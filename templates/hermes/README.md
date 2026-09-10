# Review Bridge for Hermes

This directory is the self-contained Hermes integration for Review Bridge
v0.12.0. It contains the packaged server runtime, separate author and reviewer
MCP snippets, and a Review Bridge-owned reviewer skill. The reviewer snippet
runs `node <absolute-versioned-path>/server/server.mjs --role reviewer
--reviewer-provider HERMES`; the author snippet runs the same exact server with
only `--role author`.

## Why separate profiles

Configured MCP tools are profile-scoped and Hermes auto-injects every selected
tool into the profile that references the server. The author and reviewer
roles expose disjoint capabilities, so they MUST live in separate Hermes
profiles. The reviewer profile receives only the reviewer server and skill;
the author profile receives only the author server. Never add the
author/publication server to the reviewer profile, and never add a reviewer
server or provider binding to the author profile.

The reviewer allowlist contains exactly seven tools. Five list or read
immutable review state; `submit_review` and `submit_rereview` write verdicts to
the review ledger. They are reviewer-scoped, not intrinsically read-only, and
have no author or publication side effects. The author snippet deliberately has
no tool allowlist, so it cannot accidentally hide required author/publication
tools as that surface evolves.

## Install

1. Check out the exact `v0.12.0` tag, run `npm ci`, `npm test`, `npm run build`,
   and `npm run verify:build`. Keep the resulting
   `dist/review-bridge-v0.12.0/hermes-integration` directory in place.
2. Create dedicated author and reviewer profiles. Do not clone a profile after
   installing either Review Bridge MCP entry, because that would copy the
   opposite role's server into the new profile.
3. Render both snippets before installing them:
   - `__REVIEW_BRIDGE_RELEASE_PATH__` → the absolute path of the versioned
     `hermes-integration` directory, ending in
     `review-bridge-v0.12.0/hermes-integration`.
   - `__REVIEW_BRIDGE_HOME__` → the absolute path of the shared store used by
     every Review Bridge participant.
4. Merge the server entry from `mcp/reviewer.config.yaml` into the reviewer
   profile's top-level `mcp_servers` mapping. It starts the server with `--role reviewer
   --reviewer-provider HERMES` and exposes only the reviewer tools.
5. Merge the server entry from `mcp/author.config.yaml` into the author
   profile's top-level `mcp_servers` mapping. It starts the server with only
   `--role author`.
6. Copy the entire `skills/review-bridge-reviewer` directory into the reviewer
   profile's skills directory. Do not edit or replace a Hermes-bundled skill.
7. Reload MCP servers or restart both profiles.

Hermes' direct MCP schema has no `cwd` setting, so neither snippet uses one.
The rendered server path and shared store must be absolute; do not replace the
placeholders with relative paths, shell interpolation, a floating `main`
checkout, or a symlink that is retargeted during an upgrade. Do not put GitHub
tokens, API keys, or other credentials in the Review Bridge MCP env. The only
configured environment entry is `REVIEW_BRIDGE_HOME`.

## Verify the installation

Run `hermes -p <reviewer-profile> mcp test review-bridge-reviewer` and
`hermes -p <author-profile> mcp test review-bridge-author`. Inspect the
reviewer profile's selected MCP tools and require exactly:

```text
list_pending_reviews open_review read_review_artifact read_snapshot_file
search_snapshot submit_review submit_rereview
```

The reviewer profile must have no Review Bridge author/publication server or
tools. The author profile must have no Review Bridge reviewer server and must
retain the full author tool surface. Both rendered snippets must contain the
same absolute `REVIEW_BRIDGE_HOME` and the same absolute v0.12.0 integration
path.

## Review

In the reviewer profile, start a fresh, independent Hermes context and ask it
to follow the packaged reviewer skill for the pending Review Bridge task bound
to `HERMES`. The context must not be a fork of the author task or profile and
must have no authoring history for the change. A round-two rereview may reuse
the same reviewer context for that review ID. To have the driver session start
that context from the shell instead of starting it yourself, see Dispatch a
review from the driver session below.

## Dispatch a review from the driver session

The driver session authoring the change — a Codex task, or a Hermes instance
in the author profile — can dispatch this review itself instead of asking the
operator to start the reviewer by hand. The reviewer isolation the section
above requires is unchanged; only who performs the launch changes.

1. From the author side, call `prepare_review` with
   `reviewer_provider: HERMES` against an immutable base SHA and a committed
   head, and record the returned review ID and `state_version`.
2. Launch a fresh instance in the reviewer profile from the shell, handing it
   the reviewer request below as its single query:

   ```bash
   hermes -p <reviewer-profile> chat -q '<the reviewer request below>' < /dev/null
   ```

   > Independently review Review Bridge task `<review_id>` using the packaged
   > Hermes reviewer skill. Require `reviewer_provider: HERMES`, follow the
   > review strategy, and submit every actionable finding.

   Single-quote that request: it contains backticks, and a double-quoted shell
   string would execute them instead of passing them through. Pass it as one
   line with `<review_id>` substituted. Redirect stdin from `/dev/null`, as
   both launch lines here do: the launch has no terminal on stdin, and an
   approval prompt that fires anyway then reads end-of-file and is denied at
   once instead of waiting — what can raise one is stated below the launch
   discipline. Run the launch so it does not block step 3 — background it or
   use a separate terminal — and capture its stderr, where Hermes prints a
   `session_id:` line on exit.
3. Wait for the verdict with `wait_for_review_state` on the recorded
   `state_version`. Its bounded wait returns `timed_out` while the review is
   still in progress, which is expected; call it again with the same
   `state_version`. Unlike the one-shot `-z` mode, `chat -q` does not
   auto-approve tool prompts; what keeps the seven Review Bridge calls from
   raising one is the reviewer snippet's `trust: full`, below. If the wait
   keeps timing out, read the launch output before assuming the review is
   merely slow. When the review is submitted, report every finding in the
   driver session with its ID, severity, one-line summary, and location, and
   report each disposition after the author records it — reading both from the
   review ledger rather than from chat text.

The launch discipline states what must never happen rather than counting
launches. Never run two reviewers on the same round at once, and never review
from the author profile: never launch the author profile to review, never
resume or continue an existing Hermes session for a new review, and never pass
any authoring history — the diff, the requirement discussion, the author's
reasoning, or the driver session's transcript. Within those two bars launches
are not rationed. That request is the whole handoff.

A round-two rereview of the same review ID resumes the instance that produced
round one, in the same shape as the launch:

```bash
hermes -p <reviewer-profile> chat --resume <session-id> -q '<rereview request>' < /dev/null
```

Send it the same review ID and a request to rereview the author's resolutions
with the packaged reviewer skill. That resume is round two's launch, so it is
required rather than an exception, and it starts no second reviewer: the
resumed instance is the one reviewer on that round.

A launch that has exited leaves the round to be judged from the ledger: if the
ledger shows no verdict for this round, no reviewer is working it, so start a
replacement launch in the same shape as the original; that replacement is the
same round, and both bars still hold, because the reviewer it replaces is gone.
The exit status, zero or not, establishes only that the process is gone — a run
can submit its verdict and then fail while saving its session or printing its
output, and a replacement started on that exit code alone would rerun a round
the ledger already carries. Judge that by the process having exited, never by
`wait_for_review_state` timing out: a timeout says the round is unfinished, not
that the reviewer is gone, and replacing a reviewer that is merely slow creates
exactly the concurrent pair the first bar forbids. The driver started the
process, so it has the exit status to judge by. A round-one replacement is a
fresh instance, not a resume: the launch it replaces produced no round one, so
there is nothing to resume, and the replacement's own `session_id:` line is the
one round two resumes. A round-two replacement resumes the round-one instance
again, as the launch it replaces did.

A launch sitting at a prompt has not exited, so the replacement rule does not
fire for it while it waits, and a replacement started after the denial meets
the same prompt; that is why the approval is settled by the snippet's
`trust: full` rather than by anyone at the keyboard.

Launch it outside the repository under review. Hermes injects project context
from the working directory — the first of `.hermes.md`, `AGENTS.md`,
`CLAUDE.md`, or `.cursorrules` that it finds wins, and the first two are
collected from the git root down rather than from that directory alone — so a
reviewer started in the authoring worktree inherits whatever rules the
workspace carries for its author. Pass `--in <directory outside the
worktree>` when the driver session's shell is inside it, and prefer a
directory in no repository at all, since one inside another repository
inherits that repository's rules instead. The reviewer process needs no
checkout of its own: its tools read the change from the immutable snapshot and
from the author's repository by recorded path, never from its own working
directory. Its `SOUL.md`, memory, and skills come from the reviewer profile's
Hermes home, which `-p` already separates.

This launch may run unattended; it needs no operator at the keyboard, and
what that rests on is one key in the packaged reviewer snippet: `trust: full`
on the `review-bridge-reviewer` server. Hermes routes an MCP call through its
approval prompt only on a server configured `trust: untrusted`, and there for
every tool without a `readOnlyHint` annotation, which is all seven here; on a
`trust: full` server no call of that server's tools is gated, so
`list_pending_reviews`, `open_review`, and `submit_review` run without a
prompt. That was measured on 2026-09-10 rather than read: under this launch
`list_pending_reviews` completed in 0.4 s and the run exited 0, and with the
same server marked `trust: untrusted` the same call raised the prompt —
`Server 'review-bridge-reviewer' is configured 'trust: untrusted'` — read
end-of-file from the closed stdin, and was denied without running. `full` is
also what Hermes assumes for a server with no `trust` key; the snippet names
it so the launch rests on packaged configuration rather than on a default.
One prompt remains outside the snippet's reach: a shell command Hermes classes
as dangerous, from any built-in toolset the reviewer profile carries beside
the server. The reviewer skill gives the reviewer no reason to run one, and
by Hermes' approval code every prompt path is bounded by `approvals.timeout`,
300 s by default, and denies when it expires — read from the source, not
measured here — so even that prompt ends in a denial rather than a wait.

Review Bridge records the review's `HERMES` binding; it observes nothing about
how the instance was started, and this section adds no mechanism that would.
Local autonomous task creation still accepts `CODEX_TASK` dispatch only. The
`CLAUDE_DESKTOP` boundary is unchanged, and nothing above narrows it: never
launch, script, or otherwise programmatically invoke a Claude reviewer from
the driver session — the operator opens that conversation themselves, an
account-compliance boundary rather than a convenience.

## Upgrade

Build the new exact release tag into a new versioned directory and run its full
build verification before switching profiles. Re-render both snippets to that
new immutable path, update the author and reviewer profiles together, and
restart them. Keep `REVIEW_BRIDGE_HOME` unchanged. Do not overwrite the old
runtime in place or run mixed Review Bridge versions against the shared store.
Every participant sharing that store must run one exact Review Bridge version.

## Boundaries

- `HERMES` is configured local reviewer provenance, not cryptographic model
  identity.
- Local autonomous task creation remains `CODEX_TASK`-only; the Hermes
  reviewer never creates or advances local autonomous workflow tasks.
- Remote GitHub Codex publication is performed by the author/publication side
  only after the local HERMES reviewer gate has passed.
