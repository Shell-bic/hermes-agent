"""Enterprise managed-mode policy helpers.

These helpers are intentionally independent from ``config.is_managed()``.
That flag describes package-manager ownership of an install, while
``HERMES_ENTERPRISE_MANAGED`` describes an enterprise runtime policy boundary.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping, Optional


ENTERPRISE_MANAGED_ENV = "HERMES_ENTERPRISE_MANAGED"
ENTERPRISE_POLICY_FILE_ENV = "HERMES_ENTERPRISE_TOOL_POLICY_FILE"
ENTERPRISE_POLICY_JSON_ENV = "HERMES_ENTERPRISE_TOOL_POLICY_JSON"
ENTERPRISE_PROVIDER = "company-gateway"
ENTERPRISE_GATEWAY_TOKEN_ENV = "COMPANY_GATEWAY_TOKEN"

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
        if current and current in {_profile_model(profile), _text(profile.get("id"))}:
            return profile
    return {}


def capabilities(policy: Optional[Mapping[str, Any]] = None, model: str = "") -> dict[str, Any]:
    policy = policy or load_enterprise_policy()
    raw_top = _policy_value(policy, "capabilities")
    result = dict(scrub_secret_fields(raw_top)) if isinstance(raw_top, dict) else {}
    model_id = _text(model) or current_model(policy)
    for profile in model_profiles(policy):
        if model_id and model_id in {_profile_model(profile), _text(profile.get("id"))}:
            raw = profile.get("capabilities")
            if isinstance(raw, dict):
                result.update(dict(scrub_secret_fields(raw)))
            break
    return result


def runtime_defaults(policy: Optional[Mapping[str, Any]] = None, model: str = "") -> dict[str, Any]:
    policy = policy or load_enterprise_policy()
    raw = _policy_value(policy, "runtimeDefaults")
    result = dict(scrub_secret_fields(raw)) if isinstance(raw, dict) else {}
    model_id = _text(model) or current_model(policy)
    for profile in model_profiles(policy):
        if model_id and model_id in {_profile_model(profile), _text(profile.get("id"))}:
            profile_defaults = profile.get("runtimeDefaults")
            if isinstance(profile_defaults, dict):
                result.update(dict(scrub_secret_fields(profile_defaults)))
            break
    return result


def auxiliary_policy(policy: Optional[Mapping[str, Any]] = None, model: str = "") -> dict[str, Any]:
    policy = policy or load_enterprise_policy()
    raw = _policy_value(policy, "auxiliaryPolicy")
    result = dict(scrub_secret_fields(raw)) if isinstance(raw, dict) else {}
    model_id = _text(model) or current_model(policy)
    for profile in model_profiles(policy):
        if model_id and model_id in {_profile_model(profile), _text(profile.get("id"))}:
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
    for profile in model_profiles(policy):
        if model_id and model_id in {_profile_model(profile), _text(profile.get("id"))}:
            return _profile_name(profile, model_id)
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
    if not isinstance(caps, dict):
        return None
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
    return None


def denial_message(action: str, reason: str = "") -> str:
    detail = f"Enterprise managed policy denied {action}"
    if reason:
        detail += f": {reason}"
    return detail


def require_model_allowed(model: str, action: str = "model selection") -> None:
    if not is_enterprise_managed():
        return
    model_id = str(model or "").strip()
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
