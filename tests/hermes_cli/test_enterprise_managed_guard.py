import json

import pytest
import yaml


@pytest.fixture
def client(monkeypatch, _isolate_hermes_home):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    home = get_hermes_home()
    (home / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "model": {
                    "provider": "company-gateway",
                    "default": "allowed/model",
                },
                "providers": {
                    "company-gateway": {
                        "api": "https://gateway.example/v1",
                        "key_env": "COMPANY_GATEWAY_TOKEN",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", home / "state.db")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def managed_policy(tmp_path, monkeypatch):
    policy_path = tmp_path / "enterprise-policy.json"
    policy_path.write_text(
        json.dumps(
            {
                "allowedModels": ["allowed/model"],
                "auxiliaryPolicy": {"mode": "follow-main", "apiKey": "drop-me"},
                "capabilities": {"reasoning": True, "context_window": 131072},
                "currentModel": "allowed/model",
                "defaultModel": "allowed/model",
                "lockedSurfaces": ["mcp"],
                "modelProfiles": [
                    {
                        "id": "profile-allowed",
                        "apiFormat": "openai-chat",
                        "auxiliaryPolicy": {"mode": "follow-main"},
                        "capabilities": {
                            "reasoning": True,
                            "fast": False,
                            "max_output_tokens": 8192,
                        },
                        "displayName": "Allowed Enterprise Model",
                        "isDefault": True,
                        "model": "allowed/model",
                        "providerSecret": "drop-me",
                        "runtimeDefaults": {"reasoningEffort": "medium"},
                    },
                    {
                        "id": "profile-blocked",
                        "model": "blocked/model",
                        "displayName": "Blocked Enterprise Model",
                    },
                ],
                "runtimeDefaults": {"serviceTier": "auto"},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    return policy_path


def _detail(resp):
    return str(resp.json().get("detail", ""))


def test_unmanaged_env_write_is_not_blocked(client):
    resp = client.put("/api/env", json={"key": "OPENAI_API_KEY", "value": "sk-test"})
    assert resp.status_code == 200


def test_managed_env_provider_write_is_rejected(client, managed_policy):
    resp = client.put("/api/env", json={"key": "OPENAI_API_KEY", "value": "sk-test"})
    assert resp.status_code == 403
    assert "Enterprise managed policy denied" in _detail(resp)
    assert "provider credentials" in _detail(resp)


def test_managed_config_model_provider_change_is_rejected(client, managed_policy):
    resp = client.put(
        "/api/config",
        json={
            "config": {
                "model": {
                    "provider": "openrouter",
                    "default": "not/allowed",
                },
                "providers": {
                    "openrouter": {
                        "api": "https://openrouter.ai/api/v1",
                        "key_env": "OPENROUTER_API_KEY",
                    }
                },
            }
        },
    )
    assert resp.status_code == 403
    assert "Enterprise managed policy denied /api/config" in _detail(resp)


def test_managed_model_set_rejects_model_outside_allowlist(client, managed_policy):
    resp = client.post(
        "/api/model/set",
        json={
            "scope": "main",
            "provider": "company-gateway",
            "model": "blocked/model",
            "confirm_expensive_model": True,
        },
    )
    assert resp.status_code == 403
    assert "model 'blocked/model' is not in allowedModels" in _detail(resp)


def test_managed_model_options_only_returns_enterprise_provider(client, managed_policy):
    resp = client.get("/api/model/options")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["provider"] == "company-gateway"
    assert payload["providers"] == [
        {
            "authenticated": True,
            "capabilities": {
                "allowed/model": {
                    "fast": False,
                    "max_output_tokens": 8192,
                    "reasoning": True,
                }
            },
            "models": ["allowed/model"],
            "name": "Company Gateway",
            "slug": "company-gateway",
            "total_models": 1,
        }
    ]
    assert "blocked/model" not in json.dumps(payload)
    assert "openrouter" not in json.dumps(payload).lower()
    assert "claude" not in json.dumps(payload).lower()
    assert "copilot" not in json.dumps(payload).lower()
    assert "gemini" not in json.dumps(payload).lower()


def test_managed_model_info_uses_enterprise_policy(client, managed_policy):
    resp = client.get("/api/model/info")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["provider"] == "company-gateway"
    assert payload["model"] == "allowed/model"
    assert payload["default_model"] == "allowed/model"
    assert payload["display_name"] == "Allowed Enterprise Model"
    assert payload["runtimeDefaults"] == {
        "reasoningEffort": "medium",
        "serviceTier": "auto",
    }
    assert payload["auxiliaryPolicy"] == {"mode": "follow-main"}
    assert "drop-me" not in json.dumps(payload)


def test_managed_recommended_default_uses_enterprise_default(client, managed_policy):
    resp = client.get("/api/model/recommended-default?provider=openrouter")
    assert resp.status_code == 200
    assert resp.json() == {
        "provider": "company-gateway",
        "model": "allowed/model",
        "free_tier": None,
        "managed": True,
    }


def test_managed_auxiliary_returns_enterprise_policy(client, managed_policy):
    resp = client.get("/api/model/auxiliary")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["main"] == {"provider": "company-gateway", "model": "allowed/model"}
    assert payload["auxiliaryPolicy"] == {"mode": "follow-main"}
    assert "drop-me" not in json.dumps(payload)


def test_managed_model_set_rejects_provider_override(client, managed_policy):
    resp = client.post(
        "/api/model/set",
        json={
            "scope": "main",
            "provider": "openrouter",
            "model": "allowed/model",
            "confirm_expensive_model": True,
        },
    )
    assert resp.status_code == 403
    assert "provider is controlled by enterprise policy" in _detail(resp)


def test_managed_model_set_rejects_custom_endpoint_override(client, managed_policy):
    resp = client.post(
        "/api/model/set",
        json={
            "scope": "main",
            "provider": "company-gateway",
            "model": "allowed/model",
            "base_url": "https://evil.example/v1",
            "api_key": "sk-evil",
            "confirm_expensive_model": True,
        },
    )
    assert resp.status_code == 403
    assert "custom endpoints and API keys" in _detail(resp)


def test_managed_model_set_rejects_auxiliary_override(client, managed_policy):
    resp = client.post(
        "/api/model/set",
        json={
            "scope": "auxiliary",
            "provider": "company-gateway",
            "model": "allowed/model",
            "task": "vision",
            "confirm_expensive_model": True,
        },
    )
    assert resp.status_code == 403
    assert "auxiliary models are controlled" in _detail(resp)


def test_managed_model_set_allows_policy_model(client, managed_policy):
    resp = client.post(
        "/api/model/set",
        json={
            "scope": "main",
            "provider": "company-gateway",
            "model": "allowed/model",
            "confirm_expensive_model": True,
        },
    )
    assert resp.status_code == 200
    assert resp.json()["provider"] == "company-gateway"


def test_managed_mcp_manage_is_rejected_by_locked_surface(client, managed_policy):
    resp = client.post(
        "/api/mcp/servers",
        json={"name": "local-mcp", "url": "http://localhost:9999/sse"},
    )
    assert resp.status_code == 403
    assert "surface 'mcp' is locked" in _detail(resp)


def test_runtime_provider_rejects_non_gateway_provider_in_managed_mode(
    managed_policy, _isolate_hermes_home
):
    from hermes_cli.auth import AuthError
    from hermes_cli.runtime_provider import resolve_runtime_provider

    with pytest.raises(AuthError) as exc:
        resolve_runtime_provider(requested="openrouter")
    assert "Enterprise managed policy denied runtime provider resolution" in str(exc.value)


def test_runtime_provider_resolves_company_gateway_in_managed_mode(
    managed_policy, monkeypatch, _isolate_hermes_home
):
    from hermes_cli.config import get_hermes_home
    from hermes_cli.runtime_provider import resolve_runtime_provider

    home = get_hermes_home()
    (home / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "model": {"provider": "company-gateway", "default": "allowed/model"},
                "providers": {
                    "company-gateway": {
                        "base_url": "https://gateway.example/v1",
                        "key_env": "COMPANY_GATEWAY_TOKEN",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("COMPANY_GATEWAY_TOKEN", "gateway-token")

    runtime = resolve_runtime_provider(requested="company-gateway")
    assert runtime["provider"] == "company-gateway"
    assert runtime["api_mode"] == "chat_completions"
    assert runtime["base_url"] == "https://gateway.example/v1"
    assert runtime["api_key"] == "gateway-token"
