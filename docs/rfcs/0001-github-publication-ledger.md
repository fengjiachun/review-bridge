# RFC 0001: GitHub Publication Ledger

| Field | Value |
| --- | --- |
| Status | Implemented |
| Authors | Review Bridge contributors |
| Created | 2026-07-25 |
| Target release | v0.2.0 |
| Shipped in | v0.2.0 |

This RFC describes the version-1 local-gate publication ledger as shipped in
v0.2.0. Version 0.4 added authorization-union ledgers with schema version 2,
which remain able to read and complete version-1 ledgers; that extension is not
covered here.

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
- Recover GitHub request or result objects deleted before the first complete
  publication baseline.

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

Version 1 also assumes that exact or trigger-shaped Codex review request
objects are not deleted before the next publication baseline captures them.
GitHub's
current-object listing APIs cannot prove that an already deleted request once
existed, so a repository that cannot enforce this operational rule must not
treat the local publication gate as sufficient. Closing that historical gap
requires a future PR-scoped webhook or append-only GitHub-side event ledger.

GitHub also exposes no structural identifier tying a Codex result to the event
that triggered it. Publication therefore starts under one immutable trigger
policy. `EXPLICIT_ONLY` asserts that automatic Codex review is disabled.
It also asserts that the packaged workflow is the only actor allowed to issue
Codex review triggers.
`AUTOMATIC_QUIESCENCE_ACKNOWLEDGED` requires direct human confirmation, bound
to the current head and obtained immediately before the baseline, that every
automatic review already triggered for that head has finished; it records the
operator label, rationale, and acknowledgement time. The server cannot verify
either repository setting or quiescence, so the latter explicitly accepts the
risk of an undisclosed automatic result later being associated with a workflow
request. The skill may never infer this acknowledgement from elapsed time,
reactions, silence, or a general instruction to continue.

## Storage

Publication state is separate from the local review state:

```text
reviews/<review_id>/
├── review.json
├── gate.json
├── publication.json
├── publication-gate.json
├── publication-gate-audit.jsonl
└── publication-gate-audit-head.json
```

Separating the files keeps the Claude review lifecycle unchanged and prevents
GitHub publication fields from becoming part of the reviewer protocol.

`publication.json` is the current mutable ledger. `publication-gate.json` is
written only after a fresh observation derives `MERGE_READY`. The gate is a
revocable view of one ledger revision, not an independent durable verdict. It
is valid only while its `publication_revision` equals the current ledger
revision, that revision still derives `MERGE_READY`, and the server clock has
not passed the `expires_at` recomputed from the stored observation timestamps.
`publication-gate-audit.jsonl` is a server-maintained append-only event log.
`publication-gate-audit-head.json` is a small atomic cursor that commits a
prefix of that log. Appending never rewrites prior events; only the cursor is
replaced. Together they record accepted finalization attempts and every
completed gate-verification verdict for post-publication audit, but neither is
read to authorize a merge.

All files use the existing private directory and file modes. Publication
JSON snapshots and the audit head use the same exclusive temporary-file,
file-sync, atomic-rename, and directory-sync procedure as review mutations, but
not their serializer. `publication.json`, `publication-gate.json`, and
`publication-gate-audit-head.json` are each one RFC 8785 canonical UTF-8 JSON
value followed by one newline. Existing `review.json` and `gate.json` retain
their current formatting so their file-byte digests stay stable. Audit records
use the append-and-commit protocol below. All publication mutations also use a
per-review inter-process lock and revision check so concurrent Codex sessions
cannot overwrite each other's observations.

Whenever `gate.json`, `publication.json`, or `publication-gate.json` is read to
issue or verify a merge-authorizing gate, the server opens the canonical path
without following symlinks and confirms from the opened descriptor that it is a
regular file with mode `0600`. A symlink, another file type, a permission
mismatch, or a file above the size limit never authorizes a gate. A symlink,
non-regular file, or oversized file is an unrecoverable local store error. A
mode mismatch returns actionable, non-mutating `STORE_MODE_MISMATCH` with the
canonical path, actual mode, required mode `0600`, and instruction to correct
the mode and retry. It is a store-precondition failure before a verification
verdict or gate-finalization decision, so it short-circuits before any audit
append and changes no file. Path validation is not based on a separate
time-of-check lookup.

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
  "revision": 3,
  "review_id": "rb-...",
  "created_at": "2026-07-25T08:00:00.000Z",
  "updated_at": "2026-07-25T08:05:01.000Z",
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
    },
    "codex_trigger_policy": {
      "mode": "EXPLICIT_ONLY",
      "operator_label": null,
      "rationale": null,
      "acknowledged_at": null
    }
  },
  "terminal": null,
  "codex_review_baseline": {
    "observed_at": "2026-07-25T07:59:58.000Z",
    "recorded_at": "2026-07-25T08:00:00.000Z",
    "collection": {
      "status": "COMPLETE",
      "collected_at": "2026-07-25T07:59:58.000Z",
      "adapter_version": 1,
      "sources": [
        {
          "kind": "ISSUE_COMMENTS",
          "endpoint": "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          "collected_at": "2026-07-25T07:59:58.000Z",
          "status": "COMPLETE",
          "pagination_complete": true,
          "page_count": 1
        },
        {
          "kind": "PULL_REQUEST_REVIEWS",
          "endpoint": "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          "collected_at": "2026-07-25T07:59:58.000Z",
          "status": "COMPLETE",
          "pagination_complete": true,
          "page_count": 1
        },
        {
          "kind": "PULL_REQUEST_REVIEW_COMMENTS",
          "endpoint": "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
          "collected_at": "2026-07-25T07:59:58.000Z",
          "status": "COMPLETE",
          "pagination_complete": true,
          "page_count": 1
        }
      ]
    },
    "requests": [],
    "candidate_results": []
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
      "timestamp_field": "created_at",
      "recorded_at": "2026-07-25T08:03:01.000Z",
      "recorded_revision": 2,
      "body_sha256": "sha256...",
      "requested_head_sha": "0123456789abcdef..."
    }
  ],
  "codex_result_history": [
    {
      "result_id": 101,
      "resource_kind": "ISSUE_COMMENT",
      "native_review_state": null,
      "url": "https://github.com/...",
      "event_at": "2026-07-25T08:04:00.000Z",
      "timestamp_field": "created_at",
      "actor": {
        "id": 987654,
        "type": "Bot"
      },
      "reviewed_head_sha": "0123456789abcdef...",
      "commit_binding": {
        "source": "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
        "field": "body.reviewed_commit",
        "prefix": "0123456789"
      },
      "attached_review_comments": [],
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
        "sources": [
          {
            "kind": "PULL_REQUEST",
            "endpoint": "GET /repos/{owner}/{repo}/pulls/{pull_number}",
            "collected_at": "2026-07-25T08:05:00.000Z",
            "status": "COMPLETE"
          },
          {
            "kind": "BASE_BRANCH_METADATA",
            "endpoint": "GET /repos/{owner}/{repo}/branches/{branch}",
            "collected_at": "2026-07-25T08:04:59.000Z",
            "status": "COMPLETE",
            "branch_tip_sha": "abcdef0123456789..."
          },
          {
            "kind": "BASE_HEAD_COMPARISON",
            "endpoint": "GET /repos/{owner}/{repo}/compare/{base}...{head}",
            "collected_at": "2026-07-25T08:05:00.000Z",
            "status": "COMPLETE"
          },
          {
            "kind": "REVIEWED_BASE_CURRENT_BASE_COMPARISON",
            "endpoint": "GET /repos/{owner}/{repo}/compare/{reviewed_base}...{current_base}",
            "collected_at": "2026-07-25T08:05:00.000Z",
            "status": "COMPLETE"
          }
        ]
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
      "pr_reported_base_sha": "fedcba9876543210...",
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
            "kind": "CHECK_RUN",
            "endpoint": "GET /repos/{owner}/{repo}/commits/{head}/check-runs?filter=all",
            "status": "COMPLETE",
            "collected_at": "2026-07-25T08:04:58.000Z",
            "pagination_complete": true,
            "page_count": 1,
            "item_count": 1,
            "reported_total_count": 1
          },
          {
            "kind": "COMMIT_STATUS",
            "endpoint": "GET /repos/{owner}/{repo}/commits/{head}/statuses",
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
            "collected_at": "2026-07-25T08:05:00.000Z",
            "result": "SUCCESS",
            "binding_field": "rules[].parameters.required_status_checks[].integration_id",
            "pagination_complete": true,
            "page_count": 1
          },
          {
            "kind": "BRANCH_METADATA",
            "endpoint": "GET /repos/{owner}/{repo}/branches/{branch}",
            "collected_at": "2026-07-25T08:05:00.000Z",
            "result": "SUCCESS",
            "protected": true,
            "branch_tip_sha": "abcdef0123456789..."
          },
          {
            "kind": "CLASSIC_BRANCH_PROTECTION",
            "endpoint": "GET /repos/{owner}/{repo}/branches/{branch}/protection",
            "collected_at": "2026-07-25T08:05:00.000Z",
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
              "field": "required_status_checks.checks[].app_id",
              "raw_representation": "POSITIVE_INTEGER"
            }
          ]
        }
      ],
      "runs": [
        {
          "run_id": 9001,
          "run_kind": "CHECK_RUN",
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
        "adapter_version": 1,
        "sources": [
          {
            "kind": "ISSUE_COMMENTS",
            "endpoint": "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
            "collected_at": "2026-07-25T08:05:00.000Z",
            "status": "COMPLETE",
            "pagination_complete": true,
            "page_count": 1
          },
          {
            "kind": "PULL_REQUEST_REVIEWS",
            "endpoint": "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
            "collected_at": "2026-07-25T08:05:00.000Z",
            "status": "COMPLETE",
            "pagination_complete": true,
            "page_count": 1
          },
          {
            "kind": "PULL_REQUEST_REVIEW_COMMENTS",
            "endpoint": "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
            "collected_at": "2026-07-25T08:05:00.000Z",
            "status": "COMPLETE",
            "pagination_complete": true,
            "page_count": 1
          }
        ]
      },
      "preexisting_requests": [],
      "preexisting_candidate_results": [],
      "requests": [
        {
          "comment_id": 100,
          "resource_kind": "ISSUE_COMMENT",
          "url": "https://github.com/...",
          "event_at": "2026-07-25T08:03:00.000Z",
          "timestamp_field": "created_at",
          "body": "@codex review",
          "body_sha256": "sha256...",
          "requested_head_sha": "0123456789abcdef..."
        }
      ],
      "unbound_requests": [],
      "unsupported_requests": [],
      "foreign_actor_objects": [],
      "results": [
        {
          "result_id": 101,
          "resource_kind": "ISSUE_COMMENT",
          "native_review_state": null,
          "url": "https://github.com/...",
          "event_at": "2026-07-25T08:04:00.000Z",
          "timestamp_field": "created_at",
          "actor": {
            "id": 987654,
            "type": "Bot",
            "login": "chatgpt-codex-connector[bot]"
          },
          "request_ref": {
            "resource_kind": "ISSUE_COMMENT",
            "resource_id": 100
          },
          "association": "SINGLE_OPEN_REQUEST",
          "reviewed_head_sha": "0123456789abcdef...",
          "commit_binding": {
            "source": "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
            "field": "body.reviewed_commit",
            "prefix": "0123456789"
          },
          "attached_review_comments": [],
          "format": "CODEX_CLEAN_COMMENT_V1",
          "verdict": "CLEAN",
          "body_sha256": "sha256..."
        }
      ]
    },
    "review_threads": {
      "collection": {
        "status": "COMPLETE",
        "collected_at": "2026-07-25T08:05:00.000Z",
        "sources": [
          {
            "kind": "PULL_REQUEST_REVIEW_THREADS",
            "endpoint": "GraphQL PullRequest.reviewThreads",
            "collected_at": "2026-07-25T08:05:00.000Z",
            "status": "COMPLETE",
            "pagination_complete": true,
            "page_count": 1
          }
        ]
      },
      "total_count": 0,
      "unresolved_count": 0,
      "threads": []
    }
  },
  "status": "MERGE_READY",
  "history": [
    {
      "at": "2026-07-25T08:00:00.000Z",
      "event": "PUBLICATION_STARTED",
      "revision": 1,
      "status": "PR_PENDING",
      "head_sha": "0123456789abcdef..."
    },
    {
      "at": "2026-07-25T08:03:01.000Z",
      "event": "CODEX_REVIEW_REQUEST_RECORDED",
      "revision": 2,
      "status": "PR_PENDING",
      "head_sha": "0123456789abcdef...",
      "cleared_observation_sha256": null
    },
    {
      "at": "2026-07-25T08:05:01.000Z",
      "event": "GITHUB_SNAPSHOT_RECORDED",
      "revision": 3,
      "status": "MERGE_READY",
      "head_sha": "0123456789abcdef..."
    }
  ]
}
```

Every history event records `at`, `event`, `revision`, `status`, and
`head_sha`. `event` is exactly `PUBLICATION_STARTED`,
`CODEX_REVIEW_REQUEST_RECORDED`, `GITHUB_SNAPSHOT_RECORDED`, or
`CODEX_REVIEW_AMBIGUITY_ACKNOWLEDGED`; any other value is rejected. A
`CODEX_REVIEW_REQUEST_RECORDED` event additionally records
`cleared_observation_sha256`: null when no observation existed, otherwise the
64-hex RFC 8785 digest of the exact normalized `latest_observation` discarded
by that mutation. No other event may carry that field. A populated event is:

```json
{
  "at": "2026-07-25T08:07:00.000Z",
  "event": "CODEX_REVIEW_REQUEST_RECORDED",
  "revision": 4,
  "status": "PR_PENDING",
  "head_sha": "0123456789abcdef0123456789abcdef01234567",
  "cleared_observation_sha256": "2222222222222222222222222222222222222222222222222222222222222222"
}
```

GitHub object IDs and URLs are evidence locators. The ledger stores normalized
facts and a hash of the Codex response body instead of depending on mutable
free-form chat text as its source of truth.

For request and result object identities, `resource_kind` is exactly one of
`ISSUE_COMMENT`, `PULL_REQUEST_REVIEW`, or
`PULL_REQUEST_REVIEW_COMMENT`. Each value names a separate GitHub object-ID
namespace; an unrecognized value is rejected rather than treated as a new
namespace. Recognized review requests are always `ISSUE_COMMENT` objects, so
their native API field remains `comment_id`. Collection-source entries instead
use `kind`; source kinds identify fetched feeds or derived comparison evidence
and never participate in object identity.

Every numeric GitHub identifier accepted by schema version 1 must be a positive
JavaScript safe integer. The server rejects larger JSON numbers rather than
risk precision loss; a future schema may encode REST identifiers as decimal
strings. Object-identity comparisons remain scoped by review `resource_kind`
even when two objects have the same numeric value.

Version 1 accepts full Git object IDs only as 40 lowercase hexadecimal
characters and SHA-256 digests only as 64 lowercase hexadecimal characters.
The shortened values ending in `...` in this RFC are readability placeholders,
not schema-valid inputs.

All normalized timestamps use canonical UTC RFC 3339 with millisecond
precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Validation compares parsed instants and
rejects invalid or non-canonical strings rather than relying on caller locale.

Server-derived digests of JSON values hash the UTF-8 RFC 8785 JSON
Canonicalization Scheme representation of the named normalized value.
`github_observation_sha256`, including every copy in a gate or gate-audit
event, hashes the exact normalized `latest_observation` object, including its
server-authored `recorded_at`. `backing_observation_sha256` hashes the exact
normalized observation that backs the acknowledgement, also including its
server-authored `recorded_at`. The same normalized observation therefore has
the same digest wherever that digest is copied. Digests of existing files such
as `local_gate_sha256` hash the exact file bytes. Body-digest semantics are
defined separately in the adapter section.

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
      "reason": "WRONG_RESOURCE_KIND",
      "body_sha256": "sha256..."
    }
  ]
}
```

Empty arrays never imply that collection succeeded. Each evidence class carries
`collection.status`, a parent collection time, and one source entry for every
independent GitHub endpoint or GraphQL connection used to produce it. Every
source records its endpoint, endpoint-specific outcome, and
response-completion `collected_at`; paginated sources also record
`pagination_complete` and a positive `page_count`. What that flag rests on
differs by endpoint, and so does how much the server can check.

Feeds returning a bare list expose no total, so the collector's only proof of
exhaustion is the absence of a `Link` header advertising `rel="next"` on the
last response. Two limits are worth stating rather than leaving to be
rediscovered. That header proves the walk reached the last page, not that every
item was seen: the feed is walked by offset, so a deletion and an insertion
between two requests can drop an item without repeating one, and these feeds
carry no total against which to notice. And at the ledger boundary the flag
remains a caller assertion — the observation arrives as caller-supplied JSON,
so the server can require the boolean to be true but cannot re-derive it.

Check runs, commit statuses and review threads are read atomically instead:
a single response, with more than one page refused. All three reach a decision
through a selection that prefers the newest evidence — `decidingRunsFor` takes
the latest run for a context, and `unresolved_count` counts what is currently
open — so anything that hides the newest objection resolves in favour of
merging. Each hides it differently, and no count sees any of them. A check run
is mutable in place, since the Checks API updates status and conclusion on the
same id, so a run read as successful and failed before the next page is
recorded successful with every count intact. A review thread's resolved flag
mutates the same way. A commit status is immutable per posting, but that
endpoint reports no total, so a walk has nothing against which to notice a row
it never saw; whether it could depends on the feed's ordering, and reading one
page removes the dependency rather than resting on it.

The Codex feeds are still walked, and it is worth being exact about why, since
per-item state decides the gate there too. One direction is closed: a review's
own state only ever moves between `PENDING`, `DISMISSED` and the submitted
states, all of which withhold `MERGE_READY`, so a stale read of that field
cannot be more permissive than the truth. Two directions are not closed, and
are recorded here rather than argued away.

A body edited or deleted mid-walk is recorded as it was read, and that can run
the permissive way: a Codex clean comment read before an edit that removes its marker is
stored as clean, where the current body would leave the result set empty and
derive `GITHUB_REVIEW_PENDING`. `codex_result_history` does not catch it,
because that compares against previously recorded observations and a result
first seen during a walk enters history already carrying the stale value. The
offset-drop limit above applies here as well, these feeds having no total
either. Both remain open, and the reason these feeds are walked rather than
read atomically is a practical one — a pull request may hold more than a page
of comments, where more than a page of check runs or review threads is rare
enough to refuse.

A check run's single page is proven by the `total_count` the endpoint reports;
a commit status's and a review thread's by the terminal `Link` state and the
connection's own `totalCount` respectively. The parent
`collection.collected_at` must equal the maximum source time, while every
source time independently participates in freshness and
atomic-window validation. Reusing a cached response preserves its original
source time; normalizing it later cannot refresh it. Any missing source, failed
query, ambiguous permission error, or incomplete page sequence makes the whole
observation incomplete.

Both the immutable baseline and each current Codex-review collection record
the positive `adapter_version` used to parse all three Codex feeds. This RFC
supports only adapter version 1. `start_publication` and
`record_github_snapshot` reject a missing, mixed, or unsupported adapter
version before state derivation; changing adapter semantics therefore requires
a new version and a new publication ledger rather than silently reinterpreting
an existing history.

For `codex_trigger_policy.mode: "EXPLICIT_ONLY"`, `operator_label`,
`rationale`, and `acknowledged_at` are all null. For
`AUTOMATIC_QUIESCENCE_ACKNOWLEDGED`, the first two are non-empty direct-human
inputs and `acknowledged_at` is the server timestamp assigned by
`start_publication`.

`codex_review_baseline` is an immutable publication-start cutoff captured from
a fresh, complete, fully paginated collection immediately before
`start_publication`. It uses stable `(resource_kind, resource_id)` identities,
not a comparison between GitHub and server timestamps. It stores every
preexisting exact or trigger-shaped request from all three supported resource
kinds and every
preexisting actor-admitted candidate result. Baseline objects are audit-only:
they never satisfy the new ledger and are never retrospectively paired.

Every baseline request remains an open source candidate until an operator
explicitly acknowledges its exact resource-scoped reference and accepts that
it will produce no further result. Therefore the first complete snapshot
derives `GITHUB_REVIEW_UNKNOWN` while any baseline request remains open, and
the workflow must obtain that acknowledgement before posting its first new
request. This one-time fail-closed boundary avoids inventing a historical head
binding or assuming that an old result proves no delayed duplicate can arrive.
Preexisting results remain audit-only and do not themselves require
acknowledgement unless a later active association makes a new result
indeterminate.

Each baseline request records the same identity, URL, event timestamp,
timestamp field, and body digest as an active request. An exact issue comment
uses classification `BASELINE_EXACT`; exact text in another resource kind and
trigger-shaped non-exact text use `BASELINE_UNSUPPORTED` plus
`WRONG_RESOURCE_KIND` or `NON_EXACT_TRIGGER_SHAPE`. These classifications are
immutable audit facts, not active-history bindings.

The adapter does not echo server-assigned `classification` or `reason` fields.
For `preexisting_requests`, it returns exactly the immutable GitHub facts
`resource_id`, `resource_kind`, URL, `event_at`, `timestamp_field`,
`body_sha256`, and stable actor ID/type. For
`preexisting_candidate_results`, it returns those applicable result facts plus
`result_id`, resource-kind-appropriate native review state, reviewed-head and
commit-binding provenance, and immutable attached review-comment evidence.
The server projects each stored baseline object onto the corresponding
type-specific immutable-fact shape and requires exact set equality with the
adapter array. It separately verifies that the stored server-assigned
classification and reason have not changed. The caller cannot supply or
reclassify them. A non-empty request example is:

```json
{
  "schema_valid_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "stored_baseline_request": {
    "resource_id": 77,
    "resource_kind": "ISSUE_COMMENT",
    "url": "https://github.com/owner/repository/issues/5#issuecomment-77",
    "event_at": "2026-07-25T07:55:00.000Z",
    "timestamp_field": "created_at",
    "body_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
    "actor": {
      "id": 88,
      "type": "User"
    },
    "classification": "BASELINE_EXACT",
    "reason": null
  },
  "adapter_preexisting_request": {
    "resource_id": 77,
    "resource_kind": "ISSUE_COMMENT",
    "url": "https://github.com/owner/repository/issues/5#issuecomment-77",
    "event_at": "2026-07-25T07:55:00.000Z",
    "timestamp_field": "created_at",
    "body_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
    "actor": {
      "id": 88,
      "type": "User"
    }
  }
}
```

The server later requires every baseline object still returned by the three
feeds to match its stored immutable identity, body digest, actor, timestamp,
native state, and commit provenance. Deletion or mutation persists terminal
`INVALIDATED`; a new object cannot be smuggled into the baseline by giving it
an old GitHub timestamp. A request object first appearing after the complete
baseline must have a `RECORDED_AT_POST` binding or enter active history as
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
`timestamp_field`, server `recorded_at`, server `recorded_revision`,
`body_sha256`, and nullable `requested_head_sha`; the SHA is required for
recognized requests and null for unbound or unsupported requests.
`recorded_revision` is the ledger revision whose mutation first admitted the
request and is the authoritative ordering signal across acknowledgement
boundaries. On every later complete collection,
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
ID and type, nullable resource-kind-appropriate native review state,
reviewed-head and commit-binding provenance, immutable attached
review-comment evidence for formal findings, body digest, and server
`recorded_at`; adapter-derived format, verdict, and request association are
deliberately excluded because the evaluator replays them from the immutable
baseline, complete histories, and current complete collection.
On every later complete collection, every historical result must still appear
in `results`
with the same immutable GitHub facts. A missing result, changed body, reused
`(resource_kind, result_id)`, changed actor, changed resource-kind-appropriate
native review state, conflicting commit binding, or missing or changed
attached review-comment evidence persists terminal `INVALIDATED`. Adapter
semantics cannot change inside one version-1
publication ledger. Incomplete collections neither compare nor advance result
history, and result disappearance receives no post-to-list grace.

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

Run discovery reads each feed in a single request, and refuses more than one
page of either. Both carry state that decides the gate, and a walk reads each
page at its own instant, so a run or status that changes after its page was
read is stored with a value it no longer has. The two endpoints are:

- `GET /repos/{owner}/{repo}/commits/{head}/check-runs?filter=all`; and
- `GET /repos/{owner}/{repo}/commits/{head}/statuses`.

The check-run request must use `filter=all`; GitHub's default latest-only view
cannot prove complete attempt ordering. Each `run_kind` has a separate
`run_sources` entry with its endpoint, status, collection time, pagination
flag, page count, item count, and endpoint-provided total count when available.
`COMPLETE` requires
`pagination_complete: true`, a `page_count` of exactly one, and `item_count`
equal to the number of normalized runs of that kind. A source recording more
than one page is refused as invalid input rather than derived as incomplete
evidence: it is not a collection that fell short, but one whose per-run state
was never observed at a single instant. Both entries are mandatory even
when their item count is zero. The check-run entry also records GitHub's
non-negative `total_count` as `reported_total_count` and requires it to equal
`item_count`; the commit-status entry uses null because that endpoint exposes
no total count, and proves its single page instead by the absence of a `Link`
header advertising a next page. Reading atomically puts a ceiling of 100 on
both feeds, and a head commit exceeding either cannot be collected at all. For
check runs the ceiling shows as a reported `total_count` above the page size;
for statuses, as a full page that still advertises a next one. The status
ceiling is the more reachable of the two, since that endpoint returns one row
per posting rather than one per context. Both are an accepted cost of reading
at a single instant, and both refusals name the ceiling rather than reporting a
count mismatch or a short read. An absent, failed, or unknown source makes required-check
evidence incomplete; completeness of one kind never substitutes for the
other.

The required-check keys are the union of both successful policy reads. A key is
the exact tuple `(context, app_binding, required_app_id)`. Duplicate instances
of one tuple are coalesced and retain every distinct `binding_source`; tuples
that share a context but differ in binding or App ID remain separate required
checks. Each requirement records:

- `app_binding`: `PINNED` or `EXPLICITLY_UNBOUND`;
- `required_app_id`, which is a positive integer exactly when the binding is
  `PINNED` and null exactly when it is `EXPLICITLY_UNBOUND`; and
- every identity-capable response field and raw representation that supplied
  the binding.

The adapter normalizes a ruleset `integration_id` and a classic
branch-protection `checks[].app_id` into `required_app_id`. A positive integer
produces `PINNED`. A classic GET response with `app_id: null` produces
`EXPLICITLY_UNBOUND`; the documented write-side `-1` sentinel produces the same
result if a response ever contains it. Ruleset `integration_id` being null or
absent inside an otherwise valid required-status-check object also produces
`EXPLICITLY_UNBOUND`, because that field is optional in GitHub's schema. Zero
or another negative ruleset or classic value is `UNKNOWN`; `-1` is accepted
only from classic branch protection.
`EXPLICITLY_UNBOUND` permits a matching check run or commit status from any
producer. Each binding source records the raw representation
(`POSITIVE_INTEGER`, `NEGATIVE_ONE`, `NULL`, or `ABSENT`) as well as the field
path, so the normalization is replayable.

Reading only the legacy classic `contexts[]` field, a classic `checks[]` entry
with a missing `app_id` key, zero, or a negative value other than `-1`, or
otherwise using a response shape that cannot distinguish an explicit nullable
binding is `UNKNOWN`, never `SUCCESS` or `EXPLICITLY_UNBOUND`. A ruleset's
documented absent `integration_id` remains distinguishable from a response shape that omitted
the containing required-status-check object. Each policy source and requirement
records the exact binding field and raw representation, so the server can
enforce this distinction.

Each check run records its positive `app.id` as `app_id` and
`app_id_source: "CHECK_RUN_APP_ID"`. Check runs are the only version 1
resource kind that can prove a producing GitHub App ID; a missing or malformed
`app.id` is incomplete evidence. Each commit status records `app_id: null` and
`app_id_source: "COMMIT_STATUS_UNAVAILABLE"` because GitHub's commit-status
response exposes `creator`, not the producing App's numeric ID. The adapter
must not infer an App ID from the creator login, user ID, target URL, token
used to read the status, or any external mapping.

An authorization error or ambiguous `404` is `UNKNOWN`, not evidence that no
checks are configured. There is one positive no-protection shortcut: a
successful branch read with `protected: false`, together with a complete empty
applicable-rules response, proves that neither classic protection nor a
ruleset applies. In that case the classic-protection endpoint is not queried,
its policy-source entry is conditionally omitted, and policy discovery records
the branch field as the `NOT_CONFIGURED` provenance. When `protected` is true,
successful branch-metadata or applicable-rules reads do not prove access to
classic protection because that endpoint has a separate Administration
permission. A classic-protection `404` may then be classified as
`NOT_CONFIGURED` only when the connector also supplies this endpoint-specific
authorization proof. The classic source itself must name the exact
`GET /repos/{owner}/{repo}/branches/{base_branch}/protection` endpoint, retain
`http_status: 404`, and timestamp the completion of that response before any
follow-up permission lookup:

```json
{
  "kind": "GITHUB_APP_INSTALLATION_PERMISSIONS",
  "endpoint": "GET /repos/{owner}/{repo}/installation",
  "collected_at": "2026-07-25T08:05:00.000Z",
  "result": "SUCCESS",
  "credential_type": "GITHUB_APP",
  "field": "permissions.administration",
  "level": "READ"
}
```

Version 1 also accepts a local GitHub CLI OAuth proof when the exact
`GET /repos/{owner}/{repo}` response reports `permissions.admin: true` and its
`X-OAuth-Scopes` response header contains the full `repo` scope:

```json
{
  "kind": "GITHUB_OAUTH_REPOSITORY_PERMISSIONS",
  "endpoint": "GET /repos/{owner}/{repo}",
  "collected_at": "2026-07-25T08:05:00.000Z",
  "result": "SUCCESS",
  "credential_type": "OAUTH_SCOPE_TOKEN",
  "field": "x-oauth-scopes+permissions.admin",
  "level": "ADMIN",
  "scope": "repo"
}
```

The server accepts either that exact repository-bound proof or an authenticated
GitHub App installation-permission map whose `administration` grant is `read`
or `write`. A missing permission map, a mismatched repository endpoint, another
credential class, an inferred repository role without token scope, or
successful lower-privilege calls leave the `404` as `UNKNOWN`. Whenever this
proof is used, it is a conditionally mandatory `policy_sources` entry with its
own endpoint, success status, and response-completion `collected_at`; it
participates in source coverage, freshness, and the atomic-observation window
exactly like the policy read it authorizes.

`policy` is exactly `REQUIRED`, `STRICT_ONLY`, or `NONE_CONFIGURED`.
`REQUIRED` is valid only with a non-empty `requirements` array and may have
either boolean strict value. Complete policy discovery that produces zero
required-check keys never normalizes to `REQUIRED`. It becomes `STRICT_ONLY`
when `strict_policy.required` is true and `NONE_CONFIGURED` when it is false;
both require `requirements: []`.

Either empty-key policy is permitted only when discovery proves an explicit
empty result: the applicable-rules response contains no required status-check
key, and classic protection is either present with no required checks,
conclusively `NOT_CONFIGURED` through authorized `404` evidence, or
conditionally omitted under the successful `branch.protected: false`
shortcut. `STRICT_ONLY` additionally proves a successful applicable source
whose strict flag is true; `NONE_CONFIGURED` proves that every applicable
strict flag is false or no required-status-check policy exists. Any
policy/strict/requirements combination outside these three cases is malformed,
not vacuously satisfied. Fully collected runs may be present under either
empty-key policy because GitHub still reports optional checks and commit
statuses. They remain subject to run-source counts, schema, and head-binding
validation, but do not participate in required-check satisfaction. A caller
that cannot establish the policy or a required app binding derives
`EVIDENCE_INCOMPLETE`.

The authoritative current base is the live `commit.sha` returned by
`GET /repos/{owner}/{repo}/branches/{branch}`. The normalized pull-request
evidence stores it as `base_sha` and separately stores the pull request
object's potentially stale `base.sha` as audit-only
`pr_reported_base_sha`; that value is never an equality, comparison, or state
derivation input and may differ from the live tip. The pull-request
`BASE_BRANCH_METADATA` source and required-check `BRANCH_METADATA` policy
source are two mandatory independent fetches and both retain the fetched live
tip as `branch_tip_sha`. `BASE_BRANCH_METADATA.collected_at` must be strictly
earlier than `BRANCH_METADATA.collected_at`; a reused cached response retains
its original collection time and cannot back both entries. A complete
observation requires `base_sha` and both `branch_tip_sha` values to be the same
full SHA. A mismatch or missing field means the branch moved or one read was
incomplete inside the atomic window, derives `EVIDENCE_INCOMPLETE`, and is
retryable with two fresh reads. Exact source coverage counts these as two fetch
instances even though their endpoint templates are identical. Neither ancestry
nor strict-update evaluation may use `pr_reported_base_sha`.

`strict_policy.required` is the logical OR of every successful applicable
source's strict-update flag. The adapter records
`required_status_checks.strict` from classic protection and
`strict_required_status_checks_policy` from each applicable required-status-
checks ruleset rule, including false values and exact field provenance. A
missing or malformed strict field on a source that defines required checks
forces that owning `policy_sources[]` entry to `result: "UNKNOWN"` and the
required-check collection to `status: "UNKNOWN"`; the adapter must not emit a
successful source or `strict_policy.required: false` for it. Such an observation
derives `EVIDENCE_INCOMPLETE` before `strict_policy` is consumed. Consequently,
`strict_policy.required` remains a boolean only on a complete collection and
needs no implicit third value. When strict mode is required, the pull-request
collection also records the current base SHA and a complete compare response
for `base...head`.
The comparison's base and head SHAs must exactly match the pull-request
collection.
`AHEAD` or `IDENTICAL` proves that the head contains the current base;
`BEHIND` or `DIVERGED` derives `PR_UPDATE_REQUIRED`, and an unknown or
incomplete comparison derives `EVIDENCE_INCOMPLETE`. Updating the branch
changes the reviewed head and therefore requires a new local review.

Independently of strict-update policy, every pull-request collection records a
complete compare response for `local_gate.base_sha...pull_request.base_sha`.
The comparison's base SHA must exactly match the local gate and its head SHA
must exactly match the live base-branch tip. `AHEAD` or `IDENTICAL` proves
that the current target base preserves the locally reviewed base ancestry.
`BEHIND` or `DIVERGED` persists terminal `INVALIDATED`; an unknown or
incomplete comparison derives `EVIDENCE_INCOMPLETE`. This ancestry check is
always required, including when no status checks are configured or strict
updates are disabled.

Multiple runs may share one requirement key. Every run records `started_at` and
`completed_at`; the latter is null until completion. `run_kind` is exactly
`CHECK_RUN` or `COMMIT_STATUS`, and each kind has its own numeric ID namespace.
The evaluator partitions matching attempts by `run_kind` before selecting
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
`CHECKS_PENDING`; every non-completed run must have null `completed_at` and
null conclusion. A completed run must have non-null `completed_at` and exactly
one of these conclusions:

- `SUCCESS`, `SKIPPED`, or `NEUTRAL` satisfies the requirement;
- `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, or
  `STARTUP_FAILURE` derives `CHECKS_FAILED`;
- `STALE` derives `CHECKS_PENDING` and requires a rerun; and
- a missing or unrecognized value derives `EVIDENCE_INCOMPLETE`.

For a commit status, the adapter uses its creation time as `started_at`. A
`PENDING` status has normalized status `PENDING`, null `completed_at`, and null
conclusion even though GitHub supplies `updated_at`. A terminal status uses
`updated_at` as `completed_at`; `SUCCESS` maps to `SUCCESS`, `FAILURE` maps to
`FAILURE`, and `ERROR` maps to `FAILURE`. These passing conclusions match
GitHub's required-status-check semantics.

For an open pull request, `state` is `OPEN`, `is_merged` is false,
`merged_at` is null, and `merge_commit_sha` is normalized to null because
GitHub's pre-merge value may describe a test merge. Only `is_merged: true`
together with `state: "CLOSED"`, `merged_at`, and `merge_commit_sha` is merge
evidence.

Thread collection reads the `reviewThreads` connection in a single request and
refuses anything larger. A thread's resolved state decides the publication gate,
and state gathered across a walk is state from several instants, so only an
atomic read can establish it (see RFC 0003). It records every normalized thread,
not only unresolved threads, and the server requires:

```text
total_count == threads.length
unresolved_count == threads.filter(thread => !thread.is_resolved).length
```

An empty thread array is acceptable only with parent `status: "COMPLETE"`, one
complete review-thread source whose `pagination_complete` is true, and both
counts set to zero.

## Atomic GitHub observations

One `record_github_snapshot` call records all publication evidence observed at
the same time:

- pull request identity, current head and base SHAs, and reviewed-base ancestry;
- draft, open, mergeability, and base-branch state;
- required-check policy provenance, separate complete run feeds, and every run
  for the head;
- every exact or trigger-shaped Codex review request object, partitioned
  against the immutable publication-start baseline;
- every candidate Codex result needed to partition the immutable baseline and
  replay the active epoch with unclosed source-only baseline requests;
- the single-page review-thread collection and resolution counts; and
- the observation timestamp.

`observed_at` is captured immediately after the final GitHub response. Every
parent collection and every independent source has its own `collected_at`, and
the server requires all of them to satisfy:

```text
publication.created_at <= collected_at <= observed_at
observed_at - collected_at <= 2 minutes
max(collected_at) - min(collected_at) <= 2 minutes
```

This includes pull-request and comparison sources, required-check policy and
run sources, each Codex issue-comment/review/review-comment feed, and the
review-thread source. A parent collection timestamp cannot refresh any stale
source.

At both recording and finalization, every parent and source `collected_at` must
also be no more than five minutes old relative to the server clock and no more
than 30 seconds in the future. A current top-level `observed_at` cannot refresh
cached pull-request, comparison, policy, run, review, or thread evidence.

The separate start baseline is collected immediately before
`start_publication`, so its parent, source, and observation timestamps may
precede `publication.created_at`; they must still satisfy the same freshness,
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
history; only `record_github_snapshot` advances result history or persists a
newly proposed terminal state from the pure evaluator. Separately, after input
validation and before evaluation, any mutating publication tool may persist the
single out-of-band capacity terminal defined under Resource bounds, but only
when its mandatory server-owned monotonic projection no longer fits; rejected
caller input and replaceable observations never cause that transition.
Baseline requests remain in their immutable baseline collection and are closed
only by an ambiguity acknowledgement.
`record_codex_review_request` first clears
replaceable observation evidence, so its pure no-observation derivation is
`PR_PENDING` rather than a comparison between new history and a pre-post
snapshot.

The numbered derivation below is the single normative priority order.
Non-terminal statuses report its first applicable blocking condition. The
table mirrors that order for reference and is descriptive; if future editing
ever makes the two disagree, the numbered derivation controls.
The capacity transition is a storage precondition, not a GitHub-evidence
status; once written, derivation step 1 observes its ordinary `INVALIDATED`
terminal record.

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
| `GITHUB_REVIEW_UNKNOWN` | No | A baseline, unbound, or unsupported request is open, or the result format, association, or verdict is ambiguous. |
| `GITHUB_REVIEW_NOT_REQUESTED` | No | No valid exact request exists for the head. |
| `GITHUB_REVIEW_PENDING` | No | The latest request has no corresponding result. |
| `CHANGES_REQUIRED` | No | Codex reported findings or any review thread is unresolved. |
| `MERGE_READY` | No | Every required invariant passes for the current head. |
| `INVALIDATED` | Yes | The pull request identity/head no longer matches the local gate, the current base no longer preserves the reviewed base ancestry, or an observed request or Codex result disappeared or changed. |
| `CLOSED` | Yes | The pull request closed without a recorded merge. |
| `MERGED` | Yes | A live observation confirms the merge and its commit SHA. |

In a separate invalidation scenario, when `record_github_snapshot` first
receives a sticky derivation, it writes:

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

Once `terminal` is non-null, `record_codex_review_request`,
`record_github_snapshot`, `acknowledge_codex_review_ambiguity`, and
`finalize_publication_gate` fail with non-retryable
`PUBLICATION_TERMINAL` before revoking a gate or changing any file; the ledger
and audit entries remain byte-identical. `get_publication` remains readable and
`verify_publication_gate` remains callable, but verification necessarily
returns invalid because a terminal ledger cannot derive `MERGE_READY`.

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
   pull request head match the bound target and local gate.
   `pr_reported_base_sha` is retained for audit but ignored. The normalized
   `base_sha` and both independently fetched `branch_tip_sha` values match
   exactly, and the first branch-source time is strictly earlier than the
   second. Any mismatch or missing live-tip
   proof derives `EVIDENCE_INCOMPLETE` before comparisons. The complete
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
   Partition the immutable baseline objects by stored identity before
   requiring the complete current recognized/unbound/unsupported request union
   to match the already-reconciled `codex_request_history` and the complete
   current actor-admitted non-baseline result set to match
   `codex_result_history`. A disappearance, change, or missing history entry
   returns a proposed terminal `INVALIDATED` without mutating either structure,
   except that a just-recorded request absent within the bounded post-to-list
   visibility grace derives `EVIDENCE_INCOMPLETE`.
9. An open pull request with `is_draft: true` derives `PR_DRAFT`; otherwise
   continue.
10. The adapter normalizes GitHub's mergeability result to `MERGEABLE`,
   `CONFLICTING`, or `UNKNOWN`.
   `UNKNOWN` derives `PR_STATE_PENDING`; `CONFLICTING` derives
   `PR_CONFLICTING`; only `MERGEABLE` may continue.
11. Required-check policy discovery is complete, and reject every combination
    except `REQUIRED` with non-empty requirements, `STRICT_ONLY` with empty
    requirements and strict updates required, or `NONE_CONFIGURED` with empty
    requirements and strict updates not required. If any source requires strict
    updates, require
    `base_head_comparison` to prove the head contains the current base; `BEHIND`
    or `DIVERGED` derives `PR_UPDATE_REQUIRED` before any run conclusion is
    evaluated. Then require both run sources to report complete pagination and
    per-kind item counts that exactly match `runs`. For `REQUIRED`, partition
    matching runs by `run_kind`, select the latest attempt independently inside
    every present kind, and require every selected attempt to pass. A check run
    and commit status with the same required context both participate; neither
    supersedes the other. Every pinned requirement has a
    latest check run bound to the pull request head and exact required App ID;
    a commit status cannot establish that identity, but any same-context commit
    status kind must independently pass. Every explicitly unbound requirement
    has at least one latest run bound to the head, and every participating kind
    has a passing conclusion. For `STRICT_ONLY` and `NONE_CONFIGURED`, policy
    discovery is explicitly empty and optional fully collected runs may be
    present but do not participate in satisfaction. `STRICT_ONLY` reaches this
    point only after its mandatory base-to-head comparison passes.
12. Replay event identity and association from `codex_request_history`,
    `codex_result_history`, the current collection's validated parsed verdicts,
    and every stored ambiguity acknowledgement for the current head rather than
    trusting only the latest observation's identities. An immutable baseline
    request never enters active history or satisfies this ledger, but while
    unclosed it remains a source-only candidate for every later actor-admitted
    result because no trustworthy historical head binding exists. Any
    unacknowledged baseline request therefore derives
    `GITHUB_REVIEW_UNKNOWN`, even before a new request is posted. A result
    arriving before any active request and uniquely attributable to one
    baseline source is retained as `BASELINE_LATE_RESULT` audit evidence and
    cannot satisfy the new ledger; multiple eligible baseline sources make it
    ambiguous. Only an acknowledgement that names every open baseline request
    closes them for later epochs.
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
    `BASELINE_LATE_RESULT`. Neither result can satisfy review; an open baseline
    request remains independently blocking. A result arriving after its
    epoch's last request was already closed and before another request opens is
    ambiguous: every previously closed recognized request in the current epoch
    whose full head matches the formal review commit or clean marker prefix
    re-enters the indeterminate set; an unbound result includes all of them.
13. Any unacknowledged unsupported request after publication starts, including
    exact text in a pull request review or review comment and any
    trigger-shaped non-exact text in any of the three resource kinds, derives
    `GITHUB_REVIEW_UNKNOWN` and remains blocking until a valid acknowledgement
    closes its resource-scoped reference; it is never silently discarded.
    Exclude `closed_requests` and `foreign_actor_objects`. From the remaining
    recognized `ISSUE_COMMENT` requests, select the latest by
    `(event_at, comment_id)`. This tie-break is within one resource kind and ID
    namespace. If none exists, derive `GITHUB_REVIEW_NOT_REQUESTED`. Zero
    correlated results derives `GITHUB_REVIEW_PENDING`; an ambiguous result
    created after the latest request or more than one correlated result derives
    `GITHUB_REVIEW_UNKNOWN`. Timestamps widen ambiguity but never establish a
    request/result pairing.
14. The single correlated result's actor ID and `Bot` type match the immutable
    expected Codex actor. An expected-actor formal review in native
    `CHANGES_REQUESTED` state and bound to the current head derives
    `CHANGES_REQUIRED` regardless of body parsing; `DISMISSED` derives
    `GITHUB_REVIEW_UNKNOWN`. Only submitted `APPROVED` or `COMMENTED` states
    continue to format parsing. Version 1 accepts exactly two result formats:
    - `CODEX_CLEAN_COMMENT_V1` is an `ISSUE_COMMENT` with null native review
      state, a recognized clean body, and a reviewed-commit prefix. Its
      `SINGLE_OPEN_REQUEST` association must identify a workflow-bound request
      whose full `requested_head_sha` equals the current head, and the marker
      must be a prefix of that same SHA. Only then does
      `CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD` bind the result and allow
      verdict `CLEAN`.
    - `CODEX_FINDINGS_REVIEW_V1` is a formal pull request review whose
      `PULL_REQUEST_REVIEW_COMMIT_ID` binding names the current head and whose
      attached Codex review comments establish verdict `FINDINGS`.
      `FINDINGS` derives `CHANGES_REQUIRED`.
    A reaction alone, another resource kind, missing or conflicting binding,
    stale SHA, unrecognized format, or `UNKNOWN` verdict derives
    `GITHUB_REVIEW_UNKNOWN`. An expected-actor `PENDING` formal review makes
    collection incomplete before this step.
15. Thread collection is complete and its counts are internally consistent.
    A positive `unresolved_count` derives `CHANGES_REQUIRED`; zero may continue.

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
requests and every open source-only baseline request, and resource-scoped
result references, asserting that those old
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
- the positive numeric `codex_actor_id`, exact `codex_actor_type`, and
  `codex_actor_login` returned by a GitHub actor object for the configured
  Codex bot; the type must be exactly `Bot`, while login is audit display only
- `codex_trigger_mode`, exactly `EXPLICIT_ONLY` or
  `AUTOMATIC_QUIESCENCE_ACKNOWLEDGED`; the latter also requires a directly
  supplied non-empty `operator_label` and `rationale`
- one fresh, complete, fully paginated normalized baseline of preexisting exact
  or trigger-shaped requests and actor-admitted candidate results from
  conversation comments, formal reviews, and review comments

The tool requires `LOCAL_GATE_PASSED`, reloads `gate.json`, verifies the local
working tree is clean, and verifies local `HEAD` equals the gate `head_sha`.
It rejects an existing `publication.json` or orphaned
`publication-gate.json`; publication is never reset or rebound in place. An
existing gate-audit pair is accepted only as the exact canonical pre-start
remnant for this review ID: an empty `publication-gate-audit.jsonl` plus a
version 1 head with `committed_bytes: 0`, `next_sequence: 1`, and
`last_event_sha256: null`, with no ledger or gate. If a crash left only the
empty log before the head was created, retry may create that exact empty head.
Any populated, malformed, permission-mismatched, head-only, or otherwise
orphaned audit state is rejected.
It validates the baseline's identity, completeness, pagination, freshness, and
event provenance, stores every exact or trigger-shaped request and
expected-actor candidate result without pairing them, and rejects a baseline
containing an
expected-actor `PENDING` formal review. The tool rejects any actor type other
than `Bot`. For automatic-quiescence mode it records the server
acknowledgement time and requires the fresh baseline observation to immediately
precede that instant for the unchanged local head, with
`acknowledged_at - baseline.observed_at <= 30 seconds`; caller timestamps
cannot backdate the boundary. It stores the validated actor and trigger policy,
then creates revision 1 with status `PR_PENDING`, the pure evaluator's
no-observation result. Baseline requests are not copied into active request
history; their immutable
resource-scoped identities remain open until explicit acknowledgement. The
audit history records a
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
one existed, using `cleared_observation_sha256` and the RFC 8785 digest rule
defined above, or records null when none existed; the next
`record_github_snapshot` call supplies replacement evidence and performs
normal reconciliation. Only a replacement request
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
requirement keys, run IDs unique within each `run_kind`, GitHub object
IDs unique within each review resource kind, binding-field and timestamp-field
provenance, exact source coverage for every independently fetched endpoint,
per-source collection times and pagination proof, per-kind run-source item
counts, required-app identity, strict-policy provenance and base/head
comparison, run ordering and status/conclusion pairs, evidence provenance and
collection metadata, thread counts, latest-run selection, exact request
bodies, resource-kind-scoped event ordering, recognized requests being issue
comments, complete reporting of unbound issue-comment requests and exact
request text in unsupported resource kinds, result actor admission,
foreign-actor partitioning, native review state/resource-kind pairing,
versioned Codex result format, and commit-binding provenance,
endpoint-specific authorization proof for a classic-protection
`NOT_CONFIGURED`, request/result correlation, monotonic recognized and
unbound/unsupported request history, monotonic actor-admitted result history,
latest-request selection, merge fields, and cross-field ordering. An incomplete
but well-formed collection is recorded and derives `EVIDENCE_INCOMPLETE`.

It applies the five-minute age and 30-second future limits to `observed_at` and
every parent and source `collected_at`, rejects a post-start observation,
parent, or source timestamp earlier than the publication `created_at`, and
enforces the two-minute atomic observation interval. GitHub object `event_at`
values may be older and are partitioned by stable baseline identity rather than
wall-clock comparison. The server sets `recorded_at` from its own clock,
derives status, and atomically records the next revision. Server-authored
`updated_at` and the appended history event's `at` both equal that
`recorded_at`.

For a complete Codex-review collection, the server compares and advances
`codex_request_history` against the non-baseline union of `requests`,
`unbound_requests`, and `unsupported_requests`, and compares and advances
`codex_result_history` against non-baseline `results`, in the same locked
mutation before calling the pure state evaluator. The adapter reports baseline
requests and candidate results separately; the server requires exact set
equality with the immutable baseline and rejects any changed, missing, or
additional baseline object, any baseline identity in an active array, and any
non-baseline identity in a baseline array. Exclusion from the active arrays
does not remove a baseline request from source association: every unclosed
baseline request is a source-only candidate for every later result because its
historical head is deliberately unknown. Every recognized request must already
have a
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
cannot replace or truncate history. Only `record_codex_review_request` and
`record_github_snapshot` advance request history; only the latter advances
result history or materializes a newly derived terminal record.

The first observation must be recorded after `start_publication`. The target
and expected Codex actor are immutable after creation; there is no rebinding
operation.

If `publication-gate.json` exists, `record_github_snapshot` removes and
directory-syncs it under the publication lock before replacing the ledger.
This is required even when the new observation is for the same head and still
derives `MERGE_READY`.

## Resource bounds

`publication.json` is stored as one RFC 8785 canonical UTF-8 JSON value followed
by one newline. Its absolute size is 10 MiB, including that newline. A
non-terminal ledger may use at most 10 MiB minus 64 KiB; the reserved 64 KiB is
large enough for the fixed-schema minimal terminal record and its one history
event, as asserted by a boundary test.

Version 1 applies these cheaper first-pass limits before serializing a
prospective ledger:

- one normalized GitHub observation is at most 6 MiB in the same RFC 8785
  encoding used inside `publication.json`;
- the publication-start baseline is at most 2 MiB in that encoding;
- `requirements` has at most 1,000 entries;
- all variable-length evidence arrays in one observation have at most 10,000
  entries in aggregate, including runs, threads, every Codex object array, and
  attached review comments;
- the baseline has at most 5,000 request and candidate-result entries;
- all monotonic ledger arrays have at most 20,000 entries in aggregate,
  counting request history, result history, acknowledgement records, every
  nested acknowledgement reference, and ledger history;
- no individual monotonic array has more than 10,000 entries; a non-terminal
  ledger history has at most 9,999 entries, reserving its 10,000th slot for a
  capacity-terminal history event; and
- acknowledgements number at most 1,000, and each stored acknowledgement has
  at most 1,000 references in aggregate across `closed_requests` and
  `closed_results`. The monotonic aggregate counts each of those stored
  references exactly once.

The 6 MiB observation ceiling leaves at least 4 MiB minus the terminal reserve
for the baseline, target, local-gate identity, and histories in an otherwise
empty ledger. The prospective canonical-file check is nevertheless the binding
constraint as histories grow. Count limits are independent cheap rejection
guards and are not a promise that every maximum can coexist in one file.
Tests exercise each count rejection with a small valid fixture rather than
requiring simultaneous maxima.

`start_publication` validates the caller-supplied baseline and prospective
initial file before creating an audit remnant. Every post-start tool validates
its caller-supplied arrays and byte-bounded objects before gate revocation or
any write. An input-side violation returns non-retryable
`PUBLICATION_LIMIT_EXCEEDED` without changing the ledger, gate, audit, or
terminal state.

After input validation, the server separately projects only mandatory
server-owned monotonic appends for the mutation, with replaceable
`latest_observation` omitted. If that minimal state would exceed the 19,999
non-terminal aggregate-entry allowance, an individual monotonic array's
10,000-entry allowance, the 9,999-entry non-terminal ledger-history allowance,
or the non-terminal file budget, the tool revokes any gate and writes terminal
`INVALIDATED` with reason `server-owned monotonic publication state exceeds
version 1 capacity`. Its history event uses the reserved aggregate entry,
ledger-history slot, and byte space; it is the 20,000th aggregate entry only
when the aggregate-count boundary triggered. This is the only out-of-band
capacity transition. If the monotonic projection fits but the full candidate
with a replaceable observation does not, the tool returns
`PUBLICATION_LIMIT_EXCEEDED` without writing. Before parsing an existing
publication or gate file, the server checks its actual file size against the
10 MiB absolute limit.

### `get_publication`

Returns the ledger without accessing GitHub.

### `acknowledge_codex_review_ambiguity`

Inputs:

- `review_id`
- `expected_revision`
- `head_sha`
- the exact non-empty `request_refs` that the boundary will close; each
  reference names `resource_kind` and `resource_id` and the set includes every
  indeterminate, unbound, unsupported, still-open recovery, and open
  source-only baseline request
- the exact `ambiguous_results`; each result names both `resource_kind` and
  `result_id`. `ambiguous_results` may be empty when a baseline, unbound, or
  unsupported request alone is blocking
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
the direct-human acknowledgement path. It must obtain direct approval for
automatic-quiescence mode rather than inferring it. The skill must include
every open baseline request's exact resource-scoped reference in the closure
set presented for approval.
`scripts/verify-build.mjs` must assert these requirements in the packaged
skill, so losing one fails the build rather than silently changing the
workflow.

The normative sequence is: collect a fresh, complete, fully paginated
preexisting Codex request/result baseline; call `start_publication` with it;
when the baseline contains any request, record a complete snapshot, stop for
direct human approval of the complete resource-scoped baseline closure set,
and acknowledge it before posting. When it contains none, the fresh baseline
is sufficient to continue. Then refresh and verify the head, post one exact
request, immediately call `record_codex_review_request`, and record a complete
snapshot. If later ambiguity or an unbound or unsupported request blocks it,
repeat the direct-human full-closure acknowledgement before posting a recovery
request. After `MERGE_READY`, finalize the gate and call
`verify_publication_gate` immediately before the head-matching merge.

Under the publication lock, the server reloads the current observation,
requires `head_sha` to match the local gate and pull request, independently
replays association, and requires set equality between the supplied references
and the entire request set the boundary would close and the current
indeterminate result set, comparing requests by
`(resource_kind, resource_id)` and results by `(resource_kind, result_id)`. The
request set includes every indeterminate recognized, unbound, unsupported,
recovery, and open source-only baseline request in the current epoch.
The backing observation must satisfy the same five-minute age limit, 30-second
future tolerance, post-publication ordering, and two-minute atomic-collection
window used by finalization. Otherwise the call fails with an instruction to
record a fresh snapshot first.

The acknowledgement closes the entire observed correlation epoch. Every
indeterminate recognized, unbound, unsupported, recovery, and source-only
baseline request in that epoch must be present in the directly approved
`request_refs`. The server stores that exact set once as `closed_requests`; the
input alias `request_refs` is not persisted, and the boundary cannot close an
unapproved request. It likewise stores the exact supplied `ambiguous_results`
set once as `closed_results`; the input alias is not persisted, and the
boundary cannot close an unapproved result. These two stored arrays are the
only nested acknowledgement references counted by the per-acknowledgement and
monotonic aggregate limits.
In a separate ambiguity-recovery scenario, the server-generated record is:

```json
{
  "acknowledgement_id": "ack-...",
  "head_sha": "0123456789abcdef...",
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

The same array also holds a second, server-authored record kind:
`acknowledgement: "SUPERSEDED_BY_LATER_OWN_REQUEST"`. `record_codex_review_request`
appends one, in the same locked transaction as the request it records, naming
the prior requests this ledger can prove from its own durable evidence that it
issued: its `RECOGNIZED` history entries bound `RECORDED_AT_POST`, and
`BASELINE_CORRELATED` baseline requests whose issuance the server re-derived at
start against a prior ledger of the same chain. It never names an `UNBOUND`
request, whose only claim to ownership is a forgeable comment marker, and never
names a request whose reply the ledger has already recorded, whose correlation a
closure would retroactively strip.

An already-recorded reply is recognized in both of the shapes it arrives in. A
result carrying the request's `rbreq` ID names its request exactly, and only
that request is spared. A clean review leaves no inline comment for the marker
to travel in, so its reply carries no ID at all; the durable trace is the
`reviewed_head_sha` the adapter writes when the reply binds, which
`resultHistoryFacts` pins. Such a reply cannot say which request it answered, but the
binding rules bound the candidates exactly: a markerless clean comment binds
only to a request whose head is the one written to `reviewed_head_sha`, and
only to one ordering strictly before it under the same comparator the replay
binds with. A `RECOGNIZED` entry meeting both tests is spared; one failing
either could not have produced the recorded reply. Both tests earn their place.
Sparing a request that could not have answered leaves it open for good and
ambiguates every later markerless reply — the tax this closure exists to end —
and a review carries its own `commit_id` into `reviewed_head_sha` whatever it
binds to, so without the head test a review of an earlier commit would spare
every request at the authorized head. Sparing too little re-derives the reply as
`UNSOLICITED`, drops the pinned `reviewed_head_sha`, and the next snapshot
refuses the ledger as terminally changed. Baseline requests are outside this
rule, because the adapter binds a markerless reply only to a recognized
request.

A baseline holds up to 5,000 requests and a request history up to 10,000, so a
long enough chain can prove more open requests than the 1,000 references one
acknowledgement may close. The closure is therefore split across as many bounded
records as it needs, sharing one `acknowledged_at` and `publication_revision` to
mark them one transaction. Writing it as a single record would exceed the cap
and refuse the mutation after the driver has already posted the request comment
to GitHub, identically on every retry.

Each record closes no results, carries no
`operator_label`, `rationale`, or `backing_observed_at`, and its
`backing_observation_sha256` is `null`: the derivation reads the ledger, not an
observation, and the request it accompanies clears the observation anyway. A
version 1 ledger, which has no request IDs to tell an answered request from an
open one, records no supersession. The distinct enum is what lets an audit
separate this derivation from a human risk decision; both kinds close requests
through the same `closed_requests` array, so replay, adapter closure, and the
epoch fence need no second mechanism.

Like every later ledger mutation, the tool first revokes and directory-syncs
an existing publication gate, then appends the acknowledgement and history
event named `CODEX_REVIEW_AMBIGUITY_ACKNOWLEDGED` and advances the revision.
After acknowledgement, no active request exists until
`record_codex_review_request` admits a new exact
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
`issuance_committed` is true and that its `review_id`,
`publication_revision`, `head_sha`, and status match a current `MERGE_READY`
ledger. It recomputes `expires_at` from the stored observation
timestamps, requires it to match the gate, and requires the server clock to be
no later than that instant. This reapplies every five-minute freshness bound at
verification time rather than treating successful finalization as timeless.
It returns:

```json
{
  "valid": true,
  "status": "MERGE_READY",
  "head_sha": "0123456789abcdef...",
  "publication_revision": 3,
  "expires_at": "2026-07-25T08:09:58.000Z",
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
changes a revision, or otherwise modifies `publication.json`; that file remains
byte-identical on both valid and invalid returns. Before returning either
completed verdict (`valid: true` or `valid: false`), the tool durably appends
and commits a `GATE_VERIFIED` audit event under the same lock. A descriptor or
store-precondition error, including `STORE_MODE_MISMATCH`, short-circuits
before evaluator execution and is not a verification verdict or
`GATE_VERIFIED` event. If the audit log or head itself has mode drift, the tool
returns the same actionable path, actual mode, required mode, and repair
instruction without changing any file; it does not replace that error with an
opaque audit failure. A valid response and head SHA are returned only after the
appended line is file-synced and the audit-head replacement and directory sync
succeed.

### `finalize_publication_gate`

Inputs:

- `review_id`
- `expected_revision`

Under the publication lock, the tool requires the latest purely derived status
to be `MERGE_READY`,
rechecks the local gate file and local repository head, and enforces all of
these freshness rules:

- server `recorded_at` is no more than five minutes old;
- caller `observed_at` is no more than five minutes old and no more than 30
  seconds in the future;
- every parent and source `collected_at` is no more than five minutes old, no
  more than 30 seconds in the future, and still satisfies the two-minute
  atomic observation interval;
- all post-start caller and server timestamps are at or later than the
  publication `created_at`; and
- the revision being finalized is still the latest revision.

It then writes:

```json
{
  "version": 1,
  "review_id": "rb-...",
  "issuance_committed": true,
  "passed_at": "2026-07-25T08:05:01.500Z",
  "repository_id": 123456,
  "pr_number": 5,
  "head_sha": "0123456789abcdef...",
  "local_gate_sha256": "sha256...",
  "publication_revision": 3,
  "github_observation_sha256": "sha256...",
  "github_observed_at": "2026-07-25T08:05:00.000Z",
  "github_oldest_collection_at": "2026-07-25T08:04:58.000Z",
  "github_recorded_at": "2026-07-25T08:05:01.000Z",
  "expires_at": "2026-07-25T08:09:58.000Z",
  "status": "MERGE_READY"
}
```

`passed_at` is the server clock at successful gate issuance; it is not copied
from the observation's `recorded_at`.

Finalization does not modify `publication.json`: it does not change
`revision`, `updated_at`, status, or history. Before its first write,
finalization completes the audit-pair preflight defined below. It then
atomically writes the candidate gate with `issuance_committed: false`, durably
appends and commits a `GATE_FINALIZATION_PASSED` audit event containing the
prospectively computed `gate_sha256` of the final committed payload, and
atomically replaces the gate with that final payload, which is identical
except `issuance_committed: true`. It returns success only after the final
replacement and directory sync. Verification rejects an uncommitted candidate.
Therefore a crash can leave an audit-only issuance attempt or an unusable
candidate gate, but every usable gate has a preceding durable audit record
without consulting the audit log during authorization. The committed gate
names the unchanged ledger revision that was validated. These audit and gate
writes are not later ledger mutations and do not revoke themselves.

Codex must perform a fresh GitHub read immediately before this call. It then
calls `verify_publication_gate` immediately before merging and passes the
returned `head_sha` to an operation that rejects a changed PR head, such as
`gh pr merge --match-head-commit <head_sha>`. The finalize response, a direct
file read, or an earlier verification result is not a reusable merge
credential.

The five-minute bound is an upper limit, not a target delay. A stale or
future-dated top-level observation or nested collection cannot produce
`publication-gate.json`, even if its cached status is `MERGE_READY`.

`github_oldest_collection_at` is the minimum across every parent collection and
every source timestamp, including pull-request comparisons, policy reads, run
feeds, the three Codex feeds, and review threads.
`expires_at` is exactly five minutes after the minimum of
`github_recorded_at`, `github_observed_at`, and every parent and source
`collected_at`. Finalization and verification both recompute it from
`publication.json`; caller input cannot choose or extend it. Finalization
refuses issuance when the server's `passed_at` would be later than that
deadline.

## Gate audit

Every tool that may append an audit event first performs one non-mutating store
preflight under the publication lock. Before evaluator execution, gate
replacement, crash-tail recovery, or temporary cleanup, it opens `gate.json`
and `publication.json`, and opens `publication-gate.json` when present, as
read-only without following symlinks. In the same preflight it opens
`publication-gate-audit.jsonl` read-write with append semantics and opens
`publication-gate-audit-head.json` read-only, both without following symlinks.
It validates regular-file type, mode `0600`, and applicable size limits from
all opened descriptors; validates that matching audit-head temporaries are
regular non-symlink files; and reads enough of the audit head and bounded
suffix to classify the current audit state. An absent `publication-gate.json`
is not a preflight failure: verification evaluates it as an invalid gate, while
finalization may create a new candidate after the preflight succeeds.

The tool retains the validated authorization-file and audit descriptors for
all subsequent reads, recovery, and append in the same lock hold rather than
resolving those paths again. Positional reads and any `ftruncate` use the
retained read-write append-mode log descriptor; appending uses that descriptor
with its append semantics. The audit head is replaced through a fresh
temporary and atomic rename rather than written through its read-only
descriptor. `finalize_publication_gate` therefore cannot write or replace a
candidate gate before every applicable file passes this preflight. A mode
mismatch returns `STORE_MODE_MISMATCH` without changing the existing gate,
audit pair, temporary files, or any other artifact. After a successful
preflight, the tool removes matching regular temporary files regardless of
their mode, performs any permitted tail recovery, and then continues with
finalization or verification.

`start_publication` exclusively creates an empty
`publication-gate-audit.jsonl` with mode `0600`, file-syncs it, then atomically
creates `publication-gate-audit-head.json` through a mode-`0600` temporary file
and syncs the review directory before atomically creating `publication.json`,
all during one publication-lock hold. The initial head has version 1, the review ID,
`committed_bytes: 0`, `next_sequence: 1`, and
`last_event_sha256: null`. A crash before the head write leaves only the exact
empty log; a crash before the ledger write leaves the exact empty pair.
Retrying `start_publication` validates and completes or reuses either remnant.
Because every audit append requires an existing ledger, these empty remnants
cannot contain publication evidence. An existing ledger, gate, populated log
or head, head without a log, malformed audit state, or permission mismatch
fails rather than overwriting evidence.

Every audit-head replacement uses an exclusively created
`publication-gate-audit-head.json.<temp_id>.tmp` sibling, where `temp_id` is
fresh 128-bit lowercase hex. Under the publication lock, start and append
ignore only that exact temporary-file pattern during orphan checks, remove
matching leftovers after the canonical log/head state validates, and reject a
temporary that is a symlink or not a regular file as an unrecoverable local
store error. A matching regular file is never reused and is removed regardless
of its mode; unlink authority comes from the private review directory, so
requiring an operator to change the mode of crash garbage would add no safety.
Other review-directory files are outside the audit-pair state and are not
deleted.

Each log record is the UTF-8 RFC 8785 canonical representation of one event
object followed by exactly one newline. The canonical object is at most
16 KiB before the newline and contains `version: 1`, the owning `review_id`, a
positive contiguous `sequence`, a cryptographically random 128-bit
lowercase-hex `event_id`, and `previous_event_sha256`. The first event has a
null previous digest; every later event stores the SHA-256 digest of the exact
previous canonical event bytes, excluding its newline. The head's
`last_event_sha256` stores the same digest for the last committed event, and
`committed_bytes` ends immediately after that event's newline. Callers cannot
supply sequence numbers, event IDs, timestamps, or chain digests.

Under the publication lock, append reads the small head and only the
bounded suffix needed to validate the last committed record and any bytes
after `committed_bytes`; it never scans or parses the committed prefix. Both
audit paths must be regular non-symlink files with mode `0600`. A permission or
file-type mismatch never permits append: mode drift returns the same actionable
`STORE_MODE_MISMATCH`, while a file-type mismatch, a log shorter than
`committed_bytes`, a last committed record that disagrees with the head, or a
mismatched review ID, sequence, or chain digest is an unrecoverable local store
error. Bytes after
`committed_bytes` can only be one
uncommitted crash-tail record because no second append starts until recovery.
If that suffix is one complete, canonical, newline-terminated event matching
the next sequence and chain digest, recovery commits it by advancing the head.
If it contains no newline and is no larger than the maximum event size, it is
one incomplete crash-tail record; recovery truncates it back to
`committed_bytes` and file-syncs the log before proceeding. Any other suffix,
including an invalid complete line, multiple lines, or one valid line followed
by extra bytes, violates the single-writer invariant and is preserved as an
unrecoverable audit-corruption error rather than silently discarded.

To append, the server writes the complete canonical line through a file
descriptor opened with append semantics, handling partial writes, then
file-syncs the log. It atomically replaces the head with the new byte offset,
next sequence, and event digest through a mode-`0600` temporary file and syncs
the review directory. A current
finalization or verification succeeds only after both durability steps.
Failure before the head replacement leaves an uncommitted tail that the next
operation deterministically adopts, truncates, or rejects under the rules
above; failure after replacement
leaves a committed event even if the caller did not receive the response.
Events in the committed prefix are never deleted, overwritten, or reordered.
Appending is O(1) in event count and has no event-count cliff; the append-only
log can grow for the lifetime of the review, which is an intentional audit
retention trade-off.

`event` is exactly `GATE_FINALIZATION_PASSED` or `GATE_VERIFIED`, and `outcome`
is exactly `SUCCESS` or `FAILURE`; any other value is malformed.
`GATE_FINALIZATION_PASSED` always has `SUCCESS` and a null normalized reason.
`GATE_VERIFIED` has `SUCCESS` and a null reason exactly when verification
returns `valid: true`; otherwise it has `FAILURE` and the same non-null
normalized reason as the completed `valid: false` response. Store-precondition
errors return before either verdict and therefore have no `GATE_VERIFIED`
event. An inability to durably append the current event prevents a valid gate
or merge-authorizing verification response from being returned. The log and
head are not authorization inputs. Offline audit inspection validates the
complete digest chain for reporting; historical corruption is reported as
audit corruption but cannot make an otherwise invalid gate valid.

The following is a logical projection of two consecutive log records. It
records what the server evaluated so a completed or invalidated publication
retains gate history after `publication-gate.json` is revoked:

```json
{
  "version": 1,
  "review_id": "rb-...",
  "events": [
    {
      "version": 1,
      "review_id": "rb-...",
      "sequence": 1,
      "event_id": "11111111111111111111111111111111",
      "previous_event_sha256": null,
      "event": "GATE_FINALIZATION_PASSED",
      "outcome": "SUCCESS",
      "normalized_reason": null,
      "at": "2026-07-25T08:05:01.500Z",
      "publication_revision": 3,
      "head_sha": "0123456789abcdef...",
      "github_observation_sha256": "sha256...",
      "gate_sha256": "sha256...",
      "expires_at": "2026-07-25T08:09:58.000Z"
    },
    {
      "version": 1,
      "review_id": "rb-...",
      "sequence": 2,
      "event_id": "22222222222222222222222222222222",
      "previous_event_sha256": "693f0ac40fb3ebc938367e19079de5f01743f05a30d159554dd15f18eaae4249",
      "event": "GATE_VERIFIED",
      "outcome": "SUCCESS",
      "normalized_reason": null,
      "at": "2026-07-25T08:05:02.000Z",
      "publication_revision": 3,
      "head_sha": "0123456789abcdef...",
      "github_observation_sha256": "sha256...",
      "gate_sha256": "sha256...",
      "expires_at": "2026-07-25T08:09:58.000Z"
    }
  ]
}
```

The corresponding committed audit head is:

```json
{
  "version": 1,
  "review_id": "rb-...",
  "committed_bytes": 849,
  "next_sequence": 3,
  "last_event_sha256": "e085d78e03a76c28ab3d892caf7e895e14a2e1410c90a928fb678743d1ba907d"
}
```

`next_sequence` is always the sequence assigned to the next append, never the
sequence most recently committed.

An invalid verification records `outcome: "FAILURE"`, a normalized non-null
reason, the available identity fields, and null for facts that could not be
validated. A `GATE_VERIFIED` event's `gate_sha256` hashes the exact RFC
8785-normalized gate payload read by verification, even when that parsed gate
fails validation, and is null when no parseable gate could be read. It equals
the finalization digest when both events refer to the same unchanged gate.
`GATE_FINALIZATION_PASSED` is appended between the uncommitted and committed
gate writes described above; its `gate_sha256` hashes the final committed RFC
8785-normalized gate payload. A crash before the final gate replacement
therefore leaves an honest record of an accepted issuance attempt but no usable
gate. The audit log proves workflow history, not GitHub authenticity, and never
revives, extends, or substitutes for a gate.

## Codex result adapter

Observed GitHub Codex behavior has two result shapes: a clean review is an
expected-bot issue comment containing a reviewed-commit marker, while a review
with suggestions is a formal pull request review with attached inline review
comments. Version 1 supports exactly those two versioned formats. Other
conversation comments, formal reviews, review comments, and reactions remain
`UNKNOWN` or pending. Parsing belongs in a small, versioned adapter in the
Codex plugin, not in the generic ledger evaluator.

The adapter independently collects every page of issue comments, formal
reviews, and review comments. Its collection metadata contains exactly one
source entry for each endpoint, with independent completion time, pagination
flag, and page count. The adapter returns:

- every immutable publication-baseline request still present under
  `preexisting_requests` and every baseline candidate result still present
  under `preexisting_candidate_results`; these arrays contain only the exact
  type-specific immutable GitHub fact fields defined in the baseline section,
  never server-assigned classification or reason. Objects are located by their
  stored `(resource_kind, resource_id)` identities, then every immutable fact
  is compared exactly before they are excluded from active arrays. Each
  unacknowledged baseline request remains a source-only association candidate
  for every later result;
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
- every review-trigger-shaped but non-exact issue comment, formal review, or
  review comment under `unsupported_requests`, with reason
  `NON_EXACT_TRIGGER_SHAPE`;
- all candidate Codex results, with GitHub object ID, resource kind, URL,
  stable actor ID and type, active-result audit login, timestamp,
  resource-kind-appropriate native review state, reviewed commit SHA, validated
  commit-binding source and field, structurally attached review-comment
  evidence where applicable (comment ID, actor ID/type, commit SHA, and body
  digest), adapter format, resource-scoped `request_ref`, and association
  method;
- response-shaped objects from any other actor under `foreign_actor_objects`
  for audit only;
- `CLEAN`, `FINDINGS`, or `UNKNOWN` for each candidate result; and
- a SHA-256 digest of each original response body.

All request, result, baseline, and foreign-actor partitions are disjoint by
`(resource_kind, resource_id)`. An object matching more than one role makes the
Codex collection malformed instead of allowing caller-chosen precedence.

An object absent from the immutable baseline cannot be reported under either
preexisting array, even when its GitHub timestamp predates publication
creation. On every complete collection, both arrays must exactly reproduce the
server's type-specific projection of the stored baseline's immutable GitHub
facts; caller-supplied classification or reason fields are rejected. A missing,
edited, reclassified, or
provenance-changed baseline object terminally invalidates the ledger; a new
object enters an active array and cannot be grandfathered by timestamp. This
prevents old identities from being reclassified on every snapshot without
allowing mutation or deletion to erase the evidence that justified the
operator's acknowledgement.

Each `unbound_requests` and `unsupported_requests` entry carries `resource_id`,
`resource_kind`, URL, `event_at`, `timestamp_field`, and `body_sha256`.
Unbound entries additionally carry the fixed reason above. Unsupported entries
carry exactly `WRONG_RESOURCE_KIND` or `NON_EXACT_TRIGGER_SHAPE`. An unbound
request participates only as an indeterminate request that widens or preserves
ambiguity; it can never satisfy review. An unsupported request is not
correlated with a result. Either blocks after publication starts, and neither
is converted into a recognized request.

Request classification applies only to objects the expected Codex actor did not
author. A review request originates on the author side, so an object the
expected actor wrote is never one whatever its body quotes. The GitHub Codex
App's own review-summary comment quotes the trigger phrase while documenting
itself, and classifying that comment as an unsupported request blocked every
gate in a repository the App reviews. An expected-actor object is evaluated as
a response instead, and an unrecognized response shape remains fail-closed as
`UNKNOWN` rather than being ignored, unless it carries a known App marker.

An expected-actor object that is not verdict-shaped and carries a marker the
Codex App uses to identify its own notices — today the review-summary marker
and the environment notice — is reported under `app_notices` with that marker
rather than as an unrecognized result. Each entry carries `resource_id`,
`resource_kind`, URL, `event_at`, `timestamp_field`, the body, `body_sha256`,
the pinned actor, and the matched marker; it is audit-only and never blocks a
gate. The body is carried because the claim is what makes the entry
non-blocking: the ledger recomputes the digest and rederives the marker from
that body, so an observation cannot move an unrecognized response out of the
fail-closed result path by asserting a marker its body never carried. This
carve-out is bounded by two further rules. Verdict recognition runs first, so a
marker-carrying object that matches a verdict format is that verdict. And an
unrecognized shape without a known marker keeps failing closed, which is what
keeps a real verdict in a new format from being silently dropped. The App
posts and updates such a notice on every review, so without the carve-out
every round of every publication needs an operator ambiguity acknowledgement.

The same marker rule applies at baseline capture. The App edits a notice in
place on every later review round, and a baseline object's stored facts —
`body_sha256` among them — must be reproduced exactly by every later snapshot,
so a baselined notice is a ledger the App's next round terminally invalidates.
A known App notice therefore never enters the baseline: the baseline-mode
adapter skips exactly the objects the snapshot mode reports under
`app_notices`, and every snapshot keeps reporting the live object there.
The exclusion cannot widen admission, because `app_notices` entries take part
in no association: nothing is credited to them and they credit nothing.

The exact request body is byte-for-byte UTF-8 string equality with
`@codex review`; leading or trailing whitespace, additional instructions, a
different case, or another line is not the workflow request. To avoid silently
missing an out-of-band trigger, the adapter conservatively treats any other
body containing an ASCII-case-insensitive command-shaped
`@codex` + whitespace + `review` word sequence as unsupported. False positives
must be closed through the same direct-human acknowledgement path; the adapter
never upgrades them into recognized requests. Each body digest is SHA-256 over
the decoded GitHub `body` string re-encoded as UTF-8, without whitespace,
Unicode, or line-ending normalization; it is not a digest of the JSON
response's escaped wire representation.

Any unrecognized response format returns `UNKNOWN`. An eyes or thumbs-up
reaction without a supported result object is still pending because reactions
are transient and carry neither the reviewed commit nor the adapter result
format.

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

A `CODEX_FINDINGS_REVIEW_V1` formal review binds to its reviewed commit through
the review object's GitHub-native `commit_id`. Its only accepted source/field
pair is `PULL_REQUEST_REVIEW_COMMIT_ID`/`commit_id`. The adapter requires the
recognized Codex findings-review body shape and at least one attached review
comment whose `pull_request_review_id` names that same formal review, whose
actor ID/type matches the expected bot, and whose `commit_id` matches the
formal review. Each attachment has a positive safe-integer ID and body digest;
duplicate IDs are rejected. The result records the complete set of
expected-actor comments attached to that review from the fully paginated
review-comment feed, sorted by comment ID; a caller cannot submit only a
favorable subset. Comments from other actors remain represented by the thread
collection but do not become Codex result evidence. The adapter then returns
`FINDINGS`. A generic formal review without that structural evidence is
`UNKNOWN`.

A `CODEX_CLEAN_COMMENT_V1` issue comment is accepted only after actor admission
and only when all of these predicates hold:

- its body begins with the recognized Codex clean sentence and contains exactly
  one fixed `**Reviewed commit:**` Markdown field whose code value is 10 to 40
  lowercase hexadecimal characters;
- association independently produces `SINGLE_OPEN_REQUEST` for one
  `RECORDED_AT_POST` request;
- that request's full `requested_head_sha` equals the immutable local-gate and
  current pull-request head; and
- the marker is a prefix of that same full SHA.

The result then records the full request-bound SHA and
`CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD` with the exact marker prefix.
The body marker is an expected-bot provider assertion and a cross-check, not
free-form request linkage: it cannot create an association, bind an unbound
request, or override a mismatching head. Any other conversation comment,
arbitrary SHA mention, linked review, copied current pull-request head, or
review comment has null `reviewed_head_sha` and `commit_binding` and returns
`UNKNOWN`.

Every `PULL_REQUEST_REVIEW` result records GitHub's native `state` as
`native_review_state`, exactly one of `APPROVED`, `CHANGES_REQUESTED`,
`COMMENTED`, or `DISMISSED`. Conversation and review-comment results record
null. GitHub omits `submitted_at` from `PENDING` reviews, so they cannot be
normalized as candidate results; observing one from the expected actor makes
the Codex-review collection incomplete until it is submitted or deleted.
Missing, null, or unrecognized state on a submitted formal review, and non-null
state on another resource kind, is malformed evidence. A `DISMISSED` formal
review derives `GITHUB_REVIEW_UNKNOWN` and can never satisfy a request. A
current `CHANGES_REQUESTED` state derives `CHANGES_REQUIRED` regardless of a
body parser disagreement; only `APPROVED` or `COMMENTED` may continue to the
parsed verdict. Because dismissal mutates the same review object rather than
creating a new result ID, any state change after that result enters
`codex_result_history` is a monotonic-history conflict and persists terminal
`INVALIDATED`.

After actor admission, the adapter processes active recognized requests,
unbound requests, open baseline requests, and active candidate results by
`event_at`. A formal review begins with its native full `commit_id`. A clean
issue comment begins only with its validated commit prefix and may obtain a
full `reviewed_head_sha` only from one uniquely associated active recognized
request. The adapter never expands the prefix from the currently observed pull
request head. Because baseline and unbound requests have no trusted historical
head, every open one is conservatively eligible for every later result. Their
presence prevents a result from establishing a unique active association until
a human acknowledgement closes them. GitHub object IDs break timestamp ties
only when both events have the same `resource_kind` and therefore share an ID
namespace. An equal-timestamp tie across issue comments, pull request reviews,
or review comments has no total order; if it can affect request/result
association, the result is `AMBIGUOUS` and derivation returns
`GITHUB_REVIEW_UNKNOWN` unless a future structural ordering signal exists.
The accepted resource-kind values are the three enums defined in the schema;
the adapter rejects any other value.
Version 1 accepts only these association values:

- a result created before any exact request in the current correlation epoch
  and with no open baseline or unbound request uses
  `association: "UNSOLICITED"` with a null `request_ref`; it is retained for
  audit but never opens, closes, or satisfies a request;
- a result that can answer exactly one open baseline request and no active or
  unbound request uses `association: "BASELINE_LATE_RESULT"` and records that
  baseline request's resource-scoped `request_ref`; it is audit evidence that
  does not close the baseline source or satisfy the new ledger;
- a result uses `association: "SINGLE_OPEN_REQUEST"` only when exactly one
  unmatched prior recognized request exists for that head and no unbound
  or baseline request exists in the open epoch, and records that issue
  comment's resource-scoped `request_ref`;
- when more than one recognized or baseline request could own the result, or
  any unbound request exists, the adapter returns
  `association: "AMBIGUOUS"` and a null `request_ref`; and
- after at least one active request existed in the current epoch but none
  remains open, a later result is also `AMBIGUOUS` and makes every previously
  closed recognized request whose head matches its full commit or clean marker
  prefix indeterminate; a result with no usable binding includes every closed
  request in the epoch.

A correlated result closes its request. An ambiguous result marks every
currently unmatched recognized request for that head and every open unbound
or baseline request in the epoch indeterminate, but does not close or discard
the set. A `BASELINE_LATE_RESULT` does not close its source-only
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
`BASELINE_LATE_RESULT` evidence. Neither can correlate to a later active
request; the baseline request still requires the same explicit acknowledgement
it required before the result arrived. A later result after an active request
closed is not harmless: it reopens the epoch's possible request sources as an
indeterminate set and blocks until direct acknowledgement.

The evaluator independently replays this algorithm, validates each
association from the reconciled request and result histories, and then selects
the latest request; it never reconstructs a pairing from "created after latest
request" alone. The adapter must return the complete current result collection,
and the server rejects disappearance or mutation of an already recorded
result's immutable GitHub facts instead of letting a later snapshot forget it.
The ledger pins adapter version 1, so an adapter semantic change requires a new
publication ledger.
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
`publication.json`, `publication-gate.json`, and
both `publication-gate-audit` files use the publication lock. Publication
never starts before the local review becomes terminal, so
there is no need to serialize both domains behind one lock.

Atomic rename prevents corrupt JSON but does not prevent lost updates. Each
lock record therefore contains:

- a cryptographically random 128-bit owner token;
- owner PID and process start time;
- acquisition and heartbeat timestamps; and
- the lock domain and review ID.

One helper process holds a persistent sibling `.<domain>-state.lock.guard` file
through `lockf -k` on macOS or `flock` on Linux for the full lifetime of each
state lock. Acquisition, heartbeat, and release commands travel over that
helper's standard input and output; owner tokens never travel in process
arguments. Both platform invocations preserve one guard inode across holders,
and the operating system releases its advisory lock automatically if the helper
exits. This makes stale-record replacement a single coordinated operation
rather than a check-then-unlink race between contenders, without starting a new
process for every transition.

Each platform lock wrapper and its Node helper run in a dedicated process
group. A command that does not answer within five seconds gets one event-loop
poll phase to deliver a response that became ready while synchronous repository
work blocked the parent. If it is still unanswered, the parent terminates that
entire process group before performing token-checked cleanup under a new guard
holder. The `/bin/ps` probes used for process identity have their own two-second
limit, so neither a helper command nor its liveness probe can wait forever.

The holder refreshes a heartbeat every five seconds with atomic replacement and
releases in a `finally` block only after rereading the lock under the guard and
matching its owner token. Acquisition waits at most ten seconds. A contender
may reclaim a lock only when its heartbeat is older than 30 seconds and the
operating-system probe confirms that no process with both the recorded PID and
process start time is alive. PID liveness alone is insufficient because PIDs
can be reused. The process start rendering uses `/bin/ps` with `LC_ALL=C` and
`TZ=UTC` and carries a format version in the record, so independently launched
desktop and terminal processes compare the same identity. An inconclusive
identity probe fails closed with an actionable, non-retryable error and never
steals the lock. A malformed or wrong-mode lock also fails immediately with its
path; normal acquisition and heartbeat writes cannot create a partial record
because they use durable atomic replacement.

If the final token-checked release attempt fails, the mutation returns
non-retryable `LOCK_CLEANUP_FAILED` instead of reporting success. The error
names the lock path, sets `state_may_have_changed`, and requires the operator to
stop the owning Review Bridge process before inspecting or removing the record.

If the helper exits while its parent is still operating, the canonical record
continues to identify that live parent. Even after the heartbeat becomes stale,
contenders therefore remain busy rather than admitting a second owner. The
parent reacquires the guard for token-checked cleanup; if the parent itself
exits, stale-owner recovery becomes possible only after the same conclusive
identity check. Helper loss can reduce availability, but cannot silently create
concurrent cooperating owners.

A missing, foreign, malformed, or otherwise untrustworthy owner record is
different from helper loss: it proves that the parent can no longer verify the
record it wrote. The release path surfaces that condition to the MCP caller as
`LOCK_OWNERSHIP_LOST` after token-safe cleanup instead of returning a successful
mutation result. It sets `details.state_may_have_changed` because the protected
write may already be on disk and instructs the caller to reread state before
deciding whether to retry. Lock errors retain their structured code and
`details.retryable` value at the tool boundary.

An unexpected acquisition failure also attempts token-checked cleanup unless
its error conclusively occurred before this owner could write a record. This
covers post-rename durability failures without removing a foreign owner's
record.

If atomic replacement renames the new canonical file but the following parent
directory sync fails, the mutation returns non-retryable
`STORE_WRITE_INDETERMINATE` with `state_may_have_changed`. The caller must
reread the relevant state before deciding whether to retry; in particular,
`prepare_review` must not blindly create a second review task.

An acquisition timeout returns a documented retryable `REVIEW_BUSY` or
`PUBLICATION_BUSY` error without changing state. Adding `REVIEW_BUSY` to
existing reviewer mutations is an intentional client-visible behavior change,
although it does not change tool inputs, successful outputs, or review-state
transitions.

Publication revision checks remain necessary even with a lock because callers
can operate from stale reads.

## Failure and recovery

- Missing or malformed evidence never advances the state.
- Caller input above a version 1 count or byte limit returns
  `PUBLICATION_LIMIT_EXCEEDED` without changing any publication artifact.
  Replaceable evidence that cannot fit the prospective file is handled the same
  way. Only a validated mutation whose mandatory server-owned monotonic
  projection no longer fits revokes the gate and records the out-of-band
  capacity `INVALIDATED`; the reserved entry and byte space keep that
  fail-closed write within the absolute limits.
- `STORE_MODE_MISMATCH` changes no state and identifies the exact `chmod 0600`
  repair before retry. Symlink, non-regular-file, and oversize store errors
  remain unrecoverable.
- `start_publication` durably creates the empty gate-audit log and head before
  the ledger. A crash between those writes leaves one of the exact empty
  pre-start remnants that a retry for the same review validates and completes
  or reuses; no populated or malformed audit is ever overwritten.
- A GitHub read failure leaves the previous revision unchanged when the
  workflow does not submit a snapshot; a deliberately submitted well-formed
  incomplete collection advances the revision and derives
  `EVIDENCE_INCOMPLETE`.
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
- A mismatch among the normalized current base and either independently fetched
  live branch-tip source, or a non-increasing pair of branch-source collection
  times, derives `EVIDENCE_INCOMPLETE`; no comparison may use or fall back to
  the audit-only PR-reported value.
- A later observation cannot clear `INVALIDATED`, `CLOSED`, or `MERGED`.
- Once any terminal record exists, every state-changing publication call fails
  with `PUBLICATION_TERMINAL` before revoking or writing anything; only reads
  and a necessarily invalid gate verification remain available.
- An incomplete or stale publication-start Codex baseline prevents revision 1
  from being created. All preexisting requests and candidate results remain
  outside active history and cannot satisfy the new ledger. Every baseline
  request remains an open source candidate and blocks until explicit
  acknowledgement; missing or changed baseline objects terminally invalidate
  the ledger.
- An incomplete pull-request collection derives `EVIDENCE_INCOMPLETE` before
  identity comparison and cannot write a sticky terminal state.
- An incomplete check, request, result, or thread collection derives
  `EVIDENCE_INCOMPLETE`; an empty list alone never proves absence.
- A complete feed of one kind cannot cover the other. Once a run collection
  claims `COMPLETE`, three conditions are rejected as invalid input rather than
  derived: an unproven `pagination_complete`, a feed reporting more than one
  page, and an item-count or check-run reported-total mismatch. The only route
  to `EVIDENCE_INCOMPLETE` for these feeds is the collection not claiming
  completeness in the first place, which the bullet above already covers.
- A stale or future-dated top-level observation, parent collection, or
  independent source cannot be finalized.
- A finalized gate expires at the earliest underlying five-minute evidence
  deadline. `verify_publication_gate` returns `EVIDENCE_STALE` after that
  instant even when the ledger revision and head are unchanged.
- A crash before committed issuance can leave an uncommitted candidate gate or
  an audit-only `GATE_FINALIZATION_PASSED` event; verification rejects the
  candidate. Audit-line or head sync failure prevents a committed gate or
  valid verification response, while prior audit events remain durable and
  authorization never depends on replaying them.
- A crash during audit append leaves at most one suffix after the head's
  `committed_bytes`. The next locked operation adopts one complete valid next
  record or truncates one bounded incomplete record with no newline. A
  complete-invalid, multi-record, or valid-plus-extra suffix, truncation below
  the committed offset, or a committed-tail digest mismatch is an
  unrecoverable store error and is preserved for diagnosis.
- A previously observed exact request that is changed or deleted persists
  terminal `INVALIDATED`; an older `CLEAN` can never become latest again.
- A previously observed actor-admitted Codex result that disappears or changes
  its body, resource-kind-appropriate native review state, commit provenance,
  or attached review-comment evidence persists terminal `INVALIDATED`.
  Dismissing a previously recorded formal review therefore cannot leave its old
  verdict eligible. Deleting an ambiguous comment or review cannot erase it
  from correlation history or restore an older `CLEAN`. A changed adapter
  version is rejected rather than re-parsing the stored body under different
  semantics.
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
  `UNSOLICITED`; one uniquely attributable to one open baseline request
  is `BASELINE_LATE_RESULT`. Both remain audit evidence and cannot poison or
  satisfy a later exact request. A result arriving after a request has closed
  and before another opens instead makes the possible closed request sources
  indeterminate and blocks.
- An issue-comment result can satisfy only the exact
  `CODEX_CLEAN_COMMENT_V1` actor, format, association, bound-request head, and
  reviewed-commit-prefix predicates. Any other comment-only result is
  `UNKNOWN`; copying the pull request head or using an arbitrary SHA mention is
  forbidden.
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
  to `GITHUB_REVIEW_UNKNOWN`; supporting the new shape requires a versioned
  adapter update and a new publication ledger.
- Version 1 cannot satisfy an App-pinned required check using only a legacy
  commit status because GitHub's status response does not expose the producing
  App ID. Such repositories must emit a check run from the pinned App or remain
  `CHECKS_PENDING`.
- A connector that cannot expose authenticated GitHub App installation
  permissions cannot classify a classic-protection `404` on a protected branch
  as not configured; it remains fail-closed as `UNKNOWN`.
- The reviewed-base ancestry rule accepts a live target base that moved
  forward from the locally reviewed base. When strict required-check updates
  are disabled, the eventual base-to-head diff and merged tree may therefore
  include base commits that Claude did not review. This matches GitHub's
  non-strict update policy; repositories requiring an exact reviewed-base diff
  must enable strict required-status-check updates or start a new local review
  after every base movement.
- The per-review gate-audit log intentionally retains every committed event and
  can grow without a fixed count limit. Appends remain O(1), but long-lived
  automation that verifies repeatedly consumes disk until the review store is
  archived or removed under the existing local-store lifecycle.
- Version 1 rejects very large pull requests or long publication histories
  that exceed the explicit evidence, aggregate-entry, or 10 MiB ledger limits.
  Caller-input and replaceable-observation overflow is non-mutating, but cannot
  progress until the GitHub evidence fits or the operator chooses a manual
  merge path. Exhausted server-owned monotonic capacity is terminal; shrinking
  current collections does not erase that history and requires a new bounded
  task or a manual merge decision.
- Version 1 depends on two provider-specific response shapes: a recognized
  clean issue comment and a findings review with attached inline comments. A
  connector that changes either body shape moves that result to
  `GITHUB_REVIEW_UNKNOWN` until its versioned adapter and fixture are updated;
  review-comment-only output remains unsupported.
- A clean comment's reviewed-commit marker is a provider assertion checked
  against the uniquely associated workflow-bound full head, not a
  GitHub-native commit field. Stable bot identity, exact format, monotonic body
  history, and the bound request constrain it, but stronger authenticity would
  require a provider-signed or GitHub-native full commit binding.
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
- When automatic Codex review is enabled, GitHub exposes no pending-job or
  trigger identity that the ledger can verify. Automatic-quiescence mode
  therefore depends on a direct human assertion and retains the disclosed risk
  of a late automatic result being attributed to an explicit request.
- Starting a new ledger on an existing pull request requires a complete
  preexisting Codex baseline and explicit acknowledgement of every old exact
  request before a new one is posted. This trades an extra full pagination pass
  and a one-time human decision for avoiding both historical head inference and
  misattribution of delayed duplicate results.
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
  correlation to forget a prior ambiguity. An adapter semantic change requires
  a new publication ledger.
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

- Required-check keys are exact `(context, app_binding, required_app_id)`
  tuples from the union of active applicable rules and classic branch
  protection. Identical tuples coalesce their provenance; differing tuples
  remain independently required. Ambiguous access, discovery, or producer
  identity results fail closed.
- A classic-protection `404` is `NOT_CONFIGURED` only with endpoint-specific
  GitHub App installation permission evidence; successful branch or rules
  reads are not authorization proof when `branch.protected` is true. A
  successful `protected: false` branch read plus empty applicable rules is the
  only no-query shortcut.
- App bindings are explicitly `PINNED` or `EXPLICITLY_UNBOUND` and must cite an
  identity-capable response field and raw representation. Classic
  `app_id: null` or `-1` and ruleset null or absent `integration_id` normalize
  to unbound; missing keys, zero, other negatives, and legacy context-only
  policy reads are incomplete evidence.
- Only `CHECK_RUN.app.id` proves run producer identity in version 1. Commit
  statuses record unavailable App identity, are never enriched from `creator`,
  and cannot satisfy a pinned producer predicate.
- Only the latest attempt within each present `run_kind` can satisfy that
  kind's side of a requirement. `SUCCESS`, `SKIPPED`, and `NEUTRAL` pass to
  match GitHub; blocking, stale, pending, and unknown outcomes fail closed as
  specified above.
- Check runs and commit statuses are separate ID namespaces and independently
  required when both report the same required context. Cross-kind timestamps
  and IDs are never compared.
- Check-run and commit-status feeds carry separate endpoint, collection-time,
  pagination, page-count, and item-count proof. Both must be complete before
  latest-attempt selection, including when one feed is empty.
- Required-check `policy` is a closed three-value domain. `REQUIRED` has at
  least one requirement; `STRICT_ONLY` has none but still requires the strict
  base comparison; `NONE_CONFIGURED` has none and is non-strict. No empty list
  can pass by vacuous `REQUIRED` evaluation.
- Every independent GitHub endpoint or GraphQL connection carries its own
  source status, response-completion time, and pagination proof where
  applicable. Parent collection times cannot refresh stale pull-request,
  comparison, policy, run, Codex, or thread sources.
- Strict-update policy is the union of every applicable policy source. A strict
  head must contain the current base or derive `PR_UPDATE_REQUIRED`; a missing
  strict field makes its policy source and collection unknown rather than
  defaulting to false.
- The authoritative current base SHA comes from the live branch read. The PR
  object's reported base SHA is audit-only. The normalized base and both
  retained values from mandatory independent branch fetches must match before
  either comparison is evaluated; the pull-request source time must be strictly
  earlier than the policy source time so a cached response cannot back both.
- The current target base must independently descend from or equal the local
  gate's reviewed base. This identity invariant applies regardless of
  strict-update policy; a behind or diverged target base is terminal
  `INVALIDATED`.
- Pull-request identity, head, and reviewed-base ancestry evidence participate
  in the same collection freshness and atomic-observation window as checks,
  reviews, and threads.
- Every unresolved review thread blocks publication, regardless of author.
- Codex result evidence stores a digest and GitHub URL, not the response body.
- The expected Codex bot is bound by stable numeric actor ID and `Bot` type at
  publication start; the caller supplies both values from the GitHub actor
  object and the server rejects another type. Login text is audit metadata
  only. Foreign-actor objects are separated before parsing or association.
- The trigger policy is immutable. Explicit-only mode asserts automatic review
  is disabled; automatic-quiescence mode records direct human approval bound to
  the current head and a baseline no more than 30 seconds older than the
  server acknowledgement.
- Every Codex result is correlated by the single-open-request rule; overlapping
  requests are ambiguous, and free-form text never supplies request linkage.
- Every source-only baseline request, and any unbound or unsupported request,
  remains blocking until a human acknowledges the exact resource-scoped
  requests and indeterminate results the boundary will close, and asserts that
  the requests will not receive further replies. The acknowledgement is
  revisioned, revokes any gate, and starts a new correlation epoch.
- Automatic results before the epoch's first exact request are `UNSOLICITED`
  only when no baseline source is eligible; a unique baseline source produces
  `BASELINE_LATE_RESULT`. Neither creates an additional request to close;
  every open baseline request already requires acknowledgement.
- A result observed after the last active request closed and before another
  request opens is ambiguous and reopens every possible closed request source
  for direct acknowledgement; a later finding can never be ignored behind an
  earlier clean result.
- A findings review uses its GitHub-native `commit_id`. A recognized clean
  issue comment may establish `reviewed_head_sha` only by combining its single
  reviewed-commit prefix with one uniquely associated workflow-bound full
  request head; arbitrary comments, copied heads, and review comments remain
  `UNKNOWN`.
- A formal review's native `state` is a monotonic-reconciled result fact.
  `DISMISSED` never satisfies, and `PENDING` cannot be normalized as a result
  and makes collection incomplete. A later dismissal of an observed result
  terminally invalidates the ledger instead of preserving its old body verdict.
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
  result that disappears or changes immutable body, commit, native-state, or
  attached-comment facts terminally invalidates the ledger instead of clearing
  ambiguity. Adapter semantics are pinned for the ledger's lifetime.
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
- Gate issuance and every completed verification verdict append to the durable
  server-owned gate-audit log. A small atomic head commits the file prefix, so
  append work is O(1), a crash tail is recoverable, and an audit append failure
  cannot yield a usable gate or merge-authorizing verification response.
  Store-precondition errors occur before a verdict and do not append. Audit
  events are never used as authorization evidence.
- Publication evidence and monotonic histories have explicit count and byte
  limits in the same canonical encoding used on disk. Caller and replaceable
  input overflow is non-mutating; only exhaustion by validated mandatory
  monotonic state uses the reserved capacity terminal.
- Ledger-history and gate-audit event names are separate closed domains.
  Observation digests always name their exact normalized observation subtree,
  including the server-authored `recorded_at`, so copied digests retain one
  meaning across ledger, acknowledgement, gate, and audit records.
- Lock acquisition waits ten seconds; a lock is only eligible for reclamation
  after a 30-second heartbeat timeout and a conclusive owner-identity check.
- A closed, unmerged pull request terminates the ledger and requires a new local
  review before publication can restart.
- Every state-changing publication tool rejects a terminal ledger before
  touching any publication file.
- Revision 1 has status `PR_PENDING`, the evaluator's single no-observation
  result; `PUBLICATION_STARTED` is only its ledger-history event name.
- A fresh, complete publication-start baseline keeps all preexisting requests
  and expected-actor candidate results outside active history and satisfaction.
  Every baseline request remains a source-only candidate for all later results
  and blocks until directly acknowledged; no historical head or pairing is
  inferred.
- Correlation epochs are ordered by server-assigned request
  `recorded_revision` relative to the acknowledgement's
  `publication_revision`, never by comparing GitHub `created_at` with the
  server clock.

## Test plan

The implementation must test:

- the successful path from local gate to `MERGE_READY`;
- `start_publication` creating revision 1 with status `PR_PENDING` and a
  `PUBLICATION_STARTED` ledger-history event, including rejection of stale,
  incomplete, or partially paginated baselines; recovery from an exact empty
  pre-start audit log or log-and-head remnant; and rejection of existing
  publication or gate files and populated, malformed, head-only, or
  permission-mismatched audit state;
- explicit-only and automatic-quiescence trigger policies, including rejection
  of an unknown mode, missing direct-human label or rationale, a changed head,
  and a baseline more than 30 seconds older than the server acknowledgement;
- a new local task on an existing pull request whose prior requests and
  expected-actor candidate results all remain audit-only baseline objects,
  with every baseline request blocking until its complete resource-scoped set is
  directly acknowledged, plus non-empty adapter replay that exactly matches the
  server's type-specific immutable-fact projection while rejecting caller
  classification fields;
- one delayed result arriving while exactly one baseline request remains open
  becoming `BASELINE_LATE_RESULT` without closing that request, followed by
  acknowledgement, a new workflow request, and an old delayed duplicate that
  demonstrates the explicitly accepted residual misattribution risk;
- `record_codex_review_request` after an existing snapshot and after ambiguity
  acknowledgement, each revoking any gate, clearing only
  `latest_observation`, preserving baseline and both histories, recording the
  RFC 8785 cleared-observation digest or explicit null on its history event,
  and returning `PR_PENDING` until a replacement snapshot is recorded;
- a pull request head changed before and after Codex review;
- an incomplete policy query, ambiguous `404`, every invalid
  policy/strict/requirements combination (including `REQUIRED` with no
  requirements), `STRICT_ONLY` with empty requirements and both passing and
  failing strict base comparisons, `NONE_CONFIGURED` with zero and nonzero
  optional runs, empty incomplete collections, incomplete pagination, and
  count mismatches;
- missing, failed, stale, future-dated, and partially paginated independent
  sources for pull-request identity, both comparisons, every policy endpoint,
  both run feeds, each of the three Codex feeds, and review threads; a fresh
  parent timestamp paired with any stale source must remain incomplete;
- independently missing, partial, stale, and empty-complete check-run and
  commit-status feeds, per-kind item-count and reported-total mismatches, and a
  check-run query using the default latest-only filter instead of `filter=all`;
- a classic-protection `404` after successful branch/rules reads but without
  endpoint-specific authorization proof, plus GitHub App installation
  `administration` grants of missing, `read`, and `write`, and missing, stale,
  or future-dated installation-permission policy-source metadata;
- the `branch.protected: false` plus empty-rules shortcut omitting the classic
  endpoint, and rejection of that omission when the branch is protected or
  applicable rules are nonempty;
- required checks from a different head or with pending, failed, cancelled, or
  missing results;
- a required check produced by the wrong GitHub App, an explicitly unbound
  requirement, a check run with missing app identity, a commit status with an
  invented App mapping, classic `app_id` values of positive, `-1`, null, zero,
  another negative value, and a missing key, proving null and `-1` are
  explicitly unbound while the latter three are unknown; ruleset
  `integration_id` values of positive, null, absent, zero, and negative, and a
  legacy `contexts[]` policy read;
- identical required-check tuples from multiple sources coalescing all
  provenance, plus same-context tuples with different bindings or App IDs
  remaining independently required;
- a pinned requirement with only a passing commit status remaining
  `CHECKS_PENDING`, plus a pinned matching check run accompanied by passing,
  pending, and failing same-context commit statuses, and an explicitly unbound
  requirement satisfied by a commit status with unavailable App identity;
- a failed rerun after success, a successful rerun after failure, a pending
  rerun after success, a pending commit status with null `completed_at`,
  terminal commit statuses using `updated_at`, and runs with missing or
  ambiguous ordering;
- same-name check runs and commit statuses in every pass/fail/pending
  combination, proving each present kind is evaluated independently and
  cross-kind timestamps never suppress one side, plus same-kind timestamp ties
  ordered by `run_id`;
- classic and ruleset strict-update flags in every true/false combination, a
  missing strict field making the owning policy source and collection unknown
  rather than false, and strict heads that are `AHEAD`, `IDENTICAL`,
  `BEHIND`, `DIVERGED`, or have incomplete comparison evidence;
- reviewed-base ancestry with a current base that is `AHEAD` or `IDENTICAL`,
  plus `BEHIND`, `DIVERGED`, and incomplete comparisons when strict updates
  are false and when no checks are configured, proving only the first two can
  reach `MERGE_READY` and that restoring an invalidated base cannot revive the
  ledger; a mismatch between either retained live branch-tip source and the
  normalized base SHA, or non-increasing collection times proving response
  reuse or invalid ordering, must derive `EVIDENCE_INCOMPLETE` before
  comparison, while a differing audit-only PR-reported base SHA has no effect;
- `SKIPPED`, `NEUTRAL`, `TIMED_OUT`, `ACTION_REQUIRED`, `STALE`, and an
  unrecognized future check conclusion;
- a missing request, trigger-shaped non-exact requests with whitespace,
  different case, extra text, and extra lines all becoming unsupported,
  duplicate requests, and a newer request that supersedes an older `CLEAN`
  result;
- immediate post-response request binding, restart after binding, a crash
  between posting and binding, a changed head before binding, a manual exact
  issue-comment request from a non-workflow actor recorded as `UNBOUND`, and
  direct-human acknowledgement recovery without inferring its head;
- baseline partition validation that rejects an active baseline identity, a
  non-baseline identity smuggled into either preexisting array, a missing or
  changed baseline object, and a newly seen request with an old `event_at` that
  must still become unbound or unsupported;
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
- a second result after one request closes and before another opens, proving
  the closed request and new result become an acknowledgeable indeterminate
  set and an earlier clean result cannot remain eligible;
- a recovery request admitted before acknowledgement, with every subsequent
  result remaining ambiguous and the early recovery request reported as
  closed only when its ID is included in the directly approved and supplied
  closure set; omission of any open recovery request fails acknowledgement;
  exact-set acknowledgement followed by a request admitted in a later
  revision; a
  delayed old result after acknowledgement as an explicitly accepted risk; and
  a later ambiguity requiring another acknowledgement;
- zero and multiple candidate results after the latest request;
- an ambiguous result that is later body-edited, dismissed, deleted, or
  reported with conflicting actor/commit provenance, each persisting terminal
  `INVALIDATED` so a remaining older `CLEAN` cannot regain eligibility;
  missing, mixed, or unsupported adapter versions; and incomplete result
  collection leaving result history unchanged;
- eyes and thumbs-up reactions without a supported Codex result object;
- a result created before its request;
- a `CODEX_CLEAN_COMMENT_V1` issue comment with exactly one valid commit marker,
  expected Bot actor, unique workflow-bound request, and matching full head
  reaching `CLEAN`; wrong actor, unbound or ambiguous request, zero or multiple
  markers, malformed or mismatching prefixes, arbitrary SHA mentions, copied
  PR heads, and linked reviews all remaining `UNKNOWN`;
- a `CODEX_FINDINGS_REVIEW_V1` formal review with a GitHub-native `commit_id`
  and at least one structurally attached review comment deriving `FINDINGS`,
  plus attachments with a wrong actor, wrong commit, duplicate ID, or changed
  body digest, a generic formal review without attached findings, and every
  review-comment result remaining `UNKNOWN`;
- formal reviews first observed as `APPROVED`, `COMMENTED`,
  `CHANGES_REQUESTED`, and `DISMISSED`, plus a first-observed `PENDING` review
  deriving `EVIDENCE_INCOMPLETE`, missing or unknown native states, and
  non-review results with a non-null state; and a previously satisfying review
  changing to `DISMISSED` under the same review ID, body, actor, and commit
  binding and persisting terminal `INVALIDATED`;
- a formal review from the expected numeric Bot actor, a human review copying
  the recognized body and login, a different Bot ID, and missing or non-Bot
  actor provenance; foreign objects while one request is open and between two
  requests must remain audit-only, so a later delayed Codex result still
  becomes ambiguous rather than silently closing the wrong request;
- request/result timestamp ties within one resource kind, where object ID may
  order them, and across issue-comment/review resource kinds, where association
  derives `GITHUB_REVIEW_UNKNOWN`;
- every accepted review-object `resource_kind`, an unrecognized review kind,
  every accepted `run_kind`, an unrecognized run kind, and object-ID
  uniqueness scoped separately to each respective kind, including
  acknowledgement records that distinguish equal numeric result IDs from
  different kinds, plus
  rejection of one resource-scoped object appearing in multiple adapter
  partitions;
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
  spanning more than two minutes, fresh parent collections paired with a stale
  independent source, and fresh nested collections paired with a stale
  pull-request read;
- concurrent mutations, stale expected revisions, and independent review and
  publication lock domains;
- a same-head request or unresolved thread recorded after finalization, gate
  revocation before the new ledger revision, a crash after revocation, and
  rejection of a cached or revision-mismatched gate;
- `record_codex_review_request` after finalization revoking and
  directory-syncing the existing gate before writing its new revision;
- a freshly finalized gate that validates against its unchanged ledger
  revision before `expires_at`, expiry at the oldest underlying five-minute
  deadline including when a run-source timestamp is the minimum, with an
  otherwise unchanged revision/head, and a same-head mutation landing after
  verification but before merge to document the residual point-in-time
  limitation;
- committed issuance requiring an uncommitted candidate gate, a durable
  `GATE_FINALIZATION_PASSED` audit event, and the final committed gate in that
  order, including crashes at both boundaries leaving no usable unaudited gate;
- finalization or verification with mode drift on any present authorization
  file, audit log, or audit head returning `STORE_MODE_MISMATCH` before
  replacing an existing committed gate, recovering a tail, cleaning a
  temporary, or changing any audit bytes; instrumented tests must also assert
  that the preflight opens the log read-write with append semantics, opens the
  head and authorization files read-only, and performs no second path-based
  open for their later reads, recovery, or append;
- valid and invalid `verify_publication_gate` calls that leave
  `publication.json` byte-identical, including request and result histories,
  terminal, revision, and cached status, with exact boundary tests immediately
  before, at, and after `expires_at`, while appending the exact durable
  `GATE_VERIFIED` success or failure audit event before returning, including
  equal finalization and verification gate digests for an unchanged gate and a
  null verification digest when no parseable gate exists; descriptor and store
  precondition failures must instead return before evaluator execution and
  append no event;
- gate-audit sequence and digest-chain continuity, 128-bit event-ID uniqueness,
  the 16 KiB per-event limit, event enums, mode `0600`, O(1) append without a
  total-count cliff, and crash boundaries before log fsync, between log and
  head sync, and after head sync; executable examples must bind the head's
  `committed_bytes`, next sequence, review ID, and last digest to the canonical
  event lines; recovery must adopt one complete valid tail,
  truncate one bounded incomplete tail, reject a complete-invalid,
  multi-record, or valid-plus-extra suffix, and validate the last committed
  record against the audit head without scanning the committed prefix;
- offline full audit inspection detecting corruption anywhere in the committed
  digest chain and reporting it without changing gate validity;
- authorization-time unrecoverable rejection of symlinks, non-regular files,
  and oversized `gate.json`, `publication.json`, and
  `publication-gate.json`; wrong modes must instead return non-mutating,
  actionable `STORE_MODE_MISMATCH` and succeed after `chmod 0600`. Also test
  exact audit-head temporary-pattern cleanup, cleanup of matching regular
  temporaries regardless of mode, and unrecoverable rejection of matching
  symlinks or non-regular files;
- exact ledger-history event emission for all four mutation kinds and rejection
  of every unrecognized history event;
- ambiguity acknowledgement with wrong head, stale revision, missing or extra
  resource-scoped request references (including unbound and unsupported
  requests) or resource-scoped result references, equal numeric request IDs in
  different resource kinds, missing rationale, or the wrong acknowledgement
  enum, plus a stale or future-dated backing observation, gate revocation,
  closed-reference reporting, the backing observation timestamp/hash, and the
  named `CODEX_REVIEW_AMBIGUITY_ACKNOWLEDGED` ledger-history record on success,
  including a recovery request whose
  GitHub `created_at` is equal to or earlier than `acknowledged_at` but whose
  later `recorded_revision` correctly places it in the new epoch;
- packaged-skill assertions for the complete seven-tool ordering, immediate
  pre-start baseline collection, request binding, prohibition of manual exact
  or trigger-shaped request comments, unbound or unsupported request recovery
  through full-closure direct-human ambiguity approval, direct
  automatic-quiescence approval when applicable, stable Bot actor-ID
  resolution, and immediate pre-merge gate verification;
- retryable acquisition deadlines versus non-retryable helper timeouts,
  structured MCP error fields, platform lock contention versus non-contention
  exits,
  stable guard inodes, PID reuse, heartbeat expiry, event-loop stalls,
  idempotent process-group termination, helper loss, owner-token mismatch and
  propagation, malformed replacement records, conservative failed-acquire
  cleanup, lost-ownership reread guidance, token absence from process arguments,
  and inconclusive owner-liveness checks;
- every state-changing publication tool returning
  `PUBLICATION_TERMINAL` against each terminal status without changing the
  ledger, gate, or audit entries;
- malformed and oversized inputs, including numeric GitHub IDs outside the
  positive safe-integer range; exact independent rejection tests for the 6 MiB
  observation, 2 MiB baseline, 10,000-entry observation aggregate, 5,000-entry
  baseline, 1,000 requirements, 1,000 acknowledgements, and 1,000 references
  per stored acknowledgement, plus binding 10 MiB file, 64 KiB terminal
  reserve, 19,999/20,000 monotonic aggregate boundaries, each individual
  10,000-entry monotonic-array boundary, and the 9,999/10,000 non-terminal and
  reserved-terminal ledger-history boundary. Caller or replaceable overflow
  must change no artifact; only mandatory monotonic exhaustion revokes the gate
  and records capacity `INVALIDATED`;
- rejection of a non-`Bot` `codex_actor_type`, plus persistence of the exact
  validated actor ID/type pair while login changes only audit display;
- server-authored `updated_at` and history `at` matching `recorded_at`, parent
  collection times matching their latest source, and executable validation of
  every RFC JSON example, all four comparison SHA bindings, and cross-example
  expiry calculation, plus RFC 8785 observation digest stability across caller
  key ordering and equality of every copied observation digest;
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
   immediate pre-merge gate verification, no-manual-trigger guidance,
   unbound-or-unsupported-request recovery through the full-closure
   direct-human ambiguity approval rule, direct automatic-quiescence approval,
   and stable Codex Bot actor-ID resolution; and make
   `scripts/verify-build.mjs` assert those skill requirements. Adapter fixtures
   also cover the 30-second post-to-list visibility grace and endpoint-specific
   installation-permission evidence for classic-protection `404` responses.
   Before enabling publication, capture adapter fixtures from the connector's
   observed output for both a clean issue comment and a findings formal review
   with attached review comments. A clean fixture must exercise its
   reviewed-commit marker and request-bound full-head checks; a findings fixture
   must exercise native `commit_id` and review-comment attachment. Reactions
   alone, generic conversation comments, generic formal reviews, and
   review-comment-only fixtures are unsupported in version 1.

Each implementation change requires its own local Claude review and GitHub
Codex review.

## Unresolved questions

None.

## References

- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [GitHub REST API: Get rules for a branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)
- [GitHub REST API: GitHub App installations](https://docs.github.com/en/rest/apps/installations)
- [GitHub REST API: Get a branch](https://docs.github.com/en/rest/branches/branches#get-a-branch)
- [GitHub REST API: Get branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)
- [GitHub REST API: Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST API: Issue comments](https://docs.github.com/en/rest/issues/comments)
- [GitHub REST API: Pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [GitHub REST API: Pull request review comments](https://docs.github.com/en/rest/pulls/comments)
- [GitHub REST API: Check runs](https://docs.github.com/en/rest/checks/runs)
- [GitHub REST API: Commit statuses](https://docs.github.com/en/rest/commits/statuses)
- [GitHub Docs: Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
