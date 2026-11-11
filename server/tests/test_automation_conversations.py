"""宿主请业务服务建自动化对话（automations/internal.py）：定时任务到点要在「每次新开」的对话里跑时先来这里。

- 宿主令牌要对、人要是空间成员，否则一段对话都不建；
- 建出来的对话是后台对话（不进「最近」与搜索），并绑只读运行配置；
- 会话 id 用宿主预留的那个；同一 id 重放时认回同一段对话，不报错（官方 new_once 会重放）。
"""

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from knowwork_server.automations.internal import build_automation_conversation_router
from knowwork_server.conversations.listeners import Broadcaster
from knowwork_server.conversations.pump import EventPump, PumpTimings
from knowwork_server.conversations.replay import EventFeed
from knowwork_server.conversations.service import ConversationService
from knowwork_server.conversations.writer import BatchWriter
from knowwork_server.db.base import in_workspace, make_engine, make_workspace_sessionmaker
from knowwork_server.db.migrate import MAIN_LINE, upgrade_to_head
from knowwork_server.kernel.contract import KernelError

from .fakes import FakeKernel

pytestmark = pytest.mark.anyio
HOST_TOKEN = "h" * 40
MEMBERS = {("u1", "ws_a"), ("u2", "ws_a")}
SESSION_ID = "session-0e1b6f74-6a4e-4a53-9a11-2a2b1c9d0001"


class RecordingProfiles:
    """记下每次编译要的只读标记；运行配置本身的内容由 profile 的单测覆盖。"""

    def __init__(self, profile=None):
        self.calls = []
        self._profile = profile

    async def compile(self, conversation, selection=None, readonly=False):
        self.calls.append((conversation.id, readonly))
        return self._profile

    async def bound(self, conversation):
        return None

    async def bind(self, conversation, profile):
        return None


@pytest.fixture
async def world(app_db):
    """和生产一样：应用账号不是超级用户、表开了行级安全，接口按宿主给的属主声明当前空间才查得到对话。"""
    await upgrade_to_head(app_db.owner_url, app_role=app_db.role, branches=MAIN_LINE)
    engine = make_engine(app_db.app_url)
    sessionmaker = make_workspace_sessionmaker(engine)
    kernel = FakeKernel()
    writer = BatchWriter(sessionmaker)
    broadcaster = Broadcaster()
    pump = EventPump(kernel, sessionmaker, writer, broadcaster, timings=PumpTimings(idle_timeout=0.2))
    profiles = RecordingProfiles()
    service = ConversationService(kernel, sessionmaker, pump,
                                  EventFeed(sessionmaker, writer, broadcaster, pump.produced_upto),
                                  profiles=profiles)
    app = FastAPI()
    app.include_router(build_automation_conversation_router(
        service, HOST_TOKEN, member=lambda user, ws: (user, ws) in MEMBERS))
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal")

    async def create(body, token=HOST_TOKEN):
        return await http.post("/internal/host/v1/automation-conversations", json=body,
                               headers={"Authorization": f"Bearer {token}"})

    yield SimpleNamespace(kernel=kernel, service=service, profiles=profiles, create=create, http=http)
    await http.aclose()
    await pump.close()
    await engine.dispose()


def _body(session_id=SESSION_ID, user_id="u1", workspace_id="ws_a"):
    return {"sessionId": session_id, "owner": {"workspaceId": workspace_id, "userId": user_id}}


async def test_a_host_token_is_required(world):
    assert (await world.create(_body(), token="x" * 40)).status_code == 401
    assert world.kernel.opened == [], "令牌不对时一段对话都不建"


async def test_an_outsider_is_refused(world):
    assert (await world.create(_body(user_id="outsider"))).status_code == 403
    assert (await world.create(_body(workspace_id="ws_b"))).status_code == 403
    assert world.kernel.opened == []


async def test_creates_a_background_conversation_with_the_host_id(world):
    response = await world.create(_body())
    assert response.status_code == 200, response.text
    conversation_id = response.json()["id"]
    assert conversation_id == SESSION_ID, "用宿主预留的会话 id：官方之后会拿它当投递目标"
    with in_workspace("ws_a"):
        conversation = await world.service.get(conversation_id=conversation_id, workspace_id="ws_a", user_id="u1")
    assert (conversation.workspace_id, conversation.user_id, conversation.background) == ("ws_a", "u1", True)
    assert conversation.title == "自动化"
    assert world.profiles.calls == [(SESSION_ID, True)], "建自动化对话要绑只读运行配置"
    assert world.kernel.opened[-1].session_id == SESSION_ID


async def test_the_readonly_mark_is_persisted_so_reopening_stays_readonly(world):
    """宿主空闲回收会话、业务服务重启之后再打开这段对话，仍要按只读编译：标记落在会话上，不只在建的这一次。"""
    assert (await world.create(_body())).status_code == 200
    with in_workspace("ws_a"):
        conversation = await world.service.get(conversation_id=SESSION_ID, workspace_id="ws_a", user_id="u1")
    assert conversation.readonly is True
    world.profiles.calls.clear()
    # 不带 readonly 参数地重算（宿主回收后重开走的就是这条：_ensure_open → _profile(conversation, NO_SELECTION)）
    await world.service._profile(conversation, None)
    assert world.profiles.calls == [(SESSION_ID, True)], "重开时按会话上的标记只读编译"


async def test_an_automation_conversation_stays_out_of_recent_and_search(world):
    """「每次新建对话」跑出来的对话不进本人「最近」，也搜不到：它是后台对话，不是他自己开的。"""
    assert (await world.create(_body())).status_code == 200
    with in_workspace("ws_a"):
        page = await world.service.list_page(workspace_id="ws_a", user_id="u1")
        hits = await world.service.search(workspace_id="ws_a", user_id="u1", query="自动化")
    assert page.items == (), "最近里看不到自动化建的对话"
    assert hits == (), "搜也搜不到"


async def test_replaying_the_same_session_id_returns_the_same_conversation(world):
    first = await world.create(_body())
    again = await world.create(_body())
    assert (first.status_code, again.status_code) == (200, 200)
    assert again.json()["id"] == first.json()["id"]
    assert len(world.kernel.opened) == 1, "重放不再打开一次宿主会话"


async def test_the_readonly_profile_denies_everything_but_read():
    """只读运行配置：自动化跑的时候没有人看着，会写、会动外部系统的工具全进拒绝清单，只留只读工具。"""
    from knowwork_server.profile.compiler import ProfileFacts, compile_profile
    from knowwork_server.tools.registry import ToolSpec

    from .profile_support import BUILTIN, CRM, ERP, SCHEMA

    tools = (BUILTIN.spec, CRM.spec, ERP.spec, ToolSpec("kw_exec", "跑命令", SCHEMA, "dangerous"))
    permitted = frozenset(tool.name for tool in tools)
    readable = compile_profile(ProfileFacts(workspace_id="ws_a", user_id="u1", role="editor", member=True,
                                            tools=tools, permitted_tools=permitted, builtin_tools=frozenset(),
                                            readonly=True))
    assert {tool.name for tool in readable.tools} == {"kw_now", "erp_read"}, "只留只读工具"
    assert readable.denied_tools == ("crm_write", "kw_exec"), "写与 dangerous 全部拒绝"
    assert readable.policy().deny == readable.denied_tools
    writable = compile_profile(ProfileFacts(workspace_id="ws_a", user_id="u1", role="editor", member=True,
                                            tools=tools, permitted_tools=permitted, builtin_tools=frozenset()))
    assert writable.denied_tools == (), "不标只读时照旧"


async def test_the_host_failure_is_reported(world):
    world.kernel.open_effects = [KernelError("internal_error", "宿主出错了", 500)]
    response = await world.create(_body())
    assert response.status_code == 503 and "internal_error" in response.json()["detail"]
