# Claude as the author

Use this connection in an author conversation. Keep the reviewer extension in
an independent reviewer context; never use reviewer tools to review your own work.
Merge the rendered `mcp.json` entry into Claude's MCP configuration, replacing
`__REVIEW_BRIDGE_RELEASE_PATH__` with the absolute `claude-extension-source`
directory, `__REVIEW_BRIDGE_HOME__` with the shared store, and
`__CODEX_EXECUTABLE__` with the absolute Codex CLI path on this host. Restart the
client yourself. Review Bridge does not automate Claude Desktop.

1. Call `discover_reviewer_options` with the repository path and `CODEX_TASK`.
   Show the actual returned models and each model's reasoning efforts, with the
   valid prior choice suggested. Use a structured picker if available, otherwise
   ordinary conversation. Respect explicit choices without asking again.
2. Discovery is not selection or authorization to launch. Prepare the immutable
   review with `prepare_review`, then persist the user's choice through
   `select_reviewer_configuration` (model, effort, environment ID, state version).
3. When authorized, call `launch_local_reviewer`. The shared server starts Codex
   on the same runtime/account/config used for discovery, with explicit parameters.
   Claude needs neither a shell tool nor computer use.
4. Follow `get_review_summary` and `wait_for_review_state`; resolve findings and
   prepare rereview through author tools. Rereview inherits the selection. An
   explicit change is allowed before dispatch and preserves earlier rounds.

Unavailable models, unsupported pairs, and changed environments fail explicitly.
Retry failed discovery; do not guess or downgrade. The catalog query timestamp
is not an upstream cache timestamp. Requested configuration is recorded; observed
remote model identity is unavailable. Other providers expose their limits instead
of invented menus. Unattended work requires a preauthorized selection and stops
without interactive waiting if none exists.
