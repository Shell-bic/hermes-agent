"""Unified Secret Boundary policy for assistant-visible runtime surfaces.

The policy classifies credential-bearing paths and shell reads independently
from any one tool.  Callers decide where to enforce the classification; text
redaction becomes non-optional when the enterprise managed boundary is active.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional

from agent.redact import redact_sensitive_text
from hermes_cli.enterprise_policy import is_enterprise_managed


class PathSensitivity(str, Enum):
    """Assistant-read classification for a filesystem path."""

    PUBLIC = "public"
    SENSITIVE = "sensitive"
    CREDENTIAL_STORE = "credential_store"
    INTERNAL_CACHE = "internal_cache"


@dataclass(frozen=True)
class PathClassification:
    path: Path
    sensitivity: PathSensitivity
    reason: str = ""

    @property
    def assistant_read_allowed(self) -> bool:
        return self.sensitivity is PathSensitivity.PUBLIC


@dataclass(frozen=True)
class CommandClassification:
    allowed: bool
    reason: str = ""
    sensitive_paths: tuple[str, ...] = ()


_SAFE_ENV_TEMPLATES = {".env.example", ".env.sample", ".env.template"}
BLOCKED_PROJECT_ENV_BASENAMES = {
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    ".env.staging",
    ".envrc",
}

_CREDENTIAL_FILES = (
    "auth.json",
    "auth.lock",
    ".anthropic_oauth.json",
    ".env",
    "webhook_subscriptions.json",
    os.path.join("auth", "google_oauth.json"),
    os.path.join("cache", "bws_cache.json"),
)

_SENSITIVE_PATH_FRAGMENT_RE = re.compile(
    r"(?i)(?:"
    r"\.envrc\b|"
    r"\.env(?!\.(?:example|sample|template)\b)(?:\.[A-Za-z0-9_-]+)?\b|"
    r"\.anthropic_oauth\.json\b|auth\.json\b|auth\.lock\b|"
    r"webhook_subscriptions\.json\b|google_oauth\.json\b|"
    r"bws_cache\.json\b|mcp-tokens(?:[\\/][^\s;|&]+)?"
    r")"
)

_ENV_DUMP_RE = re.compile(
    r"(?i)^\s*(?:env|printenv)(?:\s|$)|"
    r"^\s*set(?:\s|\||$)|"
    r"^\s*(?:get-childitem|gci|dir)\s+env:(?:\s|\||$)"
)

_SECRET_ENV_REFERENCE_RE = re.compile(
    r"(?i)(?:"
    r"\$(?:env:)?|%"
    r")(?:COMPANY_GATEWAY_TOKEN|HERMES_DASHBOARD_SESSION_TOKEN|DESKTOP_TOKEN|"
    r"[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))%?"
)

_ENTERPRISE_TOKEN_RE = re.compile(r"\b(?:gw|dsk|adm)_[A-Za-z0-9_-]{16,}\b")
_BEARER_OR_TOKEN_RE = re.compile(
    r"\b(?:Bearer|token)\s+[A-Za-z0-9._~+/-]{16,}\b",
    re.IGNORECASE,
)
_LABELED_API_KEY_RE = re.compile(
    r"\b(?:x-api-key|api-key|api_key)\s*[:=]\s*[A-Za-z0-9._~+/-]{12,}\b",
    re.IGNORECASE,
)
_BASE64_CANDIDATE_RE = re.compile(
    r"(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/_-]{24,})(?:={0,2})(?![A-Za-z0-9+/_=-])"
)
_HEX_CANDIDATE_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:[0-9A-Fa-f]{2}){12,}(?![A-Za-z0-9])"
)
_PERCENT_ENCODED_CANDIDATE_RE = re.compile(
    r"(?<!%)(?:%[0-9A-Fa-f]{2}){12,}(?![0-9A-Fa-f])"
)
_PHONE_CANDIDATE_RE = re.compile(r"\+[1-9]\d{6,14}(?![A-Za-z0-9])")

_SAFE_PATH_TOKEN = r"(?:\"[A-Za-z0-9_./\\:~ -]+\"|'[A-Za-z0-9_./\\:~ -]+'|[A-Za-z0-9_./\\:~-]+)"
_SAFE_METADATA_SIMPLE_RE = re.compile(
    rf"(?i)^\s*(?:test-path|stat|sha256sum)\s+(?:-[A-Za-z0-9_=.-]+\s+)*{_SAFE_PATH_TOKEN}\s*$"
)
_SAFE_GET_ITEM_RE = re.compile(
    rf"(?i)^\s*get-item\s+{_SAFE_PATH_TOKEN}"
    r"(?:\s*\|\s*select-object\s+([A-Za-z, ]+))?\s*$"
)
_SAFE_METADATA_FIELDS = {
    "attributes",
    "creationtime",
    "exists",
    "lastwritetime",
    "length",
    "mode",
    "name",
}

_EXPORT_SENSITIVE_KEY_RE = re.compile(
    r"(^token$|api[_-]?key|access[_-]?token|refresh[_-]?token|gateway[_-]?token|"
    r"desktop[_-]?token|authorization|secret|password|credential|ciphertext)",
    re.IGNORECASE,
)
_EXPORT_REASONING_KEY_RE = re.compile(
    r"^(thinking|reasoning|reasoning_content|reasoning_details|codex_reasoning_items)$",
    re.IGNORECASE,
)
_REDACTED = "[REDACTED]"


def _hermes_paths() -> tuple[Path, ...]:
    """Return active and root Hermes homes without taking import-time snapshots."""
    paths: list[Path] = []
    try:
        from hermes_constants import get_default_hermes_root, get_hermes_home

        candidates = (get_hermes_home(), get_default_hermes_root())
    except Exception:
        candidates = (Path(os.path.expanduser("~/.hermes")),)

    for candidate in candidates:
        try:
            resolved = Path(candidate).expanduser().resolve()
        except Exception:
            continue
        if resolved not in paths:
            paths.append(resolved)
    return tuple(paths)


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _looks_like_secret_text(text: str) -> bool:
    # Phone-number masking is valid for direct assistant output but does not
    # make an opaque encoded blob a credential.  Exclude phones before using
    # the canonical redactor as the decoded-secret classifier.
    credential_text = _PHONE_CANDIDATE_RE.sub("", text)
    forced = redact_sensitive_text(credential_text, force=True)
    return forced != credential_text or bool(_ENTERPRISE_TOKEN_RE.search(text))


def _decode_base64_once(encoded: str) -> Optional[str]:
    """Decode one standard or URL-safe Base64 layer, including omitted padding."""
    padding = (-len(encoded)) % 4
    if padding == 3:
        # A Base64 payload can never have a one-character final quantum.
        return None
    try:
        decoded = base64.b64decode(
            encoded + ("=" * padding),
            altchars=b"-_",
            validate=True,
        )
        return decoded.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None


def _decode_hex_once(encoded: str) -> Optional[str]:
    """Decode one hexadecimal layer when it contains valid UTF-8 text."""
    try:
        return bytes.fromhex(encoded).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def _decode_percent_once(encoded: str) -> Optional[str]:
    """Decode a fully percent-encoded byte sequence exactly once."""
    try:
        raw = bytes(int(encoded[index + 1:index + 3], 16) for index in range(0, len(encoded), 3))
        return raw.decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def _redact_decoded_secret(
    match: re.Match[str],
    decoder: Callable[[str], Optional[str]],
) -> str:
    """Mask an encoded candidate only when its decoded text is secret-bearing."""
    encoded = match.group(0)
    decoded = decoder(encoded)
    if decoded is None or not _looks_like_secret_text(decoded):
        return encoded
    return "[REDACTED ENCODED SECRET]"


def _is_safe_metadata_command(command: str) -> bool:
    if _SAFE_METADATA_SIMPLE_RE.fullmatch(command):
        return True
    match = _SAFE_GET_ITEM_RE.fullmatch(command)
    if not match:
        return False
    raw_fields = match.group(1)
    if raw_fields is None:
        return True
    fields = {field.strip().casefold() for field in raw_fields.split(",") if field.strip()}
    return bool(fields) and fields.issubset(_SAFE_METADATA_FIELDS)


class SecretPolicy:
    """Shared classifier and redactor for credential-bearing data."""

    def classify_path(
        self,
        path: os.PathLike[str] | str,
        *,
        cwd: Optional[os.PathLike[str] | str] = None,
        hermes_paths: Optional[tuple[os.PathLike[str] | str, ...]] = None,
    ) -> PathClassification:
        candidate = Path(path).expanduser()
        if not candidate.is_absolute() and cwd is not None:
            candidate = Path(cwd).expanduser() / candidate
        resolved = candidate.resolve()

        resolved_hermes_paths = _hermes_paths() if hermes_paths is None else tuple(
            Path(item).expanduser().resolve() for item in hermes_paths
        )
        for hermes_home in resolved_hermes_paths:
            hub = hermes_home / "skills" / ".hub"
            if _is_relative_to(resolved, hub):
                return PathClassification(
                    resolved,
                    PathSensitivity.INTERNAL_CACHE,
                    "internal Hermes cache",
                )

            mcp_tokens = hermes_home / "mcp-tokens"
            if _is_relative_to(resolved, mcp_tokens):
                return PathClassification(
                    resolved,
                    PathSensitivity.CREDENTIAL_STORE,
                    "Hermes MCP token store",
                )

            for relative in _CREDENTIAL_FILES:
                if resolved == (hermes_home / relative).resolve():
                    return PathClassification(
                        resolved,
                        PathSensitivity.CREDENTIAL_STORE,
                        "Hermes credential store",
                    )

        name = resolved.name.casefold()
        is_secret_env = (
            name in BLOCKED_PROJECT_ENV_BASENAMES
            or (
                name.startswith(".env.")
                and name not in _SAFE_ENV_TEMPLATES
            )
        )
        if is_secret_env:
            return PathClassification(
                resolved,
                PathSensitivity.CREDENTIAL_STORE,
                "secret-bearing environment file",
            )

        return PathClassification(resolved, PathSensitivity.PUBLIC)

    def classify_command(
        self,
        command: str,
        *,
        cwd: Optional[os.PathLike[str] | str] = None,
    ) -> CommandClassification:
        text = str(command or "")
        if not text.strip():
            return CommandClassification(allowed=True)

        if _ENV_DUMP_RE.search(text):
            return CommandClassification(
                allowed=False,
                reason="environment dump may expose managed credentials",
            )

        if _SECRET_ENV_REFERENCE_RE.search(text):
            return CommandClassification(
                allowed=False,
                reason="command reads a credential environment variable",
            )

        fragments = tuple(match.group(0) for match in _SENSITIVE_PATH_FRAGMENT_RE.finditer(text))
        if fragments and not _is_safe_metadata_command(text):
            return CommandClassification(
                allowed=False,
                reason="command may read, copy, move, or encode a credential-bearing path",
                sensitive_paths=fragments,
            )

        return CommandClassification(allowed=True)

    def redact_text(self, text: Any, *, force: bool = False) -> Any:
        """Redact assistant-visible text; managed mode always forces the pass."""
        if text is None:
            return None
        if not isinstance(text, str):
            text = str(text)
        if not text:
            return text

        boundary_force = force or is_enterprise_managed()
        redacted = redact_sensitive_text(text, force=boundary_force)
        if not boundary_force:
            return redacted

        redacted = _ENTERPRISE_TOKEN_RE.sub("[REDACTED]", redacted)
        redacted = _BEARER_OR_TOKEN_RE.sub("[REDACTED]", redacted)
        redacted = _LABELED_API_KEY_RE.sub("[REDACTED]", redacted)

        redacted = _PERCENT_ENCODED_CANDIDATE_RE.sub(
            lambda match: _redact_decoded_secret(match, _decode_percent_once),
            redacted,
        )
        redacted = _HEX_CANDIDATE_RE.sub(
            lambda match: _redact_decoded_secret(match, _decode_hex_once),
            redacted,
        )
        return _BASE64_CANDIDATE_RE.sub(
            lambda match: _redact_decoded_secret(match, _decode_base64_once),
            redacted,
        )

    def redact_value(
        self,
        value: Any,
        *,
        force: bool = False,
        redact_sensitive_keys: bool = False,
        key: Optional[str] = None,
    ) -> Any:
        """Recursively redact string leaves without changing JSON structure.

        ``redact_sensitive_keys`` is the stronger export mode: known
        credential and reasoning fields are masked even when their current
        value does not match a token pattern.  Containers remain containers,
        and their keys/order are preserved so callers can still serialize the
        result as the same JSON shape.
        """
        sensitive_key = bool(
            redact_sensitive_keys
            and key
            and (
                _EXPORT_SENSITIVE_KEY_RE.search(key)
                or _EXPORT_REASONING_KEY_RE.search(key)
            )
        )

        if isinstance(value, dict):
            return {
                item_key: self.redact_value(
                    item_value,
                    force=force,
                    redact_sensitive_keys=redact_sensitive_keys,
                    key=str(item_key),
                )
                if not sensitive_key
                else self._redact_value_shape(item_value)
                for item_key, item_value in value.items()
            }
        if isinstance(value, list):
            if sensitive_key:
                return [self._redact_value_shape(item) for item in value]
            return [
                self.redact_value(
                    item,
                    force=force,
                    redact_sensitive_keys=redact_sensitive_keys,
                )
                for item in value
            ]
        if isinstance(value, tuple):
            if sensitive_key:
                return tuple(self._redact_value_shape(item) for item in value)
            return tuple(
                self.redact_value(
                    item,
                    force=force,
                    redact_sensitive_keys=redact_sensitive_keys,
                )
                for item in value
            )
        if isinstance(value, str):
            return _REDACTED if sensitive_key else self.redact_text(value, force=force)
        if sensitive_key and value is not None:
            return _REDACTED
        return value

    def redact_persisted_value(self, value: Any) -> Any:
        """Protect a persistence payload only inside the managed boundary.

        Non-managed Hermes keeps its established raw SQLite semantics.  In
        enterprise managed mode every string leaf is forced through the same
        SecretPolicy pass, including nested tool arguments/results and
        provider reasoning structures.
        """
        if not is_enterprise_managed():
            return value
        return self.redact_value(value, force=True)

    def redact_persisted_json(self, value: Optional[str]) -> Optional[str]:
        """Redact a JSON text payload while keeping it valid JSON."""
        if value is None or not is_enterprise_managed():
            return value
        try:
            decoded = json.loads(value)
        except (json.JSONDecodeError, TypeError, ValueError):
            return self.redact_text(value, force=True)
        redacted = self.redact_value(decoded, force=True)
        return json.dumps(redacted, ensure_ascii=False)

    def redact_export_value(self, value: Any) -> Any:
        """Apply the canonical, always-on session-export policy."""
        return self.redact_value(
            value,
            force=True,
            redact_sensitive_keys=True,
        )

    def _redact_value_shape(self, value: Any) -> Any:
        """Mask string leaves while preserving a sensitive field's shape."""
        if isinstance(value, dict):
            return {
                item_key: self._redact_value_shape(item_value)
                for item_key, item_value in value.items()
            }
        if isinstance(value, list):
            return [self._redact_value_shape(item) for item in value]
        if isinstance(value, tuple):
            return tuple(self._redact_value_shape(item) for item in value)
        if isinstance(value, str):
            return _REDACTED
        if value is None:
            return None
        return _REDACTED


secret_policy = SecretPolicy()


__all__ = [
    "BLOCKED_PROJECT_ENV_BASENAMES",
    "CommandClassification",
    "PathClassification",
    "PathSensitivity",
    "SecretPolicy",
    "secret_policy",
]
