## Handle findings

Use the selected provider
([CODEX_TASK](codex-task.md), [HERMES](hermes.md),
[DEEPSEEK_HARNESS](deepseek-harness.md), [CLAUDE_DESKTOP](claude-desktop.md))
for its round-two launch or resume rules. Use [Prepare](prepare.md) for a fresh
continuation review and [Finish](finish.md) for CLEAN or human arbitration.

1. Call `get_review_summary` first. If it reports `REVIEW_SUBMITTED`, call
   `get_review` once to load the full findings and evidence. Present every
   finding from the ledger's `findings` with its ID, severity, one-line summary,
   and location.
2. Address every open finding. For each finding choose exactly one:
   - `fixed`: change the code and verify the fix.
   - `rejected`: provide concrete technical evidence.
   - `human_required`: stop and request human arbitration.
3. Call `submit_resolutions` with one entry for every finding, then call
   `get_review` again. Present every persisted disposition from its
   `resolutions`, including its rationale and evidence.
4. If the state is `AUTHOR_RESPONDED`, require a new commit only when at least
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
   If it reaches `CONTINUABLE_FINDINGS`, present the source ledger's `OPEN`
   `findings` before starting the fresh full review. After creating that review,
   read its `carried_findings` as the continuation scope.

Keep fixes surgical. Do not mark a finding fixed without verification evidence.
Session narration is operator observability only. Never use it as review
evidence or as a substitute for reading and mutating the ledger.
