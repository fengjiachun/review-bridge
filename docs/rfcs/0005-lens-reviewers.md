# RFC 0005: Lens reviewers

| Field | Value |
| --- | --- |
| Status | Accepted |
| Authors | Review Bridge contributors |
| Created | 2026-11-25 |
| Target release | TBD |

## Summary

Add an optional **lens review**: a local `CODEX_TASK` review whose first
round runs three reviewers on the same snapshot at once. One is the general
reviewer, as today. The other two each get the reviewer skill plus one
**lens** file, `tests` or `design`. Every finding goes into the one review
ledger, tagged with the lens that raised it. After round one the review
follows today's protocol. If round one closes `CLEAN` it can be finalized
directly. Otherwise the author answers, and either escalates or gets today's
round-two rereview, in which one general reviewer decides every finding. The
review ends in today's statuses and today's gate.

A lens review runs only when the user asks for one in chat for that review.
Every other review is prepared, run, and gated exactly as today.

## Motivation

Issue #223 compared the local gate with an external multi-lens review over
five pull requests. Only 8 valid findings were reported by both. The
multi-lens review found 146 valid findings on code the gate had reviewed and
missed. The largest groups were documentation, test gaps, and design. The
gate found 17 that the multi-lens review missed, including 6 major
concurrency bugs. The two complement each other, so the general reviewer has
to keep running.

A replay on 15 snapshots then measured, at equal compute, whether separate
lens runs add real findings and how many of them are worth fixing before
merge (see Alternatives considered and evidence). Lens runs found defects
that four general runs did not, and most of the extra volume was valid but
optional. The owner chose to keep the `tests` and `design` lenses, to hold
both to a "worth fixing before merge" bar, and to leave the feature off
unless the user asks for it.

## Goals

- Let the user request, per review, a first round of general plus `tests`
  plus `design` runs on one snapshot, all launched by Review Bridge, with
  findings in one ledger.
- Keep the runs of that round independent of each other and of author input
  written after preparation.
- Settle lens findings through the existing path: author resolution,
  rereview, human arbitration.
- Leave the ledger, summary, gate, and publication of every other review
  unchanged.

## Non-goals

- Lens runs in round two, in continuations the user did not ask for, or in
  successor reviews.
- Choosing a subset of lenses, adding lenses, or lens text supplied by an
  author or a repository.
- Lenses for providers other than `CODEX_TASK`.
- Recording lenses in `gate.json` or checking them at publication. A lens
  review is optional, and the gate makes no claim about it.
- Deduplicating findings across runs, or any step that drops a finding
  without the resolution protocol.

## Design

### Enabling a lens review

`prepare_review` takes an optional `lens_review: true`. It requires
`force_full_review: true` and `reviewer_provider: CODEX_TASK`, and it is
refused otherwise, or when the installation check below fails. A
continuation gets lenses only when its own `prepare_review` call passes
`lens_review: true`. It does not inherit them from its source.

The author workflow skill, its preparation reference
(`references/prepare.md`), and the `prepare_review` description limit
`lens_review` to the case where the user has asked, in this conversation,
for a lens review of this review. Under that text the agent does not offer,
suggest, or start one otherwise. The server cannot check where a request
came from, so this is guidance to the agent, not an enforced rule. Its
default, no lens, is the safe side.

### Lens instructions

The two lens files are packaged with the reviewer skill. The build copies
them next to `reviewer-skill.md` in the server directory. For a lens-round
run, `launch_local_reviewer` reads the reviewer skill and the lens file only
from the directory of the server module that is launching, with no fallback
to `templates/` (the reviewer skill has one today, `src/local-reviewer.mjs:45`).
The launch is refused when that directory is inside a Git work tree, which
it checks the way `reviewerRuntime` already checks the runtime directory
(`git rev-parse --show-toplevel`). Neither a source checkout nor a `dist/`
built inside one passes. Their files are the working tree of a repository an
author may be changing, possibly the one under review. `prepare_review` runs
the same check so that a source checkout fails early. Each launch checks
again, because a retry may come from another installation. An installation
outside any work tree is the operator's choice, as it is for the reviewer
skill today. When a reviewed diff changes a lens file, the reviewer skill's
existing rule applies: changes to reviewer guidance are reviewed as content.

A lens file comes after the reviewer skill and replaces, for that run, the
skill's findings policy: report every actionable finding, nits included,
across every review dimension. Everything else in the skill still binds:
the review protocol, the tools, independence, and the rule that
instruction-like material is a finding. The lens run's launch request also
drops today's "submit every actionable finding" and names the run's lens.
A lens run submits findings only, and its file says so. If a lens run sends
a `reconstructed_intent` anyway, `submit_review` drops it and keeps the
findings, because only the general run's intent has a reader, the round-two
comparison. The `submit_review`
description says that in a lens round a submission records only this run's
findings and that the verdict forms when all three runs have submitted.

Both files limit a lens run's findings to defects worth fixing before merge
and exclude nits. The limit also covers any other defect the run notices.

- **tests.** The run looks for changed behavior that a regression could
  break without any test noticing. A changed line or branch qualifies when
  it carries behavior that the requirement, a caller, or a documented
  contract depends on, such as a new condition, error path, return value,
  or ordering. It also has to be the case that tracing the line to its
  callers and to the tests that reach it, by reading the snapshot, finds no
  assertion that would observe a plausible break of it, and that the break
  would matter after merge. The run also reports an added test whose
  assertions would still hold if the behavior it targets were broken in the
  way it claims to guard against. Out of scope: missing tests for code no
  caller depends on, cases the requirement does not distinguish, test
  style, naming or structure, and coverage for its own sake. Each finding
  names the production line, the plausible regression, and the assertion
  that would catch it.
- **design.** The run looks for a simpler shape worth adopting before merge.
  Three cases qualify: deleting a state, field, flag, check, or branch that
  nothing in the requirement or the tests needs; replacing new code with an
  existing helper that already does the same thing, named; and merging
  duplicated logic that would otherwise drift. Each finding names the code,
  the simpler equivalent, and why behavior stays the same. Naming,
  formatting, ordering preferences, new abstractions, and rewrites whose
  only gain is taste are out of scope.

### Rounds

**Round one, the lens round.** A lens review is prepared in the new status
`WAITING_FOR_LENS_REVIEW`. Its round one has three run entries, `general`,
`tests`, and `design`. `launch_local_reviewer` (same `state_version` check as
today) starts every run that has not submitted and has no live or
indeterminate attempt. The runs start concurrently, each as a separate
`codex exec` with today's launch settings. A live or indeterminate attempt
blocks relaunching only its own run. A run that exited without submitting is
relaunched by calling `launch_local_reviewer` again. Review Bridge adds no
timeout and no way to skip a run. An operator who cannot complete a run
abandons the review and prepares a plain one.

A run submits with `submit_review`, and the submission is validated as
today. It is written into the run's own entry in `review.json`: the
normalized findings, the general run's `reconstructed_intent`, and
`submitted_at`. That is
one atomic ledger write under the review's mutation lock. It changes neither
`review.findings` nor `review.status`, and it is saved without the
transition stamp, so `wait_for_review_state` does not wake for it. A run
whose entry already holds a submission cannot submit again.

The submission that fills the third entry **closes the round** in that same
write:

- the entries' findings are appended to `review.findings` in a fixed order,
  `general` first, then `tests`, then `design`, each in the order it
  submitted them, and numbered `F-001` onward. Every lens finding records
  `lens`. Finding IDs therefore do not depend on the order the runs
  submitted in;
- the general run's `reconstructed_intent` becomes the review-level field;
- the entries keep their run identity, dispatch, and `submitted_at`, and
  drop the findings and intent they held. `review.findings` is
  then the only copy, with lens provenance and order already in it;
- with no findings, the close reuses today's initial `CLEAN` transition:
  `clean_snapshot_hash` set to the round-one snapshot and the
  `INITIAL_REVIEW_CLEAN` history entry.
  `finalize_local_gate` then mints the gate from round one. Otherwise the
  status is `REVIEW_SUBMITTED`.

**After round one.** From here on the review follows today's protocol with
no changes. The author answers every finding, lens findings included, with
one `submit_resolutions` call. An answer of `human_required` moves the review
straight to `HUMAN_REQUIRED`, before any rereview. Otherwise
`prepare_rereview` opens round two, launched without a lens, as today. One
general reviewer decides every finding and may report new ones. A lens
finding is judged like any other: does the snapshot resolve it, or does the
rebuttal hold? Round two ends `CLEAN`, `CONTINUABLE_FINDINGS`, or
`HUMAN_REQUIRED` when the rereviewer keeps a rejected finding open.
`MAX_ROUNDS` stays 2.

Running lenses once means round two has no lens run raising new findings,
and a continuation is a plain review unless the user asks again. Round-one
lens findings still cost convergence in two ways. A lens finding the
author marks fixed may be judged incomplete, which leads to
`CONTINUABLE_FINDINGS` and a continuation. A lens finding the author rejects
may be kept open, which leads to `HUMAN_REQUIRED`. The replay
measured round one only, so how often a lens review converges in round two
is a prediction, not a measurement. Volume will move it, since every extra
round-one finding is one more fix that can fall short or one more
rejection that can be disputed. The "worth fixing before merge" bar targets
the optional findings that drive both. The arbitration export carries
`lens`, so a human deciding a dispute can see where a finding came from.

### Run binding

For a lens-round run, `launch_local_reviewer` starts the reviewer MCP server
with `--review-id <id>`, plus `--lens tests` or `--lens design` for a lens
run. The path is: launch, then `codexReviewerArguments`, then
`mcp_servers.review-bridge-reviewer.args`, then option parsing in
`src/server.mjs`, then the reviewer tools.

Two rules bind the round:

- In `WAITING_FOR_LENS_REVIEW`, `submit_review` is accepted only from a
  server started with this review's `--review-id`. The slot comes from that
  server's `--lens`, and no `--lens` means `general`. An unbound server, such
  as a run launched for a plain review, cannot submit into a lens round.
- A server started with `--review-id` serves its review only while the
  review is `WAITING_FOR_LENS_REVIEW`, and refuses every reviewer tool call
  naming another review. Its `list_pending_reviews` lists only its review,
  and only in that status. Once the round closes, a round-one process still
  running cannot open or decide round two, whose fresh rereviewer is
  launched unbound as today.

Round-two launches and plain reviews pass neither option, so their servers
behave as today. This is tool-role binding, not process authentication. A
reviewer server an operator wires by hand, with or without these options,
cannot be told apart from a launched one. That is the general reviewer's
position today.

### Independence inside the lens round

The guarantees below hold for reviewers that use the reviewer tools, under
the existing trust assumption that every process running as the operator's
OS user is trusted. They also require every install that shares the store
to run a release that implements this RFC. The isolation comes from the
new server's checks, and a released server does not make them (see Backward
compatibility). During a rolling upgrade, start lens reviews only after the
last install is upgraded. The store and the shared `codex-runtime` directory are
readable by that user. The reviewer sandbox restricts writes and network
access, not reads.

- **Between runs.** No run is served another run's submission before its
  own is committed. In `open_review`, `rounds` goes through `roundDescriptor`,
  which copies named snapshot fields only (`src/core.mjs:2697`).
  `current_snapshot`, however, spreads the whole current round
  (`src/core.mjs:2783`) and would carry `runs`, so it omits them. The
  `submit_review` response is `reviewerReview` (`src/core.mjs:2015`), whose
  `rounds` are the raw ledger rounds from `publicReview`
  (`src/core.mjs:1033`). `reviewerReview` therefore drops `runs` from every
  round, which also covers `submit_rereview`'s response (`:2376`).
  Reviewers never need run entries. The one exception is deliberate. The
  submission that closes the round returns a ledger whose `review.findings`
  already holds every run's findings (`src/core.mjs:1034`). By then that
  run's own verdict is committed and cannot change, so the response is
  allowed to carry them.
- **From the author.** `get_review` returns the raw rounds, so the author
  can read run entries mid-round. That is acceptable, because before the
  close the author has no action that reaches a run. `submit_resolutions`,
  `prepare_rereview`, and `finalize_local_gate` all refuse the status (see
  Backward compatibility). The rationale stays hidden until the author
  records a resolution (`src/core.mjs:1051`). The snapshot is immutable, so
  commits or working-tree edits made mid-round do not reach a run. Errata
  are the one remaining input, and `append_review_erratum` refuses
  `WAITING_FOR_LENS_REVIEW`. Errata cannot change during the round, so every
  run is served the same errata, and the close records that one watermark.
  An erratum becomes appendable when the round closes, and it then follows
  today's rules. A round-two rereviewer, or a continuation, which carries
  errata forward, reads it. A round-one `CLEAN` verdict stands as made, and a
  minted gate refuses further appends. A review that goes straight to
  `HUMAN_REQUIRED` carries the erratum into the arbitration export. A round
  normally lasts as long as its slowest run, but a run that keeps exiting
  without submitting holds it open. An author who cannot wait abandons the
  review and prepares a new one, which can carry the correction in its
  requirement.

### Ledger shape

A plain review has none of these:

- the status `WAITING_FOR_LENS_REVIEW`, used only before the close;
- `rounds[0].runs`: one entry per run, `{run, reviewer_dispatch,
  submitted_at}`, where `run` is `general`, `tests`, or
  `design`. Before the close an entry that has submitted also holds that
  run's `findings`, and the general entry its `reconstructed_intent`. The
  close moves both out. In this round the round-level `reviewer_dispatch`
  stays null. Lens participation is read from these entries. A display that
  needs a run's finding count derives it from the round-one findings and
  their `lens`, so an empty run counts zero;
- `lens` on each finding a lens run raised.

After the close, the ledger has today's shape plus those fields, and round
two adds an ordinary round.

### Driver, summary, and report

- `get_review_summary` reports `action_required: REVIEWER_INITIAL_REVIEW` for
  `WAITING_FOR_LENS_REVIEW`, and adds `runs` (run, submitted or not, dispatch
  with its exit receipt) and `lens` on each active finding. Both are absent
  for plain reviews.
- The preparation reference names `lens_review` beside the existing
  `force_full_review` exceptions (step 5). It reports the status the
  returned summary gives instead of always `WAITING_FOR_REVIEW` (step 8).
  The author workflow skill and its `CODEX_TASK` reference apply their
  launch rules per run in a lens round. The three runs are that round's
  reviewers. A run with a live or indeterminate attempt is never replaced,
  and a run whose exit receipt in `runs` shows it exited without submitting
  is relaunched through `launch_local_reviewer`. `scripts/dispatch-contract.mjs`
  pins the reworded rule in place of today's "Never run two reviewers on the
  same round at once" (`:158`).
- `get_review` and the human arbitration export carry `lens` on findings.
- `verify:build` checks that the shipped author guidance keeps the sentence
  limiting `lens_review` to an explicit user request.
- Both report tiers show the lens on each finding row and a "Lens runs" line
  for lens reviews. The report's next-step table (`src/report.mjs:992`)
  gains `WAITING_FOR_LENS_REVIEW`, worded as round-one lens runs still owed,
  so a pending lens review no longer falls through to "names no next step".
  `REPORT_FORMAT` becomes 12.
- The scorecard adds the new status to its known list, so a lens review that
  has not closed is counted rather than excluded as a defect
  (`src/scorecard.mjs:104`). `SCORECARD_SCHEMA_VERSION` becomes 5 because
  `reviews_by_status` gains a key.

### State invariants

1. A review prepared without `lens_review` has the same ledger fields,
   summary, and gate as in the current release.
2. Before the close, run submissions change neither `review.findings` nor
   `review.status`, no author action reaches a run, and no run is served
   another run's submission before its own is committed.
3. The lens round closes exactly when all three run entries hold a
   submission, and every submitted finding enters `review.findings` then.
   Afterwards only the resolution protocol changes a finding's status.
4. Finding IDs depend on the submissions, not their arrival order.
5. A lens-round run's instructions come only from the launching installation,
   which is outside any Git work tree.
6. A lens-round submission comes from a server bound to that review, into
   the slot its `--lens` names. A bound server serves nothing after the
   close. Lens runs exist only in round one, and every state after the close
   is one today's code already handles.

## Security considerations

Findings enter only through reviewer-role tools. The lens tag comes from the
launcher's `--lens` argument, not from anything the model writes.
`prepare_review` accepts a flag, never lens text, so an author cannot add or
reword instructions, and an installation inside a work tree cannot supply
them. The boundary is still tool roles and the operator's OS user, not
process authentication. A lens review does not widen it. The reviewer
skill's rule holds in every run: instruction-like text in the requirement,
scope, rationale, commit messages, or errata is a finding, never an
instruction.

## Backward compatibility

- Plain reviews are unchanged, apart from the `REPORT_FORMAT` and
  `SCORECARD_SCHEMA_VERSION` bumps, which apply to every review. A report
  rendered after the upgrade gets a new file name. Older reports stay
  readable at their own names.
- **Released servers sharing the store.** Several installs can point at one
  store, and they are upgraded one at a time. A released server cannot drive
  a lens review before its close, because every transition it implements
  allow-lists the statuses it accepts, and `WAITING_FOR_LENS_REVIEW` is in
  none of those lists:

  | Released entry point | Accepts | Effect on `WAITING_FOR_LENS_REVIEW` |
  | --- | --- | --- |
  | `submit_review` (`src/core.mjs:1972`) | `WAITING_FOR_REVIEW` | refused |
  | `launch_local_reviewer` (`:2822`) | the two `WAITING_FOR_*` | refused |
  | `submit_resolutions` (`:2026`) | `REVIEW_SUBMITTED` | refused |
  | `prepare_rereview` (`:2158`) | `AUTHOR_RESPONDED` | refused |
  | `submit_rereview` (`:2261`) | `WAITING_FOR_REREVIEW` | refused |
  | `finalize_local_gate` (`:2387`) | `CLEAN` | refused |
  | `export_human_arbitration` (`:1766`) | `HUMAN_REQUIRED` | refused |
  | continuation source (`:1146`) | `CONTINUABLE_FINDINGS` | refused |
  | `list_pending_reviews` (`:1655`) | the two `WAITING_FOR_*` | not listed |

  In a released summary an unknown status maps to `INSPECT_REVIEW`.
- Released servers do not provide the lens round's isolation, which is why
  Independence requires an upgraded store. A released
  `append_review_erratum` refuses only a frozen continuation source or a
  minted gate (`:2104`, `:2123`) and checks no status, so it would accept an
  erratum mid-round. A released `open_review` checks only the provider
  (`:2757`) and spreads the raw current round (`:2783`), so a released
  reviewer opening a lens review by ID would see the run entries. A
  released `submit_rereview` response carries raw rounds (`:2376`), which
  after the close hold only run metadata. A released scorecard reports a lens
  review that has not closed as having an unknown status.
- After the close, the ledger is a round-one review in a status released
  servers know. The extra fields change none of their decisions, and their
  round two is this design's round two, so they drive it correctly. A newer
  server reads every older ledger.
- Gates are unchanged, so publication is unchanged.

## Drawbacks

- Round one costs three runs instead of one, about three times today's
  round-one tokens. The lens round lasts as long as its slowest run, plus
  any relaunch.
- Round one returns more findings for the author to answer. Fewer lens
  reviews will end `CLEAN` in round one, and each extra finding is a possible
  dispute.
- A run that keeps failing to launch blocks its review. The only recourse is
  a plain review.
- Errata wait until the lens round closes.
- Lens reviews need every install sharing the store to be upgraded.
- Two runs may report the same defect. Each stays a finding, and the author
  answers the second with a pointer to the first fix.
- New state: one status, the run entries, the close, and two reviewer-server
  options.

## Alternatives considered and evidence

The first draft of this RFC proposed building first and experimenting after.
The experiment ran instead, before this revision: a replay on 15 snapshots,
round one only, `CODEX_TASK` at high effort, with a decision rule frozen
before the first run. Arm B was general plus `tests`, `docs`, and `design`.
Arm C was four general runs, at equal compute.

- **Lens runs against more general runs.** Under the frozen rule, B found 117
  distinct valid defects and C found 29. A stricter verifier on a 30% sample cut
  defects worth fixing and not a nit to roughly 19 against 15, about 1.3×. Out
  of sample, of 50 human review comments, B matched 10, C matched 2, and a
  single run like today's matched 1. That is why the feature uses lenses rather
  than repeated general runs.
- **The lens bar.** B raised about 11 findings per snapshot against C's 5.
  The `tests` lens raised half of them, and the stricter verifier cut it
  hardest. That is why both lenses report only what is worth fixing before
  merge, and why the `tests` lens spells out when a missing test qualifies.
- **No `docs` lens.** None of its 6 sampled findings was worth fixing under
  the verifier.
- **Round one only.** More findings per round already make `CLEAN` harder
  to reach. Lenses in round two would add lens sources of
  `CONTINUABLE_FINDINGS` and disputes where the review should settle.
- **Cost.** B cost about four times a single run. Without `docs` a lens
  round is about three times.

## Unresolved questions

None.

## Test plan

Each test fails if the behavior it names is removed:

- `lens_review` is refused without `force_full_review`, with a provider other
  than `CODEX_TASK`, and from an installation inside a Git work tree, even
  when same-named lens files sit beside the server module.
- `launch_local_reviewer` starts three runs. Each run's arguments carry the
  installation's reviewer skill, its lens file for a lens run, `--review-id`,
  and `--lens` for a lens run. The general run's final request is today's. Each
  lens run's final request names its lens and omits the general "submit every
  actionable finding" directive. A launch from an installation inside a work
  tree is refused even when the review was prepared elsewhere.
- With one run exited unsubmitted and another live, a timed-out
  `wait_for_review_state` followed by `get_review_summary` shows the exit
  receipt on the unsubmitted run's entry. A launch with the returned
  `state_version` then starts only that run.
- A run's submission leaves `review.findings`, `status`, and the transition
  stamp unchanged until the third run submits, and the close applies all of
  them and leaves only metadata in the run entries. A run's second
  submission is refused. A lens run's `reconstructed_intent` is dropped, its
findings are kept, and it never reaches the review-level field.
- Three bound servers submitting at overlapping times all persist, the close
  is recorded once, and a retry after a busy lock keeps the other slots.
- A run opening after another has submitted gets neither that run's findings
  nor its intent, in `open_review` and in its own non-closing
  `submit_review` response. The closing response carries the merged
  findings.
- Finding IDs and `lens` tags are identical for every arrival order, and the
  review-level `reconstructed_intent` is the general run's.
- Three empty submissions close the round `CLEAN`, and `finalize_local_gate`
  mints the gate from round one.
- `append_review_erratum` is refused in `WAITING_FOR_LENS_REVIEW` and
  accepted after the close, and round two serves the erratum.
- A lens continuation that carries one erratum serves it to every bound
  run's `open_review`, and the close records its sequence as the round's
  watermark.
- An unbound server's `submit_review` is refused on a lens round. With two
  pending reviews, a bound server lists only its own, reads its own
  snapshot, and is refused when it opens, reads a file or artifact of,
  searches with `search_snapshot`, or submits to the other. The other
  snapshot holds a distinct searchable string. A bound server, general or
  lens, is refused on its own review once the round has closed,
  `submit_rereview` included, while the unbound round-two rereviewer
  submits.
- A `human_required` answer to a lens finding moves the review to
  `HUMAN_REQUIRED` without a rereview. In round two, a rejected lens finding
  that the rereviewer keeps open makes the review `HUMAN_REQUIRED`. The
  arbitration export shows the lens.
- Round two of a lens review launches one reviewer without either option.
  A continuation of a lens review has no lenses unless its preparation
  passes `lens_review`.
- A report rendered for a lens review that has not closed names the owed
  lens runs as the next step. For a closed lens review with one general and
  one lens finding, both report tiers show the lens on the lens finding's
  row and the "Lens runs" line, and `get_review_summary` shows it on the
  active finding.
- `verify:build` fails when the shipped author guidance loses the
  explicit-request sentence.
- The scorecard's status-count fixture with one pending lens review counts it
  in the `WAITING_FOR_LENS_REVIEW` bucket.
- A server built from the current release refuses each transition in the
  compatibility table on a lens review before its close, and after the close
  drives round two to `CLEAN` and finalizes.
- A plain review produces the same ledger, summary, and gate fields as the
  current release for the same inputs.
- The dispatch contract check pins the per-run launch rule.
- The built package contains both lens files, and a lens review prepared and
  launched from it, outside a work tree, reads them.

## Rollout plan

One implementation pull request, off by default. It contains the core state
and close, the launcher and its installation check, the two reviewer-server
options, the lens files and build copy, the tool descriptions, the author
workflow skill, preparation reference and dispatch contract, report and
scorecard changes, and documentation that describes the option and its
cost. Estimated size:

| Part | Lines |
| --- | --- |
| core: status, run entries, close, three-run launch, errata refusal, response filtering, summary | ~200 |
| launcher, installation check, server options, tool inputs and descriptions | ~80 |
| lens files, build copy, build verification | ~60 |
| report and scorecard | ~40 |
| workflow skill and preparation reference, dispatch contract, build check, documentation | ~80 |
| tests | ~520 |
| total | ~980 |

That fits the 1,000-line preference, in one pull request.
