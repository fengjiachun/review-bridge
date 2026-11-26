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

By default the reviewer uses the model set in the MCP host's Codex
configuration (`model` in `~/.codex/config.toml`, or the file under
`CODEX_HOME`). `launch_local_reviewer` passes no `--model`, so
a model Codex accepts there is the model that reviews.

The default reasoning effort is `high`: that tool passes
`model_reasoning_effort="high"` on every launch it starts, so an everyday
configuration set to a lighter effort does not weaken reviews.

To use another model or effort for one review, say so in the author
conversation, for example "list the reviewer models" or "review this with
gpt-6.2-sol at max effort". The author lists the models this host's Codex
offers (`list_reviewer_models`), with each model's supported efforts, and
launches with your choice. A model Codex does not list, or an effort the model
does not support, is refused; the author never substitutes another. An effort
chosen without a model is checked against the configured model. The choice
carries to the review's later rounds until you choose again; a new review or a
continuation starts back at the defaults. The author does not ask which model
to use unless you raise it.

A `CODEX_TASK`
task you create yourself ([manual dispatch](local-review.md#start-a-reviewer-manually))
runs with the model and effort set in that client. Neither choice affects
GitHub's Codex review or the other reviewer providers, which use their own
clients' settings.

## Tool sequence

The author conversation's model does not select the reviewer. Every author MCP
connection (Codex, Claude, Hermes, DeepSeek Harness) uses the same tools:

| Step | Tool | Result |
| --- | --- | --- |
| Prepare | `prepare_review` | Immutable snapshot and pending review |
| Choose (only when asked) | `list_reviewer_models` | The configured model, the `high` default, and each listed model's supported efforts |
| Start | `launch_local_reviewer` | An independent Codex process, at `high` effort unless another was chosen |
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

Requested configuration is a launch record: the chosen model if any, the
effort, and for each whether it was `selected` or came from the Codex
configuration or the `high` default, for example
`{"reasoning_effort":"high","model_source":"configuration","reasoning_effort_source":"default"}`.
Reports print it per round. Observed remote model identity is
`unavailable`; neither local logs nor provider binding authenticate it. Rounds
that earlier releases launched keep the model, effort and `environment_id` the
author selected, and reports print them per round as recorded. A round still
pending at the upgrade and launched again records the new request; its
history keeps the earlier selection.

The Claude author connection is shipped separately from the reviewer extension;
see [installation](install/claude-desktop.md#use-claude-as-an-author). No computer
use is needed to launch from the author MCP connection.
