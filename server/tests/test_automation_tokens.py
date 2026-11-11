"""自动化任务的属主令牌（automations/tokens.py）与宿主侧算法（dsh-host/src/multi-user/preset-token.mjs）互通。

令牌里编着「哪个空间哪个人」，随任务存在宿主那边；业务服务铸造，宿主用同一枚宿主令牌重算签名校验。
所以这里两个方向都要测：铸出来的宿主认得过、被人改过（换属主、换签名、换前缀）宿主认不过。
"""

import base64
import hmac
import json

from knowwork_server.automations.tokens import PREFIX, TokenOwner, mint, owner_of

HOST_TOKEN = "h" * 40
OWNER = TokenOwner(workspace_id="ws_a", user_id="u1")


def _parts(token):
    return token.split(".")


def test_a_minted_token_round_trips():
    token = mint(OWNER, HOST_TOKEN)
    assert token.startswith(f"{PREFIX}.")
    assert owner_of(token, HOST_TOKEN) == OWNER


def test_the_token_matches_the_host_algorithm():
    """宿主那边是 base64url(JSON {w,u}) + base64url(hmac_sha256(host_token, 前两段))，这里按同一算式复算。"""
    token = mint(OWNER, HOST_TOKEN)
    prefix, payload, signature = _parts(token)
    compact = json.dumps({"w": "ws_a", "u": "u1"}, separators=(",", ":")).encode()
    assert payload == base64.urlsafe_b64encode(compact).rstrip(b"=").decode()
    expected = hmac.new(HOST_TOKEN.encode(), f"{prefix}.{payload}".encode(), "sha256").digest()
    assert signature == base64.urlsafe_b64encode(expected).rstrip(b"=").decode()


def test_a_tampered_payload_is_refused():
    prefix, _payload, signature = _parts(mint(OWNER, HOST_TOKEN))
    forged = base64.urlsafe_b64encode(json.dumps({"w": "ws_b", "u": "u1"}, separators=(",", ":")).encode())
    forged = forged.rstrip(b"=").decode()
    assert owner_of(f"{prefix}.{forged}.{signature}", HOST_TOKEN) is None, "换成别人的空间，签名对不上"


def test_a_tampered_signature_is_refused():
    prefix, payload, _ = _parts(mint(OWNER, HOST_TOKEN))
    assert owner_of(f"{prefix}.{payload}.{base64.urlsafe_b64encode(b'x' * 32).rstrip(b'=').decode()}", HOST_TOKEN) is None


def test_another_host_token_does_not_verify():
    assert owner_of(mint(OWNER, HOST_TOKEN), "other" * 8) is None


def test_malformed_tokens_are_refused():
    token = mint(OWNER, HOST_TOKEN)
    for broken in ("", "kwauto1", f"{token}.x", token.replace(PREFIX, "kwauto2", 1), "kwauto1.!!!.!!!"):
        assert owner_of(broken, HOST_TOKEN) is None
    assert owner_of(token, "") is None


def test_owners_are_bounded():
    for owner in (TokenOwner(workspace_id="", user_id="u1"), TokenOwner(workspace_id="ws_a", user_id="u" * 200)):
        try:
            mint(owner, HOST_TOKEN)
        except ValueError:
            continue
        raise AssertionError("非法属主应被拒")
