"""In-memory identity client for the Desktop-hosted enterprise WeCom adapter.

Nothing in this module is persisted.  Bot credentials and the Gateway service
token live only as long as the attached adapter and are explicitly closed on
detach.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import time
from typing import Any, Optional
from urllib.parse import urlsplit

from agent.enterprise_channel_audit import build_identity_signed_headers


IDENTITY_CONTRACT_VERSION = "wecom-channel-identity.v1"
IDENTITY_PROOF_VERSION = "hermes-channel-identity-v2"
RESOLVE_PATH = "/v1/wecom-personal-bot/runtime/channel-identities/resolve"
REDEEM_PATH = "/v1/wecom-personal-bot/runtime/channel-identities/redeem"


@dataclass(frozen=True)
class IdentityResolution:
    mapping_status: str = "unknown"
    match_scope: str = "none"
    desktop_user_id: Optional[str] = None
    user_name: Optional[str] = None
    display_name: Optional[str] = None

    @classmethod
    def from_payload(cls, payload: Any) -> "IdentityResolution":
        if not isinstance(payload, dict):
            return cls()
        mapping_status = str(payload.get("mappingStatus") or "unknown")
        match_scope = str(payload.get("matchScope") or "none")
        if mapping_status not in {"mapped", "unknown", "ambiguous"}:
            mapping_status = "unknown"
        if match_scope not in {"exact", "corp-consensus", "none", "ambiguous"}:
            match_scope = "none"
        return cls(
            mapping_status=mapping_status,
            match_scope=match_scope,
            desktop_user_id=_optional_text(payload.get("desktopUserId")),
            user_name=_optional_text(payload.get("userName")),
            display_name=_optional_text(payload.get("displayName")),
        )


@dataclass(frozen=True)
class RedeemResult:
    outcome: str
    identity: Optional[IdentityResolution] = None

    @property
    def intercept(self) -> bool:
        return self.outcome in {"claimed", "already-mapped"}


@dataclass
class _CacheEntry:
    value: IdentityResolution
    expires_at: float


class EnterpriseWeComIdentityClient:
    """Calls the Gateway identity runtime using body-bound HMAC v2 proofs."""

    POSITIVE_TTL_SECONDS = 300.0
    NEGATIVE_TTL_SECONDS = 30.0
    ERROR_TTL_SECONDS = 5.0
    REQUEST_TIMEOUT_SECONDS = 0.8

    def __init__(
        self,
        *,
        gateway_base_url: str,
        gateway_service_token: str,
        binding_id: str,
        bot_id: str,
        secret: str,
        http_client: Any = None,
    ) -> None:
        parsed = urlsplit(str(gateway_base_url or "").strip())
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("invalid enterprise Gateway base URL")
        if not gateway_service_token:
            raise ValueError("missing enterprise Gateway service token")
        self._base_url = f"{parsed.scheme}://{parsed.netloc}"
        self._service_token = str(gateway_service_token)
        self.binding_id = str(binding_id)
        self.bot_id = str(bot_id)
        self.secret = str(secret)
        self._http_client = http_client
        self._owns_http_client = http_client is None
        self._cache: dict[str, _CacheEntry] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def close(self) -> None:
        client, self._http_client = self._http_client, None
        self._cache.clear()
        self._locks.clear()
        self._service_token = ""
        self.secret = ""
        self.bot_id = ""
        if self._owns_http_client and client is not None:
            await client.aclose()

    async def resolve(self, channel_user_id: str) -> IdentityResolution:
        actor = str(channel_user_id or "").strip()
        now = time.monotonic()
        cached = self._cache.get(actor)
        if cached and cached.expires_at > now:
            return cached.value
        lock = self._locks.setdefault(actor, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            cached = self._cache.get(actor)
            if cached and cached.expires_at > now:
                return cached.value
            try:
                payload = await self._post(
                    RESOLVE_PATH,
                    actor,
                    {"bindingId": self.binding_id, "channelUserId": actor},
                )
                if payload.get("contractVersion") != IDENTITY_CONTRACT_VERSION:
                    raise ValueError("identity resolve contract mismatch")
                if str(payload.get("bindingId") or "") != self.binding_id:
                    raise ValueError("identity resolve binding mismatch")
                resolution = IdentityResolution.from_payload(payload)
                ttl = (
                    self.POSITIVE_TTL_SECONDS
                    if resolution.mapping_status == "mapped"
                    else self.NEGATIVE_TTL_SECONDS
                )
            except Exception:
                # Identity is labeling only.  Gateway/auth/network failure must
                # not turn an open enterprise channel into an outage.
                resolution = IdentityResolution()
                ttl = self.ERROR_TTL_SECONDS
            self._cache[actor] = _CacheEntry(resolution, time.monotonic() + ttl)
            return resolution

    async def redeem(self, channel_user_id: str, code: str) -> RedeemResult:
        actor = str(channel_user_id or "").strip()
        payload = await self._post(
            REDEEM_PATH,
            actor,
            {
                "bindingId": self.binding_id,
                "channelUserId": actor,
                "chatType": "single",
                "code": str(code),
            },
        )
        if payload.get("contractVersion") != IDENTITY_CONTRACT_VERSION:
            raise ValueError("identity redeem contract mismatch")
        if str(payload.get("bindingId") or "") != self.binding_id:
            raise ValueError("identity redeem binding mismatch")
        outcome = str(payload.get("outcome") or "not-matched")
        if outcome not in {
            "claimed",
            "already-mapped",
            "not-matched",
            "expired",
            "locked",
            "actor-conflict",
            "user-conflict",
        }:
            outcome = "not-matched"
        identity_payload = payload.get("identity")
        identity = (
            IdentityResolution.from_payload(identity_payload)
            if isinstance(identity_payload, dict)
            else None
        )
        if outcome in {"claimed", "already-mapped"} and identity is not None:
            self._cache[actor] = _CacheEntry(
                identity,
                time.monotonic() + self.POSITIVE_TTL_SECONDS,
            )
        return RedeemResult(outcome=outcome, identity=identity)

    async def _post(self, path: str, actor_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = build_identity_signed_headers(
            source="wecom",
            bot_id=self.bot_id,
            actor_id=actor_id,
            secret=self.secret,
            method="POST",
            path=path,
            body=body,
        )
        headers["Authorization"] = f"Bearer {self._service_token}"
        headers["Content-Type"] = "application/json"
        client = await self._client()
        response = await client.post(
            f"{self._base_url}{path}",
            content=body,
            headers=headers,
            timeout=self.REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        parsed = response.json()
        if not isinstance(parsed, dict):
            raise ValueError("invalid identity response")
        return parsed

    async def _client(self):
        if self._http_client is None:
            import httpx

            self._http_client = httpx.AsyncClient(follow_redirects=False)
        return self._http_client


def _optional_text(value: Any) -> Optional[str]:
    normalized = str(value or "").strip()
    return normalized or None
