# Troubleshooting

Describes Review Bridge v0.18.0.

## Models, launch, and upgrades

**No model picker appears** — Review Bridge supplies options through author MCP
tools; the client supplies the UI. Ask the author to list available
`CODEX_TASK` models and reasoning levels, then choose in conversation if the
client has no picker. An already explicit valid choice does not need another
confirmation. See [reviewer configuration](reviewer-configuration.md).

**A new model is missing, or the list differs from the author app** — discovery
uses the Codex CLI on the MCP host, with that process's account and configuration.
Check the executable and account used there. `REVIEW_BRIDGE_CODEX_COMMAND` can
pin an absolute executable when a desktop app has a different PATH. The query
time is not the upstream catalog's age, and discovery cannot force a network
refresh. Retry after correcting the runtime; do not substitute a guessed model.

**Selection or launch says the model, effort, or environment is unavailable** —
query the runtime again and explicitly select a supported pair. An environment
change between discovery and launch requires a new selection; Review Bridge
never silently downgrades the model or reasoning effort.

**No new reviewer task window appears** — `launch_local_reviewer` starts an
independent Codex process on the MCP host. Follow its `review_id` from the author
conversation with `get_review_summary` and `wait_for_review_state`. To operate a
reviewer in a visible task yourself, choose [manual dispatch](local-review.md#start-a-reviewer-manually)
instead of launching the same round twice.

**The reviewer process exited, but the review is not complete** — process exit
is not a verdict. Read the review summary for ledger status and next action. A
live or indeterminate launch blocks replacement; a missing exit record after a
host restart does not prove completion. Reconcile that attempt before retrying,
rather than deleting its records or starting another reviewer blindly.

**Upgraded files, but old tools remain** — update every installed author and
reviewer connection, restart clients, and open new sessions. Check the runtime
paths and MCP server version as described in the [upgrade guide](install/upgrade.md).
The Claude Desktop reviewer extension alone does not provide author tools;
install the separate [author connection](install/claude-desktop.md#use-claude-as-an-author)
to select and launch a Codex reviewer from Claude.

**Codex marketplace is “already added from a different source”** — replace the
old marketplace registration using the [Codex upgrade steps](install/upgrade.md#codex-plugin).
Keep the shared review store and the old runtime directory intact.

## State-changing tool errors

State-changing tools return structured errors. Whether a retry is safe depends
on `details`:

**`REVIEW_BUSY` with `details.retryable: true`** — another process owns the
review lock and the bounded wait expired. Call `get_review_summary` and retry
the same transition only if it is still required.

**`PUBLICATION_BUSY` with `details.retryable: true`** — another process owns the
publication lock and the bounded wait expired. Call `get_publication` for the
current state and revision, then retry the same transition only if it is still
required.

Errors with `details.retryable: false` are fail-closed: resolve the stated cause
before retrying. Three of them also set `details.state_may_have_changed: true`,
meaning the write may already be on disk:

**`LOCK_OWNERSHIP_LOST`** — the transition may already have been applied. Call
`get_review_summary` after a review operation or `get_publication` after a
publication operation before deciding whether any retry is still required.

**`LOCK_CLEANUP_FAILED`** — the protected write may already be on disk while the
named lock record remains. Stop the owning Review Bridge process before
inspecting or removing that record. After cleanup, reread the affected review or
publication state; do not loop on the same mutation.

**`STORE_WRITE_INDETERMINATE`** — the canonical file was replaced, but syncing
its parent directory failed. Call `get_review_summary` after a review operation
or `get_publication` after a publication operation before deciding whether any
retry is still required.

## Installation and provider setup

**`npm run build` fails immediately with `refusing to build from a dirty working
tree`** — the check runs `git status --porcelain --untracked-files=all`, so
untracked files count, and a plain `git stash` will not clear them. Commit the
changes, delete the stray files, or stash everything including untracked:

```bash
git stash --include-untracked
```

**`npm run build` fails with `fatal: not a git repository`** — you are building
from the extracted source archive. That check needs a Git worktree; clone the
repository and check out the release tag instead.

**Claude Desktop shows no Review Bridge tools** — restart the app. If they are
still missing, confirm the extension's data directory matches the Codex
`REVIEW_BRIDGE_HOME`.

**A reviewer cannot see a pending review** — each review is immutably bound to
one provider. A `CLAUDE_DESKTOP`, `CODEX_TASK`, `HERMES`, or `DEEPSEEK_HARNESS`
reviewer cannot list or open a review bound to any of the other providers.
