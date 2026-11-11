"""自动化页的四个行内动作（automations/api.py）：暂停 / 恢复 / 立即运行 / 删除。

这四个动作都不在本地重造调度：业务服务只把调用者的身份（空间 + 用户）带过去，
转调宿主内建 @deepseek-ai/dsh-schedule 的官方写侧。宿主说「刚被改过」「正在跑/排队」
时按既定文案回 409，说「没有这个定时任务」时回 404。
"""

from dataclasses import dataclass
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from knowwork_server.automations.api import build_router
from knowwork_server.conversations.models import Conversation
from knowwork_server.conversations.service import ConversationNotFound
from knowwork_server.db.base import in_workspace, make_engine, make_workspace_sessionmaker
from knowwork_server.db.migrate import MAIN_LINE, upgrade_to_head
from knowwork_server.kernel.contract import KernelError, ScheduleNotFound, SessionOwner

from .fakes import token_actor

pytestmark = pytest.mark.anyio
TOKEN = "t" * 40
HOST_TOKEN = "h" * 40
WORKSPACE = "ws_a"
BASE = f"/api/workspaces/{WORKSPACE}/automations"
OWNER = SessionOwner(workspace_id=WORKSPACE, user_id="u1")
RULE = "DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;COUNT=1"

CONFLICT = {"code": "schedule_conflict", "message": "任务刚被改过，请刷新后再改"}
PENDING = {"code": "schedule_execution_pending", "message": "这个任务正在运行或排队，等它结束再试"}
MISSING = {"code": "schedule_not_found", "message": "没有这个定时任务"}


class FakeHost:
    """宿主客户端替身：记下四个动作各自发出去的 method/path/body/owner，并可按需抛错。"""

    def __init__(self) -> None:
        self.edited: list[dict] = []
        self.ran: list[dict] = []
        self.deleted: list[dict] = []
        self.edit_effect: BaseException | None = None
        self.run_effect: BaseException | None = None
        self.delete_effect: BaseException | None = None
        self.updated_at = "2099-01-01T00:00:00Z"

    def an_entry(self, *, schedule_id: str, status: str = "active", active: bool = True) -> dict:
        return {"id": schedule_id, "kind": "rrule", "title": "写日报", "prompt": "写日报", "rrule": RULE,
                "scheduledAt": "2099-01-01T01:00:00Z",
                "target": {"kind": "session", "sessionId": "c_chat"}, "involvedSessionIds": [],
                "status": status, "active": active, "updatedAt": self.updated_at}

    async def edit_schedule(self, schedule_id, body, *, owner):
        self.edited.append({"id": schedule_id, "body": body, "owner": owner})
        if self.edit_effect is not None:
            raise self.edit_effect
        return self.an_entry(schedule_id=schedule_id, active=body["patch"]["active"])

    async def run_schedule(self, schedule_id, *, owner):
        self.ran.append({"id": schedule_id, "owner": owner})
        if self.run_effect is not None:
            raise self.run_effect
        return self.an_entry(schedule_id=schedule_id)

    async def delete_schedule(self, schedule_id, *, owner):
        self.deleted.append({"id": schedule_id, "owner": owner})
        if self.delete_effect is not None:
            raise self.delete_effect
        return {"id": schedule_id, "deleted": True}


@dataclass
class World:
    host: FakeHost
    chat: Conversation
    sessionmaker: object

    async def call(self, method, path, body=None):
        headers = {"Authorization": f"Bearer {TOKEN}"}
        if method == "get":
            return await self.http.get(path, headers=headers)
        return await self.http.request(method.upper(), path, json=body, headers=headers)


@pytest.fixture
async def world(app_db):
    await upgrade_to_head(app_db.owner_url, app_role=app_db.role, branches=MAIN_LINE)
    engine = make_engine(app_db.app_url)
    sessionmaker = make_workspace_sessionmaker(engine)
    with in_workspace(WORKSPACE):
        async with sessionmaker() as session:
            chat = Conversation(id="c_chat", workspace_id=WORKSPACE, user_id="u1", title="随便聊聊")
            other = Conversation(id="c_other", workspace_id=WORKSPACE, user_id="u2", title="别人的对话")
            session.add_all([chat, other])
            await session.commit()
    host = FakeHost()
    app = FastAPI()
    app.include_router(build_router(host, token_actor(TOKEN, user_id="u1", workspace_id=WORKSPACE),
                                    _directory(sessionmaker), HOST_TOKEN))
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal")
    state = World(host=host, chat=chat, sessionmaker=sessionmaker)
    state.http = http
    yield state
    await http.aclose()
    await engine.dispose()


def _directory(sessionmaker):
    """会话服务的替身：照 ConversationService 的 get / create 取法（create 会真的落一行）。"""

    async def get(*, conversation_id: str, workspace_id: str, user_id: str):
        from sqlalchemy import select

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

    made: list[str] = []

    async def create(*, workspace_id: str, user_id: str, title: str = "", background: bool = False,
                     conversation_id: str | None = None, readonly: bool = False):
        with in_workspace(workspace_id):
            async with sessionmaker() as session:
                conversation = Conversation(id=conversation_id or f"c_auto_{len(made) + 1}",
                                            workspace_id=workspace_id, user_id=user_id, title=title,
                                            background=background, readonly=readonly)
                session.add(conversation)
                await session.commit()
        made.append(conversation.id)
        return conversation

    return SimpleNamespace(get=get, create=create)


async def test_pause_sends_active_false_with_owner(world):
    """暂停：只发 update/active=False，带上调用者身份，回包是写后的那条任务。"""
    response = await world.call("post", f"{BASE}/schedule-1/pause")
    assert response.status_code == 200
    assert response.json()["id"] == "schedule-1"
    assert world.host.edited == [{"id": "schedule-1",
                                  "body": {"action": "update", "patch": {"active": False}},
                                  "owner": OWNER}]


async def test_resume_sends_active_true_with_owner(world):
    """恢复：只发 update/active=True；下一次运行时间由宿主重算，业务服务不自己算。"""
    response = await world.call("post", f"{BASE}/schedule-1/resume")
    assert response.status_code == 200
    assert response.json()["id"] == "schedule-1"
    assert world.host.edited == [{"id": "schedule-1",
                                  "body": {"action": "update", "patch": {"active": True}},
                                  "owner": OWNER}]


async def test_run_calls_host_with_owner(world):
    """立即运行：转调宿主的 run，成功把宿主给的那条任务回出去。"""
    response = await world.call("post", f"{BASE}/schedule-1/run")
    assert response.status_code == 200
    assert response.json()["id"] == "schedule-1"
    assert world.host.ran == [{"id": "schedule-1", "owner": OWNER}]


async def test_delete_calls_host_with_owner(world):
    """删除：转调宿主的 delete，成功只回 deleted，不碰任何对话或消息。"""
    response = await world.call("delete", f"{BASE}/schedule-1")
    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    assert world.host.deleted == [{"id": "schedule-1", "owner": OWNER}]


@pytest.mark.parametrize("path,method,record", [
    ("/schedule-1/pause", "post", "edited"),
    ("/schedule-1/resume", "post", "edited"),
    ("/schedule-1/run", "post", "ran"),
    ("/schedule-1", "delete", "deleted"),
])
async def test_all_actions_carry_owner(world, path, method, record):
    """四个动作无一例外都把空间+用户带过去；宿主才有资格决定这条任务归谁。"""
    response = await world.call(method, f"{BASE}{path}")
    assert response.status_code == 200
    assert getattr(world.host, record)[0]["owner"] == OWNER


@pytest.mark.parametrize("path,method,effect", [
    ("/schedule-1/pause", "post", "edit_effect"),
    ("/schedule-1/resume", "post", "edit_effect"),
    ("/schedule-1/run", "post", "run_effect"),
    ("/schedule-1", "delete", "delete_effect"),
])
async def test_conflict_is_409_with_fixed_message(world, path, method, effect):
    """宿主说刚被改过：四个动作都回 409 与固定文案，前端据此提示刷新。"""
    setattr(world.host, effect, KernelError("schedule_conflict", "任务刚被改过", 409))
    response = await world.call(method, f"{BASE}{path}")
    assert response.status_code == 409
    assert response.json()["detail"] == CONFLICT


@pytest.mark.parametrize("path,method,effect", [
    ("/schedule-1/pause", "post", "edit_effect"),
    ("/schedule-1/resume", "post", "edit_effect"),
    ("/schedule-1/run", "post", "run_effect"),
    ("/schedule-1", "delete", "delete_effect"),
])
async def test_pending_is_409_with_fixed_message(world, path, method, effect):
    """宿主说正在跑/排队（run 的 .then(settled) 会把 pending 转成这个 409）：四个动作都回固定文案。"""
    setattr(world.host, effect, KernelError("schedule_execution_pending", "正在运行或排队", 409))
    response = await world.call(method, f"{BASE}{path}")
    assert response.status_code == 409
    assert response.json()["detail"] == PENDING


@pytest.mark.parametrize("path,method,effect", [
    ("/schedule-1/pause", "post", "edit_effect"),
    ("/schedule-1/resume", "post", "edit_effect"),
    ("/schedule-1/run", "post", "run_effect"),
    ("/schedule-1", "delete", "delete_effect"),
])
async def test_missing_is_404(world, path, method, effect):
    """宿主说没有这条任务：四个动作都回 404，不是 503、也不是空列表。"""
    setattr(world.host, effect, ScheduleNotFound("schedule_not_found", "没有这个定时任务", 404))
    response = await world.call(method, f"{BASE}{path}")
    assert response.status_code == 404
    assert response.json()["detail"] == MISSING
