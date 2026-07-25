# RFC 0001: GitHub Publication Ledger

| Field | Value |
| --- | --- |
| Status | Draft |
| Authors | Review Bridge contributors |
| Created | 2026-07-25 |
| Target release | v0.2.0 |

## Summary

Add a local GitHub publication ledger that binds a passed Claude review, pull
request head, required checks, GitHub Codex review, and unresolved review
threads to one commit. The ledger derives a fail-closed publication state and
produces a `MERGE_READY` attestation only after a fresh, coherent GitHub
observation passes every invariant.

## Motivation

Review Bridge v0.1.1 proves that a local Claude review reached
`LOCAL_GATE_PASSED` for an immutable base SHA, head SHA, and snapshot hash.
Publication through GitHub is currently coordinated by the Codex skill:

1. push the reviewed commit and open a pull request;
2. wait for required checks;
3. post exactly `@codex review`;
4. wait for the GitHub Codex result and inspect unresolved review threads; and
5. merge only if every observation still applies to the pull request head.

Those rules are fail-closed, but their GitHub evidence exists only in the live
GitHub state and the active Codex conversation. A missed step or evidence from
different commits can therefore produce an incorrect workflow decision.

## Goals

- Persist the GitHub publication evidence associated with one local review.
- Bind the local gate, pull request, checks, Codex request, Codex result, and
  review threads to one head SHA.
- Derive publication status from a single coherent GitHub observation.
- Invalidate publication immediately when the pull request head differs from
  the locally reviewed head.
- Keep GitHub credentials out of the Review Bridge MCP server.
- Preserve the existing rule that the ledger is a workflow attestation, not a
  Git or GitHub security boundary.

## Non-goals

- Automatically merge a pull request.
- Replace GitHub branch protection, rulesets, or required checks.
- Make GitHub evidence cryptographically unforgeable.
- Give the Claude reviewer GitHub access.
- Support review providers other than GitHub Codex in the first version.
- Migrate existing local review records when no publication was started.

## Security considerations

The Codex plugin continues to use the user's separately configured GitHub
tools. It performs external reads and writes, then supplies a normalized
observation to the Review Bridge author server.

The author server:

- never receives or stores a GitHub token;
- never invokes the GitHub API;
- validates the observation schema and all cross-SHA invariants;
- persists evidence with private filesystem permissions; and
- fails closed when evidence is missing, stale, inconsistent, or unknown.

The server cannot independently prove that a supplied GitHub observation is
authentic. Before merge, Codex must refresh the live GitHub state, record that
observation, finalize the publication gate, and use a head-matching merge
operation. Stronger authenticity would require a future GitHub App or signed
attestation.

## Storage

Publication state is separate from the local review state:

```text
reviews/<review_id>/
├── review.json
├── gate.json
├── publication.json
└── publication-gate.json
```

Separating the files keeps the Claude review lifecycle unchanged and prevents
GitHub publication fields from becoming part of the reviewer protocol.

`publication.json` is the current mutable ledger. `publication-gate.json` is
written only after a fresh observation derives `MERGE_READY`. The gate is a
revocable view of one ledger revision, not an independent durable verdict. It
is valid only while its `publication_revision` equals the current ledger
revision and that revision still derives `MERGE_READY`.

All files use the existing private directory and file modes. Publication
mutations must use the same atomic replacement mechanism as review mutations,
plus a per-review inter-process lock and revision check so concurrent Codex
sessions cannot overwrite each other's observations.

Under that lock, any later ledger mutation must durably remove the canonical
`publication-gate.json` before replacing `publication.json`. If gate removal or
the parent-directory sync fails, the mutation aborts. A crash after removal can
leave a conservative missing gate, never a stale authoritative gate. Gate
consumers must call `verify_publication_gate`, which cross-checks the canonical
gate and current ledger under the publication lock, immediately before merge.
Direct file reads and previously returned or cached verification results never
authorize a later merge.

## Backward compatibility

Existing `review.json` and `gate.json` formats remain unchanged. Reviews created
before this RFC have no publication ledger and continue to support the local
Claude workflow. Publication tools are opt-in and available only after
`LOCAL_GATE_PASSED`.

The locking prerequisite adds a retryable `REVIEW_BUSY` failure to existing
state-changing author and reviewer tools. Clients that already surface MCP
errors require no schema migration, but release notes must document that a
caller should retry after rereading the review. Successful tool responses and
review-state transitions remain compatible.

The new files begin at schema version 1. Readers must reject unsupported future
versions instead of attempting a best-effort interpretation. A future schema
change must define an explicit migration or create a new publication ledger.

## Ledger schema

The initial schema is:

```json
{
  "version": 1,
  "revision": 4,
  "review_id": "rb-...",
  "created_at": "2026-07-25T08:00:00.000Z",
  "updated_at": "2026-07-25T08:05:00.000Z",
  "local_gate": {
    "head_sha": "0123456789abcdef...",
    "base_sha": "abcdef0123456789...",
    "snapshot_hash": "sha256...",
    "gate_sha256": "sha256..."
  },
  "target": {
    "repository_id": 123456,
    "owner": "owner",
    "repo": "repository",
    "pr_number": 5,
    "base_branch": "main",
    "head_branch": "agent/change"
  },
  "terminal": null,
  "codex_review_ambiguity_acknowledgements": [],
  "latest_observation": {
    "observed_at": "2026-07-25T08:05:00.000Z",
    "recorded_at": "2026-07-25T08:05:01.000Z",
    "pull_request": {
      "collection": {
        "status": "COMPLETE",
        "collected_at": "2026-07-25T08:05:00.000Z",
        "source": "REST_PULL_REQUEST"
      },
      "repository_id": 123456,
      "number": 5,
      "url": "https://github.com/owner/repository/pull/5",
      "state": "OPEN",
      "is_merged": false,
      "merged_at": null,
      "merge_commit_sha": null,
      "is_draft": false,
      "head_sha": "0123456789abcdef...",
      "head_branch": "agent/change",
      "base_branch": "main",
      "mergeable": "MERGEABLE"
    },
    "required_checks": {
      "collection": {
        "status": "COMPLETE",
        "collected_at": "2026-07-25T08:05:00.000Z",
        "policy_sources": [
          {
            "kind": "APPLICABLE_RULES",
            "endpoint": "GET /repos/{owner}/{repo}/rules/branches/{branch}",
            "result": "SUCCESS",
            "binding_field": "rules[].parameters.required_status_checks[].integration_id",
            "pagination_complete": true
          },
          {
            "kind": "BRANCH_METADATA",
            "endpoint": "GET /repos/{owner}/{repo}/branches/{branch}",
            "result": "SUCCESS",
            "protected": true
          },
          {
            "kind": "CLASSIC_BRANCH_PROTECTION",
            "endpoint": "GET /repos/{owner}/{repo}/branches/{branch}/protection",
            "result": "SUCCESS",
            "binding_field": "required_status_checks.checks[].app_id"
          }
        ]
      },
      "policy": "REQUIRED",
      "requirements": [
        {
          "context": "test",
          "app_binding": "PINNED",
          "required_app_id": 12345,
          "binding_sources": [
            {
              "kind": "CLASSIC_BRANCH_PROTECTION",
              "field": "required_status_checks.checks[].app_id"
            }
          ]
        }
      ],
      "runs": [
        {
          "run_id": 9001,
          "context": "test",
          "app_id": 12345,
          "head_sha": "0123456789abcdef...",
          "started_at": "2026-07-25T08:04:00.000Z",
          "completed_at": "2026-07-25T08:04:30.000Z",
          "status": "COMPLETED",
          "conclusion": "SUCCESS",
          "details_url": "https://github.com/..."
        }
      ]
    },
    "codex_review": {
      "collection": {
        "status": "COMPLETE",
        "collected_at": "2026-07-25T08:05:00.000Z",
        "source": "PULL_REQUEST_CONVERSATION_AND_REVIEWS",
        "pagination_complete": true
      },
      "requests": [
        {
          "comment_id": 100,
          "url": "https://github.com/...",
          "created_at": "2026-07-25T08:03:00.000Z",
          "body": "@codex review",
          "requested_head_sha": "0123456789abcdef..."
        }
      ],
      "results": [
        {
          "comment_id": 101,
          "url": "https://github.com/...",
          "created_at": "2026-07-25T08:04:00.000Z",
          "author": "chatgpt-codex-connector",
          "request_comment_id": 100,
          "association": "SINGLE_OPEN_REQUEST",
          "reviewed_head_sha": "0123456789abcdef...",
          "verdict": "CLEAN",
          "body_sha256": "sha256..."
        }
      ]
    },
    "review_threads": {
      "collection": {
        "status": "COMPLETE",
        "collected_at": "2026-07-25T08:05:00.000Z",
        "source": "GRAPHQL_PULL_REQUEST_REVIEW_THREADS",
        "pagination_complete": true
      },
      "total_count": 0,
      "unresolved_count": 0,
      "threads": []
    }
  },
  "status": "MERGE_READY",
  "history": [
    {
      "at": "2026-07-25T08:05:00.000Z",
      "event": "GITHUB_SNAPSHOT_RECORDED",
      "revision": 4,
      "status": "MERGE_READY",
      "head_sha": "0123456789abcdef..."
    }
  ]
}
```

GitHub object IDs and URLs are evidence locators. The ledger stores normalized
facts and a hash of the Codex response body instead of depending on mutable
free-form chat text as its source of truth.

Empty arrays never imply that collection succeeded. Each evidence class carries
`collection.status`, its source, collection time, and pagination completeness
where applicable. Any missing field, failed query, ambiguous permission error,
or incomplete page sequence makes the whole observation incomplete.

`collection.status` is `COMPLETE`, `INCOMPLETE`, or `UNKNOWN`. Policy-source
results are `SUCCESS`, `NOT_CONFIGURED`, `ERROR`, or `UNKNOWN`. Incomplete or
unknown collections are valid observations that derive
`EVIDENCE_INCOMPLETE`; malformed collection metadata is rejected.

Required-check policy discovery reads both:

- active rules applying to the base branch from
  `GET /repos/{owner}/{repo}/rules/branches/{branch}`; and
- branch metadata and classic branch protection from
  `GET /repos/{owner}/{repo}/branches/{branch}` and
  `GET /repos/{owner}/{repo}/branches/{branch}/protection`.

The required-check keys are the union of both successful policy reads. Each
requirement records:

- `app_binding`: `PINNED` or `EXPLICITLY_UNBOUND`;
- `required_app_id`, which is a positive integer exactly when the binding is
  `PINNED` and null exactly when it is `EXPLICITLY_UNBOUND`; and
- every identity-capable response field that supplied the binding.

The adapter normalizes a ruleset `integration_id` and a classic
branch-protection `checks[].app_id` into `required_app_id`. `PINNED` requires a
run with the same `context` and exact producing GitHub App ID.
`EXPLICITLY_UNBOUND` means GitHub returned an explicit null from an
identity-capable field and permits a matching check run or commit status from
any producer.

Reading the legacy classic `contexts[]` field, omitting
`rules[].parameters.required_status_checks[].integration_id`, or otherwise
using a response shape that cannot expose app identity is `UNKNOWN`, never
`SUCCESS` or `EXPLICITLY_UNBOUND`. Each policy source and requirement records
the exact binding field used, so the server can enforce this distinction.

Each run records the actual producing `app_id`, or null only when the
identity-capable run/status response explicitly has no GitHub App. A pinned
requirement never matches a null producer identity.

An authorization error or ambiguous `404` is `UNKNOWN`, not evidence that no
checks are configured. A classic-protection `404` may be classified as
`NOT_CONFIGURED` only when the same authenticated client successfully read the
branch metadata and every page of applicable rules immediately beforehand.
Otherwise it remains `UNKNOWN`.

`policy: "NONE_CONFIGURED"` is permitted only when complete policy discovery
produces an explicit empty result: the applicable-rules response contains no
required status-check rule, and classic protection is either present with no
required checks or conclusively `NOT_CONFIGURED`. It must accompany
`requirements: []` and `runs: []`; otherwise the observation is invalid. A
caller that cannot establish the policy or a required app binding derives
`EVIDENCE_INCOMPLETE`.

Multiple runs may share one requirement key. Every run records `started_at` and
`completed_at`; the latter is null until completion. For each
`(context, app_id)` producer key, the evaluator selects the latest attempt by
`(started_at, run_id)`. A `PINNED` requirement evaluates that exact producer
key. An `EXPLICITLY_UNBOUND` requirement selects the latest attempt across all
producer keys with the same context, again by `(started_at, run_id)`. A missing
ordering field or duplicate ordering key is incomplete evidence. Older attempts
remain in the ledger for audit but never satisfy a requirement or override the
latest attempt.

Normalized run status is one of `QUEUED`, `IN_PROGRESS`, `WAITING`,
`REQUESTED`, `PENDING`, or `COMPLETED`. A non-completed latest run derives
`CHECKS_PENDING`. A completed run must have exactly one of these conclusions:

- `SUCCESS`, `SKIPPED`, or `NEUTRAL` satisfies the requirement;
- `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, or
  `STARTUP_FAILURE` derives `CHECKS_FAILED`;
- `STALE` derives `CHECKS_PENDING` and requires a rerun; and
- a missing or unrecognized value derives `EVIDENCE_INCOMPLETE`.

For a commit status, the adapter uses its creation time as `started_at`, its
update time as `completed_at`, and normalizes `ERROR` to `FAILURE`. These
passing conclusions match GitHub's required-status-check semantics.

For an open pull request, `state` is `OPEN`, `is_merged` is false,
`merged_at` is null, and `merge_commit_sha` is normalized to null because
GitHub's pre-merge value may describe a test merge. Only `is_merged: true`
together with `state: "CLOSED"`, `merged_at`, and `merge_commit_sha` is merge
evidence.

Thread collection reads the complete paginated `reviewThreads` connection. It
records every normalized thread, not only unresolved threads, and the server
requires:

```text
total_count == threads.length
unresolved_count == threads.filter(thread => !thread.is_resolved).length
```

An empty thread array is acceptable only with `status: "COMPLETE"`,
`pagination_complete: true`, and both counts set to zero.

## Atomic GitHub observations

One `record_github_snapshot` call records all publication evidence observed at
the same time:

- pull request identity and current head SHA;
- draft, open, mergeability, and base-branch state;
- required-check policy provenance and every required run for the head;
- every exact `@codex review` request for the head;
- every candidate Codex result after those requests;
- the complete paginated review-thread collection and resolution counts; and
- the observation timestamp.

`observed_at` is captured immediately after the final GitHub response. Every
nested evidence collection has its own `collected_at`, and the server requires:

```text
publication.created_at <= collected_at <= observed_at
observed_at - collected_at <= 2 minutes
max(collected_at) - min(collected_at) <= 2 minutes
```

At both recording and finalization, every `collected_at` must also be no more
than five minutes old relative to the server clock and no more than 30 seconds
in the future. A current top-level `observed_at` cannot refresh cached check,
review, or thread evidence.

The server must not expose independent mutations such as
`record_checks_passed` and `record_codex_passed`. Separate mutations could
combine a check result from commit A, a review from commit B, and the current
pull request head from commit C.

Each mutation accepts `expected_revision`. Under the per-review lock, the
server compares it with the stored revision before writing. A mismatch fails
and requires the caller to read the ledger again.

After input and revision validation, a mutation that would advance the ledger
first revokes any existing publication gate as described above. This ordering
is part of the mutation contract, including when the new observation keeps the
same pull request head but adds a request, result, or unresolved thread.

## Derived states

`status` is cached for display but recomputed from the latest observation on
every mutation and finalization unless `terminal` is set.

| Status | Sticky | Meaning |
| --- | --- | --- |
| `PUBLICATION_STARTED` | No | The local gate and GitHub target are bound. |
| `PR_PENDING` | No | No pull request observation exists yet. |
| `EVIDENCE_INCOMPLETE` | No | A required evidence collection is absent, ambiguous, or incomplete. |
| `PR_DRAFT` | No | The pull request is still a draft. |
| `PR_STATE_PENDING` | No | GitHub has not finished computing mergeability. |
| `PR_CONFLICTING` | No | GitHub reports that the pull request conflicts. |
| `CHECKS_PENDING` | No | A latest required-check attempt is incomplete or stale. |
| `CHECKS_FAILED` | No | A latest required-check attempt has a blocking conclusion. |
| `GITHUB_REVIEW_NOT_REQUESTED` | No | No valid exact request exists for the head. |
| `GITHUB_REVIEW_PENDING` | No | The latest request has no corresponding result. |
| `GITHUB_REVIEW_UNKNOWN` | No | The result format, association, or verdict is ambiguous. |
| `CHANGES_REQUIRED` | No | Codex reported findings or any review thread is unresolved. |
| `MERGE_READY` | No | Every required invariant passes for the current head. |
| `INVALIDATED` | Yes | The pull request identity or head no longer matches the local gate. |
| `CLOSED` | Yes | The pull request closed without a recorded merge. |
| `MERGED` | Yes | A live observation confirms the merge and its commit SHA. |

When a sticky state is first derived, the server writes:

```json
{
  "status": "INVALIDATED",
  "at": "2026-07-25T08:06:00.000Z",
  "revision": 5,
  "reason": "pull request head differs from local gate"
}
```

to `terminal`. Later derivation short-circuits to `terminal.status`, and no
mutation may clear or replace it. Restoring a force-pushed branch to the
reviewed SHA does not revive the ledger. `INVALIDATED` and `CLOSED` require a
new local Review Bridge task; `MERGED` completes the lifecycle.

## State derivation

The evaluator applies these checks in order:

1. If `terminal` is set, return its status without inspecting later evidence.
2. The ledger references an existing `LOCAL_GATE_PASSED` gate.
3. If no observation exists, derive `PR_PENDING`.
4. The pull-request collection reports `COMPLETE` and has valid provenance.
   A well-formed `INCOMPLETE` or `UNKNOWN` collection derives
   `EVIDENCE_INCOMPLETE` without evaluating identity or writing a terminal
   state; malformed or stale collection metadata is rejected before derivation.
5. The repository identity, pull request number, base branch, head branch, and
   pull request head match the bound target and local gate. Any mismatch
   persists terminal `INVALIDATED`.
6. A merged pull request has `is_merged: true`, `state: "CLOSED"`, a valid
   `merged_at`, and a full `merge_commit_sha`. If so, persist terminal `MERGED`;
   the merge commit may differ from the reviewed head after squash merge.
7. A pull request with `state: "CLOSED"` and `is_merged: false` persists
   terminal `CLOSED`.
8. Every remaining evidence collection reports `COMPLETE`, is fresh, has
   complete pagination, and satisfies its internal counts and provenance rules.
9. An open pull request is no longer a draft.
10. The adapter normalizes GitHub's mergeability result to `MERGEABLE`,
   `CONFLICTING`, or `UNKNOWN`.
   `UNKNOWN` derives `PR_STATE_PENDING`; `CONFLICTING` derives
   `PR_CONFLICTING`; only `MERGEABLE` may continue.
11. Required-check policy discovery is complete. For `REQUIRED`, select the
    latest attempt per producer key and evaluate only it. Every requirement has
    a latest run bound to the pull request head, with the required app identity
    when pinned, and a passing conclusion. For `NONE_CONFIGURED`, the
    explicit-empty invariants hold.
12. Replay request/result association and every stored ambiguity
    acknowledgement for the current head. An unacknowledged ambiguous result
    preserves its indeterminate request set and derives
    `GITHUB_REVIEW_UNKNOWN`. A valid acknowledgement closes exactly its named
    observed epoch without correlating a result retroactively. Any
    later-discovered pre-boundary event absent from its closed-ID lists derives
    `GITHUB_REVIEW_UNKNOWN`. An `UNSOLICITED` result before the epoch's first
    exact request is retained for audit but does not block or correlate.
13. From the remaining requests, select the latest exact `@codex review`
    request by `(created_at, comment_id)`. If none exists, derive
    `GITHUB_REVIEW_NOT_REQUESTED`. Zero correlated results derives
    `GITHUB_REVIEW_PENDING`; an ambiguous result created after the latest
    request or more than one correlated result derives
    `GITHUB_REVIEW_UNKNOWN`. Timestamps widen ambiguity but never establish a
    request/result pairing.
14. The single correlated result names the current head SHA and its parser
    returns `CLEAN`; a stale SHA or unknown format fails closed.
15. Thread collection is complete, its counts are internally consistent, and
    `unresolved_count` is zero.

Only an observation that passes every check derives `MERGE_READY`.

Outdated but unresolved threads still block publication. A human must resolve
or dismiss them explicitly instead of relying on the ledger to infer that they
are harmless.

A later exact request always supersedes an earlier request for the same head,
but timestamp order alone never associates a result with that request. An
earlier `CLEAN` result cannot satisfy a later request. If a new exact request
arrives while an earlier request has no correlated result, the next result is
ambiguous rather than being assigned to the newest request. Duplicate and
overlapping requests are therefore represented and evaluated rather than
rejected or silently paired.

Ambiguity never clears automatically. Publication can recover on the same head
only after the operator explicitly acknowledges the exact indeterminate
request and result IDs, asserting that those old requests will produce no
further results and accepting the risk if that assertion is wrong. The next
exact request posted after `acknowledged_at` starts a new correlation epoch;
requests posted before acknowledgement are reported and closed by that
boundary.

## Author tools

The author role adds six tools.

### `start_publication`

Inputs:

- `review_id`
- `repository_id`
- `owner`
- `repo`
- `pr_number`
- `base_branch`
- `head_branch`

The tool requires `LOCAL_GATE_PASSED`, reloads `gate.json`, verifies the local
working tree is clean, and verifies local `HEAD` equals the gate `head_sha`.
It creates revision 1 in `PUBLICATION_STARTED`.

### `record_github_snapshot`

Inputs:

- `review_id`
- `expected_revision`
- one normalized GitHub observation with collection metadata for every evidence
  class

The tool validates sizes, enums, timestamps, SHA formats, URLs, unique
requirement keys, unique run and GitHub object IDs, binding-field provenance,
required-app identity, run ordering and status/conclusion pairs, evidence
provenance and collection metadata, thread counts, latest-run selection, exact
request bodies, request/result correlation, latest-request selection, merge
fields, and cross-field ordering. An incomplete but well-formed collection is
recorded and derives `EVIDENCE_INCOMPLETE`.

It applies the five-minute age and 30-second future limits to `observed_at` and
every collection's `collected_at`, rejects any timestamp earlier than the
publication `created_at`, and enforces the two-minute atomic observation
interval. The server sets `recorded_at` from its own clock, derives status, and
atomically records the next revision.

The first observation must be recorded after `start_publication`. The target is
immutable after creation; there is no target-rebinding operation.

If `publication-gate.json` exists, `record_github_snapshot` removes and
directory-syncs it under the publication lock before replacing the ledger.
This is required even when the new observation is for the same head and still
derives `MERGE_READY`.

### `get_publication`

Returns the ledger without accessing GitHub.

### `acknowledge_codex_review_ambiguity`

Inputs:

- `review_id`
- `expected_revision`
- `head_sha`
- the exact non-empty `request_comment_ids` and `ambiguous_result_ids` being
  acknowledged
- `acknowledgement: "NO_FURTHER_RESULTS_EXPECTED"`
- a non-empty `operator_label` and `rationale`

This is an explicit human risk decision, not a normal automated recovery step.
The skill must invoke it only after a human directly approves the named
acknowledgement; silence, a retry request, or a previous general instruction to
finish the workflow is not approval.

The shipped Codex workflow skill must carry that approval rule and the complete
six-tool ordering, including `verify_publication_gate` immediately before
merge. `scripts/verify-build.mjs` must assert both requirements in the packaged
skill, so losing either rule fails the build rather than silently changing the
workflow.

The normative sequence is: `start_publication`, use `get_publication` as needed,
record a complete snapshot, and, only if ambiguity blocks it, stop for direct
human approval before acknowledgement; then post a new exact request and
record a new snapshot. After `MERGE_READY`, finalize the gate and call
`verify_publication_gate` immediately before the head-matching merge.

Under the publication lock, the server reloads the current observation,
requires `head_sha` to match the local gate and pull request, independently
replays association, and requires set equality between the supplied IDs and
the current indeterminate request/result sets. The backing observation must
satisfy the same five-minute age limit, 30-second future tolerance,
post-publication ordering, and two-minute atomic-collection window used by
finalization. Otherwise the call fails with an instruction to record a fresh
snapshot first.

The acknowledgement closes the entire observed correlation epoch, including
any recovery request posted after the ambiguity but before acknowledgement.
The server records every request and result ID closed by the boundary, not just
the indeterminate IDs supplied by the caller. The server-generated record is:

```json
{
  "acknowledgement_id": "ack-...",
  "head_sha": "0123456789abcdef...",
  "request_comment_ids": [100, 102],
  "ambiguous_result_ids": [101],
  "closed_request_comment_ids": [100, 102, 104],
  "closed_result_ids": [101, 103],
  "acknowledgement": "NO_FURTHER_RESULTS_EXPECTED",
  "operator_label": "local maintainer",
  "rationale": "Old requests are no longer expected to answer.",
  "backing_observed_at": "2026-07-25T08:05:00.000Z",
  "backing_observation_sha256": "sha256...",
  "acknowledged_at": "2026-07-25T08:06:00.000Z",
  "publication_revision": 5
}
```

`operator_label` is a self-declared audit label, not authenticated identity.
The acknowledgement asserts that the named requests will produce no later
results; the server cannot prove that claim. It closes only the exact named
indeterminate set. It never changes a result to `CLEAN`, and any later
unacknowledged ambiguity requires a new human decision.

Like every later ledger mutation, the tool first revokes and directory-syncs
an existing publication gate, then appends the acknowledgement and history
event and advances the revision. After acknowledgement, no active request
exists until the operator posts a new exact `@codex review` comment after
`acknowledged_at`. A request already present in the backing observation is
reported in `closed_request_comment_ids` and cannot become active silently.
If a later snapshot discovers any pre-boundary request or result that was not
recorded in the closed-ID lists, derivation returns
`GITHUB_REVIEW_UNKNOWN` and requires a fresh human decision.

### `verify_publication_gate`

Inputs:

- `review_id`

Under the publication lock, the tool reads the canonical
`publication-gate.json` and `publication.json` together, rejects unsupported
formats, recomputes the current ledger status, and verifies that the gate's
`review_id`, `publication_revision`, `head_sha`, and status match a current
`MERGE_READY` ledger. It returns:

```json
{
  "valid": true,
  "status": "MERGE_READY",
  "head_sha": "0123456789abcdef...",
  "publication_revision": 4,
  "verified_at": "2026-07-25T08:05:02.000Z"
}
```

A missing, mismatched, revoked, or non-`MERGE_READY` gate returns
`valid: false` with a normalized reason and no merge-authorizing head SHA.
Callers never read the private store directly to make this decision.

### `finalize_publication_gate`

Inputs:

- `review_id`
- `expected_revision`

The tool requires the latest derived status to be `MERGE_READY`, rechecks the
local gate file and local repository head, and enforces all of these freshness
rules:

- server `recorded_at` is no more than five minutes old;
- caller `observed_at` is no more than five minutes old and no more than 30
  seconds in the future;
- every collection `collected_at` is no more than five minutes old, no more
  than 30 seconds in the future, and still satisfies the two-minute atomic
  observation interval;
- all caller and server timestamps are later than the publication `created_at`;
  and
- the revision being finalized is still the latest revision.

It then writes:

```json
{
  "version": 1,
  "review_id": "rb-...",
  "passed_at": "2026-07-25T08:05:01.000Z",
  "repository_id": 123456,
  "pr_number": 5,
  "head_sha": "0123456789abcdef...",
  "local_gate_sha256": "sha256...",
  "publication_revision": 4,
  "github_observation_sha256": "sha256...",
  "github_observed_at": "2026-07-25T08:05:00.000Z",
  "github_oldest_collection_at": "2026-07-25T08:05:00.000Z",
  "github_recorded_at": "2026-07-25T08:05:01.000Z",
  "status": "MERGE_READY"
}
```

Finalization does not modify `publication.json`: it does not change
`revision`, `updated_at`, status, or history. `publication-gate.json` is the
sole record of issuance and names the unchanged ledger revision that was
validated. This write is not a later ledger mutation and therefore does not
revoke itself.

Codex must perform a fresh GitHub read immediately before this call. It then
calls `verify_publication_gate` immediately before merging and passes the
returned `head_sha` to an operation that rejects a changed PR head, such as
`gh pr merge --match-head-commit <head_sha>`. The finalize response, a direct
file read, or an earlier verification result is not a reusable merge
credential.

The five-minute bound is an upper limit, not a target delay. A stale or
future-dated top-level observation or nested collection cannot produce
`publication-gate.json`, even if its cached status is `MERGE_READY`.

`github_oldest_collection_at` is the minimum across the pull-request,
required-check, Codex-review, and review-thread collection timestamps.

## Codex result adapter

GitHub Codex may report success in a pull request conversation comment rather
than a formal GitHub review. Parsing therefore belongs in a small,
versioned adapter in the Codex plugin, not in the generic ledger evaluator.

The adapter collects every page of conversation comments and formal reviews
and returns:

- all exact request comments, with GitHub object ID, URL, timestamp, and the
  head SHA recorded when the request was made;
- all candidate Codex results, with GitHub object ID, URL, author, timestamp,
  reviewed commit SHA, `request_comment_id`, and association method;
- `CLEAN`, `FINDINGS`, or `UNKNOWN` for each candidate result; and
- a SHA-256 digest of each original response body.

Any unrecognized response format returns `UNKNOWN`. A reaction without a
response is still pending. The adapter processes requests and results in
`(created_at, GitHub object ID)` order and maintains the unmatched exact
requests for each head. Version 1 accepts only these association values:

- a result created before any exact request in the current correlation epoch
  uses `association: "UNSOLICITED"` with a null `request_comment_id`; it is
  retained for audit but never opens, closes, or satisfies a request;
- a result uses `association: "SINGLE_OPEN_REQUEST"` only when exactly one
  unmatched prior exact request exists for that head, and records that
  request's comment ID;
- when multiple requests could own the result, the adapter returns
  `association: "AMBIGUOUS"` and a null `request_comment_id`; and
- after at least one request has existed in the epoch, a result with no open
  request is a possible duplicate result and is also `AMBIGUOUS`.

A correlated result closes its request. An ambiguous result marks every
currently unmatched request for that head indeterminate but does not close or
discard the set. Every later result for that head therefore remains ambiguous
until `acknowledge_codex_review_ambiguity` closes the exact indeterminate set.
The acknowledgement is a server-recorded correlation-epoch boundary, not a
result association. A request posted after it starts the next open set.

Response body text, mentions, permalinks, and all other free-form content never
supply request linkage. Version 1 has no `EXPLICIT_LINK`; adding a future
structural GitHub link requires a schema change that names and validates the
exact response field.

An automatic Codex result that predates the workflow's first exact request is
therefore harmless `UNSOLICITED` evidence. It cannot correlate to a later
request and does not force routine human acknowledgement in repositories with
automatic review enabled.

The evaluator independently replays this algorithm, validates each
association, and then selects the latest request; it never reconstructs a
pairing from "created after latest request" alone. The adapter must not discard
older, duplicate, or ambiguous events because doing so could let a delayed old
`CLEAN` result mask a pending newer review.

If an old request produces a delayed result after an acknowledgement and a new
request, the protocol cannot distinguish it from the new request's result. The
operator accepted that specific residual risk by asserting that the
acknowledged requests would produce no further results. The acknowledgement
record keeps that decision visible in the ledger instead of presenting the
association as mechanically proven.

Thread collection remains separate from result parsing, follows every GraphQL
page, and includes every thread's stable ID, resolution state, outdated state,
path, line, and latest-comment author.

## Locking and revisions

Before adding publication mutations, Review Bridge introduces one lock utility
with separate per-review lock domains:

```text
reviews/<review_id>/.review-state.lock
reviews/<review_id>/.publication-state.lock
```

Existing `review.json` and `gate.json` mutations use the review-state lock.
`publication.json` and `publication-gate.json` mutations use the publication
lock. Publication never starts before the local review becomes terminal, so
there is no need to serialize both domains behind one lock.

Atomic rename prevents corrupt JSON but does not prevent lost updates. Each
lock record therefore contains:

- a cryptographically random 128-bit owner token;
- owner PID and process start time;
- acquisition and heartbeat timestamps; and
- the lock domain and review ID.

The holder refreshes a heartbeat every five seconds and releases in a `finally`
block only after rereading the lock and matching its owner token. Acquisition
waits at most ten seconds. A contender may reclaim a lock only when its
heartbeat is older than 30 seconds and the operating-system probe confirms that
no process with both the recorded PID and process start time is alive. PID
liveness alone is insufficient because PIDs can be reused. An inconclusive
identity probe fails closed with an actionable error and never steals the lock.

An acquisition timeout returns a documented retryable `REVIEW_BUSY` or
`PUBLICATION_BUSY` error without changing state. Adding `REVIEW_BUSY` to
existing reviewer mutations is an intentional client-visible behavior change,
although it does not change tool inputs, successful outputs, or review-state
transitions.

Publication revision checks remain necessary even with a lock because callers
can operate from stale reads.

## Failure and recovery

- Missing or malformed evidence never advances the state.
- A GitHub read failure leaves the previous revision unchanged.
- An interrupted atomic write leaves the previous complete JSON file.
- A revision conflict requires a new `get_publication` call.
- Any accepted ledger mutation after finalization removes and directory-syncs
  `publication-gate.json` before replacing the ledger. Failure after removal
  requires finalization again; it cannot preserve a stale gate.
- A changed head records `INVALIDATED` and requires a new local review.
- A later observation cannot clear `INVALIDATED`, `CLOSED`, or `MERGED`.
- An incomplete pull-request collection derives `EVIDENCE_INCOMPLETE` before
  identity comparison and cannot write a sticky terminal state.
- An incomplete check, request, result, or thread collection derives
  `EVIDENCE_INCOMPLETE`; an empty list alone never proves absence.
- A stale or future-dated top-level observation or nested evidence collection
  cannot be finalized.
- A changed or deleted GitHub comment makes the next fresh observation pending
  or unknown; it does not retain a stale pass.
- Ambiguous Codex results remain `GITHUB_REVIEW_UNKNOWN` until an explicit
  acknowledgement names the exact indeterminate IDs. An acknowledgement
  revokes any gate and creates an auditable risk-acceptance boundary; it does
  not prove that old requests have stopped.
- A pre-request automatic result is `UNSOLICITED`, remains audit evidence, and
  cannot poison or satisfy a later exact request.
- Stale evidence cannot back an ambiguity acknowledgement; the operator must
  record a fresh snapshot first.
- A merged pull request may be recorded only when a live observation supplies
  its merge commit SHA. A squash merge commit is allowed to differ from the
  reviewed head.

## Drawbacks

- The ledger records normalized claims supplied by Codex; it cannot
  independently authenticate GitHub without expanding the credential boundary.
- GitHub response-format changes can move a previously understood Codex result
  to `GITHUB_REVIEW_UNKNOWN` until the adapter is updated.
- Per-review locking adds complexity to the otherwise simple atomic-file store.
- `verify_publication_gate` is a point-in-time local verdict. The local lock
  cannot span GitHub's merge execution: `--match-head-commit` closes a head
  change, but a same-head request or thread mutation can still land after
  verification and before merge. Closing that residual window requires
  repository-side enforcement such as the deferred GitHub Check Run.
- GitHub does not structurally correlate a Codex result with its request.
  Explicitly acknowledging ambiguity restores progress but accepts the risk
  that an old delayed result may later be attributed to the new request. The
  ledger records that human decision; it cannot eliminate the uncertainty.
- A new commit intentionally requires a new local review rather than resuming
  the existing publication ledger.

## Alternatives considered

### Extend `review.json`

Rejected because local model review and GitHub publication have different
actors, evidence, and lifecycles. Combining them would expand the reviewer
protocol and make local review records harder to evolve.

### Store independent check and review facts

Rejected because facts observed at different times can belong to different
pull request heads. One complete snapshot makes cross-SHA validation atomic.

### Let the MCP server call GitHub directly

Rejected because it would give the server GitHub credentials and contradict
the current capability boundary. The Codex plugin already has the appropriate
GitHub integration.

### Keep the workflow only in the skill

Rejected because prose correctly guides an agent but does not persist evidence
or prevent steps from being skipped across sessions.

### Use a GitHub Check Run as the first implementation

Deferred. A Check Run would provide stronger repository-side enforcement but
requires a GitHub App, credential management, and a larger deployment model.
The local ledger is the smallest improvement that preserves the existing
architecture.

## Resolved design decisions

- Required-check keys, including any GitHub App binding, are the union of active
  applicable rules and classic branch protection. Ambiguous access, discovery,
  or producer identity results fail closed.
- App bindings are explicitly `PINNED` or `EXPLICITLY_UNBOUND` and must cite an
  identity-capable response field; legacy context-only policy reads are
  incomplete evidence.
- Only the latest check attempt can satisfy a requirement. `SUCCESS`,
  `SKIPPED`, and `NEUTRAL` pass to match GitHub; blocking, stale, pending, and
  unknown outcomes fail closed as specified above.
- Pull-request identity and head evidence participates in the same collection
  freshness and atomic-observation window as checks, reviews, and threads.
- Every unresolved review thread blocks publication, regardless of author.
- Codex result evidence stores a digest and GitHub URL, not the response body.
- Every Codex result is correlated by the single-open-request rule; overlapping
  requests are ambiguous, and free-form text never supplies linkage.
- Ambiguity remains blocking until a human acknowledges the exact indeterminate
  IDs and asserts that no old request will reply. The acknowledgement is
  revisioned, revokes any gate, and starts a new correlation epoch.
- Automatic results before the epoch's first exact request are `UNSOLICITED`
  and never trigger the acknowledgement path.
- The packaged workflow skill carries the six-tool ordering and direct-human
  approval rule, and build verification asserts both properties.
- A publication gate is valid only for the current ledger revision. Every
  later ledger mutation revokes it before writing, including same-head changes.
- Lock acquisition waits ten seconds; a lock is only eligible for reclamation
  after a 30-second heartbeat timeout and a conclusive owner-identity check.
- A closed, unmerged pull request terminates the ledger and requires a new local
  review before publication can restart.

## Test plan

The implementation must test:

- the successful path from local gate to `MERGE_READY`;
- a pull request head changed before and after Codex review;
- an incomplete policy query, ambiguous `404`, explicit no-check policy, empty
  incomplete collections, incomplete pagination, and count mismatches;
- required checks from a different head or with pending, failed, cancelled, or
  missing results;
- a required check produced by the wrong GitHub App, an explicitly unbound
  requirement, a missing app identity, and a legacy `contexts[]` policy read;
- a failed rerun after success, a successful rerun after failure, a pending
  rerun after success, and runs with missing or ambiguous ordering;
- `SKIPPED`, `NEUTRAL`, `TIMED_OUT`, `ACTION_REQUIRED`, `STALE`, and an
  unrecognized future check conclusion;
- a missing request, a non-exact request, duplicate requests, and a newer
  request that supersedes an older `CLEAN` result;
- overlapping requests where the older delayed result arrives after the newer
  request and derives `GITHUB_REVIEW_UNKNOWN`, plus a body-only request
  permalink that remains ambiguous;
- an automatic pre-request result recorded as `UNSOLICITED`, followed by a
  normal explicit request and result reaching `MERGE_READY` without
  acknowledgement, with the unsolicited result never correlating later;
- a recovery request posted before acknowledgement, with every subsequent
  result remaining ambiguous and the early recovery request reported as
  closed; exact-set acknowledgement followed by a post-acknowledgement request;
  a delayed old result after acknowledgement as an explicitly accepted risk;
  and a later ambiguity requiring another acknowledgement;
- zero and multiple candidate results after the latest request;
- a reaction without a Codex result;
- a result created before its request;
- a missing, malformed, unknown, or stale reviewed commit;
- findings and unresolved, resolved, and outdated threads;
- a pull request retargeted to another base branch;
- a force-push after `MERGE_READY`, including restoring the original head
  without clearing terminal `INVALIDATED`;
- closing and reopening a pull request without clearing terminal `CLOSED`;
- `UNKNOWN`, `CONFLICTING`, and `MERGEABLE` mergeability, plus validation of
  merged state, timestamp, and merge commit SHA;
- stale, future-dated, pre-publication, and stale-at-finalization observations,
  including a fresh `observed_at` with stale nested collections and collections
  spanning more than two minutes, plus fresh nested collections paired with a
  stale pull-request read;
- concurrent mutations, stale expected revisions, and independent review and
  publication lock domains;
- a same-head request or unresolved thread recorded after finalization, gate
  revocation before the new ledger revision, a crash after revocation, and
  rejection of a cached or revision-mismatched gate;
- a freshly finalized gate that validates against its unchanged ledger
  revision, plus a same-head mutation landing after verification but before
  merge to document the residual point-in-time limitation;
- ambiguity acknowledgement with wrong head, stale revision, missing or extra
  request/result IDs, missing rationale, or the wrong acknowledgement enum,
  plus a stale or future-dated backing observation, gate revocation, closed-ID
  reporting, the backing observation timestamp/hash, and the revisioned audit
  record on success;
- packaged-skill assertions for the complete six-tool ordering, direct-human
  ambiguity approval, and immediate pre-merge gate verification;
- lock timeout errors, PID reuse, heartbeat expiry, owner-token mismatch, and
  inconclusive owner-liveness checks;
- malformed and oversized inputs;
- failure to finalize from every state except `MERGE_READY`; and
- recording a squash merge whose merge commit differs from the reviewed head.

The existing end-to-end packaged-client test should add one publication flow,
while GitHub API behavior remains covered by adapter fixtures rather than live
network calls.

## Rollout plan

Implement this design in two changes:

1. add the lock utility and review-state lock, document retryable
   `REVIEW_BUSY`, and verify existing successful tool inputs, outputs, and
   state transitions remain unchanged; and
2. add publication storage, state derivation, author tools, the Codex adapter,
   publication-state lock, and packaged-client verification; update the
   packaged Codex workflow skill with the six-tool ordering, immediate
   pre-merge gate verification, and direct-human ambiguity approval rule; and
   make `scripts/verify-build.mjs` assert those skill requirements.

Each implementation change requires its own local Claude review and GitHub
Codex review.

## References

- [GitHub REST API: Get rules for a branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)
- [GitHub REST API: Get a branch](https://docs.github.com/en/rest/branches/branches#get-a-branch)
- [GitHub REST API: Get branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)
- [GitHub REST API: Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST API: Check runs](https://docs.github.com/en/rest/checks/runs)
- [GitHub Docs: Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
