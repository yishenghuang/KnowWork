"""连续失败自动暂停：观察每轮汇总，连续三次失败就把宿主里的任务停掉，并留一条审计说明原因。

铁律（见 plan-2 §12）：调度真相只有宿主 dsh-schedule，业务服务不建任务表、不自算下次运行、不起扫描循环。
这里只借现有 RunSummary 读历史结果，借宿主 edit_schedule 改 active，借 AuditLog 记原因；没有新表、没有内存计数。

时序：observe 是 RunSummaries 的 Contributor，在 summaries._ended 里经 _facts 调用，此刻本轮的 RunSummary 行
还没 upsert 入库（更早在 _started 写的 RUNNING 行 facts={} 也不会被 fact 过滤命中），所以 page(limit=2) 恰好
读到的是此前最近两条「已结束」轮。判据 = 本轮 failed 且那两条都 failed —— 中间任意一次 completed / cancelled
会自然打断连续链（等于清零），不需要额外状态。「跳过」宿主里根本没有 RunSummary 行，对连续链透明。
"""

import logging
from datetime import UTC, datetime, timedelta

import httpx

from ..audit import AuditEvent, AuditSink, safe_record
from ..conversations.summaries import SummaryQuery, TurnEnded
from ..db.base import in_workspace
from ..kernel.contract import KernelError, SessionOwner
from ..kernel.host_client import HostKernel

log = logging.getLogger(__name__)

# 连续到第几次就停。判据是「本轮 + 历史两条」，所以窗里读 limit=2 条历史。
FAILURE_LIMIT = 3
# 与 api.RUN_WINDOW 一致：更早的汇总对「最近几次」没有意义。
HISTORY_WINDOW = timedelta(days=30)
# 审计 detail 的 reason 用这个标量键；sanitize_detail 会丢掉命中正文词 / 凭据词的键，这里都是安全键。
PAUSE_REASON = "连续 3 次运行失败，已自动暂停"
AUDIT_ACTION = "automation.auto_paused"


class ScheduleSupervisor:
    """连续失败时把定时任务转为暂停，并记一条审计事件说明为什么停。

    作为 RunSummaries 的 Contributor（Callable[[TurnEnded], Awaitable[...]]）注册，只做副作用、恒返回 None。
    宿主写失败只记日志、绝不向外抛：_facts 虽已吞掉 contributor 异常，这里仍显式保证不影响正常汇总。
    """

    def __init__(self, runs: SummaryQuery, kernel: HostKernel, sink: AuditSink | None) -> None:
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

        owner = SessionOwner(workspace_id=ended.workspace_id, user_id=ended.user_id)
        try:
            await self._kernel.edit_schedule(task_id, {"action": "update", "patch": {"active": False}},
                                             owner=owner)
        except (KernelError, httpx.HTTPError, OSError):
            log.warning("auto-pause schedule %s failed", task_id, exc_info=True)
            return

        # 只有 edit 成功才留痕：detail 全用标量键，避开 sanitize_detail 的正文词 / 凭据词过滤。
        event = AuditEvent(
            workspace_id=ended.workspace_id, actor_type="system", action=AUDIT_ACTION, result="success",
            actor_id=ended.user_id, resource_type="automation", resource_id=task_id,
            session_id=ended.conversation_id,
            detail={"reason": PAUSE_REASON, "failures": FAILURE_LIMIT, "scheduleId": task_id,
                    "conversationId": ended.conversation_id},
        )
        await safe_record(self._sink, event)
