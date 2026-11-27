# RFC 0006: Round-limit severity cutoff and maintainer rulings

| Field | Value |
| --- | --- |
| Status | Draft |
| Authors | Review Bridge contributors |
| Created | 2026-11-27 |
| Target release | TBD |

## Summary

Two changes to local review.

**D1.** A review that has used its last round, and whose findings left open
are all `minor` or `nit`, can be finalized by `finalize_local_gate`. Today
only `CLEAN` can. The open findings are listed in the gate, the review
summary, and the report. No status, round, or finding category is added.

**D2.** Between rounds, the author side can record a **maintainer ruling**
with a new tool, `record_maintainer_ruling`. A ruling decides a trade-off
raised by named findings or amends a requirement clause that turned out
wrong. The next round's reviewer receives the rulings with the requirement
and treats them as binding scope, within stated bounds. A continuation
carries them forward.

## Motivation

A field report from 2026-11-27 covered six consecutive local reviews on
review-bridge 0.26.0 (`CODEX_TASK`, `gpt-6.2-astra` at high effort). None
reached `CLEAN` within the round limit, and the owner skipped the gate on
every push. None of the findings left open was a production defect that the
author disputed. The report found four patterns:

1. Every round that changes a test raises new findings on that test, so the
   count does not reach zero within two rounds even when every earlier
   finding is resolved.
2. A requirement clause the author wrote wrong blocks `CLEAN` for the whole
   review, because the requirement is part of the snapshot commitment and a
   rereview cannot amend it.
3. A maintainer decision made between rounds has no channel into the running
   review. In one of the six reviews the decision was written into
   resolution text, and the rereviewer raised a major finding that the
   rebuttals added exceptions to the frozen requirement. The finding is
   correct under today's design, because author text is material to verify,
   never instructions.
4. Writing "tests are kept few by decision" into the requirement did not
   reduce test-strength findings.

The store agrees. 109 reviews created since 2026-11-01 stopped at round 2 in
`CONTINUABLE_FINDINGS` (63) or `HUMAN_REQUIRED` (46). Counting a finding as
closed when its status is `RESOLVED` or `REBUTTAL_ACCEPTED`, the worst
severity left open was:

| Worst open severity | `CONTINUABLE_FINDINGS` | `HUMAN_REQUIRED` | Total |
| --- | --- | --- | --- |
| nit | 8 | 2 | 10 |
| minor | 35 | 16 | 51 |
| major | 20 | 27 | 47 |
| blocker | 0 | 1 | 1 |

So at their round-two verdict, 61 of the 109 (56%) held only minor or nit
findings. Since then, 38 of the 109 have been continued, 25 of them
minor-or-nit only. Of the open findings whose title or path contains the
whole word `test` or `tests`, 51 are minor, 26 are nit, and none is major. A
bare substring match adds three majors, and all three are false positives
("latest", "attest", "attestations"). Of 31 publications started in
the same period, 9 came through a local gate and 22 were `REMOTE_ONLY`.

## Goals

- Stop minor and nit findings from blocking the local gate once the review
  has no round left, while keeping them visible.
- Make test findings warn without blocking. D1 does that by severity: all
  77 open findings the test match above selects are minor or nit. An open
  major test finding would still block.
- Give a maintainer decision made between rounds a recorded, bounded channel
  to the next reviewer, including a correction to a requirement clause.
- Add as little state as possible, and leave reviews that use neither change
  as they are today.

## Non-goals

- A **human override after the last round**: a ruling recorded after round
  two that closes open `blocker` or `major` findings. `export_human_arbitration`
  stays the path for disputes. A ruling never changes a finding's status in
  any round.
- A separate test-finding category, a new review status, or a third round.
- Changing how D1 treats findings before the last round. Minor findings in
  round one still go through resolution and rereview.
- Authenticating the maintainer. A ruling has the same operator-label trust
  as `authorize_remote_publication`.
- Any change to the publication gate or the `REMOTE_ONLY` path.

## Design

### D1: Finalizing at the round limit

#### Predicate

A review is **finalizable at the round limit** when all of these hold:

1. `status` is `CONTINUABLE_FINDINGS` or `HUMAN_REQUIRED`;
2. `current_round` equals the ledger's `max_rounds`;
3. `continued_by_review_id` is null, so no continuation has frozen it;
4. every entry in `findings` whose status is not `RESOLVED` or
   `REBUTTAL_ACCEPTED` has `severity` `minor` or `nit`.

Severity is the `severity` the reviewer submitted. It is validated by
`normalizeFinding` and no tool changes it afterwards, so the author cannot
lower it. `carried_findings` do not count. They are scope hints from the
source review, not findings of this ledger, and the continuation's reviewer
raises again whatever is still present.

The predicate reads existing fields only. In today's code it can hold only
in round two. Only the initial review sets `REVIEW_SUBMITTED`, so an
author's `human_required` answer (`submitResolutionsWhileLocked` in
`src/core.mjs`) occurs only in round one.
A round-two `HUMAN_REQUIRED` therefore comes from `REREVIEW_UNRESOLVED`, a
rejected finding the rereviewer kept open. At that point the open findings
are `OPEN` (new in round two) or `STILL_OPEN`. Rule 4 covers disputed and
undisputed findings alike, as the owner decided.

One exported function in `src/core.mjs` computes the predicate. The
summary, `finalize_local_gate`, and the report's next-step line call it. It
decides eligibility before finalization only. Once a review is
`LOCAL_GATE_PASSED`, rule 1 no longer holds, so the report and the scorecard
recognize a review gated with open findings by its open findings (see
Report and scorecard), not by this predicate.

#### Finalization

`finalize_local_gate` accepts `CLEAN`, as today, or a review for which the
predicate holds. In the second case the gated round is the last round,
`rounds.at(-1)`, the snapshot the last reviewer judged. Finalization runs
today's checks against it: successor artifacts, the stored patch hash, and
the live working tree. In the same write that sets `LOCAL_GATE_PASSED` it
sets `clean_snapshot_hash` to that round's `snapshot_hash`.

Reusing `clean_snapshot_hash` is deliberate. Its meaning widens from "the
snapshot judged clean" to "the snapshot the gate attests". Every reader
already uses it that way: successor parent selection, finalization,
`localGateReviewMismatch` in publication, and the report. They need no
change, and neither do released servers sharing the store (see Backward
compatibility). A new `gated_snapshot_hash` would need every one of them to
learn it.

The review status stays `LOCAL_GATE_PASSED`. A finalized review can be
neither continued nor sent to arbitration, as today. A review with a
continuation is refused by rule 3, because the continuation is where the
work went.

Finalization writes `gate.json` before it saves the ledger status, as today.
A crash between the two writes leaves an eligible status beside a minted
gate. For `CLEAN` nothing else can act on that state. For a
`CONTINUABLE_FINDINGS` review, a continuation could freeze it and leave the
gate stranded. So `freezeContinuationSource` refuses a source whose
`gate.json` exists, using the artifact check `appendReviewErratumWhileLocked`
already makes under the same lock. A retried `finalize_local_gate` still
finds the predicate true and completes, rewriting the gate, as a retried
`CLEAN` finalization does today.

#### Attestation

`gate.json` gains `open_findings`: one `{id, severity, status}` per finding
the predicate allowed, in ledger order. The field is present only when that
list is not empty, so a gate minted from `CLEAN` has the same fields as
today. The gate stays version 1. Released readers ignore the field and make
the right decision, which is to publish the gated head (see Backward
compatibility).

The list is checked in two places, which do different things. The
publication gate binds the local gate's bytes through `local_gate_sha256`,
so a publication commits to the list as written. It does not compare the
list with the ledger. The report does compare them. Its gate check
(`localGateReviewMismatch`, called from `src/report.mjs`) also compares the
gate's `open_findings` with the ledger's open findings. It reads that field
from `gate.json`, because `normalizedLocalGate` does not carry it, and it
reports a difference as it reports other gate mismatches.

The review summary needs no new field. `active_findings` already lists every
finding that is not `RESOLVED` or `REBUTTAL_ACCEPTED`, and it still does
after `LOCAL_GATE_PASSED`.

#### Next action

`actionRequired` reads the review instead of the status alone. When the
predicate holds, `get_review_summary` (and therefore `wait_for_review_state`)
reports `action_required: FINALIZE_LOCAL_GATE`, with today's
`required_inputs` for that action. Otherwise it reports today's mapping:
`ADDRESS_LOCAL_FINDINGS` or `HUMAN_ARBITRATION`.

The other paths stay open until the gate is minted. A continuation can still
be prepared from an eligible `CONTINUABLE_FINDINGS` review, and an eligible
`HUMAN_REQUIRED` review can still be exported for arbitration. The summary
names the default, not the only option.

#### Lens and successor reviews

A lens review (RFC 0005) reaches round two through today's protocol, so the
predicate applies unchanged. Lens findings count like any other, and
nothing changes in round one, including a lens round that closes `CLEAN`.

A successor review has two rounds like any other, and the predicate applies
to it unchanged. Finalization verifies the gated round's successor artifacts,
as today. A review gated with open findings is a valid successor parent,
like any `LOCAL_GATE_PASSED` review. The successor's delta reviewer is not
shown the parent's open findings, because the parent's gate accepted them.
They stay listed in that gate, which the successor proof binds by
`parent_gate_sha256`. (Successors of reviews that hold rulings are covered
under D2.)

#### Report and scorecard

The report and the scorecard count every `LOCAL_GATE_PASSED` review as clean
today (`CLEAN_STATUSES` in `src/report.mjs` and `src/scorecard.mjs`). That
would misstate a review gated with open findings, and it would hide D1 from
its own measurement. Both therefore classify a `LOCAL_GATE_PASSED` review
whose ledger holds a finding that is not `RESOLVED` or `REBUTTAL_ACCEPTED` as
gated with open findings.

- **Report.** For a gated review with open findings, the outcome section
  says it was gated at the round limit with N findings open, in place of
  "Rounds to CLEAN", and labels the snapshot "Gated snapshot". The open
  findings appear where the report already lists findings still open. For an
  eligible review not yet finalized, the next-step line says the local gate
  can be finalized next with N minor or nit findings left open.
  `REPORT_FORMAT` becomes 13.
- **Scorecard.** A `LOCAL_GATE_PASSED` review whose findings include open
  ones is not counted in `rounds_to_clean` or the Clean columns. It is
  counted in a new `gated_with_open_findings` total and still appears in
  `reviews_by_status`. `SCORECARD_SCHEMA_VERSION` becomes 6.

#### Publication

The publication path needs no change. Reading `src/publication.mjs`:

- `validateOpenedLocalGate` requires gate version 1, the review ID, status
  `LOCAL_GATE_PASSED`, valid object IDs and digest, a review in
  `LOCAL_GATE_PASSED`, and a matching provider. A D1 gate meets all of them.
- `localGateReviewMismatch` compares the gate's base and head with
  `rounds.at(-1)` and its snapshot with `clean_snapshot_hash`. D1 gates the
  last round and sets `clean_snapshot_hash` from it, so both match.
- `authorize_remote_publication` never reads a review ledger.

On GitHub, Codex reviews the pull request independently. It may raise an
open local finding again, and the author handles that as ordinary GitHub
review feedback. The report's comparison above is a report change, not a
publication change.

#### Test findings

No test-finding category is added. Every open test-shaped finding in the
store tally is minor or nit, so D1 alone makes them warn without blocking at
the round limit. A category would need a reviewer-side classification and a
field, and severity already does the job.

### D2: Maintainer rulings

#### Tool

`record_maintainer_ruling`, an author tool, with these inputs:

| Input | Rule |
| --- | --- |
| `review_id` | the review |
| `expected_state_version` | must equal the ledger's `state_version`, as in `export_human_arbitration` |
| `text` | 1 to 20,000 characters, the errata limit |
| `finding_ids` | optional, at most 100 distinct IDs, each an `id` in this ledger's `findings` |
| `operator_label` | 1 to 500 characters, the limit `authorize_remote_publication` uses |

It returns the compact summary, as `append_review_erratum` does. No summary
or `required_inputs` entry ever names it, so an unattended driver never
reaches it as a next step. It runs only when a human has made a decision.

There is no `kind` field. Whether a ruling decides a trade-off or amends a
clause is in its text, and the reviewer judges its bounds either way.

#### When it is accepted

The tool takes the review's mutation lock and accepts a ruling in one
window, **W1**: `status` is `AUTHOR_RESPONDED` and `current_round` is less
than `max_rounds`. The round's verdict and the author's resolutions are on
record, and the next round has not been captured. With `MAX_ROUNDS = 2`, this
is the gap between round one and round two of a review, including a
continuation.

It is refused in every other state:

- in `WAITING_FOR_REVIEW`, `WAITING_FOR_LENS_REVIEW`, and
  `WAITING_FOR_REREVIEW`, because a reviewer may already be reading the
  round;
- in `REVIEW_SUBMITTED`, because the author has not yet answered;
- in `CONTINUABLE_FINDINGS`, because that follows the last round, its new
  findings have no resolutions, and D1 could finalize the review with no
  reviewer having checked the ruling;
- in `HUMAN_REQUIRED`, because disputes go to arbitration;
- in `CLEAN` and `LOCAL_GATE_PASSED`, because no round follows.

Every W1 ruling is therefore followed by a rereview that checks it. Under the
lock, `prepare_rereview` closes the window, so no ruling can be recorded
after the next round's snapshot exists. The rulings that apply to a round
are fixed when it is captured, which is why rulings need no served-watermark
like errata. The reviewer receives them through `open_review`, as it receives
the requirement. The server does not witness that delivery, because a
verdict can be submitted without an open, exactly as for the requirement
today.

A ruling is not a transition. It is saved without the transition stamp, like
an erratum, so `wait_for_review_state` does not wake for it. The exception
is a ledger written before the stamp existed, where the wait's legacy
fallback wakes on any `state_version` change, as it does for errata.

#### Ledger shape and version

`review.rulings` is an array. It is absent or empty when there are no
rulings, and it holds at most 100 entries, carried ones included:

```json
{
  "id": "R-001",
  "at": "<ISO timestamp>",
  "round": 1,
  "operator_label": "<label>",
  "finding_ids": ["F-003"],
  "text": "<ruling>"
}
```

A carried entry also has `continued_from_review_id`, the ledger it was
recorded in, kept through chains of continuations as errata keep theirs.
Its `finding_ids` refer to that ledger. They are provenance, not scope. A
continuation carries only the source's open findings, so the finding a
ruling decided may not reach the next reviewer. The ruling's text must
therefore state the resulting behavior in full, without relying on the
finding's text.

Per CONTRIBUTING step 7, a ledger that holds a ruling is written as
**version 2**. A released reader would act on it wrongly. Its
`open_review` would serve round two, or a continuation's round one, without
the rulings. Its continuation would drop them, and its arbitration export
would omit them. Nothing else stops a released server here, because a ruling
changes no status. RFC 0005's lens round was protected by its new status;
rulings have none. `SUPPORTED_REVIEW_VERSIONS` becomes `[1, 2]`. A
ledger with no ruling stays version 1, so a review that uses neither change
stays readable by released installs. The first recorded or carried ruling
sets the version.

Readers fall into three groups:

- **0.27.0 up to the D2 release** read version 1 only and refuse version 2
  with `LEDGER_VERSION_UNSUPPORTED` (#233), so they fail closed.
- **Releases before 0.27.0** check no version. They would read a version 2
  ledger by their own rules and serve a rereview without its rulings.
- **The D2 release and later** read both versions.

So every install sharing the store must run the D2 release before the first
ruling is recorded. An install at 0.27.0 or later that missed the upgrade
fails closed; one older than 0.27.0 does not.

#### How rulings reach the reviewer

`publicReview` adds `rulings`. It is always an array, empty when there are
none, so `get_review`, `open_review` (through `reviewerReview`), and the
reviewer tools' responses carry it. It is served in every round,
including a continuation's round one, beside the requirement. It is not
withheld the way `rationale` is in round one. The rationale is the author's
argument for the design and could bias the first findings. A ruling is scope:
it is part of what the change must satisfy. In a lens round, every run is
served the same rulings, because no window is open during the round.

Rulings are not part of the snapshot commitment. The requirement stays
immutable and keeps binding the hash. A ruling is a separate record whose
window closes before the round it governs is captured.

#### What a ruling may say

The reviewer skill treats reviewer-directed text in the requirement, scope,
rationale, commit messages, errata, or author responses as a finding. A
ruling is reviewer-directed by design, so it becomes a second bounded
exception, beside reviewer-guidance files in the diff. The reviewer
surfaces (the Codex, Hermes, and DeepSeek Harness reviewer skills and
`templates/claude-extension/REVIEW_INSTRUCTIONS.md`) gain one paragraph,
pinned on all four by `scripts/dispatch-contract.mjs`:

- **Binding.** A ruling decides behavior or a trade-off raised by the
  findings it names, or it amends or replaces a requirement clause. A later
  ruling may also replace or withdraw an earlier one by naming its ID. The
  reviewer applies the rulings in ledger order to the requirement, and the
  result is the effective scope. The reviewer does not raise again a
  trade-off that scope decides. A replaced or withdrawn ruling stays in the
  record and binds nothing.
- **Checked.** The reviewer checks the code against the effective scope and
  raises a finding where the code contradicts it. A superseded clause
  produces no contradiction finding. For a finding a ruling names, the
  reviewer decides it under the ruling: if the code satisfies the ruled
  behavior, it is `resolved` or `rebuttal_accepted`, and `verification`
  cites the ruling and the code read. The link is the ruling's
  `finding_ids`, not the resolution text, which was written before the
  ruling existed.
- **Bounded.** A ruling may not tell the reviewer to skip files, areas, or
  review dimensions. It may not lower or cap severities, declare a finding
  resolved without code that carries it, or change the review protocol. A
  ruling, or the part of one, that tries is a finding of severity `major`,
  and the reviewer does not follow that part. Major keeps an overreaching
  ruling from passing under D1. For example, "tests are kept few" as a
  blanket rule skips a review dimension, so it is a finding. A ruling that
  a named finding's requested test is not wanted decides a trade-off. An
  overreaching ruling is cured by a later ruling that withdraws it. The
  next round's reviewer then resolves the finding, which no code change
  could cure. If the major is raised in round two, the review continues, and
  the continuation carries the offending ruling. Its round one raises the
  finding again, and the withdrawal goes in its W1. A fresh review that is
  not a continuation carries no rulings at all.
- Text addressed to the reviewer anywhere else is still a finding. A
  ruling does not open a channel through the requirement or the resolutions.

#### Continuations

A continuation must repeat its source's `requirement` exactly
(`prepareReview`'s same-requirement refusal), and that rule stays. The
requirement text is unchanged and bound into the snapshot hash. Its
amendments travel beside it: `freezeContinuationSource` takes the source's
rulings under the source's lock, together with its errata and carried
findings, and `prepareReview` writes them into the continuation's ledger.
The copies are renumbered `R-001` onward in the new
ledger, and each keeps its origin's `continued_from_review_id`. The
continuation can record its own rulings in its own W1.

A successor review does not inherit its parent's rulings. A successor is a
new review of a delta, under a requirement the author states for it. If a
decision should still bind, that requirement states it. That is today's #206
guidance, and it applies here unchanged.

Rulings change what the parent was gated against, though, and the successor
proof compares raw requirement strings. Suppose a parent was gated under a
ruling that relaxed a clause, and a child repeats the original requirement.
The proof would report `requirement_match: true`, and a delta that does not
touch the affected code would leave the parent's relaxed code unreviewed
against the stricter clause. So `buildSuccessorArtifacts` sets
`requirement_match` to false whenever the parent or the review being
prepared holds a ruling. The reviewer skill already tells the reviewer to
read the already-gated code the requirement bears on when the match is
false. Where a match is required, the strategy falls back to `FULL` with
today's "must use the same requirement" reason. That covers an explicit
parent, and a successor review's own `prepare_rereview` after a W1 ruling
when its parent was explicit. The same rule covers a W1 ruling that amends
a successor review's own scope before round two.

#### Report and arbitration export

- The human arbitration export gains `rulings` in its structured data and a
  "Maintainer rulings" section in its Markdown, labeled as maintainer
  decisions recorded under an operator label. Its `schema_version` stays 1,
  because the field is additive in a read-only export.
- The full report prints each ruling: ID, operator label, time, round,
  named findings, origin review for carried ones, and text, in the fenced
  form the report uses for other free text. The brief prints one line with
  the count, IDs, and labels. `REPORT_FORMAT` advances again.
- The summary and the scorecard do not change.

#### Author workflow skill

The #206 guidance (`references/finish.md`, `references/prepare.md` step 2,
and the "Common boundaries" bullet) currently sends every ruling into a new
review's requirement, prepared as a new review rather than a continuation.
It changes as follows:

- **Between rounds, in W1.** When the user decides a finding's trade-off or
  corrects a requirement clause, record it with `record_maintainer_ruling`.
  The text states the user's decision faithfully and in full, as a property
  of the change, and does not depend on the finding's text. It names the
  findings it decides. `operator_label` names the human who decided. Then
  call `prepare_rereview` as usual. Never put the decision in resolution
  text, and never record a ruling the user did not make. To undo a ruling,
  record one that withdraws it by ID.
- **After the last round, or after arbitration.** For a decision made at
  `CONTINUABLE_FINDINGS` or from a `HUMAN_REQUIRED` arbitration, the #206
  path stays: the next review's requirement states the ruled behavior. A
  decision at `CONTINUABLE_FINDINGS` can instead wait for the continuation's
  own W1.
- `references/findings.md` names W1 at step 4.

### Trust

A ruling cannot be proven to come from a human. `operator_label` is a label,
not authentication. Any process that can call the author tools can record a
ruling under any label. That is the trust `authorize_remote_publication`
and `acknowledge_codex_review_ambiguity` already have, and this RFC does not
change it.

A misused ruling **can** make the next reviewer accept a trade-off, or an
amended clause, that it would otherwise hold against the change. A finding
it names can then be decided `resolved` or `rebuttal_accepted` when it
would have stayed open.

A misused ruling **cannot**:

- change a finding's status or severity, or the review status;
- skip a round or mint a gate;
- direct the reviewer outside the bounds above without that becoming a
  major finding;
- hide itself, because it is in the ledger, every reviewer's `open_review`,
  the arbitration export, and the report;
- reach a review outside its continuation chain.

It is weaker than `authorize_remote_publication`, which skips local review
altogether under the same trust.

### State invariants

1. A review that records no ruling and is never finalized under D1 has the
   same ledger, summary, and gate fields as in the current release, apart
   from `rulings: []` in reads.
2. `finalize_local_gate` mints a gate only from `CLEAN` or from a review the
   predicate allows. The gate attests the last round's snapshot, and every
   finding left open is listed in it and is minor or nit.
3. No tool changes a finding's severity, and no ruling changes a finding's
   status or the review status.
4. Rulings are recorded only in W1, so every ruling is followed by a
   rereview. The rulings that apply to a round are fixed when the round, or
   its continuation, is created.
5. A ledger holding a ruling is version 2. A continuation carries every
   ruling of its source, and a successor carries none. A successor proof
   reports `requirement_match: false` whenever either side holds a ruling.

### What this RFC does not add

No review status, no finding category or field, no round, no ruling kind,
no new gate version, no history event, no summary field, no driver action
for rulings, and no ruling window outside W1.

## Security considerations

D1 lets findings the reviewer rated minor or nit reach publication
unfixed. Severity is the reviewer's judgment. A defect rated minor that is
really major passes the local gate. Codex's GitHub review and the required
checks are later chances to catch it, but nothing guarantees either does,
so it can survive both. The author cannot lower a severity. Because the
open findings are listed in the gate, an auditor can see what was accepted.

D2 adds author-side text that the reviewer obeys. The bounds are judged by a
model, not enforced by the server, so a ruling written to look in-bounds
could still narrow a review. The controls are visibility, the major finding
for overreach, the requirement that the code match every ruling, and the
single window. At rest, rulings live in the review ledger, under the
operator's OS user, as errata do. Their full text goes to every reviewer
through the reviewer tools, to the report, and to the arbitration export,
which is meant to be handed to a human or an externally coordinated
reviewer. So a ruling should hold nothing that may not leave the machine
in those ways. Trust is discussed above.

## Backward compatibility

- **D1.** No ledger or gate version changes. A released server's summary
  of an eligible review reports today's action, and its
  `finalize_local_gate` refuses that review, so it does not offer D1. A
  released server reading a gate minted under D1 accepts it for
  publication. That is the intended decision, since publishing the gated
  head is what D1 allows. A released report or scorecard calls such a review
  clean. That is a projection and changes no state, so it needs no version
  bump. Read D1 measurements with an upgraded scorecard.
- **D2.** A ledger with rulings is version 2. Releases from 0.27.0 refuse
  it in publication, continuation, the reviewer tools, and the arbitration
  export. Their successor-parent selection skips it, because
  `automaticParentCandidates` drops ledgers it cannot load. Releases before
  0.27.0 check no version and would misread it (see Ledger shape and
  version). In a store shared by mixed versions, record rulings only after
  every install runs the D2 release. Ledgers without rulings are unaffected.
- A newer server reads every older ledger and every gate.

## Drawbacks

- The local gate no longer means "no findings open". Readers that equate
  `LOCAL_GATE_PASSED` with clean, inside and outside this repository, have
  to check `open_findings` or the ledger.
- An author dispute of a minor finding passes without human arbitration.
- A ruling is reviewer-directed text whose bounds rest on model judgment.
- The first ruling in a ledger forces every install sharing the store to be
  upgraded before the ledger can be read there.
- A decision made after the last round still has no ruling window. It waits
  for a continuation's W1 or goes into a new review's requirement.

## Alternatives considered

- **Raise `MAX_ROUNDS`.** Pattern 1 grows with rounds: each round that
  changes a test brings new test findings. Raising it adds cost and round
  directories, and it changes a rule every workflow surface states ("Never
  add a third round"). It does nothing for a wrong requirement clause.
- **A test-finding category.** It would need a new field and a reviewer
  classification. The tally shows severity already separates test findings,
  because none left open is major.
- **Rulings in resolution text.** The rereviewer refused this correctly in
  the field report. Making resolution text binding would remove the boundary for all
  author text. A separate record keeps the boundary and bounds the exception.
- **A human override after the last round.** This is a non-goal. It would let
  operator-label trust alone close a major or blocker finding, and
  `export_human_arbitration` already serves disputes.
- **Today's #206 path for every ruling.** A new review with the ruled
  requirement drops the continuation link and the carried findings, and it
  needs a new review ID for every decision.
- **A new status for a round-limit gate.** Every reader, including released
  allow-lists, the summary, the report, and the scorecard, would have to learn
  it. A predicate over existing fields gives the same result with no new
  state.
- **A `gated_snapshot_hash` field.** Rejected for the same reason, as
  described under Finalization.

## Unresolved questions

None.

## Test plan

**D1** (each test fails if its behavior is removed):

- `finalize_local_gate` mints a gate for a round-two `CONTINUABLE_FINDINGS`
  review and for a round-two `HUMAN_REQUIRED` review whose open findings are
  minor or nit. The gate's `open_findings` lists them, and
  `clean_snapshot_hash` and the gated head are round two's. One of these
  ledgers also holds a resolved major and a rebuttal-accepted blocker, and
  the gate lists only the open findings.
- It refuses when one open finding is major or blocker, at round one in
  `HUMAN_REQUIRED` after an author escalation, on a continued source, and
  when the working tree changed.
- With `gate.json` written and the ledger still `CONTINUABLE_FINDINGS`, as
  after a crash between the two writes, a continuation is refused and a
  retried finalization completes.
- The report flags a gate whose `open_findings` differs from the ledger's
  open findings.
- The summary reports `FINALIZE_LOCAL_GATE` exactly when the predicate holds,
  and after finalization `active_findings` still lists the open findings.
- A `CLEAN` gate has no `open_findings` key.
- `start_publication` accepts a D1 gate with today's publication code.
- A D1-gated review is selected as a successor parent, and its proof
  verifies.
- The report renders the gated-with-open-findings outcome and the next-step
  line. The scorecard counts the review in `gated_with_open_findings` and
  not as clean.

**D2:**

- A ruling is accepted in W1 and refused in every other status, including
  `CONTINUABLE_FINDINGS`. A stale `expected_state_version` is refused, as is
  an unknown or duplicate finding ID.
- A ruling advances `state_version` and not `last_transition_state_version`,
  and the ledger becomes version 2.
- A ruling recorded in W1 is served by round two's `open_review`. A
  continuation carries it renumbered, with its origin, and serves it in round
  one. A successor of a ruled review carries none.
- `prepare_rereview` closes the window: a ruling attempted after it is
  refused.
- A successor whose parent holds a ruling, with requirement text identical
  to the parent's and a delta that does not touch the ruled code, gets
  `requirement_match: false`. With an explicit parent it falls back to
  `FULL`. A W1 ruling on a successor review with an explicit parent makes
  its round two `FULL`.
- A ruling that withdraws an earlier ruling by ID is recorded, and both
  stay in the ledger and the report.
- A server built from the current release refuses a version 2 ledger.
- The arbitration export and both report tiers show rulings.
- The dispatch contract pins the ruling paragraph on all four reviewer
  surfaces.

## Rollout plan

Two implementation pull requests, D1 first.

| Pull request | Contents | Estimate |
| --- | --- | --- |
| 1. D1 | predicate, `finalize_local_gate`, gate `open_findings`, continuation refusal on a minted gate, `actionRequired`; report (`REPORT_FORMAT` 13, gate comparison) and scorecard (schema 6); author-server instructions and the `finalize_local_gate` description in `src/server.mjs`; `docs/reference.md`, README, `docs/review-flow.md`, and `docs/local-review.md`, with version labels unchanged; workflow skill `finish.md`, `findings.md`, and common boundaries; tests | ~500 lines |
| 2. D2 | tool and input schema; ledger field, W1, version 2; `publicReview`; continuation carry; successor `requirement_match`; arbitration export; report; four reviewer surfaces and dispatch contract; workflow skill; reference and guides; tests | ~850 lines |

**Measurement.** Run the read-only tally again over reviews created after
each release, against the 2026-11-01 to 2026-11-27 baseline. The cohort is
fixed at the round-two verdict: reviews whose round-two verdict event,
`REREVIEW_CONTINUABLE_FINDINGS` or `REREVIEW_UNRESOLVED`, left only minor or
nit findings open. Later continuations and gates are counted separately,
because the live predicate stops matching once either happens.

- The share of round-two non-`CLEAN` verdicts that were eligible at the
  verdict (baseline 61 of 109). After D1 ships, also count how many of
  those were then finalized and how many were continued.
- The ratio of `LOCAL_GATE` to `REMOTE_ONLY` publications (baseline 9 to 22).
  D1 succeeds if gated publications rise. A gate skipped because minor
  findings blocked it should become rare.
- After D2 ships: rulings recorded per review, the share of ruled reviews
  that reach `CLEAN` or a D1 gate, round-two findings that restate a decided
  trade-off (sampled by hand), and overreach findings raised against rulings.
- Track the worst-open-severity distribution. If D1 is gamed by
  under-rating, minor findings will grow at the expense of major ones.
