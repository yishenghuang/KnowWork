"""宿主请业务服务建自动化对话：定时任务到点要在一个「每次新开」的对话里跑时，宿主先来这里。

宿主上的定时任务只认「带属主令牌的 new_once / new 目标」（令牌由业务服务铸造，见 automations/tokens.py：令牌里
编着建任务的那个空间、那个人）。到点要建对话时，宿主带着令牌里的属主和它预留的会话 id 来这里：

- 场景与权限由业务服务判：这个人此刻还是不是这个空间的成员（宿主给的属主只用来按空间查）；
- 建出来的对话是后台对话（不进「最近」、不进搜索），并绑只读运行配置（自动化跑的时候没有人看着，
  会写、会动外部系统的工具一律不给）；
- 会话 id 用宿主给的：官方 new_once 之后会把目标改成这段会话，重放同一个 id 时要认回同一段对话，不报错。

认证用宿主令牌（与激活、后台对话同一枚）：内部端口只给宿主和 worker 连，令牌是第二道。

- POST /internal/host/v1/automation-conversations   body {sessionId, owner: {workspaceId, userId}}
"""

import hmac
import logging
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..conversations.service import ConversationService
from ..db.base import in_workspace
from ..kernel.contract import KernelError

log = logging.getLogger(__name__)

MemberCheck = Callable[[str, str], bool]  # (用户, 空间) → 是不是空间成员
# 宿主预留的会话 id 形如 session-<uuid>（44 字符）；不超出 conversation.id 列的长度，
# 取值范围与宿主 HTTP 面的 SESSION_ID_PATTERN 一致（宿主那边限 128，这里受列长所限收到 64）
SESSION_ID = r"^[A-Za-z0-9_.:\-]{1,64}$"


class Owner(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    workspace_id: str = Field(alias="workspaceId", min_length=1, max_length=128)
    user_id: str = Field(alias="userId", min_length=1, max_length=128)


class CreateBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: str = Field(alias="sessionId", pattern=SESSION_ID)
    owner: Owner


def build_automation_conversation_router(service: ConversationService, host_token: str, *,
                                         member: MemberCheck) -> APIRouter:
    router = APIRouter(prefix="/internal/host/v1")
    expected = host_token.encode("utf-8")

    def require_host(authorization: Annotated[str, Header()] = "") -> None:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(token.encode("utf-8"), expected):
            raise HTTPException(status_code=401, detail="宿主令牌无效")

    @router.post("/automation-conversations", dependencies=[Depends(require_host)])
    async def create(body: CreateBody) -> dict[str, str]:
        """按宿主给的 id 建一段自动化对话（已有就返回已有的那段）"""
        workspace_id, user_id = body.owner.workspace_id, body.owner.user_id
        if not member(user_id, workspace_id):
            raise HTTPException(status_code=403, detail="这个人不是这个空间的成员")
        with in_workspace(workspace_id):
            try:
                conversation = await service.create(workspace_id=workspace_id, user_id=user_id,
                                                    conversation_id=body.session_id, background=True,
                                                    readonly=True, title="自动化")
            except KernelError as error:
                raise HTTPException(status_code=503, detail=f"宿主没能打开这段对话：{error.code}") from error
        log.info("created automation conversation %s for %s", conversation.id, user_id)
        return {"id": conversation.id}

    return router
