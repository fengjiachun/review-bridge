# Upgrade an existing installation

Describes upgrading to Review Bridge v0.17.0. For a first installation, use the
[Codex](codex-plugin.md), [Claude](claude-desktop.md), [Hermes](hermes.md), or
[DeepSeek Harness](deepseek-harness.md) instructions.

Every participant sharing a review store must use the same Review Bridge
version. Keep `REVIEW_BRIDGE_HOME` unchanged: it holds review history, not the
installed runtime. Update the clients you actually use, including both author
and reviewer connections where installed.

## Prepare the new runtime

1. Finish active reviews or stop and reconcile their running processes before
   switching. Close the affected client sessions so old MCP processes cannot
   keep writing while you update the other participants.
2. Record the current runtime paths, shared store path, and enabled roles. Back
   up client configuration files privately; they may contain credentials.
3. Build in a new directory, keeping the previous installation intact. For
   example, from a parent directory where `review-bridge-v0.17.0` does not exist:

   ```bash
   git clone --branch v0.17.0 https://github.com/fengjiachun/review-bridge.git review-bridge-v0.17.0
   cd review-bridge-v0.17.0
   npm ci
   npm run build
   npm run verify:build
   ```

Keep this checkout and its `dist/review-bridge-v0.17.0` output in a permanent
location. Use absolute paths in client configurations; do not overwrite the old
runtime or retarget a shared symlink beneath running processes.

## Switch installed clients

### Codex plugin

From the new checkout above, inspect the registered marketplace:

```bash
codex plugin marketplace list
```

If `review-bridge-local` points to the old installation, replace that source
and install the plugin from the new one:

```bash
codex plugin marketplace remove review-bridge-local
codex plugin marketplace add "$(pwd)/dist/review-bridge-v0.17.0/codex-marketplace"
codex plugin add review-bridge@review-bridge-local
```

If no source is registered, skip `remove`. If it already points to this exact
directory, skip both marketplace commands. Adding a different path under the
same marketplace name without removing the old source produces “already added
from a different source.” Removing the marketplace registration does not
delete the review store. Retain any custom shared-store configuration.

### Other clients

| Installed connection | What to update |
| --- | --- |
| Claude Desktop reviewer | Install the new release's `.mcpb` extension (or `.dxt` where required), keep it enabled, and preserve its data-directory setting. |
| Claude author MCP | Update the server path to the new `claude-extension-source` runtime using the [author entry](../../templates/claude-extension/author/mcp.json). Retain the shared store and absolute Codex executable path. |
| Hermes profiles | Re-render author/reviewer snippets against the new `hermes-integration` directory and update the reviewer skill; follow the [packaged upgrade instructions](../../templates/hermes/README.md#upgrade). |
| DeepSeek Harness profiles | Re-render installed profiles and update the reviewer skill from the new `deepseek-harness` directory; follow the [packaged upgrade instructions](../../templates/deepseek-harness/README.md#upgrade). |

If you configured an MCP server manually in another client, update that
connection too. Replacing a Desktop extension does not update a separately
configured author server. Preserve each connection's author/reviewer role.

## Verify in new sessions

Restart the affected clients after all paths have been switched, then open new
tasks or conversations. Existing sessions may retain old processes and tool
lists even when the files on disk are new.

- Check the installed plugin/extension version and each configured runtime
  path. Where the client exposes MCP initialization details, its server version
  should be `0.17.0`.
- An author connection should expose `discover_reviewer_options`,
  `select_reviewer_configuration`, and `launch_local_reviewer`. A reviewer
  connection should expose reviewer tools, without author/publication tools.
- Ask an author connection to list available `CODEX_TASK` models and efforts
  for your repository. Discovery is read-only with respect to the review
  ledger and does not start a review. See [reviewer configuration](../reviewer-configuration.md).
- Confirm an existing review can still be read from the same store. An empty
  history usually warrants checking the store path before creating new work.

If verification fails, stop new work and inspect [troubleshooting](../troubleshooting.md).
Keeping old files is useful for recovery, but does not prove an older release
can read ledgers written by a newer one. Do not run mixed versions against the
store or delete review history to repair an installation.
