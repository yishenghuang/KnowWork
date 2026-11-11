"""连续失败自动暂停：观察每轮汇总，连续三次失败就把宿主里的任务停掉，并留一条审计说明原因。

铁律（见 plan-2 §12）：调度真相只有宿主 dsh-schedule，业务服务不建任务表、不自算下次运行、不起扫描循环。
这里只借现有 RunSummary 读历史结果，借宿主 edit_schedule 改 active，借 AuditLog 记原因；没有新表、没有内存计数。

时序：observe 是 RunSummaries 的 Contributor，在 summaries._ended 里经 _facts 调用，此刻本轮的 RunSummary 行
还没 upsert 入库（更早在 _started 写的 RUNNING 行 facts={} 也不会被 fact 过滤命中），所以 page(limit=2) 恰好
读到的是此前最近两条「已结束」轮。判据 = 本轮 failed 且那两条都 failed —— 中间任意一次 completed / cancelled
会自然打断连续链（等于清零），不需要额外状态。「跳过」宿主里根本没有 RunSummary 行，对连续链透明。
"""

import logging
from datetime import UTC, datetime

import httpx

from ..audit import AuditEvent, AuditSink, safe_record
from ..conversations.summaries import SummaryQuery, TurnEnded
from ..db.base import in_workspace
from ..kernel.contract import KernelError, ScheduleKernel, SessionOwner
from . import limits

log = logging.getLogger(__name__)

# 阈值、窗口与审计用词都在 limits 里（api 读同几个值给前端，别处再写一遍就会两边漂移）
FAILURE_LIMIT = limits.FAILURE_LIMIT
HISTORY_WINDOW = limits.RUN_WINDOW
# 审计 detail 的 reason 用这个标量键；sanitize_detail 会丢掉命中正文词 / 凭据词的键，这里都是安全键。
PAUSE_REASON = limits.AUDIT_PAUSE_REASON
AUDIT_ACTION = limits.AUDIT_PAUSE_ACTION


def _error_code(error: BaseException) -> str:
    """宿主错误码（KernelError.code）；HTTP / 系统错误的类名顶上也够看。"""
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and code else type(error).__name__


def _event(ended: TurnEnded, task_id: str, result: str, detail: dict) -> AuditEvent:
    return AuditEvent(
        workspace_id=ended.workspace_id, actor_type="system", action=AUDIT_ACTION, result=result,
        actor_id=ended.user_id, resource_type="automation", resource_id=task_id,
        session_id=ended.conversation_id, detail=detail,
    )


class ScheduleSupervisor:
    """连续失败时把定时任务转为暂停，并记一条审计事件说明为什么停。

    作为 RunSummaries 的 Contributor（Callable[[TurnEnded], Awaitable[...]]）注册，只做副作用、恒返回 None。
    宿主写失败绝不向外抛（_facts 虽已吞掉 contributor 异常，这里仍显式保证不影响正常汇总），但要留一条
    result="failed" 的审计：自动暂停没停成，用户与管理员都得看得见。
    """

    def __init__(self, runs: SummaryQuery, kernel: ScheduleKernel, sink: AuditSink | None) -> None:
        self._runs = runs
        self._kernel = kernel
        self._sink = sink

    async def observe(self, ended: TurnEnded) -> None:
        if ended.user_id is None:
            # _facts 在 user_id 判空之前调用，contributor 可能拿到 None；SessionOwner 也要求非空。
            return
        if ended.status != "failed":
            # cancelled / completed / skipped 都不参与连续失败计数。
            return

        now = datetime.now(UTC)
        since = now - HISTORY_WINDOW
        for item in ended.schedule:
            task_id = item.get("id")
            if not isinstance(task_id, str) or not task_id:
                continue
            await self._check(task_id, ended, since, now)
        return

    async def _check(self, task_id: str, ended: TurnEnded, since: datetime, until: datetime) -> None:
        # SummaryQuery 用 make_workspace_sessionmaker，after_begin 依赖 current_workspace ContextVar；
        # observe 在 asyncio.create_task 后台任务里跑，没有请求上下文，不设空间 RLS 会静默读空。
        with in_workspace(ended.workspace_id):
            rows = await self._runs.page(ended.workspace_id, since=since, until=until,
                                         fact=("schedule", "id", task_id), limit=FAILURE_LIMIT - 1)
        if len(rows) < FAILURE_LIMIT - 1 or not all(row.summary.status == "failed" for row in rows):
            return

        # detail 全用标量键，避开 sanitize_detail 的正文词 / 凭据词过滤；成功与失败用同一组键，按 result 分辨。
        detail: dict = {"reason": PAUSE_REASON, "failures": FAILURE_LIMIT, "scheduleId": task_id,
                        "conversationId": ended.conversation_id}
        owner = SessionOwner(workspace_id=ended.workspace_id, user_id=ended.user_id)
        try:
            await self._kernel.edit_schedule(task_id, {"action": "update", "patch": {"active": False}},
                                             owner=owner)
        except (KernelError, httpx.HTTPError, OSError) as error:
            # 停下来这件事没做成，恰恰是最该留下痕迹的时候：调用者的权限可能已经被收走，任务还在按点跑。
            # 记 result="failed" 并把宿主的错误码带进 detail，管理员在审计里能看见「该停没停成」。
            log.warning("auto-pause schedule %s failed", task_id, exc_info=True)
            await safe_record(self._sink, _event(ended, task_id, "failed",
                                                 {**detail, "error": _error_code(error)}))
            return

        await safe_record(self._sink, _event(ended, task_id, "success", detail))
