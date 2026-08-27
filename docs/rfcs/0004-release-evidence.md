# RFC 0004: Release evidence

| Field | Value |
| --- | --- |
| Status | Draft |
| Authors | Review Bridge contributors |
| Created | 2026-08-27 |
| Target release | TBD |

## Summary

Extend the evidence chain one step past `MERGE_READY`: a release becomes a
machine-checkable claim instead of an operator ritual. A read-only collector
observes the GitHub facts of a release — the merged pull requests since the
previous tag, the tag object, the published assets — and a verifier checks
them against the repository's own claims (the CHANGELOG entry, the version
alignment) and against the store's workflow terminal records. A release that
verifies appends one immutable evidence record to the store. Nothing in this
RFC performs a release action: tagging, publishing, and merging remain human
work, exactly as RFC 0003 left them.

## Motivation

Two failures this repository actually shipped motivate the design:

- `v0.6.0` was released in every human-visible sense — version bumped,
  CHANGELOG written — and never tagged. The gap was discovered two releases
  later, by accident, while checking something else.
- The `v0.8.1` release retraced a process from memory and stepped into the
  same pitfalls a previous release had already paid for, because the process
  was prose in a session transcript rather than a checkable list.

Both are claim-versus-fact gaps of exactly the kind the rest of the system
refuses to tolerate for code review. The CHANGELOG asserts what a release
contains; nothing compares that assertion against the merged pull requests it
claims to describe. A workflow ends with a terminal record attesting the head
that was `MERGE_READY`; nothing ever checks that the commit GitHub merged is
that head. The evidence exists on both sides. This RFC adds the comparison.

## Goals

- Verify a release's claims against observed GitHub facts and recorded
  workflow attestations, with an exact, named failure for every mismatch.
- Record one append-only release evidence record per version in the store
  after verification passes.
- Check, for every pull request in the release range that has a workflow
  terminal record, that its merge introduced exactly the attested head.
- Keep every check replayable: the record names the observation it was
  verified against.

## Non-goals

- Performing any release action: no tagging, no asset upload, no publishing,
  no merging. The verifier reads; the operator acts.
- A release state machine. Releases are operator-driven, low-concurrency,
  minutes-long processes with no unattended crash-recovery need; there is no
  intent chain to persist (see Alternatives).
- A merge-time ledger domain. Merge evidence is GitHub's native audit trail;
  this RFC only compares it against existing attestations at release time.
- Blocking unattested pull requests. A repository legitimately merges work
  that never ran the autonomous workflow; the record makes the
  attested/unattested split visible rather than forbidding it.
- Cross-repository aggregation or telemetry.

## Design

### Two verification phases, one requirement list

The facts of a release become observable at two different times, so the
verifier runs in two modes sharing one requirement list:

- **Pre-flight** (`--pre`), before tagging — checkable from the repository
  alone, so it can also run in CI on the release pull request:
  - the top CHANGELOG entry names the version `package.json` carries, and the
    existing release-metadata alignment assertions hold;
  - the CHANGELOG entries newer than the previous extant tag (or all entries, for the repository's first tagged release, whose range starts at the repository root) — one entry
    normally, several when an intermediate release was never tagged — taken
    together reconcile with the merge commits between that tag and the
    release commit: every claimed change maps to a merged pull request in
    the range, and every merged pull request in the range is either
    represented in one of those entries or explicitly listed as
    internal-only. A missing intermediate tag therefore widens the claim set
    along with the commit range instead of turning the intermediate
    release's merges into false mismatches.

    Reconciliation is deterministic, never prose interpretation. Its unit is
    the pull-request number: every bullet in a reconciled entry names the
    pull requests it describes (for example `(#63)`), internal-only merges
    are listed under an explicit marker in the entry, and the check compares
    the claimed number set against the merged set in the range. The
    exemption for history has a deterministic cutoff: a marker in the
    CHANGELOG header names the first version whose entry must carry
    references. Entries older than the marker are reported as
    `pre-convention` — the same visible-but-not-fatal treatment as
    unattested merges — while an entry at or after it that omits references
    fails verification, so a new entry cannot borrow the legacy exemption by
    omission. The marker is ordinary CHANGELOG text: moving it is a visible
    edit, and the entry digests of recorded releases pin the text it
    governed. The marker is always read from the default branch's CHANGELOG
    at verification time, never from the historical text a tag carries —
    adoption is a repository-level fact, and a tag created before the marker
    existed cannot contain it. A historical tag therefore verifies under the
    same cutoff as a fresh release, and the record pins the cutoff it
    applied so a replay classifies entries exactly as the original run did.

    Local discovery reads merge commits, so it assumes the merge-commit
    history the merge-integrity check below already requires; a squash- or
    rebase-merged pull request is invisible to it. The two comparison
    directions therefore carry different weight in pre-flight: a locally
    visible merge that no entry claims fails, because a local merge commit
    is ground truth for presence — but a claimed pull request that local
    discovery cannot find is deferred, not failed, because local history
    cannot prove absence. The final phase settles deferred claims from
    GitHub's facts, which is the authoritative reconciliation.
- **Final** (`--final`), after tag and release are published — requires the
  authenticated GitHub CLI and the store, so it runs on the operator's
  machine only:
  - the tag exists and is reachable from the default branch, and the final
    phase reruns every pre-flight requirement against the peeled tag target
    itself. Pre-flight persists nothing and claims no continuity with any
    later run — it is early warning, not evidence; the CI copy checks a pull
    request's head while the tag targets a merge commit, so the two need not
    even agree on a SHA. The record rests solely on what the final phase
    verified;
  - the reconciliation re-runs against GitHub's merged-pull-request facts
    for the range — the authoritative discovery, which also covers squash-
    and rebase-merged pull requests that local history cannot reveal — so
    the pre-flight result is exact for merge-commit-only history and an
    approximation otherwise;
  - the published release's assets match a local `verify-build` output for
    the same tag. The checksum manifest is validated by content — the
    published `SHA256SUMS.txt` must equal the locally generated one — and is
    then excluded from the payload set, because a manifest cannot list a
    stable checksum of itself. The remaining assets must agree with that
    manifest in both directions: no missing asset, no unexplained extra;
  - the merge-integrity check below.

### Merge-integrity check

For each pull request in the release range, the verifier looks up a bound
publication with a workflow terminal record. Where one exists, the merge
commit's second parent must equal the terminal record's attested head — the
commit `MERGE_READY` was recorded for is the commit that entered history.
Pull requests without a terminal record are reported as `unattested`, which
is information, not failure.

This check requires merge commits. A squash or rebase merge destroys the
attested head's identity, making the comparison impossible; such merges are
recorded as `unverifiable`, and a repository that wants this check must keep
merge commits for workflow-driven pull requests.

### The evidence record

The store serves multiple repositories — the review APIs accept arbitrary
repository paths against one `REVIEW_BRIDGE_HOME` — so release records are
namespaced by a stable repository identity: on a passing `--final` run the
verifier appends `releases/<repository-id>/<version>.json`, keyed by the
numeric GitHub repository ID the observation was collected from, the same
identity the publication push fencing already resolves. Two repositories
releasing the same version never address the same record. The record
carries:

- the repository identity (numeric GitHub repository ID and full name);
- version, tag name, tag target SHA, release commit SHA;
- the range boundary the claims and pull requests were reconciled against:
  the previous extant tag's name and target SHA at verification time, or an
  explicit root sentinel for the repository's first tagged release, whose
  range starts at the repository root — never an implicit null;
- one digest per reconciled CHANGELOG entry, keyed by version, committing
  the complete claim set the verification actually used;
- the pull-request list of the range, each entry carrying its merge SHA and
  either the terminal-record reference it matched, `unattested`, or
  `unverifiable`;
- the asset digest list;
- the observation reference: the collected observation is itself persisted
  content-addressed — its filename is its own content digest, written with
  no-overwrite semantics before the record is appended — and the record
  carries that path and digest along with the collection time and verifier
  version. A re-run's fresh collection lands under its own digest and can
  never replace the referenced bytes; identical content is idempotent. The
  exact evidence behind the record stays re-readable.

One record per version. A re-run against an existing record compares and
reports; it never silently overwrites. The comparison replays the record's
own range boundary, so a historical tag backfilled later — the permitted
human action — narrows nothing retroactively: the changed boundary is
reported as superseded, never as divergence. Equality is defined over the
record's semantic fields — the identities, SHAs, boundary, reconciled sets,
and digests — and excludes the per-run provenance (observation reference,
collection time, verifier version), which a fresh collection renews by
construction: new provenance is not history divergence. A genuine mismatch
in the semantic fields is a loud failure — history changed after it was
recorded — and resolving it is operator work.

### What the record is, and is not

The evidence-direction rule applies unchanged: this record authorizes
nothing. It is not consulted by any gate, it cannot make a future action
legal, and a missing record blocks nothing but the operator's own confidence.
It is frozen evidence that, at one named moment, the release's claims and the
observable facts agreed. Reading workflow terminal records here is likewise
pure audit: frozen attestations compared against observed history, never
evidence for a new write.

## Security considerations

- The collector and verifier are read-only against GitHub and the repository;
  the only write is the evidence record in the operator's private store.
- No credentials enter the record: it carries SHAs, digests, and public
  pull-request metadata.
- The record's trust bound is the same as RFC 0003's observations: it is as
  authentic as the authenticated `gh` session that collected it. This RFC
  adds no cryptographic identity.

## Backward compatibility

- No existing ledger schema changes. The release record is a new, standalone
  file family in the store; older tooling ignores it.
- Releases before this RFC simply have no record; the verifier can be run
  retroactively against a historical tag to produce one, with the observation
  identity making the late collection explicit.

## Drawbacks

- The CHANGELOG reconciliation needs two conventions — per-bullet
  pull-request references, and an explicit internal-only list for merges
  deliberately absent from the prose — which is more release discipline to
  document, and entries older than the conventions stay `pre-convention`
  forever unless rewritten.
- The asset check depends on a local rebuild at the tag; a toolchain
  difference that changes bytes produces a false mismatch the operator must
  investigate rather than wave through.

## Alternatives considered

### A fourth full ledger domain

Rejected (operator decision, 2026-08-27). The existing domains earn their
state machines by surviving unattended crashes between external writes.
Releases have an operator present at every step and no autonomous writes, so
a `PLANNED -> EXECUTING -> OBSERVED` chain would be machinery without a
failure mode to protect against — and RFC 0003 already records that each
added state domain permanently raises maintenance and recovery-test cost.

### An independent merge-authorization ledger

Rejected (operator decision, 2026-08-27). Recording merge authorization at
merge time duplicates GitHub's native audit trail and adds a domain whose
one novel fact — merged SHA versus attested head — the release-time
comparison already yields without new write paths.

### Status quo

The two shipped failures above are the argument against it.

## Test and rollout plan

The verifier is tested the way the collector and gate already are: fixture
observations and stores, one test per named failure (each check must have a
case that turns it red), and fail-soft handling for malformed inputs. The
merge-integrity cases cover matched, unattested, unverifiable, and
mismatched pull requests; the record cases cover first write, agreeing
re-run, and the loud mismatch on divergent history.

Rollout is one implementation change: the collector/verifier scripts, their
tests, and the release-process documentation update. The first real exercise
is retroactive — record every historical release whose tag exists, and
report the ones whose tag does not. `v0.6.0` cannot be recorded, and that is
the point: the verifier's loud report of the missing tag is exactly the
catch this RFC exists for. No backfill exception is added; creating a
historical tag remains an ordinary human release action outside this
document, after which that version records normally. When the shipped
implementation matches this document, the status line flips to `Implemented`
in the change that makes it true.

## Unresolved questions

- Whether the pre-flight mode should be wired into the release pull request's
  CI or stay an operator command; CI wiring needs no store access, so it is
  possible, but it adds a release-PR-shaped special case to the workflow file.
- Where the CHANGELOG conventions — per-bullet pull-request references and
  the internal-only list — are stated (CHANGELOG header, CONTRIBUTING, or
  the verifier's own documentation).
