# Review Bridge for Hermes

This directory is the self-contained Hermes integration for Review Bridge
v0.8.0. It contains the packaged server runtime, separate author and reviewer
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

1. Check out the exact `v0.8.0` tag, run `npm ci`, `npm test`, `npm run build`,
   and `npm run verify:build`. Keep the resulting
   `dist/review-bridge-v0.8.0/hermes-integration` directory in place.
2. Create dedicated author and reviewer profiles. Do not clone a profile after
   installing either Review Bridge MCP entry, because that would copy the
   opposite role's server into the new profile.
3. Render both snippets before installing them:
   - `__REVIEW_BRIDGE_RELEASE_PATH__` → the absolute path of the versioned
     `hermes-integration` directory, ending in
     `review-bridge-v0.8.0/hermes-integration`.
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
same absolute `REVIEW_BRIDGE_HOME` and the same absolute v0.8.0 integration
path.

## Review

In the reviewer profile, start a fresh, independent Hermes context and ask it
to follow the packaged reviewer skill for the pending Review Bridge task bound
to `HERMES`. The context must not be a fork of the author task or profile and
must have no authoring history for the change. A round-two rereview may reuse
the same reviewer context for that review ID.

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
   hermes -p <reviewer-profile> chat -q '<the reviewer request below>'
   ```

   > Independently review Review Bridge task `<review_id>` using the packaged
   > Hermes reviewer skill. Require `reviewer_provider: HERMES`, follow the
   > review strategy, and submit every actionable finding.

   Single-quote that request: it contains backticks, and a double-quoted shell
   string would execute them instead of passing them through. Pass it as one
   line with `<review_id>` substituted. Run the launch so it does not block
   step 3 — background it or use a separate terminal — and capture its stderr,
   where Hermes prints a `session_id:` line on exit.
3. Wait for the verdict with `wait_for_review_state` on the recorded
   `state_version`. Its bounded wait returns `timed_out` while the review is
   still in progress, which is expected; call it again with the same
   `state_version`. Unlike the one-shot `-z` mode, `chat -q` does not
   auto-approve tool prompts, so an unattended launch can stall on one; if the
   wait keeps timing out, read the launch output before assuming the review is
   merely slow. When the review is submitted, report every finding in the
   driver session with its ID, severity, one-line summary, and location, and
   report each disposition after the author records it — reading both from the
   review ledger rather than from chat text.

One new instance per review ID. Never resume or continue an existing Hermes
session for a new review, never launch the author profile to review, and never
pass any authoring history — the diff, the requirement discussion, the
author's reasoning, or the driver session's transcript. That request is the
whole handoff.

Only a round-two rereview of the same review ID may resume the instance that
produced round one, in the same shape as the launch:

```bash
hermes -p <reviewer-profile> chat --resume <session-id> -q '<rereview request>'
```

Send it the same review ID and a request to rereview the author's resolutions
with the packaged reviewer skill.

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

This is the operator-present manual flow, and the operator's presence is what
attests that the reviewer was launched this way. Review Bridge records the
review's `HERMES` binding; it observes nothing about how the instance was
started, and this section adds no mechanism that would. Local autonomous task
creation still accepts `CODEX_TASK` dispatch only.

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
