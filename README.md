# Review Bridge

[![CI](https://github.com/fengjiachun/review-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/fengjiachun/review-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/fengjiachun/review-bridge)](https://github.com/fengjiachun/review-bridge/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B%20%7C%20Linux-lightgrey.svg)](#platform-support)

A code-review handoff between an author task and an explicitly bound
reviewer: Claude Desktop, a fresh Codex task, a Hermes profile, a DeepSeek
Harness profile, or GitHub Codex in remote-only publication mode. An
explicitly authorized autonomous workflow can drive the full path — local
gate, draft pull request, remote review, thread closure, ready-for-review —
and stops at a recorded
`MERGE_READY`. Nothing starts without an operator instruction, and merging
stays a human decision.

Any MCP client can drive the author role (`--role author`). Codex is the
packaged author driver, so the walkthroughs below use it.

A local review runs like this:

1. You finish a change in a Codex task and ask it to prepare a review. Review
   Bridge captures an **immutable snapshot** of the diff and the changed files.
2. You open a **fresh reviewer context** — a new Claude Desktop conversation,
   a brand-new Codex task, or an isolated Hermes or DeepSeek Harness reviewer
   profile — which inspects the immutable snapshot and submits structured
   findings.
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
- [Hermes reviewer profile](docs/install/hermes.md)
- [DeepSeek Harness reviewer profile](docs/install/deepseek-harness.md)
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
| Hermes reviewer and author profiles | `hermes-integration/` inside the same build output — see [Hermes reviewer profile](docs/install/hermes.md) |
| DeepSeek Harness reviewer and author profiles | `deepseek-harness/` inside the same build output — see [DeepSeek Harness reviewer profile](docs/install/deepseek-harness.md) |

Install every process that shares a store from the same Review Bridge build. Do
not mix a locking-enabled build with artifacts from an earlier release; earlier
processes do not participate in the locking protocol.

Because the integrations come from different places, **pin every participant
to the same release tag**: install the extension from a release, then build the
Codex plugin and Hermes integration from a checkout of that same tag. Building
from an arbitrary `main` checkout can pair a newer author process with an older
reviewer against one store. The version examples below use `v0.15.1`; substitute
the exact release you installed.

Install the Claude Desktop extension: see [docs/install/claude-desktop.md](docs/install/claude-desktop.md).

Install the Codex plugin: see [docs/install/codex-plugin.md](docs/install/codex-plugin.md).

Install the Hermes reviewer profile: see [docs/install/hermes.md](docs/install/hermes.md).

`HERMES` records configured reviewer provenance; it is not cryptographic model
identity. Autonomous local task creation remains `CODEX_TASK`-only. After a
local HERMES gate passes, remote GitHub Codex publication remains an
author/publication-side operation.

Install the DeepSeek Harness reviewer profile: see [docs/install/deepseek-harness.md](docs/install/deepseek-harness.md).

### Build output

`npm run build` writes everything under `dist/review-bridge-v0.15.1/`:

- `codex-marketplace/` — local Codex marketplace containing the Review Bridge
  plugin, author MCP server, and `CODEX_TASK` reviewer MCP server.
- `review-bridge-reviewer-v0.15.1.mcpb` — MCP Bundle for Claude Desktop.
- `review-bridge-reviewer-v0.15.1.dxt` — compatibility copy of the same bundle.
- `claude-extension-source/` — inspectable source of the Claude extension.
- `hermes-integration/` — Hermes profile MCP config snippets (separate author
  and reviewer), the Review Bridge-owned Hermes reviewer skill, and
  install/upgrade/isolation documentation, with the same packaged server
  runtime.
- `deepseek-harness/` — DeepSeek Harness cordis patch snippets (separate author
  and reviewer), the Review Bridge-owned DeepSeek Harness reviewer skill, and
  install/upgrade/isolation documentation, with the same packaged server
  runtime.
- `review-bridge-source-v0.15.1.zip` — source archive of the built commit, for
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
errors. See [Troubleshooting](docs/troubleshooting.md) for what each one means and
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

### Operator narration

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

A panel's `CODEX_TASK` member reads a third party's diff, so it is launched
only through the packaged `scripts/advisory-sandbox-launch.mjs` in the Codex
plugin, which runs the reviewer inside a Linux container that is the
filesystem read boundary: the operator's `auth.json` bind-mounted read-only,
the packaged plugin read-only, a fresh clone the launcher makes from the author
checkout read-only at the recorded path (the operator's `.git` never enters), a staged copy of the
one review read-write (the host store is never mounted; the staged bytes are
never copied back — the verdict is replayed through the host's own
`submit_review` under the review's state lock and kept only if the replay
equals the staged ledger), an isolated
`CODEX_HOME`, and egress only through a sidecar proxy that admits
`chatgpt.com`, `api.openai.com`, and `auth.openai.com`, by CONNECT host and
by the TLS SNI the client then presents. Inside the container the reviewer runs
with `--sandbox danger-full-access`; the container's own default confinement
is the boundary and is not weakened to fit Codex's nested sandbox. The
launcher fails closed without Docker and prints the three criteria it
verified on exit. On Docker Desktop keep the panel worktree, the runtime
marketplace, and the store under your home directory: the launcher refuses a
path under `/private/tmp/` or `/Volumes/`, where Docker Desktop stops serving
files a few seconds into a container. The residual is the credential it must carry: a narrowly
scoped API key in place of the ChatGPT token is the operator's option. The
packaged workflow skill's Dispatching a CODEX_TASK review section states the
full form.

## Autonomous workflow

See [Autonomous workflow](docs/autonomous-workflow.md).

## GitHub publication gate

See [GitHub publication gate](docs/publication-gate.md), including its Head-SHA discipline.

## Security and scope

- The bound local reviewer receives read-only snapshot/search tools and
  verdict-writing tools. It has no Review Bridge tool for modifying the
  repository, pushing code, or creating pull requests.
- Author and reviewer roles run as separate MCP processes with different tool
  lists. Each local review is immutably bound to `CLAUDE_DESKTOP`, `CODEX_TASK`,
  `HERMES`, or `DEEPSEEK_HARNESS`; mismatched reviewer processes cannot list,
  read, or submit it.
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
- An advisory `CODEX_TASK` review over a third party's pull request runs only
  inside the container the packaged `advisory-sandbox-launch.mjs` builds; the
  host filesystem is absent there, not denied, and the one host secret inside
  is the operator's `auth.json`.
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
[Troubleshooting](docs/troubleshooting.md) for how to clear them. Set
`REVIEW_BRIDGE_OUTPUT_ROOT` to write the build somewhere other than `dist/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request process and
[docs/rfcs/](docs/rfcs/) for design records. Release history is in
[CHANGELOG.md](CHANGELOG.md).

## Troubleshooting

See [Troubleshooting](docs/troubleshooting.md) for structured errors and build failures.

**A reviewer cannot see a pending review** — each review is immutably bound to
one provider. A `CLAUDE_DESKTOP`, `CODEX_TASK`, `HERMES`, or `DEEPSEEK_HARNESS`
reviewer cannot list or open a review bound to any of the other providers.

## License

[MIT](LICENSE).
