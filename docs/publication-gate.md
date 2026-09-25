# GitHub publication gate

Describes Review Bridge v0.18.0.

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
not access GitHub or return the full ledger. A finalized gate also reports
`gate_expires_in_seconds`: the gate expires five minutes after the oldest source
collection in the observation it was minted over, not five minutes after
issuance, so part of that window is already spent when the gate first exists.
Its `required_inputs` — like the one on `get_review_summary`,
`get_autonomous_workflow_summary`, and `list_autonomous_workflows` — names the
calls the current action implies as `{tool: [[field, source], ...]}`, so a
driver never has to discover a schema by sending empty arguments. When
`next_action` is
`POST_AND_RECORD_CODEX_REVIEW_REQUEST`, post the returned
`codex_review_request.body` unchanged and bind the post with its
`codex_review_request.request_id` when present. Adapter-version-1 ledgers
return the legacy exact body without an ID. For a fresh snapshot, run the
packaged read-only collector against the review ID:

```bash
node dist/review-bridge-v0.18.0/codex-marketplace/plugins/review-bridge/scripts/collect-github-observation.mjs --review-id <review_id>
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

## Review statistics

`scripts/review-scorecard.mjs` aggregates the ledgers already in the configured
store into one report: findings by severity, author dispositions crossed with
reviewer decisions, rebuttal outcomes before and after the verification
obligation, rounds to CLEAN, continuations, workflow budget events, and human
arbitration escalations, each per reviewer provider and overall. It prints
markdown, or JSON with `--json`, and states every counting rule in the report
itself so a number can be replayed against the ledgers it came from. It reads
one store, writes nothing, sends nothing anywhere, and lists a ledger it cannot
parse as skipped rather than repairing it.

For example, to summarize September 2026 reviews by reviewer provider, including
recorded rebuttal outcomes:

```bash
node dist/review-bridge-v0.18.0/codex-marketplace/plugins/review-bridge/scripts/review-scorecard.mjs \
  --since 2026-09-01 --until 2026-10-01
```

Replace the dates for another month. The period selects **reviews created in
that month**, not rebuttal events occurring in that month. Groups are reviewer
providers such as `CODEX_TASK`, not a ranking of individual models.

Use review filters together to compare the same period, repository, review
type, and strategy:

```bash
node dist/review-bridge-v0.18.0/codex-marketplace/plugins/review-bridge/scripts/review-scorecard.mjs \
  --since 2026-09-01 --until 2026-10-01 \
  --repository /path/persisted/in/the/ledger \
  --review-type gate --strategy FULL --json
```

Run the packaged helper from the repository root after `npm run build`.
Set `REVIEW_BRIDGE_HOME` to select another store. Every supplied filter must match:

- `--since` and `--until` accept `YYYY-MM-DD` (UTC midnight) or an ISO timestamp
  with seconds, optional millisecond precision, and an explicit `Z` or UTC
  offset. They compare `review.created_at` as UTC instants in `[since, until)`:
  the lower bound is inclusive and the upper bound is exclusive. Invalid dates
  and `since >= until` are rejected.
- `--repository` matches the ledger's persisted `repository_path` string
  exactly. It does not resolve a filesystem path, normalize it, or combine
  matching basenames, and the recorded worktree need not still exist.
- `--review-type` accepts `gate` or `advisory`; `--strategy` accepts `FULL` or
  `SUCCESSOR`. Strategy means the review's current `review_strategy.mode`,
  not a separate selection of its historical rounds. Missing/null legacy
  fields follow core compatibility defaults: provider `CLAUDE_DESKTOP`,
  review type `gate`, and strategy `FULL`.

All review counters, denominators, and the corpus's earliest/latest
`created_at` come from the same selected valid reviews. Read/validation
diagnostics describe the whole scanned review store, including unreadable or
invalid ledgers that cannot be classified reliably; they are not selected
review counts. Valid reviews excluded by the filters are counted separately
as `corpus.reviews_filtered_out`. An empty selection has zero counters and
null corpus timestamps and rates whose denominator is zero.

Review filters do not identify an entire workflow or its audit events. With
any filter enabled, the helper does not read workflow ledgers or audit logs:
JSON `workflows`, corpus workflow/audit counts, and workflow/audit diagnostic
lists are null, and
`scope.workflow_omission_reason` explains their omission. Markdown gives the
same explanation. With no filters, existing workflow statistics remain
included over the whole store.

The JSON schema is version 2. It preserves existing unfiltered counters and
adds `filters`, `scope`, `metric_semantics`, `corpus.reviews_filtered_out`, and
each provider's `reviews_by_type` and `advisory_reported`. Consumers should
check `schema_version` and handle the null workflow fields in filtered
reports. The raw `not_clean` counter means a status other than `CLEAN` or
`LOCAL_GATE_PASSED`; it is not a failure count. An advisory review reaches a
terminal report at `REVIEW_SUBMITTED` (counted in `advisory_reported`) or
`CLEAN` (counted in the existing clean totals). Markdown excludes reported
advisory reviews from its in-flight count. Author disposition, rebuttal, and
continuation metrics describe the gate author/rereview loop; advisory reviews
have no author loop, and advisory `CLEAN` does not attest a gate.

These are recorded outcomes, not model accuracy: `fixed`/`resolved` does not
establish accuracy, and `rebuttal_accepted` does not establish a false
positive. A strategy's `parent_review_id` is not evidence of a continuation
or rework chain.

## Read one review report

The author tool `render_review_report` and the packaged
`scripts/review-report.mjs <review_id> [--full] [--json] [--store <path>]`
render one review's ledger, and its publication ledger when present, as a
Markdown report a person can read in one sitting (a `REMOTE_ONLY` publication,
which has no review ledger, renders from its publication and authorization
alone).

The script prints a brief by default: the terminal state and where the review
goes next in the first two lines, a fact table, the findings still open before
the ones already settled, the round-level facts, and a pointer to the full
rendering. Every number in it is counted over the ledger and every grouping is
one the ledger decides -- severity, the round a finding was introduced in,
whether two findings name the same title at the same location -- because the
renderer calls no model; a line that would read across findings to say what
they have in common is out of its reach, and it states the counting rule
instead. A review with nothing open says so rather than heading an empty
section, and a `REMOTE_ONLY` publication briefs in the same shape.

`--full` prints the full rendering, which is also what the tool writes:
requirement and scope, each round's findings
with the author's disposition and the rereviewer's decision, what changed
between rounds, the terminal state, and the pull request, Codex results,
checks, and threads a publication recorded. Both tiers read the same ledgers
through the same reader and print the same report revision in their footer;
`--json` names which tier it rendered. The tool writes
`reviews/<review_id>/report-r<state_version>[-p<revision>-s<summary digest>]-f<renderer format>.md`
(`report-p<revision>-s<summary digest>-f<renderer format>.md` when remote-only) beside the ledger
and returns a receipt -- path, byte count, sha256, the ledger revisions and
the summary digest rendered -- rather than the Markdown, which can run to
megabytes; the script only prints. The summary digest covers the publication
summary fields the report prints, so a gate appearing or evidence expiring
writes a new report rather than reusing one that says otherwise. The `f<N>` is
the renderer's own format version, raised whenever the Markdown changes, so an
upgrade writes its report beside the ones earlier versions wrote instead of
colliding with them. Both read every ledger through the reader the server
itself uses, so a publication that is not canonical, names another review, or
is not bound to the gate or authorization file beside it fails the render with
that reader's error, and a review ledger filed under another review's id is
refused. Neither changes a ledger, consumes a round, or touches a gate. The workflow skill renders the report once `LOCAL_GATE_PASSED` is
recorded and again once a publication reads `MERGE_READY`, and opens it in
Plannotator when that tool is on PATH; annotations never flow back into the
ledger. Like operator narration, the report is a projection of the ledger, not
evidence.

## Head-SHA discipline

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
Ledger](rfcs/0001-github-publication-ledger.md).
