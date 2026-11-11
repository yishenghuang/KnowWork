"""自动化页的「一句话生成草稿」（automations/draft.py）：一次模型调用把用户那句话翻成表单草稿。

- 草稿永远不建任务：本模块没有宿主客户端，草稿路径上也不会有任何写库、建对话的调用（AC3 靠这里的结构保证）；
- 模型的话认不出 → 200 加一份空草稿和一句「没听懂」，不报错；
- 预设校验不过就退 RRULE 原文（AC4 的服务端出口），两者都没有才是 timing: null；
- 模型调用失败或装配没给模型客户端 → 503 draft_unavailable。"""

from dataclasses import dataclass

import httpx
import pytest
from fastapi import FastAPI

from knowwork_server.automations.draft import build_router
from knowwork_server.db.base import make_engine, make_workspace_sessionmaker
from knowwork_server.db.migrate import MAIN_LINE, upgrade_to_head
from knowwork_server.models.client import ModelCallError

from .fakes import token_actor

pytestmark = pytest.mark.anyio
TOKEN = "t" * 40
WORKSPACE = "ws_a"
PATH = f"/api/workspaces/{WORKSPACE}/automations/draft"

DAILY = ('{"title":"交日报","prompt":"提醒我把今天的日报交了",'
         '"preset":{"kind":"daily","every":1,"times":["09:00"]},"target":"new_once"}')


class FakeModels:
    """模型客户端替身：记下每次调用看到的是谁、发了什么、带了哪些参数，按需回话或抛错。"""

    def __init__(self, reply: str = DAILY, raises: BaseException | None = None) -> None:
        self.reply = reply
        self.raises = raises
        self.calls: list[dict] = []

    async def chat(self, workspace_id, alias, messages, **kwargs):
        self.calls.append({"workspace_id": workspace_id, "alias": alias, "messages": messages, **kwargs})
        if self.raises is not None:
            raise self.raises
        return self.reply


@dataclass
class World:
    models: FakeModels

    async def draft(self, text: str = "每天早上九点提醒我把日报交了", time_zone: str = "Asia/Shanghai"):
        return await self.http.post(PATH, json={"text": text, "timeZone": time_zone},
                                    headers={"Authorization": f"Bearer {TOKEN}"})

    async def post(self, body):
        return await self.http.post(PATH, json=body, headers={"Authorization": f"Bearer {TOKEN}"})


@pytest.fixture
async def world_factory(app_db):
    http_clients: list[httpx.AsyncClient] = []
    engines = []
    await upgrade_to_head(app_db.owner_url, app_role=app_db.role, branches=MAIN_LINE)
    engine = make_engine(app_db.app_url)
    engines.append(engine)
    # 就绪用的会话工厂：草稿路由本身不碰库，这里只是照自动化写接口的测试骨架拿一份真库
    make_workspace_sessionmaker(engine)

    def make(models: FakeModels | None) -> World:
        app = FastAPI()
        app.include_router(build_router(models, token_actor(TOKEN, user_id="u1", workspace_id=WORKSPACE)))
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://internal")
        http_clients.append(http)
        state = World(models=models)
        state.http = http
        return state

    yield make
    for http in http_clients:
        await http.aclose()
    for engine in engines:
        await engine.dispose()


@pytest.fixture
async def world(world_factory):
    return world_factory(FakeModels())


async def test_draft_fills_every_field_with_one_call(world):
    """正常：一次调用把标题、提示词、时间规则、执行位置都填出来，参数照契约（后台、不传 response_format）。"""
    response = await world.draft()
    assert response.status_code == 200, response.text
    assert response.json() == {"title": "交日报", "prompt": "提醒我把今天的日报交了",
                               "timing": {"preset": {"kind": "daily", "every": 1, "times": ["09:00"]}},
                               "target": "new_once", "note": None}
    assert len(world.models.calls) == 1
    call = world.models.calls[0]
    assert call["workspace_id"] == WORKSPACE and call["alias"] == "default"
    assert call["max_tokens"] == 600 and call["temperature"] == 0.0
    assert call["background"] is False
    # 厂商对 response_format 支持不一：契约要求不传
    assert "response_format" not in call
    assert "Asia/Shanghai" in call["messages"][0]["content"]
    assert call["messages"][-1] == {"role": "user", "content": "每天早上九点提醒我把日报交了"}


async def test_not_json_gives_empty_draft_not_an_error(world_factory):
    """模型回了一句大白话：200 + 全空 + 一句「没听懂」，不报错也不乱填。"""
    world = world_factory(FakeModels(reply="好的：每天九点。"))
    response = await world.draft()
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title"] is None and body["prompt"] is None
    assert body["timing"] is None and body["target"] is None
    assert body["note"]


async def test_unknown_preset_falls_back_to_rrule(world_factory):
    """预设之外的说法：落到 RRULE 原文（前端 parseRule 认不出就当「自定义」，AC4 的服务端一半）。"""
    world = world_factory(FakeModels(reply='{"title":"年报","rrule":"FREQ=YEARLY;BYMONTH=3",'
                                       '"preset":{"kind":"cron","expr":"* * * * *"}}'))
    response = await world.draft()
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["timing"] == {"rrule": "FREQ=YEARLY;BYMONTH=3"}
    assert body["title"] == "年报"
    assert body["prompt"] is None and body["target"] is None


async def test_invalid_preset_without_rrule_gives_null_timing(world_factory):
    """预设校验不过又没有 rrule：timing 为 null，校验不过的半成品绝不透给前端。"""
    world = world_factory(FakeModels(reply='{"title":"交日报","preset":{"kind":"daily","every":1,'
                                       '"times":["9am"]}}'))
    response = await world.draft()
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["timing"] is None
    assert body["title"] == "交日报"


async def test_rrule_without_freq_prefix_is_dropped(world_factory):
    """rrule 不是以 FREQ= 开头：当作没给（同样落到 timing: null）。"""
    world = world_factory(FakeModels(reply='{"title":"交日报","rrule":"every day at 9"}'))
    response = await world.draft()
    assert response.status_code == 200, response.text
    assert response.json()["timing"] is None


async def test_model_failure_is_503(world_factory):
    """模型调用失败：503，对外只给一句固定文案。"""
    world = world_factory(FakeModels(raises=ModelCallError("model_unavailable", "模型服务暂时不可用", retryable=True)))
    response = await world.draft()
    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "draft_unavailable", "message": "模型暂时用不了，先自己填一下表单"}


async def test_missing_model_client_is_503(world_factory):
    """装配没给模型客户端：同样 503，不调任何东西。"""
    world = world_factory(None)
    response = await world.draft()
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "draft_unavailable"


async def test_text_and_time_zone_validation(world):
    """text 为空或超过 1000 字、时区超过 64 字：422（pydantic 拦下，不调模型）。"""
    for body in ({"text": ""}, {"text": "x" * 1001}, {"text": "每天九点", "timeZone": "z" * 65},
                 {"text": "每天九点", "extra": 1}):
        response = await world.post(body)
        assert response.status_code == 422, (body, response.text)
    assert world.models.calls == []


async def test_empty_time_zone_is_accepted(world):
    """时区可以是空串（前端没取到本机时区时）：照 UTC 写进提示词，不是 422。"""
    response = await world.post({"text": "每天早上九点交日报", "timeZone": ""})
    assert response.status_code == 200, response.text
    system = world.models.calls[0]["messages"][0]["content"]
    assert "Etc/UTC" in system


async def test_text_is_trimmed_before_the_call(world):
    """用户随手打的空白不进提示词。"""
    response = await world.post({"text": "  每天早上九点交日报  "})
    assert response.status_code == 200, response.text
    assert world.models.calls[0]["messages"][-1]["content"] == "每天早上九点交日报"
