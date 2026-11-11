"""自动化页的写接口（automations/api.py）：新建与编辑定时任务。
- 保存前先在本地拦三种情况：间隔小于 5 分钟、本人已有 20 条、本空间已有 100 条，并且**不往宿主发请求**；
- 一次建多个时刻走批量口：要么全成，要么把已建的删掉；配额按这一次要建的合计判；
- 「每次新建对话」的目标要带一枚属主令牌，宿主凭它认出这是谁的任务；编辑时沿用旧令牌，不每次换；
- 「固定对话」由业务服务先建一段后台只读对话，再拿它当投递目标；
- 指定对话必须是自己的，别人的当不存在（404）；
- 宿主说刚被改过 → 409 原样透出，前端据此提示刷新而不是静默覆盖。"""

from dataclasses import dataclass
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from knowwork_server.automations import tokens
from knowwork_server.automations.api import build_router
from knowwork_server.conversations.models import Conversation
from knowwork_server.conversations.service import ConversationNotFound
from knowwork_server.db.base import in_workspace, make_engine, make_workspace_sessionmaker
from knowwork_server.db.migrate import MAIN_LINE, upgrade_to_head
from knowwork_server.kernel.contract import KernelError, SessionOwner

from .fakes import token_actor

pytestmark = pytest.mark.anyio
TOKEN = "t" * 40
HOST_TOKEN = "h" * 40
WORKSPACE = "ws_a"
BASE = f"/api/workspaces/{WORKSPACE}/automations"

RULE = "DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;COUNT=1"
MINUTES_4 = "DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=MINUTELY;INTERVAL=4"
MORNING = "DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0"
EVENING = "DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=18;BYMINUTE=30"


class FakeHost:
    """宿主客户端替身：记下写请求看到的是谁、写了什么，按需抛错。"""

    def __init__(self) -> None:
        self.created: list[dict] = []
        self.deleted: list[tuple[str, SessionOwner]] = []
        self.edited: list[dict] = []
        self.listed: list[dict] = []
        self.counted: list[str] = []
        self.viewed: list[tuple[str, SessionOwner]] = []
        self.mine_total = 1
        self.workspace_total = 3
        self.create_effect: BaseException | None = None
        self.fail_create_after: int | None = None
        self.edit_effect: BaseException | None = None
        self.view_effect: BaseException | None = None
        self.current_target: dict = {"kind": "session", "sessionId": "c_chat"}
        self.updated_at = "2099-01-01T00:00:00Z"

    def an_entry(self, *, schedule_id: str, target: dict, title: str = "写日报", prompt: str = "写日报",
                 rrule: str = RULE) -> dict:
        return {"id": schedule_id, "kind": "rrule", "title": title, "prompt": prompt, "rrule": rrule,
                "scheduledAt": "2099-01-01T01:00:00Z", "target": target, "involvedSessionIds": [],
                "status": "active", "updatedAt": self.updated_at}

    async def list_schedules(self, *, owner, limit=100, offset=0, active=None):
        self.listed.append({"owner": owner, "limit": limit, "offset": offset, "active": active})
        # 护栏只数条数，所以这里按 total 说话，items 给不给都不影响
        return {"items": [], "shown": 0, "total": self.mine_total, "limit": limit, "offset": offset}

    async def view_schedule(self, schedule_id, *, owner):
        self.viewed.append((schedule_id, owner))
        if self.view_effect is not None:
            raise self.view_effect
        return self.an_entry(schedule_id=schedule_id, target=self.current_target)

    async def count_schedules(self, *, workspace_id):
        self.counted.append(workspace_id)
        return {"total": self.workspace_total}

    async def create_schedule(self, body, *, owner):
        self.created.append({"body": body, "owner": owner})
        if self.create_effect is not None:
            raise self.create_effect
        # 第几条开始失败（批量建的中途出错）
        if self.fail_create_after is not None and len(self.created) > self.fail_create_after:
            raise KernelError("schedule_unavailable", "宿主写不进去了", 503)
        return self.an_entry(schedule_id="schedule-new", target=body["target"], title=body["title"],
                             prompt=body["prompt"], rrule=body["timing"]["rrule"])

    async def delete_schedule(self, schedule_id, *, owner):
        self.deleted.append((schedule_id, owner))

    async def edit_schedule(self, schedule_id, body, *, owner):
        self.edited.append({"id": schedule_id, "body": body, "owner": owner})
        if self.edit_effect is not None:
            raise self.edit_effect
        patch = body["patch"]
        return self.an_entry(schedule_id=schedule_id, target=patch.get("target", self.current_target),
                             title=patch.get("title", "写日报"), prompt=patch.get("prompt", "写日报"),
                             rrule=(patch.get("timing") or {}).get("rrule", RULE))


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


def new_once(target: dict | None = None, **over):
    return {"title": "写日报", "prompt": "把今天的进展写下来", "rrule": RULE,
            "target": target if target is not None else {"kind": "new_once"}, **over}


async def test_new_once_task_carries_owner_token_back_to_me(world):
    response = await world.call("post", BASE, new_once())
    assert response.status_code == 201, response.text
    body = response.json()
    assert body == {"id": "schedule-new", "scheduledAt": "2099-01-01T01:00:00Z", "origin": "page",
                    "updatedAt": "2099-01-01T00:00:00Z"}

    sent = world.host.created[0]
    assert sent["owner"] == SessionOwner(workspace_id=WORKSPACE, user_id="u1")
    # 时间规则要包在 timing 里；宿主只认这个形状
    assert sent["body"]["timing"] == {"kind": "rrule", "rrule": RULE}
    target = sent["body"]["target"]
    assert target["kind"] == "new_once"
    # 令牌能被同一枚宿主令牌解回「当前用户 + 当前空间」：宿主靠它认人
    assert tokens.owner_of(target["create"]["agentPreset"], HOST_TOKEN) == tokens.TokenOwner(
        workspace_id=WORKSPACE, user_id="u1")


async def test_fixed_conversation_is_created_first_then_used_as_the_target(world):
    response = await world.call("post", BASE, new_once({"kind": "fixed"}))
    assert response.status_code == 201, response.text
    target = world.host.created[0]["body"]["target"]
    assert target["kind"] == "session"

    # 先建了一段后台只读对话，任务就投在它里面；origin 因此算页面上建的
    conversation = await _load(world, target["sessionId"])
    assert conversation.background is True and conversation.readonly is True
    assert conversation.title == "自动化"
    assert conversation.user_id == "u1"
    assert response.json()["origin"] == "page"


async def _load(world, conversation_id: str) -> Conversation:
    from sqlalchemy import select

    with in_workspace(WORKSPACE):
        async with world.sessionmaker() as session:
            return (await session.execute(select(Conversation).where(
                Conversation.id == conversation_id))).scalar_one()


async def test_editing_keeps_the_old_owner_token(world):
    preset = tokens.mint(tokens.TokenOwner(workspace_id=WORKSPACE, user_id="u1"), HOST_TOKEN)
    world.host.current_target = {"kind": "new_once", "create": {"agentPreset": preset}}
    response = await world.call("patch", f"{BASE}/schedule-1",
                                {"title": "改成写周报", "target": {"kind": "new_once"},
                                 "expectedUpdatedAt": "2099-01-01T00:00:00Z"})
    assert response.status_code == 200, response.text
    sent = world.host.edited[0]
    assert sent["id"] == "schedule-1"
    assert sent["body"]["expectedUpdatedAt"] == "2099-01-01T00:00:00Z"
    assert sent["body"]["patch"]["target"]["create"]["agentPreset"] == preset


async def test_four_minute_interval_is_stopped_before_the_host(world):
    response = await world.call("post", BASE, new_once(rrule=MINUTES_4))
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "interval_too_short", "message": "间隔不能小于 5 分钟"}
    # 拦在本地：一条请求都不该发给宿主
    assert world.host.created == [] and world.host.listed == [] and world.host.counted == []


async def test_twenty_tasks_of_mine_is_the_ceiling(world):
    world.host.mine_total = 20
    response = await world.call("post", BASE, new_once())
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "quota_exceeded",
                                         "message": "每个人最多 20 条定时任务，先删掉不用的再建"}
    assert world.host.created == []
    assert world.host.counted == [], "本人已经满了，不必再问空间"


async def test_hundred_tasks_in_the_workspace_is_the_ceiling(world):
    world.host.workspace_total = 100
    response = await world.call("post", BASE, new_once())
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "quota_exceeded",
                                         "message": "每个空间最多 100 条定时任务，请联系管理员清理"}
    assert world.host.counted == [WORKSPACE]
    assert world.host.created == []


async def test_conflict_from_the_host_is_passed_through_as_409(world):
    world.host.edit_effect = KernelError("schedule_conflict", "任务刚被改过", 409)
    response = await world.call("patch", f"{BASE}/schedule-1", {"title": "改成写周报"})
    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "schedule_conflict", "message": "任务刚被改过，请刷新后再改"}


async def test_pending_execution_is_passed_through_as_409(world):
    world.host.edit_effect = KernelError("schedule_execution_pending", "正在跑", 409)
    response = await world.call("patch", f"{BASE}/schedule-1", {"title": "改成写周报"})
    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "schedule_execution_pending",
                                         "message": "这个任务正在运行或排队，等它结束再试"}



def batch(rules: list[str] | None = None, target: dict | None = None):
    return {"title": "写日报", "prompt": "把今天的进展写下来",
            "rules": rules if rules is not None else [MORNING, EVENING],
            "target": target if target is not None else {"kind": "new_once"}}


async def test_batch_creates_every_moment_with_one_request(world):
    response = await world.call("post", f"{BASE}/batch", batch())
    assert response.status_code == 201, response.text
    body = response.json()
    assert [item["id"] for item in body["items"]] == ["schedule-new", "schedule-new"]
    # 每条规则各建一条任务，同一个执行位置（令牌只铸一次，也只建一次固定对话）
    assert [sent["body"]["timing"]["rrule"] for sent in world.host.created] == [MORNING, EVENING]
    assert {sent["body"]["target"]["kind"] for sent in world.host.created} == {"new_once"}
    assert world.host.deleted == []


async def test_batch_rolls_back_what_it_already_created(world):
    world.host.fail_create_after = 1
    response = await world.call("post", f"{BASE}/batch", batch())
    assert response.status_code == 503, response.text
    # 第二条失败：留下来的是半套，得把第一条删掉
    assert len(world.host.created) == 2
    assert world.host.deleted[0][0] == "schedule-new"


async def test_batch_counts_the_whole_batch_against_the_quota(world):
    # 已经有 19 条，一次再加 2 条就超过 20 —— 按一条判会漏过去
    world.host.mine_total = 19
    response = await world.call("post", f"{BASE}/batch", batch())
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "quota_exceeded",
                                         "message": "每个人最多 20 条定时任务，先删掉不用的再建"}
    assert world.host.created == []


async def test_batch_with_one_too_dense_rule_creates_nothing(world):
    response = await world.call("post", f"{BASE}/batch", batch([MORNING, MINUTES_4]))
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "interval_too_short", "message": "间隔不能小于 5 分钟"}
    assert world.host.created == []

async def test_target_session_must_be_my_own_conversation(world):
    response = await world.call("post", BASE, new_once({"kind": "session", "sessionId": "c_other"}))
    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "conversation_not_found", "message": "会话不存在"}
    assert world.host.created == []

    # 自己的对话可以
    mine = await world.call("post", BASE, new_once({"kind": "session", "sessionId": "c_chat"}))
    assert mine.status_code == 201, mine.text
    assert world.host.created[0]["body"]["target"] == {"kind": "session", "sessionId": "c_chat"}
