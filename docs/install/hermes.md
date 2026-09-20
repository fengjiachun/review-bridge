# Install the Hermes reviewer profile

Describes Review Bridge v0.16.0.

Hermes is a supported local reviewer provider. The build output contains
`hermes-integration/`, which packages the same server runtime plus:

- `mcp/reviewer.config.yaml` — a reviewer-only Hermes MCP config snippet.
- `mcp/author.config.yaml` — a separate author-only Hermes MCP config snippet.
- `skills/review-bridge-reviewer/SKILL.md` — the Review Bridge-owned Hermes
  reviewer skill.
- `README.md` — install, upgrade, and profile-isolation instructions.

Hermes auto-injects every tool from a configured MCP server into the profile
that references it, so **author and reviewer MUST live in separate Hermes
profiles**: the reviewer profile receives only the reviewer server and skill,
and the author profile receives only the author server. Never add the
author/publication server to the reviewer profile, and never add a reviewer
provider binding to the author profile.

Run `npm run verify:build`, then render `__REVIEW_BRIDGE_RELEASE_PATH__` to the
absolute, versioned `review-bridge-v0.16.0/hermes-integration` directory and
`__REVIEW_BRIDGE_HOME__` to one explicit absolute shared store. Merge each
snippet's server entry into only its matching profile's top-level `mcp_servers`
mapping.
All participants share that one `REVIEW_BRIDGE_HOME` and one exact Review
Bridge version. The packaged `hermes-integration/README.md` gives the complete
install, profile tool checks, and atomic upgrade procedure.
