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
written only after a fresh observation derives `MERGE_READY`.

All files use the existing private directory and file modes. Publication
mutations must use the same atomic replacement mechanism as review mutations,
plus a per-review inter-process lock and revision check so concurrent Codex
sessions cannot overwrite each other's observations.

## Backward compatibility

Existing `review.json` and `gate.json` formats remain unchanged. Reviews created
before this RFC have no publication ledger and continue to support the local
Claude workflow. Publication tools are opt-in and available only after
`LOCAL_GATE_PASSED`.

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
    "base_branch": "main",
    "head_branch": "agent/change"
  },
  "latest_observation": {
    "observed_at": "2026-07-25T08:05:00.000Z",
    "pull_request": {
      "number": 5,
      "url": "https://github.com/owner/repository/pull/5",
      "state": "OPEN",
      "is_draft": false,
      "head_sha": "0123456789abcdef...",
      "base_branch": "main",
      "mergeable": "MERGEABLE"
    },
    "required_checks": [
      {
        "name": "test",
        "status": "COMPLETED",
        "conclusion": "SUCCESS",
        "details_url": "https://github.com/..."
      }
    ],
    "codex_request": {
      "comment_id": 100,
      "url": "https://github.com/...",
      "created_at": "2026-07-25T08:03:00.000Z",
      "body": "@codex review",
      "requested_head_sha": "0123456789abcdef..."
    },
    "codex_result": {
      "comment_id": 101,
      "url": "https://github.com/...",
      "created_at": "2026-07-25T08:04:00.000Z",
      "author": "chatgpt-codex-connector",
      "reviewed_head_sha": "0123456789abcdef...",
      "verdict": "CLEAN",
      "body_sha256": "sha256..."
    },
    "unresolved_threads": []
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

## Atomic GitHub observations

One `record_github_snapshot` call records all publication evidence observed at
the same time:

- pull request identity and current head SHA;
- draft, open, mergeability, and base-branch state;
- every required check and its conclusion;
- the exact `@codex review` request;
- the resulting Codex response and reviewed commit;
- all unresolved review threads; and
- the observation timestamp.

The server must not expose independent mutations such as
`record_checks_passed` and `record_codex_passed`. Separate mutations could
combine a check result from commit A, a review from commit B, and the current
pull request head from commit C.

Each mutation accepts `expected_revision`. Under the per-review lock, the
server compares it with the stored revision before writing. A mismatch fails
and requires the caller to read the ledger again.

## Derived states

`status` is cached for display but recomputed from the latest observation on
every mutation and finalization.

| Status | Meaning |
| --- | --- |
| `PUBLICATION_STARTED` | The local gate and GitHub target are bound. |
| `PR_PENDING` | No pull request observation exists yet. |
| `PR_DRAFT` | The pull request is still a draft. |
| `CHECKS_PENDING` | At least one required check has not completed. |
| `CHECKS_FAILED` | At least one required check failed or was cancelled. |
| `GITHUB_REVIEW_NOT_REQUESTED` | No valid exact request exists for the head. |
| `GITHUB_REVIEW_PENDING` | A request exists but no later Codex result exists. |
| `GITHUB_REVIEW_UNKNOWN` | The result format or verdict cannot be recognized. |
| `CHANGES_REQUIRED` | Codex reported findings or any review thread is unresolved. |
| `MERGE_READY` | Every required invariant passes for the current head. |
| `INVALIDATED` | The pull request identity or head no longer matches the local gate. |
| `CLOSED` | The pull request closed without a recorded merge. |
| `MERGED` | A later observation confirms the pull request was merged. |

`INVALIDATED` is terminal for this review. A code change requires a new local
Review Bridge task and a new publication ledger.

## State derivation

The evaluator applies these checks in order:

1. The ledger references an existing `LOCAL_GATE_PASSED` gate.
2. The repository identity, pull request base, and pull request number match
   the bound target.
3. The pull request head equals the local gate `head_sha`.
4. The pull request is open and no longer a draft.
5. Every required check is completed successfully.
6. The request body is exactly `@codex review`, and the request is bound to the
   current head.
7. The Codex result was created after the request.
8. The result names the same reviewed head SHA.
9. The result parser returns `CLEAN`; an unknown format fails closed.
10. No review thread remains unresolved.

Only an observation that passes every check derives `MERGE_READY`.

Outdated but unresolved threads still block publication. A human must resolve
or dismiss them explicitly instead of relying on the ledger to infer that they
are harmless.

## Author tools

The author role adds four tools.

### `start_publication`

Inputs:

- `review_id`
- `repository_id`
- `owner`
- `repo`
- `base_branch`
- `head_branch`

The tool requires `LOCAL_GATE_PASSED`, reloads `gate.json`, verifies the local
working tree is clean, and verifies local `HEAD` equals the gate `head_sha`.
It creates revision 1 in `PUBLICATION_STARTED`.

### `record_github_snapshot`

Inputs:

- `review_id`
- `expected_revision`
- one complete normalized GitHub observation

The tool validates sizes, enums, timestamps, SHA formats, URLs, unique check
names, unique thread IDs, exact request body, and cross-field ordering. It then
derives status and atomically records the next revision.

### `get_publication`

Returns the ledger without accessing GitHub.

### `finalize_publication_gate`

Inputs:

- `review_id`
- `expected_revision`

The tool requires the latest derived status to be `MERGE_READY`, rechecks the
local gate file and local repository head, and writes:

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
  "status": "MERGE_READY"
}
```

Codex must perform a fresh GitHub read immediately before this call. It then
merges with an operation that rejects a changed PR head, such as
`gh pr merge --match-head-commit <head_sha>`.

## Codex result adapter

GitHub Codex may report success in a pull request conversation comment rather
than a formal GitHub review. Parsing therefore belongs in a small,
versioned adapter in the Codex plugin, not in the generic ledger evaluator.

The adapter returns:

- the GitHub object ID, URL, author, and timestamp;
- the reviewed commit SHA;
- `CLEAN`, `FINDINGS`, or `UNKNOWN`; and
- a SHA-256 digest of the original response body.

Any unrecognized response format returns `UNKNOWN`. A reaction without a
response is still pending. Thread collection remains separate from result
parsing and includes thread resolution state.

## Locking and revisions

Before adding publication mutations, Review Bridge must introduce a shared
per-review lock used by both existing review mutations and new publication
mutations. Atomic rename prevents corrupt JSON but does not prevent lost
updates.

The lock must:

- have an acquisition timeout;
- record owner PID and acquisition time;
- recover only locks whose owner is no longer alive and whose age exceeds the
  stale threshold; and
- always release in a `finally` block.

Revision checks remain necessary even with a lock because callers can operate
from stale reads.

## Failure and recovery

- Missing or malformed evidence never advances the state.
- A GitHub read failure leaves the previous revision unchanged.
- An interrupted atomic write leaves the previous complete JSON file.
- A revision conflict requires a new `get_publication` call.
- A changed head records `INVALIDATED` and requires a new local review.
- A changed or deleted GitHub comment makes the next fresh observation pending
  or unknown; it does not retain a stale pass.
- A merged pull request may be recorded only when a live observation supplies
  its merge commit SHA. A squash merge commit is allowed to differ from the
  reviewed head.

## Drawbacks

- The ledger records normalized claims supplied by Codex; it cannot
  independently authenticate GitHub without expanding the credential boundary.
- GitHub response-format changes can move a previously understood Codex result
  to `GITHUB_REVIEW_UNKNOWN` until the adapter is updated.
- Per-review locking adds complexity to the otherwise simple atomic-file store.
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

## Unresolved questions

Claude review should resolve these before implementation:

1. Which GitHub API response is authoritative for the set of required checks
   when rulesets and classic branch protection coexist?
2. Should every unresolved thread block publication, or only threads created
   by GitHub Codex? This RFC currently chooses every unresolved thread.
3. Should the first implementation store the normalized Codex response body in
   addition to its digest, or rely on its GitHub URL for full audit context?
4. What acquisition timeout and stale threshold should the per-review lock use?
5. Should a closed, unmerged pull request permit starting another publication
   ledger for the same local gate, or require a fresh local review?

## Test plan

The implementation must test:

- the successful path from local gate to `MERGE_READY`;
- a pull request head changed before and after Codex review;
- required checks from a different head or with pending, failed, cancelled, or
  missing results;
- a missing request, a non-exact request, and duplicate requests;
- a reaction without a Codex result;
- a result created before its request;
- a missing, malformed, unknown, or stale reviewed commit;
- findings and unresolved, resolved, and outdated threads;
- a pull request retargeted to another base branch;
- a force-push after `MERGE_READY`;
- concurrent mutations and stale expected revisions;
- malformed and oversized inputs;
- failure to finalize from every state except `MERGE_READY`; and
- recording a squash merge whose merge commit differs from the reviewed head.

The existing end-to-end packaged-client test should add one publication flow,
while GitHub API behavior remains covered by adapter fixtures rather than live
network calls.

## Rollout plan

Implement this design in two changes:

1. add the shared per-review lock and revision support without changing the
   review protocol; and
2. add publication storage, state derivation, author tools, the Codex adapter,
   and packaged-client verification.

Each implementation change requires its own local Claude review and GitHub
Codex review.
