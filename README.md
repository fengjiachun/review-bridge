# Review Bridge

[![CI](https://github.com/fengjiachun/review-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/fengjiachun/review-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/fengjiachun/review-bridge)](https://github.com/fengjiachun/review-bridge/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B%20%7C%20Linux-lightgrey.svg)](#platform-support)

A code-review handoff between an author task and an explicitly bound
reviewer: Claude Desktop, a fresh Codex task, a Hermes profile, or GitHub
Codex in remote-only publication mode. An explicitly authorized autonomous
workflow can drive the full path — local gate, draft pull request, remote
review, thread closure, ready-for-review — and stops at a recorded
`MERGE_READY`. Nothing starts without an operator instruction, and merging
stays a human decision.

Any MCP client can drive the author role (`--role author`). Codex is the
packaged author driver, so the walkthroughs below use it.

A local review runs like this:

1. You finish a change in a Codex task and ask it to prepare a review. Review
   Bridge captures an **immutable snapshot** of the diff and the changed files.
2. You open a **fresh reviewer context** — a new Claude Desktop conversation,
   a brand-new Codex task, or an isolated Hermes reviewer profile/context —
   which inspects the immutable snapshot and submits structured findings.
3. If the reviewer submits no findings, the review is already `CLEAN` and you
   finalize it. Otherwise you go back to the author task, **answer every
   finding**, and prepare round two.
4. A prior finding that still stands after round two becomes
   `HUMAN_REQUIRED`. Uncontested new findings become `CONTINUABLE_FINDINGS`
   and are addressed in a fresh full review; a clean review can then reach
   `LOCAL_GATE_PASSED`.

New to the project? [How Review Bridge reviews a change](docs/review-flow.md)
walks one change from commit to merge-ready and explains why each step exists.

Review Bridge is an independent community project. It is not affiliated with,
endorsed by, or sponsored by OpenAI or Anthropic.

## Contents

- [How Review Bridge reviews a change](docs/review-flow.md)
- [Platform support](#platform-support)
- [Install](#install)
- [Hermes reviewer profile](#hermes-reviewer-profile)
- [Use](#use)
- [Successor reviews](#successor-reviews)
- [State machine](#state-machine)
- [GitHub publication gate](#github-publication-gate)
- [Security and scope](#security-and-scope)
- [Data handling and cleanup](#data-handling-and-cleanup)
- [Develop](#develop)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Platform support

Review Bridge supports macOS 13 Ventura or newer and Linux. The Claude Desktop
extension manifest remains Darwin-only; the Codex and Hermes integrations run
on both supported platforms. Windows is not supported or tested. State locking
uses `/usr/bin/lockf` on macOS, `/usr/bin/flock` on Linux, and `/bin/ps` on
both.

Node.js 18 or newer is required. CI verifies each change on macOS and Ubuntu
with Node 20.
The GitHub publication collector also requires an authenticated
[GitHub CLI](https://cli.github.com/) (`gh auth status`).

## Install

The client integrations install differently:

| Component | Source |
| --- | --- |
| Claude Desktop reviewer extension | Prebuilt `.mcpb` on the [latest release](https://github.com/fengjiachun/review-bridge/releases/latest) |
| Codex plugin (author + `CODEX_TASK` reviewer) | Build from a clone at the same release tag — the marketplace directory is not published as a release asset |
| Hermes reviewer and author profiles | `hermes-integration/` inside the same build output — see [Hermes reviewer profile](#hermes-reviewer-profile) |

Install every process that shares a store from the same Review Bridge build. Do
not mix a locking-enabled build with artifacts from an earlier release; earlier
processes do not participate in the locking protocol.

Because the integrations come from different places, **pin every participant
to the same release tag**: install the extension from a release, then build the
Codex plugin and Hermes integration from a checkout of that same tag. Building
from an arbitrary `main` checkout can pair a newer author process with an older
reviewer against one store. The version examples below use `v0.7.0`; substitute
the exact release you installed.

### Claude Desktop extension

Download `review-bridge-reviewer-<version>.mcpb` from the
[latest release](https://github.com/fengjiachun/review-bridge/releases/latest),
and note the tag — you will build the Codex plugin from it. A `.dxt`
compatibility copy is published for Claude Desktop versions that still use the
older file extension; the two files are byte-identical.

Optionally verify the download against the release's `SHA256SUMS.txt`:

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

Then, in Claude Desktop:

1. Open **Settings → Extensions → Advanced settings**.
2. Choose **Install Extension**.
3. Select the `.mcpb` file. If the picker only accepts `.dxt`, select the
   compatibility copy.
4. Keep the default Review Bridge data directory, or select the same directory
   configured through `REVIEW_BRIDGE_HOME` for Codex.
5. Restart Claude Desktop if its tools do not appear immediately.

### Codex plugin

Clone the repository and check out the release tag matching the extension you
installed, then build the local marketplace and register it:

```bash
git clone https://github.com/fengjiachun/review-bridge.git
cd review-bridge
git checkout v0.7.0
npm ci
npm run build
codex plugin marketplace add "$(pwd)/dist/review-bridge-v0.7.0/codex-marketplace"
```

Build from a Git clone, not from the release's source archive: `scripts/build.mjs`
runs `git status` to reject a dirty tree, which fails outside a Git worktree. The
archive is for inspection and provenance.

Restart the Codex desktop app, open Plugins, select **Review Bridge Local**, and
install **Review Bridge**.

The local marketplace remains the source of the installed plugin. Keep the
`codex-marketplace` directory in place while using this build.

Two things about `npm run build` are worth knowing before you run it: it refuses
to build from a working tree with any modified or untracked file, and it runs
`npm install` for the packaged runtime, so it needs network access. A fresh
clone at a release tag satisfies both. See [Develop](#develop) for the full
build and verification loop.

### Hermes reviewer profile

Hermes is a supported local reviewer provider. The build output contains
`hermes-integration/`, which packages the same server runtime plus:

- `mcp/reviewer.config.yaml` — a reviewer-only Hermes MCP config snippet.
- `mcp/author.config.yaml` — a separate author-only Hermes MCP config snippet.
- `skills/review-bridge-reviewer/SKILL.md` — the Review Bridge-owned Hermes
  reviewer skill.
- `README.md` — install, upgrade, and profile-isolation instructions.

Hermes auto-injects every tool from a configured MCP server into the profile
that references it, so **author and reviewer MUST live in separate Hermes
profiles**: the reviewer profile receives only the reviewer server and skill,
and the author profile receives only the author server. Never add the
author/publication server to the reviewer profile, and never add a reviewer
provider binding to the author profile.

Run `npm run verify:build`, then render `__REVIEW_BRIDGE_RELEASE_PATH__` to the
absolute, versioned `review-bridge-v0.7.0/hermes-integration` directory and
`__REVIEW_BRIDGE_HOME__` to one explicit absolute shared store. Merge each
snippet's server entry into only its matching profile's top-level `mcp_servers`
mapping.
All participants share that one `REVIEW_BRIDGE_HOME` and one exact Review
Bridge version. The packaged `hermes-integration/README.md` gives the complete
install, profile tool checks, and atomic upgrade procedure.

`HERMES` records configured reviewer provenance; it is not cryptographic model
identity. Autonomous local task creation remains `CODEX_TASK`-only. After a
local HERMES gate passes, remote GitHub Codex publication remains an
author/publication-side operation.

### Build output

`npm run build` writes everything under `dist/review-bridge-v0.7.0/`:

- `codex-marketplace/` — local Codex marketplace containing the Review Bridge
  plugin, author MCP server, and `CODEX_TASK` reviewer MCP server.
- `review-bridge-reviewer-v0.7.0.mcpb` — MCP Bundle for Claude Desktop.
- `review-bridge-reviewer-v0.7.0.dxt` — compatibility copy of the same bundle.
- `claude-extension-source/` — inspectable source of the Claude extension.
- `hermes-integration/` — Hermes profile MCP config snippets (separate author
  and reviewer), the Review Bridge-owned Hermes reviewer skill, and
  install/upgrade/isolation documentation, with the same packaged server
  runtime.
- `review-bridge-source-v0.7.0.zip` — source archive of the built commit, for
  inspection and provenance. It carries no Git metadata, so it cannot be used to
  run the build itself.
- `SHA256SUMS.txt` — checksums for the bundle, compatibility copy, and source
  archive.

Set `REVIEW_BRIDGE_OUTPUT_ROOT` to write a build to a different directory.

### Shared data directory

All MCP processes use this default shared data directory:

```text
~/Library/Application Support/ReviewBridge
```

Set `REVIEW_BRIDGE_HOME` to override it. When installing the Claude extension,
select the same directory in its configuration.

## Use

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
errors. See [Troubleshooting](#troubleshooting) for what each one means and
whether retrying is safe.

For a `CODEX_TASK` review, create a new Codex task. Do not fork the author task
or include its chat history. Give the new task only this request:

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

Configured Hermes MCP tools are profile-scoped and auto-injected, so this
reviewer context is independent only when its profile contains the
reviewer-only MCP server and no Review Bridge author/publication server.

If the reviewer submitted no findings, the review is already `CLEAN` and its
next action is `FINALIZE_LOCAL_GATE`; there is nothing to answer and
`prepare_rereview` will reject the state. Skip ahead and finalize.

Otherwise, back in Codex:

> Read the reviewer's findings, address each one, and prepare round two.

Resume the same reviewer context for round two. The final state is one of:

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

### Operator narration

The author-side driver narrates local review progress in the session the
operator is already watching. When a round reports findings, it presents each
finding's ID, severity, one-line summary, and location. When it submits author
resolutions, it presents each persisted disposition. For fixed resolutions
that proceed to rereview, it derives the affected files and fix commit from the
immutable preceding and latest review rounds. A mixed `fixed` and
`human_required` submission moves directly to `HUMAN_REQUIRED`, so no rereview
round binds the fixed files or commit; the driver explicitly reports that
metadata as unavailable instead of inferring it. After rereview, it presents
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

## Autonomous workflow

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
headroom; crossing it does not block, but the driver must state whether it will
continue or split before dispatch. An oversized snapshot binds normally but
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
operator work. The existing manual publication flow below remains unchanged.

## GitHub publication gate

Publishing to GitHub requires an explicit authorization, in one of two modes:

```text
LOCAL_GATE_PASSED ────────────┐
REMOTE_ONLY authorization ────┴─> publication baseline
  -> bound @codex review request
  -> atomic GitHub snapshot
  -> MERGE_READY
  -> finalize + immediate verification
```

`LOCAL_GATE` is the default: a passed local review authorizes publication.
`REMOTE_ONLY` is available only when the operator directly chooses to skip local
review. Its `authorize_remote_publication` tool records the exact
`LOCAL_REVIEW_SKIPPED` acknowledgement, operator label, rationale, clean local
repository, reviewed base SHA, and head SHA under a new review ID, and does not
create or claim `LOCAL_GATE_PASSED`. The reviewed base is the merge base of the
freshly observed PR base tip and head, so an advanced base branch does not need
to be an ancestor of the feature head.

Either way, the author tools bind the selected authorization, pull request,
required checks, exact request, pinned Codex Bot actor, result, and review
threads to **one head SHA**. Every mutation carries an expected revision and
revokes an older `publication-gate.json`. Finalization creates an expiring gate
and appends a chained audit event; Codex must call `verify_publication_gate`
immediately before a head-matching merge.

The GitHub adapter is deliberately fail-closed: a standalone review comment, a
reaction, silence, an unbound or unsupported request, incomplete pagination,
or an ambiguous result all fail rather than pass. Version-2 requests carry a
server-derived ID. If Codex omits it, Review Bridge accepts only one recorded
open request with no preceding unbound request, no compatible unresolved
baseline request, and a compatible reviewed-commit prefix or native GitHub
`commit_id`. A historical baseline request is head-scoped only when its exact
GitHub facts match a valid prior local publication ledger; caller-supplied
provenance is rejected. Multiple candidates and incompatible heads remain
ambiguous. Inline comments count only when structurally attached to a formal
review. Legacy ambiguity still requires direct human approval of the complete
resource-scoped request/result set.

Version 0.4 writes authorization-union publication ledgers with schema version 2
and remains able to read and complete version-1 local-gate ledgers. New
baselines use GitHub adapter version 2; adapter-version-1 publication ledgers
remain completable.

Use `get_publication_summary` for the compact current revision,
`blocking_reason`, `next_action`, gate state, and exact ambiguity sets. It does
not access GitHub or return the full ledger. When `next_action` is
`POST_AND_RECORD_CODEX_REVIEW_REQUEST`, post the returned
`codex_review_request.body` unchanged and bind the post with its
`codex_review_request.request_id` when present. Adapter-version-1 ledgers
return the legacy exact body without an ID. For a fresh snapshot, run the
packaged read-only collector against the review ID:

```bash
node dist/review-bridge-v0.7.0/codex-marketplace/plugins/review-bridge/scripts/collect-github-observation.mjs --review-id <review_id>
```

Run that command from the repository root after `npm run build`. Inside an
installed Codex plugin, the workflow skill resolves the same helper as
`../../scripts/collect-github-observation.mjs` relative to its own `SKILL.md`.
The collector reads the ledger from the store itself, uses the authenticated
`gh` CLI, follows every required REST and GraphQL page, canonicalizes GitHub
timestamps to UTC milliseconds, and fails closed when required policy evidence
is unavailable. It writes the observation into the private store beside the
ledger and prints only a receipt; pass the printed path to
`record_github_snapshot` as `observation_path`. An explicit `--out` is refused
inside any Git worktree, because an untracked observation file would dirty the
reviewed repository and fail publication-gate verification.

Neither the ledger nor the observation should be routed through the reviewing
or authoring model. Both run to tens of thousands of tokens, and a model that
retypes them pays for the same bytes twice — once to read them and again to
emit them — while adding a transcription failure mode the file handoff does not
have. The collector still accepts a ledger path or stdin, and
`record_github_snapshot` still accepts an inline `observation`, for callers that
have already loaded the data by other means.

The packaged Codex plugin also includes
`scripts/inspect-publication-audit.mjs <review_id>` for read-only, full-chain
offline audit validation.

### Head-SHA discipline

Before requesting GitHub review, both the local branch head and PR head must
equal the selected authorization's `head_sha`. A mismatch invalidates the
publication ledger. After any fix commit, create a new local review task or a
new explicit remote-only authorization according to the selected mode. Required
checks and a new GitHub Codex review must then pass for that new exact PR head.

For a publishable change, resolve the review base to an immutable commit SHA
before committing, then pass that SHA to `prepare_review`. Commit before local
review and commit fixes before rereview. This binds the reviewed diff to the
pre-change base and the local snapshot to the exact commit later pushed as the
PR head.

Design background: [RFC 0001 — GitHub Publication
Ledger](docs/rfcs/0001-github-publication-ledger.md).

## Security and scope

- The bound local reviewer receives read-only snapshot/search tools and
  verdict-writing tools. It has no Review Bridge tool for modifying the
  repository, pushing code, or creating pull requests.
- Author and reviewer roles run as separate MCP processes with different tool
  lists. Each local review is immutably bound to `CLAUDE_DESKTOP`, `CODEX_TASK`,
  or `HERMES`; mismatched reviewer processes cannot list, read, or submit it.
- Working-tree overlays are copied into the private review store. Unchanged
  files are read from the captured Git object ID.
- Files larger than 10 MiB are recorded but not copied into the snapshot.
- Per-review author/reviewer mutations and publication mutations use separate
  inter-process locks across processes from the same locking-enabled build.
  Earlier processes do not participate in that protocol. A retryable
  `REVIEW_BUSY` or `PUBLICATION_BUSY` response means another process owns that
  state; reread the relevant state before retrying.
- Local, remote-only, and publication gates are workflow attestations, not Git
  or GitHub security boundaries. Review Bridge does not install a `pre-push`
  hook.
- The Review Bridge MCP server receives no GitHub credentials. The packaged
  Codex skill and read-only observation collector use the user's separately
  configured GitHub tools after the selected publication authorization exists.

Provider binding and separate Codex tasks are workflow attestations, not
authenticated human or model identity. A `CODEX_TASK` review improves context
isolation but does not provide the model diversity of a separate provider.

Claude Desktop is a local application, but that does not imply local model
inference. Apply your Anthropic account and organization data policy before
reviewing confidential code.

## Data handling and cleanup

The review store contains repository paths, requirements, patches, manifests,
review findings, remote-only operator labels and rationales, and copies of
changed working-tree files. Review Bridge creates store directories with mode
`0700` and files with mode `0600`.

The Review Bridge MCP servers do not contain a network client or telemetry
integration. The selected client may send source returned by reviewer tools to
its model provider according to the account and organization configuration in
use.

Review data is retained until it is deleted. To remove one task, stop active
Review Bridge operations and delete `reviews/<review_id>` inside the configured
store. To remove all tasks, quit active Codex and Claude Desktop reviewer
processes and delete the configured Review Bridge directory.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the supported
release policy.

## Develop

Requirements: macOS 13 Ventura or newer with `/usr/bin/lockf` and `/bin/ps`, or
Linux with `/usr/bin/flock` and `/bin/ps`; Node.js 18 or newer; npm; and Git.
`npm run verify:build` additionally requires `unzip`.

```bash
npm ci
npm test
npm audit --omit=dev
npm run build
npm run verify:build
```

`npm run build` refuses to run against a dirty working tree and needs network
access to install the packaged runtime. The check uses
`git status --untracked-files=all`, so untracked files block it too; see
[Troubleshooting](#troubleshooting) for how to clear them. Set
`REVIEW_BRIDGE_OUTPUT_ROOT` to write the build somewhere other than `dist/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request process and
[docs/rfcs/](docs/rfcs/) for design records. Release history is in
[CHANGELOG.md](CHANGELOG.md).

## Troubleshooting

State-changing tools return structured errors. Whether a retry is safe depends
on `details`:

**`REVIEW_BUSY` with `details.retryable: true`** — another process owns the
review lock and the bounded wait expired. Call `get_review_summary` and retry
the same transition only if it is still required.

**`PUBLICATION_BUSY` with `details.retryable: true`** — another process owns the
publication lock and the bounded wait expired. Call `get_publication` for the
current state and revision, then retry the same transition only if it is still
required.

Errors with `details.retryable: false` are fail-closed: resolve the stated cause
before retrying. Three of them also set `details.state_may_have_changed: true`,
meaning the write may already be on disk:

**`LOCK_OWNERSHIP_LOST`** — the transition may already have been applied. Call
`get_review_summary` after a review operation or `get_publication` after a
publication operation before deciding whether any retry is still required.

**`LOCK_CLEANUP_FAILED`** — the protected write may already be on disk while the
named lock record remains. Stop the owning Review Bridge process before
inspecting or removing that record. After cleanup, reread the affected review or
publication state; do not loop on the same mutation.

**`STORE_WRITE_INDETERMINATE`** — the canonical file was replaced, but syncing
its parent directory failed. Call `get_review_summary` after a review operation
or `get_publication` after a publication operation before deciding whether any
retry is still required.

Other common situations:

**`npm run build` fails immediately with `refusing to build from a dirty working
tree`** — the check runs `git status --porcelain --untracked-files=all`, so
untracked files count, and a plain `git stash` will not clear them. Commit the
changes, delete the stray files, or stash everything including untracked:

```bash
git stash --include-untracked
```

**`npm run build` fails with `fatal: not a git repository`** — you are building
from the extracted source archive. That check needs a Git worktree; clone the
repository and check out the release tag instead.

**Claude Desktop shows no Review Bridge tools** — restart the app. If they are
still missing, confirm the extension's data directory matches the Codex
`REVIEW_BRIDGE_HOME`.

**A reviewer cannot see a pending review** — each review is immutably bound to
one provider. A `CLAUDE_DESKTOP`, `CODEX_TASK`, or `HERMES` reviewer cannot list
or open a review bound to either of the other providers.

## License

[MIT](LICENSE).
