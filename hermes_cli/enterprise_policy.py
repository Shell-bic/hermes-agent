"""Enterprise managed-mode policy helpers.

These helpers are intentionally independent from ``config.is_managed()``.
That flag describes package-manager ownership of an install, while
``HERMES_ENTERPRISE_MANAGED`` describes an enterprise runtime policy boundary.
"""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
from typing import Any, Mapping, Optional


ENTERPRISE_MANAGED_ENV = "HERMES_ENTERPRISE_MANAGED"
ENTERPRISE_POLICY_FILE_ENV = "HERMES_ENTERPRISE_TOOL_POLICY_FILE"
ENTERPRISE_POLICY_JSON_ENV = "HERMES_ENTERPRISE_TOOL_POLICY_JSON"
ENTERPRISE_PROVIDER = "company-gateway"
ENTERPRISE_GATEWAY_TOKEN_ENV = "COMPANY_GATEWAY_TOKEN"
ENTERPRISE_PROFILE_PREFIX = "enterprise-profile:"

_TRUE_VALUES = {"1", "true", "yes", "on"}

_MODEL_CONFIG_KEYS = {
    "model",
    "providers",
    "custom_providers",
    "fallback_model",
    "fallback_providers",
    "auxiliary",
    "delegation",
}

_DEFAULT_DENY_CAPABILITIES = {
    "credentials.manage",
    "cron.manage",
    "mcp.manage",
    "memory.manage",
    "skills.manage",
    "toolsets.manage",
    "webhooks.manage",
}

_TOOL_POLICY_COLLECTION_KEYS = {
    "skills": ("skills",),
    "toolsets": ("toolSets", "toolsets", "tool_sets"),
    "tools": ("tools",),
    "mcpServers": ("mcpServers", "mcp_servers", "mcp"),
}

_DENIED_TOOL_POLICY_STATUSES = {"restricted", "blocked"}
_ALLOWED_TOOL_POLICY_STATUSES = {
    "available",
    "defaultenabled",
    "recommended",
    "teamshared",
    "usercreated",
}

_HIGH_RISK_TOOL_NAMES = {
    "computer_use",
    "execute_code",
    "patch",
    "process",
    "skill_manage",
    "terminal",
    "write_file",
}

_HIGH_RISK_TOOLSETS = {
    "browser",
    "browser-cdp",
    "code_execution",
    "computer_use",
    "terminal",
}

_SURFACE_ALIASES = {
    "credential": "credentials",
    "credentials_pool": "credentials",
    "models": "model",
    "provider": "providers",
    "toolset": "toolsets",
    "tools": "toolsets",
    "webhook": "webhooks",
}

_SECRET_FIELD_PATTERN = (
    "secret",
    "api_key",
    "apikey",
    "api-key",
    "password",
    "credential",
)
_SECRET_FIELD_EXACT = {"token", "access_token", "refresh_token", "id_token"}


class EnterprisePolicyDenied(PermissionError):
    """Raised when enterprise managed policy refuses a local mutation."""


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in _TRUE_VALUES


def is_enterprise_managed() -> bool:
    """Return true only for the enterprise runtime managed flag."""
    return _truthy(os.getenv(ENTERPRISE_MANAGED_ENV, ""))


def _read_policy_file(path: str) -> Mapping[str, Any]:
    if not path:
        return {}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def load_enterprise_policy() -> Mapping[str, Any]:
    """Load the Phase 2 policy snapshot, if one was supplied."""
    raw_json = os.getenv(ENTERPRISE_POLICY_JSON_ENV, "").strip()
    if raw_json:
        try:
            data = json.loads(raw_json)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return _read_policy_file(os.getenv(ENTERPRISE_POLICY_FILE_ENV, "").strip())


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: Any) -> str:
    return str(value or "").strip()


def _policy_value(policy: Mapping[str, Any], key: str) -> Any:
    if key in policy:
        return policy.get(key)
    manifest = policy.get("manifest")
    if isinstance(manifest, dict):
        return manifest.get(key)
    return None


def _policy_value_any(policy: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        value = _policy_value(policy, key)
        if value is not None:
            return value
    return None


def scrub_secret_fields(value: Any) -> Any:
    """Return a copy of policy data without endpoint secrets or credentials."""
    if isinstance(value, list):
        return [scrub_secret_fields(item) for item in value]
    if not isinstance(value, dict):
        return value

    result: dict[str, Any] = {}
    for key, item in value.items():
        key_text = str(key)
        key_norm = key_text.lower().replace("-", "_")
        if key_norm in _SECRET_FIELD_EXACT or any(marker in key_norm for marker in _SECRET_FIELD_PATTERN):
            continue
        result[key_text] = scrub_secret_fields(item)
    return result


def _looks_like_tool_policy_snapshot(value: Mapping[str, Any]) -> bool:
    return any(
        key in value
        for keys in _TOOL_POLICY_COLLECTION_KEYS.values()
        for key in keys
    ) or "capabilityFlags" in value or "capability_flags" in value


def tool_policy_snapshot(policy: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """Return the enterprise tool policy snapshot, if present.

    The Gateway U2 contract nests this under ``toolPolicySnapshot``. During
    rollout, tests and older manifests may hand the snapshot directly or wrap it
    under ``manifest``; accept those shapes so the runtime guard remains
    backward-compatible while Gateway/Desktop converge on the final contract.
    """
    policy = policy or load_enterprise_policy()
    if not isinstance(policy, dict):
        return {}

    raw = _policy_value_any(policy, "toolPolicySnapshot", "tool_policy_snapshot")
    if isinstance(raw, dict):
        cleaned = scrub_secret_fields(raw)
        return dict(cleaned) if isinstance(cleaned, dict) else {}

    if _looks_like_tool_policy_snapshot(policy):
        cleaned = scrub_secret_fields(policy)
        return dict(cleaned) if isinstance(cleaned, dict) else {}

    return {}


def _tool_policy_collection(
    snapshot: Mapping[str, Any],
    collection: str,
) -> Any:
    for key in _TOOL_POLICY_COLLECTION_KEYS.get(collection, (collection,)):
        if key in snapshot:
            return snapshot.get(key)
    return None


def _entry_key(entry: Mapping[str, Any]) -> str:
    for key in ("key", "name", "id", "slug"):
        value = _text(entry.get(key))
        if value:
            return value
    return ""


def _entry_explicit_bool(entry: Mapping[str, Any]) -> Optional[bool]:
    for key in ("enabled", "allowed", "allow"):
        if isinstance(entry.get(key), bool):
            return entry[key]
    return None


def _catalog_lookup_keys(collection: str, key: str) -> set[str]:
    lookup = _text(key)
    if not lookup:
        return set()

    values = {lookup}
    lowered = lookup.lower()
    prefixes = {
        "skills": "skill.",
        "toolsets": "toolset.",
        "mcpServers": "mcp.",
    }
    prefix = prefixes.get(collection)
    if prefix:
        if lowered.startswith(prefix):
            stripped = lookup[len(prefix):]
            if stripped:
                values.add(stripped)
        else:
            values.add(f"{prefix}{lookup}")

    return {item.lower() for item in values if item}


def _capability_entry_enabled(entry: Mapping[str, Any]) -> bool:
    explicit = _entry_explicit_bool(entry)
    if explicit is not None:
        return explicit
    status = _text(entry.get("status")).lower()
    return status not in _DENIED_TOOL_POLICY_STATUSES


def _capability_raw_enabled(raw: Any, default: bool) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, dict):
        return _capability_entry_enabled(raw)
    if isinstance(raw, str):
        status = raw.strip().lower()
        if status in _DENIED_TOOL_POLICY_STATUSES:
            return False
        if status:
            return True
    return default


def _tool_policy_entry(
    collection: str,
    key: str,
    policy: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    lookup = _text(key)
    if not lookup:
        return {}
    snapshot = tool_policy_snapshot(policy)
    if not snapshot:
        return {}

    lookup_keys = _catalog_lookup_keys(collection, lookup)
    raw = _tool_policy_collection(snapshot, collection)
    if isinstance(raw, dict):
        item = raw.get(lookup)
        if item is None:
            item = next(
                (value for item_key, value in raw.items() if str(item_key).lower() in lookup_keys),
                None,
            )
        if isinstance(item, dict):
            cleaned = scrub_secret_fields(item)
            return dict(cleaned) if isinstance(cleaned, dict) else {}
        if isinstance(item, str):
            return {"key": lookup, "status": item}
        return {}

    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            if _entry_key(item).lower() in lookup_keys:
                cleaned = scrub_secret_fields(item)
                return dict(cleaned) if isinstance(cleaned, dict) else {}
    return {}


def tool_policy_status(
    collection: str,
    key: str,
    *,
    default: str = "",
    policy: Optional[Mapping[str, Any]] = None,
) -> str:
    entry = _tool_policy_entry(collection, key, policy)
    status = _text(entry.get("status"))
    return status or default


def _tool_policy_denies(
    collection: str,
    key: str,
    policy: Optional[Mapping[str, Any]] = None,
) -> bool:
    return tool_policy_status(collection, key, policy=policy).lower() in _DENIED_TOOL_POLICY_STATUSES


def _policy_hash(snapshot: Mapping[str, Any]) -> str:
    return _text(snapshot.get("policyHash") or snapshot.get("policy_hash"))


def _policy_file_fingerprint() -> tuple[str, Optional[tuple[int, int]]]:
    path = os.getenv(ENTERPRISE_POLICY_FILE_ENV, "").strip()
    if not path:
        return "", None
    try:
        stat = Path(path).stat()
        return path, (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return path, None


def _policy_json_fingerprint() -> str:
    raw = os.getenv(ENTERPRISE_POLICY_JSON_ENV, "")
    if not raw:
        return ""
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()


def enterprise_policy_fingerprint(policy: Optional[Mapping[str, Any]] = None) -> tuple[Any, ...]:
    """Return a compact fingerprint for runtime schema cache invalidation."""
    policy = policy or load_enterprise_policy()
    snapshot = tool_policy_snapshot(policy)
    file_path, file_stat = _policy_file_fingerprint()
    return (
        is_enterprise_managed(),
        _policy_hash(snapshot),
        file_path,
        file_stat,
        _policy_json_fingerprint(),
    )


def _status_norm(status: str) -> str:
    return status.strip().lower().replace("-", "").replace("_", "")


def _policy_entry_decision(
    collection: str,
    key: str,
    policy: Mapping[str, Any],
) -> Optional[dict[str, Any]]:
    entry = _tool_policy_entry(collection, key, policy)
    if not entry:
        return None

    status = _text(entry.get("status"))
    status_norm = _status_norm(status)
    explicit = _entry_explicit_bool(entry)
    allowed = _capability_entry_enabled(entry)
    if status_norm in _DENIED_TOOL_POLICY_STATUSES or explicit is False:
        allowed = False
    elif status_norm in _ALLOWED_TOOL_POLICY_STATUSES or explicit is True:
        allowed = True

    return {
        "allowed": bool(allowed),
        "collection": collection,
        "key": key,
        "status": status or ("allowed" if allowed else "blocked"),
    }


def _append_unique(items: list[str], value: str) -> None:
    if value and value.lower() not in {item.lower() for item in items}:
        items.append(value)


def _runtime_tool_alias_keys(tool_name: str, toolset: str) -> list[str]:
    aliases: list[str] = []
    if tool_name in {"terminal", "process"} or toolset == "terminal":
        _append_unique(aliases, "tool.terminal.exec")
    if tool_name in {"read_file", "search_files"}:
        _append_unique(aliases, "tool.file.read")
    if tool_name in {"write_file", "patch"}:
        _append_unique(aliases, "tool.file.write")
    if tool_name.startswith("browser_") or toolset in {"browser", "browser-cdp"}:
        _append_unique(aliases, "tool.browser.open")
    return aliases


def _tool_specific_candidate_keys(tool_name: str, toolset: str) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []
    tool_name = _text(tool_name)
    toolset = _text(toolset)
    if tool_name:
        candidates.append(("tools", tool_name))
        candidates.append(("tools", f"tool.{tool_name}"))
        if toolset:
            candidates.append(("tools", f"tool.{toolset}.{tool_name}"))
        for alias in _runtime_tool_alias_keys(tool_name, toolset):
            candidates.append(("tools", alias))
    return candidates


def _toolset_candidate_keys(toolset: str) -> list[tuple[str, str]]:
    toolset = _text(toolset)
    if not toolset:
        return []
    return [("toolsets", toolset), ("toolsets", f"toolset.{toolset}")]


def _mcp_server_name_candidates(tool_name: str, toolset: str) -> list[str]:
    candidates: list[str] = []
    toolset = _text(toolset)
    tool_name = _text(tool_name)
    if toolset.startswith("mcp-"):
        candidates.append(toolset)
        stripped = toolset[4:]
        if stripped:
            candidates.append(stripped)
            candidates.append(f"mcp.{stripped}")
    if tool_name.startswith("mcp_"):
        parts = tool_name.split("_")
        if len(parts) >= 2 and parts[1]:
            candidates.append(parts[1])
            candidates.append(f"mcp.{parts[1]}")

    seen: set[str] = set()
    result: list[str] = []
    for item in candidates:
        lowered = item.lower()
        if lowered not in seen:
            seen.add(lowered)
            result.append(item)
    return result


def _is_mcp_runtime_tool(tool_name: str, toolset: str) -> bool:
    return _text(toolset).startswith("mcp-") or _text(tool_name).startswith("mcp_")


def _is_high_risk_runtime_tool(tool_name: str, toolset: str) -> bool:
    tool_name = _text(tool_name)
    toolset = _text(toolset)
    if _is_mcp_runtime_tool(tool_name, toolset):
        return True
    if tool_name in _HIGH_RISK_TOOL_NAMES:
        return True
    if tool_name.startswith("browser_"):
        return True
    return toolset in _HIGH_RISK_TOOLSETS


def _runtime_tool_capabilities(tool_name: str, toolset: str) -> list[str]:
    tool_name = _text(tool_name)
    toolset = _text(toolset)
    if _is_mcp_runtime_tool(tool_name, toolset):
        return ["capability.mcp.install", "mcp.manage"]
    if tool_name in {"terminal", "process", "execute_code"} or toolset == "terminal":
        return ["capability.terminal.shell"]
    if tool_name in {"write_file", "patch"}:
        return ["capability.file.write"]
    if tool_name.startswith("browser_") or toolset in {"browser", "browser-cdp"}:
        return ["capability.browser.automation"]
    if tool_name == "skill_manage":
        return ["skills.manage"]
    return []


def runtime_tool_schema_decision(
    tool_name: str,
    *,
    toolset: str = "",
    policy: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """Return whether a runtime tool may appear in callable schemas.

    U3 schema enforcement only activates for enterprise managed mode with a
    real ``toolPolicySnapshot``. Older manifests that only contain
    ``policyVersion`` keep their U2 behavior.
    """
    if not is_enterprise_managed():
        return {"allowed": True, "reason": "not_enterprise_managed"}

    policy = policy or load_enterprise_policy()
    snapshot = tool_policy_snapshot(policy)
    if not snapshot:
        return {"allowed": True, "reason": "no_tool_policy_snapshot"}

    tool_name = _text(tool_name)
    toolset = _text(toolset)
    policy_hash = _policy_hash(snapshot)

    def _collect(candidates: list[tuple[str, str]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        denied_items: list[dict[str, Any]] = []
        allowed_items: list[dict[str, Any]] = []
        for collection, key in candidates:
            if collection == "tools" and not is_tool_allowed(key, policy):
                denied_items.append({
                    "collection": collection,
                    "key": key,
                    "status": tool_policy_status(collection, key, policy=policy),
                })
                continue
            if collection == "toolsets" and not is_toolset_allowed(key, policy):
                denied_items.append({
                    "collection": collection,
                    "key": key,
                    "status": tool_policy_status(collection, key, policy=policy),
                })
                continue
            if collection == "mcpServers" and not is_mcp_allowed(key, policy):
                denied_items.append({
                    "collection": collection,
                    "key": key,
                    "status": tool_policy_status(collection, key, policy=policy),
                })
                continue
            decision = _policy_entry_decision(collection, key, policy)
            if decision is None:
                continue
            (allowed_items if decision["allowed"] else denied_items).append(decision)
        return denied_items, allowed_items

    specific_denied, specific_allowed = _collect(
        _tool_specific_candidate_keys(tool_name, toolset)
    )
    if specific_denied:
        first = specific_denied[0]
        return {
            "allowed": False,
            "collection": first.get("collection", ""),
            "key": first.get("key", ""),
            "policyHash": policy_hash,
            "reason": "enterprise_tool_policy_denied",
            "status": first.get("status") or "blocked",
            "tool": tool_name,
            "toolset": toolset,
        }

    for capability in _runtime_tool_capabilities(tool_name, toolset):
        if not capability_enabled(capability, policy, default=True):
            return {
                "allowed": False,
                "collection": "capabilityFlags",
                "key": capability,
                "policyHash": policy_hash,
                "reason": "enterprise_capability_disabled",
                "status": "blocked",
                "tool": tool_name,
                "toolset": toolset,
            }

    mcp_candidates = [
        ("mcpServers", key)
        for key in _mcp_server_name_candidates(tool_name, toolset)
    ]
    mcp_denied, mcp_allowed = _collect(mcp_candidates)
    if mcp_denied:
        first = mcp_denied[0]
        return {
            "allowed": False,
            "collection": first.get("collection", ""),
            "key": first.get("key", ""),
            "policyHash": policy_hash,
            "reason": "enterprise_tool_policy_denied",
            "status": first.get("status") or "blocked",
            "tool": tool_name,
            "toolset": toolset,
        }

    if specific_allowed:
        first = specific_allowed[0]
        return {
            "allowed": True,
            "collection": first.get("collection", ""),
            "key": first.get("key", ""),
            "policyHash": policy_hash,
            "reason": "enterprise_tool_policy_allowed",
            "status": first.get("status") or "available",
            "tool": tool_name,
            "toolset": toolset,
        }

    if mcp_allowed:
        first = mcp_allowed[0]
        return {
            "allowed": True,
            "collection": first.get("collection", ""),
            "key": first.get("key", ""),
            "policyHash": policy_hash,
            "reason": "enterprise_tool_policy_allowed",
            "status": first.get("status") or "available",
            "tool": tool_name,
            "toolset": toolset,
        }

    toolset_denied, toolset_allowed = _collect(_toolset_candidate_keys(toolset))
    if toolset_denied:
        first = toolset_denied[0]
        return {
            "allowed": False,
            "collection": first.get("collection", ""),
            "key": first.get("key", ""),
            "policyHash": policy_hash,
            "reason": "enterprise_tool_policy_denied",
            "status": first.get("status") or "blocked",
            "tool": tool_name,
            "toolset": toolset,
        }
    if toolset_allowed:
        first = toolset_allowed[0]
        return {
            "allowed": True,
            "collection": first.get("collection", ""),
            "key": first.get("key", ""),
            "policyHash": policy_hash,
            "reason": "enterprise_tool_policy_allowed",
            "status": first.get("status") or "available",
            "tool": tool_name,
            "toolset": toolset,
        }

    if _is_high_risk_runtime_tool(tool_name, toolset):
        return {
            "allowed": False,
            "policyHash": policy_hash,
            "reason": "enterprise_high_risk_tool_not_allowed",
            "status": "blocked",
            "tool": tool_name,
            "toolset": toolset,
        }

    return {
        "allowed": True,
        "policyHash": policy_hash,
        "reason": "enterprise_unknown_low_risk_tool_allowed",
        "status": "unlisted",
        "tool": tool_name,
        "toolset": toolset,
    }


def runtime_tool_policy_error(decision: Mapping[str, Any]) -> dict[str, Any]:
    """Build a structured denial safe to return to the model."""
    return {
        "error": "Enterprise tool policy denied this tool call",
        "code": "enterprise_tool_policy_denied",
        "tool": _text(decision.get("tool")),
        "toolset": _text(decision.get("toolset")),
        "status": _text(decision.get("status")),
        "reason": _text(decision.get("reason")),
        "policyHash": _text(decision.get("policyHash")),
    }


def capability_enabled(
    name: str,
    policy: Optional[Mapping[str, Any]] = None,
    *,
    default: bool = True,
) -> bool:
    capability = _text(name)
    policy = policy or load_enterprise_policy()
    snapshot = tool_policy_snapshot(policy)
    flags = snapshot.get("capabilityFlags") or snapshot.get("capability_flags")

    if isinstance(flags, list):
        has_entry_objects = any(isinstance(item, dict) for item in flags)
        if not has_entry_objects:
            normalized = {str(item).strip().lower() for item in flags}
            return capability.lower() in normalized

        capability_lower = capability.lower()
        for item in flags:
            if isinstance(item, dict):
                if _entry_key(item).lower() == capability_lower:
                    return _capability_entry_enabled(item)
            elif str(item or "").strip().lower() == capability_lower:
                return True
        return default
    if isinstance(flags, dict):
        raw = flags.get(capability)
        if raw is None:
            raw = flags.get(capability.replace(".", ":"))
        if raw is None:
            raw = flags.get(capability.replace(".", "_"))
        if raw is not None:
            return _capability_raw_enabled(raw, default)

    legacy = _capability_value(capability, policy)
    return default if legacy is None else legacy


def is_skill_allowed(name: str, policy: Optional[Mapping[str, Any]] = None) -> bool:
    if not is_enterprise_managed():
        return True
    return not _tool_policy_denies("skills", name, policy)


def is_toolset_allowed(name: str, policy: Optional[Mapping[str, Any]] = None) -> bool:
    if not is_enterprise_managed():
        return True
    return not _tool_policy_denies("toolsets", name, policy)


def is_tool_allowed(name: str, policy: Optional[Mapping[str, Any]] = None) -> bool:
    if not is_enterprise_managed():
        return True
    return not _tool_policy_denies("tools", name, policy)


def is_mcp_allowed(name: str, policy: Optional[Mapping[str, Any]] = None) -> bool:
    if not is_enterprise_managed():
        return True
    return not _tool_policy_denies("mcpServers", name, policy)


def model_profiles(policy: Optional[Mapping[str, Any]] = None) -> list[dict[str, Any]]:
    """Return sanitized enterprise model profiles from the policy snapshot."""
    policy = policy or load_enterprise_policy()
    raw_profiles = _policy_value(policy, "modelProfiles")
    profiles: list[dict[str, Any]] = []
    for item in _as_list(raw_profiles):
        if isinstance(item, dict):
            cleaned = scrub_secret_fields(item)
            if isinstance(cleaned, dict):
                profiles.append(dict(cleaned))
    return profiles


def _profile_model(profile: Mapping[str, Any]) -> str:
    for key in ("model", "modelId", "model_id", "runtimeModel", "runtime_model", "id", "name"):
        value = _text(profile.get(key))
        if value:
            return value
    return ""


def _profile_name(profile: Mapping[str, Any], fallback: str) -> str:
    for key in ("displayName", "display_name", "name", "label"):
        value = _text(profile.get(key))
        if value:
            return value
    return fallback


def _profile_option_id(profile: Mapping[str, Any]) -> str:
    profile_id = _text(profile.get("id"))
    return f"{ENTERPRISE_PROFILE_PREFIX}{profile_id}" if profile_id else ""


def _profile_values(profile: Mapping[str, Any]) -> set[str]:
    values = {
        _text(profile.get("id")),
        _profile_model(profile),
        _profile_name(profile, ""),
        _text(profile.get("displayName")),
        _text(profile.get("display_name")),
        _text(profile.get("name")),
        _profile_option_id(profile),
    }
    return {value for value in values if value}


def profile_id_from_selection(selection: str) -> str:
    value = _text(selection)
    if value.startswith(ENTERPRISE_PROFILE_PREFIX):
        return value[len(ENTERPRISE_PROFILE_PREFIX):].strip()
    return ""


def model_profile_for_selection(
    selection: str,
    policy: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    policy = policy or load_enterprise_policy()
    value = _text(selection)
    if not value:
        return {}

    requested_profile_id = profile_id_from_selection(value)
    current_profile_id = _text(_policy_value(policy, "currentModelProfileId"))
    current = current_model(policy)

    for profile in model_profiles(policy):
        profile_id = _text(profile.get("id"))
        if requested_profile_id and profile_id == requested_profile_id:
            return profile

    # A plain model id is ambiguous when multiple profiles point at the same
    # runtime model. Prefer the manifest/current profile in that case.
    if current_profile_id:
        for profile in model_profiles(policy):
            if _text(profile.get("id")) == current_profile_id and value in _profile_values(profile):
                return profile

    for profile in model_profiles(policy):
        if value in _profile_values(profile):
            return profile
        if current and value == current and current in _profile_values(profile):
            return profile

    return {}


def resolve_model_selection(
    selection: str,
    policy: Optional[Mapping[str, Any]] = None,
) -> dict[str, str]:
    value = _text(selection)
    profile = model_profile_for_selection(value, policy)
    if profile:
        model = _profile_model(profile)
        profile_id = _text(profile.get("id"))
        return {
            "model": model or value,
            "profile_id": profile_id,
            "selection": _profile_option_id(profile) or value,
        }

    return {"model": value, "profile_id": "", "selection": value}


def allowed_model_list(policy: Optional[Mapping[str, Any]] = None) -> list[str]:
    policy = policy or load_enterprise_policy()
    raw = _policy_value(policy, "allowedModels")
    models: list[str] = []
    seen: set[str] = set()
    for item in _as_list(raw):
        model = _text(item)
        if model and model not in seen:
            seen.add(model)
            models.append(model)
    return models


def default_model(policy: Optional[Mapping[str, Any]] = None) -> str:
    policy = policy or load_enterprise_policy()
    for key in ("defaultModel", "default_model"):
        value = _text(_policy_value(policy, key))
        if value:
            return value
    for profile in model_profiles(policy):
        if bool(profile.get("isDefault")):
            model = _profile_model(profile)
            if model:
                return model
    allowed = allowed_model_list(policy)
    return allowed[0] if allowed else ""


def current_model(policy: Optional[Mapping[str, Any]] = None) -> str:
    policy = policy or load_enterprise_policy()
    for key in ("currentModel", "selectedModel", "current_model", "selected_model"):
        value = _text(_policy_value(policy, key))
        if value:
            return value
    return default_model(policy)


def selected_model(policy: Optional[Mapping[str, Any]] = None) -> str:
    return current_model(policy)


def current_model_profile(policy: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    policy = policy or load_enterprise_policy()
    current = current_model(policy)
    profile_id = _text(_policy_value(policy, "currentModelProfileId"))
    for profile in model_profiles(policy):
        if profile_id and _text(profile.get("id")) == profile_id:
            return profile
    return model_profile_for_selection(current, policy) if current else {}


def capabilities(policy: Optional[Mapping[str, Any]] = None, model: str = "") -> dict[str, Any]:
    policy = policy or load_enterprise_policy()
    raw_top = _policy_value(policy, "capabilities")
    result = dict(scrub_secret_fields(raw_top)) if isinstance(raw_top, dict) else {}
    resolved = resolve_model_selection(_text(model) or current_model(policy), policy)
    model_id = resolved["profile_id"] or resolved["model"]
    for profile in model_profiles(policy):
        if model_id and model_id in _profile_values(profile):
            raw = profile.get("capabilities")
            if isinstance(raw, dict):
                result.update(dict(scrub_secret_fields(raw)))
            break
    return result


def runtime_defaults(policy: Optional[Mapping[str, Any]] = None, model: str = "") -> dict[str, Any]:
    policy = policy or load_enterprise_policy()
    raw = _policy_value(policy, "runtimeDefaults")
    result = dict(scrub_secret_fields(raw)) if isinstance(raw, dict) else {}
    resolved = resolve_model_selection(_text(model) or current_model(policy), policy)
    model_id = resolved["profile_id"] or resolved["model"]
    for profile in model_profiles(policy):
        if model_id and model_id in _profile_values(profile):
            profile_defaults = profile.get("runtimeDefaults")
            if isinstance(profile_defaults, dict):
                result.update(dict(scrub_secret_fields(profile_defaults)))
            break
    return result


def auxiliary_policy(policy: Optional[Mapping[str, Any]] = None, model: str = "") -> dict[str, Any]:
    policy = policy or load_enterprise_policy()
    raw = _policy_value(policy, "auxiliaryPolicy")
    result = dict(scrub_secret_fields(raw)) if isinstance(raw, dict) else {}
    resolved = resolve_model_selection(_text(model) or current_model(policy), policy)
    model_id = resolved["profile_id"] or resolved["model"]
    for profile in model_profiles(policy):
        if model_id and model_id in _profile_values(profile):
            profile_policy = profile.get("auxiliaryPolicy")
            if isinstance(profile_policy, dict):
                result.update(dict(scrub_secret_fields(profile_policy)))
            break
    return result


def allowed_model_profiles(policy: Optional[Mapping[str, Any]] = None) -> list[dict[str, Any]]:
    policy = policy or load_enterprise_policy()
    allowed = set(allowed_model_list(policy))
    profiles = model_profiles(policy)
    if not allowed:
        return profiles
    return [
        profile for profile in profiles
        if _profile_model(profile) in allowed or _text(profile.get("id")) in allowed
    ]


def model_display_name(model: str, policy: Optional[Mapping[str, Any]] = None) -> str:
    model_id = _text(model)
    policy = policy or load_enterprise_policy()
    profile = model_profile_for_selection(model_id, policy)
    if profile:
        return _profile_name(profile, _profile_model(profile) or model_id)
    return model_id


def managed_model_option_provider(policy: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """Build the single provider row exposed by /api/model/options in managed mode."""
    policy = policy or load_enterprise_policy()
    allowed_list = allowed_model_list(policy)
    allowed = set(allowed_list)
    models: list[str] = []
    seen: set[str] = set()
    caps_by_model: dict[str, Any] = {}

    for profile in allowed_model_profiles(policy):
        model = _profile_model(profile)
        if not model or model in seen:
            continue
        seen.add(model)
        models.append(model)
        raw_caps = profile.get("capabilities")
        if isinstance(raw_caps, dict):
            caps_by_model[model] = scrub_secret_fields(raw_caps)

    for model in allowed_list:
        if model and model not in seen:
            seen.add(model)
            models.append(model)

    provider: dict[str, Any] = {
        "authenticated": True,
        "models": models,
        "name": "Company Gateway",
        "slug": ENTERPRISE_PROVIDER,
        "total_models": len(models),
    }
    if caps_by_model:
        provider["capabilities"] = caps_by_model
    return provider


def allowed_models(policy: Optional[Mapping[str, Any]] = None) -> set[str]:
    return set(allowed_model_list(policy))


def _configured_enterprise_gateway_base_url() -> str:
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
    except Exception:
        return ""
    providers = cfg.get("providers")
    provider_cfg = providers.get(ENTERPRISE_PROVIDER) if isinstance(providers, dict) else {}
    if not isinstance(provider_cfg, dict):
        return ""
    for key in ("base_url", "api", "url"):
        value = _text(provider_cfg.get(key)).rstrip("/")
        if value:
            return value
    return ""


def _normalize_provider_id(value: str) -> str:
    return _text(value).lower()


def _normalize_base_url(value: str) -> str:
    return _text(value).rstrip("/")


def require_runtime_model_switch_allowed(
    model: str,
    *,
    requested_provider: str = "",
    current_provider: str = "",
    resolved_provider: str = "",
    resolved_base_url: str = "",
    action: str = "runtime model switch",
) -> None:
    """Validate a live model switch against enterprise managed policy.

    This is stricter than generic runtime provider resolution because the
    Desktop active-session path is a user-facing hot switch: the model must be
    explicitly authorized and the provider/result must stay on the enterprise
    gateway, even if aliases or custom provider config try to resolve elsewhere.
    """
    if not is_enterprise_managed():
        return

    require_model_allowed(model, action=action)

    provider = _normalize_provider_id(
        resolved_provider or requested_provider or current_provider
    )
    if provider != ENTERPRISE_PROVIDER:
        raise EnterprisePolicyDenied(
            denial_message(
                action,
                f"provider '{provider or 'auto'}' is not the enterprise gateway provider",
            )
        )

    if resolved_provider:
        actual_base_url = _normalize_base_url(resolved_base_url)
        expected_base_url = _normalize_base_url(_configured_enterprise_gateway_base_url())
        if actual_base_url and (
            not expected_base_url
            or actual_base_url.lower() != expected_base_url.lower()
        ):
            raise EnterprisePolicyDenied(
                denial_message(
                    action,
                    "custom endpoints, API keys, and local endpoints are controlled by enterprise policy",
                )
            )


def _normalize_surface(surface: str) -> str:
    value = str(surface or "").strip().lower().replace("_", "-")
    value = value.replace("/", ".")
    value = value.strip(".")
    value = _SURFACE_ALIASES.get(value, value)
    return value


def locked_surfaces(policy: Optional[Mapping[str, Any]] = None) -> set[str]:
    policy = policy or load_enterprise_policy()
    raw = policy.get("lockedSurfaces")
    if raw is None and isinstance(policy.get("manifest"), dict):
        raw = policy["manifest"].get("lockedSurfaces")
    if not isinstance(raw, list):
        return set()
    return {_normalize_surface(str(item)) for item in raw if str(item or "").strip()}


def is_surface_locked(surface: str, policy: Optional[Mapping[str, Any]] = None) -> bool:
    surface_norm = _normalize_surface(surface)
    locked = locked_surfaces(policy)
    if surface_norm in locked:
        return True
    family = surface_norm.split(".", 1)[0]
    return family in locked


def _capability_value(name: str, policy: Optional[Mapping[str, Any]] = None) -> Optional[bool]:
    policy = policy or load_enterprise_policy()
    caps = policy.get("capabilities")
    if isinstance(caps, list):
        normalized = {str(item).strip().lower() for item in caps}
        return name.lower() in normalized
    if isinstance(caps, dict):
        raw = caps.get(name)
        if raw is None:
            raw = caps.get(name.replace(".", ":"))
        if raw is None:
            raw = caps.get(name.replace(".", "_"))
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, dict):
            for key in ("enabled", "allowed", "allow"):
                if isinstance(raw.get(key), bool):
                    return raw[key]

    # Runtime manifests use ``capabilities`` for model features (reasoning,
    # context window, and so on).  Coarse-grained management grants remain on
    # the role records preserved in the managed policy snapshot.  Read those
    # only when the legacy top-level field did not explicitly decide the
    # requested capability.  Multiple roles are additive, matching Gateway's
    # bootstrap capability union.
    raw_roles = _policy_value_any(policy, "role", "roles")
    if isinstance(raw_roles, dict):
        roles = [raw_roles]
    elif isinstance(raw_roles, list):
        roles = [role for role in raw_roles if isinstance(role, dict)]
    else:
        roles = []

    capability = name.lower()
    saw_role_capabilities = False
    for role in roles:
        role_capabilities = role.get("capabilities")
        if isinstance(role_capabilities, list):
            saw_role_capabilities = True
            normalized = {str(item).strip().lower() for item in role_capabilities}
            if capability in normalized:
                return True
            continue
        if not isinstance(role_capabilities, dict):
            continue

        saw_role_capabilities = True
        raw = role_capabilities.get(name)
        if raw is None:
            raw = role_capabilities.get(name.replace(".", ":"))
        if raw is None:
            raw = role_capabilities.get(name.replace(".", "_"))
        if raw is True:
            return True
        if isinstance(raw, dict) and any(
            raw.get(key) is True for key in ("enabled", "allowed", "allow")
        ):
            return True

    return False if saw_role_capabilities else None


def denial_message(action: str, reason: str = "") -> str:
    detail = f"Enterprise managed policy denied {action}"
    if reason:
        detail += f": {reason}"
    return detail


def _require_tool_policy_allowed(
    collection: str,
    key: str,
    *,
    action: str,
    capability: str,
    legacy_surface: str,
) -> None:
    if not is_enterprise_managed():
        return

    policy = load_enterprise_policy()
    snapshot = tool_policy_snapshot(policy)
    if not snapshot:
        require_surface_allowed(legacy_surface, action=action, capability=capability)
        return

    status = tool_policy_status(collection, key, policy=policy)
    if status.lower() in _DENIED_TOOL_POLICY_STATUSES:
        raise EnterprisePolicyDenied(
            denial_message(
                action,
                f"{collection} '{key}' is {status} by enterprise tool policy",
            )
        )

    if not capability_enabled(capability, policy, default=True):
        raise EnterprisePolicyDenied(
            denial_message(action, f"capability '{capability}' is disabled")
        )


def require_skill_allowed(name: str, *, action: str = "skill operation") -> None:
    _require_tool_policy_allowed(
        "skills",
        name,
        action=action,
        capability="skills.manage",
        legacy_surface="skills",
    )


def require_toolset_allowed(name: str, *, action: str = "toolset operation") -> None:
    _require_tool_policy_allowed(
        "toolsets",
        name,
        action=action,
        capability="toolsets.manage",
        legacy_surface="toolsets",
    )


def require_mcp_allowed(name: str, *, action: str = "mcp operation") -> None:
    _require_tool_policy_allowed(
        "mcpServers",
        name,
        action=action,
        capability="mcp.manage",
        legacy_surface="mcp",
    )


def require_model_allowed(model: str, action: str = "model selection") -> None:
    if not is_enterprise_managed():
        return
    model_id = resolve_model_selection(str(model or "").strip())["model"]
    if not model_id:
        return
    allowed = allowed_models()
    if model_id not in allowed:
        raise EnterprisePolicyDenied(
            denial_message(action, f"model '{model_id}' is not in allowedModels")
        )


def require_surface_allowed(
    surface: str,
    *,
    action: Optional[str] = None,
    capability: Optional[str] = None,
) -> None:
    if not is_enterprise_managed():
        return
    surface_norm = _normalize_surface(surface)
    action_label = action or surface_norm
    if is_surface_locked(surface_norm):
        raise EnterprisePolicyDenied(
            denial_message(action_label, f"surface '{surface_norm}' is locked")
        )
    cap = capability or f"{surface_norm.split('.', 1)[0]}.manage"
    decision = _capability_value(cap)
    if decision is False:
        raise EnterprisePolicyDenied(
            denial_message(action_label, f"capability '{cap}' is disabled")
        )
    if decision is True:
        return
    if cap in _DEFAULT_DENY_CAPABILITIES:
        raise EnterprisePolicyDenied(
            denial_message(action_label, f"capability '{cap}' is not granted")
        )


def is_provider_env_key(key: str, metadata: Optional[Mapping[str, Any]] = None) -> bool:
    normalized = str(key or "").strip().upper()
    if not normalized:
        return False
    if metadata and str(metadata.get("category") or "").lower() == "provider":
        return True
    provider_suffixes = (
        "_API_KEY",
        "_TOKEN",
        "_BASE_URL",
        "_CLIENT_ID",
        "_CLIENT_SECRET",
        "_PROJECT_ID",
    )
    provider_prefixes = ("OPENAI_", "OPENROUTER_", "ANTHROPIC_", "HERMES_QWEN_")
    return normalized.startswith(provider_prefixes) or normalized.endswith(provider_suffixes)


def require_env_write_allowed(key: str, metadata: Optional[Mapping[str, Any]] = None) -> None:
    if not is_enterprise_managed():
        return
    if is_provider_env_key(key, metadata):
        raise EnterprisePolicyDenied(
            denial_message(
                f"env write for {key}",
                "provider credentials and custom endpoints are controlled by enterprise policy",
            )
        )


def _selected_config_values(config: Mapping[str, Any]) -> dict[str, Any]:
    return {key: config.get(key) for key in _MODEL_CONFIG_KEYS if key in config}


def model_config_changed(current: Mapping[str, Any], proposed: Mapping[str, Any]) -> bool:
    return _selected_config_values(current) != _selected_config_values(proposed)


def require_model_config_write_allowed(
    current: Mapping[str, Any],
    proposed: Mapping[str, Any],
    *,
    action: str,
) -> None:
    if not is_enterprise_managed():
        return
    if model_config_changed(current, proposed):
        raise EnterprisePolicyDenied(
            denial_message(
                action,
                "model, provider, custom provider, fallback, auxiliary, and delegation config are enterprise-controlled",
            )
        )


def require_runtime_provider_allowed(requested_provider: str) -> None:
    if not is_enterprise_managed():
        return
    provider = str(requested_provider or "").strip().lower()
    if provider in {ENTERPRISE_PROVIDER, f"custom:{ENTERPRISE_PROVIDER}"}:
        return
    raise EnterprisePolicyDenied(
        denial_message(
            "runtime provider resolution",
            f"provider '{provider or 'auto'}' is not the enterprise gateway provider",
        )
    )
