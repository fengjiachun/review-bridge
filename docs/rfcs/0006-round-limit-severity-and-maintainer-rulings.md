# RFC 0006: Round-limit severity cutoff and maintainer rulings

| Field | Value |
| --- | --- |
| Status | Draft |
| Authors | Review Bridge contributors |
| Created | 2026-11-27 |
| Target release | TBD |

## Summary

Two changes to local review.

**D1.** A review that has used its last round, and whose open findings are
all `minor` or `nit`, can be finalized by `finalize_local_gate`. Today only
`CLEAN` can. The open findings are listed in the gate, the review summary,
and the report. No status, round, or finding category is added.

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
`CONTINUABLE_FINDINGS` (63) or `HUMAN_REQUIRED` (46). The worst severity
left open at that verdict, counting a finding as closed when its status is
`RESOLVED` or `REBUTTAL_ACCEPTED`, was:

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
("latest", "attest", "attestations"). Of 31 publications started in the same
period, 9 came through a local gate and 22 were `REMOTE_ONLY`.

## Goals

- Stop minor and nit findings from blocking the local gate once the review
  has no round left, while keeping them visible.
- Make test findings warn without blocking, through D1 alone (see Test
  findings).
- Give a maintainer decision made between rounds a recorded, bounded channel
  to the next reviewer, including a correction to a requirement clause.
- Add as little state as possible, and leave reviews that use neither change
  as they are today.

## Non-goals

- A **human override after the last round**: a ruling recorded after round
  two that closes open `blocker` or `major` findings. `export_human_arbitration`
  stays the path for disputes. A ruling never changes a finding's status in
  any round.
- Any state beyond the gate's `open_findings` and the ledger's `rulings`:
  no review status, finding category or field, round, ruling kind, gate
  version, history event, summary field, driver action for rulings, or
  ruling window outside W1.
- Changing how D1 treats findings before the last round. Minor findings in
  round one still go through resolution and rereview.
- Authenticating the maintainer (see Trust).
- Any change to what the publication gate or the `REMOTE_ONLY` path decides.

## Design

### D1: Finalizing at the round limit

#### Predicate

An **open finding** is an entry in `findings` whose status is not
`RESOLVED` or `REBUTTAL_ACCEPTED`, the same set the summary's
`active_findings` lists today. A review is **finalizable at the round
limit** when all of these hold:

1. `status` is `CONTINUABLE_FINDINGS` or `HUMAN_REQUIRED`;
2. `current_round` equals the ledger's `max_rounds`;
3. `continued_by_review_id` is null, so no continuation has frozen it;
4. every open finding has `severity` `minor` or `nit`.

Severity is the one the reviewer submitted. `normalizeFinding` validates it
and no tool changes it, so the author cannot lower it. `carried_findings`
do not count: they are scope hints from the source review, and the
continuation's reviewer raises again whatever is still present. In today's
code the predicate can hold only in round two. Only the initial review sets
`REVIEW_SUBMITTED`, so an author's `human_required` answer occurs only in
round one, and a round-two `HUMAN_REQUIRED` comes from `REREVIEW_UNRESOLVED`.
Rule 4 covers disputed and undisputed findings alike, as the owner decided.

One exported function in `src/core.mjs` computes the predicate, for the
summary, `finalize_local_gate`, and the report's next-step line. It decides
eligibility before finalization only. After `LOCAL_GATE_PASSED` rule 1 no
longer holds, and readers recognize a review gated with open findings by
its open findings (see Report and scorecard).

#### Finalization

`finalize_local_gate` accepts `CLEAN`, as today, or a review for which the
predicate holds. In the second case the gated round is `rounds.at(-1)`, the
snapshot the last reviewer judged. Finalization runs today's checks against
it (successor artifacts, stored patch hash, live working tree) and, in the
write that sets `LOCAL_GATE_PASSED`, sets `clean_snapshot_hash` to that
round's `snapshot_hash`. The field's meaning widens from "the snapshot
judged clean" to "the snapshot the gate attests", which is how every reader
already uses it: successor parent selection, finalization,
`localGateReviewMismatch`, and the report. None of them, released servers
included, reads the field differently. A finalized review can be neither continued nor
sent to arbitration, as today, and rule 3 refuses a review that already has
a continuation.

Finalization writes `gate.json` before it saves the ledger status, as today,
and this RFC keeps that order. A crash between the two writes leaves the
review in its earlier status beside a `gate.json` that nothing accepts:
`validateOpenedLocalGate` refuses a gate unless the review is
`LOCAL_GATE_PASSED`, and the report and successor-parent selection read a
gate only for a review in that status. A retry finalizes again while the
predicate holds. If a continuation froze the review first, the stray file
stays inert and the work goes on in the continuation.

#### Attestation

`gate.json` gains `open_findings`: one `{id, severity, status}` per open
finding, in ledger order, present only when the list is not empty. A gate
minted from `CLEAN` keeps today's fields. The gate stays version 1, because
a released reader ignores the field and makes the right decision, which is
to publish the gated head.

The list is checked in two places. The publication gate binds the local
gate's bytes through `local_gate_sha256`, so a publication commits to the
list as written, without comparing it with the ledger. The report does
compare it. `normalizedLocalGate` carries `open_findings` from the gate
object it already validated, so the list compared is the one whose bytes
were hashed, and `localGateReviewMismatch` compares it with the ledger's
open findings, for published and standalone gates alike. The report fails
on a difference as it does for the other attested fields. Publication
copies authorization fields into its ledger by name (`startPublication`)
and compares bound authorizations by named fields, so the extra field
changes nothing publication stores or decides.

The summary needs no new field: `active_findings` lists the open findings,
before and after `LOCAL_GATE_PASSED`.

#### Next action

`actionRequired` reads the review instead of the status alone. When the
predicate holds, `get_review_summary` (and therefore `wait_for_review_state`)
reports `action_required: FINALIZE_LOCAL_GATE`, the action `CLEAN` already
reports, with today's `required_inputs`. Otherwise every status keeps
today's action.

The other paths stay open until the gate is minted. A continuation can still
be prepared from an eligible `CONTINUABLE_FINDINGS` review, and an eligible
`HUMAN_REQUIRED` review can still be exported for arbitration. The summary
names the default, not the only option.

#### Lens and successor reviews

A lens review (RFC 0005) reaches round two through today's protocol, so the
predicate applies unchanged, lens findings count like any other, and
nothing changes in round one. A successor review has two rounds like any
other and is treated the same way. A review gated with open findings is a
valid successor parent. The successor's delta reviewer is not shown the
parent's open findings, because the parent's gate accepted them; they stay
listed in that gate, which the successor proof binds by
`parent_gate_sha256`. Parents that hold rulings are covered under D2
(Successors).

#### Report and scorecard

The report and the scorecard count every `LOCAL_GATE_PASSED` review as clean
today (`CLEAN_STATUSES` in `src/report.mjs` and `src/scorecard.mjs`). That
would misstate a review gated with open findings and hide D1 from its own
measurement. Both therefore treat a `LOCAL_GATE_PASSED` review with an open
finding as **gated with open findings**.

- **Report.** For such a review, the outcome section says it was gated at
  the round limit with N findings open, in place of "Rounds to CLEAN", and
  labels the snapshot "Gated snapshot". The open findings appear where the
  report already lists findings still open. For an eligible review not yet
  finalized, the next-step line says the local gate can be finalized next
  with N minor or nit findings left open. `REPORT_FORMAT` becomes 13.
- **Scorecard.** Such a review is not counted in `rounds_to_clean` or the
  Clean columns. It is counted in a new `gated_with_open_findings` total and
  still appears in `reviews_by_status`. `SCORECARD_SCHEMA_VERSION` becomes 6.

#### Publication

Publication decides nothing differently. `validateOpenedLocalGate` requires
a version 1 gate, with a matching review ID and provider, for a review in
`LOCAL_GATE_PASSED`. `localGateReviewMismatch` compares the gate's base and
head with `rounds.at(-1)` and its snapshot with `clean_snapshot_hash`. A D1
gate meets both. `authorize_remote_publication` never reads a review ledger.
Codex's GitHub review may raise an open local finding again, and the author
handles it as ordinary review feedback.

#### Test findings

No test-finding category is added. All 77 open findings that the
whole-word `test` match in Motivation selects are minor or nit. For those,
D1 alone makes test findings warn without blocking at the round limit. A
test finding the match misses, or a future major test finding, is treated
like any other finding of its severity, so a major one still blocks. A
category would need a reviewer-side classification and a field, and on the
sampled rows severity already does the job.

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

It returns the compact summary, as `append_review_erratum` does. The server
checks the window, the inputs, and the state version. It cannot check that
a human made the decision, so that is an obligation of the author workflow
(see Author workflow skill and Trust). No summary or `required_inputs` entry
names the tool, so a driver following next actions never reaches it.

There is no `kind` field. Whether a ruling decides a trade-off or amends a
clause is in its text, and the reviewer judges its bounds either way.

#### When it is accepted

The tool takes the review's mutation lock and accepts a ruling in one
window, **W1**: `status` is `AUTHOR_RESPONDED` and `current_round` is less
than `max_rounds`. The round's verdict and the author's resolutions are on
record, and the next round has not been captured. With `MAX_ROUNDS = 2`, this
is the gap between round one and round two of a review, a continuation
included.

It is refused in every other state:

- in `WAITING_FOR_REVIEW`, `WAITING_FOR_LENS_REVIEW`, and
  `WAITING_FOR_REREVIEW`, because a reviewer may already be reading the
  round;
- in `REVIEW_SUBMITTED`, because the author has not yet answered;
- in `CONTINUABLE_FINDINGS`, because that follows the last round, its new
  findings have no resolutions, and D1 could finalize the review with no
  reviewer having seen the ruling;
- in `HUMAN_REQUIRED`, because disputes go to arbitration;
- in `CLEAN` and `LOCAL_GATE_PASSED`, because no round follows.

Under the lock, `prepare_rereview` closes the window, so no ruling can be
recorded after the next round's snapshot exists. A W1 ruling therefore
applies to the review's next round, if one is prepared, and the rulings
that apply to a round are fixed when it is captured. That is why rulings
need no served-watermark like errata.

A ruling is not a transition. It is saved without the transition stamp, like
an erratum, so `wait_for_review_state` does not wake for it. The exception
is a ledger written before the stamp existed, where the wait's legacy
fallback wakes on any `state_version` change, as it does for errata.

#### Ledger shape and version

`review.rulings` is an array, absent or empty when there are none, of at
most 100 entries, carried ones included:

```json
{"id": "R-001", "at": "<ISO timestamp>", "round": 1,
 "operator_label": "<label>", "finding_ids": ["F-003"], "text": "<ruling>"}
```

A new ruling takes the next unused `R-` number in its ledger. Carried
entries keep their IDs and gain `continued_from_review_id`, the ledger they
were recorded in, kept through chains of continuations as errata keep
theirs (see Continuations). A ruling that names an earlier one by ID
therefore still names it after any number of continuations. `finding_ids`
refer to the origin ledger and are provenance, not scope. A continuation
carries only the source's open findings, so the finding a ruling decided
may not reach the next reviewer. The ruling's text must therefore state the
resulting behavior in full, without relying on the finding's text.

Per CONTRIBUTING step 7, a ledger that holds a ruling is written as
**version 2**, set by the first recorded or carried ruling. A reader that
ignored the field would act on it wrongly: its `open_review` would serve the
next round without the rulings, its continuation would drop them, and its
arbitration export would omit them. Nothing else stops it, because a ruling
changes no status, where RFC 0005's lens round had its own status to protect
it. `SUPPORTED_REVIEW_VERSIONS` becomes `[1, 2]`, and a ledger with no
ruling stays version 1.

Installs sharing one store fall into three groups:

- **Releases before 0.27.0** check no ledger version. They would read a
  version 2 ledger by their own rules and serve a round without its rulings.
- **0.27.0 up to the D2 release** refuse version 2 with
  `LEDGER_VERSION_UNSUPPORTED` (#233). They fail closed on a ruled review
  and handle every other review as today.
- **The D2 release and later** read both versions.

So the floor for safe coexistence is 0.27.0. Every install sharing the store
must run 0.27.0 or later before the first ruling is recorded, and only the
installs that work on a ruled review need the D2 release. A rolling upgrade
from 0.27.0 is therefore safe.

#### How rulings reach the reviewer

`publicReview` adds `rulings`. It is always an array, empty when there are
none, so `get_review`, `open_review` (through `reviewerReview`), and the
reviewer tools' responses carry it. It is served in every round, including a
continuation's round one, beside the requirement. The reviewer protocol
requires calling `open_review`, but the server does not witness the
delivery, because a verdict can be submitted without an open, as for the
requirement today. Rulings are not withheld the way `rationale` is in round
one. The rationale is the author's argument for the design and could bias
the first findings. A ruling is scope: it is part of what the change must
satisfy. In a lens round, every run is served the same rulings, because the
window is closed during the round.

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
pinned on all four by `scripts/dispatch-contract.mjs`. This section is the
one statement of these rules; other sections refer to it.

- **Effective scope.** A ruling decides behavior or a trade-off raised by
  the findings it names, or it amends or replaces a requirement clause. A
  later ruling may replace or withdraw an earlier one by naming its ID. The
  reviewer applies the rulings in ledger order to the requirement, and the
  result is the effective scope. A replaced or withdrawn ruling stays in the
  record and binds nothing. The reviewer does not raise again a trade-off
  the effective scope decides.
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
  a named finding's requested test is not wanted decides a trade-off.
- Text addressed to the reviewer anywhere else is still a finding. A
  ruling does not open a channel through the requirement or the resolutions.

An overreaching ruling cannot be cured by changing code. If the finding is
raised in round one, a W1 ruling withdraws the offender and round two
resolves the finding. If it is raised in round two of a review that ends
`CONTINUABLE_FINDINGS` and a code change is due anyway, the continuation
carries the offender, its round one raises the finding again, and its W1
withdraws it. `prepareReview` requires a continuation head that changed and
descends from the source head. Otherwise, after `HUMAN_REQUIRED` or once a
chain holds 100 rulings, the cure is arbitration or a fresh review that is
not a continuation. Such a review carries no rulings, and its requirement
states whatever decisions should still bind, under today's #206 guidance.

#### Continuations

A continuation must repeat its source's `requirement` exactly
(`prepareReview`'s same-requirement refusal), and that rule stays. The
requirement text is unchanged and bound into the snapshot hash. Its
amendments travel beside it. `freezeContinuationSource` takes the source's
rulings under the source's lock, together with its errata and carried
findings, and `prepareReview` writes them into the continuation's ledger in
order, with their IDs unchanged. The continuation then records its own
rulings in its own W1.

#### Successors

A successor review does not inherit its parent's rulings. It is a new
review of a delta, under a requirement the author states for it; if a
decision should still bind, that requirement states it, under today's #206
guidance.

Rulings do change what the parent was gated against, and the successor
proof compares raw requirement strings. If a parent was gated under a
ruling that relaxed a clause and a child repeats the original requirement,
the proof would report `requirement_match: true`, and a delta that does not
touch the affected code would leave the relaxed code unreviewed against the
stricter clause. So two requirements **match** only when their texts are
equal and neither the parent nor the review being prepared holds a ruling.
The one rule serves both places that compare requirements:

- `buildSuccessorArtifacts` records `requirement_match: false` on a
  mismatch, and the reviewer skill already tells the reviewer to read the
  already-gated code the requirement bears on in that case. Where a match
  is required, which covers an explicit parent and the rebuilt proof in a
  successor's `prepare_rereview` after a W1 ruling, the strategy falls back
  to `FULL` with today's "must use the same requirement" reason.
- `automaticParentCandidates` ranks by the same match before distance, so
  an unruled parent with the same text outranks a nearer ruled one.

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

- **In W1.** When the user decides a finding's trade-off or corrects a
  requirement clause, record it with `record_maintainer_ruling`. The text
  states the user's decision faithfully and in full, as a property of the
  change, without depending on the finding's text, and names the findings it
  decides. `operator_label` names the human who decided. Then call
  `prepare_rereview` as usual. Never put the decision in resolution text,
  and never record a ruling the user did not make. To undo a ruling, record
  one that withdraws it by ID.
- **Outside W1.** A decision from a `HUMAN_REQUIRED` arbitration takes the
  #206 path. A decision made at `CONTINUABLE_FINDINGS` waits for the
  continuation's W1 or takes the same path.
- `references/findings.md` names W1 at step 4.

### Trust

A ruling cannot be proven to come from a human. `operator_label` is a label,
not authentication, and any process that can call the author tools can
record a ruling under any label. That is the trust
`authorize_remote_publication` and `acknowledge_codex_review_ambiguity`
already have, and this RFC does not change it.

A misused ruling **can** make the next reviewer accept a trade-off, or an
amended clause, that it would otherwise hold against the change, so a
finding it names is decided `resolved` or `rebuttal_accepted` when it would
have stayed open. It **cannot** change a finding's status or severity or the
review status, skip a round, or mint a gate. It cannot direct the reviewer
outside the bounds in What a ruling may say without that becoming a major
finding, or hide itself, because it appears in the ledger, every reviewer's
`open_review`, the arbitration export, and the report. Nor can it reach a
review outside its continuation chain. It is weaker than
`authorize_remote_publication`, which skips local review altogether under
the same trust.

### State invariants

1. A review that records no ruling and is never finalized under D1 has the
   same ledger, summary, and gate fields as in the current release, apart
   from `rulings: []` in reads.
2. `finalize_local_gate` mints a gate only from `CLEAN` or from a review the
   predicate allows. The gate attests the last round's snapshot and lists
   every open finding, each minor or nit.
3. No tool changes a finding's severity, and no ruling changes a finding's
   status or the review status.
4. Rulings are recorded only in W1. The rulings that apply to a round are
   fixed when the round, or its continuation, is created.
5. A ledger holding a ruling is version 2. A continuation carries every
   ruling of its source with its ID, and a successor carries none.

## Security considerations

D1 lets findings the reviewer rated minor or nit reach publication unfixed.
Severity is the reviewer's judgment, and the author cannot lower it, so a
defect rated minor that is really major passes the local gate. Codex's
GitHub review and the required checks are later chances to catch it, but
nothing guarantees either does, so it can survive both. Because the gate
lists the open findings, an auditor can see what was accepted.

D2 adds author-side text that the reviewer obeys. The bounds are judged by a
model, not enforced by the server, so a ruling written to look in-bounds
could still narrow a review. The controls are visibility, the rules in What
a ruling may say, and the single window. At rest, rulings live in the review
ledger under the operator's OS user, as errata do. Their full text goes to
every reviewer, to the report, and to the arbitration export, which is meant
for a human or an externally coordinated reviewer, so a ruling should hold
nothing that may not leave the machine that way. Trust is covered above.

## Backward compatibility

- **D1.** No ledger or gate version changes. A released server's summary
  of an eligible review reports today's action, and its
  `finalize_local_gate` refuses that review, so it does not offer D1. A
  released server reading a gate minted under D1 accepts it for
  publication, which is the intended decision. A released report or
  scorecard calls such a review clean. That is a projection and changes no
  state, so it needs no version bump. Read D1 measurements with an upgraded
  scorecard.
- **D2.** The version 2 rule and the 0.27.0 coexistence floor are in Ledger
  shape and version. From 0.27.0, successor-parent selection skips a
  version 2 parent, because `automaticParentCandidates` drops ledgers it
  cannot load.
  Ledgers without rulings are unaffected.
- A newer server reads every older ledger and every gate.

## Drawbacks

- The local gate no longer means "no findings open". Readers that equate
  `LOCAL_GATE_PASSED` with clean, inside and outside this repository, have
  to check `open_findings` or the ledger.
- An author dispute of a minor finding passes without human arbitration.
- A ruling is reviewer-directed text whose bounds rest on model judgment.
- A ruled review can be worked on only from the D2 release (see Ledger
  shape and version).
- A decision made after the last round has no ruling window of its own.

## Alternatives considered

- **Raise `MAX_ROUNDS`.** Pattern 1 grows with rounds: each round that
  changes a test brings new test findings. Raising it adds cost and round
  directories, and it changes a rule every workflow surface states ("Never
  add a third round"). It does nothing for a wrong requirement clause.
- **A test-finding category.** It would need a new field and a reviewer
  classification, for the reasons in Test findings.
- **Rulings in resolution text.** The rereviewer refused this correctly in
  the field report. Making resolution text binding would remove the
  boundary for all author text. A separate record keeps the boundary and
  bounds the exception.
- **A human override after the last round.** This is a non-goal. It would let
  operator-label trust alone close a major or blocker finding, and
  `export_human_arbitration` already serves disputes.
- **Today's #206 path for every ruling.** A new review with the ruled
  requirement drops the continuation link and the carried findings, and it
  needs a new review ID for every decision.
- **A new status for a round-limit gate.** Every reader, including released
  allow-lists, the summary, the report, and the scorecard, would have to learn
  it. A predicate over existing fields gives the same result with no new
  state. A `gated_snapshot_hash` field is rejected for the reason given in
  Finalization.

## Unresolved questions

None.

## Test plan

Each test fails if the behavior it names is removed.

**D1:**

- `finalize_local_gate` mints a gate for a round-two `CONTINUABLE_FINDINGS`
  review and a round-two `HUMAN_REQUIRED` review whose open findings are
  minor or nit. `open_findings` lists exactly them, even though one ledger
  also holds a resolved major and a rebuttal-accepted blocker, and the gated
  snapshot and head are round two's. A `CLEAN` gate has no `open_findings`.
- It refuses with an open major or blocker, at round one in
  `HUMAN_REQUIRED` after an author escalation, on a continued source, and
  after the working tree changed.
- With `gate.json` written and the ledger still `CONTINUABLE_FINDINGS`,
  `start_publication` and the report refuse the gate, and a retried
  finalization completes.
- The summary reports `FINALIZE_LOCAL_GATE` for `CLEAN` and both eligible
  final-round statuses, today's actions for ineligible ones, and still
  lists the open findings after finalization.
- `start_publication` accepts a D1 gate, storing the same authorization
  fields as for a `CLEAN` gate. A D1-gated review serves as a successor
  parent with a verifying proof.
- The report fails on a gate whose `open_findings` differs from the ledger,
  standalone and bound to a publication. It renders the gated-with-open
  outcome and next-step line, and the scorecard counts such a review in
  `gated_with_open_findings`, not as clean.

**D2:**

- A ruling is accepted in W1 and refused in every other status, including
  `CONTINUABLE_FINDINGS`, and after `prepare_rereview`. A stale
  `expected_state_version`, an unknown finding ID, and a duplicate are
  refused.
- A ruling advances `state_version` but not `last_transition_state_version`,
  makes the ledger version 2, and is served by round two's `open_review`.
- A continuation carries every ruling in order with its ID and origin and
  serves them in round one, and a withdrawal still names its target. In one
  case the ruled finding closed in round two and another finding caused the
  continuation; the child still receives the full text and origin finding
  ID. A successor of a ruled review carries none.
- With the same requirement text, a ruled parent and a delta that does not
  touch the ruled code give `requirement_match: false`, and an explicit
  ruled parent falls back to `FULL`, as does round two of a successor review
  with an explicit parent after a W1 ruling. Of two same-text candidates,
  the unruled one wins over a nearer ruled one.
- A server built from the current release refuses a version 2 ledger.
- The arbitration export and both report tiers show rulings, withdrawn ones
  included, and the dispatch contract pins the ruling paragraph on all four
  reviewer surfaces.

## Rollout plan

Two implementation pull requests, D1 first.

| Pull request | Contents | Estimate |
| --- | --- | --- |
| 1. D1 | predicate, `finalize_local_gate`, gate `open_findings`, `actionRequired`; `normalizedLocalGate` and the report's gate comparison; report (`REPORT_FORMAT` 13) and scorecard (schema 6); author-server instructions and the `finalize_local_gate` description in `src/server.mjs`; `docs/reference.md`, README, `docs/review-flow.md`, `docs/local-review.md`, and the state diagrams and routing text of `docs/overview.md` and `docs/overview.zh.md`, with version labels unchanged; workflow skill `finish.md`, `findings.md`, and common boundaries; tests | ~500 lines |
| 2. D2 | tool and input schema; ledger field, W1, version 2; `publicReview`; continuation carry; requirement match in successor proof and parent ranking; arbitration export; report; four reviewer surfaces and dispatch contract; workflow skill; reference and guides; tests | ~850 lines |

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
