"""Signed enterprise channel actor metadata for company-gateway audit.

The actor is deliberately not an authorization principal.  GatewayRunner binds
this context from a normalized platform callback, and request hooks attach a
short-lived HMAC envelope using the WeCom Bot secret that is unavailable to the
renderer.  The server may record a verified actor next to the Desktop binding
owner, but model/tool grants remain derived from the Gateway token owner.
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import hmac
import os
import re
import secrets
import time
from typing import Any, Iterator


CONTRACT_VERSION = "hermes-channel-actor-v1"
IDENTITY_CONTRACT_VERSION = "hermes-channel-identity-v2"
HEADER_CONTRACT_VERSION = "X-Hermes-Channel-Contract-Version"
HEADER_SOURCE = "X-Hermes-Channel-Source"
HEADER_BOT_ID = "X-Hermes-Channel-Bot-Id"
HEADER_ACTOR = "X-Hermes-Channel-Actor"
HEADER_TIMESTAMP = "X-Hermes-Channel-Timestamp"
HEADER_NONCE = "X-Hermes-Channel-Nonce"
HEADER_SIGNATURE = "X-Hermes-Channel-Signature"
HEADER_BODY_SHA256 = "X-Hermes-Channel-Body-SHA256"
RESERVED_HEADERS = (
    HEADER_CONTRACT_VERSION,
    HEADER_SOURCE,
    HEADER_BOT_ID,
    HEADER_ACTOR,
    HEADER_TIMESTAMP,
    HEADER_NONCE,
    HEADER_SIGNATURE,
    HEADER_BODY_SHA256,
)

_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$")
_CONTEXT_ATTRIBUTE = "_enterprise_channel_actor_audit_context"
_HOOK_MARKER = "_hermes_enterprise_channel_actor_hook"


def canonical_payload(source: str, bot_id: str, actor_id: str, timestamp: str, nonce: str) -> str:
    return "\n".join((CONTRACT_VERSION, source, bot_id, actor_id, timestamp, nonce))


def build_signed_headers(
    *,
    source: str,
    bot_id: str,
    actor_id: str,
    secret: str,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    if source != "wecom":
        raise ValueError("unsupported enterprise channel source")
    if not _SAFE_IDENTIFIER.fullmatch(bot_id or ""):
        raise ValueError("invalid bot id")
    if not _SAFE_IDENTIFIER.fullmatch(actor_id or ""):
        raise ValueError("invalid channel actor id")
    if not secret:
        raise ValueError("missing channel signing secret")
    timestamp_text = str(int(time.time()) if timestamp is None else int(timestamp))
    nonce_text = nonce or _base64url(secrets.token_bytes(16))
    payload = canonical_payload(source, bot_id, actor_id, timestamp_text, nonce_text)
    signature = _base64url(hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest())
    return {
        HEADER_SOURCE: source,
        HEADER_BOT_ID: bot_id,
        HEADER_ACTOR: actor_id,
        HEADER_TIMESTAMP: timestamp_text,
        HEADER_NONCE: nonce_text,
        HEADER_SIGNATURE: signature,
    }


def build_identity_signed_headers(
    *,
    source: str,
    bot_id: str,
    actor_id: str,
    secret: str,
    method: str,
    path: str,
    body: bytes,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """Build the v2 proof used by identity resolve/redeem endpoints.

    The method, absolute path and exact request bytes are covered so a proof
    cannot be replayed against a different state-changing operation.
    """
    if source != "wecom":
        raise ValueError("unsupported enterprise channel source")
    if not _SAFE_IDENTIFIER.fullmatch(bot_id or ""):
        raise ValueError("invalid bot id")
    if not _SAFE_IDENTIFIER.fullmatch(actor_id or ""):
        raise ValueError("invalid channel actor id")
    if not secret:
        raise ValueError("missing channel signing secret")
    normalized_method = str(method or "").strip().upper()
    normalized_path = str(path or "").strip()
    if not normalized_method or not normalized_path.startswith("/") or "?" in normalized_path:
        raise ValueError("invalid identity proof target")
    body_sha256 = hashlib.sha256(body).hexdigest()
    timestamp_text = str(int(time.time()) if timestamp is None else int(timestamp))
    nonce_text = nonce or _base64url(secrets.token_bytes(16))
    payload = "\n".join(
        (
            IDENTITY_CONTRACT_VERSION,
            source,
            bot_id,
            actor_id,
            timestamp_text,
            nonce_text,
            normalized_method,
            normalized_path,
            body_sha256,
        )
    )
    signature = _base64url(
        hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest()
    )
    return {
        HEADER_CONTRACT_VERSION: IDENTITY_CONTRACT_VERSION,
        HEADER_SOURCE: source,
        HEADER_BOT_ID: bot_id,
        HEADER_ACTOR: actor_id,
        HEADER_TIMESTAMP: timestamp_text,
        HEADER_NONCE: nonce_text,
        HEADER_BODY_SHA256: body_sha256,
        HEADER_SIGNATURE: signature,
    }


@contextmanager
def channel_actor_audit_scope(agent: Any, source: Any) -> Iterator[None]:
    """Bind one normalized WeCom sender to model requests made in this turn."""
    previous = getattr(agent, _CONTEXT_ATTRIBUTE, None)
    context = _context_from_source(source)
    setattr(agent, _CONTEXT_ATTRIBUTE, context)
    _install_request_hooks(agent)
    try:
        yield
    finally:
        setattr(agent, _CONTEXT_ATTRIBUTE, previous)


def apply_channel_actor_headers(agent: Any, request: Any) -> None:
    """Request-hook body; strips caller headers before adding trusted metadata."""
    headers = request.headers
    for name in RESERVED_HEADERS:
        try:
            headers.pop(name, None)
        except AttributeError:
            if name in headers:
                del headers[name]

    if str(getattr(agent, "provider", "") or "").strip().lower() != "company-gateway":
        return
    context = getattr(agent, _CONTEXT_ATTRIBUTE, None)
    if not isinstance(context, dict):
        return
    signed = build_signed_headers(**context)
    for name, value in signed.items():
        headers[name] = value


def _context_from_source(source: Any) -> dict[str, str] | None:
    platform = getattr(source, "platform", None)
    platform_name = str(getattr(platform, "value", platform) or "").strip().lower()
    if platform_name != "wecom":
        return None
    actor_id = str(getattr(source, "user_id", "") or "").strip()
    managed = getattr(source, "_enterprise_channel_signing_context", None)
    if isinstance(managed, dict):
        bot_id = str(managed.get("bot_id") or "").strip()
        secret = str(managed.get("secret") or "").strip()
    else:
        bot_id = os.getenv("WECOM_BOT_ID", "").strip()
        secret = os.getenv("WECOM_SECRET", "").strip()
    if not _SAFE_IDENTIFIER.fullmatch(actor_id) or not _SAFE_IDENTIFIER.fullmatch(bot_id) or not secret:
        return None
    return {"source": "wecom", "bot_id": bot_id, "actor_id": actor_id, "secret": secret}


def _install_request_hooks(agent: Any) -> None:
    for sdk_client in (getattr(agent, "client", None), getattr(agent, "_anthropic_client", None)):
        http_client = getattr(sdk_client, "_client", None)
        hooks = getattr(http_client, "event_hooks", None)
        if not isinstance(hooks, dict) or getattr(http_client, _HOOK_MARKER, False):
            continue
        hooks.setdefault("request", []).append(lambda request, bound_agent=agent: apply_channel_actor_headers(bound_agent, request))
        setattr(http_client, _HOOK_MARKER, True)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")
