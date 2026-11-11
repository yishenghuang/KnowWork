"""自动化页「最近一次跑成没跑成」：任务投递进对话的那条消息正文里带任务 id，它落到当轮汇总的 facts.schedule；
列表按任务 id 一次批量反查各自最近的一轮汇总给出 lastRun；「跳过」宿主里根本没有记录（官方 drive() 到点时把
还在跑的那条排除在外，既不投递也不推进 scheduledAt），只能按「还在跑 + 已经过点」在业务侧推；
投递记录每条补上那一次的结果，看最近一页时把刚发生的那次「跳过」补在最前面。"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from knowwork_server.automations.api import SKIPPED_NOTE, build_router
from knowwork_server.conversations.models import Conversation, RunSummary
from knowwork_server.conversations.summaries import RunSummaries, SummaryQuery
from knowwork_server.db.base import in_workspace, make_engine, make_workspace_sessionmaker
from knowwork_server.db.migrate import MAIN_LINE, upgrade_to_head

from .fakes import token_actor

pytestmark = pytest.mark.anyio
TOKEN = "t" * 40
WORKSPACE = "ws_runs"
BASE = f"/api/workspaces/{WORKSPACE}/automations"
RULE = "DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;COUNT=1"
START, END = 1793025165294, 1793025175294  # 毫秒


def ago(**kwargs) -> datetime:
    return datetime.now(UTC) - timedelta(**kwargs)


def iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def task(over: dict | None = None) -> dict:
    """宿主 list/view 返回的 entry（照官方 entry(task) 的字段）。"""
    return {
        "id": "schedule-1",
        "kind": "rrule",
        "title": "写日报",
        "prompt": "把今天的进展写下来",
        "rrule": RULE,
        "scheduledAt": "2099-01-01T01:00:00Z",
        "target": {"kind": "session", "sessionId": "c_chat"},
        "involvedSessionIds": ["c_chat"],
        "status": "active",
        **(over or {}),
    }


class FakeHost:
    """宿主客户端替身：列表与单条各自可换，投递记录直接给。"""

    def __init__(self) -> None:
        self.items: list[dict] = [task()]
        self.viewed: dict | None = None  # 单条返回什么（例如「已经过点、上一轮还在跑」）；不给就按 id 造
        self.records: list[dict] = [{"scheduledAt": "2099-01-01T01:00:00Z",
                                     "deliveredAt": "2099-01-01T01:00:01Z", "messageId": "m1",
                                     "targetSessionId": "c_chat", "prompt": "把今天的进展写下来"}]
        self.before: list[str | None] = []

    async def list_schedules(self, *, owner, limit=100, offset=0, active=None):
        return {"items": self.items, "shown": len(self.items), "total": len(self.items), "limit": limit,
                "offset": offset}

    async def view_schedule(self, schedule_id, *, owner):
        return dict(self.viewed) if self.viewed is not None else task({"id": schedule_id})

    async def schedule_history(self, schedule_id, *, owner, limit=20, before=None):
        self.before.append(before)
        return {"id": schedule_id, "records": list(self.records), "earlierRecordsUnavailable": False,
                "earlierRecordsPruned": False, "retention": {"deliveries": 50, "days": 30}}


@dataclass
class Db:
    sessionmaker: object


@pytest.fixture
async def db(app_db):
    """真库 + 普通应用账号（行级安全开着）：会话与汇总都按工作空间隔离。"""
    await upgrade_to_head(app_db.owner_url, app_role=app_db.role, branches=MAIN_LINE)
    engine = make_engine(app_db.app_url)
    sessionmaker = make_workspace_sessionmaker(engine)
    with in_workspace(WORKSPACE):
        async with sessionmaker() as session:
            session.add_all([
                Conversation(id="c_chat", workspace_id=WORKSPACE, user_id="u1", title="随便聊聊"),
                Conversation(id="c_page", workspace_id=WORKSPACE, user_id="u1", title="自动化", background=True),
            ])
            await session.commit()
    yield Db(sessionmaker=sessionmaker)
    await engine.dispose()


@pytest.fixture
async def world(db):
    host = FakeHost()
    app = FastAPI()
    app.include_router(build_router(host, token_actor(TOKEN, user_id="u1", workspace_id=WORKSPACE),
                                    _lookup(db.sessionmaker), runs=SummaryQuery(db.sessionmaker)))
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal")
    state = World(host=host, db=db)
    state.http = http
    yield state
    await http.aclose()


@dataclass
class World:
    host: FakeHost
    db: Db

    async def get(self, path):
        # 生产里工作空间由调用者依赖设好（principals._member_of），这里替身自己设，否则行级安全看不到行
        with in_workspace(WORKSPACE):
            return await self.http.get(path, headers={"Authorization": f"Bearer {TOKEN}"})


def _lookup(sessionmaker):
    """会话查表的替身：照 ConversationService.get 的取法。"""

    async def get(*, conversation_id: str, workspace_id: str, user_id: str):
        with in_workspace(workspace_id):
            async with sessionmaker() as session:
                conversation = await session.scalar(select(Conversation).where(
                    Conversation.id == conversation_id,
                    Conversation.workspace_id == workspace_id,
                    Conversation.user_id == user_id,
                ))
        if conversation is None:
            from knowwork_server.conversations.service import ConversationNotFound

            raise ConversationNotFound(conversation_id)
        return conversation

    from types import SimpleNamespace

    return SimpleNamespace(get=get)


async def add_summary(db: Db, *, turn: int, status: str, started: datetime, schedule: list[str],
                      conversation_id: str = "c_chat", facts: dict | None = None) -> None:
    """直接插一行汇总：落库的形状与 RunSummaries 写的一致（facts.schedule 就是钩子）。"""
    with in_workspace(WORKSPACE):
        async with db.sessionmaker() as session:
            session.add(RunSummary(conversation_id=conversation_id, turn=turn, workspace_id=WORKSPACE,
                                   user_id="u1", question="定时任务：写日报", status=status,
                                   end_reason="completed", started_at=started, ended_at=started,
                                   tools=[], facts={"schedule": {"id": schedule, "occurrenceAt": None},
                                                    **(facts or {})}))
            await session.commit()


def feed(summaries: RunSummaries, cid: str, *frames) -> None:
    for kind, data in frames:
        summaries(cid, WORKSPACE, kind, data)


def frame(kind: str, data: dict, time: int = START) -> tuple[str, dict]:
    return "session/event", {"type": kind, "time": time, "data": data}


def user(text: str, source: str = "schedule") -> dict:
    return {"role": "user", "source": {"kind": source}, "content": [{"type": "text", "text": text}]}


async def summary(db: Db, cid: str, turn: int) -> RunSummary | None:
    with in_workspace(WORKSPACE):
        async with db.sessionmaker() as session:
            return await session.scalar(select(RunSummary).where(RunSummary.conversation_id == cid,
                                                                 RunSummary.turn == turn))


def scheduled(schedule_id: str = "schedule-1", occurrence: str = "2026-11-11T06:00:00.000Z") -> str:
    return (f'[SCHEDULE REMINDER]\nThis is a scheduled message from the user\n'
            f'schedule_id_json: "{schedule_id}"\noccurrence_at: {occurrence}\n'
            f'reminder_prompt_json: "写日报"')


def batch(*items: tuple[str, str]) -> str:
    body = ", ".join(f'{{"schedule_id":"{schedule_id}","occurrence_at":"{occurrence}","reminder_prompt":"写日报"}}'
                     for schedule_id, occurrence in items)
    return f"[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: [{body}]"


async def test_a_scheduled_message_lands_its_task_id_in_the_turn_summary(db):
    """定时任务投递进来的那条消息：提问记成「定时任务：…」，任务 id 落到这一轮汇总的事实里——自动化页按它反查。"""
    summaries = RunSummaries(db.sessionmaker, _owner)
    cid = await _conversation(db)
    feed(summaries, cid, frame("turn/start", {"turn": 1}), frame("user/message", user(scheduled())),
         frame("turn/end", {"turn": 1, "reason": {"kind": "completed"}}, time=END))
    await summaries.drain()
    done = await summary(db, cid, 1)
    assert done.facts["schedule"] == {"id": ["schedule-1"], "occurrenceAt": "2026-11-11T06:00:00.000Z"}
    assert done.question == "定时任务：写日报"


async def test_one_batch_delivery_records_every_task_in_it(db):
    """合并投递一轮里带了几条任务就记几个 id；occurrenceAt 取第一个有值的那次（这一轮就是它开的）。"""
    summaries = RunSummaries(db.sessionmaker, _owner)
    cid = await _conversation(db)
    text = batch(("schedule-x", "2026-11-11T06:00:00.000Z"), ("schedule-y", "2026-11-11T09:00:00.000Z"))
    feed(summaries, cid, frame("turn/start", {"turn": 1}), frame("user/message", user(text)),
         frame("turn/end", {"turn": 1, "reason": {"kind": "completed"}}, time=END))
    await summaries.drain()
    assert (await summary(db, cid, 1)).facts["schedule"] == {
        "id": ["schedule-x", "schedule-y"], "occurrenceAt": "2026-11-11T06:00:00.000Z"}


async def test_a_message_that_is_not_a_reminder_leaves_the_summary_alone(db):
    """认不出定时任务的正文（用户自己发的、别的通知）不动汇总：facts 里没有 schedule 这条。"""
    summaries = RunSummaries(db.sessionmaker, _owner)
    cid = await _conversation(db)
    feed(summaries, cid, frame("turn/start", {"turn": 1}),
         frame("user/message", user("合同有哪些条款", "user")),
         frame("turn/end", {"turn": 1, "reason": {"kind": "completed"}}, time=END))
    await summaries.drain()
    done = await summary(db, cid, 1)
    assert (done.question, "schedule" in done.facts) == ("合同有哪些条款", False)


async def test_each_task_shows_how_it_ran_last_time(world):
    """列表一眼看到每条任务最近一次跑完、取消还是失败，以及落在哪个对话。三行三种状态，一次批量查回来。"""
    world.host.items = [task({"id": "schedule-1"}), task({"id": "schedule-2"}), task({"id": "schedule-3"})]
    await add_summary(world.db, turn=1, status="completed", started=ago(hours=1), schedule=["schedule-1"])
    await add_summary(world.db, turn=2, status="cancelled", started=ago(hours=2), schedule=["schedule-2"])
    await add_summary(world.db, turn=3, status="failed", started=ago(hours=3), schedule=["schedule-3"])

    response = await world.get(BASE)
    assert response.status_code == 200, response.text
    runs = {item["id"]: item["lastRun"] for item in response.json()["items"]}
    assert {key: run["status"] for key, run in runs.items()} == {
        "schedule-1": "completed", "schedule-2": "cancelled", "schedule-3": "failed"}
    assert runs["schedule-1"]["conversationId"] == "c_chat", "点进去要能落到那一次的对话"
    assert runs["schedule-1"]["title"] == "随便聊聊"
    assert runs["schedule-1"]["note"] is None


async def test_a_task_that_has_not_run_yet_has_no_last_run(world):
    """没有汇总（还没跑过，或 30 天内没有）就老实说没有，不编一条。"""
    world.host.items = [task({"id": "schedule-1"})]
    body = (await world.get(BASE)).json()
    assert body["items"][0]["lastRun"] is None
    assert (await world.get(f"{BASE}/schedule-1")).json()["lastRun"] is None


async def test_a_task_still_running_past_its_time_shows_skipped(world):
    """到点时上一轮还没结束：官方 drive() 把这条排除在外，宿主里没有记录，业务侧按「还在跑 + 已经过点」推成跳过。"""
    due = ago(minutes=5)
    world.host.items = [task({"id": "schedule-9", "scheduledAt": iso(due), "executionActive": True})]
    run = (await world.get(BASE)).json()["items"][0]["lastRun"]
    assert run == {"status": "skipped", "at": iso(due), "conversationId": None, "title": None,
                   "note": SKIPPED_NOTE}


async def test_a_paused_or_idle_task_is_not_skipped(world):
    """只有「还在跑」才算跳过：暂停的、下一轮还没到点的，都按没有最近一次算。"""
    world.host.items = [task({"id": "schedule-1", "scheduledAt": iso(ago(minutes=5))}),
                        task({"id": "schedule-2", "status": "paused", "scheduledAt": iso(ago(minutes=5)),
                              "executionActive": True}),
                        task({"id": "schedule-3", "executionActive": True})]
    body = (await world.get(BASE)).json()
    assert [item["lastRun"] for item in body["items"]] == [None, None, None]


async def test_history_says_how_each_delivery_ran(world):
    """每条投递记录补上那一次的结果：那个对话在「这次投递之后、下一次投递之前」最近一轮汇总的状态。"""
    world.host.records = [
        {"scheduledAt": iso(ago(hours=2)), "deliveredAt": iso(ago(hours=2)), "messageId": "m2",
         "targetSessionId": "c_chat", "prompt": "写日报"},
        {"scheduledAt": iso(ago(hours=5)), "deliveredAt": iso(ago(hours=5)), "messageId": "m1",
         "targetSessionId": "c_chat", "prompt": "写日报"},
    ]
    await add_summary(world.db, turn=2, status="completed", started=ago(hours=1), schedule=["schedule-1"])
    await add_summary(world.db, turn=1, status="failed", started=ago(hours=4), schedule=["schedule-1"])

    body = (await world.get(f"{BASE}/schedule-1/history")).json()
    assert [(record["messageId"], record["status"]) for record in body["records"]] == [
        ("m2", "completed"), ("m1", "failed")]


async def test_history_shows_a_skipped_occurrence_before_the_real_records(world):
    """「跳过」那一次宿主里没有记录：看最近一页时补一条合成的在最前面，时间取那条任务原定的下一次。"""
    due = ago(minutes=5)
    world.host.viewed = task({"id": "schedule-1", "scheduledAt": iso(due), "executionActive": True})
    body = (await world.get(f"{BASE}/schedule-1/history")).json()
    synthetic, real = body["records"][0], body["records"][1]
    assert (synthetic["skipped"], synthetic["status"], synthetic["deliveredAt"]) == (True, "skipped", None)
    assert synthetic["messageId"] == f"skipped:{iso(due)}"
    assert synthetic["note"] == SKIPPED_NOTE and synthetic["prompt"] == "把今天的进展写下来"
    assert real["messageId"] == "m1" and real.get("skipped") is not True

    # 往前翻页时不补：那一次「跳过」不在更早的那一页里
    paged = (await world.get(f"{BASE}/schedule-1/history?before=m1")).json()
    assert [record["messageId"] for record in paged["records"]] == ["m1"]
    assert world.host.before == [None, "m1"]


async def _conversation(db: Db) -> str:
    cid = "c_" + uuid.uuid4().hex
    with in_workspace(WORKSPACE):
        async with db.sessionmaker() as session:
            session.add(Conversation(id=cid, workspace_id=WORKSPACE, user_id="u1", title="自动化"))
            await session.commit()
    return cid


async def _owner(conversation_id: str) -> str | None:
    return "u1"
