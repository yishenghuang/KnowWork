"""定时任务的保存护栏：最小间隔、本人条数上限、本空间条数上限。

间隔只做本地能判的那部分：只有 MINUTELY 的 INTERVAL 能算出小于 5 分钟；HOURLY 及更粗的
频率天然合规；解析不出来的规则放过，交给宿主去判。
"""

from __future__ import annotations

MIN_INTERVAL_SECONDS = 300
MAX_PER_USER = 20
MAX_PER_WORKSPACE = 100

# 频率 -> 一次间隔的秒数下限；None 表示这个频率天然不小于 5 分钟
_FREQUENCY_SECONDS = {"MINUTELY": 60, "HOURLY": 3600, "DAILY": 86400, "WEEKLY": 604800, "MONTHLY": 2592000}


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
