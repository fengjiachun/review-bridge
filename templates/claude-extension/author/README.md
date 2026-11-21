# Claude as the author

Use this connection in an author conversation. Keep the reviewer extension in
an independent reviewer context; never use reviewer tools to review your own work.
Merge the rendered `mcp.json` entry into Claude's MCP configuration, replacing
`__REVIEW_BRIDGE_RELEASE_PATH__` with the absolute `claude-extension-source`
directory, `__REVIEW_BRIDGE_HOME__` with the shared store, and
`__CODEX_EXECUTABLE__` with the absolute Codex CLI path on this host. Restart the
client yourself. Review Bridge does not automate Claude Desktop.

1. Prepare the immutable review with `prepare_review`.
2. When authorized, call `launch_local_reviewer`. The shared server starts Codex
   on this host with the model from its Codex configuration at `high` reasoning
   effort. Claude needs neither a shell tool nor computer use.
3. Follow `get_review_summary` and `wait_for_review_state`; resolve findings and
   prepare rereview through author tools, then launch again for round two.

To change the reviewer model, change the host's Codex configuration. Requested
configuration is recorded; observed remote model identity is unavailable.
