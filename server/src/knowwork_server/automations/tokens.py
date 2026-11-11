"""自动化任务的属主令牌。

属主是「哪个空间哪个人」。官方给会话创建留的口子只有 agentPreset 一个字段（createSpecSchema 只收 cwd 与
agentPreset），没有放属主的地方，所以属主编进这串令牌，随任务一起存在宿主那边：

    kwauto1.<base64url(JSON {"w": workspaceId, "u": userId})>.<base64url(hmac_sha256(host_token, 前两段))>

宿主上的会话创建插件（runtime-host/plugins/dsh-host/src/session-controller.mjs）用同一个算法、同一枚宿主令牌
重算签名，对不上就拒绝建会话。所以这里只做铸造与校验这两件纯函数的事，不碰数据库、不发请求。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass

PREFIX = "kwauto1"
# 令牌里工作空间与人的取值上限：与宿主身份头的 1..128 对齐
MAX_OWNER_FIELD = 128


@dataclass(frozen=True)
class TokenOwner:
    """令牌里的属主。"""

    workspace_id: str
    user_id: str


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64url(text: str) -> bytes | None:
    # 补齐 base64 的 = 再解；不是合法 base64url 就返回 None
    padding = "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(text + padding)
    except (ValueError, TypeError):
        return None


def _signature(host_token: str, signed: str) -> bytes:
    return hmac.new(host_token.encode("utf-8"), signed.encode("utf-8"), hashlib.sha256).digest()


def mint(owner: TokenOwner, host_token: str) -> str:
    """给一个人在一个空间里建的任务铸一枚属主令牌。令牌随任务持久化，宿主重启后照样能验。"""
    if not 1 <= len(owner.workspace_id) <= MAX_OWNER_FIELD or not 1 <= len(owner.user_id) <= MAX_OWNER_FIELD:
        raise ValueError("属主的工作空间与用户必须是 1 到 128 个字符")
    if not host_token:
        raise ValueError("宿主令牌没有配置，不能铸属主令牌")
    payload = _b64url(json.dumps({"w": owner.workspace_id, "u": owner.user_id},
                                 ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    signed = f"{PREFIX}.{payload}"
    return f"{signed}.{_b64url(_signature(host_token, signed))}"


def owner_of(token: str, host_token: str) -> TokenOwner | None:
    """验一枚令牌：签名对、载荷是合法 JSON、属主字段齐全才返回属主，否则 None。"""
    if not token or not host_token:
        return None
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != PREFIX:
        return None
    given = _unb64url(parts[2])
    if given is None:
        return None
    expected = _signature(host_token, f"{parts[0]}.{parts[1]}")
    # 长度不同时 compare_digest 直接返回 False（不会抛）
    if not hmac.compare_digest(given, expected):
        return None
    raw = _unb64url(parts[1])
    if raw is None:
        return None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    workspace_id, user_id = payload.get("w"), payload.get("u")
    if not isinstance(workspace_id, str) or not isinstance(user_id, str):
        return None
    if not 1 <= len(workspace_id) <= MAX_OWNER_FIELD or not 1 <= len(user_id) <= MAX_OWNER_FIELD:
        return None
    return TokenOwner(workspace_id=workspace_id, user_id=user_id)
