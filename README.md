# Review Bridge v0.1

Review Bridge is a local, manually triggered code-review handoff between Codex
and Claude Desktop.

It creates an immutable Git snapshot, gives Claude read-only review tools, lets
Codex answer every finding, and stops after two model-review rounds when the
models still disagree.

## What is included

- `codex-marketplace/`: local Codex marketplace containing the Review Bridge
  plugin and author-role MCP server.
- `review-bridge-reviewer-v0.1.0.mcpb`: current MCP Bundle for Claude Desktop.
- `review-bridge-reviewer-v0.1.0.dxt`: compatibility copy for Claude Desktop
  versions that still use the DXT file extension.
- `claude-extension-source/`: inspectable source of the Claude extension.

Run `npm run build` to create these files under
`dist/review-bridge-v0.1.0/`.

Both MCP processes use this default shared data directory:

```text
~/Library/Application Support/ReviewBridge
```

Set `REVIEW_BRIDGE_HOME` to override it. When installing the Claude extension,
select the same directory in its configuration.

## Install the Codex plugin

From a terminal:

```bash
codex plugin marketplace add "/absolute/path/to/codex-marketplace"
```

Restart the Codex desktop app, open Plugins, select **Review Bridge Local**, and
install **Review Bridge**.

The local marketplace remains the source of the installed plugin. Keep the
`codex-marketplace` directory in place while using this build.

## Install the Claude extension

In Claude Desktop:

1. Open **Settings → Extensions → Advanced settings**.
2. Choose **Install Extension**.
3. Select `review-bridge-reviewer-v0.1.0.mcpb`. If the picker only accepts
   `.dxt`, select the compatibility copy.
4. Keep the default Review Bridge data directory, or select the same directory
   configured through `REVIEW_BRIDGE_HOME` for Codex.
5. Restart Claude Desktop if its tools do not appear immediately.

## Use

In Codex:

> Prepare the current changes for Claude Desktop review. The requirement is
> "...", the implementation scope is "...", and the base ref is `origin/main`.

Codex returns a `review_id` and waits in `WAITING_FOR_REVIEW`.

In Claude Desktop:

> List pending Review Bridge tasks and deeply review `<review_id>`. Read the
> entire patch and relevant snapshot files, then submit structured findings.

Back in Codex:

> Read Claude's findings, address each one, and prepare round two.

Invoke Claude once more for round two. The final state is one of:

- `LOCAL_GATE_PASSED`: Claude found no remaining issue and the working tree
  still matches the reviewed snapshot.
- `HUMAN_REQUIRED`: a finding remains or a new finding appears after round two.

## State machine

```text
WAITING_FOR_REVIEW
  ├─ no findings ──────────────────────────────> CLEAN
  └─ findings -> REVIEW_SUBMITTED
                   ├─ human_required ──────────> HUMAN_REQUIRED
                   └─ fixed/rejected -> AUTHOR_RESPONDED
                                          -> WAITING_FOR_REREVIEW
                                               ├─ all accepted -> CLEAN
                                               └─ open/new -> HUMAN_REQUIRED

CLEAN -> snapshot recheck -> LOCAL_GATE_PASSED
```

## Security and scope

- Claude receives read-only snapshot/search tools and verdict-writing tools. It
  has no Review Bridge tool for modifying the repository, pushing code, or
  creating pull requests.
- Codex and Claude run separate MCP processes with different tool lists.
- Working-tree overlays are copied into the private review store. Unchanged
  files are read from the captured Git object ID.
- Files larger than 10 MiB are recorded but not copied into the snapshot.
- The local gate is a workflow attestation, not a Git or GitHub security
  boundary. v0.1 intentionally does not install a `pre-push` hook or integrate
  with GitHub.

Claude Desktop is a local application, but that does not imply local model
inference. Apply your Anthropic account and organization data policy before
reviewing confidential code.

## Develop

Requirements: Node.js 18 or newer, npm, Git, and `zip`.

```bash
npm ci
npm test
npm audit --omit=dev
npm run build
npm run verify:build
```

Set `REVIEW_BRIDGE_OUTPUT_ROOT` to write a build to a different directory.
