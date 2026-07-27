---
name: review-bridge-workflow
description: Use when preparing local code for an isolated reviewer, handling findings, or publishing through local-gate or explicitly authorized remote-only GitHub review.
---

# Review Bridge workflow

Use the Review Bridge author tools to coordinate a manual, two-round review with
Claude Desktop or a fresh Codex reviewer task, or an explicitly authorized
remote-only GitHub publication.

## Prepare

1. Confirm the repository path and choose the exact base ref. Resolve it to an
   immutable commit SHA before creating or committing publication changes, and
   pass that SHA to `prepare_review`. Do not silently guess between `HEAD`,
   `origin/main`, or another release branch.
2. Summarize the user's requirement faithfully.
3. State the implementation scope, changed behavior, and verification evidence.
4. If the user intends to publish the change, create a topic branch and commit
   the intended diff before review. Commit later fixes before rereview. This
   lets the local gate attest the exact commit that will become the PR head.
5. If this task is a committed continuation of a prior
   `LOCAL_GATE_PASSED` task for the same repository, immutable base SHA, and
   requirement, pass that task as `parent_review_id`. The server uses
   `SUCCESSOR` only when the parent gate, commit ancestry, and clean worktrees
   verify; otherwise it records an explicit `FULL` fallback. Never choose a
   parent merely because it is recent.
6. Choose `reviewer_provider` explicitly:
   - `CLAUDE_DESKTOP` for a fresh Claude Desktop conversation.
   - `CODEX_TASK` for a newly created Codex task that is not a fork of the
     author task and has no authoring history for the change.
   Never call reviewer tools from the author task; provider binding and task
   separation are workflow attestations, not authenticated model identity.
7. Call `prepare_review` with the base SHA captured in step 1, the selected
   provider, and the optional verified parent from step 5.
8. Call `get_review_summary`, record its `state_version`, and report the
   returned `review_id`, `reviewer_provider`, `review_strategy`, and state
   `WAITING_FOR_REVIEW`.
9. Start a fresh reviewer context for every new `review_id`. For
   `CLAUDE_DESKTOP`, use a fresh Claude conversation. For `CODEX_TASK`, create
   a new Codex task rather than forking this task, and send it only the review
   ID and a request to follow the packaged reviewer skill. A round-two
   rereview of the same ID may stay in that reviewer context.
10. Require the reviewer to follow the returned strategy. For `SUCCESSOR`, it
    must read `successor.json` and all of `successor.diff`, inspect changed
    files plus relevant callers, contracts, and tests, and expand to
    `patch.diff` whenever risk or uncertainty warrants it. For `FULL`, it must
    read the entire `patch.diff`.
11. Use `wait_for_review_state` with the recorded `state_version` to observe the
   transition without repeatedly loading the full ledger. It waits 25 seconds
   by default and accepts at most 30 seconds. A `timed_out` result is expected
   while a human-paced review remains in progress; call it again with the same
   `state_version` until `changed` is true, or report the returned summary and
   resume when the user confirms the review is complete.

In local-review mode, do not push or open a pull request while the task is
waiting for its reviewer.

## Handle findings

1. Call `get_review_summary` first. If it reports `REVIEW_SUBMITTED`, call
   `get_review` once to load the full findings and evidence.
2. Address every open finding. For each finding choose exactly one:
   - `fixed`: change the code and verify the fix.
   - `rejected`: provide concrete technical evidence.
   - `human_required`: stop and request human arbitration.
3. Call `submit_resolutions` with one entry for every finding.
4. If the state is `AUTHOR_RESPONDED`, call `prepare_rereview`.
5. Record the new summary's `state_version`, report `WAITING_FOR_REREVIEW`,
   resume the same reviewer context, and use `wait_for_review_state` to observe
   the next transition. Treat `timed_out` as an expected in-progress result and
   continue with the same `state_version` as described above.

Keep fixes surgical. Do not mark a finding fixed without verification evidence.

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

## Finish

- If the reviewer returns `CLEAN`, call `finalize_local_gate`.
- Finalization must fail if the working tree changed after the clean
  verdict.
- Treat `LOCAL_GATE_PASSED` as permission to continue the user's publication
  workflow, not as permission by itself to push or create a pull request.
- If the state is `HUMAN_REQUIRED`, stop. Do not start a third model round.

The review ledger, not free-form chat text, is the source of truth.

## Publish through GitHub

Choose exactly one authorization mode before starting publication:

- `LOCAL_GATE` is the default. Complete the local workflow through
  `LOCAL_GATE_PASSED`, confirm the clean local HEAD equals the finalized gate
  head, then push and open a draft pull request.
- `REMOTE_ONLY` is allowed only after the user directly instructs you to skip
  local review for this change. Do not infer it from urgency, a prior
  exception, reviewer unavailability, or a general instruction to continue.
  Commit and verify the intended diff, push it, open the pull request, freshly
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
   relative to this SKILL in `BASELINE` mode and set `authorization_head_sha`
   to the immutable publication head; do not reproduce provider body parsing
   ad hoc. The legacy
   `local_gate_head_sha` input remains compatible only for older local-ledger
   callers.
4. Call `start_publication`. If its immutable baseline contains any request,
   call `get_publication`, supply that returned JSON to the packaged read-only
   `../../scripts/collect-github-observation.mjs` helper resolved relative to
   this SKILL, and call
   `record_github_snapshot` with its output. Then call
   `get_publication_summary`, present its complete
   `required_request_refs` and `required_ambiguous_results` sets to the human,
   and call `acknowledge_codex_review_ambiguity` only after direct approval of
   both exact sets and the `NO_FURTHER_RESULTS_EXPECTED` risk statement. If the
   baseline contains no open legacy or unsupported request, continue without
   an acknowledgement. A version-2 `BASELINE_CORRELATED` request is already
   isolated by its request ID and does not require closure.
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
6. Call `get_publication` and supply its returned JSON to the packaged
   `../../scripts/collect-github-observation.mjs` helper resolved relative to
   this SKILL. The helper uses the user's authenticated `gh` CLI in read-only
   mode to collect the PR and both base comparisons, applicable rules, two
   independent branch reads, classic protection when applicable, every
   check-run page using `filter=all`, every commit-status page, all three Codex
   feeds, and all review-thread pages. It
   canonicalizes GitHub timestamps to UTC milliseconds, preserves pagination
   proof, and fails closed when policy evidence is unavailable. Call
   `record_github_snapshot` with its complete output, then use
   `get_publication_summary` for the compact revision, blocker, exact
   acknowledgement sets, gate state, and `next_action`. Use the full
   `get_publication` result again only as the next collector input or for an
   audit that needs the complete ledger.
7. For adapter version 2, treat a result that omits or changes the exact Review
   Bridge request ID as non-passing. Adapter-version-1 ledgers retain the
   legacy exact-body and single-open-request rules. In either version, treat an
   eyes reaction, silence, missing pagination, an unsupported
   standalone review comment, an unbound request, an ambiguous result, or an
   unknown response shape as non-passing. A clean issue comment must echo the
   current request ID, use the recognized clean format, and carry the commit
   prefix for the exact request head. Findings must echo the same request ID in
   a formal review bound by native `commit_id` with its complete structurally
   attached Codex review comments. Never infer correlation from timestamps.
8. If the ledger reports `GITHUB_REVIEW_UNKNOWN` because of ambiguity or an
   unbound or unsupported request, call `get_publication_summary` and present
   its entire `required_request_refs` and `required_ambiguous_results` sets to
   the human. Invoke
   `acknowledge_codex_review_ambiguity` only after direct approval of that exact
   full set; partial approval, silence, retry intent, or earlier permission to
   finish is insufficient. Then refresh the head, post and immediately bind one
   new summary-provided correlated request, and record a new complete snapshot.
9. If Codex reports an actionable finding, commit and verify the fix. Start a
    new local Review Bridge task in `LOCAL_GATE` mode or call
    `authorize_remote_publication` again in `REMOTE_ONLY` mode. A new commit
    invalidates this ledger and its prior GitHub Codex result.
10. After `MERGE_READY`, use the packaged collector for one final fresh GitHub
    observation and call `record_github_snapshot`, then call
    `finalize_publication_gate`. Immediately before merge call `verify_publication_gate`;
    only `valid: true` authorizes the next operation. Merge with the returned full
    `head_sha` using a head-matching operation such as
    `gh pr merge --match-head-commit <head_sha>`. Never reuse a finalize result,
    direct file read, cached verification, or older revision.

The nine publication tools are `authorize_remote_publication`,
`start_publication`, `get_publication`, `get_publication_summary`,
`record_codex_review_request`, `record_github_snapshot`,
`acknowledge_codex_review_ambiguity`, `finalize_publication_gate`, and
`verify_publication_gate`. Keep their revision ordering explicit and retry
`PUBLICATION_BUSY` or `REVIEW_BUSY` only after rereading current state.

Any new commit invalidates the GitHub review gate. Compare the reviewed PR head
before merge; a squash merge naturally creates a different merge commit.

The Review Bridge MCP server does not receive GitHub credentials. The Codex
skill orchestrates the repository's configured GitHub tools after a local gate
or explicit remote-only authorization exists.

For offline reporting, run
`node scripts/inspect-publication-audit.mjs <review_id>` from the installed
plugin directory. It validates every committed audit event and the complete
digest chain without changing the publication ledger or gate.
