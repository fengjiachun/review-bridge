# Install the Claude Desktop extension

Describes Review Bridge v0.17.0. For an existing setup, see [upgrading](upgrade.md).

Choose the role you need: the extension below lets Claude **review** a snapshot;
the separate [author connection](#use-claude-as-an-author) lets Claude **request
a Codex review**, including model and reasoning selection.

Download `review-bridge-reviewer-<version>.mcpb` from the
[latest release](https://github.com/fengjiachun/review-bridge/releases/latest),
and note the tag — you will build the Codex plugin from it. A `.dxt`
compatibility copy is published for Claude Desktop versions that still use the
older file extension; the two files are byte-identical.

Optionally verify the download against the release's `SHA256SUMS.txt`:

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

Then, in Claude Desktop:

1. Open **Settings → Extensions → Advanced settings**.
2. Choose **Install Extension**.
3. Select the `.mcpb` file. If the picker only accepts `.dxt`, select the
   compatibility copy.
4. Keep the default Review Bridge data directory, or select the same directory
   configured through `REVIEW_BRIDGE_HOME` for Codex.
5. Restart Claude Desktop if its tools do not appear immediately.

Claude Desktop is a local application, but that does not imply local model
inference. Apply your Anthropic account and organization data policy before
reviewing confidential code.

## Use Claude as an author

The reviewer extension above only exposes reviewer tools. For authoring, render
and install the separate [author MCP entry](../../templates/claude-extension/author/mcp.json)
and follow its [local review instructions](../../templates/claude-extension/author/README.md).
It exposes discovery, explicit selection and Codex launch on the MCP server host;
no shell or computer use in Claude is required. Keep author and reviewer contexts
separate. The entry is included under `claude-extension-source/author` in builds.

Replace the template's three placeholders with absolute paths: the built
`claude-extension-source` directory, your shared `REVIEW_BRIDGE_HOME`, and the
Codex CLI executable on this host. Merge the rendered entry into the MCP
configuration of the Claude client you actually use, preserving unrelated
entries. Restart that client and open a new author conversation. An author
connection in Claude Code and an extension in Claude Desktop are separate
installations; updating one does not configure the other.

Then follow the [choose-and-start example](../reviewer-configuration.md#choose-and-start-from-your-author-client).
The choice controls the independent Codex reviewer, not the Claude model in
this conversation. Keep a reviewer conversation separate from the author.
