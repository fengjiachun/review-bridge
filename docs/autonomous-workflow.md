# Autonomous workflow

Describes Review Bridge v0.15.3.

An explicitly authorized schema-version-1 workflow persists RFC 0003's
autonomous path, from implementation through the local gate and draft
publication to the recorded terminal state:

```text
IMPLEMENTING
  -> committed clean head
  -> bound CODEX_TASK review
  -> marker-reconciled independent reviewer task
  -> local findings and round two when needed
  -> LOCAL_GATE_PASSED
  -> reconciled fast-forward push of the exact gated head
  -> marker-bound draft pull request, claimed store-wide
  -> version-3 publication bound to the workflow authorization
  -> WAIT_PUBLICATION
       ├─ machine finding      -> ADDRESS_REMOTE_FINDINGS ─┐
       ├─ required check fails -> ADDRESS_CHECK_FAILURE  ──┤-> COMMIT_HEAD
       ├─ base gap             -> UPDATE_FROM_BASE       ──┘   -> new local review
       ├─ ambiguity, conflict, unsafe invalidation, or no progress -> PAUSED_HUMAN
       ├─ any head to push while the pull request is out of draft
       │    -> ENSURE_DRAFT_FOR_REPAIR -> back to WAIT_PUBLICATION
       │       (recording a head refuses on the same evidence)
       ├─ eligible Codex finding thread -> RESOLVE_CODEX_THREADS
       │    -> recorded reply -> proven resolution -> back to WAIT_PUBLICATION
       │    -> later pinned-Codex follow-up -> proven unresolve
       │       -> return to draft -> ADDRESS_REMOTE_FINDINGS
       │    (a publication that goes terminal mid-resolution closes the
       │     action without a resolution or unresolution record and pauses)
       └─ every other invariant passes -> PRE_READY
            -> MARK_PR_READY on the re-read clearance -> POST_READY
                 -> fresh post-ready observation
                 -> autonomous_terminal MERGE_READY -> terminal record, stop
                    (actionable finding/check/base gap returns to draft first;
                     any other blocker stays stopped as operator work)
```

`start_autonomous_workflow` binds the immutable repository, base, requirement,
topic branch, publication target, complete capability set, and authorization
digest. Store-wide claims admit only one active or paused owner for the local
branch, the GitHub head ref, and — once a draft pull request is bound — the
exact pull request. Every external action (reviewer task dispatch, gated-head
push, draft pull-request creation, thread reply, thread resolution,
mark-ready) persists
`PLANNED -> EXECUTING -> OBSERVED -> COMPLETED` in a digest-chained action
audit and recover one committed crash-tail event before another mutation.
The complete marker-bound task title and prompt remain in the active action and
compact summary, so a restarted controller reuses the persisted dispatch
instead of replanning or reconstructing it.
Pause and cancellation are committed to the same audit chain, so recovery
replays a durable stop with its bound review and finding state, or rejects a
stale active ledger before another write.
Ownership claims live in each workflow ledger: the atomic `workflow.json`
write is the single claim commit point, starts scan every persisted ledger for
conflicts under one store-wide lock, and a crashed start leaves no claims
behind. Every start and mutation also reserves the full worst-case
cancellation — both the bounded audit event and the resulting near-limit
ledger — so an admitted workflow can always persist an operator cancellation.

The compact workflow summary is the controller's source of truth for the next
action. A missing or ambiguous Codex task pauses rather than falling back to
the author task. A contested round-two finding becomes `HUMAN_REQUIRED` and
pauses. Uncontested new round-two findings become `CONTINUABLE_FINDINGS`: the
workflow records their IDs and fingerprints, enters `ADDRESS_LOCAL_FINDINGS`,
requires a changed committed head, and binds a new `FULL` review carrying only
the source finding descriptions as scope hints. No review ID receives a third
model round. Cancellation retains claims until an explicit,
exactly-reconciled release proves each branch and head ref absent — and each
bound pull request closed — with a fresh observation bound to the current
workflow revision and canonical claim target.

An autonomous publication is publication schema version 3: it keeps the
version-2 `authorization` object and its `source_sha256` meaning unchanged and
separately binds `workflow_id` and `workflow_authorization_sha256`, in both the
ledger and `publication-gate.json`. Start, snapshot recording, the autonomous
projection, finalization, and gate verification each revalidate both digests
against the workflow ledger itself, and any mismatch fails closed. Version-1
and version-2 ledgers keep their exact existing behavior and can never bind a
workflow.

`get_autonomous_pre_ready` is the only proof that a draft pull request is
otherwise complete. It is the same evaluator as the manual status in the same
fail-closed order, with the draft flag alone ignored, so a blocker can never
pass there and fail here; the manual `PR_DRAFT` and `MARK_PULL_REQUEST_READY`
behavior is unchanged. An attempt whose normalized blockers and either head or
tree match *any* earlier recorded attempt pauses `NO_PROGRESS`, so an
oscillating tree or an alternating blocker cannot walk around the check by
never repeating adjacently.

The autonomous workflow also defaults to a 2000-line change-size budget,
measured as added plus deleted lines from the immutable snapshot patch. An
internal warning threshold at 75% reports the measured total and remaining
headroom. The review round in flight when a snapshot crosses it completes
normally, but the workflow refuses to prepare the next round until
`acknowledge_change_size_warning` records the explicit split decision —
`continue` with a stated reason or `split` with the intended cut — and after
a `continue`, a later, strictly larger crossing re-arms the demand. A
recorded split keeps the gate closed until the cut shrinks the measured
change below the acknowledged crossing, or
the decision is re-acknowledged as `continue`. An
oversized snapshot binds normally but
pauses with
`CHANGE_SIZE_BUDGET_EXCEEDED` before a reviewer task is dispatched.
The same check runs again before an existing reviewer task is reused for a
newly captured rereview snapshot. Pre-upgrade bound reviews derive any missing
measurement from their immutable patch before dispatch.
`extend_change_size_budget` records an explicit increase; the operator resumes
separately after the new budget admits the measured total. Manual
`prepare_review` reports the same measurement against the default but never
blocks. Estimating and discussing a split before writing remains a driver
obligation because no snapshot exists yet.

The local continuation and remote repair loops each default to a 12-cycle
budget. Local cycles are counted when an addressed head is recorded;
exhaustion pauses with `LOCAL_CYCLE_BUDGET_EXHAUSTED` and the complete
continuation chain before another repair starts. `extend_local_cycle_budget`
records an explicit increase. The workflow ledger retains that complete chain;
ordinary audit events bind its digest, while an event that changes the chain
carries only an append-or-patch delta for the latest cycle, keeping audit-log
growth linear. The remote count is projected from non-diverted
`remote_attempts`; exhausting it pauses with
`REMOTE_CYCLE_BUDGET_EXHAUSTED` and the complete attempt chain before another
repair starts. `extend_remote_cycle_budget` records an explicit increase in the
workflow audit, after which the operator uses the ordinary resume path. All
three budgets are mutable workflow state, not part of the immutable
authorization digest, and older ledgers that lack them load with the defaults.

This release closes eligible Codex finding threads with a recorded reply and a
server-owned resolution proof, and marks the cleared pull request ready: the
mark-ready intent records which observation cleared the head, and the
clearance is read again immediately before the call, so a publication that
regresses after planning refuses the write rather than exposing a head with a
standing blocker. That checkpoint runs once, before the single call the
action makes; a controller re-issuing the call after a crash re-reads the
clearance itself, and a crash it cannot settle that way is abandoned on the
publication's own recorded observation rather than on anything the driver
claims.

It also returns the pull request to draft whenever the next thing it would
push a head for is blocked by one that is already visible for review, so no
head reaches a pull request reviewers are looking at. Two kinds of evidence
answer that question, and each is trusted in one direction only: a live
publication's recorded observation, which can refuse a repair, and the
controller's own pre-read immediately before the push, which can stop that
push but never permit one. A terminal publication answers nothing — its
reading is frozen — which is why the push carries its own.

After the mark-ready action completes, the controller records one fresh
complete observation of the ready pull request, and the run evaluates it
through the `autonomous_terminal` projection: the same fail-closed invariant
order with the draft flag *not* ignored, then an independent revalidation of
the workflow binding and both authorization digests, then a complete replay of
every automatic-resolution record and lifecycle chain against that same
observation. Only a projection that reports `MERGE_READY` over an observation
recorded after the clearance the mark-ready consumed lets the workflow record
its terminal entry (status, workflow revision, pull request identity and URL,
exact head, local review and publication IDs, post-ready observation revision
and digest, both authorization digests, and the record-and-lifecycle-set
digest), set status `MERGE_READY`, and stop. It never calls
`verify_publication_gate` and never merges; a later operator merge instruction
goes through the existing manual path unchanged. An invalidated active
resolution frontier, a missing or extra record, a broken supersession chain, a
mismatched active record, or human participation in a resolved thread blocks
the terminal projection with its own reason even when the publication status
is `MERGE_READY`, and a valid superseded predecessor stays audit evidence
rather than being compared against the current watermark. An actionable
current-head finding, failed required check, or strict-policy base gap in the
post-ready observation returns the ready pull request to draft before repair;
anything else that blocks after the pull request is ready — a contested
resolution, a new thread comment, a stale observation, an unresolved thread —
remains operator work. Threads the eligibility plan refuses also remain
operator work. The manual flow in [GitHub publication gate](publication-gate.md) remains unchanged.
