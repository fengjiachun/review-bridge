## Handle findings

Use the selected provider
([CODEX_TASK](codex-task.md), [HERMES](hermes.md),
[DEEPSEEK_HARNESS](deepseek-harness.md), [CLAUDE_DESKTOP](claude-desktop.md))
for its round-two launch or resume rules. Use [Prepare](prepare.md) for a fresh
continuation review and [Finish](finish.md) for CLEAN, a gate at the round
limit, or human arbitration.

1. Call `get_review_summary` first. If it reports `REVIEW_SUBMITTED`, call
   `get_review` once to load the full findings and evidence. Present every
   finding from the ledger's `findings` with its ID, severity, one-line summary,
   and location.
2. Address every open finding. For each finding choose exactly one:
   - `fixed`: every location and every clause the finding names is done at the
     new head, including any test or documentation it asks for. Check the
     finding's text item by item, not from memory. Do not mark a finding fixed
     without verification evidence, and do not claim a check you did not run.
     For a finding whose `constraint` is `undocumented`, fixed also means
     writing the rule into the repository's agent guidance (the invariants
     file or the affected module's `AGENTS.md`) in the same pull request. If
     the rule does not hold or is not this change's to set, answer `rejected`
     with evidence.
   - `rejected`: provide concrete technical evidence. A remedy that differs
     from the recommendation is `rejected`, not `fixed`: explain with evidence
     why it satisfies the finding, and let the rereviewer decide. A finding
     you want the user to decide as maintainer is `rejected` too, with a
     rationale saying a maintainer ruling is being sought (step 4). Never
     answer it `human_required`: that moves the review to `HUMAN_REQUIRED`,
     and the ruling window never opens. If the round-two reviewer accepts it
     under the ruling, as `rebuttal_accepted` or as `resolved` once the code
     follows the ruling, the round is not contested; only `still_open` on a
     rejected finding contests it.
   - `human_required`: stop and request human arbitration.

   A fix the rereviewer judges incomplete moves the review to
   `CONTINUABLE_FINDINGS`, and the finding is carried into the next full review,
   unless the summary then reports `FINALIZE_LOCAL_GATE` (step 5).
3. Call `submit_resolutions` with one entry for every finding, then call
   `get_review` again. Present every persisted disposition from its
   `resolutions`, including its rationale and evidence.
4. The ruling window is open while the state is `AUTHOR_RESPONDED` in round
   one, until `prepare_rereview`. When the user decides a finding's trade-off
   or corrects a requirement clause, record it with
   `record_maintainer_ruling`: the `text` states the user's decision
   faithfully and in full, as a property of the change, without depending on
   the finding's text, `finding_ids` names the findings it decides, and
   `operator_label` names the human who decided. Never put the decision in
   resolution text, and never record a ruling the user did not make. To undo
   a ruling, record one that withdraws it by ID. Then continue as usual.
   If the state is `AUTHOR_RESPONDED`, require a new commit only when at least
   one resolution is `fixed` — after the pre-commit cleanup — then call
   `prepare_rereview` and `get_review`
   again. For fixed resolutions, compare the preceding and latest rounds'
   authoritative `head_sha` values with `git diff --name-only` to derive the
   actual fix files, and present them with the latest `head_sha` as the
   committed fix head. If every
   resolution is `rejected`, report that the rereview is rebuttal-only and no
   code commit was required.
   If the state is instead `HUMAN_REQUIRED`, report the escalation reason and
   all persisted resolutions, then stop and follow the human-arbitration flow.
   When at least one of those resolutions is `fixed`, also state that no
   rereview round captured its files or commit. Do not infer that metadata from
   the workspace or session text.
5. Record the new summary's `state_version`, report `WAITING_FOR_REREVIEW`,
   follow the selected provider's round-two launch or resume rules, and use `wait_for_review_state` to observe
   the next transition. Treat `timed_out` as an expected in-progress result and
   continue with the same `state_version` as described in [Prepare](prepare.md). When rereview
   completes, call `get_review` again. Present every per-finding decision and
   any new finding from its `rereview_decisions` and `findings`. If it reaches
   `HUMAN_REQUIRED`, state the concrete escalation reason from the full ledger.
   If it reaches `CONTINUABLE_FINDINGS` or `HUMAN_REQUIRED` and
   `get_review_summary` reports `FINALIZE_LOCAL_GATE`, only `minor` or `nit`
   findings are open: follow [Finish](finish.md). Otherwise, if it reaches
   `CONTINUABLE_FINDINGS`, present the source ledger's `OPEN` and
   `STILL_OPEN` `findings` before starting the fresh full review. After
   creating that review, call `get_review` with its new ID and read its
   `carried_findings` as the continuation scope.

Keep fixes surgical.
Session narration is operator observability only. Never use it as review
evidence or as a substitute for reading and mutating the ledger.
