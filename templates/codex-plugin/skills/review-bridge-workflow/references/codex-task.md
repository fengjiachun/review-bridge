## Dispatching a CODEX_TASK review

For an ordinary local review, use [Prepare](prepare.md) first. After a verdict,
load [Handle findings](findings.md) or [Finish](finish.md) as its state requires.

This driver session can dispatch the `CODEX_TASK` reviewer itself rather than
asking the operator to start it by hand. Nothing else moves: Prepare, Handle
findings, and Finish still own the review, and this section adds only the shell
launch between them.

1. Follow Prepare through `get_review_summary`, choosing `CODEX_TASK` at its
   provider step. Record the returned `review_id` and `state_version` and
   report the summary exactly as Prepare requires.
2. Call `launch_local_reviewer` with `review_id` and the current
   `expected_state_version` after the user has chosen the reviewer configuration
   and authorized starting. This shared author tool works from Codex, Claude,
   Hermes, or DeepSeek Harness. It uses the same CLI, home, and neutral directory
   as `discover_reviewer_options`, revalidates the selection, and passes explicit
   model and effort arguments. It returns promptly; wait for the ledger verdict.
   Do not substitute a task in a different host/runtime or the author's model.

   The tool executes this sandbox shape, with the selected values (this example
   describes the launch; use the tool rather than constructing a shell command):

   ```bash
   codex exec --skip-git-repo-check --sandbox workspace-write --model <selected-model> \
     -c 'model_reasoning_effort="<selected-effort>"' \
     -c 'sandbox_workspace_write.network_access=false' \
     -c 'sandbox_workspace_write.writable_roots=[]' \
     -c 'sandbox_workspace_write.exclude_slash_tmp=true' \
     -c 'sandbox_workspace_write.exclude_tmpdir_env_var=true' \
     -c 'approvals_reviewer="guardian_subagent"' \
     -c 'approval_policy={granular={rules=false,sandbox_approval=false,skill_approval=false,request_permissions=false,mcp_elicitations=false}}' \
     -c 'memories.use_memories=false' \
     -c 'memories.generate_memories=false' \
     -c 'mcp_servers.review-bridge-author.command="node"' \
     -c 'mcp_servers.review-bridge-author.enabled=false' \
     '<the reviewer request below>' < /dev/null
   ```

   > Independently review Review Bridge task `<review_id>` using the packaged
   > Review Bridge reviewer skill. Require `reviewer_provider: CODEX_TASK`,
   > follow the review strategy, and submit every actionable finding.

   Selection is stored per round. A rereview inherits it and revalidates before
   launch. To change it explicitly, call `select_reviewer_configuration` before
   dispatch; previous rounds keep their identity. Invalid or expired selections
   fail without fallback. Query failures can be retried. `model/list` is a runtime
   catalog, not a forced network refresh; its upstream cache age is unavailable.
   `requested` records the launch choice; `observed` is unavailable. A process log
   cannot authenticate the remote model. Older ledgers remain readable with no
   invented historical configuration.

   Single-quote that request: it contains backticks, and a double-quoted shell
   string would execute them instead of passing them through. Pass it as one
   line with `<review_id>` substituted. This launch needs codex-cli 0.153.4 or
   newer. It runs the reviewer inside Codex's own `workspace-write` sandbox,
   and on 0.145.0 and earlier every sandboxed form cancelled the reviewer's
   first Review Bridge MCP call with `user cancelled MCP tool call` before it
   listed a single pending review (observed 2026-08-28 and 2026-09-04); on
   0.153.4 the same call completes under a header reporting
   `approval: granular` and
   `sandbox: workspace-write [workdir]` (observed 2026-09-10; the header read
   `approval: on-request` before the `approval_policy` line joined the launch).
   `--skip-git-repo-check` is there because the working directory is in no
   repository: without it `codex exec` refuses to start with `Not inside a
   trusted directory and --skip-git-repo-check was not specified`. Redirect
   stdin from `/dev/null`, as both launch lines here do: `codex exec` treats
   piped stdin as more input, appending it to the prompt as a `<stdin>` block
   when a prompt is also given, and an unattended launch runs from a shell
   with no terminal on stdin. Left open, that channel either feeds the
   reviewer whatever the driver's stdin carries — silently breaking the
   single-task handoff and the rule below that no authoring history reaches
   the reviewer, since the request is then no longer the whole handoff — or
   blocks the launch waiting for an EOF that never comes. Run the launch so it
   does not block step 3 — background it or use a separate terminal.
3. Wait with `wait_for_review_state` on the recorded `state_version`, treating
   `timed_out` as the expected in-progress result described in Prepare. When
   the state changes, hand the review to Handle findings, which owns narrating
   every finding from the ledger and, after `submit_resolutions`, every
   persisted disposition. `codex exec` prints the reviewer's transcript on
   stdout and exits nonzero on failure, so read its output before assuming a
   review that never arrives is merely slow. `get_review_summary` exposes
   `reviewer_dispatch.exit` once the process exits and its private log path is
   `<attempt_root>/process.log`. An absent exit means running or indeterminate;
   it never permits a concurrent replacement. After a confirmed exit without a
   verdict, a new explicit selection can replace the failed configuration.

The launch discipline is fixed, and it states what must never happen rather
than counting launches. Never run two reviewers on the same round at once, and
never review from the author task: never fork that task, and never pass any
authoring history — not the diff you wrote, the requirement discussion, your
reasoning, or this session's transcript. Within those two bars launches are not
rationed. A round-two rereview is that review's next round, so its launch is
required rather than an exception. A launch that has exited leaves the round to
be judged from the ledger: if the ledger shows no verdict for this round, no
reviewer is working it, so start a replacement launch in the same shape as the
original; that replacement is the same round, and both bars still hold, because
the reviewer it replaces is gone. The exit status, zero or not, establishes
only that the process is gone — a run can submit its verdict and then fail
while saving its session or printing its output, and a replacement started on
that exit code alone would rerun a round the ledger already carries. Judge that
by the process having exited, never by `wait_for_review_state` timing out: a
timeout says the round is unfinished, not that the reviewer is gone, and
replacing a reviewer that is merely slow creates exactly the concurrent pair
the first bar forbids. The driver started the process, so it has the exit
status to judge by. That request is the whole handoff, and Codex reads the
packaged Review Bridge reviewer skill from the plugin and follows it without
being told where it is.

The sandbox is the isolation boundary, so be exact about what it bounds. The
Review Bridge reviewer server's seven-tool `--role reviewer` surface bounds
only what Review Bridge exposes, not what the reviewer process can do — Codex
brings a shell of its own, and under this launch that shell runs inside the
`workspace-write` sandbox. Three of its edges were measured on 2026-09-09
rather than read from documentation. Writes are bounded to the working
directory alone: a write to `$HOME` or to `/tmp` from that shell fails with
`operation not permitted`, the command exits nonzero, no approval is raised,
and the launch runs to completion — an unattended run is refused, not left
waiting — while the same write inside the working directory succeeds, so the
instrument tells a denial from a reviewer that never tried. The writable roots
are in the launch line too: `workspace-write` writes `/tmp` and `$TMPDIR` by
default and adds whatever `sandbox_workspace_write.writable_roots` the host's
configuration lists, and an authoring worktree may well sit under a temporary
directory, so `writable_roots=[]`, `exclude_slash_tmp=true`, and
`exclude_tmpdir_env_var=true` shrink the roots to the working directory rather
than inheriting them — the header then reads `[workdir]` and nothing else. Network is
off: `curl https://example.com` from that shell fails with
`Could not resolve host`, again with no approval raised. `--sandbox
workspace-write` and `-c 'sandbox_workspace_write.network_access=false'` are
in the launch line for the same reason `approvals_reviewer` is below: a host
profile can set `sandbox_mode` to anything and can grant network with
`[sandbox_workspace_write] network_access = true`, so the launch names both
rather than inheriting whatever the host's `~/.codex/config.toml` says. And
the author server is disabled, for the reason given below.

What the sandbox does not remove is the approval gate on MCP calls. Every
Review Bridge tool the reviewer calls raises an approval request, and a
non-interactive `codex exec` has no operator to answer it: with the reviewer
of those requests left at its `user` default the run reports
`approval: never`, and the first call fails with
`MCP tool call requires approval, but approval policy is never`.
`approvals_reviewer="guardian_subagent"` routes each request to Codex's
guardian subagent instead, which judged the probe's `list_pending_reviews`
call `{"risk_level":"low","user_authorization":"high","outcome":"allow"}`
from the request alone. The launch line sets that key itself rather than
relying on the operator's `~/.codex/config.toml` to carry it, so the launch
either works or fails with that message, on any machine. Be exact about what
the guardian is: an automatic reviewer of the MCP calls, judging against the
request as the trusted instruction and the transcript as untrusted evidence.
It is not what bounds the shell — the sandbox denials above raised nothing for
it to judge — and it is not what keeps the author surface out of reach, below.

Nor, under this launch, does it judge sandbox escalations. By Codex's own
account of the `approvals_reviewer` setting the guardian also reviews any
escalation the reviewer explicitly asks for, and without the `approval_policy`
line it did: a reviewer that requested `sandbox_permissions=require_escalated`
for a write to `$HOME` had that request routed to the guardian, which allowed
it as part of the task, and the file was written (observed 2026-09-10). That
is a model-judged gate on the one thing the sandbox is there to refuse, and
the `approval_policy` line beside `approvals_reviewer` closes it. Under the
`granular` policy every approval category set to `false` is rejected by
configuration instead of being raised, and `sandbox_approval=false` is the
category a shell escalation falls in: the same request is refused in Codex's
tool router before any guardian thread exists, the transcript carries
`rejected by configuration` and `reject command — you cannot ask for escalated
permissions if the approval policy is Granular(…)`, no `exec` line is printed
for it, no guardian rollout is written for it, and the run exits normally with
the file absent. Escalation is refused by configuration, never judged by the
guardian, which now judges MCP calls only. The value has five fields and all
five are required: the configuration deserializer refuses it with `missing
field` for whichever is absent, so the line cannot be shortened to the one
field that matters. All-`false` is the strictest form, and the reviewer needs
none of the five — `rules` covers prefix-rule approvals, `skill_approval` does
not gate reading the packaged reviewer skill (the skill was read and the MCP
call completed under all-`false`), `request_permissions` is the tool a
reviewer would use to ask for more, and `mcp_elicitations` are MCP
elicitations, which the reviewer server never issues. MCP tool-call approval
is not one of the five, which is why it still reaches `approvals_reviewer`.
What the line does not change is the guardian's own exposure: its verdict has
a deadline, and under host load a reviewer call can come back with
`The automatic permission approval review did not finish before its deadline`
under either policy — the MCP path is the same guardian path it was, so that
exposure is unchanged, not added.

The neutral working directory is still required, for two reasons that survive
the sandbox. It is the sandbox's writable root, so a reviewer launched inside
the authoring worktree could write that tree, and Codex also injects project
context from the nearest `AGENTS.md` or `CLAUDE.md` it finds there. Launch it
from a neutral working directory outside the repository under review, and
prefer a directory in no repository at all. The reviewer process needs no
checkout of its own — its tools read the change from the immutable snapshot
and from the author's repository by recorded path, never from its own working
directory — so the task body must name the `review_id`: it is the reviewer's
only pointer to the snapshot, and the seven-tool surface exposes no other way
to discover which review it was sent to.

Codex's memory feature is pinned off in both launch lines, for the reason
stdin is closed. With the host's `[memories] use_memories = true` Codex
prepends a memory summary to the reviewer's instructions and directs it to
search `~/.codex/memories/MEMORY.md` before working, and in the first full
unattended round under this launch the reviewer's first sandboxed shell
commands were a read of the packaged reviewer skill and an `rg` over that
file, whose hits were memory lines about the very change under review and the
rulings around it (observed 2026-09-10). That is authoring history reaching
the reviewer through a channel the launch line did not close: the request is
the whole handoff, and a memory folder written by the operator's own sessions
is the operator's history whatever it happens to say.
`memories.use_memories=false` closes the read side, so no memory instructions
are injected and nothing points the reviewer at that folder, and
`memories.generate_memories=false` closes the write side, because a review is
not a session the operator's memories should record. Both keys are pinned in
the launch line rather than left to the host profile, like the sandbox and the
approver. They are the two boolean fields of the `[memories]` table, and the
key paths were confirmed the way the `granular` fields were, by the
configuration parser refusing a non-boolean for each with `invalid type:
string "x", expected a boolean` `in memories.use_memories` and
`in memories.generate_memories` — an unknown key under `memories` is accepted
silently, so acceptance of the `false` form confirms nothing and the refusal
of the wrong type is the evidence.

The sandbox does not reach MCP servers, so the launch shrinks its reachable
surface rather than describing it. An MCP server is a child process of Codex
running outside the sandbox: a probe server launched by this exact form wrote
to `$HOME` and reached the network while the shell beside it could do neither
(2026-09-09). That is what lets the reviewer server deliver a verdict at all —
the Review Bridge store lives under the operator's home, outside every
writable root — and it is also why this plugin's second server matters.
`.mcp.json` starts two servers, and the author one carries
`submit_resolutions`, `prepare_rereview`, and `finalize_local_gate`.
Author/reviewer separation cannot rest on the sandbox, and it must not rest on
the guardian either — a call the reviewer frames as part of its task is exactly
what the guardian allows. Both launch lines therefore disable that server for
the run. The `command` override beside `enabled=false` is not redundant: a
lone `enabled` key makes Codex read the entry as a new server definition, find
no transport, and refuse the whole configuration with
`failed to load configuration` — the server is disabled, so the command it
names never runs. Verify the pair the way its effect is observable:
`codex mcp list` with both overrides reports the author server `disabled` and
the reviewer server `enabled`, and an author tool invoked from such a run
returns no tool rather than a result.

An `advisory: true` review does not take this launch. The sandbox bounds
writes and network, not reads. For an advisory member, load only the
[Advisory CODEX_TASK sandbox](codex-advisory.md) launch instead.

A round-two rereview uses `launch_local_reviewer` again with the inherited
selection and current state version. Its process has the same
shape, carrying the same review ID and a request to rereview the author's
resolutions with the packaged reviewer skill:

```bash
codex exec --skip-git-repo-check --sandbox workspace-write --model <selected-model> \
  -c 'model_reasoning_effort="<selected-effort>"' \
  -c 'sandbox_workspace_write.network_access=false' \
  -c 'sandbox_workspace_write.writable_roots=[]' \
  -c 'sandbox_workspace_write.exclude_slash_tmp=true' \
  -c 'sandbox_workspace_write.exclude_tmpdir_env_var=true' \
  -c 'approvals_reviewer="guardian_subagent"' \
  -c 'approval_policy={granular={rules=false,sandbox_approval=false,skill_approval=false,request_permissions=false,mcp_elicitations=false}}' \
  -c 'memories.use_memories=false' \
  -c 'memories.generate_memories=false' \
  -c 'mcp_servers.review-bridge-author.command="node"' \
  -c 'mcp_servers.review-bridge-author.enabled=false' \
  '<the rereview request>' < /dev/null
```

`codex exec resume <session-id>` exists, and `codex exec` prints the session id
it minted in its own header, so round two could inherit round one's context.
This flow deliberately does not resume. Round two is a fresh launch that did not
perform round one, reconstructed from the ledger, which `open_review` serves
whole — every round-one finding with its explanation, recommendation, and
status, and every author resolution with its rationale and evidence. The reason
is the evidence bar rather than a missing capability: the reviewer skill
requires each `rebuttal_accepted` decision to carry verification the reviewer
performed itself rather than recalled, and a resumed context reintroduces
exactly the recall this design makes the reviewer re-derive.

This launch may run unattended; it needs no operator at the keyboard. What the
HERMES and DeepSeek Harness sections require of their own launches is stated
there and is neither changed nor described by this one. Separately, the
autonomous workflow's own state machine dispatches `CODEX_TASK` and no other
provider; this shell launch is a different path from that one. Review Bridge
records the review's `CODEX_TASK` binding and requested launch configuration;
it does not authenticate the remote model identity. The
`CLAUDE_DESKTOP` boundary is unchanged, and nothing above narrows it: never
launch, script, or otherwise programmatically invoke a Claude reviewer from this
session — the operator opens that conversation themselves, an account-compliance
boundary rather than a convenience.
