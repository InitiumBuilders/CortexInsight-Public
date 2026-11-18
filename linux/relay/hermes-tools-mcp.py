#!/usr/local/lib/hermes-agent/venv/bin/python
"""hermes-tools-mcp: expose Hermes Agent's own tool registry as a stdio MCP server.

Run with the Hermes venv interpreter and HERMES_HOME pointing at the profile:

    HERMES_HOME=/root/.hermes/profiles/augusttt \
    HERMES_YOLO_MODE=1 \
    /usr/local/lib/hermes-agent/venv/bin/python hermes-tools-mcp.py

Claude Code --mcp-config entry:
    {"mcpServers": {"hermes": {"command": "/usr/local/lib/hermes-agent/venv/bin/python",
                               "args": ["/path/hermes-tools-mcp.py"],
                               "env": {"HERMES_HOME": "/root/.hermes/profiles/augusttt",
                                       "HERMES_YOLO_MODE": "1"}}}}

Design notes (all verified against the installed tree, see the investigator report):
  * Tool schemas come from model_tools.get_tool_definitions() (OpenAI function format);
    handlers are invoked through tools.registry.registry.dispatch(name, args, **kw).
  * The mcp 2.0 high-level MCPServer derives input schemas from Python signatures only, so
    dynamic registration uses the low-level mcp.server.lowlevel.Server with on_list_tools /
    on_call_tool callbacks (MCPServer itself wires the same two hooks).
  * Handlers are synchronous and may block for minutes (terminal, browser); they run in a
    worker thread via loop.run_in_executor so the MCP ping/cancel path stays responsive.
    Async handlers (web_extract, vision_analyze) are bridged by registry.dispatch ->
    model_tools._run_async, which uses a thread-local persistent loop on worker threads.
  * HERMES_YOLO_MODE is frozen at `import tools.approval`; it must be in the environment
    before the first hermes import (this file only reads it, the MCP client config sets it).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional

HERMES_ROOT = os.environ.get("HERMES_AGENT_ROOT", "/usr/local/lib/hermes-agent")
if HERMES_ROOT not in sys.path:
    sys.path.insert(0, HERMES_ROOT)

log = logging.getLogger("hermes-tools-mcp")

# ---------------------------------------------------------------------------
# Policy: which registry tools to expose.
# ---------------------------------------------------------------------------
# Tools that recurse into the LLM (delegate_task spawns a child AIAgent -> cortex relay ->
# claude -p), need a live interactive callback (clarify, browser_vault_*), need agent-held
# state we do not replicate (todo_list), or control a desktop (computer_use).
EXCLUDE = {
    # Recurse into the LLM / need interactive callbacks / desktop / agent-held state:
    "delegate_task", "clarify", "todo_list", "computer_use", "execute_code",
    "browser_vault_list", "browser_vault_unlock", "browser_vault_fill",
    "browser_vault_save_login", "browser_vault_enter_code",
    "manage_connections", "text_to_speech",
    # Redundant with Claude Code's own native tools (the seat already has Bash,
    # Read/Write/Edit, WebSearch/WebFetch) — exposing a second copy only invites the
    # model to confuse two terminals / two web tools. The bridge stays ADDITIVE:
    # memory, session history, the Hermes skills library, browser, vision, send_message.
    "terminal", "process_manage", "read_file", "write_file", "patch", "search_files",
    "web_search", "web_extract",
}
# Optional explicit include list (comma separated env HERMES_MCP_TOOLS). Empty = everything
# the profile enables minus EXCLUDE.
INCLUDE_ONLY = {t.strip() for t in os.environ.get("HERMES_MCP_TOOLS", "").split(",") if t.strip()}
# Extra toolsets to add on top of the profile's "cli" platform selection (e.g. "kanban").
EXTRA_TOOLSETS = [t.strip() for t in os.environ.get("HERMES_MCP_EXTRA_TOOLSETS", "").split(",") if t.strip()]
# Tools the agent loop normally handles inline (model_tools._AGENT_LOOP_TOOLS); we supply
# the state they need ourselves.
INLINE_STATE_TOOLS = {"memory", "session_search"}


class HermesRuntime:
    """Process-wide Hermes initialisation + dispatch context."""

    def __init__(self) -> None:
        self.task_id = f"mcp-{os.getpid()}"          # isolates terminal/browser sessions
        self.session_id = os.environ.get("HERMES_MCP_SESSION_ID") or f"mcp-{os.getpid()}-{int(time.time())}"
        self.enabled_toolsets: List[str] = []
        self.tool_defs: List[Dict[str, Any]] = []
        self._memory_store = None
        self._session_db = None

    # -- init ---------------------------------------------------------------
    def init(self) -> None:
        t0 = time.perf_counter()
        # 1. .env of the profile (TELEGRAM_BOT_TOKEN, API keys) -> os.environ
        from hermes_cli.env_loader import load_hermes_dotenv
        load_hermes_dotenv()
        # 2. importing model_tools runs discover_builtin_tools() + discover_plugins()
        import model_tools
        from hermes_cli.config import load_config
        from hermes_cli.tools_config import _get_platform_tools
        from gateway.session_context import set_current_session_id, declare_stateless_channel

        cfg = load_config()
        self.enabled_toolsets = sorted(set(_get_platform_tools(cfg, "cli")) | set(EXTRA_TOOLSETS))
        # 3. publish a session id to tools (skill_usage, cron, terminal) and declare that
        #    nobody drains background completions (same as `hermes -z`).
        set_current_session_id(self.session_id)
        declare_stateless_channel()
        # 4. schemas, check_fn filtered (this is what the model would see)
        self.tool_defs = model_tools.get_tool_definitions(
            enabled_toolsets=self.enabled_toolsets, quiet_mode=True, skip_tool_search_assembly=True)
        log.info("hermes init: %d tools in %.2fs (toolsets=%s)", len(self.tool_defs),
                 time.perf_counter() - t0, ",".join(self.enabled_toolsets))

    # -- lazily created state for inline tools -------------------------------
    def memory_store(self):
        if self._memory_store is None:
            from tools.memory_tool import load_on_disk_store
            self._memory_store = load_on_disk_store()      # MEMORY.md / USER.md under HERMES_HOME/memories
        return self._memory_store

    def session_db(self):
        if self._session_db is None:
            from hermes_state_registry import acquire
            self._session_db = acquire()                    # HERMES_HOME/state.db (shared, refcounted)
        return self._session_db

    def close(self) -> None:
        try:
            if self._session_db is not None:
                from hermes_state_registry import release_or_close
                release_or_close(self._session_db)
        except Exception:
            pass
        try:
            from tools.terminal_tool import cleanup_task_environments
            cleanup_task_environments(self.task_id)
        except Exception:
            pass

    # -- dispatch (runs on a worker thread) ----------------------------------
    def dispatch(self, name: str, args: Dict[str, Any]):
        from tools.registry import registry
        kw: Dict[str, Any] = {"task_id": self.task_id, "session_id": self.session_id}
        if name == "memory":
            kw["store"] = self.memory_store()
        elif name == "session_search":
            kw["db"] = self.session_db()
            kw["current_session_id"] = self.session_id
        elif name == "browser_snapshot":
            kw["user_task"] = args.pop("_user_task", None)
        # registry.dispatch: coerces nothing itself, so mirror handle_function_call's arg coercion
        from tools.arg_coercion import coerce_tool_args
        args = coerce_tool_args(name, args) or {}
        return registry.dispatch(name, args, **kw)


# ---------------------------------------------------------------------------
# Extra tools that are NOT registry tools (deliberately, in Hermes).
# ---------------------------------------------------------------------------
def _extra_tool_defs() -> List[Dict[str, Any]]:
    return [
        {"type": "function", "function": {
            "name": "send_message",
            "description": ("Send a message to a Hermes-connected chat platform, e.g. target "
                            "'telegram:<chat_id>' (or just 'telegram' for the configured home "
                            "channel). Media: include 'MEDIA:/abs/path' in the message."),
            "parameters": {"type": "object", "properties": {
                "target": {"type": "string"}, "message": {"type": "string"},
                "action": {"type": "string", "enum": ["send", "list"], "default": "send"}},
                "required": ["target", "message"]}}},
        {"type": "function", "function": {
            "name": "memory_read",
            "description": "Read the current entries of the built-in Hermes memory stores (MEMORY.md / USER.md).",
            "parameters": {"type": "object", "properties": {
                "target": {"type": "string", "enum": ["memory", "user", "both"], "default": "both"}}}}},
    ]


def _dispatch_extra(rt: HermesRuntime, name: str, args: Dict[str, Any]) -> Optional[str]:
    if name == "send_message":
        from tools.send_message_tool import send_message_tool
        return send_message_tool({"action": args.get("action", "send"), **args})
    if name == "memory_read":
        store = rt.memory_store()
        target = args.get("target", "both")
        out = {}
        for t in (("memory", "user") if target == "both" else (target,)):
            out[t] = {"entries": store._entries_for(t), "usage": store._usage(t), "enabled": store.target_enabled(t)}
        return json.dumps(out, ensure_ascii=False)
    return None


# ---------------------------------------------------------------------------
# MCP wiring (low-level server: explicit JSON schemas)
# ---------------------------------------------------------------------------
def _to_mcp_tool(fn: Dict[str, Any]):
    import mcp.types as t
    params = fn.get("parameters") or {"type": "object", "properties": {}}
    if not isinstance(params, dict) or params.get("type") != "object":
        params = {"type": "object", "properties": {}}
    return t.Tool(name=fn["name"], description=fn.get("description", ""), input_schema=params)


def _result_to_content(result: Any):
    """Registry results are a JSON string or a {'_multimodal': True, 'content': [...]} dict."""
    import mcp.types as t
    if isinstance(result, dict) and result.get("_multimodal"):
        blocks = []
        for part in result.get("content", []):
            if part.get("type") == "text":
                blocks.append(t.TextContent(type="text", text=part.get("text", "")))
            elif part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                if url.startswith("data:") and "," in url:
                    header, data = url.split(",", 1)
                    mime = header[5:].split(";")[0] or "image/png"
                    blocks.append(t.ImageContent(type="image", data=data, mime_type=mime))
        return blocks or [t.TextContent(type="text", text=result.get("text_summary", ""))]
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
    return [t.TextContent(type="text", text=text)]


def _is_error(result: Any) -> bool:
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
            return isinstance(parsed, dict) and bool(parsed.get("error")) and parsed.get("success") is not True
        except ValueError:
            return False
    return False


def build_server(rt: HermesRuntime):
    import mcp.types as t
    from mcp.server.lowlevel import Server

    defs = [d["function"] for d in rt.tool_defs]
    names = {d["name"] for d in defs}
    exposed = [d for d in defs if d["name"] not in EXCLUDE and (not INCLUDE_ONLY or d["name"] in INCLUDE_ONLY)]
    extra = [d["function"] for d in _extra_tool_defs() if d["function"]["name"] not in names]
    tools = [_to_mcp_tool(d) for d in exposed + extra]
    extra_names = {d["name"] for d in extra}
    log.info("exposing %d tools: %s", len(tools), ", ".join(x.name for x in tools))

    async def on_list_tools(ctx, params) -> t.ListToolsResult:
        return t.ListToolsResult(tools=tools)

    async def on_call_tool(ctx, params: t.CallToolRequestParams) -> t.CallToolResult:
        name, args = params.name, dict(params.arguments or {})
        loop = asyncio.get_running_loop()
        from tools.thread_context import propagate_context_to_thread

        def _run():
            if name in extra_names:
                return _dispatch_extra(rt, name, args)
            if name not in {x.name for x in tools}:
                return json.dumps({"error": f"Unknown tool: {name}"})
            return rt.dispatch(name, args)

        try:
            result = await loop.run_in_executor(None, propagate_context_to_thread(_run))
        except Exception as exc:  # registry.dispatch already catches; this is belt and braces
            log.exception("tool %s failed", name)
            return t.CallToolResult(content=[t.TextContent(type="text", text=f"{type(exc).__name__}: {exc}")], is_error=True)
        return t.CallToolResult(content=_result_to_content(result), is_error=_is_error(result))

    return Server(
        name="hermes-tools",
        instructions=("Hermes Agent native tools for profile %s. Terminal/browser sessions are "
                      "isolated per server process." % os.environ.get("HERMES_HOME", "")),
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )


async def _serve(rt: HermesRuntime) -> None:
    from mcp.server.stdio import stdio_server
    server = build_server(rt)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main() -> None:
    logging.basicConfig(level=os.environ.get("HERMES_MCP_LOG", "WARNING"), stream=sys.stderr)
    if not os.environ.get("HERMES_HOME"):
        print("HERMES_HOME must be set (e.g. /root/.hermes/profiles/augusttt)", file=sys.stderr)
        sys.exit(2)
    rt = HermesRuntime()
    rt.init()
    try:
        asyncio.run(_serve(rt))
    except KeyboardInterrupt:
        pass
    finally:
        rt.close()


if __name__ == "__main__":
    main()
