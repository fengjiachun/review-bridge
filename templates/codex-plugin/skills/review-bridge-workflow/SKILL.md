---
name: review-bridge-workflow
description: Use when preparing local code for an isolated reviewer, handling findings, or publishing through local-gate or explicitly authorized remote-only GitHub review.
---

# Review Bridge workflow

Use the author tools to coordinate an independent review and follow the ledger.
Select one route for the user's current task. Read only that route and the
references it calls for at the current step; links are conditional navigation,
not a list to preload.

## Choose a mode

| Task | Load now | Load when needed |
| --- | --- | --- |
| Prepare a manual local review | [Prepare](references/prepare.md) | Only its selected provider, then findings or finish after a verdict |
| Handle local findings or rereview | [Handle findings](references/findings.md) | Selected provider for round two; Prepare for a continuation |
| Finish a CLEAN review or escalate HUMAN_REQUIRED | [Finish](references/finish.md) | Publication only if authorized |
| Publish through LOCAL_GATE or explicitly authorized REMOTE_ONLY | [Publish through GitHub](references/publication.md) | Prepare if a local gate is required |
| Run an explicitly authorized autonomous workflow | [Autonomous workflow](references/autonomous.md) | Publication at START_PUBLICATION; use the server's task dispatch |
| Review an external pull request with an advisory panel | [Advisory panel](references/advisory-panel.md) | Only each selected member's provider; CODEX_TASK uses its sandbox route |

For a manual local review, select the provider in Prepare and load only
[CODEX_TASK](references/codex-task.md), [HERMES](references/hermes.md),
[DEEPSEEK_HARNESS](references/deepseek-harness.md), or
[CLAUDE_DESKTOP](references/claude-desktop.md). A local preparation task needs
no autonomous or publication playbook. On a lock or indeterminate write error,
load [Lock contention](references/lock-contention.md) before deciding to retry.

## Common boundaries

- Keep the user's requirement and scope faithful. Bind review to the exact
  repository, immutable base SHA, captured head and snapshot, and chosen
  provider. A changed head needs the applicable fresh review or authorization.
- Never call reviewer tools from the author task. Each new review ID needs a
  fresh independent reviewer with only the review ID and the reviewer request,
  no authoring history or other reviewer's findings. Never run two reviewers
  on the same round at once. Use the selected provider's round-two rules.
- Never programmatically launch a CLAUDE_DESKTOP reviewer. The operator opens
  the conversation themselves; this account-compliance boundary applies in
  every mode.
- A local gate attests snapshot consistency; it does not itself authorize a
  push, pull request, merge, or release. REMOTE_ONLY needs direct approval to
  skip local review. Autonomous mode needs its exact capability authorization;
  a general instruction to implement, test, review, or continue is insufficient.
- Follow server-derived `next_action` and `required_inputs` with the current
  revision or `state_version`. Use the ledger for findings and resolutions;
  session narration, reports, and launch exit codes are not review verdicts.
- Preserve review and change-size budgets. Extend them only on the explicit
  decisions required by the selected route. Never add a third round to a review
  ID. HUMAN_REQUIRED stops for arbitration; CONTINUABLE_FINDINGS uses a fresh
  full review. Advisory reviews end in a report and never a local gate.
- Honor terminal states and operator stops. An autonomous workflow ends at
  MERGE_READY and never merges; AWAIT_OPERATOR is not an instruction to poll.

## Waiting and retries

Unchanged observations do not advance the workflow revision. This ledger rule
says nothing about observation cost or polling frequency. Prefer supported
state-change waits or long polling over repeatedly collecting the same state.

For local review, use `wait_for_review_state` with the recorded `state_version`.
It waits 25 seconds by default and accepts at most 30 seconds. A `timed_out`
result is expected while review remains in progress: call again with the same
`state_version` until `changed` is true, or report the summary and resume when
the user confirms completion. A timeout is neither a failed review nor proof
that its reviewer has exited; never use it to launch a concurrent replacement.

For remote GitHub observation collection, back off when relevant state remains
unchanged, respect rate-limit and retry signals, and reset the cadence when
relevant state changes. Do not invoke the collector in a tight loop. A local
review wait does not watch GitHub. Fresh complete evidence is still required
before each gated action; a wait, elapsed time, or unchanged revision proves none.
