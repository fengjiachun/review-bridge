# Review Bridge for DeepSeek Harness

This directory is the self-contained DeepSeek Harness integration for Review
Bridge v0.10.0. It contains the packaged server runtime, separate author and
reviewer profile patch snippets, and a Review Bridge-owned reviewer skill. The
reviewer snippet runs `node <absolute-versioned-path>/server/server.mjs --role
reviewer --reviewer-provider DEEPSEEK_HARNESS`; the author snippet runs the
same exact server with only `--role author`.

Pin DeepSeek Harness to `@deepseek-ai/dsh@0.1.0-rc.6`, the release these
snippets were verified against. Its plugin configuration is a developer
preview and will move; do not run these snippets against a different DeepSeek
Harness release without re-verifying them.

## Why separate profiles

A DeepSeek Harness profile is a directory under `$DSH_HOME/profiles/<name>`
holding its own bundle list and `cordis.patch.yml`, and every MCP server that
profile configures registers its tools for the model. The author and reviewer
roles expose disjoint capabilities, so they MUST live in separate profiles.
The reviewer profile receives only the reviewer server and skill; the author
profile receives only the author server. Never add the author/publication
server to the reviewer profile, and never add a reviewer server or provider
binding to the author profile.

The reviewer sees exactly seven tools, published as
`mcp__review-bridge-reviewer__<name>`. That number comes from the server's
`--role reviewer`, not from a client-side allowlist: unlike Hermes, the
DeepSeek Harness MCP client has no tool-include setting and registers whatever
the server advertises. Five of the seven list or read immutable review state;
`submit_review` and `submit_rereview` write verdicts to the review ledger.
They are reviewer-scoped, not intrinsically read-only, and have no author or
publication side effects. The author snippet deliberately has no tool
restriction either, so it cannot accidentally hide required author or
publication tools as that surface evolves.

Two DeepSeek Harness surfaces are host-level rather than profile-level, and
the reviewer snippet closes both. Skill discovery otherwise reaches
`$DSH_AGENTS_HOME/skills` and every project skill root, so the reviewer would
inherit unrelated skills installed on the machine; the snippet restricts the
filesystem provider to this directory's `skills` alone. Workspace instructions
otherwise include one user-global `$DSH_HOME/AGENTS.md` shared with the author
profile; the snippet points that scope at this packaged directory, which
contains no `AGENTS.md` and is checked at release time to keep it that way.
Neither closure is available by putting the reviewer in its own profile, which
is why they are part of the snippet rather than install prose.

## Install

1. Check out the exact `v0.10.0` tag, run `npm ci`, `npm test`, `npm run build`,
   and `npm run verify:build`. Keep the resulting
   `dist/review-bridge-v0.10.0/deepseek-harness` directory in place.
2. Create dedicated author and reviewer profile directories under
   `$DSH_HOME/profiles/<name>`. Each needs a `package.json` carrying a
   `dsh.profile.bundles` list, an empty `cordis.patch.yml` holding `[]`, and
   the `pnpm-workspace.yaml` a profile ships with. The reviewer profile's
   bundles must be `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]`:
   the headless bundle is what makes the driver-dispatched launch below a
   one-shot run, and a profile without it boots whatever surface its bundles
   do select and never reads the task. The author profile takes whichever
   surface you author in and needs no particular bundle from Review Bridge. Do
   not copy an existing profile directory after installing either Review
   Bridge entry, because that would carry the opposite role's server into the
   new profile.
3. Render both snippets before installing them:
   - `__REVIEW_BRIDGE_RELEASE_PATH__` → the absolute path of the versioned
     `deepseek-harness` directory, ending in
     `review-bridge-v0.10.0/deepseek-harness`.
   - `__REVIEW_BRIDGE_HOME__` → the absolute path of the shared store used by
     every Review Bridge participant.
4. Append the rendered entries from `cordis/reviewer.patch.yml` to the reviewer
   profile's `cordis.patch.yml`, keeping that file a single top-level YAML
   array. They start the server with `--role reviewer --reviewer-provider
   DEEPSEEK_HARNESS` and restrict the profile's skill and workspace-instruction
   scopes.
5. Append the rendered entry from `cordis/author.patch.yml` to the author
   profile's `cordis.patch.yml`. It starts the server with only `--role
   author`.
6. Leave `skills/review-bridge-reviewer` where it is. Unlike the Hermes
   integration, nothing is copied into the profile: the rendered reviewer
   snippet points `customSkillDirs` at this directory's `skills` root, so the
   reviewer loads the skill from the same versioned directory it runs the
   server from. Do not edit it or replace a DeepSeek Harness-bundled skill.

The rendered server path and shared store must be absolute; do not replace the
placeholders with relative paths, shell interpolation, a floating `main`
checkout, or a symlink that is retargeted during an upgrade. Do not put GitHub
tokens, API keys, or other credentials in the Review Bridge MCP env. The only
configured environment entry is `REVIEW_BRIDGE_HOME`. Neither snippet sets
`toolCallTimeoutMs`: a maximum-size `read_review_artifact` chunk returns in
single-digit milliseconds, so the 60-second default has room to spare.

## Verify the installation

Inspect the composed reviewer tree and the reviewer's tools:

```bash
dsh --profile <reviewer-profile> --dump-config
```

Require exactly one `@deepseek-ai/dsh-mcp-client` entry, whose `args` carry
`--role reviewer --reviewer-provider DEEPSEEK_HARNESS`, and no second Review
Bridge server. The composed tree does not list tool names, so confirm those
with a one-shot run from a directory outside any repository under review:

```bash
dsh --profile <reviewer-profile> 'List every tool available to you whose name begins with mcp__. Print only those names, one per line, and call no tool.'
```

Require exactly:

```text
mcp__review-bridge-reviewer__list_pending_reviews
mcp__review-bridge-reviewer__open_review
mcp__review-bridge-reviewer__read_review_artifact
mcp__review-bridge-reviewer__read_snapshot_file
mcp__review-bridge-reviewer__search_snapshot
mcp__review-bridge-reviewer__submit_review
mcp__review-bridge-reviewer__submit_rereview
```

The reviewer profile must have no Review Bridge author/publication server or
tools. The author profile must have no Review Bridge reviewer server and must
retain the full author tool surface. Both rendered snippets must contain the
same absolute `REVIEW_BRIDGE_HOME` and the same absolute v0.10.0 integration
path.

## Review

In the reviewer profile, start a fresh, independent DeepSeek Harness session
and ask it to follow the packaged reviewer skill for the pending Review Bridge
task bound to `DEEPSEEK_HARNESS`. The session must not be a fork of the author
task or profile and must have no authoring history for the change. To have the
driver session start that session from the shell instead of starting it
yourself, see Dispatch a review from the driver session below.

## Dispatch a review from the driver session

The driver session authoring the change — a Codex task, or a Hermes instance
in its author profile — can dispatch this review itself instead of asking the
operator to start the reviewer by hand. The reviewer isolation the section
above requires is unchanged; only who performs the launch changes.

1. From the author side, call `prepare_review` with
   `reviewer_provider: DEEPSEEK_HARNESS` against an immutable base SHA and a
   committed head, and record the returned review ID and `state_version`.
2. Launch a fresh headless run in the reviewer profile from the shell, handing
   it the reviewer request below as its single task:

   ```bash
   dsh --profile <reviewer-profile> '<the reviewer request below>'
   ```

   > Independently review Review Bridge task `<review_id>` using the packaged
   > Review Bridge reviewer skill. Require `reviewer_provider:
   > DEEPSEEK_HARNESS`, follow the review strategy, and submit every
   > actionable finding.

   Single-quote that request: it contains backticks, and a double-quoted shell
   string would execute them instead of passing them through. Pass it as one
   line with `<review_id>` substituted. `headless` is a profile name rather
   than a subcommand, so it is the reviewer profile's bundle list that selects
   the one-shot runner and the word never appears on this command line. Run
   the launch so it does not block step 3 — background it or use a separate
   terminal.
3. Wait for the verdict with `wait_for_review_state` on the recorded
   `state_version`. Its bounded wait returns `timed_out` while the review is
   still in progress, which is expected; call it again with the same
   `state_version`. The headless run prints only the reviewer's final message
   on stdout and stays silent on stderr unless it failed, so a nonzero exit is
   the signal to read its output before assuming the review is merely slow.
   When the review is submitted, report every finding in the driver session
   with its ID, severity, one-line summary, and location, and report each
   disposition after the author records it — reading both from the review
   ledger rather than from chat text.

One new session per review ID. Never continue an existing DeepSeek Harness
session for a new review, never launch the author profile to review, and never
pass any authoring history — the diff, the requirement discussion, the
author's reasoning, or the driver session's transcript. That request is the
whole handoff.

A round-two rereview of the same review ID is another launch in the same
shape, with the same review ID and a request to rereview the author's
resolutions using the packaged reviewer skill:

```bash
dsh --profile <reviewer-profile> '<the rereview request>'
```

That round runs in a session that did not perform round one, and there is no
session id to capture: the headless runner mints a fresh session per
invocation and exposes no way to name or resume one. Round two is
reconstructed from the ledger instead, which `open_review` serves whole —
every round-one finding with its explanation, recommendation, and status, and
every author resolution with its rationale and evidence. This is the same
material a resumed context would have been asked to decide against, and the
reviewer skill already requires each `rebuttal_accepted` decision to carry
verification the reviewer performed itself rather than recalled.

Launch it outside the repository under review. The invoking directory is the
session's workspace root, and DeepSeek Harness loads `AGENTS.md` and
`CLAUDE.md` from the project root — the nearest `.git` ancestor — down to that
directory, so a reviewer started in the authoring worktree inherits whatever
rules the workspace carries for its author. There is no flag that redirects
the workspace root, so run the launch from a directory outside the worktree,
and prefer a directory in no repository at all, since one inside another
repository inherits that repository's rules instead. The reviewer process
needs no checkout of its own: its tools read the change from the immutable
snapshot and from the author's repository by recorded path, never from its own
working directory. Its skills and user-global instructions come from the
reviewer profile's rendered snippet, which points both at this packaged
directory.

This is the operator-present manual flow, and the operator's presence is what
attests that the reviewer was launched this way. Review Bridge records the
review's `DEEPSEEK_HARNESS` binding; it observes nothing about how the session
was started, and this section adds no mechanism that would. Local autonomous
task creation still accepts `CODEX_TASK` dispatch only.

## Upgrade

Build the new exact release tag into a new versioned directory and run its full
build verification before switching profiles. Re-render both snippets to that
new immutable path, update the author and reviewer profiles together, and
restart them. Keep `REVIEW_BRIDGE_HOME` unchanged. Do not overwrite the old
runtime in place or run mixed Review Bridge versions against the shared store.
Every participant sharing that store must run one exact Review Bridge version.
Re-verify the snippets against the DeepSeek Harness release you pin, because
its plugin configuration is still a developer preview.

## Boundaries

- `DEEPSEEK_HARNESS` is configured local reviewer provenance, not cryptographic
  model identity.
- Local autonomous task creation remains `CODEX_TASK`-only; the DeepSeek
  Harness reviewer never creates or advances local autonomous workflow tasks.
- Remote GitHub Codex publication is performed by the author/publication side
  only after a local reviewer gate has passed. On a publish-bound change that
  gate is a `CODEX_TASK` review by default, and a `DEEPSEEK_HARNESS` review is
  the verification-shape second opinion beside it — how a change is tested,
  pinned, and fixtured — rather than the gate that authorizes the publication.
