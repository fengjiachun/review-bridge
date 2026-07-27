# RFC 0002: Codex request correlation

Status: implemented

## Problem

GitHub exposes Codex review requests and results as independent objects. A
reviewed-commit marker binds a result to code, but it does not identify which
request started the review. On a pull request with several historical
`@codex review` comments, a delayed result can therefore be indistinguishable
from the result of the newest request.

RFC 0001 fails closed by treating every old request as a possible source until
a human closes the complete ambiguity set. This is safe but makes each
successor head repeat an increasingly large confirmation.

## Decision

Adapter version 2 gives every workflow request a unique request ID. The
publication server derives the ID from the immutable review ID, current ledger
revision, and authorized head:

```text
rbreq-<32 lowercase hexadecimal characters>
```

`get_publication_summary` returns both the ID and the complete request body when
the next action is `POST_AND_RECORD_CODEX_REVIEW_REQUEST`. The body has this
exact shape:

```text
@codex review

When you finish, append exactly this marker to the review summary:
<!-- review-bridge-request-id: rbreq-... -->
```

The workflow posts that body unchanged and immediately supplies the same ID to
`record_codex_review_request`. The server recomputes the expected ID from its
current revision and rejects caller-selected or stale IDs.

Codex results should contain exactly one matching marker. A clean issue comment
may carry it in that comment; a findings review may carry it in the formal
review body or one structurally attached review comment.

The GitHub Codex App can omit requested markers from otherwise native,
head-bound results. Version 2 therefore retains a narrow fallback: a markerless
result can bind only when exactly one recorded workflow request is open, no
unbound or compatible unresolved baseline request precedes the result, and the
result carries the existing compatible reviewed-commit prefix or native GitHub
`commit_id`. Findings still require structurally attached review comments.

## Association

For adapter version 2, the server independently replays these rules:

- one matching workflow-bound request ID plus a compatible head produces
  `CORRELATED_REQUEST_ID`;
- one matching preexisting correlated request produces
  `BASELINE_LATE_RESULT` and cannot satisfy the current publication;
- one markerless, strongly head-bound result after exactly one open recorded
  request and no compatible unresolved baseline request produces
  `SINGLE_OPEN_REQUEST`;
- a matching unbound request, duplicate ID, or incompatible binding is
  `AMBIGUOUS`;
- a markerless result with multiple open requests, an open unbound request, a
  compatible unresolved baseline request, or no compatible head binding is
  `AMBIGUOUS`;
- an unrelated result with no open request is `UNSOLICITED`.

Timestamps establish only that a request existed before a result. The fallback
also requires a unique recorded request and a GitHub-native or reviewed-commit
head binding; time alone never establishes correlation.

## Successor behavior

Version-2 baseline requests with valid IDs are stored as
`BASELINE_CORRELATED`. A delayed response that echoes one of those IDs stays
attached to that historical request. At publication start, the server searches
valid prior local publication ledgers for an exact request-facts match and
recomputes the ID from the source review ID, source revision, and authorized
head. Only that server-derived issuance provenance may scope a baseline
request. For markerless results, a proven request from another head is not a
candidate; an unproven or same-head request remains a candidate until an exact
correlated result or explicit closure removes the ambiguity.

Legacy exact requests and unsupported trigger shapes remain fail-closed and
retain the RFC 0001 acknowledgement path. Upgrading an existing pull request
can therefore require one final legacy-baseline acknowledgement. Version-2
requests issued by Review Bridge do not accumulate that cost across successor
heads when their prior ledger remains available.

## Compatibility

The server and adapter continue to read and complete adapter-version-1
publication ledgers. Their publication summary returns the legacy exact request
body without a request ID. A snapshot must use the same adapter version as its
publication baseline. New workflows start with adapter version 2.

## Security boundary

The request marker is a provider assertion, not a GitHub-native or signed
identifier. Review Bridge validates its exact value when present, the pinned
actor, immutable request body, and head binding. Without a marker it accepts
only the unique-open-request fallback with a compatible native or
reviewed-commit head binding and no compatible unresolved baseline request.
Baseline head scope is trusted only when the server finds an exact request in a
valid same-PR local publication ledger and verifies its derived ID; baseline
input cannot assert that provenance. Missing or conflicting provenance remains
unscoped and fails closed. Multiple candidates, unbound requests, duplicate
results, and incompatible heads also fail closed. Stronger authenticity would
require a provider-signed request ID or a GitHub-native check run that carries
both an external ID and full head SHA.
