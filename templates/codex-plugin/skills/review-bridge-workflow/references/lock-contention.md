## Lock contention


State-changing author and reviewer tools can return a structured `REVIEW_BUSY`
error with `details.retryable: true` after a bounded lock wait. Reread the
review summary and retry the same transition only if it is still required.
Treat `details.retryable: false` as fail-closed and resolve the reported cause
before retrying.

`LOCK_OWNERSHIP_LOST` instead carries
`details.state_may_have_changed: true`. The transition may already be on disk,
so reread the review before deciding whether any retry is still required.

`LOCK_CLEANUP_FAILED` is non-retryable and also carries
`details.state_may_have_changed: true`. Stop the owning Review Bridge process
before inspecting or removing the lock record named in `details.path`; do not
loop on the same mutation.

`STORE_WRITE_INDETERMINATE` is non-retryable and also carries
`details.state_may_have_changed: true`. The canonical file was replaced, but
syncing its parent directory failed. Reread the review before deciding whether
the mutation still needs to be retried.
