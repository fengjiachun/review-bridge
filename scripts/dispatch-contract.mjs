import assert from "node:assert/strict";

// The driver-dispatched HERMES launch contract. Both author-side surfaces
// carry it, and each ships to a reader who may never see the other: the Codex
// plugin skill is not packaged into hermes-integration, and the Hermes README
// is not packaged into the Codex plugin. So both are held to the same
// requirements, here, once — test/hermes-integration.test.mjs asserts them
// against the source templates and scripts/verify-build.mjs against the
// packaged copies, and a single list keeps the release check from silently
// drifting weaker than the CI check.

// Matched against the section with blockquote markers stripped and whitespace
// collapsed, so a rewrap can never break one. Each entry is a claim the
// contract stops being operative without, not a phrasing preference: an
// alternation means the two surfaces legitimately say the same thing
// differently, because the skill defers to its own Prepare and Handle findings
// sections while the README, which ships without them, states it inline.
export const DISPATCH_CONTRACT_REQUIREMENTS = [
  [
    "step 1 binds the review to HERMES",
    /(?:`prepare_review` with `reviewer_provider: HERMES`|choosing `HERMES` at its provider step)/,
  ],
  [
    "step 1 records the state version the wait needs",
    /[Rr]ecord the returned (?:`review_id`|review ID) and `state_version`/,
  ],
  [
    "the reviewer request is the whole handoff, binding included",
    /Independently review Review Bridge task `<review_id>` using the packaged Hermes reviewer skill\. Require `reviewer_provider: HERMES`, follow the review strategy, and submit every actionable finding\./,
  ],
  [
    "the wait is bound to the recorded state version",
    /`wait_for_review_state` on the recorded `state_version`/,
  ],
  [
    "an unattended launch can stall on an approval prompt",
    /`chat -q` does not auto-approve tool prompts/,
  ],
  [
    "the session id round two resumes with is captured",
    /capture its stderr[\s\S]*?`session_id:`/,
  ],
  [
    "findings are narrated from the ledger",
    /(?:narrating every finding from the ledger|from the review ledger rather than from chat text)/,
  ],
  ["the request is single-quoted", /[Ss]ingle-quote that request[\s\S]*?backticks/],
  ["the launch does not block the wait", /background it or use a separate terminal/],
  ["one instance per review", /[Oo]ne new instance per (?:`review_id`|review ID)/],
  [
    "no context reuse",
    /[Nn]ever resume or continue an existing Hermes session for a new review/,
  ],
  ["no author profile", /[Nn]ever launch the author profile to review/],
  ["no authoring history", /[Nn]ever pass any authoring history/],
  // Hermes injects project context from the working directory, so a reviewer
  // launched inside the authoring worktree inherits that workspace's rules.
  [
    "the launch happens outside the repository under review",
    /[Ll]aunch it outside the repository under review/,
  ],
  [
    "the working directory is redirectable",
    /`--in <directory outside the worktree>`/,
  ],
  // The boundary this contract must never quietly lose.
  ["the flow is operator-present", /operator-present manual flow/],
  [
    "nothing verifies the dispatch",
    /observes nothing about how the instance was started/,
  ],
  ["autonomous dispatch stays CODEX_TASK-only", /`CODEX_TASK` dispatch only/],
];

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The body between a `## ` heading and the next one, or the end of the
// document when the section is last.
export function extractMarkdownSection(document, heading) {
  const match = document.match(
    new RegExp(
      `\\n${escapeRegExp(heading)}\\n(?<body>[\\s\\S]*?)(?=\\n## |\\s*$)`,
    ),
  );
  return match ? match.groups.body : null;
}

export function assertDispatchContract(document, heading, label) {
  const body = extractMarkdownSection(document, heading);
  assert.ok(body, `${label}: "${heading}" is missing`);
  const prose = body.replace(/^ *> ?/gm, "").replace(/\s+/g, " ");

  // The launch must stay non-interactive and must not hold the shell. A bare
  // `hermes -p <profile> chat` is an interactive REPL: a driver session can
  // neither hand it the reviewer request nor reach the wait while it blocks.
  assert.match(
    body,
    /```bash\n *hermes -p <reviewer-profile> chat -q '/,
    `${label}: launch is not the non-interactive single-query form`,
  );
  assert.doesNotMatch(
    body,
    /^ *hermes -p <reviewer-profile> chat$/m,
    `${label}: launch regressed to the interactive REPL form`,
  );
  // Round two resumes the same instance, and needs a runnable form for it.
  assert.match(
    body,
    /```bash\n *hermes -p <reviewer-profile> chat --resume <session-id> -q '/,
    `${label}: round-two resume form`,
  );

  for (const [requirement, pattern] of DISPATCH_CONTRACT_REQUIREMENTS) {
    assert.match(prose, pattern, `${label}: ${requirement}`);
  }
}
