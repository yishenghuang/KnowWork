"""管理端的自动化任务审计：看本空间全部定时任务、停用其中任意一条。

任务本身在宿主的官方 schedule 服务里（plan-2 的铁律：业务服务不建任务表、不自算下次运行）。这里只做两件事：

- 读：走宿主不带调用者身份的全量读（宿主为每条任务补 owner），再按任务属主过滤出本空间的。调用者必须是这个地方的
  所有者或管理员（workspace:edit），普通用户根本到不了这一步——他们请求同一份数据拿到的是 403，而不是别人的任务
  （AC4）。每条任务补上创建者姓名、origin 与 lastRun，说法与「我的定时任务」一致；
- 停用：透传宿主的管理端停用口（x-knowwork-admin-workspace）。宿主只接受 {patch:{active:false}}，并核对任务属主
  确实属于这个空间，不属于的回 404。

管理端只有这两件事：不替别人建任务、不改任务内容（AC5）；改内容仍由创建者自己在自动化页里做。
"""

import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..access.api import ProfileLookup
from ..access.service import AccessService
from ..access.vocab import WORKSPACE_RESOURCE, Action
from ..auth.principal import Principal
from ..conversations.summaries import SummaryQuery, SummaryRow
from ..kernel.contract import ScheduleKernel
from ..sessionfiles.lookup import ConversationLookup
from .api import HOST_ERRORS, ScheduleId, last_run, latest_runs, origin_of, upstream_error, write_error

log = logging.getLogger(__name__)

# 宿主单页最多 500 条（MAX_LIST_LIMIT）。一次翻二十页：真到这一步说明任务上万条了，宁可少读也不无限翻
PAGE_SIZE = 500
MAX_PAGES = 20

# 状态筛选与「我的定时任务」用同一组分档（宿主 status 字段的三个取值）
StatusFilter = Literal["active", "paused", "ended"]

FORBIDDEN = "只有空间的所有者或管理员可以查看本空间的定时任务"
ACCESS_UNAVAILABLE = "权限服务暂时不可用，请稍后重试"


def owner_workspace(entry: dict) -> str | None:
    """宿主为全量读补的属主：这条任务归哪个空间。没登记属主的任务返回 None（谁也不归，不显示）。"""
    owner = entry.get("owner")
    if not isinstance(owner, dict):
        return None
    value = owner.get("workspaceId")
    return value if isinstance(value, str) and value else None


def owner_user(entry: dict) -> str | None:
    """这条任务的创建者（宿主属主账本里的 userId）。"""
    owner = entry.get("owner")
    if not isinstance(owner, dict):
        return None
    value = owner.get("userId")
    return value if isinstance(value, str) and value else None


def build_router(kernel: ScheduleKernel, access: AccessService,
                 current_principal: Callable[..., Awaitable[Principal]],
                 lookup: ConversationLookup | None = None,
                 runs: SummaryQuery | None = None, profiles: ProfileLookup | None = None) -> APIRouter:
    router = APIRouter(prefix="/api/workspaces/{workspace_id}/automations/admin", tags=["automations"])
    Who = Annotated[Principal, Depends(current_principal)]

    def require_admin(who: Principal, workspace_id: str) -> None:
        """这个空间的所有者与管理员（系统管理员任何空间都算）；权限服务不健康时 fail-closed。"""
        if not access.engine.healthy:
            raise HTTPException(status_code=503, detail=ACCESS_UNAVAILABLE)
        if not access.check(who.user_id, workspace_id, WORKSPACE_RESOURCE, Action.EDIT):
            raise HTTPException(status_code=403, detail=FORBIDDEN)

    async def catalog() -> tuple[list[dict], bool]:
        """宿主里的全部任务，不按调用者过滤。多翻几页：别的空间的任务可能把本空间的挤出第一页。

        第二个返回值说明「还有没读完的」：翻满二十页仍没到底时不再往下翻，但也不能假装列表是完整的
        （AC1 要的是本空间全部任务）。调用方把它如实带给前端，由界面说明这一次只列出了前一部分。
        """
        found: list[dict] = []
        offset = 0
        truncated = False
        for _ in range(MAX_PAGES):
            page = await kernel.list_schedules(owner=None, limit=PAGE_SIZE, offset=offset)
            batch = [entry for entry in page.get("items", []) if isinstance(entry, dict)]
            found.extend(batch)
            total = page.get("total")
            offset += len(batch)
            if not batch or not isinstance(total, int) or offset >= total:
                truncated = False  # 这一次读到到底了
                break
            truncated = True  # 后面还有，接着读；读满页数仍没到底就是上面那个 True
        return found, truncated

    async def creator_names(entries: list[dict]) -> dict[str, str]:
        """一次把创建者姓名取回来。查不到（账号注销、资料服务出错）就留空，列表照常显示，不因为名字读不出发 503。"""
        user_ids = tuple(dict.fromkeys(uid for uid in (owner_user(entry) for entry in entries) if uid))
        if profiles is None or not user_ids:
            return {}
        try:
            found = await profiles(user_ids)
        except Exception:
            log.warning("creator profile lookup failed; listing automations without names", exc_info=True)
            return {}
        return {uid: str(getattr(profile, "name", "") or getattr(profile, "email", ""))
                for uid, profile in found.items()}

    async def describe(entry: dict, workspace_id: str, run: SummaryRow | None, now: datetime,
                       name: str | None) -> dict:
        """一条任务：宿主原样字段 + 创建者姓名 + origin + lastRun。origin 按创建者看那个会话，
        所以管理员看到的「页面上建的」与创建者自己看到的一致。"""
        user_id = owner_user(entry) or ""
        return {**entry, "creatorName": name,
                "origin": await origin_of(entry, workspace_id, user_id, lookup),
                "lastRun": last_run(entry, run, now)}

    @router.get("")
    async def list_all_automations(workspace_id: str, who: Who,
                                   creator: Annotated[str | None, Query(max_length=128)] = None,
                                   status: StatusFilter | None = None):
        """本空间全部定时任务（含已暂停的）。只读：管理员在这里看，不在这里建。

        creator 与 status 在这里就筛掉（票 #9 的 AC2）：任务上万条时把整表交给前端过滤，翻页与总数都会失真。
        """
        require_admin(who, workspace_id)
        try:
            found, truncated = await catalog()
        except HOST_ERRORS as error:
            raise upstream_error(error, "list workspace schedules") from error
        entries = [entry for entry in found
                   if owner_workspace(entry) == workspace_id
                   and (creator is None or owner_user(entry) == creator)
                   and (status is None or entry.get("status") == status)]
        now = datetime.now(UTC)
        latest = await latest_runs(runs, workspace_id, entries, now)
        names = await creator_names(entries)
        items = [await describe(entry, workspace_id, latest.get(str(entry.get("id"))), now,
                                names.get(owner_user(entry) or ""))
                 for entry in entries]
        return {"items": items, "total": len(items), "truncated": truncated}

    @router.post("/{schedule_id}/disable")
    async def disable_automation(schedule_id: ScheduleId, workspace_id: str, who: Who):
        """停用任意一条本空间的任务：到点不再触发。宿主核对属主是这个空间才动手，别的空间的任务回 404。"""
        require_admin(who, workspace_id)
        try:
            updated = await kernel.disable_schedule_for_admin(schedule_id, workspace_id=workspace_id)
        except HOST_ERRORS as error:
            raise write_error(error, "disable schedule") from error
        return {"id": updated.get("id"), "status": updated.get("status"),
                "scheduledAt": updated.get("scheduledAt"), "updatedAt": updated.get("updatedAt")}

    return router
