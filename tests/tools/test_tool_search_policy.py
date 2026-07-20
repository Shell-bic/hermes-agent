"""Enterprise policy coverage for the tool_search bridge."""

from __future__ import annotations

import json
from typing import Any

import pytest


DENIED_PLUGIN = "u3_policy_denied_plugin_tool"
DENIED_MCP = "u3_policy_denied_mcp_op"
ALLOWED_PLUGIN = "u3_policy_allowed_plugin_tool"
UNLISTED_PLUGIN = "u3_policy_unlisted_plugin_tool"
FILESYSTEM_MCP = "mcp_filesystem_read_text"

DENIED_PLUGIN_TOOLSET = "u3-policy-denied-plugin"
DENIED_MCP_TOOLSET = "mcp-u3-policy-denied"
ALLOWED_PLUGIN_TOOLSET = "u3-policy-allowed-plugin"
UNLISTED_PLUGIN_TOOLSET = "u3-policy-unlisted-plugin"
FILESYSTEM_MCP_TOOLSET = "mcp-filesystem"

ALL_POLICY_TOOLSETS = [
    DENIED_PLUGIN_TOOLSET,
    DENIED_MCP_TOOLSET,
    ALLOWED_PLUGIN_TOOLSET,
    UNLISTED_PLUGIN_TOOLSET,
]


def _schema(description: str, properties: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties or {},
        },
    }


@pytest.fixture
def policy_tools(monkeypatch, tmp_path):
    import model_tools
    from tools.registry import invalidate_check_fn_cache, registry

    for name in (DENIED_PLUGIN, DENIED_MCP, ALLOWED_PLUGIN, UNLISTED_PLUGIN, FILESYSTEM_MCP):
        registry.deregister(name)

    def _register(name: str, toolset: str, description: str) -> None:
        def _handler(args, task_id=None, **kwargs):
            return json.dumps({"ok": True, "tool": name, "args": args})

        registry.register(
            name=name,
            handler=_handler,
            schema=_schema(description, {"value": {"type": "string"}}),
            toolset=toolset,
        )

    _register(DENIED_PLUGIN, DENIED_PLUGIN_TOOLSET, "blocked enterprise plugin operation")
    _register(DENIED_MCP, DENIED_MCP_TOOLSET, "restricted enterprise mcp operation")
    _register(ALLOWED_PLUGIN, ALLOWED_PLUGIN_TOOLSET, "allowed enterprise plugin operation")
    _register(UNLISTED_PLUGIN, UNLISTED_PLUGIN_TOOLSET, "ordinary unknown plugin utility")
    _register(FILESYSTEM_MCP, FILESYSTEM_MCP_TOOLSET, "filesystem mcp read operation")

    policy_path = tmp_path / "enterprise-tool-policy.json"
    policy_path.write_text(
        json.dumps(
            {
                "role": [
                    {"name": "mcp-admin", "capabilities": ["mcp.manage"]},
                ],
                "toolPolicySnapshot": {
                    "policyVersion": "u3-test",
                    "policyHash": "hash-u3-tool-search-policy",
                    "toolSets": [
                        {"key": DENIED_PLUGIN_TOOLSET, "status": "blocked"},
                        {"key": ALLOWED_PLUGIN_TOOLSET, "status": "available"},
                    ],
                    "tools": [
                        {"key": DENIED_PLUGIN, "status": "blocked"},
                        {"key": ALLOWED_PLUGIN, "status": "available"},
                    ],
                    "mcpServers": [
                        {"key": "u3-policy-denied", "status": "restricted"},
                    ],
                    "capabilityFlags": {
                        "capability.mcp.install": True,
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()

    yield

    for name in (DENIED_PLUGIN, DENIED_MCP, ALLOWED_PLUGIN, UNLISTED_PLUGIN, FILESYSTEM_MCP):
        registry.deregister(name)
    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()


def _tool_names(tool_defs: list[dict[str, Any]]) -> set[str]:
    return {
        (tool_def.get("function") or {}).get("name", "")
        for tool_def in tool_defs
    }


def test_policy_denied_deferrable_tools_are_absent_from_preassembly_catalog(policy_tools):
    import model_tools

    names = _tool_names(
        model_tools.get_tool_definitions(
            enabled_toolsets=ALL_POLICY_TOOLSETS,
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
    )

    assert DENIED_PLUGIN not in names
    assert DENIED_MCP not in names
    assert ALLOWED_PLUGIN in names
    assert UNLISTED_PLUGIN in names


def test_tool_search_cannot_find_policy_denied_tools(policy_tools):
    import model_tools

    parsed = json.loads(
        model_tools.handle_function_call(
            function_name="tool_search",
            function_args={"query": "enterprise policy", "limit": 10},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )

    names = {match["name"] for match in parsed["matches"]}
    assert DENIED_PLUGIN not in names
    assert DENIED_MCP not in names
    assert ALLOWED_PLUGIN in names
    assert parsed["total_available"] == 2


def test_tool_describe_reports_policy_denied_tool_unavailable(policy_tools):
    import model_tools

    parsed = json.loads(
        model_tools.handle_function_call(
            function_name="tool_describe",
            function_args={"name": DENIED_PLUGIN},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )

    assert "error" in parsed
    assert "available" in parsed["error"].lower() or "denied" in parsed["error"].lower()


def test_stale_tool_call_to_policy_denied_tool_returns_policy_denial_without_dispatch(
    monkeypatch,
    policy_tools,
):
    import model_tools

    def _forbidden_dispatch(*args, **kwargs):
        raise AssertionError("registry.dispatch should not run for policy-denied stale tool_call")

    monkeypatch.setattr(model_tools.registry, "dispatch", _forbidden_dispatch)

    parsed = json.loads(
        model_tools.handle_function_call(
            function_name="tool_call",
            function_args={"name": DENIED_PLUGIN, "arguments": {"value": "stale"}},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )

    assert parsed["code"] == "enterprise_tool_policy_denied"
    assert parsed["tool"] == DENIED_PLUGIN
    assert parsed["policyHash"] == "hash-u3-tool-search-policy"


def test_allowed_deferrable_tool_remains_searchable_describable_and_callable(policy_tools):
    import model_tools

    search = json.loads(
        model_tools.handle_function_call(
            function_name="tool_search",
            function_args={"query": "allowed enterprise plugin", "limit": 5},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )
    match_names = {match["name"] for match in search["matches"]}
    assert ALLOWED_PLUGIN in match_names
    assert DENIED_PLUGIN not in match_names
    assert DENIED_MCP not in match_names

    described = json.loads(
        model_tools.handle_function_call(
            function_name="tool_describe",
            function_args={"name": ALLOWED_PLUGIN},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )
    assert described["name"] == ALLOWED_PLUGIN

    called = json.loads(
        model_tools.handle_function_call(
            function_name="tool_call",
            function_args={"name": ALLOWED_PLUGIN, "arguments": {"value": "ok"}},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )
    assert called["ok"] is True
    assert called["tool"] == ALLOWED_PLUGIN
    assert called["args"] == {"value": "ok"}


def test_unlisted_low_risk_plugin_remains_searchable_describable_and_callable(policy_tools):
    import model_tools

    search = json.loads(
        model_tools.handle_function_call(
            function_name="tool_search",
            function_args={"query": "ordinary unknown plugin", "limit": 5},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )
    match_names = {match["name"] for match in search["matches"]}
    assert UNLISTED_PLUGIN in match_names
    assert DENIED_PLUGIN not in match_names
    assert DENIED_MCP not in match_names

    described = json.loads(
        model_tools.handle_function_call(
            function_name="tool_describe",
            function_args={"name": UNLISTED_PLUGIN},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )
    assert described["name"] == UNLISTED_PLUGIN

    called = json.loads(
        model_tools.handle_function_call(
            function_name="tool_call",
            function_args={"name": UNLISTED_PLUGIN, "arguments": {"value": "open"}},
            enabled_toolsets=ALL_POLICY_TOOLSETS,
        )
    )
    assert called["ok"] is True
    assert called["tool"] == UNLISTED_PLUGIN


def test_mcp_dot_filesystem_restriction_blocks_runtime_mcp_filesystem_aliases(
    monkeypatch,
    policy_tools,
    tmp_path,
):
    import model_tools
    from tools.registry import invalidate_check_fn_cache

    policy_path = tmp_path / "enterprise-tool-policy-filesystem.json"
    policy_path.write_text(
        json.dumps(
            {
                "role": [
                    {"name": "mcp-admin", "capabilities": ["mcp.manage"]},
                ],
                "toolPolicySnapshot": {
                    "policyVersion": "u3-mapping-test",
                    "policyHash": "hash-u3-mcp-filesystem",
                    "mcpServers": [
                        {"key": "mcp.filesystem", "status": "restricted"},
                    ],
                    "capabilityFlags": {"capability.mcp.install": True},
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()

    names = _tool_names(
        model_tools.get_tool_definitions(
            enabled_toolsets=[FILESYSTEM_MCP_TOOLSET],
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
    )
    assert FILESYSTEM_MCP not in names

    search = json.loads(
        model_tools.handle_function_call(
            function_name="tool_search",
            function_args={"query": "filesystem", "limit": 5},
            enabled_toolsets=[FILESYSTEM_MCP_TOOLSET],
        )
    )
    assert FILESYSTEM_MCP not in {match["name"] for match in search["matches"]}

    def _forbidden_dispatch(*args, **kwargs):
        raise AssertionError("registry.dispatch should not run for restricted mcp.filesystem")

    monkeypatch.setattr(model_tools.registry, "dispatch", _forbidden_dispatch)
    stale = json.loads(
        model_tools.handle_function_call(
            function_name="tool_call",
            function_args={"name": FILESYSTEM_MCP, "arguments": {"value": "stale"}},
            enabled_toolsets=[FILESYSTEM_MCP_TOOLSET],
        )
    )
    assert stale["code"] == "enterprise_tool_policy_denied"
    assert stale["tool"] == FILESYSTEM_MCP


def test_file_toolset_restricted_allows_explicit_read_and_denies_write(
    monkeypatch,
    policy_tools,
    tmp_path,
):
    import model_tools

    policy_path = tmp_path / "enterprise-tool-policy-file.json"
    policy_path.write_text(
        json.dumps(
            {
                "toolPolicySnapshot": {
                    "policyVersion": "u3-mapping-test",
                    "policyHash": "hash-u3-file-overrides",
                    "toolSets": [
                        {"key": "toolset.file", "status": "restricted"},
                    ],
                    "tools": [
                        {"key": "tool.file.read", "status": "defaultEnabled"},
                        {"key": "tool.file.write", "status": "restricted"},
                    ],
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    model_tools._clear_tool_defs_cache()

    names = _tool_names(
        model_tools.get_tool_definitions(
            enabled_toolsets=["file"],
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
    )
    assert "read_file" in names
    assert "write_file" not in names

    def _forbidden_dispatch(*args, **kwargs):
        raise AssertionError("registry.dispatch should not run for restricted file write")

    monkeypatch.setattr(model_tools.registry, "dispatch", _forbidden_dispatch)
    denied = json.loads(
        model_tools.handle_function_call(
            function_name="write_file",
            function_args={"path": "blocked.txt", "content": "no"},
            enabled_toolsets=["file"],
        )
    )
    assert denied["code"] == "enterprise_tool_policy_denied"
    assert denied["tool"] == "write_file"


def test_terminal_exec_mapping_blocks_terminal_and_process_direct_stale_calls(
    monkeypatch,
    policy_tools,
    tmp_path,
):
    import model_tools

    policy_path = tmp_path / "enterprise-tool-policy-terminal.json"
    policy_path.write_text(
        json.dumps(
            {
                "toolPolicySnapshot": {
                    "policyVersion": "u3-mapping-test",
                    "policyHash": "hash-u3-terminal-exec",
                    "tools": [
                        {"key": "tool.terminal.exec", "status": "blocked"},
                    ],
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    model_tools._clear_tool_defs_cache()

    names = _tool_names(
        model_tools.get_tool_definitions(
            enabled_toolsets=["terminal"],
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
    )
    assert "terminal" not in names
    assert "process" not in names

    def _forbidden_dispatch(*args, **kwargs):
        raise AssertionError("registry.dispatch should not run for blocked terminal exec")

    monkeypatch.setattr(model_tools.registry, "dispatch", _forbidden_dispatch)
    for tool_name, args in (
        ("terminal", {"command": "echo blocked"}),
        ("process", {"action": "list"}),
    ):
        denied = json.loads(
            model_tools.handle_function_call(
                function_name=tool_name,
                function_args=args,
                enabled_toolsets=["terminal"],
            )
        )
        assert denied["code"] == "enterprise_tool_policy_denied"
        assert denied["tool"] == tool_name
