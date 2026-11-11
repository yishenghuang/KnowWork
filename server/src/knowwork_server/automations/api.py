"""自动化页的读接口：列我的定时任务、看单条、看投递记录。

任务存在宿主的官方 schedule 服务里（见 plan-2 的铁律：业务服务不建任务表、不自算下次运行），本模块只做三件事：

- 把请求转给宿主，并用当前调用者的身份说明「这是谁在问」（宿主据此过滤，别人的任务不会出现）；
- 补一个派生字段 `origin`：这条任务是「页面上建的」还是「对话里设的提醒」。判定依据是执行位置那个会话本身
  （页面建的自动化对话是 background 会话），不落第二份记录，前端只读这个字段、不自己按 target 猜；
- 把宿主的错误翻成对外的固定文案：没有这个任务 → 404，宿主暂时不可用 → 503。

对外文案固定，原始错误只写服务端日志。
"""

import logging
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query

from ..conversations.api import Actor, ActorDependency
from ..conversations.service import ConversationNotFound
from ..kernel.contract import KernelError, ScheduleNotFound, SessionOwner
from ..kernel.host_client import HostKernel
from ..sessionfiles.lookup import ConversationLookup

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


def build_router(kernel: HostKernel, current_actor: ActorDependency,
                 lookup: ConversationLookup | None = None) -> APIRouter:
    router = APIRouter(prefix="/api/workspaces/{workspace_id}/automations", tags=["automations"])
    Who = Annotated[Actor, Depends(current_actor)]

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

    return router
