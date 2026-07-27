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

Codex results must contain exactly one matching marker. A clean issue comment
must carry it in that comment and also needs the existing reviewed-commit
prefix. A findings review may carry it in the formal review body or one
structurally attached review comment; it also needs the existing native GitHub
`commit_id` and structurally attached review comments.

## Association

For adapter version 2, the server independently replays these rules:

- one matching workflow-bound request ID plus a compatible head produces
  `CORRELATED_REQUEST_ID`;
- one matching preexisting correlated request produces
  `BASELINE_LATE_RESULT` and cannot satisfy the current publication;
- a matching unbound request, duplicate ID, or incompatible binding is
  `AMBIGUOUS`;
- an expected-actor result after an open request that omits the marker is
  `AMBIGUOUS`;
- an unrelated result with no open request is `UNSOLICITED`.

Timestamps establish only that a request existed before a result. They never
replace the request ID.

## Successor behavior

Version-2 baseline requests with valid IDs are stored as
`BASELINE_CORRELATED`. They remain immutable audit evidence but are not open
source candidates and require no human closure. A delayed response that echoes
one of those IDs stays attached to that historical request.

Legacy exact requests and unsupported trigger shapes remain fail-closed and
retain the RFC 0001 acknowledgement path. Upgrading an existing pull request
can therefore require one final legacy-baseline acknowledgement; subsequent
version-2 requests do not accumulate that cost.

## Compatibility

The server and adapter continue to read and complete adapter-version-1
publication ledgers. Their publication summary returns the legacy exact request
body without a request ID. A snapshot must use the same adapter version as its
publication baseline. New workflows start with adapter version 2.

## Security boundary

The request marker is a provider assertion, not a GitHub-native or signed
identifier. Review Bridge validates its exact value, pinned actor, immutable
request body, and head binding, and fails closed when any are absent or
inconsistent. Stronger authenticity would require a provider-signed request ID
or a GitHub-native check run that carries both an external ID and full head SHA.
