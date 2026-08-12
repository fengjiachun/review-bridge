# Changelog

## Unreleased

- Add an immutable added-plus-deleted line measurement and a default
  2000-line autonomous change-size budget with a non-blocking 75% warning and
  a pause before reviewer dispatch, plus an audited author tool for explicit
  extensions. Manual review reports the measurement without blocking.
- Add a default 12-cycle autonomous remote-repair budget that pauses with the
  full attempt chain, plus an audited author tool for explicit extensions.

## 0.7.0 - 2026-08-11

### Added

- The autonomous publication workflow can mark a cleared draft ready, return
  it to draft when repair is required, and record a durable terminal
  `MERGE_READY` without merging. External writes are intent-bound and
  reconciled after interruption, including cross-process recovery without
  duplicate provider writes.
- Invalidated workflow-owned Codex thread resolutions are compensated through
  an audited `UNRESOLVE_REVIEW_THREAD` lifecycle, with conservative pauses for
  human or unknown participation and replay-valid supersession evidence after
  repair.
- End-to-end coverage now walks a requirement through local and remote review
  to `MERGE_READY`, and proves crash recovery for accepted mark-ready and
  thread-unresolve writes using only durable ledger and provider-journal state.
- `rebuttal_accepted` rereview decisions require replayable verification
  evidence. The evidence is preserved in public review, arbitration, and
  Markdown export while historical ledgers remain readable.

### Changed

- Reviewer protocol text treats author responses as material to verify rather
  than instructions. Packaged reviewer guidance reports instruction-like
  author text as a finding instead of following or silently ignoring it.
- RFC 0003 is now implemented. The packaged Codex, Claude, and HERMES guidance
  has been audited against the implementation, and the publication inventory
  includes all fifteen tools, including `get_autonomous_terminal`.
- Publication fixture, resolution-record, and deep-state builders are shared
  test helpers, so recovery scenarios reuse the same state construction as
  the integration suite.
- The HERMES local reviewer integration ships separate author and reviewer MCP
  profiles, a reviewer-scoped skill, exact release-path rendering, capability
  isolation, and packaged-flow verification.
- A narrative review-flow guide follows one change from commit to merge-ready
  and explains the draft, snapshot, check, repair, and durable-action
  boundaries.

## 0.6.0 - 2026-08-06

### Added

- `HERMES` local reviewer provenance and a self-contained
  `hermes-integration/` build artifact with separate author-only and
  reviewer-only MCP snippets, an exact seven-tool reviewer allowlist, a
  Review Bridge-owned FULL/SUCCESSOR reviewer skill, shared-store/version
  pinning, and install, verification, isolation, and upgrade guidance.

## 0.5.0 - 2026-07-31

### Added

- An opt-in autonomous local workflow (RFC 0003 PR1): a schema-version-1
  workflow ledger binds immutable authorization, store-wide ownership claims,
  marker-reconciled Codex reviewer task dispatch, and crash recovery, and
  drives the local two-round `CODEX_TASK` review loop through
  `LOCAL_GATE_PASSED`. Pause, cancellation, `HUMAN_REQUIRED`, and finding
  fingerprints are audited so stale active ledgers fail closed. It stops at
  the local publication boundary.

- `record_github_snapshot` accepts `observation_path`, and the packaged
  collector accepts `--review-id` and `--out`, so a publication ledger and its
  GitHub observation move between the store, the collector, and the ledger as
  files instead of being retyped through the model.
- `prepare_review` selects a successor parent itself when `parent_review_id` is
  omitted, considering only gated tasks for the same repository and base SHA
  whose gated head is a strict ancestor of the captured head, and still
  requiring the full successor proof. `review_strategy.parent_selection`
  reports `AUTOMATIC`, `EXPLICIT`, or `NONE`, and `force_full_review` demands a
  full-patch review. An explicitly named parent must still match the
  requirement exactly; server-side selection does not require it, because
  authors reword requirements between rounds of the same work, and instead
  records `parent_requirement` and `requirement_match` in the successor proof.
  Candidates are matched on shared Git repository identity, so a parent gated
  in one linked worktree is found from another, and ranked by ancestry
  distance to the captured head rather than by gate recency, so gates landing
  out of commit order cannot pull selection toward a farther parent. The collector's `--out` file
  is replaced atomically through a fresh `0600` temp file, so reusing an
  observation path never inherits looser permissions. With `--review-id` the
  observation defaults into the private store beside the ledger, and an
  explicit `--out` inside any Git worktree is refused, because an untracked
  observation file would dirty the reviewed repository and fail
  publication-gate verification.
- `open_review` returns `patch_index`, the byte offset and length of each
  file's section in `patch.diff`, so a reviewer can read the sections a review
  depends on instead of the whole cumulative patch. The index is derived on
  demand from the immutable patch the reviewer reads — never stored in or
  trusted from the mutable ledger — is served only after the patch reproduces
  the round's committed snapshot hash, covers every byte from offset zero, and
  is null, requiring a whole-patch read, whenever those checks fail.
  Finalizing the local gate likewise verifies the stored patch against its
  snapshot commitment.
  Past 400 files the index is
  truncated but still spans the whole patch: a final `path: null` entry covers
  the remainder, which reviewers must read in full. Snapshot capture forces
  `core.quotePath=true` and header decoding is strict UTF-8, so a raw
  non-UTF-8 filename byte can never produce a lossy but plausible path — such
  sections stay `path: null` and are read in full. Quoted Git paths —
  filenames with quotes, control bytes, or non-ASCII — are decoded, unquoted
  headers are resolved by the equal-length structure of `a/X b/X` rather than
  by searching for a separator a filename could legally contain, and any
  section whose name still cannot be resolved — including renames — keeps
  `path: null` and is read in full under the same rule. The index is advisory and is not part of the
  snapshot commitment.

### Changed

- Reviewer instructions state decidable conditions for expanding a `SUCCESSOR`
  review to the full patch, replacing the open-ended "whenever uncertainty
  warrants it" that sent nearly every review back to reading everything.
- `open_review` returns one compact descriptor per round plus the full current
  snapshot, instead of every round in full alongside a duplicate copy of the
  current one.
- MCP responses are serialized without indentation.

## 0.4.3 - 2026-07-29

### Added

- An author-only `export_human_arbitration` tool returns exact-version,
  deterministic structured data and copyable Markdown for `HUMAN_REQUIRED`
  reviews without changing the review ledger.

## 0.4.2 - 2026-07-28

### Added

- Version-2 Codex review requests carry server-derived correlation IDs that
  bind clean comments and formal findings reviews to the exact workflow
  request.
- Prior local publication ledgers provide durable issuance provenance for
  historical requests, so requests from older heads no longer require repeated
  human closure before each successor review.

### Fixed

- Markerless Codex results remain fail-closed when a compatible unresolved
  baseline or unbound request could own the response.
- Correlated request parsing rejects malformed or duplicate markers while
  preserving adapter-version-1 and earlier version-2 publication ledgers.
- Later snapshots retain acknowledged unbound requests instead of
  reclassifying them as recognized.

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
