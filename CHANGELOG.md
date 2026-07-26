# Changelog

## Unreleased

### Added

- Compact author-side review summaries and bounded state-change waits.
- Integer state versions keep wait cursors independent from wall-clock
  formatting and clock skew.
- Per-review cross-process locking serializes author and reviewer state
  mutations.

### Changed

- Locking-enabled builds require macOS 13 Ventura or newer with the system tools
  `/usr/bin/lockf` and `/bin/ps`, and the author and reviewer artifacts must
  come from the same build.
- Contended state-changing tools return structured, retryable `REVIEW_BUSY`
  errors after a bounded wait.
- Lost-ownership errors state that the mutation may already be on disk and
  require callers to reread state before deciding whether to retry.

### Fixed

- Final lock cleanup failures now return a non-retryable structured error
  instead of reporting a successful mutation with only a warning.
- Malformed lock errors no longer echo lock-file bytes, and tests cover
  inconclusive owner probes without changing the record.
- The packaged GitHub workflow now recognizes Codex results delivered as issue
  comments or pull-request reviews while treating attached review comments as
  supporting evidence and requiring trusted actor, exact request, and
  reviewed-head binding.
- Receipt reactions and ambiguous or unbound results remain pending rather than
  being treated as a publication pass.

## 0.1.1 - 2026-07-25

### Added

- A GitHub Codex review gate after the local Claude review gate.
- Open-source contribution, security, platform, and data-retention guidance.
- Package metadata for the source repository, issue tracker, and MIT license.

### Fixed

- Source packages now contain only files tracked at the release commit and
  builds refuse dirty working trees.
- Snapshots handle committed deletions, UTF-8 chunk boundaries, literal
  backslashes, colon-containing paths, and oversized modified files correctly.
- Publication reviews bind the immutable base SHA, local gate, CI result, and
  GitHub review to the intended pull-request head.
- The release build overrides the vulnerable transitive `tmp` version used by
  the MCP Bundle development toolchain.
