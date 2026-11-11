"""管理端的自动化任务审计（automations/admin.py）：看本空间全部定时任务、停用其中任意一条。

权限真判（走真的 AccessService 与真库）：空间所有者与管理员能看全量、能停用；普通成员与外人 403；
权限服务不健康时 503 fail-closed。宿主是替身，只核对「业务服务发过去的是什么」与错误怎么翻。
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from knowwork_server.access.models import ACCESS_RLS_TABLES
from knowwork_server.access.rls import enable_row_level_security
from knowwork_server.access.service import AccessService
from knowwork_server.audit.models import AUDIT_RLS_TABLES
from knowwork_server.auth.principal import Principal
from knowwork_server.automations.admin import build_router
from knowwork_server.conversations.models import Conversation, RunSummary
from knowwork_server.conversations.summaries import SummaryQuery
from knowwork_server.db.base import Base, in_workspace, make_engine, make_sessionmaker, make_workspace_sessionmaker
from knowwork_server.db.registry import load_all_models
from knowwork_server.kernel.contract import KernelError, ScheduleNotFound

pytestmark = pytest.mark.anyio
APP_ROLE = "kw_autoadmin_app"
TOOL_RLS_TABLES = ("action_receipt", "action_result_blob")
WORKSPACE = "ws1"
OTHER_WORKSPACE = "ws2"
RULE = "DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;COUNT=1"


def _swap(url: str, *, user: str, database: str) -> str:
    return url.replace("postgres@", f"{user}@", 1).replace("/postgres?", f"/{database}?", 1)


async def _prepare(admin_url: str) -> None:
    load_all_models()
    admin = create_async_engine(admin_url)
    async with admin.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await enable_row_level_security(conn, (*ACCESS_RLS_TABLES, *AUDIT_RLS_TABLES, *TOOL_RLS_TABLES))
        for statement in (f"GRANT USAGE ON SCHEMA public TO {APP_ROLE}",
                          f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {APP_ROLE}",
                          f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {APP_ROLE}"):
            await conn.execute(text(statement))
    await admin.dispose()


@dataclass(frozen=True)
class Db:
    app_url: str
    admin_url: str


@pytest.fixture
async def audit_db(database_url):
    """独立库 + 普通角色（不绕过行级安全）：与生产一样，业务读写要声明空间才看得到行。"""
    name = "kw_autoadmin_" + uuid.uuid4().hex[:12]
    server = create_async_engine(database_url, isolation_level="AUTOCOMMIT")
    async with server.connect() as conn:
        if not await conn.scalar(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": APP_ROLE}):
            await conn.execute(text(f"CREATE ROLE {APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS"))
        await conn.execute(text(f'CREATE DATABASE "{name}"'))
    admin_url = _swap(database_url, user="postgres", database=name)
    await _prepare(admin_url)
    yield Db(app_url=_swap(database_url, user=APP_ROLE, database=name), admin_url=admin_url)
    async with server.connect() as conn:
        await conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
    await server.dispose()


def entry(over: dict | None = None) -> dict:
    """宿主全量读返回的一条任务：比个人列表多一个 owner（宿主从属主账本补的）。"""
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
        "owner": {"workspaceId": WORKSPACE, "userId": "u1"},
        **(over or {}),
    }


class FakeHost:
    """宿主客户端替身：记下全量读与停用的参数，按需抛错。"""

    def __init__(self) -> None:
        self.listed: list[dict] = []
        self.disabled: list[tuple[str, str]] = []
        self.items: list[dict] = [entry()]
        self.list_effect: BaseException | None = None
        self.disable_effect: BaseException | None = None

    async def list_schedules(self, *, owner, limit=100, offset=0, active=None):
        self.listed.append({"owner": owner, "limit": limit, "offset": offset, "active": active})
        if self.list_effect is not None:
            raise self.list_effect
        return {"items": self.items, "shown": len(self.items), "total": len(self.items),
                "limit": limit, "offset": offset}

    async def disable_schedule_for_admin(self, schedule_id, *, workspace_id):
        self.disabled.append((schedule_id, workspace_id))
        if self.disable_effect is not None:
            raise self.disable_effect
        return entry({"id": schedule_id, "status": "paused"})


@dataclass
class World:
    host: FakeHost
    access: AccessService
    sessionmaker: object = None
    runs: object = None

    async def get(self, path, who: str):
        return await self.http.get(path, headers={"x-user": who})

    async def disable(self, schedule_id: str, who: str):
        return await self.http.post(f"{BASE}/{schedule_id}/disable", headers={"x-user": who})


async def principal_of(request: Request) -> Principal:
    """照主线：调用者身份由别处注入。测试用请求头指定是谁，才能换着人请求。"""
    return Principal(user_id=request.headers.get("x-user", "nobody"), auth_method="session")


def lookup_of(sessionmaker):
    """会话查表的替身：照 ConversationService.get 的取法（只认这个人的会话）。"""

    async def get(*, conversation_id: str, workspace_id: str, user_id: str):
        from sqlalchemy import select

        from knowwork_server.conversations.service import ConversationNotFound

        with in_workspace(workspace_id):
            async with sessionmaker() as session:
                conversation = (await session.execute(select(Conversation).where(
                    Conversation.id == conversation_id,
                    Conversation.workspace_id == workspace_id,
                    Conversation.user_id == user_id,
                ))).scalar_one_or_none()
        if conversation is None:
            raise ConversationNotFound(conversation_id)
        return conversation

    return SimpleNamespace(get=get)


def profiles_of(names: dict[str, str]):
    async def get_many(user_ids):
        return {uid: SimpleNamespace(name=names[uid], email=None, kind="person") for uid in user_ids if uid in names}

    return get_many


BASE = f"/api/workspaces/{WORKSPACE}/automations/admin"


@pytest.fixture
async def world(audit_db):
    engine = make_engine(audit_db.app_url)
    sessionmaker = make_workspace_sessionmaker(engine)
    access = AccessService(make_sessionmaker(engine))
    assert await access.reload()
    await access.create_workspace(workspace_id=WORKSPACE, name="空间一", owner_user_id="alice")
    await access.add_member("alice", WORKSPACE, "bob", "admin")
    await access.add_member("alice", WORKSPACE, "carol", "editor")
    await access.create_workspace(workspace_id=OTHER_WORKSPACE, name="空间二", owner_user_id="zed")
    # 任务的执行位置是 u1 在 ws1 的会话；两个空间各一个对话，用来核对 origin 与创建者姓名
    with in_workspace(WORKSPACE):
        async with sessionmaker() as session:
            session.add_all([Conversation(id="c_chat", workspace_id=WORKSPACE, user_id="u1", title="随便聊聊"),
                             Conversation(id="c_page", workspace_id=WORKSPACE, user_id="u1", title="自动化",
                                          background=True)])
            await session.commit()
    host = FakeHost()
    runs = SummaryQuery(sessionmaker)
    app = FastAPI()
    app.include_router(build_router(host, access, principal_of, lookup_of(sessionmaker), runs=runs,
                                    profiles=profiles_of({"u1": "张三", "u9": "李四"})))
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal")
    state = World(host=host, access=access)
    state.http = http
    state.sessionmaker = sessionmaker
    state.runs = runs
    yield state
    await http.aclose()
    await engine.dispose()


async def test_owner_and_admin_see_every_task_in_the_workspace(world):
    """AC1/AC4：所有者与管理员拿到本空间全量；拿的是不带身份的全量读。"""
    world.host.items = [entry({"id": "alice-task", "owner": {"workspaceId": WORKSPACE, "userId": "u1"}}),
                        entry({"id": "bob-task", "owner": {"workspaceId": WORKSPACE, "userId": "u2"}})]
    for who in ("alice", "bob"):
        response = await world.get(BASE, who)
        assert response.status_code == 200, response.text
        body = response.json()
        assert {item["id"] for item in body["items"]} == {"alice-task", "bob-task"}
        assert body["total"] == 2
    # 全量读：不带调用者身份（owner is None），宿主据此回全部空间的任务
    assert world.host.listed[0]["owner"] is None


async def test_editor_and_outsider_are_forbidden(world):
    """AC4：普通成员与外人请求同一份数据是 403，而不是看到别人的任务。"""
    for who in ("carol", "zed", "nobody"):
        response = await world.get(BASE, who)
        assert response.status_code == 403, response.text
        assert response.json()["detail"] == "只有空间的所有者或管理员可以查看本空间的定时任务"
    assert world.host.listed == [], "拦在权限判定，不往宿主发"


async def test_unhealthy_access_service_is_503(world, monkeypatch):
    monkeypatch.setattr(type(world.access.engine), "healthy", property(lambda self: False))
    response = await world.get(BASE, "alice")
    assert response.status_code == 503
    assert response.json()["detail"] == "权限服务暂时不可用，请稍后重试"


async def test_only_this_workspace_tasks_are_listed(world):
    """AC4：宿主回的是全部空间的任务，业务服务只留下属主是本空间的。"""
    world.host.items = [entry({"id": "mine", "owner": {"workspaceId": WORKSPACE, "userId": "u1"}}),
                        entry({"id": "theirs", "owner": {"workspaceId": OTHER_WORKSPACE, "userId": "u9"}}),
                        entry({"id": "orphan", "owner": None})]
    body = (await world.get(BASE, "alice")).json()
    assert [item["id"] for item in body["items"]] == ["mine"]
    assert body["total"] == 1


async def test_each_task_carries_creator_name_origin_and_last_run(world):
    """AC1：创建者、时间规则、状态、最近一次结果都在，创建者姓名从账号资料来。"""
    world.host.items = [entry({"id": "page-task", "target": {"kind": "session", "sessionId": "c_page"}}),
                        entry({"id": "chat-task", "target": {"kind": "session", "sessionId": "c_chat"}}),
                        entry({"id": "other-task", "owner": {"workspaceId": WORKSPACE, "userId": "u9"}})]
    body = (await world.get(BASE, "alice")).json()
    by_id = {item["id"]: item for item in body["items"]}
    assert by_id["page-task"]["creatorName"] == "张三"
    assert by_id["other-task"]["creatorName"] == "李四"  # 管理员也看得到别人建的
    assert by_id["page-task"]["origin"] == "page"
    assert by_id["chat-task"]["origin"] == "chat"
    assert by_id["page-task"]["rrule"] == RULE
    assert by_id["page-task"]["status"] == "active"
    assert by_id["page-task"]["lastRun"] is None, "还没跑过就没有最近一次"


async def test_last_run_comes_from_the_run_summary(world):
    """最近一次读的是那轮汇总：状态与所在对话原样带出。"""
    world.host.items = [entry({"id": "done"}), entry({"id": "never"})]
    started = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
    with in_workspace(WORKSPACE):
        async with world.sessionmaker() as session:
            session.add(RunSummary(conversation_id="c_chat", turn=1, workspace_id=WORKSPACE, user_id="u1",
                                   question="", status="completed", started_at=started,
                                   facts={"schedule": {"id": ["done"]}}))
            await session.commit()
    body = (await world.get(BASE, "alice")).json()
    by_id = {item["id"]: item for item in body["items"]}
    assert by_id["done"]["lastRun"] == {"status": "completed", "at": "2026-11-10T09:00:00Z",
                                        "conversationId": "c_chat", "title": "随便聊聊", "note": None}
    assert by_id["never"]["lastRun"] is None


async def test_list_survives_a_broken_run_query(world, monkeypatch):
    """汇总查询读挂了时列表照常回、lastRun 为空：审计页不能因为「最近一次」读不到就整页报错。"""

    async def boom(*args, **kwargs):
        raise RuntimeError("汇总查询读挂了")

    monkeypatch.setattr(type(world.runs), "latest_by_fact", boom)
    response = await world.get(BASE, "alice")
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["lastRun"] is None


async def test_disable_passes_the_workspace_and_pauses_the_task(world):
    """AC3：管理员停用本空间的任意一条：宿主按空间停用，回来的状态是已暂停。"""
    response = await world.disable("schedule-1", "bob")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "paused"
    assert world.host.disabled == [("schedule-1", WORKSPACE)]


async def test_disable_of_another_workspace_task_is_404(world):
    """宿主说这个任务不归这个空间：404，不泄漏它存在与否的其它信息。"""
    world.host.disable_effect = ScheduleNotFound("schedule_not_found", "没有这个定时任务", 404)
    response = await world.disable("schedule-2", "alice")
    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "schedule_not_found", "message": "没有这个定时任务"}


async def test_disable_conflicts_and_host_outage(world):
    """正在跑 → 409 等它结束；宿主连不上或出错 → 503。"""
    world.host.disable_effect = KernelError("schedule_execution_pending", "正在跑", 409)
    response = await world.disable("schedule-1", "alice")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "schedule_execution_pending"

    world.host.disable_effect = KernelError("schedule_conflict", "刚被改过", 409)
    response = await world.disable("schedule-1", "alice")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "schedule_conflict"

    world.host.disable_effect = httpx.ConnectError("连不上")
    response = await world.disable("schedule-1", "alice")
    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "schedule_unavailable", "message": "暂时读不到定时任务，请稍后重试"}


async def test_editor_and_outsider_cannot_disable(world):
    """AC4/AC5：停用同样只给所有者与管理员；普通成员请求被拒，宿主根本没被调用。"""
    for who in ("carol", "zed", "nobody"):
        response = await world.disable("schedule-1", who)
        assert response.status_code == 403, response.text
    assert world.host.disabled == []


async def test_host_outage_on_list_is_503_not_an_empty_list(world):
    world.host.list_effect = KernelError("internal_error", "宿主出错了", 500)
    response = await world.get(BASE, "alice")
    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "schedule_unavailable", "message": "暂时读不到定时任务，请稍后重试"}
