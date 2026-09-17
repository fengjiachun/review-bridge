# Install the Claude Desktop extension

Describes Review Bridge v0.15.1.

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
