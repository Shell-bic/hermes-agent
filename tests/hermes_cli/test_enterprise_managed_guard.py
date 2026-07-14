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


@pytest.fixture
def managed_tool_policy(tmp_path, monkeypatch):
    policy_path = tmp_path / "enterprise-tool-policy.json"
    policy_path.write_text(
        json.dumps(
            {
                "allowedModels": ["allowed/model"],
                "currentModel": "allowed/model",
                "defaultModel": "allowed/model",
                "toolPolicySnapshot": {
                    "policyVersion": "u2-test",
                    "policyHash": "hash-u2-test",
                    "generatedAt": "2026-07-06T00:00:00Z",
                    "skills": [
                        {"key": "enterprise-skill", "status": "recommended"},
                        {"key": "restricted-skill", "status": "restricted"},
                        {"key": "blocked-skill", "status": "blocked"},
                    ],
                    "toolSets": [
                        {"key": "web", "status": "recommended"},
                        {"key": "tts", "status": "restricted"},
                        {"key": "x_search", "status": "blocked"},
                    ],
                    "tools": [
                        {"key": "web_search", "status": "blocked"},
                    ],
                    "mcpServers": [
                        {"key": "allowed-mcp", "status": "available"},
                        {"key": "restricted-mcp", "status": "restricted"},
                        {"key": "blocked-mcp", "status": "blocked"},
                    ],
                    "capabilityFlags": {
                        "skills.manage": True,
                        "toolsets.manage": True,
                        "mcp.manage": True,
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    return policy_path


@pytest.fixture
def managed_tool_policy_gateway_capability_entries(tmp_path, monkeypatch):
    policy_path = tmp_path / "enterprise-tool-policy-capability-entries.json"
    policy_path.write_text(
        json.dumps(
            {
                "allowedModels": ["allowed/model"],
                "currentModel": "allowed/model",
                "defaultModel": "allowed/model",
                "toolPolicySnapshot": {
                    "policyVersion": "u2-test",
                    "skills": [
                        {"key": "enterprise-skill", "status": "recommended"},
                    ],
                    "toolSets": [
                        {"key": "web", "status": "recommended"},
                    ],
                    "mcpServers": [
                        {"key": "allowed-mcp", "status": "available"},
                    ],
                    "capabilityFlags": [
                        {
                            "key": "capability.env.secret-access",
                            "status": "blocked",
                        }
                    ],
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    return policy_path


@pytest.fixture
def managed_gateway_runtime_policy(tmp_path, monkeypatch):
    """Match the policy shape written from a real Gateway runtime manifest."""

    policy_path = tmp_path / "enterprise-gateway-runtime-policy.json"
    policy_path.write_text(
        json.dumps(
            {
                "allowedModels": ["allowed/model"],
                "capabilities": {
                    "reasoning": True,
                    "tools": True,
                    "contextWindowTokens": 131072,
                },
                "currentModel": "allowed/model",
                "defaultModel": "allowed/model",
                "role": [
                    {
                        "name": "default-employee",
                        "capabilities": [
                            "chat.completions",
                            "messages",
                            "skills.manage",
                        ],
                    }
                ],
                "toolPolicySnapshot": {
                    "policyVersion": "tool-policy.v1+roles:v2",
                    "skills": [
                        {"key": "expense-review", "status": "available"},
                    ],
                    "capabilityFlags": [
                        {"key": "capability.file.write", "status": "available"},
                        {"key": "capability.terminal.shell", "status": "blocked"},
                    ],
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    return policy_path


@pytest.fixture
def managed_tool_policy_blocked_skill_capability(tmp_path, monkeypatch):
    policy_path = tmp_path / "enterprise-tool-policy-blocked-skill-capability.json"
    policy_path.write_text(
        json.dumps(
            {
                "allowedModels": ["allowed/model"],
                "currentModel": "allowed/model",
                "defaultModel": "allowed/model",
                "toolPolicySnapshot": {
                    "policyVersion": "u2-test",
                    "skills": [
                        {"key": "enterprise-skill", "status": "recommended"},
                    ],
                    "capabilityFlags": [
                        {"key": "skills.manage", "status": "blocked"},
                    ],
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    return policy_path


@pytest.fixture
def managed_legacy_policy_with_policy_version(tmp_path, monkeypatch):
    policy_path = tmp_path / "enterprise-legacy-policy-version.json"
    policy_path.write_text(
        json.dumps(
            {
                "allowedModels": ["allowed/model"],
                "capabilities": {"skills.manage": False},
                "currentModel": "allowed/model",
                "defaultModel": "allowed/model",
                "lockedSurfaces": ["mcp"],
                "policyVersion": "legacy-policy-v1",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    return policy_path


def _detail(resp):
    return str(resp.json().get("detail", ""))


def test_tool_policy_parser_reads_snapshot_and_status(managed_tool_policy):
    from hermes_cli.enterprise_policy import (
        capability_enabled,
        is_mcp_allowed,
        is_skill_allowed,
        is_tool_allowed,
        is_toolset_allowed,
        tool_policy_snapshot,
    )

    snapshot = tool_policy_snapshot()
    assert snapshot["policyVersion"] == "u2-test"
    assert capability_enabled("skills.manage") is True
    assert is_skill_allowed("enterprise-skill") is True
    assert is_skill_allowed("restricted-skill") is False
    assert is_toolset_allowed("tts") is False
    assert is_tool_allowed("web_search") is False
    assert is_mcp_allowed("allowed-mcp") is True
    assert is_mcp_allowed("blocked-mcp") is False


def test_gateway_capability_entries_default_unlisted_capabilities_to_allowed(
    client, managed_tool_policy_gateway_capability_entries, monkeypatch
):
    from hermes_cli.enterprise_policy import capability_enabled
    import tools.skills_tool as skills_tool

    monkeypatch.setattr(
        skills_tool,
        "_find_all_skills",
        lambda *, skip_disabled=False: [
            {"name": "local-user-skill", "description": "local", "category": "demo"}
        ],
    )

    assert capability_enabled("capability.env.secret-access") is False
    assert capability_enabled("skills.manage") is True
    assert capability_enabled("toolsets.manage") is True
    assert capability_enabled("mcp.manage") is True

    skill_resp = client.put(
        "/api/skills/toggle",
        json={"name": "local-user-skill", "enabled": False},
    )
    assert skill_resp.status_code == 200

    toolset_resp = client.put("/api/tools/toolsets/web", json={"enabled": True})
    assert toolset_resp.status_code == 200

    mcp_resp = client.post(
        "/api/mcp/servers",
        json={"name": "local-mcp", "url": "http://localhost:9999/sse"},
    )
    assert mcp_resp.status_code == 200


def test_gateway_runtime_role_capabilities_grant_coarse_skill_surface(
    managed_gateway_runtime_policy,
):
    from hermes_cli.enterprise_policy import require_surface_allowed

    require_surface_allowed("skills", capability="skills.manage")


def test_gateway_runtime_role_capabilities_are_union_across_roles(
    managed_gateway_runtime_policy,
):
    from hermes_cli.enterprise_policy import require_surface_allowed

    policy = json.loads(managed_gateway_runtime_policy.read_text(encoding="utf-8"))
    policy["role"] = [
        {"name": "reader", "capabilities": ["messages"]},
        {"name": "skill-manager", "capabilities": ["skills.manage"]},
    ]
    managed_gateway_runtime_policy.write_text(json.dumps(policy), encoding="utf-8")

    require_surface_allowed("skills", capability="skills.manage")


def test_gateway_runtime_role_capabilities_deny_ungranted_coarse_skill_surface(
    managed_gateway_runtime_policy,
):
    from hermes_cli.enterprise_policy import EnterprisePolicyDenied, require_surface_allowed

    policy = json.loads(managed_gateway_runtime_policy.read_text(encoding="utf-8"))
    policy["role"][0]["capabilities"] = ["chat.completions", "messages"]
    managed_gateway_runtime_policy.write_text(json.dumps(policy), encoding="utf-8")

    with pytest.raises(EnterprisePolicyDenied, match="capability 'skills.manage' is disabled"):
        require_surface_allowed("skills", capability="skills.manage")


def test_legacy_top_level_capability_explicit_value_precedes_runtime_roles(
    managed_gateway_runtime_policy,
):
    from hermes_cli.enterprise_policy import EnterprisePolicyDenied, require_surface_allowed

    policy = json.loads(managed_gateway_runtime_policy.read_text(encoding="utf-8"))
    policy["capabilities"]["skills.manage"] = False
    managed_gateway_runtime_policy.write_text(json.dumps(policy), encoding="utf-8")

    with pytest.raises(EnterprisePolicyDenied, match="capability 'skills.manage' is disabled"):
        require_surface_allowed("skills", capability="skills.manage")


def test_gateway_capability_entries_block_listed_skill_manage(
    client, managed_tool_policy_blocked_skill_capability
):
    from hermes_cli.enterprise_policy import capability_enabled

    assert capability_enabled("skills.manage") is False

    resp = client.put(
        "/api/skills/toggle",
        json={"name": "local-user-skill", "enabled": False},
    )

    assert resp.status_code == 403
    assert "capability 'skills.manage' is disabled" in _detail(resp)


def test_policy_version_alone_does_not_create_tool_policy_snapshot(
    managed_legacy_policy_with_policy_version,
):
    from hermes_cli.enterprise_policy import tool_policy_snapshot

    assert tool_policy_snapshot() == {}


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


def test_legacy_policy_with_policy_version_still_rejects_locked_mcp_surface(
    client, managed_legacy_policy_with_policy_version
):
    resp = client.post(
        "/api/mcp/servers",
        json={"name": "local-mcp", "url": "http://localhost:9999/sse"},
    )

    assert resp.status_code == 403
    assert "surface 'mcp' is locked" in _detail(resp)


def test_legacy_policy_with_policy_version_still_rejects_disabled_skill_capability(
    client, managed_legacy_policy_with_policy_version
):
    resp = client.put(
        "/api/skills/toggle",
        json={"name": "local-user-skill", "enabled": False},
    )

    assert resp.status_code == 403
    assert "capability 'skills.manage' is disabled" in _detail(resp)


def test_managed_skills_list_marks_policy_status(client, managed_tool_policy, monkeypatch):
    import tools.skills_tool as skills_tool

    def _fake_find_all_skills(*, skip_disabled=False):
        return [
            {"name": "enterprise-skill", "description": "enterprise"},
            {"name": "restricted-skill", "description": "restricted"},
            {"name": "local-user-skill", "description": "local"},
        ]

    monkeypatch.setattr(skills_tool, "_find_all_skills", _fake_find_all_skills)

    resp = client.get("/api/skills")

    assert resp.status_code == 200
    skills = {item["name"]: item for item in resp.json()}
    assert skills["enterprise-skill"]["policyStatus"] == "recommended"
    assert skills["restricted-skill"]["policyStatus"] == "restricted"
    assert skills["local-user-skill"]["policyStatus"] == "userCreated"


@pytest.mark.parametrize("skill_name", ["restricted-skill", "blocked-skill"])
def test_managed_restricted_or_blocked_skill_toggle_rejected(
    client, managed_tool_policy, skill_name
):
    resp = client.put(
        "/api/skills/toggle",
        json={"name": skill_name, "enabled": False},
    )

    assert resp.status_code == 403
    assert "Enterprise managed policy denied /api/skills/toggle" in _detail(resp)
    assert skill_name in _detail(resp)


def test_managed_user_created_skill_toggle_is_not_default_denied(
    client, managed_tool_policy, monkeypatch
):
    import tools.skills_tool as skills_tool

    monkeypatch.setattr(
        skills_tool,
        "_find_all_skills",
        lambda *, skip_disabled=False: [
            {"name": "local-user-skill", "description": "local", "category": "demo"}
        ],
    )

    resp = client.put(
        "/api/skills/toggle",
        json={"name": "local-user-skill", "enabled": False},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "ok": True,
        "name": "local-user-skill",
        "enabled": False,
    }


def test_managed_toolsets_list_marks_policy_status(client, managed_tool_policy):
    resp = client.get("/api/tools/toolsets")

    assert resp.status_code == 200
    toolsets = {item["name"]: item for item in resp.json()}
    assert toolsets["web"]["policyStatus"] == "recommended"
    assert toolsets["tts"]["policyStatus"] == "restricted"
    assert toolsets["x_search"]["policyStatus"] == "blocked"


def test_managed_blocked_toolset_toggle_rejected(client, managed_tool_policy):
    resp = client.put("/api/tools/toolsets/x_search", json={"enabled": True})

    assert resp.status_code == 403
    assert "Enterprise managed policy denied /api/tools/toolsets" in _detail(resp)
    assert "x_search" in _detail(resp)


def test_managed_restricted_toolset_config_does_not_leak_provider_key_status(
    client, managed_tool_policy, monkeypatch
):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "secret-elevenlabs-key")

    resp = client.get("/api/tools/toolsets/tts/config")

    assert resp.status_code == 403
    body = json.dumps(resp.json())
    assert "ELEVENLABS_API_KEY" not in body
    assert "secret-elevenlabs-key" not in body
    assert "is_set" not in body
    assert "ElevenLabs" not in body


@pytest.mark.parametrize(
    "server_name,status",
    [("restricted-mcp", "restricted"), ("blocked-mcp", "blocked")],
)
def test_managed_restricted_or_blocked_mcp_probe_rejected(
    client, managed_tool_policy, server_name, status
):
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    (home / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "mcp_servers": {
                    server_name: {"url": "http://localhost:9999/sse"},
                }
            }
        ),
        encoding="utf-8",
    )

    resp = client.post(f"/api/mcp/servers/{server_name}/test")

    assert resp.status_code == 403
    assert f"mcpServers '{server_name}' is {status}" in _detail(resp)


def test_managed_blocked_mcp_catalog_install_rejected_before_env_write(
    client, managed_tool_policy
):
    from hermes_constants import get_hermes_home

    resp = client.post(
        "/api/mcp/catalog/install",
        json={
            "name": "blocked-mcp",
            "env": {"BLOCKED_MCP_TOKEN": "should-not-be-written"},
        },
    )

    assert resp.status_code == 403
    env_path = get_hermes_home() / ".env"
    assert not env_path.exists() or "should-not-be-written" not in env_path.read_text(
        encoding="utf-8"
    )


def test_managed_restricted_mcp_enabled_toggle_rejected(
    client, managed_tool_policy
):
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    (home / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "mcp_servers": {
                    "restricted-mcp": {"url": "http://localhost:9999/sse"},
                }
            }
        ),
        encoding="utf-8",
    )

    resp = client.put(
        "/api/mcp/servers/restricted-mcp/enabled",
        json={"enabled": False},
    )

    assert resp.status_code == 403
    assert "restricted-mcp" in _detail(resp)


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


def test_enterprise_profile_token_resolves_runtime_profile_identity(
    managed_policy, monkeypatch, _isolate_hermes_home
):
    from hermes_cli.config import get_hermes_home
    from hermes_cli.enterprise_policy import require_model_allowed
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

    require_model_allowed("enterprise-profile:profile-allowed")
    runtime = resolve_runtime_provider(
        requested="company-gateway",
        target_model="enterprise-profile:profile-allowed",
    )

    assert runtime["provider"] == "company-gateway"
    assert runtime["request_overrides"] == {
        "extra_body": {"modelProfileId": "profile-allowed"}
    }
