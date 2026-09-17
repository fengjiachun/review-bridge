# Troubleshooting

Describes Review Bridge v0.15.1.

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

Other common situations:

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
