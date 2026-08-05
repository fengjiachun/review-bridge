# RFC 0003: Autonomous review and publication workflow

| Field | Value |
| --- | --- |
| Status | Accepted |
| Authors | Review Bridge contributors |
| Created | 2026-07-29 |
| Target release | TBD |
| Amends | RFC 0001 |

If accepted, this RFC supersedes RFC 0001's human-only resolution requirement
only for eligible workflow-owned Codex threads, whether GitHub considers them
outdated or not. It does not change the rule that every unresolved review
thread blocks `MERGE_READY`.

## Summary

Add an explicitly authorized, Codex-driven workflow that advances one change
from implementation through:

1. a committed local head;
2. an independent `CODEX_TASK` review and local gate;
3. a draft GitHub pull request;
4. a correlated GitHub Codex review and required checks;
5. fix, successor-review, and remote-rereview cycles; and
6. evidence-backed resolution of workflow-owned Codex threads.

The workflow stops at `MERGE_READY`, ready for human review or a separately
authorized merge. It does not merge the pull request.

A new workflow ledger persists the requirement, authorization, exact base,
branch, pull request, review chain, current head, external-action intents, and
stop reason. The ledger lets a later Codex turn reconcile live state and resume
without silently skipping a gate or blindly repeating an external write.

Review Bridge remains the state and evidence validator. The author-side Codex
skill remains the executor that edits code, creates independent Codex tasks,
and uses the user's configured GitHub integration. The Review Bridge MCP server
does not receive GitHub credentials and does not create Codex tasks.

## Motivation

Review Bridge already provides the two component state machines:

- local immutable review, rereview, and `LOCAL_GATE_PASSED`; and
- GitHub publication evidence, correlated Codex results, required checks,
  review threads, and `MERGE_READY`.

The current author workflow connects those components through instructions in
the active Codex conversation. The operator or author agent must create a fresh
reviewer task, wait for it, address findings, publish the reviewed head, request
GitHub review, inspect the result, and repeat the entire local path after every
fix commit.

That process is safe when every instruction is followed, but it is not a
durable autonomous workflow. A context compaction, process restart, delayed
GitHub result, or crash between an external write and its local record can
leave the next author turn unable to prove what was already done. Repeating the
step may create duplicate reviewer tasks, pull requests, review requests, or
thread mutations. Skipping it may apply evidence from the wrong head.

The desired operator experience is one explicit request: implement the stated
change and run the full Review Bridge workflow until the pull request is ready
for human review or requires a human decision. The common path should not stop
merely to ask the operator to create a Codex task, poll GitHub, or resolve a
Codex thread whose fix has already been independently verified.

## Terminology

- **Workflow**: one autonomous run for one repository, immutable requirement,
  immutable reviewed base, and topic branch.
- **Author task**: the Codex task that implements the change and orchestrates
  the workflow.
- **Reviewer task**: a newly created Codex task that receives a Review Bridge
  `review_id`, one required opaque dispatch marker, and an instruction to use the
  packaged reviewer skill.
- **Head attempt**: one committed topic-branch head that enters local review.
- **Local review chain**: the ordered `review_id` values for all head attempts
  in the workflow.
- **Publication attempt**: the publication ledger bound to one locally gated
  head and one pull request.
- **Workflow-owned request**: a GitHub Codex review request generated and bound
  by the publication ledger.
- **Workflow-owned Codex thread**: a GitHub review thread whose root finding is
  structurally attached to a correlated workflow-owned Codex review from the
  pinned Codex Bot.
- **Thread watermark**: a server-derived digest of one complete, ordered,
  paginated thread-comment sequence and its stable comment identities and
  actors. Resolution state is observed alongside the watermark so the comment
  watermark remains comparable across a resolve mutation.
- **External action**: a mutation outside the Review Bridge store, such as
  creating a Codex task, pushing a ref, opening a pull request, marking it
  ready, or resolving a review thread.
- **Progress fingerprint**: the immutable head plus the normalized set of
  blocking findings or checks used to detect a no-progress loop.

## Goals

- Start only after the operator explicitly authorizes autonomous mode for a
  repository, requirement, base, and topic branch.
- Drive the normal path from implementation to `MERGE_READY` without routine
  operator intervention.
- Create a fresh, non-forked `CODEX_TASK` reviewer for every new `review_id`.
- Preserve the existing two-round local-review limit for each `review_id`.
- Use a verified `SUCCESSOR` review when its existing preconditions hold and
  retain the existing `FULL` fallback.
- Require every changed head to pass a new local gate before it is pushed as a
  publication head.
- Require a fresh correlated GitHub Codex result and current required checks
  for every publication head.
- Persist enough workflow and external-action state to reconcile and resume
  after interruption.
- Automatically resolve only workflow-owned Codex threads whose fixes have
  passed both a new local gate and a correlated remote `CLEAN` result.
- Keep every actual unresolved review thread blocking until GitHub reports it
  resolved in a fresh complete observation.
- Stop and export a precise reason whenever safe automatic progress is not
  possible.

## Non-goals

- Automatically merge a pull request.
- Replace human review, branch protection, rulesets, or required checks.
- Automate a `CLAUDE_DESKTOP` reviewer.
- Resolve, dismiss, or override a human review or a thread with unknown
  provenance.
- Turn an ambiguous GitHub Codex result into a passing result.
- Infer approval for `LOCAL_REVIEW_SKIPPED`,
  `AUTOMATIC_QUIESCENCE_ACKNOWLEDGED`, or
  `NO_FURTHER_RESULTS_EXPECTED`.
- Guarantee that Codex can repair every CI failure, merge conflict, or semantic
  disagreement.
- Give the Review Bridge MCP server GitHub credentials or direct access to the
  Codex task service.
- Provide cryptographic identity for either a local Codex task or GitHub
  evidence.
- Promise distributed exactly-once execution across Review Bridge, Codex, Git,
  and GitHub. The workflow instead uses durable intent plus reconciliation.
- Support remote review providers other than GitHub Codex in the first
  implementation.

## Operator authorization

Autonomous mode is opt-in. A general instruction to review code, run tests, or
prepare a local gate is not enough.

The author must record direct operator authorization containing:

- repository path;
- immutable base SHA, resolved from an operator-selected base ref;
- requirement;
- topic branch;
- publication target repository and base branch; the target includes the
  GitHub repository's stable numeric ID;
- publication head repository, push remote, and head branch; the head
  repository also includes its stable numeric ID; and
- acknowledgement that the workflow may:
  - edit and test the scoped repository;
  - create commits on the topic branch;
  - create fresh independent Codex reviewer tasks;
  - push the topic branch;
  - create or update one draft pull request;
  - post workflow-generated GitHub Codex review requests;
  - mark the pull request ready after all other gates pass;
  - return a workflow-owned ready pull request to draft before repairing an
    actionable current-head machine finding, required-check failure, or
    required base update;
  - resolve eligible workflow-owned Codex threads; and
  - unresolve only a thread that this workflow previously resolved when the
    server has invalidated that resolution record.

This authorization does not include:

- merging;
- force-pushing or rebasing published history;
- resolving a human or unknown-provenance thread;
- changing the resolution state of a thread that the workflow did not resolve;
- dismissing a review;
- choosing `REMOTE_ONLY`;
- acknowledging result ambiguity or automatic-review quiescence; or
- changing another pull request or branch.

Those operations retain their existing direct-approval requirements.

The server canonicalizes the structured authorization payload, including its
exact capability set and publication target but excluding the digest field
itself, and stores a `workflow_authorization_sha256`. Every later workflow,
publication, and automatic thread-resolution transition rechecks that digest
and rejects a target or capability that was not in the original decision.
Free-form conversation history is not a substitute for the persisted
authorization.

If the base ref, target repository, or topic branch is ambiguous, the workflow
must obtain the missing choice before it starts. It must not silently choose
between `HEAD`, a stale remote-tracking branch, and the freshly fetched default
branch.

The first implementation starts from a clean worktree and a topic branch
created at the immutable base SHA. If the requested branch already exists, it
must point to that base and must not already own another open pull request. A
dirty worktree, unrelated branch commit, or existing open pull request requires
an explicit continuation design rather than being silently absorbed into a new
workflow.

## Capability boundaries

### Author-side Codex controller

The packaged Codex workflow skill is the controller. It:

- edits, tests, and commits code;
- calls the Review Bridge author tools;
- creates and waits for independent Codex reviewer tasks;
- uses the user's configured Git and GitHub tools;
- reconciles planned external actions with live provider state; and
- follows the server-derived workflow and publication next actions.

The controller is an executor, not an independent trust root. Review Bridge
validates immutable heads, state transitions, provider binding, and recorded
evidence.

### Review Bridge author server

The author server:

- persists the workflow ledger and action intents;
- binds the workflow to existing local-review and publication ledgers;
- validates transition preconditions and exact revisions;
- derives a compact next action;
- records pause and terminal reasons; and
- keeps the existing GitHub credential boundary.

It never invokes GitHub, changes the repository, creates a Codex task, or
claims that caller-supplied external evidence is authentic.

### Codex reviewer task

Every new `review_id` uses a newly created task, not a fork of the author task
and not a previously used reviewer task. The task receives only:

- the immutable `review_id`;
- one server-issued opaque dispatch marker used only for task discovery and
  reconciliation; and
- an instruction to follow the packaged reviewer skill.

The dispatch marker is mandatory for autonomous dispatch and appears in both
the task title and prompt. It contains no requirement, diff, finding, test
result, or authoring context.

Round two for that same `review_id` may reuse the same reviewer task. A new head
and new `review_id` require a new reviewer task.

If the Codex client cannot create, discover, or wait for an independent task,
the workflow pauses with `TASK_ORCHESTRATION_UNAVAILABLE`. It must not fall back
to reviewing in the author task.

Provider binding and task separation remain workflow attestations, not
authenticated model identity.

### GitHub integration

GitHub reads and writes use the user's configured Codex GitHub integration or
authenticated `gh` environment. The Review Bridge server receives normalized
evidence and stable external object identities, never credentials.

The expected Codex actor remains pinned by numeric actor ID and `Bot` type.
Login text is display metadata only.

## Workflow ledger

Workflow state is separate from local-review and publication state:

```text
workflows/<workflow_id>/
├── workflow.json
├── action-audit.jsonl
└── action-audit-head.json
```

`workflow.json` is a private, canonical JSON ledger. It contains:

```json
{
  "version": 1,
  "workflow_id": "rbwf-...",
  "revision": 1,
  "repository": {
    "path": "/absolute/repository/path",
    "git_common_dir": "/canonical/git/common/dir"
  },
  "requirement": "...",
  "base_ref": "origin/main",
  "base_sha": "<40 hexadecimal characters>",
  "topic_branch": "agent/example",
  "authorization": {
    "mode": "AUTONOMOUS_LOCAL_GATE",
    "operator_label": "...",
    "authorized_at": "UTC timestamp",
    "capabilities": [
      "EDIT_AND_TEST",
      "CREATE_COMMITS",
      "CREATE_CODEX_REVIEWER_TASKS",
      "PUSH_TOPIC_BRANCH",
      "CREATE_OR_UPDATE_DRAFT_PR",
      "POST_CODEX_REVIEW_REQUESTS",
      "MARK_PR_READY",
      "RETURN_PR_TO_DRAFT_FOR_REPAIR",
      "RESOLVE_ELIGIBLE_CODEX_THREADS",
      "UNRESOLVE_INVALIDATED_CODEX_THREADS"
    ],
    "publication_target": {
      "base_repository_id": 123,
      "base_owner": "owner",
      "base_repo": "repo",
      "base_branch": "main",
      "head_repository_id": 123,
      "head_owner": "owner",
      "head_repo": "repo",
      "head_branch": "agent/example",
      "push_remote": "origin"
    },
    "workflow_authorization_sha256": "<64 lowercase hexadecimal characters>"
  },
  "status": "ACTIVE",
  "phase": "IMPLEMENTING",
  "current_head_sha": null,
  "pull_request": null,
  "attempts": [],
  "active_action": null,
  "progress_fingerprint": null,
  "pause": null
}
```

The exact schema may add bounded diagnostic fields, but the following
invariants are required:

- repository identity, requirement, base SHA, topic branch, publication target,
  exact capability set, and workflow-authorization digest are immutable;
- every action kind requires its corresponding persisted workflow capability
  or the exact single-use supplemental capability defined below;
- every push, pull-request, publication, mark-ready, thread-resolution, and
  compensating-unresolve target must equal the immutable authorized repository
  IDs, branches, and push remote;
- one workflow owns at most one open pull request;
- one active or paused workflow exclusively owns a canonical
  `(git_common_dir, topic_branch)` and GitHub
  `(head_repository_id, head_branch)` pair;
- one pull request may be bound to only one workflow unless an operator
  explicitly transfers ownership after both workflows reconcile external
  state;
- every head attempt records the full head SHA and its `review_id`;
- every publication attempt references the same head and `review_id` as its
  finalized local gate;
- attempts are append-only and ordered by commit ancestry;
- only one external-action intent may be active at a time;
- every mutation carries the expected workflow revision;
- a workflow never copies or reinterprets a local-review or publication
  verdict; it references the source ledger and re-reads it;
- terminal or paused state cannot be cleared without an explicit, validated
  resume transition; and
- existing review and publication ledgers remain their domains' sources of
  truth.

## Workflow ownership

Per-workflow locks do not protect a branch or pull request from another
workflow. Ownership claims are therefore part of each workflow ledger itself,
and every claim-affecting start is serialized under one store-wide claims
lock.

Before branch creation or reuse, workflow start atomically claims:

- canonical Git common directory plus topic branch; and
- authorized GitHub head repository ID plus head branch.

After pull-request creation or reconciliation, the workflow atomically claims
the target repository ID plus pull-request number before binding it. A second
active or paused workflow cannot claim the same key, even when it uses another
local clone or reaches GitHub through another remote name.

Claims do not expire based on wall-clock time. A crash-resumed workflow can
reacquire only its own claim. Cancellation or completion also does not silently
release a branch or pull request that still exists; release or transfer
requires an explicit operator action after a fresh external-state
reconciliation that proves each branch and head ref absent and each bound
pull request closed. This prevents a stale workflow from resuming into objects that
another workflow has started to mutate.

Under the store-wide claims lock, start reads every persisted workflow ledger,
rejects the new claim set when any readable ledger still holds a conflicting
active claim, and fails closed when any persisted ledger cannot be read. The
atomic write of the new `workflow.json` is the single claim commit point: a
start interrupted before that write leaves a directory without a ledger, which
holds no claims and is ignored by conflict scans, reads, and listings. Claim
release mutates only the owning ledger, so a torn multi-file claim state
cannot exist, and the ledger validates that an active or paused workflow holds
exactly its two authorized claims while released claims appear only on a
cancelled workflow together with their release evidence. Claim dispositions
and release evidence are part of the audited workflow state, and the release
itself commits an audit event: a ledger that claims released ownership
without that committed transition fails the audit binding, and a conflict
scan trusts released claims only after the full locked load replays that
proof. A bound local review is likewise exclusively owned: binding persists a
workflow marker under the review's own mutation lock, a second workflow whose
scope matches the same review fails closed at bind, and dispatch completion
and every advance revalidate that ownership before adopting a verdict.
Concurrent starts are serialized so exactly one claimant succeeds.

Workflow files use the existing private mode, size limits, exclusive lock,
canonical serialization, atomic replacement, file sync, and directory sync
rules. The action audit is append-only with a committed digest-chain head,
using the same durability model as the publication-gate audit.
Every active workflow mutation commits a bounded state event before replacing
the ledger, binding its revision, phase, recorded head and attempts, review
summary, finding fingerprint, and task state. The unaudited initial revision is
validated against the canonical `ACTIVE` / `IMPLEMENTING` initial state.
Before either audit artifact is written, the exact replacement ledger is
serialized with the projected sequence and digest cursor and checked against
the 2 MiB ledger limit.
`action-audit.jsonl` retains an absolute 4 MiB readable limit. Ordinary events
stop early enough to reserve two maximum-sized terminal events within that
limit, so an accepted cancellation and its later audited claim release always
fit the main log. Workflow start and every active or paused mutation also
reserve the full worst-case stop: the pessimistic cancelled-and-released
audit event must fit the 256 KiB per-event limit, and the pessimistic
cancelled-and-released ledger — including a maximal revision, audit cursor,
operator label, rationale, and reconciled release evidence — must still fit
the 2 MiB ledger limit. A mutation that would leave either reserve short is
rejected before any artifact is written. Cancellation and release rationale
are capped at 32 KiB after canonical JSON string encoding, so escaped input
cannot consume that reserved headroom.

No existing `review.json` or `publication.json` is migrated. Older Review
Bridge clients may continue their existing workflows but cannot advance a new
autonomous workflow without tools that understand schema version 1.

## External-action protocol

The controller must not treat conversation history as proof that an external
write happened.

Before a non-idempotent external write, it records an action intent containing:

- deterministic action ID;
- workflow revision;
- action kind;
- exact target;
- immutable workflow-authorization digest, required capability or exact
  supplemental capability, and applicable ownership claim;
- immutable head, when applicable;
- provider-specific correlation marker, when available; and
- the facts that must be observed before the action can be marked complete.

The active action moves through:

```text
PLANNED -> EXECUTING -> OBSERVED -> COMPLETED
                        └────────> PAUSED_UNKNOWN
```

The controller records `EXECUTING` immediately before the provider call and
records the provider response before starting another external action.

A process can fail after the provider accepted a write but before Review Bridge
recorded its result. Therefore recovery always reconciles first:

- **Git push**: resolve the named remote to the authorized head repository
  identity, then compare the exact remote ref head. Re-push only when the
  desired object is absent and the update is still a permitted fast-forward.
- **Pull request creation**: search the authorized repository for an open pull
  request with the exact head repository, head branch, and base branch. The
  create intent contains a server-generated high-entropy correlation marker
  bound to the workflow ID, action ID, repositories, branches, and head. The
  controller includes that marker in the initial pull-request body, requests
  draft state, and records the authenticated creator's numeric actor identity.
  Recovery binds exactly one match only when the marker, creator, repository
  identities, branches, head, and draft state all match. A same-branch pull
  request without the marker, a marker match that is already ready, zero
  matches after an indeterminate create, or multiple matches pauses; branch
  equality alone never establishes workflow ownership.
- **Codex reviewer task creation**: include a deterministic dispatch marker in
  the task prompt and title. Discover and bind exactly one matching task before
  creating another. If the client cannot enumerate matching tasks after an
  indeterminate create, pause instead of creating a duplicate.
- **GitHub Codex review request**: retain the publication ledger's exact body,
  request ID, immediate binding, unbound-request detection, and ambiguity
  rules. The workflow ledger references that action rather than weakening it.
- **Thread reply**: before resolving an eligible thread, the workflow answers
  it with exactly one reply comment naming the addressed-by commits. The
  intent carries a server-generated correlation marker bound to the workflow
  ID, action ID, thread ID, and head; the posted body embeds the marker, and
  the response records the provider comment ID and the authenticated actor's
  numeric identity. Recovery queries the exact thread with complete nested
  comment pagination and binds exactly one marker comment by that actor: an
  already-present marker comment completes reconciliation without another
  write; zero matches after an indeterminate post, or multiple matches,
  pauses. The reply is authorized by `RESOLVE_ELIGIBLE_CODEX_THREADS` — it
  exists only as the first half of a resolution.
- **Thread resolution or compensating unresolve**: query the exact thread ID.
  If a resolution action finds the thread already resolved, complete it with
  outcome `OBSERVED_PRE_RESOLVED`; do not create a workflow-owned
  automatic-resolution record. A resolution creates that record only when an
  immediately preceding read proved the thread unresolved, a durably recorded
  provider response attests that this action performed the transition, and the
  post-read proves the same watermark is now resolved. A crash after provider
  acceptance but before that response is recorded cannot claim ownership from
  the resolved state alone. Once the response is recorded, the record is made
  from the action alone, so a recovery that observes the pull request first
  -- and so sees the thread it resolved as resolved -- does not lose the
  ability to record what it did. A publication driven terminal is the one
  state that ends this: it accepts no write at all, so the record becomes
  uncreatable rather than late. The action completes without it there, which
  costs nothing, because no gate of a terminal publication can pass and the
  record has nothing left to protect. Repeat a resolve only while the original
  eligibility proof remains valid for the current head. Repeat an unresolve
  only while the server still reports that this workflow's proven resolution
  record is invalid, the `UNRESOLVE_INVALIDATED_CODEX_THREADS` capability is
  present, and no different workflow or thread is targeted.
- **Mark ready for review**: immediately before the provider call and during
  reconciliation, read the live pull-request repository ID, number, base and
  head branches, full head SHA, and draft state. They must equal the
  action-bound workflow-owned pull request and gated head. An already-ready
  state completes reconciliation only for that exact head; any identity or
  head drift pauses without issuing or crediting the mutation. The server
  re-reads its own clearance at that same point and refuses a publication
  that regressed since planning. A refusal there drops the planned intent
  and returns the workflow to the publication wait: nothing external has
  happened, and leaving a refused intent in a phase that can neither advance
  nor record a head would leave cancellation as its only exit. Retryable
  failures of the read itself drop nothing.

  That checkpoint runs once, before the single call the action makes. A
  driver that crashes after it reconciles by reading the pull request, and
  the pre-read it already recorded decides what it may claim: having found
  the pull request draft before the call, it completes `MARKED_READY` once
  the pull request is ready. A pull request still draft is simply called
  again, which is safe whether or not an earlier attempt landed.

  One case has no in-protocol exit in this first implementation: still
  draft, with a clearance that no longer permits the call. Whether the
  earlier call landed cannot be established -- a timeout or a lagging read
  reports a draft pull request while the mutation applies, and this provider
  attests no actor for a draft transition -- so the action can neither be
  claimed nor abandoned. Recovering it requires returning a possibly ready
  pull request to draft, which is a later action. Until that ships, such a
  crash is an operator matter: the workflow pauses as an indeterminate
  external action and may have to be cancelled.

- **Return to draft for repair**: read the exact pull request and head. Treat an
  already-draft pull request as reconciled completion. Repeat the mutation only
  while the same workflow-owned pull request remains ready on the same head,
  the current complete observation still contains the actionable machine
  finding, required-check failure, or `PR_UPDATE_REQUIRED` blocker, and
  `RETURN_PR_TO_DRAFT_FOR_REPAIR` is authorized.

When absence cannot be proved or multiple external objects match, the workflow
pauses. It does not claim exactly-once execution and does not choose an object
by timestamp alone.

Internal Review Bridge mutations retain their existing retry rules:
`REVIEW_BUSY` and `PUBLICATION_BUSY` require a fresh read before retry;
ownership-lost or indeterminate-store errors require a read before deciding
whether any mutation is still necessary.

## State machine

The server returns one compact workflow `next_action`. The controller performs
that action, records the result, and re-reads the workflow before continuing.

The normal path is:

```text
IMPLEMENTING
  -> COMMIT_HEAD
  -> PREPARE_LOCAL_REVIEW
  -> DISPATCH_CODEX_REVIEWER
  -> WAIT_LOCAL_REVIEW
       ├─ findings -> ADDRESS_LOCAL_FINDINGS
       │               -> COMMIT_AND_VERIFY_LOCAL_FIXES
       │               -> PREPARE_REREVIEW
       │               -> WAIT_LOCAL_REREVIEW
       ├─ open/new after round two -> PAUSED_HUMAN
       └─ CLEAN -> FINALIZE_LOCAL_GATE
                    -> PUBLISH_GATED_HEAD
                    -> START_PUBLICATION
                    -> REQUEST_REMOTE_CODEX_REVIEW
                    -> WAIT_PUBLICATION
                         ├─ remote findings -> ENSURE_DRAFT_FOR_REPAIR
                         │                      -> ADDRESS_REMOTE_FINDINGS
                         │                      -> COMMIT_HEAD
                         │                      -> PREPARE_LOCAL_REVIEW
                         ├─ required check failure -> ENSURE_DRAFT_FOR_REPAIR
                         │                           -> ADDRESS_CHECK_FAILURE
                         │                           -> COMMIT_HEAD
                         │                           -> PREPARE_LOCAL_REVIEW
                         ├─ update required -> ENSURE_DRAFT_FOR_REPAIR
                         │                     -> UPDATE_FROM_BASE
                         │                     -> COMMIT_HEAD
                         │                     -> PREPARE_LOCAL_REVIEW
                         ├─ eligible old Codex threads
                         │    + current remote CLEAN
                         │    -> RESOLVE_VERIFIED_CODEX_THREADS
                         │    -> REFRESH_PUBLICATION
                         ├─ autonomous pre-ready projection passes
                         │    -> MARK_READY_FOR_REVIEW
                         │    -> REFRESH_PUBLICATION
                         ├─ ambiguity or unsafe blocker -> PAUSED_HUMAN
                         └─ all invariants pass -> MERGE_READY
```

The implementation may use more granular internal phases, but it must preserve
the ordering and head bindings above.

### Implement and commit

The author implements only the recorded requirement and verifies the change
using repository-appropriate tests. The controller creates and checks out the
authorized topic branch at the immutable base before editing. Before local
review:

- the topic branch must be checked out;
- the intended change must be committed;
- the working tree must be clean;
- the full `HEAD` must be recorded; and
- the base passed to `prepare_review` must equal the workflow's immutable
  `base_sha`.

The workflow does not attest that free-form test text is true. The immutable
snapshot, repository state, and later reviewer inspection remain authoritative.

### Local review

The first head has no parent review. A later head passes the immediately
preceding eligible `LOCAL_GATE_PASSED` review as `parent_review_id`. Review
Bridge decides whether the result is `SUCCESSOR` or an explicit `FULL`
fallback.

The controller records the returned `review_id`, strategy, provider, snapshot,
and state version before dispatching the reviewer task.

The existing two-round protocol remains unchanged:

- a round-one review with no findings enters `CLEAN`, whose direct next action
  is `finalize_local_gate`;
- a review with findings cannot finalize from round one and must pass through
  author resolutions and round two;
- every finding receives one `fixed`, `rejected`, or `human_required`
  resolution;
- any code changed while addressing findings must be committed, and the
  working tree must be clean, before `prepare_rereview`;
- round two reuses the same reviewer task;
- any open or new finding after round two becomes `HUMAN_REQUIRED`; and
- the controller does not create a third model round for that `review_id`.

`HUMAN_REQUIRED` pauses the workflow and exports the exact arbitration packet.
It does not automatically start another review with the same head.

### Publication

Only `LOCAL_GATE` publication is part of the autonomous path. `REMOTE_ONLY`
requires a separate direct instruction and is outside this RFC.

After `LOCAL_GATE_PASSED`, the controller:

1. rechecks that clean local `HEAD` equals the finalized gate head;
2. records and reconciles the push intent;
3. creates or binds one draft pull request;
4. collects the complete Codex baseline;
5. starts publication under `EXPLICIT_ONLY`;
6. posts and immediately binds the exact server-generated Codex request;
7. records complete GitHub observations until the result and checks settle;
   and
8. follows the autonomous workflow projection described below.

The controller must not follow the current publication
`next_action: MARK_PULL_REQUEST_READY` merely because the main publication
status is `PR_DRAFT`. The existing evaluator intentionally reports `PR_DRAFT`
before evaluating mergeability, checks, Codex status, or threads, so that next
action does not prove that a draft pull request is otherwise ready.

The publication server therefore exposes an additional, pure
`autonomous_pre_ready` projection. It ignores only the draft flag and evaluates
all other existing publication invariants in their normal fail-closed priority,
including:

- pull-request identity, head, base, ancestry, and mergeability;
- complete and fresh policy and check evidence;
- every required check;
- the correlated current-head Codex result;
- ambiguity and request visibility;
- every unresolved review thread; and
- every automatic-thread-resolution safety record required by this RFC.

The existing publication `status` and `next_action` remain unchanged for manual
workflows. The autonomous controller may mark ready only when
`autonomous_pre_ready.status` is `READY_TO_MARK`. Pending, failed, findings,
ambiguous, incomplete, and unresolved-thread projections return their
underlying blocker instead.

The draft-gate rules below belong to rollout item 3. They exist only to answer
when an *early* mark-ready is permitted. Autonomous mark-ready now ships, but
only on that `READY_TO_MARK` clearance: the implemented action reads the
projection under the publication's own lock at planning and again at its
pre-write checkpoint, records which observation cleared the head, and has no
path that waives a blocker. So neither draft-gate pause has a resume action
and neither is reachable, exactly as before.

They are also not this repository's path. GitHub delivers `pull_request` events
for draft pull requests, and a workflow without an explicit `draft == false`
condition runs on them. Measured on pull request 22 of this repository, which
was created draft and marked ready at `2026-07-31T19:16:59Z`: eight required
`pull_request` check runs completed between `15:31Z` and `19:09Z`, and the
pinned Codex actor submitted seven reviews between `15:36Z` and `18:26Z` —
every one of them while the pull request was still draft. Neither gate is
ready-only here, so the precondition for a draft gate never holds. The rules
remain for repositories whose providers do gate on ready state.

Some repositories start required checks or remote review only after a pull
request leaves draft state. The server derives `DRAFT_GATE_DEADLOCK` only when
fresh, complete provider-policy evidence unambiguously declares that every
remaining blocker is activated by leaving draft state. The proof binds the
provider configuration resource and revision, collection completeness, exact
gate identities and trigger condition, target repository and pull request, and
current head. The source must be maintainer-approved and pinned independently
of the candidate observation.

A missing run, pending status, silent provider, elapsed interval, or workflow
guess is never deadlock proof. When all currently evaluable gates pass but no
supported provider-policy source can prove why the remaining gates have not
started, the workflow pauses as `DRAFT_GATE_INDETERMINATE`, not
`DRAFT_GATE_DEADLOCK`. The first implementation does not assume that GitHub
exposes a generic ready-only policy source; a repository without one therefore
uses the indeterminate path.

That rule decides which pause applies once the workflow stops waiting. It does
not decide when to stop. An ordinary pending gate and a gate that will never
start while draft are observationally identical, and elapsed time is explicitly
not evidence, so rollout item 3 must supply the predicate that ends the wait
before either pause can be derived.

Marking ready from either pause requires a new direct operator decision. For a
proven deadlock, the server replays the exact provider-policy proof. For an
indeterminate pause, the operator must directly assert that the displayed exact
blocker set is ready-only; the server records that assertion without claiming
it is provider-verified. The controller does not infer either permission.

The server then persists a single-use `draft_gate_exception` on the current head
attempt. The canonical record contains:

- `workflow_id`, pull-request repository ID and number, exact head SHA, and
  publication ID;
- the workflow and publication revisions at authorization;
- the exact normalized blocker set and its observation digest;
- basis `PROVIDER_VERIFIED` plus the policy-proof digest, or basis
  `OPERATOR_ASSERTED` plus a null policy-proof digest;
- supplemental capability `MARK_PR_READY_WITH_DRAFT_GATE_EXCEPTION`;
- exact acknowledgement `DRAFT_GATE_DEADLOCK_READY_EXCEPTION` for
  `PROVIDER_VERIFIED`, or `READY_ONLY_GATES_OPERATOR_ASSERTED` for
  `OPERATOR_ASSERTED`;
- operator label, rationale, and authorization timestamp; and
- `ready_exception_sha256`, derived from the complete record except its digest.

The mark-ready action intent binds both `workflow_authorization_sha256` and
`ready_exception_sha256`, the exact mark-ready action ID, and the authorized
starting revisions. Before consumption, a change to the workflow identity,
pull request, head, publication ID, blocker set, observation digest,
provider-policy proof, or operator assertion invalidates the exception.
Revision increments made by the bound action's own
`PLANNED -> EXECUTING -> OBSERVED -> COMPLETED` bookkeeping do not. No other
action may consume the exception or interleave while that action is active.

Successful reconciliation consumes the exception exactly once and records the
action ID, observed ready state, and consumption revisions in the append-only
action audit. The consumed record remains immutable evidence for terminal
replay; later complete observations and their publication revisions do not
invalidate it. Terminal replay instead requires the original exception digest,
its completed action audit chain, and the same workflow, pull request,
publication ID, and head. A target or head change invalidates the head attempt,
but ordinary post-ready observation bookkeeping does not erase the consumed
proof. The exception cannot authorize another action or waive any check,
review, thread, or terminal gate. Without this record, neither pause can resume
through an autonomous mark-ready action.

The first autonomous version requires `EXPLICIT_ONLY`. A repository that also
uses automatic Codex review needs the existing direct
`AUTOMATIC_QUIESCENCE_ACKNOWLEDGED` decision and therefore leaves the no-human
normal path.

Autonomous `start_publication` creates publication schema version 3. It
preserves the version-2 `authorization` object and its `source_sha256`
semantics, and adds top-level `workflow_id` and
`workflow_authorization_sha256`. A version-3 `publication-gate.json` likewise
preserves the existing `authorization_sha256`, which still binds the
`LOCAL_GATE` or `REMOTE_ONLY` publication authorization, and separately stores
`workflow_id` and `workflow_authorization_sha256`. Start, every snapshot
recording, both autonomous projections, finalization, and gate verification
validate the publication-authorization and workflow-authorization digests
independently. A mismatch in either fails closed.

Every fix commit creates a new head attempt. The old publication ledger remains
historical and cannot authorize the new head. The new head must pass a new
local review, local gate, push reconciliation, publication start, required
checks, and correlated GitHub Codex review.

The same pull request may be reused across head attempts. The workflow ledger
binds each local and publication attempt to its exact head.

### Required-check failures

The controller may diagnose and fix a required check when the failure is
actionable within the authorized repository. Any fix produces a new commit and
returns to local review.

The workflow pauses when:

- logs or required evidence are unavailable;
- the failure is external or administrative;
- a human formal review requests changes;
- the proposed fix would exceed the recorded requirement;
- a required secret or permission is missing; or
- the same progress fingerprint recurs without a code or evidence change.

The controller must not waive, remove, or rename a required check.

A repair phase is left only by recording a new head. A check that fails and
then passes on a rerun with no code change therefore leaves the workflow in
that phase until the operator commits a fix or cancels it. Letting a repair
phase re-evaluate its publication instead was implemented and withdrawn in
rollout item 2: every status the projection can report before it reaches the
required-check and Codex gates — a pending pull-request state, an incomplete
collection, expired evidence, and a check still running — masks a blocker that
is still standing, so each release rule tried fired on unevaluated evidence and
stranded the finished fix, since the wait cannot record a head. A correct rule
needs the projection to distinguish "this gate was evaluated and is clear" from
"this gate was never reached", which it does not currently express. Rollout
item 3 revisits this state machine for mark-ready and thread resolution and
should carry that distinction.

### Base updates and conflicts

If the target base advances while remaining compatible with the publication
ledger's existing ancestry rules, the existing publication decision applies.

If GitHub requires the topic branch to be updated, the update creates a new
head and must return to local review. When the pull request is already ready,
the controller must first complete `ENSURE_DRAFT_FOR_REPAIR` for the exact
current head; it must not merge the base or create the replacement commit while
the pull request remains ready. A non-destructive merge of the fresh base may
be performed only when it applies cleanly. A semantic conflict, required
history rewrite, rebase, or force push pauses for operator direction.

Restoring an earlier head or base does not revive an invalidated publication
ledger.

## Automatic thread resolution

RFC 0001 remains correct that every unresolved review thread, including an
outdated thread, blocks `MERGE_READY`. This RFC changes who may perform the
GitHub resolution mutation.

### Required provenance

The GitHub observation schema must be extended so each thread records enough
complete, paginated evidence to establish:

- thread node ID and current resolution state;
- root review-comment ID;
- root comment author numeric actor ID and type;
- structurally attached formal review ID;
- formal review author numeric actor ID and type;
- the correlated workflow request and reviewed head;
- the complete ordered comment sequence, with stable node and database IDs,
  actor numeric IDs and types, creation and update times, and nested-pagination
  proof;
- whether GitHub considers the thread outdated.

Login strings and timestamps alone are insufficient. A caller-supplied
`workflow_owned: true` flag is not accepted.

A thread is workflow-owned only when the server can replay the structural
association from the pinned Codex Bot through the correlated publication
result to the root finding.

For an autonomous publication, `start_publication` also binds the workflow ID
and immutable `workflow_authorization_sha256` without replacing the publication
authorization's existing `source_sha256`. Server-owned automatic-resolution
records are referenced by the publication ledger. A caller cannot manufacture
a resolution record in an observation.

From each complete normalized thread, the server derives a thread watermark.
Eligibility and resolution audit entries bind that exact watermark, not merely
the thread ID or its latest timestamp.

### Eligibility

An unresolved workflow-owned Codex thread is eligible for automatic resolution
only when all of these are true:

1. its root finding belongs to an earlier head attempt in the same workflow and
   pull request;
2. the current head descends from the finding head;
3. the workflow records the finding as addressed by one or more commits;
4. the current head has a finalized `LOCAL_GATE_PASSED`;
5. the current head has a fresh, correlated GitHub Codex `CLEAN` result;
6. the current publication observation is complete;
7. no human or unknown actor has added any comment after the Codex root
   finding, with one exception: the workflow's own recorded reply, accepted
   only as the exact comment ID a completed reply action of this same
   workflow and thread recorded, posted by the authenticated actor that
   action recorded;
8. the thread is still unresolved and has not been dismissed through another
   unsupported path; and
9. the workflow is not paused, invalidated, closed, or merged.

`is_outdated` is useful evidence but is neither necessary nor sufficient.

The first implementation of this section derives a per-thread verdict with a
refusal reason, without performing any resolution, and its coverage of the
nine conditions is deliberately uneven. Conditions 1, 2, 7, 8 and 9 are
evaluated per thread: 1 against the workflow's recorded attempt heads, 2
against a `THREAD_ANCESTRY` comparison collected per distinct finding head,
provider reported, required to cover exactly the heads the threads reference,
with descent recomputed from the status; 7 over every comment and the review's
own author; 8 over both the resolved flag and a `DISMISSED` review state; 9
over the workflow's status. Condition 4 is structural rather than per thread:
a version-3 publication cannot exist without a finalized local gate, and the
plan is read under the same authorization files the gate verifies. Condition 6
is enforced for the thread collection, whose absence refuses the whole plan;
the freshness half of condition 5 and the completeness of the other
collections are the gate's own rules and are not re-evaluated here — a plan
is advisory and the gate re-derives everything before anything acts.

Condition 3 is evaluated against the workflow's addressed-by records. One is
written when the workflow records a repair head in its remote-findings phase:
the server reads the bound publication and takes the deciding correlated
findings review from the same selection that derived `CHANGES_REQUIRED`, at
the same publication revision the workflow observed when its projection
entered the repair phase. The publication lock is released before the
workflow mutation persists, so revision equality is the atomicity
substitute: an identity
read across an intervening snapshot — one that could have withdrawn or
replaced the correlated result — refuses the head recording instead of
being recorded as though it were the blocking evidence. The record can
therefore only name the review that actually blocked — a caller cannot
supply or substitute the identity, and a repair head cannot be recorded at
all while the publication's evidence no longer decides a findings review at
that revision.
The record names that review by result ID and reviewed head and lists the
commits the repair introduced, oldest first. A thread satisfies condition 3
when a record names its root review — same review ID, same reviewed head —
and carries at least one commit; a thread whose root review no record names
refuses with `FIX_NOT_RECORDED`. A thread that fails an earlier condition
reports that earlier reason instead; `FIX_NOT_RECORDED` is the floor, not
the only answer, and consumers must treat it as blocking rather than
ignorable.

The addressed-by record is also how a thread links structurally to the
correlated Codex review — not merely to the Codex actor. The correlated
`FINDINGS` result for an earlier head lives in that head's own publication
ledger, which the current publication does not hold: each attempt starts a
fresh ledger whose baseline absorbs earlier reviews as pre-existing.
Membership in the current ledger's recorded results can therefore only ever
mean observed, not correlated — a check built on it refuses every genuine
finding-fix-resolve cycle while still admitting an unsolicited in-window
review. The addressed-by record names the finding review it answers,
carrying the link across publications; that is the structural link, and
nothing available earlier can substitute for it. An unsolicited review —
in-window or not — was never the deciding result of a blocked publication,
so no record can name it and its threads stay refused.

A thread is never eligible when it:

- was created by a human or unknown actor;
- cannot be linked structurally to the correlated Codex review;
- belongs to another pull request or workflow;
- contains any later human or unknown-actor participation beyond the
  workflow's own recorded reply;
- concerns the current head's `FINDINGS` result;
- is covered only by a local reviewer verdict without a current remote
  `CLEAN`; or
- depends on an ambiguity acknowledgement rather than an unambiguous result.

### Resolution sequence

For each eligible thread, the controller:

1. obtains the server-derived eligibility record, thread watermark, and
   evidence digest;
2. answers the thread through the reply action above — one marker comment
   naming the addressed-by commits — and then collects and records a fresh
   complete observation whose thread watermark now includes exactly that
   recorded reply; the eligibility of step 1 is re-derived over the new
   watermark and must hold again, with the recorded reply as condition 7's
   sole admitted non-Codex comment;
3. persists a `RESOLVE_REVIEW_THREAD` action intent, at whose creation the
   server revalidates the head, provenance, eligibility, and exact watermark
   and binds them into the intent's target;
4. immediately re-reads the pull request head and the exact thread with
   complete nested comment pagination;
5. records that unresolved pre-read, bound to the intent's exact watermark,
   as the action's executing proof — the last check before the provider
   call;
6. resolves the exact GitHub thread ID and durably records a provider response
   whose pinned semantics attest an unresolved-to-resolved transition by this
   action — GitHub's `resolveReviewThread` alone cannot: it succeeds
   identically on an already-resolved thread, so the attestation is the
   accepted mutation together with the post-read of step 7 reporting
   `resolvedBy` as the action's authenticated actor on the unchanged
   watermark;
7. immediately re-reads the exact thread, requiring the same comment
   watermark, an observed resolved state, and a `resolvedBy` actor equal to
   the authenticated actor the action's intent recorded;
8. creates the server-owned automatic-resolution record only from that
   action's own durable evidence -- the intent the server bound in step 3,
   the unresolved pre-read of step 5, and the transition-attesting response
   and resolved post-read of steps 6 and 7 -- naming the action and nothing
   else, so the record stays creatable however long recovery takes and
   whatever the workflow observes in the meantime. Eligibility is decided in
   steps 2, 3, and 5, where refusing still prevents the mutation; refusing
   after it would only destroy the record step 10 needs;
9. collects and records a new complete GitHub publication snapshot; and
10. requires the publication server to revalidate the automatic-resolution
    record and watermark before any pre-ready or final gate can pass.

The server does not call GitHub. The workflow audit stores stable IDs, head,
source review and result references, local gate reference, evidence digest,
pre- and post-mutation watermarks, action timestamps, and the mutation result.
It need not store GitHub comment bodies already represented by digests and URLs
in the publication ledger.

An already-resolved observation never proves who performed the mutation. If
the thread becomes resolved before the provider call, or recovery observes it
resolved without a durably recorded transition-attesting response, the action
records `OBSERVED_PRE_RESOLVED` and no automatic-resolution record. A
`resolvedBy` naming the workflow's own actor does not lift this rule: after a
crash it cannot date the transition to this action instance rather than an
operator's manual click, so recovery still refuses ownership. The resolved
thread is no longer a publication blocker, but this workflow can never
perform a compensating unresolve on it. A provider whose response cannot
distinguish an applied transition from an idempotent read of an
already-resolved thread is not eligible for automatic resolution in the first
implementation; GitHub distinguishes through the `resolvedBy` post-read, and
a provider without an equivalent attribution signal does not qualify.

The publication gate still requires `unresolved_count == 0` from the fresh
post-resolution observation. A successful mutation response by itself is not
enough.

GitHub cannot make the comment-watermark check and resolution mutation atomic.
Any later watermark change invalidates the automatic-resolution record even
when GitHub still reports the thread resolved. A change containing only new
pinned-Codex-Bot feedback triggers a compensating unresolve and returns to the
remote-finding path. New human or unknown-actor participation instead derives
`THREAD_RESOLUTION_UNSAFE`; the controller attempts a compensating unresolve
and pauses with the exact thread and watermark evidence. Failure to unresolve
remains fail-closed because the invalid resolution record independently blocks
the autonomous pre-ready projection and publication gate.

Every compensating unresolve uses its own durable action intent and the
`UNRESOLVE_INVALIDATED_CODEX_THREADS` capability. The server permits it only
for the same workflow, pull request, thread ID, and invalidated resolution
record with a proven workflow mutation. An absent capability, unrelated
thread, `OBSERVED_PRE_RESOLVED` outcome, valid resolution record, or
indeterminate reconciliation pauses without issuing the mutation.

Automatic-resolution records remain immutable and append-only. The server
derives one per-thread resolution frontier from those records and append-only
lifecycle events. New pinned-Codex-Bot feedback appends an `INVALIDATED` event
that binds the prior record ID, old and new watermarks, exact follow-up
comments, and reason. A completed compensating unresolve appends
`UNRESOLVED_FOR_REPAIR`; neither event deletes or rewrites the old record.

After the follow-up finding is addressed by a descendant head with a new local
gate and correlated remote `CLEAN`, the normal resolution sequence may create a
new proven resolution record. The server appends a `SUPERSEDES` event only when
the predecessor and successor have the same workflow, pull request, and thread,
the predecessor was invalidated solely by pinned Codex feedback, the bound
compensating unresolve completed, the successor head contains the recorded fix,
and the successor record has its own complete mutation proof and fresh
watermark. The event binds both record IDs and every intervening invalidation,
unresolve, fix, gate, result, and resolution action.

A human or unknown-actor invalidation, missing compensating unresolve,
ambiguous result, mismatched thread or workflow, ancestry gap, fork, cycle, or
second active successor can never be superseded automatically. It remains a
blocking invalidated frontier. A valid supersession retires its predecessor
only from the active frontier; the predecessor and its invalidation remain in
the audit and final digest.

A final gate for an autonomous workflow must bind
`workflow_authorization_sha256`, preserve the independent publication
`authorization_sha256`, and bind the digest of every automatic-resolution
record and lifecycle event plus any consumed `ready_exception_sha256`.
Finalization replays every per-thread chain and its active frontier against the
final complete observation.

Human and unknown-provenance threads remain blocking and produce
`PAUSED_HUMAN`, with their exact thread IDs and URLs presented to the operator.

## Ready-for-review and terminal state

The pull request remains draft while fixes are in progress. If a post-ready
observation reports an actionable current-head Codex finding, required-check
failure, or `PR_UPDATE_REQUIRED`, the server first returns
`ENSURE_DRAFT_FOR_REPAIR`. The controller must persist and reconcile a
`RETURN_PR_TO_DRAFT_FOR_REPAIR` action for the exact workflow-owned pull
request and head before it edits files, merges the base, or creates a
replacement commit. An already-draft observation completes that action without
another mutation. An unauthorized, failed, or indeterminate draft transition
pauses the workflow and leaves the current head unchanged; it must not proceed
with a repair while the pull request is publicly ready. Human formal review
feedback still pauses rather than entering this automatic repair path.

After:

- current-head local gate;
- correlated remote `CLEAN`;
- successful required checks;
- resolution of every eligible workflow-owned Codex thread; and
- absence of any other unresolved thread or publication blocker,

the server-derived `autonomous_pre_ready` projection is
`READY_TO_MARK`. Only then may the controller mark the pull request ready for
review under the recorded authorization. It then records one fresh complete
observation.

The server evaluates that post-ready observation through a second pure
`autonomous_terminal` projection. It requires the existing publication status
to be `MERGE_READY`, then independently revalidates the exact workflow, pull
request, head, publication ID, publication-authorization digest,
workflow-authorization digest, and any consumed draft-gate exception. It also
replays the complete server-owned automatic-resolution records and lifecycle
events against the thread watermarks in that same complete observation. An
invalidated active frontier, missing or extra record, broken supersession
chain, or mismatched active record returns its fail-closed blocker even when
the main publication status is `MERGE_READY`. A valid superseded predecessor
remains audit evidence but is not compared to the current watermark as though
it were still active.

Only when `autonomous_terminal.status` is `MERGE_READY` may the workflow record:

- terminal status `MERGE_READY`;
- workflow revision;
- pull request identity and URL;
- exact head;
- current local review and publication IDs; and
- post-ready observation revision and digest;
- publication- and workflow-authorization digests;
- automatic-resolution record-and-lifecycle-set digest;
- consumed `ready_exception_sha256`, if any; and
- remaining human-review requirements imposed by repository policy.

The workflow stops. It does not call `verify_publication_gate` or merge unless
the operator later gives an explicit merge instruction. At that later time the
normal final fresh observation, finalization, immediate gate verification, and
head-matching merge rules still apply.

## Pause and cancellation

`PAUSED_HUMAN` is a fail-closed workflow stop, not a successful terminal state.
The summary includes a stable reason code, exact blocked action, relevant
review, publication, thread, check, or task identifiers, and the evidence
needed from the operator.

Pause reasons include:

- `LOCAL_REVIEW_HUMAN_REQUIRED`;
- `TASK_ORCHESTRATION_UNAVAILABLE`;
- `EXTERNAL_ACTION_INDETERMINATE`;
- `WORKFLOW_OWNERSHIP_CONFLICT`;
- `GITHUB_REVIEW_AMBIGUOUS`;
- `PUBLICATION_INVALIDATED`;
- `DRAFT_GATE_DEADLOCK` (rollout item 3);
- `DRAFT_GATE_INDETERMINATE` (rollout item 3);
- `HUMAN_REVIEW_REQUIRED`;
- `HUMAN_OR_UNKNOWN_THREAD`;
- `THREAD_RESOLUTION_UNSAFE`;
- `REQUIRED_CHECK_UNACTIONABLE`;
- `SEMANTIC_CONFLICT`;
- `HISTORY_REWRITE_REQUIRED`;
- `AUTHORIZATION_REQUIRED`;
- `PERMISSION_REQUIRED`; and
- `NO_PROGRESS`.

An operator may explicitly cancel an active or paused workflow. Cancellation
prevents further automatic writes but does not delete commits, branches, pull
requests, reviews, or audit evidence. Cleanup is a separate explicit action.
Pause and cancellation transitions are committed to the workflow action audit.
Recovery replays one committed stop or rejects a ledger whose active status,
phase, bound review summary, finding fingerprint, pause evidence, or
cancellation evidence disagrees with the audit before another external
mutation.

A paused workflow resumes only after the operator supplies the exact missing
decision or external state changes and the controller freshly verifies it.
Earlier broad authorization does not satisfy a later ambiguity acknowledgement
or destructive-operation approval.

## No-progress detection

The workflow does not impose an arbitrary small number of remote fix cycles
while each cycle makes verifiable progress.

It pauses with `NO_PROGRESS` when either:

- two consecutive attempts have the same head and same normalized blockers; or
- a later attempt reproduces the same finding/check fingerprint without a
  changed relevant diff or new evidence.

The fingerprint is diagnostic, not a review verdict. A changed title or
timestamp does not count as progress. The operator can inspect the recorded
attempt chain before deciding how to continue.

## Security considerations

Autonomous mode expands the author task's operational authority. It therefore
requires a specific recorded opt-in and narrow target binding.

The main risks and controls are:

- **Author/reviewer context leakage**: every new review ID uses a fresh,
  non-forked reviewer task with only the review ID, the mandatory opaque
  dispatch marker, and the packaged-skill instruction.
- **Wrong-head evidence**: every local gate, push, publication, remote result,
  check, and thread-resolution proof carries the full head SHA.
- **Duplicate external writes**: persist intent first, reconcile stable
  provider identities, and pause when absence or uniqueness cannot be proved.
- **Diverted push target**: push-target integrity rests on the post-push
  reconciliation, not on hardening the local `git push` invocation. The local
  Git environment is trusted: a controller that can rewrite local Git
  configuration or inject it through the environment already holds the gated
  commit and can disclose it directly, so hardening the invocation defends
  nothing it does not already control. A push diverted by such a rewrite
  leaves the authorized remote without the gated commit, so the observation —
  which reads the authorized remote and requires the gated SHA at the
  authorized repository ID — fails and the workflow pauses rather than
  completing. The push does still bind the immutable gated SHA and the pinned
  URL from persisted intent so an advanced branch or a mistaken remote name
  cannot substitute a different commit or destination.
- **Edited workflow ledger**: the publication side reads the workflow through a
  narrow, lock-free binding reader rather than the full loader, so it validates
  the binding contract and the authorization digest but not the committed
  action audit. An actor who can canonically rewrite `workflow.json` can
  therefore restore a cancelled workflow or roll its head back and make a
  superseded publication actionable again, where the full loader's audit
  binding would reject it. This is accepted rather than closed: that actor
  already has write access to the private store, and the same access rewrites
  the local gate, the publication ledger, and its audit directly. The narrow
  read exists so the publication and workflow locks need no shared ordering,
  and the authorization digest it does verify still binds the immutable scope.
  Every mutable fact it returns — status, current head, bound pull request —
  is therefore trusted only to the extent the store itself is.
- **Cross-workflow interference**: atomically claim canonical local branches,
  GitHub head refs, and pull requests in a store-wide registry; never expire or
  steal a claim based only on time.
- **Forged task identity**: provider binding and task discovery are workflow
  attestations only; immutable snapshots and server-side transition checks
  remain the security-relevant evidence.
- **Forged GitHub provenance**: pin actor numeric ID and type, require complete
  pagination and structural review/comment/thread associations, and reject
  caller-selected ownership flags.
- **Over-resolving review feedback**: only workflow-owned Codex threads with a
  new local gate and current remote `CLEAN` are eligible; exact comment
  watermarks are checked before and after mutation, and later human
  participation triggers a compensating unresolve and fail-closed pause.
- **Stale gate reuse**: every accepted mutation and new head invalidates prior
  publication authorization for merge purposes.
- **Credential expansion**: the MCP server still has no GitHub or Codex task
  credentials.
- **Unbounded automation**: no-progress detection and explicit pause reasons
  stop loops that cannot demonstrate progress.
- **Unintended publication**: autonomous authorization names the repository,
  base, topic branch, stable GitHub base and head repository IDs, push remote,
  and exact permitted writes; every action rechecks
  `workflow_authorization_sha256`, and another target requires new
  authorization.

Review Bridge ledgers remain workflow attestations, not Git or GitHub security
boundaries. Repository protections remain necessary.

## Backward compatibility

- Existing local reviews and publication ledgers remain valid under their
  existing schemas and workflows.
- Existing manual workflows continue to require a person or controller to
  resolve threads; they do not gain automatic resolution merely by upgrading.
- The existing publication `status` and `next_action` remain unchanged;
  `autonomous_pre_ready` and `autonomous_terminal` are additional projections
  used only by a bound autonomous workflow.
- Workflow schema version 1 references existing review and publication IDs
  without modifying their historical records.
- Publication schema version 3 preserves version 2's publication authorization
  and adds the independent workflow binding required by autonomous mode.
  Version-1 and version-2 publication ledgers remain readable but cannot be
  attached to an autonomous workflow or produce an autonomous terminal record.
- RFC 0001's `unresolved_count > 0 -> CHANGES_REQUIRED` rule is unchanged.
- If this RFC is accepted, RFC 0001's statement that a human must always
  resolve an unresolved thread is superseded only for eligible workflow-owned
  Codex threads under the autonomous action defined here, whether or not GitHub
  marks the thread outdated.
- Older Codex plugins may read neither the workflow ledger nor its next action
  and therefore must not attempt to advance it.
- An older publication implementation cannot finalize an autonomous gate that
  requires workflow-authorization and automatic-resolution digests.
- A new plugin may resume existing non-autonomous review and publication
  ledgers through their existing skills.

## Drawbacks

- The workflow adds a third persistent state domain beside local review and
  publication. Cross-ledger references and recovery tests increase maintenance
  cost even though each domain retains one source of truth.
- A complete run may create several Codex tasks and remote reviews, increasing
  latency, model usage, and visible task history.
- Durable intent cannot make third-party writes transactional. Indeterminate
  provider state still requires a human pause.
- Provenance-based automatic resolution is safer than actor-name matching but
  still depends on the authenticity and completeness of GitHub observations
  supplied by the author-side controller.
- The first version's clean-start and `EXPLICIT_ONLY` requirements exclude
  existing pull-request adoption and repositories that cannot disable
  automatic Codex review.
- Stopping at `MERGE_READY` deliberately leaves merge timing and any final
  human approval outside the autonomous run.

## Alternatives considered

### Keep orchestration only in the skill

Rejected. Instructions can guide the common path but cannot durably bind
successive review IDs, external-action intent, recovery decisions, or automatic
thread-resolution evidence across tasks and restarts.

### Derive the workflow only from existing review and publication ledgers

Rejected. Those ledgers intentionally cover one local review and one
head-scoped publication. They do not bind the operator's workflow
authorization, topic branch, reviewer task dispatch, cross-head attempt chain,
or external-action reconciliation. Inferring those links from timestamps or
repository proximity would recreate the ambiguity this RFC is intended to
remove.

### Put the entire controller in the MCP server

Rejected. It would require GitHub and Codex task credentials in the server and
would collapse the current capability boundary.

### Use one long-lived reviewer task

Rejected. It accumulates authoring and prior-review context and breaks the
existing requirement for a fresh reviewer context on each new `review_id`.

### Fork the author task for review

Rejected. A fork carries authoring history and is not an independent reviewer
context.

### Resolve a thread immediately after a fix commit

Rejected. A commit and local test are insufficient remote evidence. Automatic
resolution requires a new local gate and a correlated remote `CLEAN` for the
current head.

### Treat an outdated thread as resolved

Rejected. GitHub's outdated flag describes line placement, not whether the
finding was fixed. The actual thread must be resolved and observed as resolved.

### Require a human for every thread

Rejected for workflow-owned Codex threads with the complete evidence chain in
this RFC. It adds a routine manual step without strengthening the proof that
the problem was fixed. It remains required for human or unknown-provenance
threads.

### Implement the feature as one change

Rejected. Durable orchestration, remote publication loops, and provenance-based
thread mutation have distinct safety boundaries and test matrices.

## Test plan

### Workflow-ledger unit tests

- immutable requirement, base, branch, repository, stable publication target,
  exact capability set, and workflow-authorization digest;
- rejection of an action whose target or capability was not authorized;
- rejection of compensating unresolve without
  `UNRESOLVE_INVALIDATED_CODEX_THREADS`;
- exact, single-use draft-gate exception authorization and invalidation;
- preservation of a bound draft-gate exception across its own action
  bookkeeping revisions and immutable replay after consumption;
- optimistic revision conflicts;
- legal and illegal phase transitions;
- one active external action;
- concurrent claims for the same canonical branch, GitHub head ref, or pull
  request admit exactly one workflow;
- crash recovery reacquires only the owning workflow's claim;
- claims require explicit reconciled release or transfer;
- append-only ordered head attempts;
- review and publication head equality;
- terminal and paused-state behavior;
- lock, durability, size, mode, and corruption failures;
- no-progress fingerprints; and
- backward rejection of unknown workflow schema versions.

### External-action recovery tests

For task creation, push, pull-request creation, review request, mark-ready,
return-to-draft, thread resolution, and compensating unresolve, inject a
failure:

- before intent;
- after intent but before the provider call;
- after provider acceptance but before local completion;
- during reconciliation; and
- after completion but before the next workflow read.

Verify that recovery binds exactly one observed object or pauses. It must never
blindly repeat an indeterminate write.

Pull-request recovery additionally verifies that matching branches without the
action-bound creation marker, a mismatched creator, or a non-draft match cannot
be adopted. Mark-ready recovery additionally changes the live head between the
gated observation and provider call and verifies that the mutation is not
issued or credited.

### Local-review integration tests

- first-round `CLEAN`;
- findings fixed and accepted in round two;
- rejected finding accepted with evidence;
- `human_required` author response;
- open or new finding after round two;
- new head using a valid `SUCCESSOR`;
- invalid successor preconditions falling back to `FULL`;
- missing, duplicate, or undiscoverable mandatory reviewer dispatch marker; and
- author working-tree change preventing local-gate finalization.

### Publication integration tests

- local gate through draft pull request and correlated remote `CLEAN`;
- draft pull requests with pending review, failed checks, findings, ambiguity,
  or unresolved threads do not become ready;
- a draft pull request becomes ready only when
  `autonomous_pre_ready.status == READY_TO_MARK`;
- ready-only checks or review produce `DRAFT_GATE_DEADLOCK` only with complete,
  pinned provider-policy proof bound to their exact gate identities;
- once the wait-ending predicate holds, missing, pending, silent, or delayed
  evidence without that proof produces `DRAFT_GATE_INDETERMINATE` rather than a
  deadlock, regardless of elapsed time;
- ordinary pending gates never produce a provider-verified deadlock exception;
- an early mark-ready requires an exact head/PR/blocker-bound single-use
  `draft_gate_exception`; an indeterminate pause additionally requires exact
  acknowledgement `READY_ONLY_GATES_OPERATOR_ASSERTED`;
- recovery rejects a stale or mismatched exception, policy proof, blocker set,
  or operator assertion;
- the bound mark-ready action may advance workflow and publication bookkeeping
  revisions, consumes its exception once, and preserves the consumed record
  across post-ready observations;
- existing manual publication summaries retain their status and next-action
  behavior;
- version-3 autonomous publication preserves `authorization_sha256` and
  independently validates `workflow_authorization_sha256` at start, snapshot,
  terminal projection, finalization, and verification;
- a mismatch in either authorization digest fails closed, while version-1 and
  version-2 non-autonomous ledgers retain their existing behavior;
- actionable remote finding, fix commit, successor local review, push, and new
  remote request;
- required-check failure repaired through a new gated head;
- a ready pull request with an actionable current-head machine finding or
  required-check failure returns to draft before repair; missing capability,
  provider failure, or indeterminate reconciliation pauses before any edit or
  replacement commit;
- base advancement that remains valid;
- update-required head returning through draft restoration and local review;
- an update-required ready pull request cannot merge the base or create a
  replacement head until return-to-draft reconciliation completes;
- semantic conflict pausing;
- ambiguous or unbound Codex result pausing for exact acknowledgement;
- force-push or unexpected head invalidation;
- mark-ready recovery;
- head or pull-request identity drift immediately before mark-ready pauses
  without exposing or crediting the ungated head;
- a new thread comment between mark-ready and the terminal observation blocks
  `autonomous_terminal`;
- the terminal projection replays every automatic-resolution record and
  lifecycle chain against the same post-ready observation; and
- terminal `MERGE_READY` without merge.

### Thread-resolution tests

- eligible workflow-owned Codex thread resolves after new local and remote
  gates;
- post-resolution fresh observation is required;
- outdated flag alone is insufficient;
- human-authored root thread is never eligible;
- unknown actor is never eligible;
- later human reply makes a Codex-rooted thread ineligible;
- any later human or unknown comment is ineligible without interpreting its
  prose as an objection;
- thread from another review, head, pull request, or workflow is rejected;
- current-head findings are not resolved;
- ambiguity-acknowledged result is insufficient;
- already-resolved thread reconciles as `OBSERVED_PRE_RESOLVED`, creates no
  automatic-resolution record, and can never authorize compensating unresolve;
- head changes after eligibility and before mutation;
- mutation succeeds but completion recording fails;
- a crash after provider acceptance but before its transition-attesting
  response is recorded cannot claim the observed resolution;
- a human resolution after the last unresolved read is not claimed when the
  provider response does not attest that this action applied the transition;
- a comment arriving between eligibility and the pre-mutation read blocks the
  mutation;
- a comment arriving between the pre-mutation read and mutation triggers
  compensating unresolve and pause;
- a comment arriving after resolution but before a later observation
  invalidates the resolution record and gate;
- later pinned-Codex-Bot feedback reopens the thread and returns to the remote
  finding path;
- pinned-Codex-Bot feedback appends invalidation and unresolve lifecycle
  events; a later proven resolution may supersede the exact predecessor without
  deleting it;
- terminal replay accepts one complete linear supersession chain whose active
  record matches the final watermark;
- a missing unresolve, human or unknown participation, ancestry gap, fork,
  cycle, or multiple active successors prevents automatic supersession and
  remains blocking;
- compensating unresolve requires the exact workflow capability and invalidated
  resolution record;
- unresolve failure remains blocked by `THREAD_RESOLUTION_UNSAFE`;
- post-ready terminal projection and finalization both bind and replay the two
  authorization domains and resolution-record and lifecycle digests; and
- unresolved human thread continues to block `MERGE_READY`.

### End-to-end scenarios

The release gate requires at least:

```text
requirement
  -> implementation
  -> local finding
  -> fix and local CLEAN
  -> draft pull request
  -> remote finding
  -> fix commit
  -> successor local CLEAN
  -> push
  -> correlated remote CLEAN
  -> resolve prior Codex thread
  -> fresh complete snapshot
  -> ready-for-review pull request
  -> MERGE_READY
```

and:

```text
external write accepted
  -> controller interruption
  -> fresh task resumes
  -> provider reconciliation
  -> no duplicate write
  -> workflow continues or pauses with exact evidence
```

## Rollout plan

Implementation is split into three changes after this RFC is accepted:

1. workflow ledger, action audit, Codex task dispatch/recovery, and the local
   autonomous loop, including store-wide workflow ownership claims;
2. draft pull-request publication, the autonomous pre-ready projection, GitHub
   Codex and required-check waiting, and remote-finding-to-successor-review
   cycles; and
3. complete thread provenance, evidence-backed automatic resolution,
   watermark and final-gate replay, ready-for-review transition, end-to-end
   recovery tests, and final packaging.

The pull request stays draft for the whole of item 2, so everything that acts
on ready state belongs to item 3: both draft-gate pauses, the provider-policy
proof, the single-use `draft_gate_exception`, the mark-ready action, and
`RETURN_PR_TO_DRAFT_FOR_REPAIR`, whose precondition is a ready pull request.
Item 2 keeps the reachable pauses `GITHUB_REVIEW_AMBIGUOUS`,
`PUBLICATION_INVALIDATED`, `REQUIRED_CHECK_UNACTIONABLE`, `SEMANTIC_CONFLICT`,
`HISTORY_REWRITE_REQUIRED`, and `NO_PROGRESS`. Unresolved review threads block
`MERGE_READY` throughout item 2 and stay operator work, since evidence-backed
automatic resolution is item 3.

Each change uses the existing Review Bridge local and GitHub review gates. The
feature remains unavailable until the packaged workflow skill and server
support the same workflow schema and transition set.

The first shipped version documents Codex Desktop task orchestration and
`EXPLICIT_ONLY` GitHub Codex triggering as prerequisites. Missing capabilities
produce a pause, not a manual-looking success.

After all three implementation changes ship and their end-to-end tests pass,
this RFC changes from `Accepted` to `Implemented`.

## Unresolved questions

- Which stable Codex task fields are available for deterministic dispatch
  discovery across application restarts?
- Should the first implementation expose an operator-configurable resource
  budget in addition to mandatory no-progress detection?
- ~~Which GitHub API shape provides the smallest complete paginated thread,
  review, comment, and actor provenance proof?~~ Resolved: a single GraphQL
  query on `pullRequest.reviewThreads` with nested `comments`. One request
  returns every element this RFC requires — thread node ID, `isResolved`,
  `isOutdated`, each comment's node and database ID with `createdAt` and
  `updatedAt`, `author { __typename ... databaseId }` for the numeric actor ID
  and type, and `pullRequestReview { databaseId author commit { oid } }` for
  the structurally attached review, its author, and the head it reviewed — with
  `pageInfo.hasNextPage` and `totalCount` at both the thread and comment levels
  as the nested-pagination proof. REST cannot supply it: it exposes no thread
  node ID and no structural thread-to-review link, and would need one call per
  thread. Measured against the five real threads on pull request 23 of this
  repository.

  One element is not in that query. The correlated workflow request is reached
  by joining the recorded review ID against the Codex results already in the
  observation, which carry the request correlation; the thread evidence
  supplies the review ID and reviewed head that make the join possible.

  A thread collection that claims completeness must be an atomic read: a single
  response, and so a single instant. The collector produces nothing else, and
  the ledger requires it of the observation, which arrives as caller-supplied
  JSON. A collection that instead admits incompleteness may carry anything and
  is still recorded — it claims no evidence, and the gate returns
  `EVIDENCE_INCOMPLETE` for it without reading `unresolved_count`. So the rule
  binds exactly the collections something is decided from.

  This is a real restriction — a pull request past one page of review threads
  is not collectable — and it is worth being precise about why, because the
  obvious weaker rules look sufficient and are not.

  Counts can prove *membership* across a paginated walk. Requiring the
  provider's `totalCount` on every page, identical across pages, and equal to
  the distinct identities collected is in fact strong enough to make membership
  exact rather than merely bounded: the connection is ordered by a keyset
  cursor over immutable per-thread keys, so a thread outliving the walk cannot
  sort behind a cursor already passed and be skipped, and any compensating
  creation and deletion puts the new thread into the walk as well, pushing the
  distinct count past the reported total and forcing a refusal.

  What no count can prove is per-thread *state*. `isResolved` is read from
  whichever page carried the node. Resolving or unresolving a thread between
  two pages changes no total, no identity, and no `pageInfo`, so there is
  nothing for a rule to compare, and the value read earlier is recorded as
  established fact. That fails in the worst direction: `unresolved_count` feeds
  the publication gate, so a thread unresolved after its page was read records
  as resolved and the gate reads `MERGE_READY` over a live objection.

  Refusing is therefore the honest answer rather than a conservative one — a
  walk cannot establish what it never observed at one instant. Supporting
  larger pull requests needs evidence that survives interleaving: agreement
  between two independent walks, or state that carries its own read time. That
  is deliberately left to a later change rather than approximated here.
- Which predicate ends the pre-ready wait, given that a pending gate and a
  ready-only gate are observationally identical and elapsed time is not
  evidence?
- Should a later version support repositories with automatic Codex review
  without requiring the existing direct quiescence acknowledgement?
