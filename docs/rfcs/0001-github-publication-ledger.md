# RFC 0001: GitHub Publication Ledger

| Field | Value |
| --- | --- |
| Status | Accepted |
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
revision, that revision still derives `MERGE_READY`, and the server clock has
not passed the `expires_at` recomputed from the stored observation timestamps.

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
    "head_branch": "agent/change",
    "codex_actor": {
      "id": 987654,
      "type": "Bot",
      "login_at_start": "chatgpt-codex-connector[bot]"
    }
  },
  "terminal": null,
  "codex_review_baseline": {
    "observed_at": "2026-07-25T07:59:58.000Z",
    "recorded_at": "2026-07-25T08:00:00.000Z",
    "collection": {
      "status": "COMPLETE",
      "collected_at": "2026-07-25T07:59:58.000Z",
      "source": "PULL_REQUEST_CONVERSATION_REVIEWS_AND_REVIEW_COMMENTS",
      "pagination_complete": true
    },
    "excluded_request_pairs": [
      {
        "request": {
          "resource_id": 90,
          "resource_kind": "ISSUE_COMMENT",
          "url": "https://github.com/...",
          "event_at": "2026-07-25T07:50:00.000Z",
          "timestamp_field": "created_at",
          "body_sha256": "sha256..."
        },
        "result": {
          "result_id": 91,
          "resource_kind": "PULL_REQUEST_REVIEW",
          "url": "https://github.com/...",
          "event_at": "2026-07-25T07:51:00.000Z",
          "timestamp_field": "submitted_at",
          "actor": {
            "id": 987654,
            "type": "Bot"
          },
          "reviewed_head_sha": "fedcba9876543210...",
          "commit_binding": {
            "source": "PULL_REQUEST_REVIEW_COMMIT_ID",
            "field": "commit_id"
          },
          "association": "SINGLE_OPEN_REQUEST",
          "body_sha256": "sha256..."
        }
      }
    ]
  },
  "codex_review_ambiguity_acknowledgements": [],
  "codex_request_history": [
    {
      "resource_id": 100,
      "resource_kind": "ISSUE_COMMENT",
      "classification": "RECOGNIZED",
      "binding_source": "RECORDED_AT_POST",
      "url": "https://github.com/...",
      "event_at": "2026-07-25T08:03:00.000Z",
      "recorded_at": "2026-07-25T08:03:01.000Z",
      "recorded_revision": 2,
      "body_sha256": "sha256...",
      "requested_head_sha": "0123456789abcdef..."
    }
  ],
  "codex_result_history": [
    {
      "result_id": 101,
      "resource_kind": "PULL_REQUEST_REVIEW",
      "url": "https://github.com/...",
      "event_at": "2026-07-25T08:04:00.000Z",
      "timestamp_field": "submitted_at",
      "actor": {
        "id": 987654,
        "type": "Bot"
      },
      "reviewed_head_sha": "0123456789abcdef...",
      "commit_binding": {
        "source": "PULL_REQUEST_REVIEW_COMMIT_ID",
        "field": "commit_id"
      },
      "body_sha256": "sha256...",
      "recorded_at": "2026-07-25T08:05:01.000Z"
    }
  ],
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
      "base_sha": "abcdef0123456789...",
      "mergeable": "MERGEABLE",
      "base_head_comparison": {
        "status": "AHEAD",
        "source": "REST_COMPARE_BASE_TO_HEAD",
        "base_sha": "abcdef0123456789...",
        "head_sha": "0123456789abcdef..."
      },
      "reviewed_base_current_base_comparison": {
        "status": "IDENTICAL",
        "source": "REST_COMPARE_REVIEWED_BASE_TO_CURRENT_BASE",
        "base_sha": "abcdef0123456789...",
        "head_sha": "abcdef0123456789..."
      }
    },
    "required_checks": {
      "collection": {
        "status": "COMPLETE",
        "collected_at": "2026-07-25T08:05:00.000Z",
        "run_sources": [
          {
            "resource_kind": "CHECK_RUN",
            "endpoint": "GET /repos/{owner}/{repo}/commits/{ref}/check-runs?filter=all",
            "status": "COMPLETE",
            "collected_at": "2026-07-25T08:04:58.000Z",
            "pagination_complete": true,
            "page_count": 1,
            "item_count": 1,
            "reported_total_count": 1
          },
          {
            "resource_kind": "COMMIT_STATUS",
            "endpoint": "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
            "status": "COMPLETE",
            "collected_at": "2026-07-25T08:04:59.000Z",
            "pagination_complete": true,
            "page_count": 1,
            "item_count": 0,
            "reported_total_count": null
          }
        ],
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
      "strict_policy": {
        "required": true,
        "sources": [
          {
            "kind": "CLASSIC_BRANCH_PROTECTION",
            "field": "required_status_checks.strict",
            "value": true
          }
        ]
      },
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
          "resource_kind": "CHECK_RUN",
          "context": "test",
          "app_id": 12345,
          "app_id_source": "CHECK_RUN_APP_ID",
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
        "source": "PULL_REQUEST_CONVERSATION_REVIEWS_AND_REVIEW_COMMENTS",
        "pagination_complete": true
      },
      "requests": [
        {
          "comment_id": 100,
          "resource_kind": "ISSUE_COMMENT",
          "url": "https://github.com/...",
          "event_at": "2026-07-25T08:03:00.000Z",
          "timestamp_field": "created_at",
          "body": "@codex review",
          "requested_head_sha": "0123456789abcdef..."
        }
      ],
      "unbound_requests": [],
      "unsupported_requests": [],
      "foreign_actor_objects": [],
      "results": [
        {
          "result_id": 101,
          "resource_kind": "PULL_REQUEST_REVIEW",
          "url": "https://github.com/...",
          "event_at": "2026-07-25T08:04:00.000Z",
          "timestamp_field": "submitted_at",
          "actor": {
            "id": 987654,
            "type": "Bot",
            "login": "chatgpt-codex-connector[bot]"
          },
          "request_comment_id": 100,
          "association": "SINGLE_OPEN_REQUEST",
          "reviewed_head_sha": "0123456789abcdef...",
          "commit_binding": {
            "source": "PULL_REQUEST_REVIEW_COMMIT_ID",
            "field": "commit_id"
          },
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

`resource_kind` is exactly one of `ISSUE_COMMENT`, `PULL_REQUEST_REVIEW`, or
`PULL_REQUEST_REVIEW_COMMENT`. Each value names a separate GitHub object-ID
namespace; an unrecognized value is rejected rather than treated as a new
namespace. Recognized review requests are always `ISSUE_COMMENT` objects, so
their native API field remains `comment_id`.

`event_at` is the normalized ordering timestamp. Its `timestamp_field` must be
`created_at` for issue comments and review comments, and `submitted_at` for
formal pull request reviews. The adapter records both so the evaluator can
reject a timestamp attributed to the wrong GitHub field.

An exact request in a review comment is recorded, but unsupported:

```json
{
  "unsupported_requests": [
    {
      "resource_id": 200,
      "resource_kind": "PULL_REQUEST_REVIEW_COMMENT",
      "url": "https://github.com/...",
      "event_at": "2026-07-25T08:03:30.000Z",
      "timestamp_field": "created_at",
      "body_sha256": "sha256..."
    }
  ]
}
```

Empty arrays never imply that collection succeeded. Each evidence class carries
`collection.status`, its source, collection time, and pagination completeness
where applicable. Any missing field, failed query, ambiguous permission error,
or incomplete page sequence makes the whole observation incomplete.

`codex_review_baseline` is an immutable publication-start cutoff captured from
a fresh, complete, fully paginated collection immediately before
`start_publication`. It uses stable `(resource_kind, resource_id)` identities,
not a comparison between GitHub and server timestamps. The baseline adapter
replays all preexisting exact requests and actor-admitted results with the same
single-open-request rules. It excludes a request from active history and review
satisfaction only when one unambiguous preexisting result already settled it;
the server stores that exact request/result pair under
`excluded_request_pairs`. The stored request remains a source-only candidate
for later actor-admitted results bound to the same reviewed head. It cannot
satisfy the new ledger, become the latest active request, or block by itself,
but until an ambiguity acknowledgement names and closes it, it must widen
association when a later result could also answer an active request.

Only a recognized exact issue-comment request can enter an excluded settled
pair. Any preexisting exact request that is unmatched, overlapping, unbound,
or in an unsupported resource kind is not silently cut off. `start_publication`
seeds it into `codex_request_history` at revision 1 with the corresponding
`UNBOUND` or `UNSUPPORTED` classification and
`binding_source: "OBSERVED_BASELINE"`. It therefore blocks under the normal
direct-human acknowledgement rule before a new request can satisfy the gate.
A request object first appearing after the complete baseline is likewise never
grandfathered: it must have a `RECORDED_AT_POST` binding or enter history as
unbound or unsupported.

`codex_request_history` is server-maintained and monotonic. A workflow-managed
issue-comment request enters history through `record_codex_review_request`,
immediately after the comment-post response, with
`binding_source: "RECORDED_AT_POST"`. The mutation binds the returned comment
ID and creation time to the already verified pull request head; a later
snapshot never infers `requested_head_sha` from the then-current pull request.
A complete Codex-review collection reconciles those recognized entries and
appends newly observed exact issue-comment requests lacking a post-time binding
as `UNBOUND` with `binding_source: "OBSERVED_UNBOUND"`, plus unsupported
requests with `binding_source: "OBSERVED_UNSUPPORTED"`.

Each history entry records `resource_id`, `resource_kind`, `classification`
(`RECOGNIZED`, `UNBOUND`, or `UNSUPPORTED`), binding source, URL, `event_at`,
server `recorded_at`, server `recorded_revision`, `body_sha256`, and nullable
`requested_head_sha`; the SHA is required for recognized requests and null for
unbound or unsupported requests. `recorded_revision` is the ledger revision
whose mutation first admitted the request and is the authoritative ordering
signal across acknowledgement boundaries. On every later complete collection,
every historical request must still appear in the union of `requests`,
`unbound_requests`, and `unsupported_requests` with the same immutable facts. A
missing request, changed body, reclassification, reused
`(resource_kind, resource_id)`, or conflicting provenance persists terminal
`INVALIDATED`; restoring or recreating the object cannot revive that
publication ledger.

`codex_result_history` is also server-maintained and monotonic. A complete
Codex-review collection reconciles every actor-admitted candidate in `results`
against prior history and appends newly observed results. Each entry records
`result_id`, `resource_kind`, URL, `event_at`, `timestamp_field`, stable actor
ID and type, reviewed-head and commit-binding provenance, body digest, and
server `recorded_at`; adapter-derived verdict and request
association are deliberately excluded because the evaluator replays them from
the immutable baseline, complete histories, and current complete collection.
On every later complete collection, every historical result must still appear
in `results`
with the same immutable GitHub facts. A missing result, changed body, reused
`(resource_kind, result_id)`, changed actor, or conflicting commit binding
persists terminal `INVALIDATED`. A verdict difference under the same body
digest is a changed adapter interpretation, not a changed GitHub fact; the
evaluator uses the current complete collection's verdict without truncating
history. Incomplete collections neither compare nor advance result history,
and result disappearance receives no post-to-list grace.

There is one bounded visibility exception for a post-time binding that is not
yet present in a separate listing response. If a `RECORDED_AT_POST` history
entry is absent and the Codex-review collection's `collected_at` is no more
than 30 seconds after the entry's server `recorded_at`, the snapshot derives
`EVIDENCE_INCOMPLETE` without advancing history or writing a terminal state and
instructs the caller to retry. Once that window expires, continued absence is
a missing request and persists `INVALIDATED`. Changed bodies,
reclassifications, and provenance conflicts receive no grace. Other incomplete
collections neither compare nor advance the history.

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

Run discovery independently collects every page from:

- `GET /repos/{owner}/{repo}/commits/{head}/check-runs?filter=all`; and
- `GET /repos/{owner}/{repo}/commits/{head}/statuses`.

The check-run request must use `filter=all`; GitHub's default latest-only view
cannot prove complete attempt ordering. Each resource kind has a separate
`run_sources` entry with its endpoint, status, collection time, pagination
flag, page count, item count, and endpoint-provided total count when available.
`COMPLETE` requires
`pagination_complete: true`, a positive `page_count`, and `item_count` equal to
the number of normalized runs of that kind. Both entries are mandatory even
when their item count is zero. The check-run entry also records GitHub's
non-negative `total_count` as `reported_total_count` and requires it to equal
`item_count`; the commit-status entry uses null because that endpoint exposes
no total count. An absent, failed, unknown, or partially paginated source makes
required-check evidence incomplete; completeness of one kind never substitutes
for the other.

The required-check keys are the union of both successful policy reads. Each
requirement records:

- `app_binding`: `PINNED` or `EXPLICITLY_UNBOUND`;
- `required_app_id`, which is a positive integer exactly when the binding is
  `PINNED` and null exactly when it is `EXPLICITLY_UNBOUND`; and
- every identity-capable response field that supplied the binding.

The adapter normalizes a ruleset `integration_id` and a classic
branch-protection `checks[].app_id` into `required_app_id`. `PINNED` requires a
check run with the same `context` and exact producing GitHub App ID.
`EXPLICITLY_UNBOUND` means GitHub returned an explicit null from an
identity-capable field and permits a matching check run or commit status from
any producer.

Reading the legacy classic `contexts[]` field, omitting
`rules[].parameters.required_status_checks[].integration_id`, or otherwise
using a response shape that cannot expose app identity is `UNKNOWN`, never
`SUCCESS` or `EXPLICITLY_UNBOUND`. Each policy source and requirement records
the exact binding field used, so the server can enforce this distinction.

Each check run records its positive `app.id` as `app_id` and
`app_id_source: "CHECK_RUN_APP_ID"`. Check runs are the only version 1
resource kind that can prove a producing GitHub App ID; a missing or malformed
`app.id` is incomplete evidence. Each commit status records `app_id: null` and
`app_id_source: "COMMIT_STATUS_UNAVAILABLE"` because GitHub's commit-status
response exposes `creator`, not the producing App's numeric ID. The adapter
must not infer an App ID from the creator login, user ID, target URL, token
used to read the status, or any external mapping.

An authorization error or ambiguous `404` is `UNKNOWN`, not evidence that no
checks are configured. Successful branch-metadata or applicable-rules reads do
not prove access to classic protection because that endpoint has a separate
Administration permission. A classic-protection `404` may be classified as
`NOT_CONFIGURED` only when the connector also supplies this endpoint-specific
authorization proof:

```json
{
  "status": "ESTABLISHED",
  "source": "GITHUB_APP_INSTALLATION_PERMISSIONS",
  "field": "permissions.administration",
  "level": "READ"
}
```

Version 1 accepts only an authenticated GitHub App installation-permission map
whose `administration` grant is `read` or `write`; the server normalizes those
values to `READ` or `WRITE`. A missing permission map, another credential
class, an inferred repository role, or successful lower-privilege calls leave
the `404` as `UNKNOWN`.

`policy: "NONE_CONFIGURED"` is permitted only when complete policy discovery
produces an explicit empty result: the applicable-rules response contains no
required status-check rule, and classic protection is either present with no
required checks or conclusively `NOT_CONFIGURED`. It must accompany
`strict_policy.required: false`, `requirements: []`, and `runs: []`; otherwise
the observation is invalid. A caller that cannot establish the policy or a
required app binding derives `EVIDENCE_INCOMPLETE`.

`strict_policy.required` is the logical OR of every successful applicable
source's strict-update flag. The adapter records
`required_status_checks.strict` from classic protection and
`strict_required_status_checks_policy` from each applicable required-status-
checks ruleset rule, including false values and exact field provenance. A
missing strict field on a source that defines required checks is `UNKNOWN`, not
false. When strict mode is required, the pull-request collection also records
the current base SHA and a complete compare response for `base...head`.
The comparison's base and head SHAs must exactly match the pull-request
collection.
`AHEAD` or `IDENTICAL` proves that the head contains the current base;
`BEHIND` or `DIVERGED` derives `PR_UPDATE_REQUIRED`, and an unknown or
incomplete comparison derives `EVIDENCE_INCOMPLETE`. Updating the branch
changes the reviewed head and therefore requires a new local review.

Independently of strict-update policy, every pull-request collection records a
complete compare response for `local_gate.base_sha...pull_request.base_sha`.
The comparison's base SHA must exactly match the local gate and its head SHA
must exactly match the current pull-request base. `AHEAD` or `IDENTICAL` proves
that the current target base preserves the locally reviewed base ancestry.
`BEHIND` or `DIVERGED` persists terminal `INVALIDATED`; an unknown or
incomplete comparison derives `EVIDENCE_INCOMPLETE`. This ancestry check is
always required, including when no status checks are configured or strict
updates are disabled.

Multiple runs may share one requirement key. Every run records `started_at` and
`completed_at`; the latter is null until completion. `resource_kind` is exactly
`CHECK_RUN` or `COMMIT_STATUS`, and each kind has its own numeric ID namespace.
The evaluator partitions matching attempts by `resource_kind` before selecting
latest runs. For a `PINNED` requirement, a matching `CHECK_RUN` kind is
mandatory and selects the latest attempt for the exact
`(context, required_app_id, CHECK_RUN)` producer key. A commit status can never
satisfy that producer-identity predicate. If any commit status reports the same
context, however, `COMMIT_STATUS` also participates and selects its latest
attempt by context without an App binding; it must pass independently. For an
`EXPLICITLY_UNBOUND` requirement, each present kind selects the latest attempt
across producer keys with that context inside the kind, and at least one
matching kind must be present. Selection uses `(started_at, run_id)`, so
`run_id` breaks a timestamp tie only within its own ID namespace. If both a
check run and a commit status report the required context, both independently
selected latest attempts must pass; neither can supersede or hide the other.
Their timestamps and numeric IDs are never compared across kinds. A missing
ordering field, duplicate within-kind ordering key, invalid
`app_id`/`app_id_source` pairing, or unrecognized kind is incomplete evidence.
Older attempts within a kind remain in the ledger for audit but never satisfy
a requirement or override that kind's latest attempt. A pinned requirement
with no matching check run from the required App derives `CHECKS_PENDING`,
even if a same-context commit status passed.

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

- pull request identity, current head and base SHAs, and reviewed-base ancestry;
- draft, open, mergeability, and base-branch state;
- required-check policy provenance, separate complete run feeds, and every run
  for the head;
- every exact `@codex review` request object, partitioned against the immutable
  publication-start baseline;
- every candidate Codex result needed to partition the immutable baseline and
  replay the active epoch with unclosed source-only baseline requests;
- the complete paginated review-thread collection and resolution counts; and
- the observation timestamp.

`observed_at` is captured immediately after the final GitHub response. Every
nested evidence collection has its own `collected_at`, and the server requires:

```text
publication.created_at <= collected_at <= observed_at
observed_at - collected_at <= 2 minutes
max(collected_at) - min(collected_at) <= 2 minutes
```

Each `required_checks.collection.run_sources[].collected_at` participates in
these freshness and atomic-window calculations independently; the parent
required-check timestamp cannot refresh a stale run feed.

At both recording and finalization, every `collected_at` must also be no more
than five minutes old relative to the server clock and no more than 30 seconds
in the future. A current top-level `observed_at` cannot refresh cached check,
review, or thread evidence.

The separate start baseline is collected immediately before
`start_publication`, so its collection and observation timestamps may precede
`publication.created_at`; they must still satisfy the same freshness,
future-tolerance, and two-minute atomic-collection bounds when revision 1 is
created. GitHub object `event_at` values may predate either collection. They
never establish the publication-start cutoff.

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
every mutation and finalization unless `terminal` is set. State derivation is
pure: it returns a status and, when applicable, a proposed terminal record but
never changes the ledger, request or result history, gate, or filesystem. Only
`record_codex_review_request` and `record_github_snapshot` advance request
history after `start_publication` seeds any unsettled baseline requests at
revision 1; only `record_github_snapshot` advances result history or persists
a newly proposed terminal state. `record_codex_review_request` first clears
replaceable observation evidence, so its pure no-observation derivation is
`PR_PENDING` rather than a comparison between new history and a pre-post
snapshot.

| Status | Sticky | Meaning |
| --- | --- | --- |
| `PR_PENDING` | No | No current pull request observation is stored. |
| `EVIDENCE_INCOMPLETE` | No | A required evidence collection is absent, ambiguous, or incomplete. |
| `PR_DRAFT` | No | The pull request is still a draft. |
| `PR_STATE_PENDING` | No | GitHub has not finished computing mergeability. |
| `PR_CONFLICTING` | No | GitHub reports that the pull request conflicts. |
| `PR_UPDATE_REQUIRED` | No | Strict status-check policy requires the head to contain the current base. |
| `CHECKS_PENDING` | No | A latest required-check attempt is incomplete or stale. |
| `CHECKS_FAILED` | No | A latest required-check attempt has a blocking conclusion. |
| `GITHUB_REVIEW_NOT_REQUESTED` | No | No valid exact request exists for the head. |
| `GITHUB_REVIEW_PENDING` | No | The latest request has no corresponding result. |
| `GITHUB_REVIEW_UNKNOWN` | No | A request is unbound, or the result format, association, or verdict is ambiguous. |
| `CHANGES_REQUIRED` | No | Codex reported findings or any review thread is unresolved. |
| `MERGE_READY` | No | Every required invariant passes for the current head. |
| `INVALIDATED` | Yes | The pull request identity/head no longer matches the local gate, the current base no longer preserves the reviewed base ancestry, or an observed request or Codex result disappeared or changed. |
| `CLOSED` | Yes | The pull request closed without a recorded merge. |
| `MERGED` | Yes | A live observation confirms the merge and its commit SHA. |

When `record_github_snapshot` first receives a sticky derivation, it writes:

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
   pull request head match the bound target and local gate. The complete
   `reviewed_base_current_base_comparison` must compare the local gate's
   `base_sha` with the current pull-request `base_sha`; `AHEAD` or `IDENTICAL`
   may continue, while `BEHIND` or `DIVERGED` persists terminal `INVALIDATED`.
   Unknown or incomplete comparison evidence derives `EVIDENCE_INCOMPLETE`.
   Any other identity mismatch persists terminal `INVALIDATED`.
6. A merged pull request has `is_merged: true`, `state: "CLOSED"`, a valid
   `merged_at`, and a full `merge_commit_sha`. If so, persist terminal `MERGED`;
   the merge commit may differ from the reviewed head after squash merge.
7. A pull request with `state: "CLOSED"` and `is_merged: false` persists
   terminal `CLOSED`.
8. Every remaining evidence collection reports `COMPLETE`, is fresh, has
   complete pagination, and satisfies its internal counts and provenance rules.
   Partition the immutable baseline's excluded request/result pairs before
   requiring the complete current recognized/unbound/unsupported request union
   to match the already-reconciled `codex_request_history` and the complete
   current actor-admitted non-baseline result set to match
   `codex_result_history`. A disappearance, change, or missing history entry
   returns a proposed terminal `INVALIDATED` without mutating either structure,
   except that a just-recorded request absent within the bounded post-to-list
   visibility grace derives `EVIDENCE_INCOMPLETE`.
9. An open pull request is no longer a draft.
10. The adapter normalizes GitHub's mergeability result to `MERGEABLE`,
   `CONFLICTING`, or `UNKNOWN`.
   `UNKNOWN` derives `PR_STATE_PENDING`; `CONFLICTING` derives
   `PR_CONFLICTING`; only `MERGEABLE` may continue.
11. Required-check policy discovery is complete, both run sources report
    complete pagination, and their per-kind item counts exactly match `runs`.
    For `REQUIRED`, partition matching runs by
    `resource_kind`, select the latest attempt independently inside every
    present kind, and require every selected attempt to pass. A check run and
    commit status with the same required context both participate; neither
    supersedes the other. If any source requires strict updates, require
    `base_head_comparison` to prove the head contains the current base; `BEHIND`
    or `DIVERGED` derives `PR_UPDATE_REQUIRED`. Every pinned requirement has a
    latest check run bound to the pull request head and exact required App ID;
    a commit status cannot establish that identity, but any same-context commit
    status kind must independently pass. Every explicitly unbound requirement
    has at least one latest run bound to the head, and every participating kind
    has a passing conclusion. For `NONE_CONFIGURED`, the explicit-empty
    invariants hold, including `strict_policy.required: false`.
12. Replay event identity and association from `codex_request_history`,
    `codex_result_history`, the current collection's validated parsed verdicts,
    and every stored ambiguity acknowledgement for the current head rather than
    trusting only the latest observation's identities. A request from an
    immutable settled baseline pair never enters active history or satisfies
    this ledger, but while unclosed it remains a source-only candidate for any
    later actor-admitted result whose reviewed head matches that pair's stored
    result head. A result that could answer both such a baseline source and an
    active request is ambiguous. A result arriving before any active request
    and uniquely attributable to a baseline source is retained as
    `BASELINE_LATE_RESULT` audit evidence and cannot satisfy or block the new
    ledger. Only an acknowledgement that names the source-only baseline request
    closes it for later epochs.
    `foreign_actor_objects` never participates. An unacknowledged ambiguous
    result preserves its indeterminate request set and derives
    `GITHUB_REVIEW_UNKNOWN`. An unbound exact issue-comment request also derives
    `GITHUB_REVIEW_UNKNOWN`, can never satisfy review, and remains in the
    correlation epoch until a valid acknowledgement closes it. A valid
    acknowledgement closes exactly its named observed epoch without
    correlating a result retroactively. Requests admitted in revisions at or
    before that acknowledgement are pre-boundary; a request admitted by a
    later revision belongs to the next epoch even if its GitHub timestamp is
    equal to or earlier than `acknowledged_at`. The boundary is validated from
    the closed references captured by the acknowledgement, not reconstructed
    from wall-clock timestamps. A result before the epoch's first exact request
    and with no eligible baseline source is retained as `UNSOLICITED` audit
    evidence; a unique eligible baseline source instead produces
    `BASELINE_LATE_RESULT`. Neither can satisfy or block.
13. Any unacknowledged exact `@codex review` text in a pull request review or
    review comment after publication starts is an unsupported request location,
    derives `GITHUB_REVIEW_UNKNOWN`, and remains blocking until a valid
    acknowledgement closes its resource-scoped reference; it is never silently
    discarded. Exclude `closed_requests` and `foreign_actor_objects`. From the
    remaining recognized `ISSUE_COMMENT` requests, select the latest by
    `(event_at, comment_id)`. This tie-break is within one resource kind and ID
    namespace. If none exists, derive `GITHUB_REVIEW_NOT_REQUESTED`. Zero
    correlated results derives `GITHUB_REVIEW_PENDING`; an ambiguous result
    created after the latest request or more than one correlated result derives
    `GITHUB_REVIEW_UNKNOWN`. Timestamps widen ambiguity but never establish a
    request/result pairing.
14. The single correlated result's actor ID and `Bot` type match the immutable
    expected Codex actor. It is a formal pull request review whose
    `PULL_REQUEST_REVIEW_COMMIT_ID` binding names the current head SHA, and its
    parser returns `CLEAN`. A result from another actor or resource kind, a
    missing binding, a SHA copied from the pull request at collection time, a
    stale SHA, or an unknown format fails closed.
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
resource-scoped request references, including any unbound or unsupported
requests and any source-only settled baseline requests that could own the
result, and resource-scoped result references, asserting that those old
requests will produce no further results and accepting the risk if that
assertion is wrong. The next workflow-managed
exact request admitted by `record_codex_review_request` in a revision after the
acknowledgement's `publication_revision` starts a new correlation epoch;
requests already admitted when acknowledgement runs are reported and closed by
that boundary. GitHub `created_at` and server `acknowledged_at` remain audit
timestamps and are never compared to choose an epoch.

## Author tools

The author role adds seven tools.

### `start_publication`

Inputs:

- `review_id`
- `repository_id`
- `owner`
- `repo`
- `pr_number`
- `base_branch`
- `head_branch`
- the positive numeric `codex_actor_id` resolved by the GitHub connector for
  the configured Codex bot, plus `codex_actor_login` for audit display
- one fresh, complete, fully paginated normalized baseline of preexisting exact
  requests and actor-admitted candidate results from conversation comments,
  formal reviews, and review comments

The tool requires `LOCAL_GATE_PASSED`, reloads `gate.json`, verifies the local
working tree is clean, and verifies local `HEAD` equals the gate `head_sha`.
It validates the baseline's identity, completeness, pagination, freshness, and
event provenance, then replays its requests and results with the expected actor
and the normal association algorithm. Unambiguously settled request/result
pairs become the immutable `codex_review_baseline`; their recognized request
components remain source-only candidates for later results on the same
reviewed head. Any unsettled preexisting request is seeded into
`codex_request_history` with `recorded_revision: 1` and
`binding_source: "OBSERVED_BASELINE"`. The tool stores the actor ID with fixed
`type: "Bot"` and creates revision 1 with status `PR_PENDING`, the pure
evaluator's no-observation result. The audit history records a
`PUBLICATION_STARTED` event, but that event name is not a second status. The
target, expected actor, and baseline are immutable after creation.

### `record_codex_review_request`

Inputs:

- `review_id`
- `expected_revision`
- the GitHub response's positive numeric `comment_id`, canonical `url`, and
  `created_at`
- `requested_head_sha`, captured from a fresh pull request read immediately
  before posting the exact `@codex review` comment

The tool requires the requested head to equal the immutable local-gate head and
local `HEAD`, requires a clean working tree, validates that the comment response
is fresh, and appends a `RECORDED_AT_POST` recognized request to
`codex_request_history`. The server supplies the exact-body digest and
`recorded_at` and assigns `recorded_revision` to the new ledger revision;
callers cannot choose them. A duplicate comment ID, conflicting binding, stale
response, or changed local head fails without writing.

In the same atomic ledger replacement, the tool sets `latest_observation` to
null before state derivation, preserves the immutable baseline and both
monotonic histories, and therefore caches `PR_PENDING`. A pre-post observation
cannot be reconciled against the newly appended request or materialize a
terminal state. The history event records the cleared observation's digest when
one existed; the next `record_github_snapshot` call supplies replacement
evidence and performs normal reconciliation. Only a replacement request
listing collected after the post can use the 30-second visibility grace.

Under the publication lock, this revision-advancing tool follows the universal
revoke-before-write rule: if `publication-gate.json` exists, it removes and
directory-syncs the gate before replacing the ledger. Failure to remove or
sync the gate aborts the mutation.

This local mutation cannot be atomic with GitHub comment creation. The packaged
workflow therefore performs a fresh head check, posts exactly one request, and
calls this tool immediately with the post response before any other workflow
step. If the process crashes in that interval, a later snapshot records the
comment as `UNBOUND` and derives `GITHUB_REVIEW_UNKNOWN`; it never infers the
request head from the current pull request. Recovery requires direct human
approval to close that unbound request in the complete acknowledgement set,
followed by a new workflow-managed request.

Exact `@codex review` conversation comments must therefore be posted only by
the packaged workflow. A human who wants a re-review asks the workflow to post
and bind it rather than commenting directly. A manually posted exact request
is retained as unbound audit evidence and blocks publication until the human
explicitly acknowledges that it will produce no further result. Editing or
deleting it is not recovery: once observed, the monotonic-history rules make
that change terminally invalidating.

### `record_github_snapshot`

Inputs:

- `review_id`
- `expected_revision`
- one normalized GitHub observation with collection metadata for every evidence
  class

The tool validates sizes, enums, timestamps, SHA formats, URLs, unique
requirement keys, run IDs unique within each run resource kind, GitHub object
IDs unique within each review resource kind, binding-field and timestamp-field
provenance, per-kind run-source endpoint and pagination proof, run-source item
counts, required-app identity, strict-policy provenance and base/head
comparison, run ordering and status/conclusion pairs, evidence provenance and
collection metadata, thread counts, latest-run selection, exact request
bodies, resource-kind-scoped event ordering, recognized requests being issue
comments, complete reporting of unbound issue-comment requests and exact
request text in unsupported resource kinds, result actor admission,
foreign-actor partitioning, and commit-binding provenance,
endpoint-specific authorization proof for a classic-protection
`NOT_CONFIGURED`, request/result correlation, monotonic recognized and
unbound/unsupported request history, monotonic actor-admitted result history,
latest-request selection, merge fields, and cross-field ordering. An incomplete
but well-formed collection is recorded and derives `EVIDENCE_INCOMPLETE`.

It applies the five-minute age and 30-second future limits to `observed_at` and
every collection's `collected_at`, rejects an observation or collection
timestamp earlier than the publication `created_at`, and enforces the
two-minute atomic observation interval. GitHub object `event_at` values may be
older and are partitioned by stable baseline identity rather than wall-clock
comparison. The server sets `recorded_at` from its own clock, derives status,
and atomically records the next revision.

For a complete Codex-review collection, the server compares and advances
`codex_request_history` against the non-baseline union of `requests`,
`unbound_requests`, and `unsupported_requests`, and compares and advances
`codex_result_history` against non-baseline `results`, in the same locked
mutation before calling the pure state evaluator. The adapter reports baseline
pairs separately; the server requires exact identity membership in the
immutable baseline and rejects any attempt to place a baseline object in an
active array or a non-baseline object in the excluded partition. Exclusion from
the active arrays does not remove a settled baseline request from source
association: every unclosed baseline request whose stored result head matches
the candidate result head participates as a source-only candidate. Every
recognized request must already have a
`RECORDED_AT_POST` entry. An exact issue comment without one is reported under
`unbound_requests`, appended with `OBSERVED_UNBOUND`, and blocks without
receiving an inferred head. If prior entries all match, the tool appends newly
observed unbound and unsupported requests and newly observed actor-admitted
results, assigning new request entries the revision written by this mutation,
then derives status by replaying both histories.

When a just-recorded recognized entry is absent from the collection within the
30-second post-to-list visibility grace, the tool records the observation in
the next revision without advancing request history and derives retryable
`EVIDENCE_INCOMPLETE`; absence after the grace is a history conflict and writes
terminal `INVALIDATED`. Other history conflicts have no grace. Caller input
cannot replace or truncate history. After revision 1 has seeded unsettled
baseline requests, only `record_codex_review_request` and
`record_github_snapshot` advance request history; only the latter advances
result history or materializes a newly derived terminal record.

The first observation must be recorded after `start_publication`. The target
and expected Codex actor are immutable after creation; there is no rebinding
operation.

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
- the exact non-empty `request_refs` that the boundary will close; each
  reference names `resource_kind` and `resource_id` and the set includes every
  indeterminate, unbound, unsupported, still-open recovery, and source-only
  settled baseline request participating in the ambiguity
- the exact `ambiguous_results`; each result names both `resource_kind` and
  `result_id`. `ambiguous_results` may be empty when an unbound or unsupported
  request alone is blocking
- `acknowledgement: "NO_FURTHER_RESULTS_EXPECTED"`
- a non-empty `operator_label` and `rationale`

Each request reference accepts only `ISSUE_COMMENT`,
`PULL_REQUEST_REVIEW`, or `PULL_REQUEST_REVIEW_COMMENT`; `resource_id` is
interpreted only inside that namespace. Duplicate tuples are rejected, while
equal numeric IDs in different resource kinds remain distinct.

This is an explicit human risk decision, not a normal automated recovery step.
The skill must invoke it only after a human directly approves the named
acknowledgement and the complete resource-scoped request closure set; silence,
approval of only the indeterminate subset, a retry request, or a previous
general instruction to finish the workflow is not approval.

The shipped Codex workflow skill must carry that approval rule and the complete
seven-tool ordering, including `record_codex_review_request` immediately after
every exact request post and `verify_publication_gate` immediately before
merge. It must collect the complete preexisting Codex baseline immediately
before `start_publication`, tell operators never to post exact request comments
by hand, and recover an observed unbound or unsupported request only through
the direct-human acknowledgement path. When a settled baseline request is a
source candidate for an ambiguous result, the skill must include its exact
resource-scoped reference in the closure set presented for approval.
`scripts/verify-build.mjs` must assert these requirements in the packaged
skill, so losing one fails the build rather than silently changing the
workflow.

The normative sequence is: collect a fresh, complete, fully paginated
preexisting Codex request/result baseline; call `start_publication` with it;
refresh and verify the head; post one exact request and immediately call
`record_codex_review_request`; use `get_publication` as needed; then record a
complete snapshot. Only if ambiguity or an unbound or unsupported request
blocks it, stop for direct human approval of the full resource-scoped closure
set before acknowledgement; then refresh the head, post a new exact request,
immediately record its binding, and record a new snapshot. After `MERGE_READY`,
finalize the gate and call `verify_publication_gate` immediately before the
head-matching merge.

Under the publication lock, the server reloads the current observation,
requires `head_sha` to match the local gate and pull request, independently
replays association, and requires set equality between the supplied references
and the entire request set the boundary would close and the current
indeterminate result set, comparing requests by
`(resource_kind, resource_id)` and results by `(resource_kind, result_id)`. The
request set includes every indeterminate recognized, unbound, unsupported,
recovery, and source-only settled baseline request in the current open epoch.
The backing observation must satisfy the same five-minute age limit, 30-second
future tolerance, post-publication ordering, and two-minute atomic-collection
window used by finalization. Otherwise the call fails with an instruction to
record a fresh snapshot first.

The acknowledgement closes the entire observed correlation epoch. Every
indeterminate recognized, unbound, unsupported, recovery, and source-only
settled baseline request in that epoch must be present in the directly approved
`request_refs`. The server copies that exact set to `closed_requests`; the
boundary cannot close an unapproved request.
It likewise copies the exact supplied `ambiguous_results` set to
`closed_results`; the boundary cannot close an unapproved result.
The server-generated record is:

```json
{
  "acknowledgement_id": "ack-...",
  "head_sha": "0123456789abcdef...",
  "request_refs": [
    {
      "resource_kind": "ISSUE_COMMENT",
      "resource_id": 100
    },
    {
      "resource_kind": "PULL_REQUEST_REVIEW_COMMENT",
      "resource_id": 104
    }
  ],
  "ambiguous_results": [
    {
      "resource_kind": "PULL_REQUEST_REVIEW",
      "result_id": 101
    }
  ],
  "closed_requests": [
    {
      "resource_kind": "ISSUE_COMMENT",
      "resource_id": 100
    },
    {
      "resource_kind": "PULL_REQUEST_REVIEW_COMMENT",
      "resource_id": 104
    }
  ],
  "closed_results": [
    {
      "resource_kind": "PULL_REQUEST_REVIEW",
      "result_id": 101
    }
  ],
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
results; the server cannot prove that claim. It closes only the exact directly
approved request set and named indeterminate results. It never changes a result
to `CLEAN`, and any later unacknowledged ambiguity requires a new human
decision.

Like every later ledger mutation, the tool first revokes and directory-syncs
an existing publication gate, then appends the acknowledgement and history
event and advances the revision. After acknowledgement, no active request
exists until `record_codex_review_request` admits a new exact
`@codex review` comment in a revision greater than the acknowledgement's
`publication_revision`. A request already admitted or present in the backing
observation is reported in `closed_requests` and cannot become active silently.
GitHub `created_at` is not compared with `acknowledged_at`;
this avoids using independent clocks to decide ledger order. A request first
admitted by a later snapshot has a later `recorded_revision` and belongs to the
new epoch; if it is unbound or unsupported, it blocks under the normal rules
and is never added retroactively to the prior closed set. A result first
observed later is evaluated in the then-open epoch under the delayed-result
risk the operator accepted.

### `verify_publication_gate`

Inputs:

- `review_id`

Under the publication lock, the tool reads the canonical
`publication-gate.json` and `publication.json` together, rejects unsupported
formats, recomputes the current ledger status, and verifies that the gate's
`review_id`, `publication_revision`, `head_sha`, and status match a current
`MERGE_READY` ledger. It recomputes `expires_at` from the stored observation
timestamps, requires it to match the gate, and requires the server clock to be
no later than that instant. This reapplies every five-minute freshness bound at
verification time rather than treating successful finalization as timeless.
It returns:

```json
{
  "valid": true,
  "status": "MERGE_READY",
  "head_sha": "0123456789abcdef...",
  "publication_revision": 4,
  "expires_at": "2026-07-25T08:10:00.000Z",
  "verified_at": "2026-07-25T08:05:02.000Z"
}
```

A missing, mismatched, revoked, expired, or non-`MERGE_READY` gate returns
`valid: false` with a normalized reason and no merge-authorizing head SHA. An
expired gate uses reason `EVIDENCE_STALE`; the caller must record fresh GitHub
evidence and finalize a new gate. Callers never read the private store directly
to make this decision.
Verification invokes the pure evaluator against the already-reconciled stored
ledger. It never advances request or result history, writes a terminal record,
changes a revision, or otherwise modifies `publication.json`; the file remains
byte-identical on both valid and invalid returns.

### `finalize_publication_gate`

Inputs:

- `review_id`
- `expected_revision`

The tool requires the latest purely derived status to be `MERGE_READY`,
rechecks the local gate file and local repository head, and enforces all of
these freshness rules:

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
  "expires_at": "2026-07-25T08:10:00.000Z",
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
required-check, each required-check run-source, Codex-review, and review-thread
collection timestamps.
`expires_at` is exactly five minutes after the minimum of
`github_recorded_at`, `github_observed_at`, and every collection
`collected_at`. Finalization and verification both recompute it from
`publication.json`; caller input cannot choose or extend it.

## Codex result adapter

Version 1 requires the GitHub Codex integration to produce a formal pull
request review. Conversation comments and review comments cannot satisfy the
publication gate because neither carries its own GitHub-native reviewed-commit
binding. The adapter still collects them as `UNKNOWN` evidence instead of
silently ignoring them. Parsing belongs in a small, versioned adapter in the
Codex plugin, not in the generic ledger evaluator.

The adapter collects every page of conversation comments, formal reviews, and
review comments and returns:

- every immutable publication-baseline request/result pair still present under
  `preexisting_pairs`; these objects are matched only by their stored
  `(resource_kind, resource_id)` identities and never enter the active arrays,
  while each recognized request component remains a source-only association
  candidate for later results on its stored reviewed head;
- every exact `@codex review` issue comment whose object ID already has a
  `RECORDED_AT_POST` history entry as a recognized request, with GitHub object
  ID, URL, timestamp, the `ISSUE_COMMENT` resource kind, and the head SHA from
  that entry;
- every other exact issue-comment request under `unbound_requests`, with no
  head SHA and `reason: "MISSING_POST_BINDING"`; the adapter never adopts it
  using the pull request head observed later;
- every exact `@codex review` body found in a formal review or review comment
  under `unsupported_requests`, so unsupported re-review intent blocks rather
  than disappearing from evaluation;
- all candidate Codex results, with GitHub object ID, resource kind, URL,
  stable actor ID and type, audit login, timestamp, reviewed commit SHA,
  GitHub-native commit-binding source and field, `request_comment_id`, and
  association method;
- response-shaped objects from any other actor under `foreign_actor_objects`
  for audit only;
- `CLEAN`, `FINDINGS`, or `UNKNOWN` for each candidate result; and
- a SHA-256 digest of each original response body.

An object absent from the immutable baseline cannot be reported under
`preexisting_pairs`, even when its GitHub timestamp predates publication
creation. A baseline object that is edited or deleted remains outside the new
epoch; the stored baseline pair is audit evidence from the prior publication
cycle, not monotonic evidence for this one, but its stored request identity
remains source-only until directly acknowledged. This prevents previous,
already settled requests on the same pull request from being reclassified as
unbound on every new local task without allowing a delayed duplicate result to
masquerade as the response to a new request. Unsettled baseline requests were
seeded into active history at revision 1 and are therefore never returned as
preexisting pairs.

Each `unbound_requests` and `unsupported_requests` entry carries `resource_id`,
`resource_kind`, URL, `event_at`, `timestamp_field`, and `body_sha256`.
Unbound entries additionally carry the fixed reason above. An unbound request
participates only as an indeterminate request that widens or preserves
ambiguity; it can never satisfy review. An unsupported request is not
correlated with a result. Either blocks after publication starts, and neither
is converted into a recognized request.

Any unrecognized response format returns `UNKNOWN`. A reaction without a
response is still pending.

`start_publication` binds the expected Codex actor by its numeric GitHub actor
ID and requires `type: "Bot"`; the login captured at start is audit metadata,
not the trust key. Every candidate result records the source object's
`user.id`, `user.type`, and `user.login`. Actor admission occurs before body
parsing and before request/result association. Only an exact actor-ID match
with `type: "Bot"` enters `results`; `record_github_snapshot` rejects any
`results` entry that fails that invariant. A response-shaped object with a
matching login but different ID, missing ID/type, or human `User` type is
stored in `foreign_actor_objects`. That audit-only array is never parsed,
associated, or allowed to open, close, satisfy, or make ambiguous any request.
Each audit entry records its resource identity, URL, timestamp provenance,
actor fields, and body digest.

A formal pull request review binds to its reviewed commit through the review
object's GitHub-native `commit_id`. The only accepted source/field pair is
`PULL_REQUEST_REVIEW_COMMIT_ID`/`commit_id`. Conversation issue comments and
review comments have no accepted reviewed-commit field in version 1. Comment
body text, a SHA mentioned by Codex, a linked review, or the pull request head
observed when the comment is fetched is never a commit binding. Such a result
therefore has null `reviewed_head_sha` and `commit_binding` and returns
`UNKNOWN`.

After actor admission, the adapter processes recognized requests, unbound
requests, source-only settled baseline requests, and candidate results by
`event_at`. It maintains the unmatched recognized requests for each head, the
unbound indeterminate requests for the publication epoch, and every unclosed
source-only baseline request whose stored result is bound to that head. The
presence of an unbound or source-only request prevents a result from
establishing a unique active association until a human acknowledgement closes
it. GitHub object IDs break timestamp ties only when both events have the same
`resource_kind` and therefore share an ID namespace. An equal-timestamp tie
across issue comments, pull request reviews, or review comments has no total
order; if it can affect request/result association, the result is `AMBIGUOUS`
and derivation returns
`GITHUB_REVIEW_UNKNOWN` unless a future structural ordering signal exists.
The accepted resource-kind values are the three enums defined in the schema;
the adapter rejects any other value.
Version 1 accepts only these association values:

- a result created before any exact request in the current correlation epoch
  and with no eligible source-only baseline request uses
  `association: "UNSOLICITED"` with a null `request_comment_id`; it is retained
  for audit but never opens, closes, or satisfies a request;
- a result that can answer exactly one source-only baseline request and no
  active request uses `association: "BASELINE_LATE_RESULT"` and records that
  recognized issue-comment request's `comment_id`; it is audit evidence that
  does not close the baseline source or satisfy the new ledger;
- a result uses `association: "SINGLE_OPEN_REQUEST"` only when exactly one
  unmatched prior recognized request exists for that head and no unbound
  request or source-only baseline request exists in the open epoch, and records
  that request's comment ID;
- when multiple recognized requests or any unbound or source-only baseline
  request could own the result, the adapter returns
  `association: "AMBIGUOUS"` and a null `request_comment_id`; and
- after at least one request has existed in the epoch, a result with no open
  request is a possible duplicate result and is also `AMBIGUOUS`.

A correlated result closes its request. An ambiguous result marks every
currently unmatched recognized request for that head and every open unbound
or source-only baseline request in the epoch indeterminate, but does not close
or discard the set. A `BASELINE_LATE_RESULT` does not close its source-only
request because GitHub provides no signal that another delayed or duplicate
result cannot follow.
Every later result for that head therefore remains ambiguous until
`acknowledge_codex_review_ambiguity` closes the exact indeterminate set. The
acknowledgement is a server-recorded correlation-epoch boundary, not a result
association. A request whose server-assigned `recorded_revision` is greater
than the acknowledgement's `publication_revision` starts the next open set;
GitHub and server wall-clock timestamps do not establish that ordering.

Response body text, mentions, permalinks, and all other free-form content never
supply request linkage. Version 1 has no `EXPLICIT_LINK`; adding a future
structural GitHub link requires a schema change that names and validates the
exact response field.

An automatic Codex result that predates the workflow's first exact request and
has no eligible baseline source is therefore harmless `UNSOLICITED` evidence.
A result uniquely attributable to one source-only baseline request is harmless
`BASELINE_LATE_RESULT` evidence. Neither can correlate to a later request or
force routine human acknowledgement in repositories with automatic review
enabled.

The evaluator independently replays this algorithm, validates each
association from the reconciled request and result histories, and then selects
the latest request; it never reconstructs a pairing from "created after latest
request" alone. The adapter must return the complete current result collection,
and the server rejects disappearance or mutation of an already recorded
result's immutable GitHub facts instead of letting a later snapshot forget it.
The current adapter may reparse an unchanged body digest to a different verdict
without changing result history; derivation uses that current interpretation.
Older, duplicate, or ambiguous events cannot be discarded because doing so
could let a delayed old `CLEAN` result mask a pending newer review.

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
- Recording a workflow-managed request clears the pre-post
  `latest_observation`, preserves baseline and monotonic histories, and derives
  `PR_PENDING`; the next complete snapshot replaces the observation. It never
  evaluates the newly appended request against stale evidence.
- Any accepted ledger mutation after finalization removes and directory-syncs
  `publication-gate.json` before replacing the ledger. Failure after removal
  requires finalization again; it cannot preserve a stale gate.
- A changed head records `INVALIDATED` and requires a new local review.
- A current target base that is behind or diverged from the local gate's
  reviewed base records `INVALIDATED`, even when strict updates are disabled or
  no status checks are configured. Restoring the target base later does not
  revive that ledger.
- A later observation cannot clear `INVALIDATED`, `CLOSED`, or `MERGED`.
- An incomplete or stale publication-start Codex baseline prevents revision 1
  from being created. Settled preexisting request/result pairs remain outside
  active history and cannot satisfy the new ledger, but their recognized
  request components remain source-only candidates for later same-head
  results; every unsettled preexisting request is seeded into active history
  and blocks until normal acknowledgement recovery.
- An incomplete pull-request collection derives `EVIDENCE_INCOMPLETE` before
  identity comparison and cannot write a sticky terminal state.
- An incomplete check, request, result, or thread collection derives
  `EVIDENCE_INCOMPLETE`; an empty list alone never proves absence.
- Missing or partial pagination for either the check-run or commit-status feed,
  including an item-count or check-run reported-total mismatch, derives
  `EVIDENCE_INCOMPLETE` before latest-attempt selection. A complete feed of one
  kind cannot cover the other.
- A stale or future-dated top-level observation or nested evidence collection
  cannot be finalized.
- A finalized gate expires at the earliest underlying five-minute evidence
  deadline. `verify_publication_gate` returns `EVIDENCE_STALE` after that
  instant even when the ledger revision and head are unchanged.
- A previously observed exact request that is changed or deleted persists
  terminal `INVALIDATED`; an older `CLEAN` can never become latest again.
- A previously observed actor-admitted Codex result that disappears or changes
  its body or provenance persists terminal `INVALIDATED`. Deleting an ambiguous
  comment or review cannot erase it from correlation history or restore an
  older `CLEAN`. Re-parsing an unchanged body to another verdict changes the
  current interpretation, not the immutable history.
- A manually posted exact issue-comment request has no
  `RECORDED_AT_POST` head binding. It is recorded as `UNBOUND`, never receives
  an inferred head, and derives `GITHUB_REVIEW_UNKNOWN` until a direct human
  acknowledgement closes it. Operators must not edit or delete it after
  observation.
- A just-recorded request missing from a complete listing within the 30-second
  visibility grace derives retryable `EVIDENCE_INCOMPLETE`; continued absence
  after the grace persists terminal `INVALIDATED`.
- Ambiguous Codex results and unbound or unsupported requests remain
  `GITHUB_REVIEW_UNKNOWN` until an explicit acknowledgement names the exact
  resource-scoped request and result references. An acknowledgement revokes
  any gate and creates an auditable risk-acceptance boundary; it does not prove
  that old requests have stopped.
- A pre-request automatic result with no eligible baseline source is
  `UNSOLICITED`; one uniquely attributable to a source-only baseline request
  is `BASELINE_LATE_RESULT`. Both remain audit evidence and cannot poison or
  satisfy a later exact request.
- A comment-only result without a GitHub-native reviewed-commit binding is
  `UNKNOWN`; copying the pull request head or parsing body text is forbidden.
- A response-shaped object whose stable actor ID/type does not match the
  expected Codex bot is audit-only and never enters association. An observation
  that places it in `results` is rejected.
- An exact request in a pull request review or review comment is recorded as an
  unsupported request and derives `GITHUB_REVIEW_UNKNOWN`; it is never dropped
  while an older recognized request remains eligible. Recovery requires direct
  human approval of its `(resource_kind, resource_id)` reference.
- Equal timestamps across different GitHub resource kinds never use object IDs
  as a cross-namespace tie-breaker and derive `GITHUB_REVIEW_UNKNOWN` when
  ordering affects association.
- A classic-protection `404` without GitHub App installation evidence of
  `administration: read` or `write` is `UNKNOWN`; lower-privilege reads never
  upgrade it to `NOT_CONFIGURED`.
- A check run and commit status with the same required context are evaluated
  independently. A pass in one kind never hides a pending or failing latest
  attempt in the other, regardless of timestamps.
- Commit-status responses never supply or prove a producing GitHub App ID.
  `creator` is audit metadata, not an App mapping. A pinned requirement needs a
  matching check run from the required App; a same-context commit status still
  participates independently but cannot satisfy the pinned producer predicate.
- When any policy source requires strict updates, a head that does not contain
  the current base derives `PR_UPDATE_REQUIRED`.
- Ambiguity acknowledgement fails unless direct human approval and tool input
  cover every resource-scoped request the correlation-epoch boundary would
  close, including unbound and unsupported requests.
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
- Version 1 cannot satisfy an App-pinned required check using only a legacy
  commit status because GitHub's status response does not expose the producing
  App ID. Such repositories must emit a check run from the pinned App or remain
  `CHECKS_PENDING`.
- Version 1 cannot publish through a Codex integration that emits only
  conversation comments or review comments. An adopter must verify that the
  connector produces formal pull request reviews before enabling publication.
- Per-review locking adds complexity to the otherwise simple atomic-file store.
- `verify_publication_gate` is a point-in-time local verdict. The local lock
  cannot span GitHub's merge execution: `--match-head-commit` closes a head
  change, but a same-head request or thread mutation can still land after
  verification and before merge. The gate expires with its oldest evidence,
  which bounds reuse but does not close this residual window; doing that
  requires repository-side enforcement such as the deferred GitHub Check Run.
- GitHub does not structurally correlate a Codex result with its request.
  Explicitly acknowledging ambiguity restores progress but accepts the risk
  that an old delayed result may later be attributed to the new request. The
  ledger records that human decision; it cannot eliminate the uncertainty.
- Starting a new ledger on an existing pull request requires a complete
  preexisting Codex baseline. Only unambiguously settled pairs are excluded
  from active history; their requests remain source-only candidates, so a later
  same-head result that overlaps a new request can still require explicit
  acknowledgement. Unsettled requests carry forward directly. This trades an
  extra full pagination pass and occasional acknowledgement for avoiding both
  silent cutoff and misattribution of delayed duplicate results.
- Exact `@codex review` conversation comments must be posted through the
  packaged workflow so they can be bound to the verified head. A manual exact
  comment is fail-closed as `UNBOUND` and requires explicit human
  acknowledgement before recovery; editing or deleting it after observation
  invalidates the monotonic ledger.
- The post response and paginated comment listing can briefly disagree. The
  30-second visibility grace trades a short retry delay for avoiding terminal
  invalidation during normal write-to-list propagation; persistent absence
  still invalidates.
- Actor-admitted Codex results are monotonic audit evidence. Editing or deleting
  one after observation terminally invalidates that ledger rather than allowing
  correlation to forget a prior ambiguity. An adapter upgrade may reinterpret
  the same pinned body digest without invalidating the ledger.
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
- A classic-protection `404` is `NOT_CONFIGURED` only with endpoint-specific
  GitHub App installation permission evidence; successful branch or rules
  reads are not authorization proof.
- App bindings are explicitly `PINNED` or `EXPLICITLY_UNBOUND` and must cite an
  identity-capable response field; legacy context-only policy reads are
  incomplete evidence.
- Only `CHECK_RUN.app.id` proves run producer identity in version 1. Commit
  statuses record unavailable App identity, are never enriched from `creator`,
  and cannot satisfy a pinned producer predicate.
- Only the latest attempt within each present resource kind can satisfy that
  kind's side of a requirement. `SUCCESS`, `SKIPPED`, and `NEUTRAL` pass to
  match GitHub; blocking, stale, pending, and unknown outcomes fail closed as
  specified above.
- Check runs and commit statuses are separate ID namespaces and independently
  required when both report the same required context. Cross-kind timestamps
  and IDs are never compared.
- Check-run and commit-status feeds carry separate endpoint, collection-time,
  pagination, page-count, and item-count proof. Both must be complete before
  latest-attempt selection, including when one feed is empty.
- Strict-update policy is the union of every applicable policy source. A strict
  head must contain the current base or derive `PR_UPDATE_REQUIRED`.
- The current target base must independently descend from or equal the local
  gate's reviewed base. This identity invariant applies regardless of
  strict-update policy; a behind or diverged target base is terminal
  `INVALIDATED`.
- Pull-request identity, head, and reviewed-base ancestry evidence participates
  in the same collection freshness and atomic-observation window as checks,
  reviews, and threads.
- Every unresolved review thread blocks publication, regardless of author.
- Codex result evidence stores a digest and GitHub URL, not the response body.
- The expected Codex bot is bound by stable numeric actor ID and `Bot` type at
  publication start; login text is audit metadata only. Foreign-actor objects
  are separated before parsing or association.
- Every Codex result is correlated by the single-open-request rule; overlapping
  requests are ambiguous, and free-form text never supplies linkage.
- Ambiguity involving source-only baseline requests, and any unbound or
  unsupported request, remains blocking until a human acknowledges the exact
  resource-scoped results and requests the boundary will close, and asserts
  that none will reply. The acknowledgement is revisioned, revokes any gate,
  and starts a new correlation epoch.
- Automatic results before the epoch's first exact request are `UNSOLICITED`
  only when no baseline source is eligible; a unique baseline source produces
  `BASELINE_LATE_RESULT`. Neither triggers the acknowledgement path alone.
- Only a formal pull request review's GitHub-native `commit_id` can establish
  `reviewed_head_sha`; conversation comments and review comments are `UNKNOWN`.
- Recognized requests are workflow-managed exact `@codex review` issue
  comments with a durable post-time binding. An exact issue comment without
  that binding is `UNBOUND`; the same exact text in another resource kind is
  unsupported. Both block publication rather than being silently discarded.
- Recognized, unbound, and unsupported exact requests are accumulated in one
  server-owned monotonic history. Any previously observed request that
  disappears, changes, or is reclassified terminally invalidates the
  publication ledger.
- Actor-admitted Codex results are accumulated in a separate server-owned
  monotonic history. The evaluator replays association from both histories; a
  result that disappears or changes immutable body or provenance facts
  terminally invalidates the ledger instead of clearing ambiguity. A verdict
  reparse under an unchanged body digest is evaluated currently and does not
  rewrite or invalidate history.
- Every recognized request is durably bound to the verified head immediately
  after its GitHub post response. Snapshot collection never infers that head;
  unbound or unsupported requests can only be closed through directly approved
  resource-scoped ambiguity acknowledgement.
- Object IDs order equal-time events only within one resource kind. A
  cross-resource timestamp tie that affects association is ambiguous.
- The packaged workflow skill carries the seven-tool ordering, immediate
  request-binding mutation, no-manual-request guidance, and complete
  direct-human approval rule; build verification asserts all four properties.
- A publication gate is valid only for the current ledger revision. Every
  later ledger mutation revokes it before writing, including same-head changes.
- Recording a new workflow-managed request atomically clears the replaceable
  pre-post observation and derives `PR_PENDING`, while retaining the baseline
  and both monotonic histories for the next snapshot's reconciliation.
- A publication gate also expires at the earliest five-minute deadline among
  its stored observation timestamps; verification reapplies that deadline
  against the server clock and never treats finalization as timeless.
- Lock acquisition waits ten seconds; a lock is only eligible for reclamation
  after a 30-second heartbeat timeout and a conclusive owner-identity check.
- A closed, unmerged pull request terminates the ledger and requires a new local
  review before publication can restart.
- Revision 1 has status `PR_PENDING`, the evaluator's single no-observation
  result; `PUBLICATION_STARTED` is only its audit event name.
- A fresh, complete publication-start baseline excludes only unambiguously
  settled preexisting request/result pairs from active history and
  satisfaction. Their recognized request components remain source-only
  candidates for delayed same-head results until directly acknowledged.
  Unsettled preexisting requests enter revision-1 request history and remain
  fail-closed.
- Correlation epochs are ordered by server-assigned request
  `recorded_revision` relative to the acknowledgement's
  `publication_revision`, never by comparing GitHub `created_at` with the
  server clock.

## Test plan

The implementation must test:

- the successful path from local gate to `MERGE_READY`;
- `start_publication` creating revision 1 with status `PR_PENDING` and a
  `PUBLICATION_STARTED` audit event, including rejection of stale, incomplete,
  or partially paginated baselines;
- a new local task on an existing pull request whose prior exact requests have
  unambiguous results, proving those stored baseline pairs stay outside active
  history and satisfaction while their request components remain source-only,
  plus an unmatched, overlapping, unbound, or unsupported preexisting request
  seeded at revision 1 and blocking normally;
- a delayed or duplicate same-head result from a settled baseline request
  arriving before any new request and becoming non-blocking
  `BASELINE_LATE_RESULT`, then another arriving after a new request and
  becoming ambiguous; acknowledgement must name the exact baseline source,
  active request, and result before a recovery request can start a new epoch;
- `record_codex_review_request` after an existing snapshot and after ambiguity
  acknowledgement, each revoking any gate, clearing only
  `latest_observation`, preserving baseline and both histories, and returning
  `PR_PENDING` until a replacement snapshot is recorded;
- a pull request head changed before and after Codex review;
- an incomplete policy query, ambiguous `404`, explicit no-check policy, empty
  incomplete collections, incomplete pagination, and count mismatches;
- independently missing, partial, stale, and empty-complete check-run and
  commit-status feeds, per-kind item-count and reported-total mismatches, and a
  check-run query using the default latest-only filter instead of `filter=all`;
- a classic-protection `404` after successful branch/rules reads but without
  endpoint-specific authorization proof, plus GitHub App installation
  `administration` grants of missing, `read`, and `write`;
- required checks from a different head or with pending, failed, cancelled, or
  missing results;
- a required check produced by the wrong GitHub App, an explicitly unbound
  requirement, a check run with missing app identity, a commit status with an
  invented App mapping, and a legacy `contexts[]` policy read;
- a pinned requirement with only a passing commit status remaining
  `CHECKS_PENDING`, plus a pinned matching check run accompanied by passing,
  pending, and failing same-context commit statuses, and an explicitly unbound
  requirement satisfied by a commit status with unavailable App identity;
- a failed rerun after success, a successful rerun after failure, a pending
  rerun after success, and runs with missing or ambiguous ordering;
- same-name check runs and commit statuses in every pass/fail/pending
  combination, proving each present kind is evaluated independently and
  cross-kind timestamps never suppress one side, plus same-kind timestamp ties
  ordered by `run_id`;
- classic and ruleset strict-update flags in every true/false combination, a
  missing strict field, and strict heads that are `AHEAD`, `IDENTICAL`,
  `BEHIND`, `DIVERGED`, or have incomplete comparison evidence;
- reviewed-base ancestry with a current base that is `AHEAD` or `IDENTICAL`,
  plus `BEHIND`, `DIVERGED`, and incomplete comparisons when strict updates
  are false and when no checks are configured, proving only the first two can
  reach `MERGE_READY` and that restoring an invalidated base cannot revive the
  ledger;
- `SKIPPED`, `NEUTRAL`, `TIMED_OUT`, `ACTION_REQUIRED`, `STALE`, and an
  unrecognized future check conclusion;
- a missing request, a non-exact request, duplicate requests, and a newer
  request that supersedes an older `CLEAN` result;
- immediate post-response request binding, restart after binding, a crash
  between posting and binding, a changed head before binding, a manual exact
  issue-comment request from a non-workflow actor recorded as `UNBOUND`, and
  direct-human acknowledgement recovery without inferring its head;
- baseline partition validation that rejects an active baseline identity, a
  non-baseline identity smuggled into `preexisting_pairs`, and a newly seen
  request with an old `event_at` that must still become unbound or unsupported;
- a complete listing that temporarily omits a just-recorded request within the
  30-second visibility grace, a successful retry after it appears, and
  persistent absence or deletion after the grace becoming terminal;
- an exact request posted as a pull request review body or review comment,
  each recorded as an unsupported request and deriving
  `GITHUB_REVIEW_UNKNOWN` instead of leaving an older request eligible, then
  closed only by direct approval of its exact
  `(resource_kind, resource_id)` reference;
- overlapping requests where the older delayed result arrives after the newer
  request and derives `GITHUB_REVIEW_UNKNOWN`, plus a body-only request
  permalink that remains ambiguous;
- an automatic pre-request result with no eligible baseline source recorded as
  `UNSOLICITED`, followed by a normal explicit request and result reaching
  `MERGE_READY` without acknowledgement, with the unsolicited result never
  correlating later;
- a recovery request admitted before acknowledgement, with every subsequent
  result remaining ambiguous and the early recovery request reported as
  closed only when its ID is included in the directly approved and supplied
  closure set; omission of any open recovery request fails acknowledgement;
  exact-set acknowledgement followed by a request admitted in a later
  revision; a
  delayed old result after acknowledgement as an explicitly accepted risk; and
  a later ambiguity requiring another acknowledgement;
- zero and multiple candidate results after the latest request;
- an ambiguous result that is later body-edited, deleted, or reported with
  conflicting actor/commit provenance, each persisting terminal `INVALIDATED`
  so a remaining older `CLEAN` cannot regain eligibility; an unchanged body
  digest re-parsed to a different verdict under an updated adapter without
  truncating history; and incomplete result collection leaving result history
  unchanged;
- a reaction without a Codex result;
- a result created before its request;
- a formal review with a GitHub-native `commit_id`, conversation-comment and
  review-comment results with no accepted commit binding, an attempted
  PR-head copy/body-SHA/linked-review binding, and a missing, malformed,
  unknown, or stale reviewed commit;
- a formal review from the expected numeric Bot actor, a human review copying
  the recognized body and login, a different Bot ID, and missing or non-Bot
  actor provenance; foreign objects while one request is open and between two
  requests must remain audit-only, so a later delayed Codex result still
  becomes ambiguous rather than silently closing the wrong request;
- request/result timestamp ties within one resource kind, where object ID may
  order them, and across issue-comment/review resource kinds, where association
  derives `GITHUB_REVIEW_UNKNOWN`;
- every accepted `resource_kind`, an unrecognized kind, and object-ID
  uniqueness scoped separately to each kind, including acknowledgement records
  that distinguish equal numeric result IDs from different kinds;
- findings and unresolved, resolved, and outdated threads;
- a superseding exact request that is later edited, deleted, or recreated under
  a new ID after being observed, each persisting terminal `INVALIDATED` so an
  older `CLEAN` cannot regain eligibility;
- an unsupported review/comment request that is later edited or deleted after
  being observed, with the same terminal invalidation and monotonic history
  behavior;
- a pull request retargeted to another base branch;
- a target branch force-pushed or reset behind the locally reviewed base,
  including restoring the original base without clearing terminal
  `INVALIDATED`;
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
- `record_codex_review_request` after finalization revoking and
  directory-syncing the existing gate before writing its new revision;
- a freshly finalized gate that validates against its unchanged ledger
  revision before `expires_at`, expiry at the oldest underlying five-minute
  deadline with an otherwise unchanged revision/head, and a same-head mutation
  landing after verification but before merge to document the residual
  point-in-time limitation;
- valid and invalid `verify_publication_gate` calls that leave
  `publication.json` byte-identical, including request and result histories,
  terminal, revision, and cached status, with exact boundary tests immediately
  before, at, and after `expires_at`;
- ambiguity acknowledgement with wrong head, stale revision, missing or extra
  resource-scoped request references (including unbound and unsupported
  requests) or resource-scoped result references, equal numeric request IDs in
  different resource kinds, missing rationale, or the wrong acknowledgement
  enum, plus a stale or future-dated backing observation, gate revocation,
  closed-reference reporting, the backing observation timestamp/hash, and the
  revisioned audit record on success, including a recovery request whose
  GitHub `created_at` is equal to or earlier than `acknowledged_at` but whose
  later `recorded_revision` correctly places it in the new epoch;
- packaged-skill assertions for the complete seven-tool ordering, immediate
  pre-start baseline collection, request binding, prohibition of manual exact
  request comments, unbound or unsupported request recovery through
  full-closure direct-human ambiguity approval, stable Bot actor-ID resolution,
  and immediate pre-merge gate verification;
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
   packaged Codex workflow skill with the seven-tool ordering, complete
   pre-start baseline collection, immediate post-response request binding,
   immediate pre-merge gate verification, no-manual-request guidance,
   unbound-or-unsupported-request recovery through the full-closure
   direct-human ambiguity approval rule, and stable Codex Bot actor-ID
   resolution; and make
   `scripts/verify-build.mjs` assert those skill requirements. Adapter fixtures
   also cover the 30-second post-to-list visibility grace and endpoint-specific
   installation-permission evidence for classic-protection `404` responses.
   Before enabling publication, capture an adapter fixture from the connector's
   observed output and verify that it contains a formal pull request review;
   conversation-comment-only and review-comment-only fixtures are unsupported
   in version 1.

Each implementation change requires its own local Claude review and GitHub
Codex review.

## Unresolved questions

None.

## References

- [GitHub REST API: Get rules for a branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)
- [GitHub REST API: Get a branch](https://docs.github.com/en/rest/branches/branches#get-a-branch)
- [GitHub REST API: Get branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)
- [GitHub REST API: Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST API: Check runs](https://docs.github.com/en/rest/checks/runs)
- [GitHub REST API: Commit statuses](https://docs.github.com/en/rest/commits/statuses)
- [GitHub Docs: Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
