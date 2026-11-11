"""自动化页的读接口：列我的定时任务、看单条、看投递记录。

任务存在宿主的官方 schedule 服务里（见 plan-2 的铁律：业务服务不建任务表、不自算下次运行），本模块只做三件事：

- 把请求转给宿主，并用当前调用者的身份说明「这是谁在问」（宿主据此过滤，别人的任务不会出现）；
- 补一个派生字段 `origin`：这条任务是「页面上建的」还是「对话里设的提醒」。判定依据是执行位置那个会话本身
  （页面建的自动化对话是 background 会话），不落第二份记录，前端只读这个字段、不自己按 target 猜；
- 补一个派生字段 `lastRun`：这条任务最近一次跑成没跑成（跑完/取消/失败/跳过）、落在哪个对话。结果不在宿主里，
  读的是那个对话当轮的「每轮汇总」——定时任务投递进来的那条消息正文带任务 id，汇总把它记在 facts.schedule.id
  （见 conversations/summaries.py）。「跳过」宿主里根本没有记录（到点时上一轮还在跑，官方 drive() 直接跳过、
  也不推进 scheduledAt），只能按「还在跑 + 已经过点」在业务侧推出来；
- 把宿主的错误翻成对外的固定文案：没有这个任务 → 404，宿主暂时不可用 → 503。

对外文案固定，原始错误只写服务端日志。
"""

import logging
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field

from ..audit import AuditFilter, AuditQuery
from ..conversations.api import Actor, ActorDependency
from ..conversations.service import Conversation, ConversationNotFound
from ..conversations.summaries import SummaryQuery, SummaryRow
from ..db.base import in_workspace
from ..kernel.contract import KernelError, ScheduleKernel, ScheduleNotFound, SessionOwner
from ..sessionfiles.lookup import ConversationLookup
from . import limits, tokens

log = logging.getLogger(__name__)

# 宿主给的 id 形如 schedule-<uuid>，取值范围和会话 id 一样
ScheduleId = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")]

UNAVAILABLE = HTTPException(status_code=503, detail={"code": "schedule_unavailable",
                                                    "message": "暂时读不到定时任务，请稍后重试"})
# 宿主侧的其它错误码在这里一律当「暂时读不到」：自动化页只需要知道现在读不出来、可以重试
HOST_ERRORS = (KernelError, httpx.HTTPError, OSError)

# 到点时上一轮还没结束，这一次跳过的说明（前端原样显示在「最近一次」与投递记录里）
SKIPPED_NOTE = "到点时上一轮还没结束，这一次跳过了"
# 最近一次运行看多久以内的汇总、自动暂停那条审计叫什么，都在 limits 里：supervisor 写、这里读，同一个值只写一次
RUN_WINDOW = limits.RUN_WINDOW
AUDIT_PAUSE_ACTION = limits.AUDIT_PAUSE_ACTION
AUDIT_PAUSE_LIMIT = 200  # 与 AuditQuery.MAX_LIMIT 一致；一次批量读完，不为每条任务各查一次
AUDIT_PAUSE_REASON = limits.AUDIT_PAUSE_REASON


def moment(value: Any) -> datetime | None:
    """宿主给的时间（ISO 字符串）→ 带时区的时刻；认不出来时为 None（没有时区的按 UTC 算）。"""
    if not isinstance(value, str) or value == "":
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def iso(value: datetime | None) -> str | None:
    return None if value is None else value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def skipped_now(entry: dict, now: datetime) -> bool:
    """到点时该任务上一轮还没结束：官方 drive() 把还在跑的这条排除在外，既不投递也不推进 scheduledAt，
    所以宿主里根本没有这一次的记录，只能在业务侧按「还在跑 + 已经过点」推出来。"""
    if entry.get("status") != "active" or entry.get("executionActive") is not True:
        return False
    due = moment(entry.get("scheduledAt"))
    return due is not None and due <= now


def last_run(entry: dict, row: SummaryRow | None, now: datetime) -> dict | None:
    """这条任务最近一次跑成没跑成：跑完/取消/失败取那一轮汇总的状态，跳过按上面那三个条件推。
    一轮汇总都没有（还没跑过，或 30 天内没有）时为空。

    管理端审计页与「我的定时任务」都读这一段：两边对「最近一次」的说法必须一致。
    """
    if skipped_now(entry, now):
        return {"status": "skipped", "at": entry.get("scheduledAt"), "conversationId": None, "title": None,
                "note": SKIPPED_NOTE}
    if row is None:
        return None
    return {"status": row.summary.status, "at": iso(row.summary.started_at),
            "conversationId": row.summary.conversation_id, "title": row.title or None, "note": None}


async def latest_runs(runs: SummaryQuery | None, workspace_id: str, entries: list[dict],
                      now: datetime) -> dict[str, SummaryRow]:
    """一次把这批任务各自最近的一轮汇总取回来（列表页不能一条一条查）。"""
    if runs is None:
        return {}
    wanted = [entry["id"] for entry in entries if isinstance(entry.get("id"), str) and entry["id"]]
    try:
        return await runs.latest_by_fact(workspace_id, module="schedule", key="id", values=wanted,
                                         since=now - RUN_WINDOW, until=now)
    except Exception:
        log.exception("reading the latest runs failed")
        return {}


def owner_of(who: Actor) -> SessionOwner:
    return SessionOwner(workspace_id=who.workspace_id, user_id=who.user_id)


def upstream_error(error: Exception, action: str) -> HTTPException:
    """宿主读不出来的统一出口：不存在 → 404，其余（含连不上宿主）→ 503。"""
    if isinstance(error, ScheduleNotFound):
        return HTTPException(status_code=404, detail={"code": "schedule_not_found", "message": "没有这个定时任务"})
    code = error.code if isinstance(error, KernelError) else "host_unreachable"
    log.warning("%s failed: %s %s", action, type(error).__name__, code)
    return HTTPException(status_code=503, detail=UNAVAILABLE.detail)


async def conversation_title(session_id: str, workspace_id: str, user_id: str,
                           lookup: ConversationLookup | None) -> str | None:
    """投递目标那个对话的名字：记录里只有会话 id，界面上写 id 等于没写。

    会话删了或不是这个人的，没有名字可显示，留空（前端退回显示 id）。
    """
    if lookup is None or session_id == "":
        return None
    try:
        conversation = await lookup.get(conversation_id=session_id, workspace_id=workspace_id, user_id=user_id)
    except ConversationNotFound:
        return None
    return conversation.title or None


async def origin_of(entry: dict, workspace_id: str, user_id: str, lookup: ConversationLookup | None) -> str:
    """这条任务是页面上建的（page），还是对话里设的提醒（chat）。

    每次新建对话（new_once、new）只可能是页面上建的；固定在某个会话里投递的，看那个会话是不是页面建出来的
    自动化专属对话（background）。会话查不到时按对话里设的提醒算，宁可少显示一栏也不凭空造一条。
    """
    target = entry.get("target")
    kind = target.get("kind") if isinstance(target, dict) else None
    if kind in ("new_once", "new"):
        return "page"
    session_id = target.get("sessionId") if isinstance(target, dict) else None
    if lookup is None or not isinstance(session_id, str) or session_id == "":
        return "chat"
    try:
        conversation = await lookup.get(conversation_id=session_id, workspace_id=workspace_id, user_id=user_id)
    except ConversationNotFound:
        # 会话删了或不是这个人的：判定不了就按对话里设的提醒算，不影响任务本身
        return "chat"
    return "page" if conversation.background else "chat"


class TargetBody(BaseModel):
    """执行位置：每次新建对话（new_once）、指定对话（session）、页面固定对话（fixed，由服务端建对话）。"""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["new_once", "session", "fixed"]
    sessionId: str | None = Field(default=None, min_length=1, max_length=128,
                                  pattern=r"^[A-Za-z0-9_.:-]+$")


# 一条 RRULE 行（带不带 DTSTART 都行，宿主都认）
Rrule = Annotated[str, Field(min_length=1, max_length=2000)]


class CreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=4000)
    rrule: Rrule
    target: TargetBody


class BatchCreateBody(BaseModel):
    """一次建多条：每天多个时刻就是几条规则、同一句话，界面上仍是一条「新建」。

    条数上限给 32：一天最多提醒这么多次已经不合常理，也免得一次请求把配额整段吃掉。
    """

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=4000)
    rules: list[Rrule] = Field(min_length=1, max_length=32)
    target: TargetBody


class PatchBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=120)
    prompt: str | None = Field(default=None, min_length=1, max_length=4000)
    rrule: str | None = Field(default=None, min_length=1, max_length=2000)
    target: TargetBody | None = None
    active: bool | None = None
    expectedUpdatedAt: str | None = Field(default=None, max_length=128)


class ConversationDirectory(ConversationLookup, Protocol):
    """建「固定对话」时要用到 create：登记的是完整会话服务，测试里给个同形状的假货。"""

    async def create(self, *, workspace_id: str, user_id: str, title: str = "", background: bool = False,
                     conversation_id: str | None = None, readonly: bool = False) -> Conversation: ...


# 保存前的本地拦截：这几条都是请求本身不合规，回 422 并把原因说清楚。
# 数值一律从 limits 里取（规格要求「这三个数值是常量，集中在一处」），文案里不再另写一份
INTERVAL_TOO_SHORT = {"code": "interval_too_short",
                      "message": f"间隔不能小于 {limits.MIN_INTERVAL_MINUTES} 分钟"}
PER_USER_QUOTA = {"code": "quota_exceeded",
                  "message": f"每个人最多 {limits.MAX_PER_USER} 条定时任务，先删掉不用的再建"}
PER_WORKSPACE_QUOTA = {"code": "quota_exceeded",
                       "message": f"每个空间最多 {limits.MAX_PER_WORKSPACE} 条定时任务，请联系管理员清理"}


def rejected(detail: dict) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def write_error(error: Exception, action: str) -> HTTPException:
    """宿主写侧的错误翻成对外文案：冲突原样透出，其余按写不进去算。"""
    if isinstance(error, KernelError):
        if error.code == "schedule_conflict":
            return HTTPException(status_code=409, detail={"code": "schedule_conflict",
                                                          "message": "任务刚被改过，请刷新后再改"})
        if error.code == "schedule_execution_pending":
            return HTTPException(status_code=409, detail={"code": "schedule_execution_pending",
                                                          "message": "这个任务正在运行或排队，等它结束再试"})
    return upstream_error(error, action)


def build_router(kernel: ScheduleKernel, current_actor: ActorDependency,
                 lookup: ConversationLookup | None = None, host_token: str | None = None,
                 runs: SummaryQuery | None = None, audit: AuditQuery | None = None) -> APIRouter:
    router = APIRouter(prefix="/api/workspaces/{workspace_id}/automations", tags=["automations"])
    Who = Annotated[Actor, Depends(current_actor)]

    def host_secret() -> str:
        """属主令牌要拿宿主令牌当密钥。调用方没显式给就按部署配置取（延迟到真正要铸令牌时）。"""
        if host_token is not None:
            return host_token
        from ..config import get_settings  # 只在铸令牌时读配置：只读路由不该依赖它

        return get_settings().host_token.get_secret_value()

    async def owned_conversation(session_id: str, who: Actor) -> Conversation:
        """执行位置指向的对话必须是这个人自己的：既确认存在，也确认归属。"""
        if lookup is None:
            raise HTTPException(status_code=503, detail=UNAVAILABLE.detail)
        try:
            return await lookup.get(conversation_id=session_id, workspace_id=who.workspace_id, user_id=who.user_id)
        except ConversationNotFound as error:
            raise HTTPException(status_code=404, detail={"code": "conversation_not_found",
                                                         "message": "会话不存在"}) from error

    async def fixed_conversation(who: Actor) -> Conversation:
        """「固定对话」：先替这条任务建一段后台只读对话，任务到点就在这段对话里跑。"""
        directory = lookup
        if directory is None or not hasattr(directory, "create"):
            raise HTTPException(status_code=503, detail=UNAVAILABLE.detail)
        try:
            with in_workspace(who.workspace_id):
                conversation = await (directory.create(  # type: ignore[union-attr]
                    workspace_id=who.workspace_id, user_id=who.user_id, background=True, readonly=True,
                    title="自动化"))
        except KernelError as error:
            log.warning("create automation conversation failed: %s", error.code)
            raise HTTPException(status_code=503, detail=UNAVAILABLE.detail) from error
        return conversation

    async def agent_preset(who: Actor, reuse: dict | None = None) -> str:
        """「每次新建对话」的属主令牌：原来那条任务已经是新开对话且令牌还在，就沿用，别每改一次换一枚。"""
        old = (reuse or {}).get("create")
        if isinstance(old, dict) and isinstance(old.get("agentPreset"), str) and old["agentPreset"] != "":
            return old["agentPreset"]
        try:
            return tokens.mint(tokens.TokenOwner(workspace_id=who.workspace_id, user_id=who.user_id), host_secret())
        except ValueError as error:
            log.warning("mint agent preset failed: %s", error)
            raise HTTPException(status_code=503, detail=UNAVAILABLE.detail) from error

    async def host_target(target: TargetBody, who: Actor, reuse: dict | None = None) -> dict:
        """把前端的执行位置翻成宿主认的 target。"""
        if target.kind == "new_once":
            return {"kind": "new_once", "create": {"agentPreset": await agent_preset(who, reuse)}}
        if target.kind == "fixed":
            conversation = await fixed_conversation(who)
            return {"kind": "session", "sessionId": conversation.id}
        if target.sessionId is None:
            raise rejected({"code": "invalid_target", "message": "固定对话要指定是哪一段对话"})
        await owned_conversation(target.sessionId, who)
        return {"kind": "session", "sessionId": target.sessionId}

    async def guard_save(who: Actor, rrule: str, extra: int = 1) -> None:
        """保存前先拦：间隔太密、本人太多、本空间太多。顺序固定，先说最贴近这条请求的那条。

        extra 是这一次要建几条：一次建多个时刻时要按合计判，不能按一条判（不然 19 条时仍能一次加 5 条）。
        """
        if limits.interval_too_short(rrule):
            raise rejected(INTERVAL_TOO_SHORT)
        try:
            mine = await kernel.list_schedules(owner=owner_of(who), limit=1)
        except HOST_ERRORS as error:
            raise upstream_error(error, "count my schedules") from error
        if int(mine.get("total", 0)) + extra > limits.MAX_PER_USER:
            raise rejected(PER_USER_QUOTA)
        try:
            workspace = await kernel.count_schedules(workspace_id=who.workspace_id)
        except HOST_ERRORS as error:
            raise upstream_error(error, "count workspace schedules") from error
        if int(workspace.get("total", 0)) + extra > limits.MAX_PER_WORKSPACE:
            raise rejected(PER_WORKSPACE_QUOTA)

    async def discard(made: list[dict], who: Actor) -> None:
        """一次建多条失败时，把已经建出来的删掉，尽量不留半套。

        删不掉的只记日志：这时真正要报给用户的还是最初那个失败，不能让它被回滚的错盖过去。
        """
        for entry in made:
            schedule_id = entry.get("id")
            if not isinstance(schedule_id, str) or not schedule_id:
                continue
            try:
                await kernel.delete_schedule(schedule_id, owner=owner_of(who))
            except HOST_ERRORS:
                log.warning("rollback created schedule %s failed", schedule_id, exc_info=True)

    async def current_entry(schedule_id: str, who: Actor) -> dict | None:
        """当前这条任务（历史里要不要补一条「跳过」、时间窗算到哪，都要看它）。读不到就当没有，不影响记录本身。"""
        try:
            return await kernel.view_schedule(schedule_id, owner=owner_of(who))
        except HOST_ERRORS:
            log.warning("view schedule for history failed", exc_info=True)
            return None

    async def with_statuses(records: list[dict], who: Actor, now: datetime) -> list[dict]:
        """每条真实投递记录补上「那一次跑成没跑成」：记录新的在前，第 i 条的窗口是
        [deliveredAt_i, deliveredAt_{i-1})，最后一条用现在作上界；窗口里那个对话最近一轮汇总的状态就是它。"""
        upper = now
        filled = []
        for record in records:
            if not isinstance(record, dict):
                filled.append(record)
                continue
            session_id = record.get("targetSessionId")
            status = None
            if runs is not None and isinstance(session_id, str) and session_id:
                lower = moment(record.get("deliveredAt")) or moment(record.get("scheduledAt"))
                if lower is not None:
                    status = await run_status(who, session_id, lower, upper)
            filled.append({**record, "status": status})
            delivered = moment(record.get("deliveredAt"))
            if delivered is not None:
                upper = delivered
        return filled

    async def run_status(who: Actor, conversation_id: str, since: datetime, until: datetime) -> str | None:
        """某个对话在 [since, until) 里最近一轮汇总的状态；没跑过、或读不到时为 None。"""
        if until <= since:
            return None
        try:
            rows = await runs.page(who.workspace_id, since=since, until=until, conversation_id=conversation_id,
                                   limit=1)
        except Exception:
            log.exception("reading the run of %s failed", conversation_id)
            return None
        return rows[0].summary.status if rows else None

    async def auto_pauses(who: Actor, entries: list[dict]) -> dict[str, dict]:
        """一次批量读「自动暂停」的原因：审计里按 id 留最新一条，只给这页里已暂停的任务。

        AuditQuery.page 自己 set_workspace，按 occurred_at desc / id desc 返回，所以每个 id 的第一条就是最新的。
        只认 result="success" 那一类：任务被连续失败判定命中、但停用请求被宿主拒掉的那次（result="failed"）
        不在这里显示成「已自动暂停」——它还跑着，界面不该说它停了。
        审计读不到或没登记查询对象都不能让列表读挂掉：返回空字典，前端退回普通「已暂停」文案。
        """
        if audit is None:
            return {}
        wanted = {entry["id"] for entry in entries if isinstance(entry, dict)
                  and entry.get("status") == "paused" and isinstance(entry.get("id"), str) and entry["id"]}
        if not wanted:
            return {}
        try:
            page = await audit.page(who.workspace_id, AuditFilter(action=AUDIT_PAUSE_ACTION),
                                    limit=AUDIT_PAUSE_LIMIT)
        except Exception:
            log.exception("reading auto-pause audit failed")
            return {}
        result: dict[str, dict] = {}
        for item in page.items:
            task_id = item.resource_id
            if not isinstance(task_id, str) or task_id not in wanted or task_id in result:
                continue
            # 老审计行可能没有 result 字段，按成功处理；只有明确是失败的那次跳过
            if getattr(item, "result", "success") != "success":
                continue
            detail = item.detail if isinstance(item.detail, dict) else {}
            reason = detail.get("reason")
            result[task_id] = {"reason": reason if isinstance(reason, str) and reason else AUDIT_PAUSE_REASON,
                               "at": iso(item.occurred_at)}
        return result

    async def describe(entry: dict, who: Actor, run: SummaryRow | None = None,
                       now: datetime | None = None, auto_paused: dict | None = None) -> dict:
        moment_now = now or datetime.now(UTC)
        return {**entry, "origin": await origin_of(entry, who.workspace_id, who.user_id, lookup),
                "lastRun": last_run(entry, run, moment_now), "autoPaused": auto_paused}

    @router.get("")
    async def list_automations(who: Who, limit: Annotated[int, Query(ge=1, le=500)] = 100,
                               offset: Annotated[int, Query(ge=0)] = 0, active: bool | None = None):
        """我的定时任务（含已暂停的，前端按视图分组）"""
        try:
            page = await kernel.list_schedules(owner=owner_of(who), limit=limit, offset=offset, active=active)
        except HOST_ERRORS as error:
            raise upstream_error(error, "list schedules") from error
        entries = [entry for entry in page.get("items", []) if isinstance(entry, dict)]
        now = datetime.now(UTC)
        latest = await latest_runs(runs, who.workspace_id, entries, now)
        pauses = await auto_pauses(who, entries)
        items = [await describe(entry, who, latest.get(str(entry.get("id"))), now,
                                pauses.get(str(entry.get("id")))) for entry in entries]
        return {"items": items, "total": page.get("total", len(items)), "limit": page.get("limit", limit),
                "offset": page.get("offset", offset)}

    @router.get("/{schedule_id}")
    async def get_automation(schedule_id: ScheduleId, who: Who):
        """单条任务"""
        try:
            entry = await kernel.view_schedule(schedule_id, owner=owner_of(who))
        except HOST_ERRORS as error:
            raise upstream_error(error, "view schedule") from error
        now = datetime.now(UTC)
        latest = await latest_runs(runs, who.workspace_id, [entry], now)
        pauses = await auto_pauses(who, [entry])
        return await describe(entry, who, latest.get(schedule_id), now, pauses.get(schedule_id))

    @router.get("/{schedule_id}/history")
    async def automation_history(schedule_id: ScheduleId, who: Who,
                                 limit: Annotated[int, Query(ge=1, le=100)] = 20,
                                 before: Annotated[str | None, Query(min_length=1, max_length=256)] = None):
        """投递记录：哪一次、什么时间、投到了哪个对话、那一次跑成没跑成"""
        try:
            page = await kernel.schedule_history(schedule_id, owner=owner_of(who), limit=limit, before=before)
        except HOST_ERRORS as error:
            raise upstream_error(error, "schedule history") from error
        # 记录里只有会话 id；同一个对话只查一次，补上它的名字（查不到就是 None）
        titles: dict[str, str | None] = {}
        records = []
        for record in page.get("records", []):
            session_id = record.get("targetSessionId") if isinstance(record, dict) else None
            if not isinstance(session_id, str) or session_id == "":
                records.append(record)
                continue
            if session_id not in titles:
                titles[session_id] = await conversation_title(session_id, who.workspace_id, who.user_id, lookup)
            records.append({**record, "targetTitle": titles[session_id]})
        now = datetime.now(UTC)
        records = await with_statuses(records, who, now)
        # 「跳过」那一次宿主里没有记录（见 skipped_now）：只在看最近一页时把它补在最前面
        entry = await current_entry(schedule_id, who)
        if entry is not None and before is None and skipped_now(entry, now):
            records = [{"scheduledAt": entry.get("scheduledAt"), "deliveredAt": None,
                        "messageId": f"skipped:{entry.get('scheduledAt')}", "targetSessionId": None,
                        "targetTitle": None, "prompt": entry.get("prompt"), "status": "skipped", "skipped": True,
                        "note": SKIPPED_NOTE}, *records]
        return {**page, "records": records}

    @router.post("", status_code=201)
    async def create_automation(body: CreateBody, who: Who):
        """建一条任务：一句话要做的事、时间规则、执行位置。"""
        await guard_save(who, body.rrule)
        target = await host_target(body.target, who)
        try:
            created = await kernel.create_schedule({
                "title": body.title, "prompt": body.prompt, "timing": {"kind": "rrule", "rrule": body.rrule},
                "target": target,
            }, owner=owner_of(who))
        except HOST_ERRORS as error:
            raise write_error(error, "create schedule") from error
        entry = await describe(created, who)
        return _written(entry)

    @router.post("/batch", status_code=201)
    async def create_automations(body: BatchCreateBody, who: Who):
        """一次建多条（「每天 9:00 与 18:30」这种）：要么全成，要么一条都不留。

        不能让前端逐条发：第 N 条失败时前面几条已经落在宿主里，用户看到报错回头重试就多出一批。
        """
        for rule in body.rules:
            await guard_save(who, rule, len(body.rules))
        target = await host_target(body.target, who)
        made: list[dict] = []
        try:
            for rule in body.rules:
                made.append(await kernel.create_schedule({
                    "title": body.title, "prompt": body.prompt, "timing": {"kind": "rrule", "rrule": rule},
                    "target": target,
                }, owner=owner_of(who)))
        except HOST_ERRORS as error:
            await discard(made, who)
            raise write_error(error, "create schedule") from error
        return {"items": [_written(await describe(entry, who)) for entry in made]}

    @router.patch("/{schedule_id}")
    async def update_automation(schedule_id: ScheduleId, body: PatchBody, who: Who):
        """改一条任务：时间规则、提示词、执行位置、暂停/恢复。"""
        patch: dict = {}
        if body.title is not None:
            patch["title"] = body.title
        if body.prompt is not None:
            patch["prompt"] = body.prompt
        if body.rrule is not None:
            if limits.interval_too_short(body.rrule):
                raise rejected(INTERVAL_TOO_SHORT)
            patch["timing"] = {"kind": "rrule", "rrule": body.rrule}
        if body.active is not None:
            patch["active"] = body.active
        # 原来的任务要先读出来：复用旧令牌、判归属、以及没改规则时的冲突检测都靠它
        try:
            current = await kernel.view_schedule(schedule_id, owner=owner_of(who))
        except HOST_ERRORS as error:
            raise write_error(error, "view schedule") from error
        if body.target is not None:
            patch["target"] = await host_target(body.target, who, current.get("target"))
        if not patch:
            raise rejected({"code": "nothing_to_update", "message": "没有要改的字段"})
        try:
            updated = await kernel.edit_schedule(schedule_id, {
                "action": "update", "patch": patch,
                **({} if body.expectedUpdatedAt is None else {"expectedUpdatedAt": body.expectedUpdatedAt}),
            }, owner=owner_of(who))
        except HOST_ERRORS as error:
            raise write_error(error, "edit schedule") from error
        entry = await describe(updated, who)
        return _written(entry)

    @router.post("/{schedule_id}/pause")
    async def pause_automation(schedule_id: ScheduleId, who: Who):
        """暂停：到点不再触发。只把 active 关掉，其余字段一概不碰。"""
        try:
            updated = await kernel.edit_schedule(schedule_id,
                                                {"action": "update", "patch": {"active": False}},
                                                owner=owner_of(who))
        except HOST_ERRORS as error:
            raise write_error(error, "pause schedule") from error
        return _written(await describe(updated, who))

    @router.post("/{schedule_id}/resume")
    async def resume_automation(schedule_id: ScheduleId, who: Who):
        """恢复：宿主按 patch.active=true 重算下一次运行时间，业务服务不自己算。"""
        try:
            updated = await kernel.edit_schedule(schedule_id,
                                                {"action": "update", "patch": {"active": True}},
                                                owner=owner_of(who))
        except HOST_ERRORS as error:
            raise write_error(error, "resume schedule") from error
        return _written(await describe(updated, who))

    @router.post("/{schedule_id}/run")
    async def run_automation(schedule_id: ScheduleId, who: Who):
        """立即运行一次：宿主立刻发起一轮，原来的下次运行时间不变。正在跑/排队时宿主回 409。"""
        try:
            entry = await kernel.run_schedule(schedule_id, owner=owner_of(who))
        except HOST_ERRORS as error:
            raise write_error(error, "run schedule") from error
        return _written(await describe(entry, who))

    @router.delete("/{schedule_id}")
    async def delete_automation(schedule_id: ScheduleId, who: Who):
        """删掉任务：宿主侧不再触发；它跑过的对话与消息不在这里，删不掉。"""
        try:
            await kernel.delete_schedule(schedule_id, owner=owner_of(who))
        except HOST_ERRORS as error:
            raise write_error(error, "delete schedule") from error
        return {"deleted": True}

    return router


def _written(entry: dict) -> dict:
    """写路由只回前端立刻要用的四样：id、下次什么时候跑、属于哪一栏、以及改完的版本。"""
    return {"id": entry.get("id"), "scheduledAt": entry.get("scheduledAt"), "origin": entry.get("origin"),
            "updatedAt": entry.get("updatedAt")}
