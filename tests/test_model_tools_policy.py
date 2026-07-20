from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

import model_tools


def _schema(name: str) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": f"{name} test schema",
            "parameters": {"type": "object", "properties": {}},
        },
    }


def _install_policy(monkeypatch, snapshot: dict | None, *, extra: dict | None = None) -> None:
    policy = dict(extra or {})
    if snapshot is not None:
        policy["toolPolicySnapshot"] = snapshot
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_JSON", json.dumps(policy))
    monkeypatch.delenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", raising=False)
    model_tools._clear_tool_defs_cache()


def _install_registry(monkeypatch, entries: dict[str, str]) -> None:
    definitions = [_schema(name) for name in entries]
    entry_map = {
        name: SimpleNamespace(
            name=name,
            toolset=toolset,
            schema=_schema(name)["function"],
        )
        for name, toolset in entries.items()
    }
    monkeypatch.setattr(
        model_tools.registry,
        "get_definitions",
        lambda tool_names, quiet=False: list(definitions),
    )
    monkeypatch.setattr(
        model_tools.registry,
        "get_entry",
        lambda name: entry_map.get(name),
    )


def _tool_names() -> set[str]:
    tools = model_tools.get_tool_definitions(
        enabled_toolsets=[],
        quiet_mode=True,
        skip_tool_search_assembly=True,
    )
    return {tool["function"]["name"] for tool in tools}


@pytest.fixture(autouse=True)
def _clear_tool_cache():
    model_tools._clear_tool_defs_cache()
    yield
    model_tools._clear_tool_defs_cache()


def test_blocked_web_search_terminal_and_write_file_do_not_enter_schema(monkeypatch):
    _install_registry(
        monkeypatch,
        {
            "web_search": "web",
            "terminal": "terminal",
            "write_file": "file",
            "read_file": "file",
        },
    )
    _install_policy(
        monkeypatch,
        {
            "policyHash": "hash-blocked",
            "tools": [
                {"key": "web_search", "status": "blocked"},
                {"key": "write_file", "status": "restricted"},
            ],
            "toolSets": [
                {"key": "terminal", "status": "blocked"},
            ],
        },
    )

    names = _tool_names()

    assert "web_search" not in names
    assert "terminal" not in names
    assert "write_file" not in names
    assert "read_file" in names


@pytest.mark.parametrize(
    "status",
    ["defaultEnabled", "recommended", "available", "userCreated", "teamShared"],
)
def test_allowed_statuses_keep_high_risk_tools_visible(monkeypatch, status):
    _install_registry(monkeypatch, {"terminal": "terminal"})
    _install_policy(
        monkeypatch,
        {
            "policyHash": f"hash-{status}",
            "tools": [{"key": "terminal", "status": status}],
            "capabilityFlags": {"capability.terminal.shell": True},
        },
    )

    assert "terminal" in _tool_names()


def test_unlisted_high_risk_tools_hide_but_unknown_plugin_tools_remain(monkeypatch):
    _install_registry(
        monkeypatch,
        {
            "terminal": "terminal",
            "process": "terminal",
            "execute_code": "code_execution",
            "write_file": "file",
            "patch": "file",
            "browser_click": "browser",
            "computer_use": "computer_use",
            "skill_manage": "skills",
            "mcp_demo_search": "mcp-demo",
            "local_plugin_lookup": "plugin_local",
            "custom_user_tool": "user_custom",
        },
    )
    _install_policy(monkeypatch, {"policyHash": "hash-default-allow"})

    names = _tool_names()

    assert "terminal" not in names
    assert "process" not in names
    assert "execute_code" not in names
    assert "write_file" not in names
    assert "patch" not in names
    assert "browser_click" not in names
    assert "computer_use" not in names
    assert "skill_manage" not in names
    assert "mcp_demo_search" not in names
    assert "local_plugin_lookup" in names
    assert "custom_user_tool" in names


def test_terminal_exec_gateway_alias_allows_terminal_family(monkeypatch):
    _install_registry(
        monkeypatch,
        {
            "terminal": "terminal",
            "process": "terminal",
        },
    )
    _install_policy(
        monkeypatch,
        {
            "policyHash": "hash-terminal-alias",
            "tools": [{"key": "tool.terminal.exec", "status": "defaultEnabled"}],
            "capabilityFlags": {"capability.terminal.shell": True},
        },
    )

    names = _tool_names()

    assert "terminal" in names
    assert "process" in names


def test_catalog_prefixed_toolset_keys_match_runtime_toolset_names(monkeypatch):
    _install_registry(monkeypatch, {"browser_click": "browser"})
    _install_policy(
        monkeypatch,
        {
            "policyHash": "hash-prefixed-toolset",
            "toolSets": [{"key": "toolset.browser", "status": "available"}],
            "capabilityFlags": {"capability.browser.automation": True},
        },
    )

    assert "browser_click" in _tool_names()


def test_file_read_alias_allow_overrides_broad_file_toolset_restricted(monkeypatch):
    _install_registry(
        monkeypatch,
        {
            "read_file": "file",
            "search_files": "file",
            "write_file": "file",
            "patch": "file",
        },
    )
    _install_policy(
        monkeypatch,
        {
            "policyHash": "hash-file-alias",
            "tools": [
                {"key": "tool.file.read", "status": "defaultEnabled"},
                {"key": "tool.file.write", "status": "blocked"},
            ],
            "toolSets": [{"key": "toolset.file", "status": "restricted"}],
        },
    )

    names = _tool_names()

    assert "read_file" in names
    assert "search_files" in names
    assert "write_file" not in names
    assert "patch" not in names


def test_mcp_server_matches_toolset_without_mcp_prefix(monkeypatch):
    _install_registry(monkeypatch, {"mcp_allowed_search": "mcp-allowed"})
    _install_policy(
        monkeypatch,
        {
            "policyHash": "hash-mcp-allowed",
            "mcpServers": [{"key": "allowed", "status": "available"}],
            "capabilityFlags": {"capability.mcp.install": True},
        },
        extra={"role": [{"name": "mcp-admin", "capabilities": ["mcp.manage"]}]},
    )

    assert "mcp_allowed_search" in _tool_names()


def test_mcp_server_matches_mcp_dot_server_alias_for_restriction(monkeypatch):
    _install_registry(monkeypatch, {"mcp_filesystem_read": "mcp-filesystem"})
    _install_policy(
        monkeypatch,
        {
            "policyHash": "hash-mcp-restricted",
            "mcpServers": [{"key": "mcp.filesystem", "status": "restricted"}],
        },
    )

    assert "mcp_filesystem_read" not in _tool_names()


@pytest.mark.parametrize(
    ("tool_name", "toolset", "capability"),
    [
        ("terminal", "terminal", "capability.terminal.shell"),
        ("write_file", "file", "capability.file.write"),
        ("browser_click", "browser", "capability.browser.automation"),
        ("mcp_filesystem_read", "mcp-filesystem", "capability.mcp.install"),
    ],
)
def test_capability_flags_hide_runtime_tools(monkeypatch, tool_name, toolset, capability):
    _install_registry(monkeypatch, {tool_name: toolset})
    snapshot = {
        "policyHash": f"hash-{capability}",
        "capabilityFlags": {capability: False},
    }
    if toolset.startswith("mcp-"):
        snapshot["mcpServers"] = [{"key": toolset[4:], "status": "available"}]
    else:
        snapshot["tools"] = [{"key": tool_name, "status": "available"}]
    extra = None
    if toolset.startswith("mcp-"):
        extra = {"role": [{"name": "mcp-admin", "capabilities": ["mcp.manage"]}]}
    _install_policy(monkeypatch, snapshot, extra=extra)

    assert tool_name not in _tool_names()


def test_managed_high_risk_tool_without_tool_policy_snapshot_fails_closed(monkeypatch):
    _install_registry(monkeypatch, {"terminal": "terminal"})
    _install_policy(
        monkeypatch,
        snapshot=None,
        extra={"policyVersion": "legacy-u2", "lockedSurfaces": ["mcp"]},
    )

    assert "terminal" not in _tool_names()


@pytest.mark.parametrize(
    ("role_granted", "tool_flag_enabled", "expected_allowed"),
    [
        (True, True, True),
        (True, False, False),
        (False, True, False),
        (False, False, False),
    ],
)
def test_mcp_role_and_tool_policy_quadrants_keep_schema_and_execution_in_sync(
    monkeypatch,
    role_granted,
    tool_flag_enabled,
    expected_allowed,
):
    tool_name = "mcp_filesystem_read"
    _install_registry(monkeypatch, {tool_name: "mcp-filesystem"})
    _install_policy(
        monkeypatch,
        {
            "policyHash": f"quadrant-{int(role_granted)}-{int(tool_flag_enabled)}",
            "mcpServers": [{"key": "filesystem", "status": "available"}],
            "capabilityFlags": {
                "capability.mcp.install": tool_flag_enabled,
            },
        },
        extra={
            "role": [
                {
                    "name": "mcp-admin",
                    "capabilities": ["mcp.manage"] if role_granted else [],
                }
            ]
        },
    )
    monkeypatch.setattr(
        model_tools.registry,
        "dispatch",
        lambda *args, **kwargs: json.dumps({"ok": True, "tool": tool_name}),
    )

    schema_allowed = tool_name in _tool_names()
    payload = json.loads(model_tools.handle_function_call(tool_name, {"path": "demo"}))
    execution_allowed = payload.get("ok") is True

    assert schema_allowed is expected_allowed
    assert execution_allowed is expected_allowed
    if not expected_allowed:
        assert payload["code"] == "enterprise_tool_policy_denied"


@pytest.mark.parametrize(
    ("role_granted", "tool_policy_allowed", "expected_allowed"),
    [
        (True, True, True),
        (True, False, False),
        (False, True, False),
        (False, False, False),
    ],
)
@pytest.mark.parametrize(
    ("policy_collection", "policy_key"),
    [
        ("tools", "skill_manage"),
        ("toolSets", "skills"),
    ],
)
def test_skill_manage_role_and_tool_policy_quadrants_keep_schema_and_execution_in_sync(
    monkeypatch,
    role_granted,
    tool_policy_allowed,
    expected_allowed,
    policy_collection,
    policy_key,
):
    tool_name = "skill_manage"
    _install_registry(monkeypatch, {tool_name: "skills"})
    _install_policy(
        monkeypatch,
        {
            "policyHash": (
                f"skill-quadrant-{int(role_granted)}-{int(tool_policy_allowed)}"
            ),
            policy_collection: [
                {
                    "key": policy_key,
                    "status": "available" if tool_policy_allowed else "blocked",
                }
            ],
        },
        extra={
            "role": [
                {
                    "name": "skill-admin",
                    "capabilities": ["skills.manage"] if role_granted else [],
                }
            ]
        },
    )
    monkeypatch.setattr(
        model_tools.registry,
        "dispatch",
        lambda *args, **kwargs: json.dumps({"ok": True, "tool": tool_name}),
    )

    schema_allowed = tool_name in _tool_names()
    payload = json.loads(model_tools.handle_function_call(tool_name, {"action": "list"}))
    execution_allowed = payload.get("ok") is True

    assert schema_allowed is expected_allowed
    assert execution_allowed is expected_allowed
    if not expected_allowed:
        assert payload["code"] == "enterprise_tool_policy_denied"


def test_unmanaged_tool_schema_and_direct_execution_are_unchanged(monkeypatch):
    _install_registry(monkeypatch, {"terminal": "terminal"})
    monkeypatch.delenv("HERMES_ENTERPRISE_MANAGED", raising=False)
    monkeypatch.delenv("HERMES_ENTERPRISE_TOOL_POLICY_JSON", raising=False)
    monkeypatch.delenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", raising=False)
    model_tools._clear_tool_defs_cache()
    monkeypatch.setattr(
        model_tools.registry,
        "dispatch",
        lambda *args, **kwargs: json.dumps({"ok": True}),
    )

    assert "terminal" in _tool_names()
    assert json.loads(
        model_tools.handle_function_call("terminal", {"command": "noop"})
    ) == {"ok": True}


def test_role_capability_namespace_cannot_supply_tool_policy_flag(monkeypatch):
    _install_registry(monkeypatch, {"terminal": "terminal"})
    _install_policy(
        monkeypatch,
        {
            "policyHash": "role-capability-does-not-cross",
            "tools": [{"key": "terminal", "status": "available"}],
            "capabilityFlags": {},
        },
        extra={
            "role": [
                {
                    "name": "misconfigured-role",
                    "capabilities": ["capability.terminal.shell"],
                }
            ]
        },
    )
    monkeypatch.setattr(
        model_tools.registry,
        "dispatch",
        lambda *args, **kwargs: pytest.fail("role capability must not dispatch terminal"),
    )

    assert "terminal" not in _tool_names()
    payload = json.loads(model_tools.handle_function_call("terminal", {"command": "noop"}))
    assert payload["code"] == "enterprise_tool_policy_denied"
    assert payload["reason"] == "enterprise_capability_disabled"


def test_quiet_cache_invalidates_when_policy_hash_changes(monkeypatch):
    calls = {"count": 0}

    def fake_compute(*args, **kwargs):
        calls["count"] += 1
        return [_schema(f"tool_{calls['count']}")]

    monkeypatch.setattr(model_tools, "_compute_tool_definitions", fake_compute)
    _install_policy(monkeypatch, {"policyHash": "hash-one"})

    assert model_tools.get_tool_definitions(quiet_mode=True)[0]["function"]["name"] == "tool_1"
    assert model_tools.get_tool_definitions(quiet_mode=True)[0]["function"]["name"] == "tool_1"

    _install_policy(monkeypatch, {"policyHash": "hash-two"})

    assert model_tools.get_tool_definitions(quiet_mode=True)[0]["function"]["name"] == "tool_2"
    assert calls["count"] == 2


def test_quiet_cache_invalidates_when_policy_json_content_changes(monkeypatch):
    calls = {"count": 0}

    def fake_compute(*args, **kwargs):
        calls["count"] += 1
        return [_schema(f"tool_{calls['count']}")]

    monkeypatch.setattr(model_tools, "_compute_tool_definitions", fake_compute)
    _install_policy(monkeypatch, {"policyHash": "same", "generatedAt": "one"})
    model_tools.get_tool_definitions(quiet_mode=True)

    _install_policy(monkeypatch, {"policyHash": "same", "generatedAt": "two"})

    assert model_tools.get_tool_definitions(quiet_mode=True)[0]["function"]["name"] == "tool_2"
    assert calls["count"] == 2


def test_quiet_cache_invalidates_when_policy_file_changes(tmp_path, monkeypatch):
    calls = {"count": 0}
    policy_path = tmp_path / "enterprise-policy.json"

    def fake_compute(*args, **kwargs):
        calls["count"] += 1
        return [_schema(f"tool_{calls['count']}")]

    monkeypatch.setattr(model_tools, "_compute_tool_definitions", fake_compute)
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.delenv("HERMES_ENTERPRISE_TOOL_POLICY_JSON", raising=False)
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))

    policy_path.write_text(
        json.dumps({"toolPolicySnapshot": {"policyHash": "same"}}),
        encoding="utf-8",
    )
    model_tools._clear_tool_defs_cache()
    model_tools.get_tool_definitions(quiet_mode=True)

    policy_path.write_text(
        json.dumps({"toolPolicySnapshot": {"policyHash": "same"}, "padding": "changed"}),
        encoding="utf-8",
    )

    assert model_tools.get_tool_definitions(quiet_mode=True)[0]["function"]["name"] == "tool_2"
    assert calls["count"] == 2


def test_stale_direct_high_risk_tool_call_returns_policy_error(monkeypatch):
    _install_policy(monkeypatch, {"policyHash": "hash-stale"})
    monkeypatch.setattr(
        model_tools.registry,
        "dispatch",
        lambda *args, **kwargs: pytest.fail("blocked tool should not dispatch"),
    )

    payload = json.loads(model_tools.handle_function_call("terminal", {"command": "echo hi"}))

    assert payload["code"] == "enterprise_tool_policy_denied"
    assert payload["tool"] == "terminal"
    assert payload["reason"] == "enterprise_capability_disabled"
