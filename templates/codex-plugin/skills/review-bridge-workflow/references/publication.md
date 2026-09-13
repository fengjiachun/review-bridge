## Publish through GitHub

Use [Prepare](prepare.md) for LOCAL_GATE preparation and provider selection.
For either mode, the pre-commit cleanup means removing comments that do not
state a constraint the code cannot express and tests that no behavior change
can turn red. Use the shared waiting rules in [the entrypoint](../SKILL.md)
when remote observations are unchanged.

Resolve all `../../scripts/` helper paths from the directory containing
`review-bridge-workflow/SKILL.md`, not from this `references/` directory.

Choose exactly one authorization mode before starting publication:

- `LOCAL_GATE` is the default. Complete the local workflow through
  `LOCAL_GATE_PASSED`, confirm the clean local HEAD equals the finalized gate
  head, then push and open a draft pull request. The gate that authorizes a
  publication is a `CODEX_TASK` review by default, on the terms Prepare states.
- `REMOTE_ONLY` is allowed only after the user directly instructs you to skip
  local review for this change. Do not infer it from urgency, a prior
  exception, reviewer unavailability, or a general instruction to continue.
  Apply the pre-commit cleanup, commit and verify the intended diff, push it,
  open the pull request, freshly
  read the PR base branch tip and head, fetch both commits, and require local
  HEAD to equal the PR head. Resolve `base_sha` as the exact merge base of that
  fresh base tip and head; do not pass the base branch tip unless it is itself
  the merge base. Obtain the operator label and their stated rationale without
  inventing either, then call `authorize_remote_publication` with that
  `base_sha`, the full head, and the exact acknowledgement
  `LOCAL_REVIEW_SKIPPED`. Record the returned `review_id`; its immutable
  authorization head replaces the local-gate head in every step below.

For either mode:

1. Require the PR head commit to equal the immutable publication authorization
   `head_sha`. A mismatch requires a new local review task or a new remote-only
   authorization, according to the selected mode.
2. Resolve the expected Codex GitHub App from a maintainer-approved pinned
   source. Record its stable numeric actor ID and exact `Bot` type; the login is
   audit display only. Never learn or replace this identity from a candidate
   result.
3. Immediately before `start_publication`, collect every page of the three
   preexisting Codex feeds: issue comments, formal pull-request reviews, and
   pull-request review comments. Supply their independent completion times and
   pagination proof as the complete version-2 baseline. Version 2 recognizes
   Review Bridge request IDs while preserving legacy request shapes as
   fail-closed baseline evidence. Set `adapter_version: 2` in the normalizer
   input. Use `EXPLICIT_ONLY`
   only when automatic Codex review is disabled and this workflow is the sole
   trigger actor. `AUTOMATIC_QUIESCENCE_ACKNOWLEDGED` requires direct human
   approval, an operator label, and a rationale immediately before this fresh
   baseline; never infer quiescence from elapsed time, silence, reactions, or a
   general instruction to continue. Normalize the raw three-feed payload with
   the packaged `../../scripts/normalize-codex-evidence.mjs` adapter resolved
   relative to the entrypoint SKILL in `BASELINE` mode and set `authorization_head_sha`
   to the immutable publication head; do not reproduce provider body parsing
   ad hoc. The legacy
   `local_gate_head_sha` input remains compatible only for older local-ledger
   callers.
4. Call `start_publication`. If its immutable baseline contains any request,
   run the packaged read-only `../../scripts/collect-github-observation.mjs`
   helper resolved relative to the entrypoint SKILL as `--review-id <review_id>`, and
   call `record_github_snapshot` with the `observation_path` the helper prints.
   The helper reads the ledger from the store and writes the observation into
   the private store beside it — never into a repository worktree, where an
   untracked observation would dirty the tree and fail gate verification — so
   neither payload passes through this conversation. Then call
   `get_publication_summary`, present its complete
   `required_request_refs` and `required_ambiguous_results` sets to the human,
   and call `acknowledge_codex_review_ambiguity` only after direct approval of
   both exact sets and the `NO_FURTHER_RESULTS_EXPECTED` risk statement. If the
   baseline contains no open legacy, unsupported, or unverified correlated
   request, continue without an acknowledgement. A version-2 `BASELINE_CORRELATED` request with
   server-verified issuance provenance from another head is not a candidate for
   a later markerless result; an unverified, same-head, or legacy unscoped
   baseline request remains a candidate. A same-head one stops being a
   candidate the moment step 5 records the next request: the server supersedes
   the prior requests it proved this chain issued. An unverified or legacy one
   is never superseded and keeps the acknowledgement path.
5. Refresh the PR head and require it to equal the publication authorization
   head. Call `get_publication_summary` and require
   `next_action: POST_AND_RECORD_CODEX_REVIEW_REQUEST`. Post exactly one issue
   comment whose entire body equals the returned `codex_review_request.body`;
   do not edit, reconstruct, or shorten it. Then immediately call
   `record_codex_review_request` with the post response's comment ID, URL,
   `created_at`, the freshly read full head, and, when present, the returned
   `codex_review_request.request_id`. Adapter-version-1 ledgers return the
   legacy exact body without a request ID; omit that field when resuming them.
   Never post an exact or
   trigger-shaped Codex review request manually or outside this sequence. A
   crash between post and binding leaves an unbound request and must fail
   closed.
6. Run the packaged `../../scripts/collect-github-observation.mjs` helper
   resolved relative to the entrypoint SKILL as `--review-id <review_id>`.
   The helper uses the user's authenticated `gh` CLI in read-only
   mode to collect the PR and both base comparisons, applicable rules, two
   independent branch reads, classic protection when applicable, a single
   page each of check runs using `filter=all`, commit statuses and review
   threads -- a selection that prefers the newest evidence decides from them, so
   they are read at one instant or refused -- and all pages of the three Codex
   feeds, which are walked because a pull request may hold more than a page of
   them. It
   canonicalizes GitHub timestamps to UTC milliseconds, preserves pagination
   proof, and fails closed when policy evidence is unavailable. Call
   `record_github_snapshot` with the `observation_path` the helper prints,
   then use `get_publication_summary` for the compact revision, blocker,
   exact acknowledgement sets, gate state, and `next_action`. Never paste an
   observation or a ledger into a tool call or a shell heredoc: the helper
   reads and writes those files itself, and retyping them costs more than every
   other step of this workflow combined. Call `get_publication` only for an
   audit that genuinely needs the complete ledger in the transcript.
7. For adapter version 2, prefer a clean issue comment or findings review that
   echoes the exact current Review Bridge request ID. When the GitHub Codex App
   omits it, accept only the server-replayed fallback of exactly one recorded
   open request, no preceding unbound or compatible unresolved baseline
   request, and a compatible reviewed-commit prefix or native GitHub
   `commit_id`. Adapter-version-1 ledgers retain the legacy exact-body and
   single-open-request rules. In either version, treat an eyes reaction,
   silence, missing pagination, an unsupported standalone review comment, an
   unbound request, an ambiguous result, or an unknown response shape as
   non-passing. Findings must be a formal review with its complete structurally
   attached Codex review comments. Never infer correlation from timestamps
   alone.
8. If the ledger reports `GITHUB_REVIEW_UNKNOWN` because of ambiguity or an
   unbound or unsupported request, call `get_publication_summary` and present
   its entire `required_request_refs` and `required_ambiguous_results` sets to
   the human. Invoke
   `acknowledge_codex_review_ambiguity` only after direct approval of that exact
   full set; partial approval, silence, retry intent, or earlier permission to
   finish is insufficient. Then refresh the head, post and immediately bind one
   new summary-provided correlated request, and record a new complete snapshot.
9. If Codex reports an actionable finding, apply the pre-commit cleanup, then
    commit and verify the fix. Start a
    new local Review Bridge task in `LOCAL_GATE` mode or call
    `authorize_remote_publication` again in `REMOTE_ONLY` mode. A new commit
    invalidates this ledger and its prior GitHub Codex result. In `LOCAL_GATE`
    mode that task is a successor by default: leave `parent_review_id` unset
    and `force_full_review` off, so its reviewed unit is the fix delta over the
    head this publication already gated.
10. After `MERGE_READY`, run the packaged collector once more with
    `--review-id <review_id>` for a final fresh GitHub observation and call
    `record_github_snapshot` with the printed `observation_path`, then call
    `finalize_publication_gate`. The summary's `gate_expires_in_seconds` says
    how much of that gate's window is left. It expires five minutes after the
    oldest source collection in the observation it was minted over, not five
    minutes after issuance, so part of the window is already spent when the gate
    first exists. Read it before starting the merge: too little left means
    collect a fresh observation and finalize again, not hurry.
    Immediately before merge call `verify_publication_gate`;
    only `valid: true` authorizes the next operation. Merge with the returned full
    `head_sha` using a head-matching operation such as
    `gh pr merge --match-head-commit <head_sha>`. Never reuse a finalize result,
    direct file read, cached verification, or older revision.
11. Once the ledger reads `MERGE_READY`, call `render_review_report` with the
    `review_id` — in `REMOTE_ONLY` mode the authorization's, since no local
    review exists and the report then renders from the publication and its
    authorization alone — and print the returned path. If `command -v plannotator` finds
    Plannotator on PATH, run `plannotator annotate <path>` so the operator can
    read the report there; otherwise the printed path is the whole step.
    Annotations never flow back into the ledger: whatever the reader decides
    goes through the ordinary tools. The report is a projection of the ledger,
    not evidence, and a failure in this step changes no gate and no workflow
    state, so it may run before or after the merge.

The fifteen publication tools are `authorize_remote_publication`,
`start_publication`, `get_publication`, `get_publication_summary`,
`get_autonomous_pre_ready`, `get_autonomous_terminal`,
`get_thread_resolution_plan`,
`get_invalidated_resolution_plan`,
`record_codex_review_request`, `record_github_snapshot`,
`record_automatic_resolution`, `record_automatic_unresolve`,
`acknowledge_codex_review_ambiguity`,
`finalize_publication_gate`, and `verify_publication_gate`. Keep their
revision ordering explicit and retry `PUBLICATION_BUSY` or `REVIEW_BUSY` only
after rereading current state. `get_autonomous_pre_ready` exists only for a
version-3 autonomous ledger; version-1 and version-2 ledgers keep their exact
existing status and next-action behavior and can never bind a workflow.

Any new commit invalidates the GitHub review gate. Compare the reviewed PR head
before merge; a squash merge naturally creates a different merge commit.

The Review Bridge MCP server does not receive GitHub credentials. The Codex
skill orchestrates the repository's configured GitHub tools after a local gate
or explicit remote-only authorization exists.

For offline reporting, run
`node scripts/inspect-publication-audit.mjs <review_id>` from the installed
plugin directory. It validates every committed audit event and the complete
digest chain without changing the publication ledger or gate.
