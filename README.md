# Review Bridge v0.2.0

Review Bridge is a local, manually triggered code-review handoff between Codex
and Claude Desktop.

It creates an immutable Git snapshot, gives Claude read-only review tools, lets
Codex answer every finding, and stops after two model-review rounds when the
models still disagree.

Review Bridge is an independent community project. It is not affiliated with,
endorsed by, or sponsored by OpenAI or Anthropic.

## Platform support

Review Bridge v0.2.0 supports macOS 13 Ventura or newer. The Claude Desktop
extension manifest is Darwin-only; Linux and Windows are not currently
supported or tested. State locking uses the macOS system tools
`/usr/bin/lockf` and `/bin/ps`.

## What is included

- `codex-marketplace/`: local Codex marketplace containing the Review Bridge
  plugin and author-role MCP server.
- `review-bridge-reviewer-v0.2.0.mcpb`: current MCP Bundle for Claude Desktop.
- `review-bridge-reviewer-v0.2.0.dxt`: compatibility copy for Claude Desktop
  versions that still use the DXT file extension.
- `claude-extension-source/`: inspectable source of the Claude extension.

Run `npm run build` to create these files under
`dist/review-bridge-v0.2.0/`.

Both MCP processes use this default shared data directory:

```text
~/Library/Application Support/ReviewBridge
```

Set `REVIEW_BRIDGE_HOME` to override it. When installing the Claude extension,
select the same directory in its configuration.

Install the author plugin and reviewer extension from the same Review Bridge
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
3. Select `review-bridge-reviewer-v0.2.0.mcpb`. If the picker only accepts
   `.dxt`, select the compatibility copy.
4. Keep the default Review Bridge data directory, or select the same directory
   configured through `REVIEW_BRIDGE_HOME` for Codex.
5. Restart Claude Desktop if its tools do not appear immediately.

## Use

In Codex:

> Prepare the current changes for Claude Desktop review. The requirement is
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

## GitHub publication gate

The installed Codex skill adds a second gate after the local review:

```text
LOCAL_GATE_PASSED
  -> publication baseline
  -> bound @codex review request
  -> atomic GitHub snapshot
  -> MERGE_READY
  -> finalize + immediate verification
```

Version 0.2 stores this workflow in `publication.json`. The author tools bind
the local gate, pull request, required checks, exact request, pinned Codex Bot
actor, result, and review threads to one head SHA. Every mutation carries an
expected revision and revokes an older `publication-gate.json`. Finalization
creates an expiring gate and appends a chained audit event; Codex must call
`verify_publication_gate` immediately before a head-matching merge.

The packaged version-1 adapter recognizes the observed clean issue-comment
shape and findings formal-review shape. Inline comments count only when
structurally attached to that formal review. A standalone review comment,
reaction, silence, unbound request, unsupported request, incomplete pagination,
or ambiguous result fails closed. Closing ambiguity requires direct human
approval of the complete resource-scoped request/result set.

Before requesting GitHub review, both the local branch head and PR head must
equal the `head_sha` returned by `finalize_local_gate`. A mismatch invalidates
the local gate and requires a new local Review Bridge task.

If the GitHub review finds an actionable issue, commit the fix and start a new
local Review Bridge task. Merge only after the new local gate, required checks,
and a new GitHub Codex review all pass for the same PR head.

For a publishable change, resolve the review base to an immutable commit SHA
before committing, then pass that SHA to `prepare_review`. Commit before local
review and commit fixes before rereview. This binds the reviewed diff to the
pre-change base and the local snapshot to the exact commit later pushed as the
PR head.

## Security and scope

- Claude receives read-only snapshot/search tools and verdict-writing tools. It
  has no Review Bridge tool for modifying the repository, pushing code, or
  creating pull requests.
- Codex and Claude run separate MCP processes with different tool lists.
- Working-tree overlays are copied into the private review store. Unchanged
  files are read from the captured Git object ID.
- Files larger than 10 MiB are recorded but not copied into the snapshot.
- Per-review author/reviewer mutations and publication mutations use separate
  inter-process locks across processes from the same locking-enabled build.
  Earlier processes do not participate in that protocol. A retryable
  `REVIEW_BUSY` or `PUBLICATION_BUSY` response means another process owns that
  state; reread the relevant state before retrying.
- The local gate and publication gate are workflow attestations, not Git or
  GitHub security boundaries. v0.2 does not install a `pre-push` hook.
- The Review Bridge MCP server receives no GitHub credentials. The packaged
  Codex skill uses the user's separately configured GitHub tools after the
  local gate passes.

Claude Desktop is a local application, but that does not imply local model
inference. Apply your Anthropic account and organization data policy before
reviewing confidential code.

## Data handling and cleanup

The review store contains repository paths, requirements, patches, manifests,
review findings, and copies of changed working-tree files. Review Bridge creates
store directories with mode `0700` and files with mode `0600`.

The Review Bridge MCP servers do not contain a network client or telemetry
integration. However, Claude Desktop can send source returned by reviewer tools
to Anthropic according to the account and organization configuration in use.

Review data is retained until it is deleted. To remove one task, stop active
Review Bridge operations and delete `reviews/<review_id>` inside the configured
store. To remove all tasks, quit Codex and Claude Desktop and delete the
configured Review Bridge directory.

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
