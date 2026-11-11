"""自动化页「一句话生成草稿」：把用户那句大白话翻成表单填得进去的一份草稿。

本模块只做一件事：**调一次模型，把它的回答收成草稿**。不建任务、不碰宿主、不写库——用户改完点「保存」才真的
建任务（见 plan-2 §14，票 #10 的 AC3 靠这里的结构保证，不靠前端按钮顺序）。

时间规则仍然只有前端 model.ts 一处会拼 RRULE 文本：这里只把模型的话翻成预设对象的字段（与 model.ts 的 Preset
联合类型一一对应），模型给的 RRULE 行则原样透出——前端 parseRule 认不出就落成「自定义」，正好是 AC4。

模型的话未必规整，所以解析照知识库判卷的宽容写法（knowledge/answer_check.py 的 parse_verdicts）：从回答里取出
第一个 JSON 对象，逐字段白名单校验，认不出的一律丢掉，绝不把没校验过的对象原样透给前端。
"""

import json
import logging
import re
from datetime import UTC, datetime
from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..conversations.api import Actor, ActorDependency
from ..models.catalog import DEFAULT_ALIAS
from ..models.client import ModelCallError, ModelClient

log = logging.getLogger(__name__)

# 对外文案固定：模型调用失败只回这一句，原始错误写服务端日志
UNAVAILABLE = {"code": "draft_unavailable", "message": "模型暂时用不了，先自己填一下表单"}
# 模型没说出个所以然：不报错，交回一份空草稿，让用户自己填
NOT_UNDERSTOOD = "没听懂这句话，把它写得更具体些，或者直接填表单"

# 前端字段本来就有长度上限（标题 120、提示词 4000），这里先截断，免得整份草稿因为一个长字段被丢掉
TITLE_MAX = 120
PROMPT_MAX = 4000
NOTE_MAX = 200

# 八种预设里的前七种；custom 不是预设（认不出的规则走 rrule 原文）
KINDS = frozenset({"once", "minutes", "hours", "daily", "workdays", "weekly", "monthly"})
WEEKDAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
TARGETS = frozenset({"fixed", "new_once"})

CLOCK = re.compile(r"^(\d{1,2}):(\d{2})$")
MOMENT = "%Y-%m-%dT%H:%M"


class DraftBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=1000)
    # 空串（前端没取到本机时区时）按 UTC 算；时区名只写进提示词，服务端不做任何换算
    timeZone: str = Field(default="", max_length=64)


def build_router(chat: ModelClient | None, current_actor: ActorDependency) -> APIRouter:
    """草稿路由。chat 为空（装配没给模型客户端）时一律 503：这条路只有模型能给答案。"""
    router = APIRouter(prefix="/api/workspaces/{workspace_id}/automations", tags=["automations"])
    Who = Annotated[Actor, Depends(current_actor)]

    @router.post("/draft")
    async def draft_automation(body: DraftBody, who: Who):
        """一句话 → 表单草稿（标题、提示词、时间规则、执行位置）。**不建任务。**"""
        if chat is None:
            raise HTTPException(status_code=503, detail=UNAVAILABLE)
        zone = body.timeZone.strip() or "Etc/UTC"
        try:
            reply = await chat.chat(who.workspace_id, DEFAULT_ALIAS, messages(body.text.strip(), zone),
                                    max_tokens=600, temperature=0.0, background=False)
        except ModelCallError as error:
            log.warning("draft model call failed: %s", error.code)
            raise HTTPException(status_code=503, detail=UNAVAILABLE) from error
        return parse_draft(reply)

    return router


def messages(text: str, zone: str) -> list[dict[str, str]]:
    """一次调用的两条消息：system 交代字段与例子（含今天日期、时区），user 就是用户那句话。"""
    return [{"role": "system", "content": _system(zone)}, {"role": "user", "content": text}]


def _today(zone: str) -> str:
    """给定时区里的今天（一次性任务、明天下午这类说法要换算日期）。认不出的时区名按 UTC 算。"""
    try:
        return datetime.now(ZoneInfo(zone)).strftime("%Y-%m-%d")
    except (ZoneInfoNotFoundError, ValueError):
        return datetime.now(UTC).strftime("%Y-%m-%d")


def _system(zone: str) -> str:
    return (_SYSTEM.replace("__TODAY__", _today(zone)).replace("__ZONE__", zone))


# 占位符单独替换，模板里的 JSON 大括号原样留着（不写 f-string，免得每个大括号都要双写）
_SYSTEM = """你是把用户的一句话排成定时任务的助手。今天是 __TODAY__，用户所在时区是 __ZONE__。

把用户那句话翻成**一个 JSON 对象**。只输出这个 JSON：不要解释、不要 Markdown 代码围栏、不要前后多余的字。

字段（拿不准的就整条不给，不要编）：
- title：任务标题，20 字以内，像「交日报」这样。
- prompt：到点时要发给 AI 的那句话，以「提醒我」开头，写完事要做的事。
- 时间规则，二选一：
  - preset：能落进下面七种预设时给这个对象；
  - rrule：预设表达不了时给 RRULE 行原文（以 FREQ= 开头）；
  - 都拿不准就两个都不给。
- target：「fixed」表示固定在已有的一段对话里跑，「new_once」表示每次新建一段对话跑；用户没说就选 new_once。
- note：给用户看的一句中文补充（例如「时间只填了个大概，你看一下」）；没有就不给。

preset 的七种写法（kind 必有，其余字段缺一不可）：
- {"kind":"once","at":"YYYY-MM-DDTHH:mm"}                 只跑一次，本地时间
- {"kind":"minutes","every":N}                            每 N 分钟
- {"kind":"hours","every":N}                              每 N 小时
- {"kind":"daily","every":N,"times":["HH:mm","HH:mm"]}    每 N 天的这些时刻
- {"kind":"workdays","every":N,"time":"HH:mm"}            每 N 周的工作日
- {"kind":"weekly","every":N,"days":["MO","WE"],"time":"HH:mm"}  每 N 周的这几天，days 取值 MO TU WE TH FR SA SU
- {"kind":"monthly","every":N,"day":15,"time":"HH:mm"}    每 N 月的某日，day 是 1..31，-1 表示当月最后一天

例子 1：每天早上九点提醒我把日报交了
{"title":"交日报","prompt":"提醒我把今天的日报交了","preset":{"kind":"daily","every":1,"times":["09:00"]},"target":"new_once"}

例子 2：每周一三五下午三点站会
{"title":"站会提醒","prompt":"提醒我去开站会","preset":{"kind":"weekly","every":1,"days":["MO","WE","FR"],"time":"15:00"},"target":"new_once"}
"""


def parse_draft(reply: str) -> dict[str, Any]:
    """模型的回答 → 草稿。一个字段都认不出时给一份空草稿加一句「没听懂」，不报错。"""
    body = _object(reply)
    draft: dict[str, Any] = _empty(None if body is not None else NOT_UNDERSTOOD)
    if body is None:
        return draft
    draft["title"] = _text(body.get("title"), TITLE_MAX)
    draft["prompt"] = _text(body.get("prompt"), PROMPT_MAX)
    draft["timing"] = _timing(body)
    target = body.get("target")
    draft["target"] = target if isinstance(target, str) and target in TARGETS else None
    draft["note"] = _text(body.get("note"), NOTE_MAX)
    if all(draft[key] is None for key in ("title", "prompt", "timing", "target")):
        # JSON 是规整的、但没有一个字段认得出：和解析失败一样，当作没听懂
        draft["note"] = draft["note"] or NOT_UNDERSTOOD
    return draft


def _empty(note: str | None) -> dict[str, Any]:
    return {"title": None, "prompt": None, "timing": None, "target": None, "note": note}


def _object(reply: str) -> dict[str, Any] | None:
    """回答里第一个 JSON 对象；没有或不是对象时为 None（照 answer_check.parse_verdicts 的写法）。"""
    match = re.search(r"\{.*\}", reply, re.DOTALL)
    try:
        body = json.loads(match.group(0)) if match else None
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _text(value: Any, limit: int) -> str | None:
    """非空字符串，压掉多余空白后截断；别的类型一律不要。"""
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text[:limit] or None


def _timing(body: dict[str, Any]) -> dict[str, Any] | None:
    """时间规则：预设优先，其次 RRULE 原文（AC4 的出口），都没有就 None。"""
    preset = _preset(body.get("preset"))
    if preset is not None:
        return {"preset": preset}
    rrule = _rrule(body.get("rrule"))
    return {"rrule": rrule} if rrule is not None else None


def _rrule(value: Any) -> str | None:
    """RRULE 行原文：以 FREQ= 开头（写错成 RRULE:FREQ=... 的也收，去掉前缀）。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.startswith("RRULE:"):
        text = text[len("RRULE:"):].strip()
    return text if text.startswith("FREQ=") else None


def _preset(value: Any) -> dict[str, Any] | None:
    """逐字段白名单校验一个预设；任何一项对不上就整条丢掉（校验不过的半成品绝不透给前端）。"""
    if not isinstance(value, dict):
        return None
    kind = value.get("kind")
    if not isinstance(kind, str) or kind not in KINDS:
        return None
    if kind == "once":
        at = _moment(value.get("at"))
        return {"kind": "once", "at": at} if at is not None else None
    every = _count(value.get("every"))
    if every is None:
        return None
    if kind in ("minutes", "hours"):
        return {"kind": kind, "every": every}
    if kind == "daily":
        times = _times(value.get("times"))
        return {"kind": "daily", "every": every, "times": times} if times is not None else None
    time = _clock(value.get("time"))
    if time is None:
        return None
    if kind == "workdays":
        return {"kind": "workdays", "every": every, "time": time}
    if kind == "weekly":
        days = _days(value.get("days"))
        return {"kind": "weekly", "every": every, "days": days, "time": time} if days is not None else None
    # 剩下就是 monthly
    day = _count(value.get("day"), minimum=-1)
    if day is None or day == 0 or day > 31:  # -1 或 1..31，别的都不算
        return None
    return {"kind": "monthly", "every": every, "day": day, "time": time}


def _count(value: Any, minimum: int = 1) -> int | None:
    """整数且不小于 minimum（模型偶尔给 '1' 或 1.0，收下来；bool 不算）。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, float) and value.is_integer():
        number = int(value)
    elif isinstance(value, str) and value.strip().lstrip("-").isdigit():
        number = int(value.strip())
    else:
        return None
    return number if number >= minimum else None


def _clock(value: Any) -> str | None:
    """'HH:mm'（写成 '9:05' 的也收，补齐成两位）。"""
    if not isinstance(value, str):
        return None
    match = CLOCK.match(value.strip())
    if match is None:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


def _moment(value: Any) -> str | None:
    """一次性的时刻：本地时间 'YYYY-MM-DDTHH:mm'，日期也要真的存在。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    try:
        datetime.strptime(text, MOMENT)
    except ValueError:
        return None
    return text


def _times(value: Any) -> list[str] | None:
    """若干个 'HH:mm'；不是非空列表、或有一项不对，整条丢掉。"""
    if not isinstance(value, list) or not value:
        return None
    times = [_clock(item) for item in value]
    if any(item is None for item in times):
        return None
    return [item for item in times if item is not None]


def _days(value: Any) -> list[str] | None:
    """若干个星期（MO..SU）；不是非空列表、或有一项不认识，整条丢掉。"""
    if not isinstance(value, list) or not value:
        return None
    days: list[str] = []
    for item in value:
        day = item.strip().upper() if isinstance(item, str) else ""
        if day not in WEEKDAYS:
            return None
        if day not in days:
            days.append(day)
    return days
