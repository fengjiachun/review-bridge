# Changelog

## 0.4.1 - 2026-07-27

### Added

- A compact `get_publication_summary` author tool reports the current revision,
  blocking reason, next action, gate state, and exact ambiguity
  acknowledgement sets without returning the full ledger.
- The packaged Codex plugin includes a read-only GitHub observation collector
  that follows required REST and GraphQL pagination, retains policy
  provenance, and canonicalizes GitHub timestamps before ledger submission.

### Changed

- The packaged publication workflow uses the collector and compact summary
  instead of requiring an agent to hand-assemble observations or inspect the
  full ledger for routine state transitions.
- Ruleset-only branches can prove an absent classic-protection endpoint with
  repository-bound OAuth administration evidence from the authenticated
  GitHub CLI session.

## 0.4.0 - 2026-07-27

### Added

- Local review tasks bind an immutable `CLAUDE_DESKTOP` or `CODEX_TASK`
  reviewer provider through the local and publication gates.
- The Codex plugin includes a reviewer-only MCP process and a fresh-task review
  skill for independent local Codex review.
- Explicit `REMOTE_ONLY` publication authorization records the operator,
  rationale, clean repository, base SHA, and head SHA without claiming a local
  review gate.
- The packaged workflow can run the existing GitHub Codex, required-check, and
  review-thread gates from either a local gate or a remote-only authorization.

### Changed

- Reviewer processes can list, read, and submit only tasks bound to their
  configured provider. Successor proofs preserve the parent provider.
- New publication ledgers use authorization-union schema version 2; version-1
  local-gate ledgers remain readable and completable.
- Any new local or pull-request head requires a new authorization and GitHub
  Codex result before merge.
- Remote-only authorizations explicitly carry no local reviewer provenance.

## 0.3.0 - 2026-07-26

### Added

- Successor reviews bind a prior local gate, parent/current Git trees, and the
  exact intervening commit delta while retaining the full snapshot for
  risk-driven expansion and final verification.
- Explicit `FULL` fallback records why a requested successor proof was
  ineligible instead of silently weakening review context.

### Changed

- The packaged workflow starts a fresh Claude conversation for every new review
  task and uses focused successor context only after server-side proof checks.
- Snapshot commitments now include explicit worktree cleanliness. Review tasks
  prepared by 0.2.x must be recreated after upgrading to 0.3.0 before local
  gate finalization.

## 0.2.0 - 2026-07-26

### Added

- Compact author-side review summaries and bounded state-change waits.
- Integer state versions keep wait cursors independent from wall-clock
  formatting and clock skew.
- Per-review cross-process locking serializes author and reviewer state
  mutations.
- A revisioned GitHub publication ledger, versioned Codex response adapter,
  expiring `MERGE_READY` gate, and append-only gate audit chain.

### Changed

- Locking-enabled builds require macOS 13 Ventura or newer with the system tools
  `/usr/bin/lockf` and `/bin/ps`, and the author and reviewer artifacts must
  come from the same build.
- Contended state-changing tools return structured, retryable `REVIEW_BUSY`
  errors after a bounded wait.
- Lost-ownership errors state that the mutation may already be on disk and
  require callers to reread state before deciding whether to retry.

### Fixed

- Post-rename directory-sync failures now return a non-retryable structured
  error that tells callers to reread state before retrying.
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
