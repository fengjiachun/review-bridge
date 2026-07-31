---
name: review-bridge-workflow
description: Use when preparing local code for an isolated reviewer, handling findings, or publishing through local-gate or explicitly authorized remote-only GitHub review.
---

# Review Bridge workflow

Use the Review Bridge author tools to coordinate a manual, two-round review with
Claude Desktop or a fresh Codex reviewer task, or an explicitly authorized
remote-only GitHub publication.

## Autonomous local workflow

The schema-version-1 autonomous workflow is opt-in and currently advances only
through the local `CODEX_TASK` gate. It does not yet automate GitHub
publication, remote findings, ready-state changes, or thread resolution.

1. Obtain direct operator authorization for the exact repository path,
   operator-selected base ref and resolved full base SHA, requirement,
   implementation scope, topic branch, publication target, push remote, and
   the complete capability set returned by the
   `start_autonomous_workflow` schema. A general instruction to implement,
   test, review, or continue is not autonomous authorization.
2. Require a clean worktree with the authorized topic branch checked out at
   the immutable base. Call `start_autonomous_workflow`, record its
   `workflow_id` and revision, and follow only the server-derived
   `next_action`.
3. For `COMMIT_HEAD`, implement only the recorded requirement, test it, commit
   it without rewriting published history, require a clean worktree, and call
   `record_workflow_head` with the full `HEAD`.
4. For `PREPARE_LOCAL_REVIEW`, call `prepare_review` with the workflow's full
   base SHA, exact requirement and scope, and `CODEX_TASK`; then call
   `bind_workflow_review` at the workflow's current revision.
5. For `PLAN_CODEX_TASK_DISPATCH`, call `plan_codex_task_dispatch`. Persist
   `EXECUTING` with `mark_workflow_action_executing` immediately before task
   creation. Create a fresh non-forked Codex task whose title and prompt equal
   the returned dispatch payload. Enumerate the exact opaque marker and call
   `record_codex_task_observation` only when exactly one matching task exists;
   then call `complete_workflow_action`. After an indeterminate create,
   reconcile the marker before creating anything else. After a restart,
   recover the exact title and prompt from `active_action.dispatch` in
   `get_autonomous_workflow` or `get_autonomous_workflow_summary`; never
   reconstruct the strings or call `plan_codex_task_dispatch` again.
6. If the client cannot create, discover, or wait for that independent task,
   call `pause_autonomous_workflow` with
   `TASK_ORCHESTRATION_UNAVAILABLE`. If creation may have succeeded but
   uniqueness cannot be proved, use `EXTERNAL_ACTION_INDETERMINATE`. Never
   review from the author task or discard the active intent.
7. Use `advance_local_workflow` after every local-review ledger transition.
   Address findings and record any committed descendant fix head before
   submitting resolutions. Round two reuses the same reviewer task. A
   `HUMAN_REQUIRED` review pauses the workflow and must not create a third
   model round.
8. For `PLAN_PUSH`, call `plan_workflow_push`; it verifies the clean
   checked-out HEAD still equals the gated workflow head and binds the
   remote's single push URL into the intent. Persist `EXECUTING` with
   `mark_workflow_action_executing` immediately before pushing, then push the
   immutable gated commit — `git push <remote>
   <active_action.target.head_sha>:refs/heads/<topic_branch>`, recovering the
   SHA from the persisted intent after a restart — never the mutable branch
   name, so a branch that advanced after planning cannot leak an ungated
   commit to the remote. Never force-push. Reconcile from the provider, never
   from the plan: freshly read the remote's configured push URL,
   resolve that URL to its GitHub repository and numeric repository ID, and
   freshly read the exact remote ref head. Call `record_push_observation`
   with the `remote_ref_sha`, `remote_repository_id`, and `remote_url` taken
   from that fresh read — echoing the planned target's values would make the
   proof meaningless — and the server accepts them only when they prove the
   authorized repository and the exact gated head. Then call
   `complete_workflow_action`. If the remote URL, repository identity, or ref
   cannot be read or does not converge, pause with
   `EXTERNAL_ACTION_INDETERMINATE` instead of re-pushing blindly.
9. For `PLAN_DRAFT_PULL_REQUEST`, first resolve the authenticated principal
   that will create the pull request (its numeric actor ID and User or Bot
   type), and call `plan_draft_pull_request` with it; the intent pins that
   creator, and recovery binds only a pull request created by the same
   principal. Include
   the returned exact `body_marker` in the initial pull-request body. Persist
   `EXECUTING` before creating the draft pull request against the authorized
   base. Reconcile by searching the authorized repository for open pull
   requests with the exact head branch: bind exactly one match whose marker,
   base repository, head repository (by numeric ID — a fork is never the
   authorized head repository), branches, head, draft state, and creator all
   verify, and call
   `record_draft_pull_request_observation` with those facts; then call
   `complete_workflow_action`, which atomically claims the pull request
   store-wide. A same-branch pull request without the marker, a non-draft
   match, or multiple matches pauses; branch equality alone never establishes
   ownership.
10. Stop this implementation at `START_PUBLICATION`. Autonomous publication
    ledgers, remote Codex waiting, and repair cycles remain unavailable until
    the later workflow schema and skill update ship. Continue manually through
    the existing `LOCAL_GATE` publication flow only after a fresh operator
    instruction.

Every mutation uses the exact current workflow revision. On `WORKFLOW_BUSY`,
`WORKFLOW_CLAIMS_BUSY`, `LOCK_OWNERSHIP_LOST`, or an indeterminate store write,
freshly reread the workflow before deciding whether a transition is still
needed. Ownership claims live in the workflow ledger itself; a start that
cannot read every persisted ledger, or that conflicts with an active claim,
fails closed before writing anything. Cancellation retains claims. Release
them only after exact reconciliation proves each branch and head ref absent
and each bound pull request closed, with each observation bound to the
current workflow revision and exact canonical claim target, and the operator
explicitly requests cleanup.

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
5. Leave `parent_review_id` unset unless you have a specific parent in mind.
   The server then selects one itself, considering only tasks that are already
   `LOCAL_GATE_PASSED` for the same repository and immutable base SHA and whose
   gated head is a strict ancestor of the head being captured; each candidate
   still has to pass the full successor proof. It prefers a parent gated for
   the same requirement, and when none exists it records the parent's
   requirement and `requirement_match: false` in the proof so the reviewer
   knows the gate was granted while reviewing for different work. Naming a
   parent explicitly still requires the requirement to match exactly, because
   there a mismatch means you picked the wrong parent. The
   result reports `review_strategy.parent_selection` as `AUTOMATIC`,
   `EXPLICIT`, or `NONE`. Pass `parent_review_id` to pin a specific parent, and
   `force_full_review: true` to demand a full-patch review. Prefer letting a
   verified `SUCCESSOR` stand: on a long-lived branch its delta is a small
   fraction of the cumulative patch, and re-reviewing already-gated code costs
   the reviewer far more context than it buys.
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
    must read `successor.json` and all of `successor.diff` and inspect changed
    files plus relevant callers, contracts, and tests; it expands to
    `patch.diff` only for a cross-file contract change, a security or
    compatibility surface, or a proof that fails to verify. For `FULL`, it
    reads `patch.diff` through `current_snapshot.patch_index` and reports which
    sections it skipped.
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
- If the state is `HUMAN_REQUIRED`, call `get_review_summary`, then call
  `export_human_arbitration` with its exact `state_version`. Give the returned
  Markdown to the human or externally coordinated reviewer. The export is
  read-only and does not authorize publication. Do not start a third model
  round.

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
   run the packaged read-only `../../scripts/collect-github-observation.mjs`
   helper resolved relative to this SKILL as `--review-id <review_id>`, and
   call `record_github_snapshot` with the `observation_path` the helper prints.
   The helper reads the ledger from the store and writes the observation into
   the private store beside it — never into a repository worktree, where an
   untracked observation would dirty the tree and fail gate verification — so
   neither payload passes through this conversation. Then call
   `get_publication_summary`, present its complete
   `required_request_refs` and `required_ambiguous_results` sets to the human,
   and call `acknowledge_codex_review_ambiguity` only after direct approval of
   both exact sets and the `NO_FURTHER_RESULTS_EXPECTED` risk statement. If the
   baseline contains no open legacy or unsupported request, continue without
   an acknowledgement. A version-2 `BASELINE_CORRELATED` request with
   server-verified issuance provenance from another head is not a candidate for
   a later markerless result; an unverified, same-head, or legacy unscoped
   baseline request remains a candidate.
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
   resolved relative to this SKILL as `--review-id <review_id>`.
   The helper uses the user's authenticated `gh` CLI in read-only
   mode to collect the PR and both base comparisons, applicable rules, two
   independent branch reads, classic protection when applicable, every
   check-run page using `filter=all`, every commit-status page, all three Codex
   feeds, and all review-thread pages. It
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
9. If Codex reports an actionable finding, commit and verify the fix. Start a
    new local Review Bridge task in `LOCAL_GATE` mode or call
    `authorize_remote_publication` again in `REMOTE_ONLY` mode. A new commit
    invalidates this ledger and its prior GitHub Codex result.
10. After `MERGE_READY`, run the packaged collector once more with
    `--review-id <review_id>` for a final fresh GitHub observation and call
    `record_github_snapshot` with the printed `observation_path`, then call
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
