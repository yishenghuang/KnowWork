"""定时任务的保存护栏，以及「连续失败自动暂停」写入与读取共用的那组数值。

这里的数值只写一次，别处一律引用：

- MIN_INTERVAL_SECONDS / MAX_PER_USER / MAX_PER_WORKSPACE 是保存前的三道护栏（plan-2 §4.6）：
  接口层的 422 文案按它们拼，前端的最小间隔从 model.MIN_INTERVAL_MINUTES 取同一口径；
- FAILURE_LIMIT / RUN_WINDOW / AUDIT_PAUSE_ACTION / AUDIT_PAUSE_REASON 同时被写侧（supervisor.py 判连续失败、
  写审计）与读侧（api.py 读「最近一次运行」与「已自动暂停」的原因）用到。写入与读取必须是同一份字面量，
  否则界面上永远显示不出暂停原因，而且两边各自改一个数值就会静默对不上。

间隔只做本地能判的那部分：SECONDLY / MINUTELY 的 INTERVAL 能算出小于 5 分钟；HOURLY 及更粗的
频率天然合规；解析不出来的规则放过，交给宿主去判。宿主自己还有 MIN_EVERY_INTERVAL_SECONDS=60
的下限，那是另一道闸，不替代这里。
"""

from __future__ import annotations

from datetime import timedelta

# 保存护栏：三条数值就是全部口径
MIN_INTERVAL_SECONDS = 300
MAX_PER_USER = 20
MAX_PER_WORKSPACE = 100

# 前端要跟这里保持一致的最小间隔（分钟）：表单里的 min 与提示文案都取它
MIN_INTERVAL_MINUTES = MIN_INTERVAL_SECONDS // 60

# 连续到第几次就停。判据是「本轮 + 历史两条」，所以窗里读 limit=2 条历史。
FAILURE_LIMIT = 3
# 「最近一次运行」与「连续失败」都只看近 30 天的汇总：更早的记录对这两件事都没有意义，也免得多读。
RUN_WINDOW = timedelta(days=30)
# 自动暂停的审计口径：supervisor 按这个 action 写，api 按这个 action 查、按 reason 显示。
AUDIT_PAUSE_ACTION = "automation.auto_paused"
AUDIT_PAUSE_REASON = f"连续 {FAILURE_LIMIT} 次运行失败，已自动暂停"

# 频率 -> 一次间隔的秒数下限。SECONDLY 是 1 秒：INTERVAL 再小也小不过它，照样可能低于 5 分钟。
_FREQUENCY_SECONDS = {"SECONDLY": 1, "MINUTELY": 60, "HOURLY": 3600, "DAILY": 86400, "WEEKLY": 604800,
                      "MONTHLY": 2592000}


def rule_parts(rrule: str) -> dict[str, str] | None:
    """从 rrule 文本里取出 RRULE 那一行的键值；取不到（像自定义的怪写法）返回 None。"""
    line = next((row.strip() for row in rrule.splitlines() if row.strip().upper().startswith("RRULE:")), None)
    if line is None:
        return None
    parts: dict[str, str] = {}
    for chunk in line[len("RRULE:") :].split(";"):
        key, sep, value = chunk.partition("=")
        if sep:
            parts[key.strip().upper()] = value.strip()
    return parts or None


def interval_too_short(rrule: str) -> bool:
    """这条规则的间隔是否小于 5 分钟。解析不出的规则按合规处理。"""
    parts = rule_parts(rrule)
    if parts is None:
        return False
    unit = _FREQUENCY_SECONDS.get(parts.get("FREQ", ""))
    if unit is None:
        return False
    raw = parts.get("INTERVAL", "1")
    try:
        every = int(raw)
    except ValueError:
        return False
    if every < 1:
        return False
    return unit * every < MIN_INTERVAL_SECONDS
