# Local reviewer configuration

The author conversation's model does not select the reviewer. Every author MCP
connection (Codex, Claude, Hermes, DeepSeek Harness) uses the same tools:

| Step | Tool | Result |
| --- | --- | --- |
| Discover | `discover_reviewer_options` | Visible models and per-model efforts from the target runtime; a suggestion, not a selection |
| Prepare | `prepare_review` | Immutable snapshot and pending review |
| Select | `select_reviewer_configuration` | Validated requested configuration on the current round; no process starts |
| Start | `launch_local_reviewer` | Explicit model/effort passed to an independent Codex process |
| Inspect | `get_review_summary` | Requested configuration, process identity and exit record when available; ledger verdict remains authoritative |

Present a light choice before the first review if the user has not specified it.
Use a structured picker only where the author client supports one; ordinary
conversation is the fallback. Prefer the last still-valid pair for this repository
and execution environment. Otherwise suggest the runtime's default model with
`high` if that model advertises it (the #162 review default), or its advertised
default effort. A suggestion never authorizes a start. Unattended drivers require
a preauthorized pair; missing or invalid configuration stops without waiting for
an interactive answer.

Discovery starts the Codex CLI on the MCP host, using that process's account,
configuration, environment and neutral cwd. `REVIEW_BRIDGE_CODEX_COMMAND` may name
an absolute CLI executable (use this for desktop applications with a different
PATH). The same resolved executable and cwd are used for launch. A store inside
a Git repository is refused as a reviewer cwd. Models and efforts are not copied
from the author client or the public API catalog. The opaque `environment_id`
binds host, runtime, Codex home, account and effective configuration; raw account
and configuration responses are not saved. Selection and start both re-query the
runtime, so environment changes or unsupported pairs cause explicit failures.
No automatic downgrade or replacement is performed. Every integration package
ships the matching CODEX_TASK reviewer skill with its server. The launcher passes
that skill as process-local developer instructions, so a Claude/Hermes/DeepSeek
author does not need a separately installed Codex plugin. Global configuration
is not modified.

[OpenAI's app-server contract](https://learn.chatgpt.com/docs/app-server#list-models-modellist)
provides `model/list` with `supportedReasoningEfforts`, `defaultReasoningEffort`,
`isDefault`, `hidden` and cursor pagination. The adapter follows every page and
only presents picker-visible models. `queried_at` is when Review Bridge queried
the runtime. The protocol does not expose an upstream catalog cache timestamp or
a force-network-refresh parameter. Review Bridge neither caches model lists nor
claims a network refresh: `freshness` explicitly says upstream source and age are
unavailable. Discovery failure is an error and can be retried; stored preferences
are never used as availability evidence.

Round two inherits the requested pair. Explicit changes before dispatch preserve
prior rounds; after an exited failed launch, changing selection preserves the
old attempt in history. Live or indeterminate attempts block replacement. Process
exit is not a verdict; inspect the ledger before retrying. An absent exit record
is deliberately indeterminate even if a host reboot killed the process; an
operator must reconcile that attempt before replacing it.

The autonomous controller stores the selected configuration in its dispatch
intent. Select before binding the review. After marking the action EXECUTING,
`launch_codex_task_dispatch` starts the same runtime and returns its task identity,
title and prompt for the existing observation/completion protocol. Repeating it
recovers the recorded identity instead of launching a duplicate. If validation fails before any launch attempt, `abandon_workflow_action` can
release that local intent after checking the ledger; reselect explicitly and plan
a new intent. Attempted, live or indeterminate launches are never abandoned this
way. Legacy intents without the local-launch contract remain readable but need
reconciliation or workflow cancellation before replacement. Round-two launch uses
`launch_local_reviewer` after the controller advances to WAIT_LOCAL_REREVIEW.

Requested configuration is a launch record. Observed remote model identity is
`unavailable`; neither local logs nor provider binding authenticate it. Older
ledgers stay readable and report unavailable rather than acquiring invented
historical defaults. Reports retain per-round requested identity. Other reviewer
providers currently have no discovery/control adapter and return that limitation
with no fabricated options. Advisory reviews keep their dedicated isolation
launcher and are not eligible for the ordinary local launch tool.

The Claude author connection is shipped separately from the reviewer extension;
see [installation](install/claude-desktop.md#use-claude-as-an-author). No computer
use is needed to discover, select, or launch from the author MCP connection.
