# Review Bridge v0.4.0

Review Bridge is a manually triggered code-review handoff between a Codex
author and an explicitly bound reviewer: Claude Desktop, a fresh Codex task, or
GitHub Codex in remote-only publication mode.

For local review, it creates an immutable Git snapshot, gives the reviewer
read-only tools, lets the author answer every finding, and stops after two
rounds when a finding remains.

Review Bridge is an independent community project. It is not affiliated with,
endorsed by, or sponsored by OpenAI or Anthropic.

## Platform support

Review Bridge v0.4.0 supports macOS 13 Ventura or newer. The Claude Desktop
extension manifest is Darwin-only; Linux and Windows are not currently
supported or tested. State locking uses the macOS system tools
`/usr/bin/lockf` and `/bin/ps`.

## What is included

- `codex-marketplace/`: local Codex marketplace containing the Review Bridge
  plugin, author MCP server, and `CODEX_TASK` reviewer MCP server.
- `review-bridge-reviewer-v0.4.0.mcpb`: current MCP Bundle for Claude Desktop.
- `review-bridge-reviewer-v0.4.0.dxt`: compatibility copy for Claude Desktop
  versions that still use the DXT file extension.
- `claude-extension-source/`: inspectable source of the Claude extension.

Run `npm run build` to create these files under
`dist/review-bridge-v0.4.0/`.

All MCP processes use this default shared data directory:

```text
~/Library/Application Support/ReviewBridge
```

Set `REVIEW_BRIDGE_HOME` to override it. When installing the Claude extension,
select the same directory in its configuration.

Install every process that shares a store from the same Review Bridge
build. Do not mix a locking-enabled build with artifacts from an earlier
release; earlier processes do not participate in the locking protocol.

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
3. Select `review-bridge-reviewer-v0.4.0.mcpb`. If the picker only accepts
   `.dxt`, select the compatibility copy.
4. Keep the default Review Bridge data directory, or select the same directory
   configured through `REVIEW_BRIDGE_HOME` for Codex.
5. Restart Claude Desktop if its tools do not appear immediately.

## Use

In the author Codex task, choose the reviewer provider explicitly:

> Prepare the current changes for a `CODEX_TASK` review. The requirement is
> "...", the implementation scope is "...", and the base ref is `origin/main`.

Codex returns a `review_id` and waits in `WAITING_FOR_REVIEW`.
Use `get_review_summary` for the compact state, next action, current snapshot,
and active versus all-time finding counts. Pass its `state_version` to
`wait_for_review_state`; the tool waits 25 seconds by default, configurable up
to 30 seconds, and returns the same compact summary without repeated full-ledger
polling. A timed-out wait is expected while a human-paced review is still in
progress; call it again with the same `state_version`, or resume when the user
confirms the review is complete.

State-changing tools can return a structured `REVIEW_BUSY` error with
`details.retryable: true` after a bounded lock wait. Reread the review summary
and retry the same transition only if it is still required. Treat errors with
`details.retryable: false` as fail-closed and resolve their stated cause before
retrying.

`LOCK_OWNERSHIP_LOST` is a special non-retryable result with
`details.state_may_have_changed: true`: the transition may already be on disk.
Reread the review before deciding whether any retry is still required.

`LOCK_CLEANUP_FAILED` is also non-retryable and sets
`details.state_may_have_changed: true`. The protected write may already be on
disk while the named lock record remains. Stop the owning Review Bridge process
before inspecting or removing that record; do not loop on the same mutation.

`STORE_WRITE_INDETERMINATE` is non-retryable and also sets
`details.state_may_have_changed: true`. The canonical file was replaced, but
syncing its parent directory failed, so reread the relevant review state before
deciding whether a retry is still required.

For a `CODEX_TASK` review, create a new Codex task. Do not fork the author task
or include its chat history. Give the new task only this request:

> Independently review Review Bridge task `<review_id>` using the packaged
> reviewer skill. Submit every actionable finding and do not modify the code.

For a `CLAUDE_DESKTOP` review, start a fresh Claude Desktop conversation and
use the equivalent request:

> List pending Review Bridge tasks and deeply review `<review_id>`. Follow its
> review strategy, inspect the required artifacts and relevant snapshot files,
> then submit structured findings.

Back in Codex:

> Read the reviewer's findings, address each one, and prepare round two.

Resume the same reviewer context for round two. The final state is one of:

- `LOCAL_GATE_PASSED`: the reviewer found no remaining issue and the working tree
  still matches the reviewed snapshot.
- `HUMAN_REQUIRED`: a finding remains or a new finding appears after round two.

### Successor reviews

Start a fresh reviewer context for each new `review_id`; a round-two rereview
may stay in the same context. A `CODEX_TASK` reviewer must be a newly created
task, not a fork of the author task. This prevents authoring history and
unrelated reviews from consuming the new task's context window.

When a committed change continues a prior `LOCAL_GATE_PASSED` task for the same
repository, base SHA, and requirement, pass its ID as `parent_review_id`.
Review Bridge verifies the parent gate, clean committed snapshots, and commit
ancestry. A valid `SUCCESSOR` task includes:

- `successor.json`, which binds the parent gate and snapshot, parent/current Git
  tree IDs, and delta hash;
- `successor.diff`, the exact parent-head-to-current-head delta;
- the normal full `patch.diff` and `manifest.json`, retained for expansion and
  final fail-closed snapshot verification.

The reviewer must read the complete successor proof and delta, inspect the changed
files plus relevant callers, contracts, and tests, and expand to the full patch
whenever risk or uncertainty warrants it. If any successor precondition fails,
the task records an explicit `FULL` fallback and the reviewer reviews the complete
patch. The optimization changes context selection, not the final local gate.

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

## GitHub publication gate

The installed Codex skill supports two explicit publication authorization
modes:

```text
LOCAL_GATE_PASSED ────────────┐
REMOTE_ONLY authorization ────┴─> publication baseline
  -> bound @codex review request
  -> atomic GitHub snapshot
  -> MERGE_READY
  -> finalize + immediate verification
```

`LOCAL_GATE` remains the default. `REMOTE_ONLY` is available only when the
operator directly chooses to skip local review. The
`authorize_remote_publication` tool records the exact
`LOCAL_REVIEW_SKIPPED` acknowledgement, operator label, rationale, clean local
repository, reviewed base SHA, and head SHA under a new review ID. The reviewed
base is the merge base of the freshly observed PR base tip and head, so an
advanced base branch does not need to be an ancestor of the feature head. The
tool does not create or claim `LOCAL_GATE_PASSED`.

Version 0.4 writes authorization-union publication ledgers with schema version
2 and remains able to read and complete version-1 local-gate ledgers. The
author tools bind the selected authorization, pull request, required checks,
exact request, pinned Codex Bot actor, result, and review threads to one head
SHA. Every mutation carries an expected revision and revokes an older
`publication-gate.json`. Finalization creates an expiring gate and appends a
chained audit event; Codex must call `verify_publication_gate` immediately
before a head-matching merge.

The packaged Codex plugin also includes
`scripts/inspect-publication-audit.mjs <review_id>` for read-only, full-chain
offline audit validation.

The packaged version-1 adapter recognizes the observed clean issue-comment
shape and findings formal-review shape. Inline comments count only when
structurally attached to that formal review. A standalone review comment,
reaction, silence, unbound request, unsupported request, incomplete pagination,
or ambiguous result fails closed. Closing ambiguity requires direct human
approval of the complete resource-scoped request/result set.

Before requesting GitHub review, both the local branch head and PR head must
equal the selected authorization's `head_sha`. A mismatch invalidates the
publication ledger. After any fix commit, create a new local review task or a
new explicit remote-only authorization according to the selected mode. Required
checks and a new GitHub Codex review must then pass for that new exact PR head.

For a publishable change, resolve the review base to an immutable commit SHA
before committing, then pass that SHA to `prepare_review`. Commit before local
review and commit fixes before rereview. This binds the reviewed diff to the
pre-change base and the local snapshot to the exact commit later pushed as the
PR head.

## Security and scope

- The bound local reviewer receives read-only snapshot/search tools and
  verdict-writing tools. It has no Review Bridge tool for modifying the
  repository, pushing code, or creating pull requests.
- Author and reviewer roles run as separate MCP processes with different tool
  lists. Each local review is immutably bound to `CLAUDE_DESKTOP` or
  `CODEX_TASK`; mismatched reviewer processes cannot list, read, or submit it.
- Working-tree overlays are copied into the private review store. Unchanged
  files are read from the captured Git object ID.
- Files larger than 10 MiB are recorded but not copied into the snapshot.
- Per-review author/reviewer mutations and publication mutations use separate
  inter-process locks across processes from the same locking-enabled build.
  Earlier processes do not participate in that protocol. A retryable
  `REVIEW_BUSY` or `PUBLICATION_BUSY` response means another process owns that
  state; reread the relevant state before retrying.
- Local, remote-only, and publication gates are workflow attestations, not Git
  or GitHub security boundaries. Review Bridge does not install a `pre-push`
  hook.
- The Review Bridge MCP server receives no GitHub credentials. The packaged
  Codex skill uses the user's separately configured GitHub tools after the
  selected publication authorization exists.

Provider binding and separate Codex tasks are workflow attestations, not
authenticated human or model identity. A `CODEX_TASK` review improves context
isolation but does not provide the model diversity of a separate provider.

Claude Desktop is a local application, but that does not imply local model
inference. Apply your Anthropic account and organization data policy before
reviewing confidential code.

## Data handling and cleanup

The review store contains repository paths, requirements, patches, manifests,
review findings, remote-only operator labels and rationales, and copies of
changed working-tree files. Review Bridge creates store directories with mode
`0700` and files with mode `0600`.

The Review Bridge MCP servers do not contain a network client or telemetry
integration. The selected client may send source returned by reviewer tools to
its model provider according to the account and organization configuration in
use.

Review data is retained until it is deleted. To remove one task, stop active
Review Bridge operations and delete `reviews/<review_id>` inside the configured
store. To remove all tasks, quit active Codex and Claude Desktop reviewer
processes and delete the configured Review Bridge directory.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the supported
release policy.

## Develop

Requirements: macOS 13 Ventura or newer with `/usr/bin/lockf` and `/bin/ps`,
Node.js 18 or newer, npm, Git, and `unzip`.

```bash
npm ci
npm test
npm audit --omit=dev
npm run build
npm run verify:build
```

Set `REVIEW_BRIDGE_OUTPUT_ROOT` to write a build to a different directory.
