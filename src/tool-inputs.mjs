// Declared next-call inputs for every transition a read surface points at.
//
// A driver that reads a summary must not have to discover a tool's required
// arguments by sending empty ones and parsing the validation error. Each entry
// maps a next-action code to the tool calls it implies and, per call, the exact
// tool field names with where each value comes from.
//
// Emitted shape, kept terse because every byte is a driver context token:
//   {"<tool_name>": [["<tool_field>", "<source>"], ...]}
// A source names a field on the same summary unless it names another tool, a
// fuller read surface, or an external read. Fields whose requirement depends on
// evidence the ledger cannot see carry that condition in their source text.
//
// This table declares; it never validates. Transition semantics live in the
// tools themselves, and test/tool-inputs.test.mjs holds the declarations to
// them so a transition cannot gain a required field without this going red.

// The pull request identity every publication start binds, minus the review ID
// that says which authorization is being published.
const PUBLICATION_TARGET_INPUTS = [
  ["repository_id", "the pull request read"],
  ["owner", "the pull request read"],
  ["repo", "the pull request read"],
  ["pr_number", "the pull request read"],
  ["base_branch", "the pull request read"],
  ["head_branch", "the pull request read"],
  ["codex_actor_id", "the pinned Codex bot actor"],
  ["codex_actor_type", "Bot"],
  ["codex_actor_login", "the pinned Codex bot actor"],
  ["codex_trigger_mode", "the operator's trigger policy"],
  ["codex_review_baseline_path", "the collector --baseline file"],
  [
    "operator_label",
    "the acknowledging human; required for AUTOMATIC_QUIESCENCE_ACKNOWLEDGED, refused for EXPLICIT_ONLY",
  ],
  [
    "rationale",
    "the acknowledging human; required for AUTOMATIC_QUIESCENCE_ACKNOWLEDGED, refused for EXPLICIT_ONLY",
  ],
];

// The report a passed gate is followed by: a read of the ledgers, written
// beside them, that advances nothing. Declared where the workflow skill calls
// it -- once the local gate is recorded, and once the publication reads
// MERGE_READY -- so a driver finds it here rather than in prose.
const REVIEW_REPORT = [["review_id", "id"]];

export const REVIEW_ACTION_INPUTS = {
  AUTHOR_RESOLUTIONS: {
    submit_resolutions: [
      ["review_id", "id"],
      ["resolutions", "one entry per active_findings[].id"],
    ],
  },
  ADDRESS_LOCAL_FINDINGS: {
    prepare_review: [
      ["repository_path", "get_review repository_path"],
      ["base_ref", "get_review base_ref"],
      ["requirement", "get_review requirement"],
      [
        "implementation_scope",
        "your scope for the new head; get_review implementation_scope may be reused",
      ],
      ["rationale", "optional, your design rationale for the new head"],
      ["reviewer_provider", "reviewer_provider; may be omitted when it is CODEX_TASK"],
      ["continued_from_review_id", "id"],
      ["force_full_review", "true, required with continued_from_review_id"],
    ],
  },
  PREPARE_REREVIEW: { prepare_rereview: [["review_id", "id"]] },
  FINALIZE_LOCAL_GATE: { finalize_local_gate: [["review_id", "id"]] },
  PUBLISH: {
    render_review_report: REVIEW_REPORT,
    start_publication: [["review_id", "id"], ...PUBLICATION_TARGET_INPUTS],
  },
  HUMAN_ARBITRATION: {
    export_human_arbitration: [
      ["review_id", "id"],
      ["expected_state_version", "state_version"],
    ],
  },
};

export const PUBLICATION_ACTION_INPUTS = {
  RECORD_GITHUB_SNAPSHOT: {
    record_github_snapshot: [
      ["review_id", "review_id"],
      ["expected_revision", "revision"],
      ["observation_path", "the collector --out file"],
    ],
  },
  POST_AND_RECORD_CODEX_REVIEW_REQUEST: {
    record_codex_review_request: [
      ["review_id", "review_id"],
      ["expected_revision", "revision"],
      ["comment_id", "the comment posted from codex_review_request"],
      ["url", "the posted comment"],
      ["created_at", "the posted comment"],
      ["requested_head_sha", "head_sha"],
      ["request_id", "the posted comment, when the response carries one"],
    ],
  },
  ACKNOWLEDGE_CODEX_REVIEW_AMBIGUITY: {
    acknowledge_codex_review_ambiguity: [
      ["review_id", "review_id"],
      ["expected_revision", "revision"],
      ["head_sha", "head_sha"],
      ["request_refs", "required_request_refs"],
      ["ambiguous_results", "required_ambiguous_results"],
      ["acknowledgement", "NO_FURTHER_RESULTS_EXPECTED"],
      ["operator_label", "the deciding human"],
      ["rationale", "the deciding human"],
    ],
  },
  FINALIZE_PUBLICATION_GATE: {
    render_review_report: [["review_id", "review_id"]],
    finalize_publication_gate: [
      ["review_id", "review_id"],
      ["expected_revision", "revision"],
    ],
  },
  VERIFY_PUBLICATION_GATE: {
    verify_publication_gate: [["review_id", "review_id"]],
  },
  START_NEW_PUBLICATION_AUTHORIZATION: {
    // This publication's ID is spent: its ledger exists, and start_publication
    // requires one that does not. The remote-only path mints the replacement
    // here; the local-gate path reaches its own through a fresh review.
    authorize_remote_publication: [
      ["repository_path", "the authoring repository"],
      ["base_sha", "the base the pull request merges into"],
      ["head_sha", "the head to publish"],
      ["acknowledgement", "LOCAL_REVIEW_SKIPPED"],
      ["operator_label", "the deciding human"],
      ["rationale", "the deciding human"],
    ],
    start_publication: [
      [
        "review_id",
        "the authorize_remote_publication result id, or a new local gate",
      ],
      ...PUBLICATION_TARGET_INPUTS,
    ],
  },
};

// Every remaining blocking action is fixed outside the ledger; the call that
// then moves the ledger is the same fresh snapshot in each case.
for (const action of [
  "REFRESH_GITHUB_SNAPSHOT",
  "FIX_REQUIRED_CHECKS",
  "ADDRESS_GITHUB_REVIEW_FEEDBACK",
  "MARK_PULL_REQUEST_READY",
  "RESOLVE_PULL_REQUEST_CONFLICTS",
]) {
  PUBLICATION_ACTION_INPUTS[action] =
    PUBLICATION_ACTION_INPUTS.RECORD_GITHUB_SNAPSHOT;
}

export function reviewRequiredInputs(actionRequired) {
  return REVIEW_ACTION_INPUTS[actionRequired] ?? {};
}

export function publicationRequiredInputs(nextAction) {
  return PUBLICATION_ACTION_INPUTS[nextAction] ?? {};
}
