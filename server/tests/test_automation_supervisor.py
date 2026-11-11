"""连续失败自动暂停：ScheduleSupervisor 的编排逻辑单测。

用轻量 Fake 顶掉真库 / 宿主 HTTP / 审计落库，不碰共享夹具，也不起 RLS 会话。
重点验证：只有「本轮 failed + 历史两条都 failed」才暂停；中间成功 / 取消清零；
user_id 为空、状态非 failed、跳过（无汇总行）直接放过；宿主写失败只吞掉、不写审计。
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest

from knowwork_server.automations.supervisor import ScheduleSupervisor
from knowwork_server.conversations.summaries import TurnEnded
from knowwork_server.db.base import current_workspace
from knowwork_server.kernel.contract import KernelError

pytestmark = pytest.mark.anyio

WORKSPACE = "default"
USER = "dev-user"
TASK_ID = "schedule-1"
PAUSE_REASON = "连续 3 次运行失败，已自动暂停"


def row(status: str):
    """读侧只用 row.summary.status，其余字段都不需要。"""
    return SimpleNamespace(summary=SimpleNamespace(status=status))


def ended(**over) -> TurnEnded:
    base = {"workspace_id": WORKSPACE, "conversation_id": "conv-1", "turn": 1,
            "question": "q", "answer": "a", "status": "failed", "user_id": USER,
            "schedule": ({"id": TASK_ID},)}
    return TurnEnded(**{**base, **over})


class FakeRuns:
    def __init__(self, rows=()):
        self.rows = tuple(rows)
        self.calls: list[tuple] = []

    async def page(self, workspace_id, **kwargs):
        self.calls.append((workspace_id, kwargs))
        # 证明 supervisor 用 in_workspace 包住了查询：后台任务里不设空间 RLS 会静默读空。
        assert current_workspace.get() == workspace_id
        return self.rows


class FakeKernel:
    def __init__(self, error=None):
        self.error = error
        self.calls: list[tuple] = []

    async def edit_schedule(self, schedule_id, body, *, owner):
        self.calls.append((schedule_id, body, owner))
        if self.error is not None:
            raise self.error
        return {}


class FakeSink:
    def __init__(self):
        self.events: list = []

    async def record(self, event):
        self.events.append(event)


def make(runs_rows=(), kernel_error=None):
    runs = FakeRuns(runs_rows)
    kernel = FakeKernel(kernel_error)
    sink = FakeSink()
    return ScheduleSupervisor(runs, kernel, sink), runs, kernel, sink


async def test_two_history_failures_plus_current_pauses_and_audits():
    sup, runs, kernel, sink = make([row("failed"), row("failed")])

    assert await sup.observe(ended()) is None

    # 宿主侧：把任务改成 inactive，带上正确的 SessionOwner。
    assert len(kernel.calls) == 1
    schedule_id, body, owner = kernel.calls[0]
    assert schedule_id == TASK_ID
    assert body == {"action": "update", "patch": {"active": False}}
    assert owner.workspace_id == WORKSPACE
    assert owner.user_id == USER

    # 审计侧：一条 success 事件，detail 全用标量键（避开 sanitize_detail 的正文 / 凭据词过滤）。
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.workspace_id == WORKSPACE
    assert event.actor_type == "system"
    assert event.action == "automation.auto_paused"
    assert event.result == "success"
    assert event.actor_id == USER
    assert event.resource_type == "automation"
    assert event.resource_id == TASK_ID
    assert event.session_id == "conv-1"
    assert event.detail == {"reason": PAUSE_REASON, "failures": 3,
                            "scheduleId": TASK_ID, "conversationId": "conv-1"}

    # 读侧：按 fact 过滤近 30 天、只取最近 2 条历史；in_workspace 用完要复位，不污染外层上下文。
    assert len(runs.calls) == 1
    workspace_id, kwargs = runs.calls[0]
    assert workspace_id == WORKSPACE
    assert kwargs["fact"] == ("schedule", "id", TASK_ID)
    assert kwargs["limit"] == 2
    assert isinstance(kwargs["since"], datetime) and isinstance(kwargs["until"], datetime)
    assert kwargs["until"] - kwargs["since"] == timedelta(days=30)
    assert kwargs["until"].tzinfo is UTC
    assert current_workspace.get() is None


@pytest.mark.parametrize("statuses", [("completed", "failed"), ("failed", "completed"),
                                      ("cancelled", "failed"), ("failed", "cancelled")])
async def test_middle_success_or_cancel_breaks_the_chain(statuses):
    """中间成功一次清零；用户手动取消也不计入连续失败。"""
    sup, _runs, kernel, sink = make([row(s) for s in statuses])
    assert await sup.observe(ended()) is None
    assert kernel.calls == []
    assert sink.events == []


@pytest.mark.parametrize("status", ["cancelled", "completed", "skipped"])
async def test_current_not_failed_never_pauses(status):
    sup, runs, kernel, sink = make([row("failed"), row("failed")])
    assert await sup.observe(ended(status=status)) is None
    assert runs.calls == []  # 当前轮不是失败就直接放过，连历史都不读
    assert kernel.calls == []
    assert sink.events == []


async def test_single_history_failure_is_not_enough():
    sup, _runs, kernel, sink = make([row("failed")])
    assert await sup.observe(ended()) is None
    assert kernel.calls == []
    assert sink.events == []


async def test_no_user_id_returns_without_touching_the_kernel():
    """_facts 在 user_id 判空之前调用，contributor 可能拿到 None；SessionOwner 也要求非空。"""
    sup, runs, kernel, sink = make([row("failed"), row("failed")])
    assert await sup.observe(ended(user_id=None)) is None
    assert runs.calls == []
    assert kernel.calls == []
    assert sink.events == []


@pytest.mark.parametrize("error", [KernelError("host_down", "host unavailable", 502),
                                   httpx.ConnectError("no route to host")])
async def test_host_failure_is_swallowed_and_never_audits(error):
    """只有 edit 成功才留痕；宿主不可达只记日志、绝不向 _facts 抛。"""
    sup, _runs, kernel, sink = make([row("failed"), row("failed")], kernel_error=error)
    assert await sup.observe(ended()) is None
    assert len(kernel.calls) == 1
    assert sink.events == []


async def test_empty_schedule_returns_immediately():
    sup, runs, kernel, sink = make([row("failed"), row("failed")])
    assert await sup.observe(ended(schedule=())) is None
    assert runs.calls == []
    assert kernel.calls == []
    assert sink.events == []


async def test_batch_schedule_checks_every_id():
    """批量投递可能在一次 TurnEnded 里带多个任务 id，逐个判、逐个停、逐个记。"""
    sup, runs, kernel, sink = make([row("failed"), row("failed")])
    batch = ({"id": "schedule-1"}, {"id": "schedule-2"})
    assert await sup.observe(ended(schedule=batch)) is None
    assert [c[0] for c in kernel.calls] == ["schedule-1", "schedule-2"]
    assert [e.resource_id for e in sink.events] == ["schedule-1", "schedule-2"]
    assert [c[1]["fact"][2] for c in runs.calls] == ["schedule-1", "schedule-2"]
