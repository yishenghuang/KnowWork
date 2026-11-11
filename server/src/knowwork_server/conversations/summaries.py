"""每轮汇总（run_summary）：挂在事件泵的观察者上，回合开始时插一行（进行中），结束时补齐状态、起止时间、提问、
用过的工具，以及各模块给的事实（contribute 登记，如知识模块的检索次数与引用条数）。

同其他观察者一样在泵的帧处理里同步调用、立即返回，写库放后台任务，失败只记日志。开始与结束两次写都按
（会话, 轮次）upsert，谁先落库都对：很短的一轮，结束那次可能先写进去。进程内记账：进程重启后才收到结束帧的那一轮，
提问、工具记不全，状态照样补上。

管理端「运行记录」的列表读它（SummaryQuery），点开一轮的详情照旧读原始帧。
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import and_, cast, func, literal, or_, select
from sqlalchemy.dialects.postgresql import JSONPATH, insert
from sqlalchemy.ext.asyncio import async_sessionmaker

from ..access.rls import set_workspace
from .events_v1 import TRIGGER_TITLES, assistant_text, message_text, reminder_schedules, trigger_text, user_parts
from .models import AnswerFeedback, Conversation, RunSummary

log = logging.getLogger(__name__)

RUNNING = "running"
# 宿主 turn/end 的 reason.kind → 状态：写满长度截断的也算答完；用户中止是取消；被拦截、出错和不认识的算失败
STATUSES = {"completed": "completed", "max-tokens": "completed", "aborted": "cancelled", "cancelled": "cancelled",
            "interrupted": "cancelled"}
FAILED = "failed"
MAX_QUESTION = 2000


@dataclass(frozen=True)
class TurnEnded:
    """结束的一轮，交给各模块算自己的事实、做自己的事。answer 是最后一条助手回答的全文；user_id 是会话的主人
    （提问的人），查不到时为 None。"""

    workspace_id: str
    conversation_id: str
    turn: int
    question: str
    answer: str
    status: str
    user_id: str | None = None
    started_at: datetime | None = None  # 这一轮开始的时刻（模块按它取这一轮自己的记录）；没看到开始帧时为 None
    # 这一轮是哪些定时任务投递进来的（任务 id 与它该跑的時刻）：自动化页按任务 id 反查最近一次跑成没跑成
    schedule: tuple[dict[str, str], ...] = ()


Contributor = Callable[[TurnEnded], Awaitable[Mapping[str, Any] | None]]
OwnerLookup = Callable[[str], Awaitable[str | None]]


@dataclass(frozen=True)
class _Turn:
    turn: int | None = None
    started: datetime | None = None
    question: str | None = None  # 用户这一轮亲自发的第一条消息；后面的插话不算
    answer: str = ""             # 最后一条助手回答
    tools: tuple[str, ...] = ()
    schedule: tuple[dict[str, str], ...] = ()  # 投递进这一轮的定时任务（见 TurnEnded.schedule）


def _int(value: Any) -> int | None:
    return value if type(value) is int else None


def _time(value: Any) -> datetime:
    """帧上的时间（毫秒）；没有时用现在。"""
    return datetime.fromtimestamp(value / 1000, UTC) if type(value) is int else datetime.now(UTC)


def _question(source: dict, content: Any) -> str | None:
    """这一轮问的是什么：用户亲自发的原话；定时任务、后台任务完成这类自动发起的记成「定时任务：提示词」，运行记录里
    不留空。宿主也用 user/message 注入运行时上下文等，这些不算提问（None）。"""
    kind = source.get("kind")
    if kind == "user":
        return user_parts(content)[0]
    if kind in TRIGGER_TITLES:
        return f"{TRIGGER_TITLES[kind]}：{trigger_text(source, content)}"
    return None


def status_of(reason: str | None) -> str:
    return STATUSES.get(reason or "", FAILED)


class RunSummaries:
    def __init__(self, sessionmaker: async_sessionmaker, owner_of: OwnerLookup) -> None:
        self._sessionmaker = sessionmaker
        self._owner_of = owner_of
        self._contributors: dict[str, Contributor] = {}
        self._turns: dict[str, _Turn] = {}
        self._tasks: set[asyncio.Task] = set()

    def contribute(self, name: str, contributor: Contributor) -> None:
        """登记一个模块在回合结束时要做的事与给的事实，事实写进 facts[name]；给 None 就不写。装配时调用。
        各模块互不影响：一个出错只记日志。"""
        self._contributors = {**self._contributors, name: contributor}

    def current_turn(self, conversation_id: str) -> int | None:
        """这个会话正在跑第几轮；没看到这一轮开始（进程刚重启、多副本）时为 None。"""
        return self._turns.get(conversation_id, _Turn()).turn

    def __call__(self, conversation_id: str, workspace_id: str, kind: str, data: Any) -> None:
        if kind != "session/event" or not isinstance(data, dict):
            return
        payload = data.get("data") if isinstance(data.get("data"), dict) else {}
        event = data.get("type")
        current = self._turns.get(conversation_id, _Turn())
        if event == "turn/start":
            turn = _int(payload.get("turn"))
            # 提问一般在开始帧之后到；上一轮结束后、这一轮开始前就到了的（排队的消息）也算这一轮的
            question = current.question if current.turn is None else None
            started = _time(data.get("time"))
            self._put(conversation_id, _Turn(turn=turn, started=started, question=question))
            if turn is not None:
                self._spawn(self._started(workspace_id, conversation_id, turn, question or "", started))
        elif event == "user/message":
            source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
            content = payload.get("content")
            # 定时任务投递进对话的那条消息正文里带任务 id：无论这一步认不认得出问题，都要把它记到这一轮上
            refs = (reminder_schedules(message_text(content)) if source.get("kind") == "schedule" else ())
            question = _question(source, content) if current.question is None else None
            if question is not None or refs:
                self._put(conversation_id, replace(current, question=current.question if question is None else question,
                                                   schedule=refs or current.schedule))
                if question is not None and current.turn is not None:  # 进行中的那一行也看得到在问什么
                    self._spawn(self._asked(workspace_id, conversation_id, current.turn, question,
                                            current.started or _time(data.get("time"))))
        elif event == "assistant/message":
            text = assistant_text(payload)
            if text:
                self._put(conversation_id, replace(current, answer=text))
        elif event == "tool/call":
            name = payload.get("name")
            if isinstance(name, str) and name and name not in current.tools:
                self._put(conversation_id, replace(current, tools=(*current.tools, name)))
        elif event == "turn/end":
            self._turns = {k: v for k, v in self._turns.items() if k != conversation_id}
            turn = _int(payload.get("turn")) or current.turn
            if turn is None:
                return
            reason = payload.get("reason") if isinstance(payload.get("reason"), dict) else {}
            kind = reason.get("kind") if isinstance(reason.get("kind"), str) else None
            ended = TurnEnded(workspace_id=workspace_id, conversation_id=conversation_id, turn=turn,
                              question=current.question or "", answer=current.answer, status=status_of(kind),
                              started_at=current.started, schedule=current.schedule)
            self._spawn(self._ended(ended, kind, current.tools, _time(data.get("time"))))

    def _put(self, conversation_id: str, turn: _Turn) -> None:
        self._turns = {**self._turns, conversation_id: turn}

    def _spawn(self, work) -> None:
        task = asyncio.create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _started(self, workspace_id: str, conversation_id: str, turn: int, question: str,
                       at: datetime) -> None:
        try:
            user_id = await self._owner_of(conversation_id)
            if user_id is None:
                return
            async with self._sessionmaker() as session, session.begin():
                await set_workspace(session, workspace_id)
                await session.execute(insert(RunSummary).values(
                    conversation_id=conversation_id, turn=turn, workspace_id=workspace_id, user_id=user_id,
                    question=question[:MAX_QUESTION], status=RUNNING, started_at=at, tools=[], facts={},
                ).on_conflict_do_nothing(index_elements=["conversation_id", "turn"]))
        except Exception:
            log.exception("recording the start of %s turn %s failed", conversation_id, turn)

    async def _asked(self, workspace_id: str, conversation_id: str, turn: int, question: str,
                     started: datetime) -> None:
        """提问补写到进行中的那一行。开始那一行也在后台写，负载高时这次可能先落库：没有那一行就连行一起插，
        有就只在还没写提问时补上（结束时照样会写）。"""
        try:
            user_id = await self._owner_of(conversation_id)
            if user_id is None:
                return
            statement = insert(RunSummary).values(
                conversation_id=conversation_id, turn=turn, workspace_id=workspace_id, user_id=user_id,
                question=question[:MAX_QUESTION], status=RUNNING, started_at=started, tools=[], facts={})
            async with self._sessionmaker() as session, session.begin():
                await set_workspace(session, workspace_id)
                await session.execute(statement.on_conflict_do_update(
                    index_elements=["conversation_id", "turn"], set_={"question": statement.excluded.question},
                    where=RunSummary.question == ""))
        except Exception:
            log.exception("recording the question of %s turn %s failed", conversation_id, turn)

    async def _ended(self, ended: TurnEnded, reason: str | None, tools: tuple[str, ...], at: datetime) -> None:
        try:
            user_id = await self._owner_of(ended.conversation_id)
            facts = await self._facts(replace(ended, user_id=user_id))
            if ended.schedule:
                # 自动化页按 facts.schedule.id 反查这条任务最近一次投递所在的那一轮（模块名固定 schedule）
                facts = {**facts, "schedule": {
                    "id": [item["id"] for item in ended.schedule],
                    "occurrenceAt": next((item["occurrenceAt"] for item in ended.schedule if item["occurrenceAt"]),
                                         None)}}
            if user_id is None:
                return
            row = {"conversation_id": ended.conversation_id, "turn": ended.turn, "workspace_id": ended.workspace_id,
                   "user_id": user_id, "question": ended.question[:MAX_QUESTION], "status": ended.status,
                   "end_reason": (reason or "")[:32] or None, "started_at": at, "ended_at": at,
                   "tools": list(tools), "facts": facts}
            statement = insert(RunSummary).values(**row)
            async with self._sessionmaker() as session, session.begin():
                await set_workspace(session, ended.workspace_id)
                await session.execute(statement.on_conflict_do_update(
                    index_elements=["conversation_id", "turn"],
                    set_={"status": statement.excluded.status, "end_reason": statement.excluded.end_reason,
                          "ended_at": statement.excluded.ended_at,
                          # 重启后才收到结束帧时进程里没记下提问、工具：留着开始时（或上次）写的
                          "question": func.coalesce(func.nullif(statement.excluded.question, ""),
                                                    RunSummary.question),
                          "tools": statement.excluded.tools if tools else RunSummary.tools,
                          "facts": RunSummary.facts.op("||")(statement.excluded.facts)}))
        except Exception:
            log.exception("recording the end of %s turn %s failed", ended.conversation_id, ended.turn)

    async def _facts(self, ended: TurnEnded) -> dict[str, Any]:
        facts: dict[str, Any] = {}
        for name, contributor in self._contributors.items():
            try:
                value = await contributor(ended)
            except Exception:
                log.exception("%s facts for %s turn %s failed", name, ended.conversation_id, ended.turn)
                continue
            if value is not None:
                facts[name] = dict(value)
        return facts

    async def drain(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)


# 运行记录的筛选信号：检索了知识库却没引用（答完的才算）；被点了踩；没答上来（回合结束后模型判断知识库没答上或
# 只答了一部分，见 knowledge.answer_check；智能体答不上来时常常还引用沾边的背景，靠「没引用」筛不出来）
UNCITED, DISLIKED, UNANSWERED = "uncited", "disliked", "unanswered"
SIGNALS = (UNCITED, DISLIKED, UNANSWERED)
NOT_ANSWERED = ("partial", "unanswered")  # knowledge.answer_check 的 verdict 里算「没答上来」的
# 别的模块在自己的事实里写 unanswered: true 也算没答上来（例如问数这一轮的查询全报错）
UNANSWERED_FACT = "$.* ? (@.unanswered == true)"


def _recorded(facts: Any, module: str, key: str) -> list[str]:
    """汇总里 facts[module][key] 记的值（字符串数组）；旧行没有这条事实，或者形状不对，就当没有。"""
    group = facts.get(module) if isinstance(facts, dict) else None
    values = group.get(key) if isinstance(group, dict) else None
    return [value for value in values if isinstance(value, str)] if isinstance(values, list) else []


@dataclass(frozen=True)
class SummaryRow:
    summary: RunSummary
    title: str
    rating: str | None  # like | dislike，没评价为空


class SummaryQuery:
    """按时间倒序翻每轮汇总（运行记录的列表）：可按提问人、状态、信号、用过的工具、检索到的知识库筛（问答大盘下钻）。
    sessionmaker 要声明好工作空间。"""

    def __init__(self, sessionmaker: async_sessionmaker) -> None:
        self._sessionmaker = sessionmaker

    async def page(self, workspace_id: str, *, since: datetime, until: datetime, before: datetime | None = None,
                   user_id: str | None = None, status: str | None = None, signal: str | None = None,
                   tool: str | None = None, base: str | None = None, fact: tuple[str, str, str] | None = None,
                   conversation_id: str | None = None, limit: int = 50) -> tuple[SummaryRow, ...]:
        """fact：(模块, 键, 值)，只要模块记的事实 facts[模块][键] 里有这个值的轮（例如问数记的用了哪几个数据源）。"""
        feedback = and_(AnswerFeedback.conversation_id == RunSummary.conversation_id,
                        AnswerFeedback.run_id == func.concat("run-", RunSummary.turn))
        statement = (select(RunSummary, Conversation.title, AnswerFeedback.rating)
                     .join(Conversation, Conversation.id == RunSummary.conversation_id)
                     .outerjoin(AnswerFeedback, feedback)
                     .where(RunSummary.workspace_id == workspace_id, RunSummary.started_at >= since,
                            RunSummary.started_at < until))
        if before is not None:
            statement = statement.where(RunSummary.started_at < before)
        if conversation_id is not None:
            statement = statement.where(RunSummary.conversation_id == conversation_id)
        if user_id is not None:
            statement = statement.where(RunSummary.user_id == user_id)
        if status is not None:
            statement = statement.where(RunSummary.status == status)
        if tool is not None:
            statement = statement.where(RunSummary.tools.contains([tool]))
        if base is not None:
            statement = statement.where(RunSummary.facts["knowledge"]["bases"].contains([base]))
        if fact is not None:
            module, key, value = fact
            statement = statement.where(RunSummary.facts[module][key].contains([value]))
        if signal == UNCITED:
            knowledge = RunSummary.facts["knowledge"]
            statement = statement.where(RunSummary.status == "completed",
                                        knowledge["searches"].as_integer() > 0, knowledge["cited"].as_integer() == 0)
        elif signal == DISLIKED:
            statement = statement.where(AnswerFeedback.rating == "dislike")
        elif signal == UNANSWERED:
            statement = statement.where(or_(RunSummary.facts["knowledge"]["verdict"].as_string().in_(NOT_ANSWERED),
                                            func.jsonb_path_exists(RunSummary.facts, cast(literal(UNANSWERED_FACT), JSONPATH))))
        statement = statement.order_by(RunSummary.started_at.desc(), RunSummary.conversation_id).limit(limit)
        async with self._sessionmaker() as session:
            rows = (await session.execute(statement)).all()
        return tuple(SummaryRow(summary=summary, title=title or "", rating=rating) for summary, title, rating in rows)

    async def latest_by_fact(self, workspace_id: str, *, module: str, key: str, values: Sequence[str],
                             since: datetime, until: datetime) -> dict[str, SummaryRow]:
        """按模块事实（facts[module][key] 是字符串数组）一次取回一批 id 各自最近的一次汇总（started_at 最新的那条）。
        返回 {值: SummaryRow}，没有记录的 id 不在结果里。列表页用它避免逐条查。"""
        wanted = [value for value in dict.fromkeys(values) if value]
        if not wanted:
            return {}
        feedback = and_(AnswerFeedback.conversation_id == RunSummary.conversation_id,
                        AnswerFeedback.run_id == func.concat("run-", RunSummary.turn))
        statement = (select(RunSummary, Conversation.title, AnswerFeedback.rating)
                     .join(Conversation, Conversation.id == RunSummary.conversation_id)
                     .outerjoin(AnswerFeedback, feedback)
                     .where(RunSummary.workspace_id == workspace_id, RunSummary.started_at >= since,
                            RunSummary.started_at < until,
                            or_(*(RunSummary.facts[module][key].contains([value]) for value in wanted)))
                     .order_by(RunSummary.started_at.desc(), RunSummary.conversation_id).limit(2000))
        async with self._sessionmaker() as session:
            rows = (await session.execute(statement)).all()
        latest: dict[str, SummaryRow] = {}
        for summary, title, rating in rows:
            row = SummaryRow(summary=summary, title=title or "", rating=rating)
            for value in _recorded(summary.facts, module, key):
                if value in latest or value not in wanted:
                    continue
                latest[value] = row  # 按 started_at 倒序来，每个值第一次遇到的就是最新的一条
        return latest
