# Local reviewer configuration

## Start from your author client

Ask in the conversation where you authored the change:

> Use Review Bridge to review this change with Codex. Use `origin/main` as the
> base; the requirement is "..." and the implementation scope is "...".

The reviewer runs as an independent Codex process on the MCP host. It need not
appear as a new task window in the author app. Ask the author for the review's
status or findings; [local review](local-review.md) explains the next steps.

| Author client | Connection needed |
| --- | --- |
| Codex | [Review Bridge plugin](install/codex-plugin.md) with author tools |
| Claude | Separate [author MCP connection](install/claude-desktop.md#use-claude-as-an-author); the Desktop reviewer extension alone cannot launch Codex |
| Hermes | [Author profile](install/hermes.md), separate from the reviewer profile |
| DeepSeek Harness | [Author profile](install/deepseek-harness.md), separate from the reviewer profile |

The MCP host needs an authenticated Codex CLI **0.153.4 or newer**. Check
`codex --version` on that host before launching (or check the executable set by
`REVIEW_BRIDGE_CODEX_COMMAND`). Older versions such as 0.145.0 can cancel the
reviewer's first MCP call; see the
[launcher compatibility notes](../templates/codex-plugin/skills/review-bridge-workflow/references/codex-task.md).
Upgrade the CLI before using automatic launch.

## Model and reasoning effort

The reviewer uses the model set in the MCP host's Codex configuration
(`model` in `~/.codex/config.toml`, or the file under `CODEX_HOME`).
`launch_local_reviewer` and `launch_codex_task_dispatch` pass no `--model`, so
a model Codex accepts there is the model that reviews. To change the reviewer
model, change the Codex configuration.

Reasoning effort is always `high`: those two tools pass
`model_reasoning_effort="high"` on every launch they start, so an everyday
configuration set to a lighter effort does not weaken reviews. A `CODEX_TASK`
task you create yourself ([manual dispatch](local-review.md#start-a-reviewer-manually))
runs with the model and effort set in that client. Neither choice affects
GitHub's Codex review or the other reviewer providers, which use their own
clients' settings. A workflow dispatch planned before the upgrade that
recorded a model is the one exception: it runs with the model and effort it
recorded, whatever the Codex configuration says. An older intent without a
recorded configuration is not launched; see the recovery section below.

## Tool sequence

The author conversation's model does not select the reviewer. Every author MCP
connection (Codex, Claude, Hermes, DeepSeek Harness) uses the same tools:

| Step | Tool | Result |
| --- | --- | --- |
| Prepare | `prepare_review` | Immutable snapshot and pending review |
| Start | `launch_local_reviewer` | An independent Codex process at `high` effort |
| Inspect | `get_review_summary` | Requested configuration, process identity and exit record when available; ledger verdict remains authoritative |

## Runtime

Launch starts the Codex CLI on the MCP host, using that process's account,
configuration, environment and a neutral cwd under the store.
`REVIEW_BRIDGE_CODEX_COMMAND` may name an absolute CLI executable (use this for
desktop applications with a different PATH). A store inside a Git repository is
refused as a reviewer cwd. Every integration package ships the matching
CODEX_TASK reviewer skill with its server. The launcher passes that skill as
process-local developer instructions, so a Claude/Hermes/DeepSeek author does
not need a separately installed Codex plugin. Global configuration is not
modified. The attempt's `process.log` captures the CLI's output, which may
include the model and effort Codex reports for itself; it does not prove them.

## Rereview and launch recovery

Each round records its own launch. Live or indeterminate attempts block
replacement. Process exit is not a verdict; inspect the ledger before retrying.
An absent exit record is deliberately indeterminate even if a host reboot killed
the process; an operator must reconcile that attempt before replacing it.

The autonomous controller stores the pinned effort in its dispatch intent.
After marking the action EXECUTING, `launch_codex_task_dispatch` starts the
reviewer and returns its task identity, title and prompt for the existing
observation/completion protocol. Repeating it recovers the recorded identity
instead of launching a duplicate while the current round holds that dispatch's
started receipt (an older round's receipt is not consulted, so check the
current round and marker before retrying an old action), including after the
process exited once the review recorded a verdict. For a recorded attempt, a
failed start, a missing started receipt, or a process that exited while the
review is still pending is refused and needs reconciliation. An error before
any attempt is recorded, such as an unavailable Codex executable, can be
corrected and launched again. An intent planned by an earlier release with
a selected model runs with the model and effort it recorded. To move such a
LOCAL_PROCESS intent to the host model before any launch, abandon it with
`abandon_workflow_action`, which requires the ledger to show no launch attempt,
then plan again. Legacy intents without
the local-launch contract remain readable but need reconciliation or workflow
cancellation before replacement. Round-two launch uses `launch_local_reviewer`
after the controller advances to WAIT_LOCAL_REREVIEW.

Requested configuration is a launch record: `{"reasoning_effort":"high"}`, with
the model left to the Codex configuration. Observed remote model identity is
`unavailable`; neither local logs nor provider binding authenticate it. Rounds
that earlier releases launched keep the model, effort and `environment_id` the
author selected, and reports print them per round as recorded. A round still
pending at the upgrade and launched again records the new request; its
history keeps the earlier selection.

The Claude author connection is shipped separately from the reviewer extension;
see [installation](install/claude-desktop.md#use-claude-as-an-author). No computer
use is needed to launch from the author MCP connection.
