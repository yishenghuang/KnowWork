"""自动化页的读接口（automations/api.py）：列我的定时任务、看单条、看投递记录。
- 请求带的是当前用户身份：宿主按它过滤，别人的任务不会出现；
- 宿主读不出来（连不上、出错）→ 503 且 code=schedule_unavailable，前端据此显示「暂时读不到」而不是空列表；
- 宿主说没有这个任务（不存在或不是他的）→ 404 code=schedule_not_found；
- 每条任务补一个 origin：页面上建的（page）还是对话里设的提醒（chat），判定在业务服务一处做完。"""

from dataclasses import dataclass
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from knowwork_server.automations.api import build_router
from knowwork_server.conversations.models import Conversation
from knowwork_server.db.base import in_workspace, make_engine, make_workspace_sessionmaker
from knowwork_server.db.migrate import MAIN_LINE, upgrade_to_head
from knowwork_server.kernel.contract import KernelError, ScheduleNotFound, SessionOwner

from .fakes import token_actor

pytestmark = pytest.mark.anyio
TOKEN = "t" * 40
WORKSPACE = "ws_a"

RULE = "DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;COUNT=1"


def entry(over: dict | None = None) -> dict:
    """宿主 view/list 返回的 entry（照官方 entry(task) 的字段）。"""
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
    """宿主客户端替身：记下每次调用看到的是谁在问，按需抛错。"""

    def __init__(self) -> None:
        self.listed: list[dict] = []
        self.viewed: list[tuple[str, SessionOwner]] = []
        self.histories: list[tuple[str, SessionOwner, int, str | None]] = []
        self.list_effect: BaseException | None = None
        self.view_effect: BaseException | None = None
        self.history_effect: BaseException | None = None
        self.items: list[dict] = [entry()]

    async def list_schedules(self, *, owner, limit=100, offset=0, active=None):
        self.listed.append({"owner": owner, "limit": limit, "offset": offset, "active": active})
        if self.list_effect is not None:
            raise self.list_effect
        return {"items": self.items, "shown": len(self.items), "total": len(self.items), "limit": limit, "offset": offset}

    async def view_schedule(self, schedule_id, *, owner):
        self.viewed.append((schedule_id, owner))
        if self.view_effect is not None:
            raise self.view_effect
        return entry({"id": schedule_id})

    async def schedule_history(self, schedule_id, *, owner, limit=20, before=None):
        self.histories.append((schedule_id, owner, limit, before))
        if self.history_effect is not None:
            raise self.history_effect
        return {"id": schedule_id, "records": [{"scheduledAt": "2099-01-01T01:00:00Z",
                                                "deliveredAt": "2099-01-01T01:00:01Z",
                                                "messageId": "m1", "targetSessionId": "c_chat",
                                                "prompt": "把今天的进展写下来"}],
                "earlierRecordsUnavailable": False, "earlierRecordsPruned": False,
                "retention": {"deliveries": 50, "days": 30}}


@dataclass
class World:
    host: FakeHost
    chat: Conversation
    page: Conversation

    async def get(self, path, headers=None):
        return await self.http.get(path, headers=headers if headers is not None else {"Authorization": f"Bearer {TOKEN}"})

    async def history(self, path, headers=None):
        return await self.get(path, headers)


@pytest.fixture
async def world(app_db):
    await upgrade_to_head(app_db.owner_url, app_role=app_db.role, branches=MAIN_LINE)
    engine = make_engine(app_db.app_url)
    sessionmaker = make_workspace_sessionmaker(engine)
    # 会话判定要用到：一个是用户的聊天（chat），一个是页面建出来的自动化专属对话（page）
    with in_workspace(WORKSPACE):
        async with sessionmaker() as session:
            chat = Conversation(id="c_chat", workspace_id=WORKSPACE, user_id="u1", title="随便聊聊")
            page = Conversation(id="c_page", workspace_id=WORKSPACE, user_id="u1", title="自动化", background=True)
            session.add_all([chat, page])
            await session.commit()
    host = FakeHost()
    app = FastAPI()
    app.include_router(build_router(host, token_actor(TOKEN, user_id="u1", workspace_id=WORKSPACE),
                                    _lookup(sessionmaker)))
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal")
    state = World(host=host, chat=chat, page=page)
    state.http = http
    yield state
    await http.aclose()
    await engine.dispose()


def _lookup(sessionmaker):
    """会话查表的替身：照 ConversationService.get 的取法。"""

    async def get(*, conversation_id: str, workspace_id: str, user_id: str):
        from sqlalchemy import select

        # 生产里这项工作空间由调用者依赖设好（principals._member_of），这里替身自己设，否则行级安全看不到行
        with in_workspace(workspace_id):
            async with sessionmaker() as session:
                conversation = (await session.execute(select(Conversation).where(
                    Conversation.id == conversation_id,
                    Conversation.workspace_id == workspace_id,
                    Conversation.user_id == user_id,
                ))).scalar_one_or_none()
        if conversation is None:
            from knowwork_server.conversations.service import ConversationNotFound

            raise ConversationNotFound(conversation_id)
        return conversation

    return SimpleNamespace(get=get)


BASE = f"/api/workspaces/{WORKSPACE}/automations"


async def test_lists_my_tasks_with_my_identity(world):
    response = await world.get(BASE)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 1 and body["items"][0]["id"] == "schedule-1"
    # 请求带的是当前用户身份：宿主按它过滤
    assert world.host.listed[0]["owner"] == SessionOwner(workspace_id=WORKSPACE, user_id="u1")


async def test_origin_says_where_the_task_was_created(world):
    world.host.items = [
        entry({"id": "page-fixed", "target": {"kind": "session", "sessionId": "c_page"}}),
        entry({"id": "chat", "target": {"kind": "session", "sessionId": "c_chat"}}),
        entry({"id": "page-new", "target": {"kind": "new", "create": {}}}),
    ]
    body = (await world.get(BASE)).json()
    assert {item["id"]: item["origin"] for item in body["items"]} == {
        "page-fixed": "page", "chat": "chat", "page-new": "page"}


async def test_single_task_and_its_history(world):
    single = await world.get(f"{BASE}/schedule-1")
    assert single.status_code == 200
    assert single.json()["title"] == "写日报"
    assert world.host.viewed[0] == ("schedule-1", SessionOwner(workspace_id=WORKSPACE, user_id="u1"))

    history = await world.get(f"{BASE}/schedule-1/history?limit=5")
    assert history.status_code == 200
    assert history.json()["records"][0]["messageId"] == "m1"
    assert world.host.histories[0] == ("schedule-1", SessionOwner(workspace_id=WORKSPACE, user_id="u1"), 5, None)


async def test_host_outage_is_503_not_an_empty_list(world):
    world.host.list_effect = KernelError("internal_error", "宿主出错了", 500)
    response = await world.get(BASE)
    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "schedule_unavailable", "message": "暂时读不到定时任务，请稍后重试"}

    # 连不上宿主同样算暂时读不到
    world.host.list_effect = httpx.ConnectError("连不上")
    assert (await world.get(BASE)).status_code == 503

    world.host.view_effect = OSError("网络断了")
    assert (await world.get(f"{BASE}/schedule-1")).status_code == 503
    world.host.history_effect = KernelError("internal_error", "宿主出错了", 500)
    assert (await world.get(f"{BASE}/schedule-1/history")).status_code == 503


async def test_missing_or_someone_elses_task_is_404(world):
    world.host.view_effect = ScheduleNotFound("schedule_not_found", "没有这个定时任务", 404)
    response = await world.get(f"{BASE}/schedule-2")
    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "schedule_not_found", "message": "没有这个定时任务"}

    world.host.history_effect = ScheduleNotFound("schedule_not_found", "没有这个定时任务", 404)
    assert (await world.get(f"{BASE}/schedule-2/history")).status_code == 404


async def test_task_id_shape_is_checked(world):
    assert (await world.get(f"{BASE}/bad id")).status_code == 422, "不合法 id 不往宿主发"
    assert world.host.viewed == []
