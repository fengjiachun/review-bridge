# Install the DeepSeek Harness reviewer profile

Describes Review Bridge v0.16.0.

DeepSeek Harness is a supported local reviewer provider. The build output
contains `deepseek-harness/`, which packages the same server runtime plus:

- `cordis/reviewer.patch.yml` — a reviewer-only profile patch snippet.
- `cordis/author.patch.yml` — a separate author-only profile patch snippet.
- `skills/review-bridge-reviewer/SKILL.md` — the Review Bridge-owned DeepSeek
  Harness reviewer skill.
- `README.md` — install, upgrade, and profile-isolation instructions.

Every MCP server a profile configures registers its tools for that profile's
model, so **author and reviewer MUST live in separate profiles**, on the same
terms as Hermes. Two further scopes are host-level rather than profile-level —
skill discovery and the user-global `AGENTS.md` — and the packaged reviewer
snippet restricts both to the release directory so the reviewer inherits
neither the machine's other skills nor the author's guidance.

Pin `@deepseek-ai/dsh@0.1.0-rc.6`, the release these snippets were verified
against; its plugin configuration is a developer preview and will move. Run
`npm run verify:build`, then render `__REVIEW_BRIDGE_RELEASE_PATH__` to the
absolute, versioned `review-bridge-v0.16.0/deepseek-harness` directory and
`__REVIEW_BRIDGE_HOME__` to one explicit absolute shared store. Append each
snippet's entries to only its matching profile's `cordis.patch.yml`. The
packaged `deepseek-harness/README.md` gives the complete install, profile tool
checks, and atomic upgrade procedure.

`DEEPSEEK_HARNESS` records configured reviewer provenance; it is not
cryptographic model identity. Autonomous local task creation remains
`CODEX_TASK`-only. A round-two rereview runs in a new session rather than a
resumed one, because a headless run always starts a fresh session; the reviewer
decides from the ledger `open_review` serves and re-runs its own verification.
