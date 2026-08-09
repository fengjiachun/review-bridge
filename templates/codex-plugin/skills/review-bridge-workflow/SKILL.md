---
name: review-bridge-workflow
description: Use when preparing local code for an isolated reviewer, handling findings, or publishing through local-gate or explicitly authorized remote-only GitHub review.
---

# Review Bridge workflow

Use the Review Bridge author tools to coordinate a manual, two-round review with
Claude Desktop or a fresh Codex reviewer task, or an explicitly authorized
remote-only GitHub publication.

## Autonomous local workflow

The schema-version-1 autonomous workflow is opt-in and currently advances
through the local `CODEX_TASK` gate, the reconciled push of the gated head,
the marker-bound draft pull request, the version-3 publication ledger, the
remote wait, the three repair loops that return a new head to local review,
the reply-then-resolve closure of eligible Codex finding threads, and the
mark-ready that takes the cleared pull request out of draft. It then records
one fresh complete observation of the ready pull request and evaluates the
`autonomous_terminal` projection; when that reports `MERGE_READY` it records
its terminal entry and stops deliberately. A blocker that arrives after the
pull request is ready — a contested resolution record, a new thread comment, a
stale observation — leaves the run stopped at `POST_READY` as operator work,
except that an actionable current-head finding, failed required check, or base
gap returns the ready pull request to draft before any repair.

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
   remote's single push URL into the intent; a push URL that embeds
   credentials is rejected before anything is persisted. Before marking
   `EXECUTING`, resolve the pinned `active_action.target.remote_url` to its
   GitHub repository and numeric repository ID through the provider, and
   call `mark_workflow_action_executing` with `resolved_repository_id` and
   `resolved_url`; the server refuses to record `EXECUTING` unless they
   equal the authorized target, so a remote repointed before planning can
   never receive the gated commit. Then push the immutable gated commit to
   the pinned URL by refspec — `git push <active_action.target.remote_url>
   <active_action.target.head_sha>:refs/heads/<topic_branch>`, both
   operands recovered from the persisted intent after a restart, never the
   mutable remote name or branch name. Never force-push. Review Bridge
   trusts the local Git environment and does not try to harden this `git
   push` against it: a controller that can rewrite local Git configuration
   or inject configuration through the environment already holds the gated
   commit and can disclose it directly, so hardening the invocation defends
   nothing it does not already control. Integrity of the push target rests
   instead on the reconciliation below — a push diverted by any such
   rewrite leaves the authorized remote without the gated commit, so the
   observation fails and the workflow pauses `EXTERNAL_ACTION_INDETERMINATE`
   rather than completing; its only residual effect is disclosing a commit
   the local attacker already holds. Reconcile from the provider, never
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

   Once a pull request exists, that pre-read also reports its draft state, as
   `pull_request_is_draft`. A visible pull request drops the push intent and
   moves the workflow to `ENSURE_DRAFT_FOR_REPAIR`: return it to draft there
   and the push is planned again from `LOCAL_GATE_PASSED`. This is the last
   point before the new head stands in front of reviewers, and no publication
   is bound here to answer for it, so your reading is the evidence — which is
   why it is trusted to stop the push and never to permit one.
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
   `record_draft_pull_request_observation` with those facts, including the
   exact marker comment extracted from the freshly read pull-request body —
   the server accepts only a byte-exact match with the marker it issued, so
   never report a boolean or a reconstructed string; then call
   `complete_workflow_action`, which atomically claims the pull request
   store-wide. A same-branch pull request without the marker, a non-draft
   match, or multiple matches pauses; branch equality alone never establishes
   ownership.
10. For `START_PUBLICATION`, follow the `LOCAL_GATE` publication steps below to
    collect the complete fresh baseline, but call `start_publication` with the
    workflow's `workflow_id` and current `expected_workflow_revision`. That
    creates a version-3 ledger which keeps the existing `authorization` object
    and separately binds the workflow authorization digest. Post and
    immediately bind the exact server-generated Codex request through
    `record_codex_review_request` as usual — the publication ledger owns
    request generation, binding, and unbound detection, and the workflow adds
    no second mechanism. Then call `bind_workflow_publication` with the
    publication's `review_id`.
11. For `WAIT_PUBLICATION`, run the packaged observation collector, call
    `record_github_snapshot`, then call `advance_remote_workflow`. Read the
    projection with `get_autonomous_pre_ready`: it evaluates every publication
    invariant in its normal fail-closed order and ignores only the draft flag,
    so `READY_TO_MARK` is the only status that proves a draft pull request is
    otherwise complete. Never treat the manual summary's
    `next_action: MARK_PULL_REQUEST_READY` as that proof; it fires on
    `PR_DRAFT` alone, before any other invariant is evaluated. Keep waiting
    while checks or review are still settling. `EVIDENCE_STALE` means the
    observation aged out: collect a fresh one rather than acting on it.
    Unresolved review threads no longer stop the run outright: when
    `get_thread_resolution_plan` reports at least one eligible thread the
    workflow enters `RESOLVE_CODEX_THREADS`. Answer the thread with
    `plan_thread_reply`, record a fresh observation so the reply is in the
    watermark, then close it with `plan_thread_resolution`. After the resolve
    call is observed, call `record_automatic_resolution` before
    `complete_workflow_action`: the server-owned record is what the
    completion requires. Two outcomes need no record. An
    `OBSERVED_PRE_RESOLVED` resolution claims nothing, so there is nothing to
    record and the action closes on its own. The other is a publication that
    has gone terminal — the pull request merged, closed, or the head diverged
    — while the resolution was in flight. That ledger accepts no write, so
    `record_automatic_resolution` fails `PUBLICATION_TERMINAL` and the
    completion stops requiring it; complete the action, after which the
    remote wait pauses `PUBLICATION_INVALIDATED` like any other terminal
    publication — a resume from there re-enters `IMPLEMENTING` for a new
    head. Otherwise `advance_remote_workflow` returns the
    workflow to the wait. Threads the
    plan refuses stay operator work. An idle poll that observes no
    change costs no workflow revision, so waiting needs no backoff
    bookkeeping.

    When the pre-ready projection reports an invalidated workflow-owned
    resolution, call `get_invalidated_resolution_plan`; only an
    `actionable: true` result may be passed to `plan_thread_unresolve` for its
    exact thread. Immediately before the provider call, read the authorized
    repository ID, pull-request number, thread ID, resolution state, and exact
    `new_watermark`, then persist that proof with
    `mark_workflow_action_executing`. If the thread is already unresolved,
    issue no mutation and record `OBSERVED_ALREADY_UNRESOLVED`; otherwise
    issue the unresolve and record `UNRESOLVED`. Call
    `record_automatic_unresolve`; it appends the server-owned `INVALIDATED`
    and `UNRESOLVED_FOR_REPAIR` events and clears the stale observation. Then
    collect and record a fresh complete GitHub snapshot before
    `complete_workflow_action`, restoring proof for every unaffected thread.
    If the publication becomes terminal while
    the unresolve is in flight, it accepts no lifecycle write; complete the
    observed action without one and let the remote wait pause the terminal
    publication, exactly like a terminal in-flight resolution. A pinned-Codex
    follow-up next runs the
    return-to-draft action (an already-draft pre-read is a no-op) before it
    enters the remote repair path. Human or unknown participation performs the
    same compensating unresolve and then pauses `THREAD_RESOLUTION_UNSAFE`.
    During reconciliation
    repeat the external unresolve only while the same server plan remains
    actionable for the same workflow, pull request, thread, record, and
    watermark; never use a controller pre-read to authorize or discard a
    different durable intent.

    When the projection reports `GITHUB_REVIEW_NOT_REQUESTED` — which is what
    an acknowledged ambiguity leaves behind — post the exact
    `codex_review_request.body` it returns and immediately bind it with
    `record_codex_review_request`. Take that body only from this projection
    while the pull request is draft: the manual summary evaluates `PR_DRAFT`
    before Codex status and so never offers it, and the version-2 request ID is
    server-derived with no other source.
12. `advance_remote_workflow` routes an actionable machine finding to
    `ADDRESS_REMOTE_FINDINGS`, a failed required check to
    `ADDRESS_CHECK_FAILURE`, and a strict-policy base gap to
    `UPDATE_FROM_BASE`. All three end the same way: fix only the recorded
    requirement, verify, commit, and call `record_workflow_head`, which returns
    the workflow to `PREPARE_LOCAL_REVIEW` and drops the old publication
    binding. The new head needs a new local review, gate, push, and
    publication; the previous ledger stays on disk as history and can never
    authorize it. Prefer letting the successor strategy stand for that review.

    A repair phase is left only by recording a new head. If the blocker clears
    on its own — a required check that failed and then passed on a rerun with
    no code change — the workflow stays in its repair phase, and the operator
    either commits a fix or cancels the workflow. Do not create an empty commit
    to escape one. `advance_remote_workflow` accepts `WAIT_PUBLICATION`,
    `RESOLVE_CODEX_THREADS`, `PRE_READY`, and `POST_READY`, and only with no
    action in flight: it is how the thread loop returns to the wait, how the
    pre-ready stop reacts to a clearance that moved, and how the post-ready
    stop reaches its terminal record. It refuses a repair
    phase except to send it to the draft restoration described next.
13. The server routes to `ENSURE_DRAFT_FOR_REPAIR` whenever the next thing
    the workflow would push a head for is blocked by a pull request that is
    out of draft: every repair ends in a new head pushed to it, and one
    reviewers can already see must not receive it. Call
    `plan_return_to_draft` there, pre-read the pull request, issue the call
    only if that pre-read finds it ready, and reconcile with
    `record_return_to_draft_observation` — `RETURNED_TO_DRAFT` after your own
    call, `OBSERVED_ALREADY_DRAFT` when the pre-read already found it draft.
    If the pull request closes or merges while that action is in flight, it
    can never report the draft state its reconciliation needs. With a
    publication bound, `abandon_workflow_action` settles it on that observed
    state and the wait pauses the terminal publication as always. With none
    bound — the restoration reached from a refused push — there is nothing
    left for this workflow to do: its pull request is gone, so no head can be
    pushed to it and no draft can be returned to. Pause
    `EXTERNAL_ACTION_INDETERMINATE` and cancel. That cancellation is the
    cheap one where it usually is not: releasing the claims needs the bound
    pull request proven closed, which is exactly what has happened, alongside
    the ordinary proofs that the local branch and the head ref are gone. Completion returns the workflow to the wait, which re-derives the
    blocker as ordinary work — the diverted repair is not counted as an attempt, so
    it resumes rather than stalling `NO_PROGRESS` on a position it never
    tried. A terminal publication — closed, merged, or invalidated — is
    the one case this does not answer, and deliberately: it records no
    further observation, so its last reading is frozen and could never
    report the pull request as a draft again however many times it became
    one. The wait pauses it as always, and the publication started for the
    next head is what reads the pull request afresh. The phase is
    advanceable, so if someone else returns the pull request to draft the
    workflow moves on rather than waiting for an action with nothing to
    do. `record_workflow_head` refuses with
    `WORKFLOW_PULL_REQUEST_EXPOSED` on the same evidence, and a repair phase
    that hits it advances back through this transition rather than stalling.
    A cleared publication is unaffected: it reaches the pre-ready stop, where
    an already-ready pull request reconciles `OBSERVED_ALREADY_READY` without
    claiming a mutation.
14. The server pauses `GITHUB_REVIEW_AMBIGUOUS` on an ambiguous or
    unbound result, `SEMANTIC_CONFLICT` on a conflicting merge state,
    `PUBLICATION_INVALIDATED` when the pull request or head diverged from the
    authorization, and `NO_PROGRESS` when an attempt's normalized blockers and
    either its head or its tree match any earlier recorded attempt — not only
    the one before it. Pause yourself
    with `REQUIRED_CHECK_UNACTIONABLE` when logs or required evidence are
    unavailable, the failure is external or administrative, a required secret
    or permission is missing, or the fix would exceed the recorded
    requirement; with `SEMANTIC_CONFLICT` when merging the fresh base does not
    apply cleanly, and with `HISTORY_REWRITE_REQUIRED` when it would need a
    rewrite — that last one cannot be resumed, because every workflow head must
    descend from the last, so it ends in cancellation. Never waive, remove, or
    rename a required check, and never rebase or force-push to resolve one.
15. At `PRE_READY`, call `plan_mark_pull_request_ready`. It refuses unless the
    publication's own projection is `READY_TO_MARK` on this exact head, and it
    records which observation cleared it. A refusal here changes nothing —
    the clearance simply moved between the advance and this call — so call
    `advance_remote_workflow` and let it route the new blocker. Where that
    lands is the blocker's business, not this step's: a machine finding, a
    failed check, or a base gap enters a repair phase you leave only by
    recording a new head, exactly as step 12 describes, while something that
    settles on its own returns to this stop. Read the live pull request
    immediately before the call and pass it as the executing proof; if that
    pre-read already shows it out of draft on this head, issue no mutation and
    reconcile with `OBSERVED_ALREADY_READY`.

    That checkpoint re-reads the clearance. If the publication regressed
    since planning, it refuses with `WORKFLOW_PUBLICATION_NOT_READY` and
    drops the planned intent — the response says so in
    `details.action_abandoned` — leaving the workflow in `WAIT_PUBLICATION`
    at the revision the error reports, where the ordinary routing owns the
    new blocker. Lock contention and every other failure of the read itself
    are retryable and drop nothing.

    One pre-read sends the dropped intent somewhere else: one that found the
    pull request already out of draft. The repair phases the wait routes into
    push new commits, and a pull request already visible for review must not
    receive them, so that intent lands in `ENSURE_DRAFT_FOR_REPAIR` instead —
    return it to draft there, and the blocker becomes ordinary work.

    The checkpoint runs once, before the one call this action makes. If you
    crash after it, reconcile by reading the pull request. Found ready,
    record `MARKED_READY` — your own pre-read proved it was draft before this
    action's call. Reconcile either outcome with
    `record_mark_ready_observation` and close the action with
    `complete_workflow_action`, which is what sets `POST_READY`.

    Found still draft, read `get_autonomous_pre_ready` again before
    re-issuing: there is no second server checkpoint, so on this path you are
    the one enforcing it. Re-issue only while it still reports
    `READY_TO_MARK` on this exact head — that call is safe whether or not an
    earlier attempt landed, since the pull request ends ready either way and
    your recorded pre-read decides the outcome you may claim. If the
    clearance regressed, do not call: marking ready there would expose a head
    with a standing blocker to reviewers before the return-to-draft undo could
    make the repair legal.
    Do not plan around a second checkpoint either; there is none, and nothing
    you can read decides whether an earlier call landed (GitHub attests no
    actor for a draft transition). Call `abandon_workflow_action` instead.
    Record a fresh observation first: the server drops the action only on one
    taken *after* the action executed, since an older one shows a draft pull
    request simply because the call had not happened yet, and it refuses a
    stale projection for the same reason. It also refuses while the
    observation shows the pull request out of draft, because then the action
    performed the transition its pre-read predicted and reconciling it is the
    honest close.

16. At `POST_READY`, the workflow summary advertises
    `RECORD_FRESH_OBSERVATION_AND_ADVANCE` while the workflow is still
    `ACTIVE`: record one fresh complete observation of the ready pull request
    (`record_github_snapshot`), then call `advance_remote_workflow`. Do not
    stop at `AWAIT_OPERATOR` here — the run still owes the server that
    observation. The server evaluates it through the `autonomous_terminal`
    projection: it requires publication `MERGE_READY`, revalidates the
    workflow binding and both authorization digests, and replays every
    automatic-resolution record and lifecycle chain against the same
    observation. Only when the projection reports `MERGE_READY` — and the
    observation was recorded after the clearance the mark-ready consumed —
    does the workflow record its terminal entry, set status `MERGE_READY`, and
    stop. A terminal workflow refuses every further mutation; it never calls
    `verify_publication_gate` and never merges. Merging is the operator's
    later explicit instruction through the existing manual path, and the
    operator's post-merge reconciliation cleanup can still release the
    workflow's claims (`release_workflow_claims` accepts a `MERGE_READY`
    workflow) so a later run can reuse the topic branch.

    Any other terminal verdict keeps the run stopped at `POST_READY`: a
    contested resolution record, a new thread comment, a stale observation, or
    an unresolved thread is operator work. Once the first blocked evaluation
    is recorded, the summary advertises `AWAIT_OPERATOR` — do not keep
    re-collecting snapshots; the operator decides, and only an explicit
    operator instruction resumes the loop. An actionable current-head machine
    finding, failed required check, or strict-policy base gap is the one route
    out: `advance_remote_workflow` sends the visible pull request to
    `ENSURE_DRAFT_FOR_REPAIR` first, exactly as step 13 describes, and the
    repair loop then runs as usual. A draft pull request in the post-ready
    observation is never a success — record another observation only after
    the pull request is genuinely ready.

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
   - `HERMES` for a fresh, independent Hermes reviewer context using the
     packaged Hermes reviewer profile.
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
   ID and a request to follow the packaged reviewer skill. For `HERMES`, start
   a fresh, independent Hermes reviewer context in the packaged Hermes reviewer
   profile, and send it only the review ID and a request to follow the packaged
   reviewer skill. A round-two rereview of the same ID may stay in that reviewer
   context.
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

The fourteen publication tools are `authorize_remote_publication`,
`start_publication`, `get_publication`, `get_publication_summary`,
`get_autonomous_pre_ready`, `get_thread_resolution_plan`,
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
