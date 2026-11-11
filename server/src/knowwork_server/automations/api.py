"""自动化页的读接口：列我的定时任务、看单条、看投递记录。

任务存在宿主的官方 schedule 服务里（见 plan-2 的铁律：业务服务不建任务表、不自算下次运行），本模块只做三件事：

- 把请求转给宿主，并用当前调用者的身份说明「这是谁在问」（宿主据此过滤，别人的任务不会出现）；
- 补一个派生字段 `origin`：这条任务是「页面上建的」还是「对话里设的提醒」。判定依据是执行位置那个会话本身
  （页面建的自动化对话是 background 会话），不落第二份记录，前端只读这个字段、不自己按 target 猜；
- 把宿主的错误翻成对外的固定文案：没有这个任务 → 404，宿主暂时不可用 → 503。

对外文案固定，原始错误只写服务端日志。
"""

import logging
from typing import Annotated, Literal, Protocol

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field

from ..conversations.api import Actor, ActorDependency
from ..conversations.service import Conversation, ConversationNotFound
from ..db.base import in_workspace
from ..kernel.contract import KernelError, ScheduleNotFound, SessionOwner
from ..kernel.host_client import HostKernel
from ..sessionfiles.lookup import ConversationLookup
from . import limits, tokens

log = logging.getLogger(__name__)

# 宿主给的 id 形如 schedule-<uuid>，取值范围和会话 id 一样
ScheduleId = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")]

UNAVAILABLE = HTTPException(status_code=503, detail={"code": "schedule_unavailable",
                                                    "message": "暂时读不到定时任务，请稍后重试"})
# 宿主侧的其它错误码在这里一律当「暂时读不到」：自动化页只需要知道现在读不出来、可以重试
HOST_ERRORS = (KernelError, httpx.HTTPError, OSError)


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


class CreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=4000)
    rrule: str = Field(min_length=1, max_length=2000)
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


# 保存前的本地拦截：这几条都是请求本身不合规，回 422 并把原因说清楚
INTERVAL_TOO_SHORT = {"code": "interval_too_short", "message": "间隔不能小于 5 分钟"}
PER_USER_QUOTA = {"code": "quota_exceeded", "message": "每个人最多 20 条定时任务，先删掉不用的再建"}
PER_WORKSPACE_QUOTA = {"code": "quota_exceeded", "message": "每个空间最多 100 条定时任务，请联系管理员清理"}


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


def build_router(kernel: HostKernel, current_actor: ActorDependency,
                 lookup: ConversationLookup | None = None, host_token: str | None = None) -> APIRouter:
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

    async def guard_save(who: Actor, rrule: str) -> None:
        """保存前先拦：间隔太密、本人太多、本空间太多。顺序固定，先说最贴近这条请求的那条。"""
        if limits.interval_too_short(rrule):
            raise rejected(INTERVAL_TOO_SHORT)
        try:
            mine = await kernel.list_schedules(owner=owner_of(who), limit=1)
        except HOST_ERRORS as error:
            raise upstream_error(error, "count my schedules") from error
        if int(mine.get("total", 0)) >= limits.MAX_PER_USER:
            raise rejected(PER_USER_QUOTA)
        try:
            workspace = await kernel.count_schedules(workspace_id=who.workspace_id)
        except HOST_ERRORS as error:
            raise upstream_error(error, "count workspace schedules") from error
        if int(workspace.get("total", 0)) >= limits.MAX_PER_WORKSPACE:
            raise rejected(PER_WORKSPACE_QUOTA)

    async def describe(entry: dict, who: Actor) -> dict:
        return {**entry, "origin": await origin_of(entry, who.workspace_id, who.user_id, lookup)}

    @router.get("")
    async def list_automations(who: Who, limit: Annotated[int, Query(ge=1, le=500)] = 100,
                               offset: Annotated[int, Query(ge=0)] = 0, active: bool | None = None):
        """我的定时任务（含已暂停的，前端按视图分组）"""
        try:
            page = await kernel.list_schedules(owner=owner_of(who), limit=limit, offset=offset, active=active)
        except HOST_ERRORS as error:
            raise upstream_error(error, "list schedules") from error
        items = [await describe(entry, who) for entry in page.get("items", [])]
        return {"items": items, "total": page.get("total", len(items)), "limit": page.get("limit", limit),
                "offset": page.get("offset", offset)}

    @router.get("/{schedule_id}")
    async def get_automation(schedule_id: ScheduleId, who: Who):
        """单条任务"""
        try:
            entry = await kernel.view_schedule(schedule_id, owner=owner_of(who))
        except HOST_ERRORS as error:
            raise upstream_error(error, "view schedule") from error
        return await describe(entry, who)

    @router.get("/{schedule_id}/history")
    async def automation_history(schedule_id: ScheduleId, who: Who,
                                 limit: Annotated[int, Query(ge=1, le=100)] = 20,
                                 before: Annotated[str | None, Query(min_length=1, max_length=256)] = None):
        """投递记录：哪一次、什么时间、投到了哪个对话"""
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

    return router


def _written(entry: dict) -> dict:
    """写路由只回前端立刻要用的四样：id、下次什么时候跑、属于哪一栏、以及改完的版本。"""
    return {"id": entry.get("id"), "scheduledAt": entry.get("scheduledAt"), "origin": entry.get("origin"),
            "updatedAt": entry.get("updatedAt")}
