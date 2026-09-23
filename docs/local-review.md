# Run a local review

Describes Review Bridge v0.17.0.

The manual local review, step by step: the requests to give each reviewer,
the states a review ends in, successor reviews, and the state machine. For
why each step exists, see [How Review Bridge reviews a change](review-flow.md);
for every tool and error code, see the [reference](reference.md).

## Prepare and dispatch

In the author Codex task, choose the reviewer provider explicitly:

> Prepare the current changes for a `CODEX_TASK` review. The requirement is
> "...", the implementation scope is "...", and the base ref is `origin/main`.

Codex returns a `review_id` and waits in `WAITING_FOR_REVIEW`.
Use `get_review_summary` for the compact state, next action, current snapshot,
and active versus all-time finding counts. Pass its `state_version` to
`wait_for_review_state`; the tool waits 25 seconds by default, configurable up
to 30 seconds, and returns the same compact summary without repeated full-ledger
polling. A timed-out wait is expected while a human-paced review is still in
progress; call it again with the same `state_version`, or resume when the user
confirms the review is complete.

State-changing tools can also return structured concurrency and durability
errors. See [Troubleshooting](troubleshooting.md) for what each one means and
whether retrying is safe.

For a `CODEX_TASK` review, create a new Codex task and select `high` reasoning
effort unless you explicitly want another level. Keep your configured model.
Do not fork the author task or include its chat history. Give the new task only
this request:

> Independently review Review Bridge task `<review_id>` using the packaged
> reviewer skill. Submit every actionable finding and do not modify the code.

For a `CLAUDE_DESKTOP` review, start a fresh Claude Desktop conversation and
use the equivalent request:

> List pending Review Bridge tasks and deeply review `<review_id>`. Follow its
> review strategy, inspect the required artifacts and relevant snapshot files,
> then submit structured findings.

For a `HERMES` review, use the dedicated reviewer profile and start a fresh,
independent context that has no authoring history for the change:

> Independently review Review Bridge task `<review_id>` using the packaged
> Hermes reviewer skill. Require `reviewer_provider: HERMES`, follow the review
> strategy, and submit every actionable finding.

For a `DEEPSEEK_HARNESS` review, use the dedicated reviewer profile and start a
fresh session that has no authoring history for the change:

> Independently review Review Bridge task `<review_id>` using the packaged
> Review Bridge reviewer skill. Require `reviewer_provider: DEEPSEEK_HARNESS`,
> follow the review strategy, and submit every actionable finding.

Either profile-based reviewer is independent only when its profile contains the
reviewer-only MCP server and no Review Bridge author/publication server:
configured Hermes MCP tools are profile-scoped and auto-injected, and a
DeepSeek Harness profile registers the tools of every MCP server it configures.
A DeepSeek Harness reviewer profile must also scope its skill and
workspace-instruction roots, which the packaged snippet does.

If the reviewer submitted no findings, the review is already `CLEAN` and its
next action is `FINALIZE_LOCAL_GATE`; there is nothing to answer and
`prepare_rereview` will reject the state. Skip ahead and finalize.

Otherwise, back in Codex:

> Read the reviewer's findings, address each one, and prepare round two.

For a `CODEX_TASK` rereview, create another new task with the same review ID
and a request to rereview the author's resolutions. Select `high` unless you
explicitly want another level, keeping your configured model.

Resume the same reviewer context for round two where the provider allows it. A
`DEEPSEEK_HARNESS` reviewer cannot: every headless run starts a fresh session,
so launch a new one with the same review ID and a request to rereview the
author's resolutions. It rebuilds the round from `open_review`, which serves
every round-one finding and every author resolution. The final state is one of:

- `LOCAL_GATE_PASSED`: the reviewer found no remaining issue and the working tree
  still matches the reviewed snapshot. The gate attests snapshot consistency,
  not test results: the deterministic check gate lives in the publication
  layer, where a failing required check blocks `MERGE_READY` on provider
  evidence rather than on the author's word.
- `CONTINUABLE_FINDINGS`: all prior findings were accepted, but round two found
  a new issue. Commit a changed head and call `prepare_review` with
  `continued_from_review_id` and `force_full_review: true`; the fresh reviewer
  receives only the bare finding descriptions as scope hints.
- `HUMAN_REQUIRED`: a prior finding remains contested after round two.

For `HUMAN_REQUIRED`, call `get_review_summary`, then pass its exact
`state_version` to `export_human_arbitration`. The read-only export fails if the
ledger has advanced or does not require human arbitration. It returns an
`arbitration` object containing the requirement, implementation scope,
immutable round identities, escalation reason, and active and resolved findings
with their author resolutions and rereview decisions. Its deterministic
`markdown` field is ready to copy to a human or externally coordinated
reviewer. Exporting does not change the ledger, consume a review round, contact
another model, or authorize publication.

## Operator narration

The author-side driver narrates local review progress in the session the
operator is already watching. When a round reports findings, it presents each
finding's ID, severity, one-line summary, and location. When it submits author
resolutions, it presents each persisted disposition. For fixed resolutions
that proceed to rereview, it derives the affected files and fix commit from the
immutable preceding and latest review rounds. Any author `human_required`
resolution moves directly to `HUMAN_REQUIRED` and stops for arbitration. When
that submission also contains a fixed resolution, no rereview round binds its
files or commit, so the driver explicitly reports that metadata as unavailable
instead of inferring it. After rereview, it presents
every per-finding decision and any new finding. It states why a review reached
`HUMAN_REQUIRED`, or presents the carried-findings list before continuing from
`CONTINUABLE_FINDINGS` in a fresh full review.

This narration is observability, not evidence. The review ledger remains the
sole source of truth: the driver reads the full review ledger after findings
and completed rereviews, and narrates from its findings, resolutions, rereview
decisions, and carried findings. Session text never advances or proves review
state.

## Successor reviews

Start a fresh reviewer context for each new `review_id`; a round-two rereview
may stay in the same context. A `CODEX_TASK` reviewer must be a newly created
task, not a fork of the author task. This prevents authoring history and
unrelated reviews from consuming the new task's context window.

When a committed change continues a prior `LOCAL_GATE_PASSED` task for the same
repository, base SHA, and requirement, that task is the parent. Leave
`parent_review_id` unset and Review Bridge finds the parent itself: it considers
only gated tasks for that repository and base SHA whose gated head is a strict
ancestor of the head being captured, and every candidate still has to pass the
full successor proof — the parent gate, clean committed snapshots, and commit
ancestry. `review_strategy.parent_selection` records whether the parent was
`AUTOMATIC`, `EXPLICIT`, or `NONE`. Pass `parent_review_id` to pin a parent, or
`force_full_review: true` to require a full-patch review.

Requirement text is treated differently in the two cases. Naming a parent is an
assertion that the task continues it, so a requirement mismatch fails closed —
it means the wrong parent was named. Server-side selection asserts nothing:
requirements are free text that authors reword between rounds of the same work,
so equality there would reject nearly every real continuation. Selection prefers
a parent gated for the same requirement, and otherwise records the parent's
requirement and `requirement_match: false` in the proof. A reviewer that sees
`requirement_match: false` knows the parent's code was reviewed, but not with
the current question in mind, and reads the gated code that question bears on
rather than trusting the delta alone.

A valid `SUCCESSOR` task includes:

- `successor.json`, which binds the parent gate and snapshot, parent/current Git
  tree IDs, and delta hash;
- `successor.diff`, the exact parent-head-to-current-head delta;
- the normal full `patch.diff` and `manifest.json`, retained for expansion and
  final fail-closed snapshot verification.

The reviewer must read the complete successor proof and delta and inspect the
changed files plus relevant callers, contracts, and tests. It expands to the full
patch only when the delta changes a contract used outside it, touches a security
or compatibility surface, or the proof fails to verify; delta size alone is not a
reason. If any successor precondition fails, the task records an explicit `FULL`
fallback and the reviewer reviews the complete patch. The optimization changes
context selection, not the final local gate.

`patch.diff` is a cumulative base-to-head diff, so on a long-lived branch a
`FULL` review re-reads code that earlier reviews already cleared. `open_review`
therefore returns `patch_index` under `current_snapshot`: the byte offset and
length of each file's section in `patch.diff`. A reviewer reads the sections
the reviewed behavior depends on through `read_review_artifact` and reports
which it skipped. The index always spans the entire patch: past 400 files it is
truncated, `patch_index_truncated` is set, and one final `path: null` entry
covers the whole remainder, which the reviewer must read in full.

The index is never stored: it is derived on demand from the same immutable
`patch.diff` the reviewer reads, so an index that disagrees with the served
bytes cannot exist, and nothing in the mutable ledger can redirect what a
reviewer skips. Before the index is served, the patch must reproduce the
round's committed `snapshot_hash`; coverage is contiguous from offset zero, so
bytes before the first recognized section land in a leading `path: null` entry
rather than outside the index. If the patch cannot be read or fails these
checks, `patch_index` is null and the reviewer reads the whole patch. The
local gate independently refuses to finalize when the stored patch no longer
matches its commitment. The index
is advisory and is not part of the snapshot commitment; a reader that ignores
it sees the same bytes.

## State machine

```text
WAITING_FOR_REVIEW
  ├─ no findings ──────────────────────────────> CLEAN
  └─ findings -> REVIEW_SUBMITTED
                   ├─ human_required ──────────> HUMAN_REQUIRED
                   └─ fixed/rejected -> AUTHOR_RESPONDED
                                          -> WAITING_FOR_REREVIEW
                                               ├─ all accepted, no new -> CLEAN
                                               ├─ only new -> CONTINUABLE_FINDINGS
                                               └─ prior still open -> HUMAN_REQUIRED

CLEAN -> snapshot recheck -> LOCAL_GATE_PASSED
```

An advisory review runs the same first transition and stops there. It accepts
`submit_review` and nothing else: `finalize_local_gate`, `submit_resolutions`,
and `prepare_rereview` each refuse it, so a panel over a third party's pull
request reports findings and can never mint a gate over code this operator did
not author. A ledger written before advisory mode carries no flag and gates as
it always did.
