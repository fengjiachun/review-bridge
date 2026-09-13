## Autonomous workflow

Load this route only after its direct authorization below. At START_PUBLICATION,
load [Publish through GitHub](publication.md). For local waits, use the shared
waiting rules in [the entrypoint](../SKILL.md).

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
   `next_action`. Every summary carries `required_inputs`, which names the
   calls that action implies as `{tool: [[field, source], ...]}`. Take each
   call's arguments from it rather than discovering them by sending empty ones.
3. For `COMMIT_HEAD`, estimate added plus deleted lines before editing. Real
   diffs commonly exceed estimates, so if the change is likely to approach the
   workflow's `change_size_budget`, discuss splitting it before implementation.
   Then implement only the recorded requirement and test it. Before this
   commit and every later fix commit the workflow records, remove comments
   that do not state a constraint the code cannot express — a comment narrating the diff, the fix process, or addressed
   review feedback is noise — and remove tests that no behavior change can
   turn red. Then commit without rewriting published history, require a clean
   worktree, and call `record_workflow_head` with the full `HEAD`.
4. For `PREPARE_LOCAL_REVIEW`, call `prepare_review` with the workflow's full
   base SHA, exact requirement and scope, and `CODEX_TASK`. If the latest
   `local_review_cycles` entry has an addressed head but no follow-up review,
   also pass its `continued_from_review_id` and `force_full_review: true`.
   Then call `bind_workflow_review` at the workflow's current revision. If it
   refuses `WORKFLOW_CHANGE_SIZE_WARNING_UNACKNOWLEDGED`, an earlier crossing
   still demands its split decision: present the recorded crossing total, and
   only an explicit operator decision may call
   `acknowledge_change_size_warning` with `continue` and its stated reason or
   `split` and the intended cut. After `continue`, bind again. After `split`,
   commit the intended cut as a descendant head on the topic branch, call
   `record_workflow_head`, prepare a fresh review over the reduced head with
   the same continuation parameters, and bind that instead; the gate stays
   closed while the measured change still reaches the acknowledged crossing
   total — an empty, reverted, or grown descendant does not release it — and
   only a
   `continue` re-acknowledgment releases it without the cut. If the bind returns
   `current_review.change_size.warning_threshold_crossed`, state the
   immutable total and `remaining_headroom` in the session. The round this
   snapshot starts proceeds unblocked, but the workflow refuses to prepare
   the next review round until the crossing is acknowledged the same way,
   and after a `continue` a later, strictly larger crossing re-arms the
   demand. If it
   pauses `CHANGE_SIZE_BUDGET_EXCEEDED`, present the immutable added, deleted,
   and total line counts and the current budget to the operator. No reviewer
   task has been dispatched. Only an explicit decision may call
   `extend_change_size_budget`; resume separately after the new budget admits
   the measured total.
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
   This remeasures each newly captured rereview snapshot. If it pauses
   `CHANGE_SIZE_BUDGET_EXCEEDED`, report the new total and headroom; extend the
   budget only after an explicit operator decision, then resume separately.
   A rereview snapshot that crosses the warning threshold still completes
   its own round; state its total and `remaining_headroom` when it does.
   If the advance refuses `WORKFLOW_CHANGE_SIZE_WARNING_UNACKNOWLEDGED`, the
   crossed warning demands its split decision before the next round: state
   the crossing total, and only an explicit operator decision may call
   `acknowledge_change_size_warning` with `continue` and its stated reason
   or `split` and the intended cut. After `continue`, advance again; after
   `split`, commit the intended cut as a descendant head and call
   `record_workflow_head` before continuing — the gate stays closed while
   the measured change still reaches the acknowledged crossing total.
   When a round reports findings, call `get_review` and narrate every finding
   from its authoritative `findings` with the ID, severity, one-line summary,
   and location. Address the findings and, when any disposition is `fixed`,
   apply the pre-commit cleanup and record a committed descendant fix head
   before submitting resolutions. After
   `submit_resolutions`, call `get_review` again and narrate each persisted
   disposition, rationale, and evidence from its `resolutions`. After
   `prepare_rereview` captures the result, call `get_review` again. When any
   disposition was `fixed`, compare the preceding and latest rounds'
   authoritative `head_sha` values with `git diff --name-only` to derive the
   actual fix files, and narrate those files with the latest `head_sha` as the
   fix commit. For a rebuttal-only
   rereview, state that no code commit was required. Round two
   reuses the same reviewer task. When its result arrives, call `get_review`
   again and narrate every per-finding decision and any new finding from its
   `rereview_decisions` and `findings`. A contested `HUMAN_REQUIRED`
   review pauses the workflow; state the escalation and why it needs a human.
   Any author `human_required` resolution moves directly to `HUMAN_REQUIRED`
   without capturing a rereview round. Narrate the persisted resolutions and
   escalation reason, then stop for human arbitration. If the same submission
   also contains a fixed resolution, state that its files and commit are not
   yet bound in the ledger; never infer them from the workspace or session
   text.
   New uncontested round-two findings enter `ADDRESS_LOCAL_FINDINGS`; present
   the source ledger's `OPEN` findings, address them on a changed committed
   head after the same pre-commit cleanup, and let the next new `FULL` review
   inspect its `carried_findings` independently. Never add a third model round to the
   same review ID. If the
   workflow pauses `LOCAL_CYCLE_BUDGET_EXHAUSTED`, show the complete
   `local_review_cycles` chain to the operator; only an explicit decision may
   call `extend_local_cycle_budget`, followed separately by
   `resume_autonomous_workflow`.
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
10. For `START_PUBLICATION`, follow the `LOCAL_GATE` steps in [Publish through GitHub](publication.md) to
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
    plan refuses stay operator work. An unchanged observation does not advance the workflow revision.
    This is a ledger rule, not a polling cadence: prefer supported state-change
    waits or long polling. For remote GitHub observations, back off on
    unchanged results, respect rate-limit and retry signals, and reset the
    cadence when relevant state changes. Do not run the collector in a tight loop.

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
    If that snapshot shows another workflow-owned resolution was invalidated
    concurrently, completion stays in `RESOLVE_CODEX_THREADS`; repeat the same
    plan, observe, lifecycle, refresh, and completion sequence until every
    invalidated record is drained. Only then enter the return-to-draft repair.
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
    requirement, verify, apply the pre-commit cleanup, commit, and call
    `record_workflow_head`, which returns
    the workflow to `PREPARE_LOCAL_REVIEW` and drops the old publication
    binding. The new head needs a new local review, gate, push, and
    publication; the previous ledger stays on disk as history and can never
    authorize it. That review is a successor by default: leave
    `parent_review_id` unset and `force_full_review` off, and the server selects
    the gate the repaired head descends from, so the reviewed unit is the repair
    delta rather than the whole change again. A remote finding is the case
    successor selection was built for — the parent gate, the parent head, and
    strict descent are all already known.

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

    The remote repair loop also has a server-owned cycle budget, defaulting to
    12 and counted from non-diverted `remote_attempts`. When the workflow pauses
    `REMOTE_CYCLE_BUDGET_EXHAUSTED`, present the complete recorded attempt chain
    to the operator. Only after an explicit operator decision call
    `extend_remote_cycle_budget` with the larger value, label, and rationale;
    then call `resume_autonomous_workflow`. Extension is audited, does not
    resume by itself, and does not change the authorization digest.
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
