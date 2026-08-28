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

const WORKFLOW_ID = ["workflow_id", "workflow_id"];
const WORKFLOW_REVISION = ["expected_revision", "revision"];
const ACTION_ID = ["action_id", "active_action.action_id"];
const WORKFLOW_ACTION = [WORKFLOW_ID, WORKFLOW_REVISION, ACTION_ID];
const COMMITTED_HEAD = [
  WORKFLOW_ID,
  WORKFLOW_REVISION,
  ["head_sha", "the commit you just made"],
];
const COMPLETE_ACTION = { complete_workflow_action: WORKFLOW_ACTION };
const MARK_EXECUTING = { mark_workflow_action_executing: WORKFLOW_ACTION };
const ADVANCE_LOCAL = {
  advance_local_workflow: [WORKFLOW_ID, WORKFLOW_REVISION],
};
const RECORD_HEAD = { record_workflow_head: COMMITTED_HEAD };

// The publication a workflow phase reaches through, addressed by its own
// review ID and its own revision rather than the workflow's.
const PUBLICATION_ID = ["review_id", "current_publication.review_id"];
const PUBLICATION_REVISION = [
  "expected_revision",
  "get_publication_summary revision",
];
const REFRESH_SNAPSHOT = [
  PUBLICATION_ID,
  PUBLICATION_REVISION,
  ["observation_path", "the collector --out file"],
];

const BUDGET_EXTENSION = [
  WORKFLOW_ID,
  WORKFLOW_REVISION,
  ["new_budget", "the raised budget"],
  ["operator_label", "the deciding human"],
  ["rationale", "the deciding human"],
];

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
  ["codex_review_baseline", "the collector's preexisting Codex baseline"],
];

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
      ["implementation_scope", "get_review implementation_scope"],
      ["reviewer_provider", "reviewer_provider"],
      ["continued_from_review_id", "id"],
      ["force_full_review", "true, required with continued_from_review_id"],
    ],
  },
  PREPARE_REREVIEW: { prepare_rereview: [["review_id", "id"]] },
  FINALIZE_LOCAL_GATE: { finalize_local_gate: [["review_id", "id"]] },
  PUBLISH: {
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
    finalize_publication_gate: [
      ["review_id", "review_id"],
      ["expected_revision", "revision"],
    ],
  },
  VERIFY_PUBLICATION_GATE: {
    verify_publication_gate: [["review_id", "review_id"]],
  },
  START_NEW_PUBLICATION_AUTHORIZATION: {
    start_publication: [
      ["review_id", "a new local gate or authorize_remote_publication"],
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

export const WORKFLOW_ACTION_INPUTS = {
  COMMIT_HEAD: RECORD_HEAD,
  ADDRESS_LOCAL_FINDINGS: RECORD_HEAD,
  ADDRESS_REMOTE_FINDINGS: RECORD_HEAD,
  ADDRESS_CHECK_FAILURE: RECORD_HEAD,
  UPDATE_FROM_BASE: RECORD_HEAD,
  PREPARE_LOCAL_REVIEW: {
    prepare_review: [
      ["repository_path", "get_autonomous_workflow repository.path"],
      ["base_ref", "base_sha"],
      ["requirement", "get_autonomous_workflow requirement"],
      [
        "implementation_scope",
        "get_autonomous_workflow implementation_scope",
      ],
      ["reviewer_provider", "CODEX_TASK"],
      [
        "continued_from_review_id",
        "local_review_cycles.at(-1), when it has an addressed head and no follow-up review",
      ],
      ["force_full_review", "true, required with continued_from_review_id"],
    ],
    bind_workflow_review: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["review_id", "the prepare_review result id"],
    ],
  },
  PLAN_CODEX_TASK_DISPATCH: {
    plan_codex_task_dispatch: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["review_id", "current_review.review_id"],
    ],
  },
  CREATE_CODEX_REVIEWER_TASK: MARK_EXECUTING,
  RECONCILE_CODEX_REVIEWER_TASK: {
    record_codex_task_observation: [
      ...WORKFLOW_ACTION,
      ["matching_task_ids", "every task carrying active_action.dispatch.marker"],
      ["task_id", "the created task"],
      ["title", "active_action.dispatch.title"],
      ["prompt", "active_action.dispatch.prompt"],
    ],
  },
  COMPLETE_CODEX_TASK_DISPATCH: COMPLETE_ACTION,
  WAIT_LOCAL_REVIEW: ADVANCE_LOCAL,
  WAIT_LOCAL_REREVIEW: ADVANCE_LOCAL,
  PREPARE_REREVIEW: {
    prepare_rereview: [["review_id", "current_review.review_id"]],
  },
  FINALIZE_LOCAL_GATE: {
    finalize_local_gate: [["review_id", "current_review.review_id"]],
  },
  PLAN_PUSH: { plan_workflow_push: [WORKFLOW_ID, WORKFLOW_REVISION] },
  PUSH_TOPIC_BRANCH: {
    mark_workflow_action_executing: [
      ...WORKFLOW_ACTION,
      [
        "resolved_repository_id",
        "the numeric ID the pinned remote URL resolves to",
      ],
      ["resolved_url", "get_autonomous_workflow active_action.target.remote_url"],
      [
        "pull_request_is_draft",
        "the pre-read draft state, required once the workflow owns a pull request",
      ],
    ],
  },
  RECONCILE_PUSH: {
    record_push_observation: [
      ...WORKFLOW_ACTION,
      ["remote_ref_sha", "a fresh provider read of the pushed ref"],
      ["remote_repository_id", "the same provider read"],
      ["remote_url", "the same provider read"],
    ],
  },
  COMPLETE_PUSH: COMPLETE_ACTION,
  PLAN_DRAFT_PULL_REQUEST: {
    plan_draft_pull_request: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["creator_actor_id", "the authenticated creator"],
      ["creator_actor_type", "the authenticated creator"],
    ],
  },
  CREATE_DRAFT_PULL_REQUEST: MARK_EXECUTING,
  RECONCILE_DRAFT_PULL_REQUEST: {
    record_draft_pull_request_observation: [
      ...WORKFLOW_ACTION,
      [
        "matching_pr_numbers",
        "every pull request carrying active_action.dispatch.body_marker",
      ],
      ["pr_number", "the created pull request"],
      ["repository_id", "the created pull request"],
      ["head_repository_id", "the created pull request"],
      ["base_branch", "the created pull request"],
      ["head_branch", "the created pull request"],
      ["head_sha", "the created pull request"],
      ["draft", "the created pull request"],
      ["body_marker", "active_action.dispatch.body_marker"],
      ["creator_actor_id", "the created pull request"],
      ["creator_actor_type", "the created pull request"],
      ["url", "the created pull request"],
    ],
  },
  COMPLETE_DRAFT_PULL_REQUEST: COMPLETE_ACTION,
  START_PUBLICATION: {
    start_publication: [
      ["review_id", "current_review.review_id"],
      ...PUBLICATION_TARGET_INPUTS,
      ["workflow_id", "workflow_id"],
      ["expected_workflow_revision", "revision"],
    ],
    bind_workflow_publication: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["review_id", "current_review.review_id"],
    ],
  },
  WAIT_PUBLICATION: {
    advance_remote_workflow: [WORKFLOW_ID, WORKFLOW_REVISION],
  },
  PLAN_THREAD_ACTION: {
    plan_thread_reply: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["thread_id", "get_thread_resolution_plan threads[].thread_id"],
      ["actor_id", "the posting actor"],
      ["actor_type", "the posting actor"],
    ],
    plan_thread_resolution: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["thread_id", "the replied thread in thread_replies"],
    ],
    plan_thread_unresolve: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["thread_id", "get_invalidated_resolution_plan thread_id"],
    ],
  },
  REPLY_TO_CODEX_THREAD: MARK_EXECUTING,
  RECONCILE_THREAD_REPLY: {
    record_thread_reply_observation: [
      ...WORKFLOW_ACTION,
      [
        "matching_comment_ids",
        "every comment carrying active_action.dispatch.body_marker",
      ],
      ["comment_id", "the posted comment"],
      ["thread_id", "the posted comment"],
      ["actor_id", "the posted comment"],
      ["actor_type", "the posted comment"],
      ["body", "active_action.dispatch.body"],
    ],
  },
  COMPLETE_THREAD_REPLY: COMPLETE_ACTION,
  RESOLVE_REVIEW_THREAD: {
    mark_workflow_action_executing: [
      ...WORKFLOW_ACTION,
      ["thread_id", "get_autonomous_workflow active_action.target.thread_id"],
      ["is_resolved", "the pre-read"],
      [
        "thread_watermark",
        "the pre-read, required while the thread is unresolved",
      ],
    ],
  },
  RECONCILE_THREAD_RESOLUTION: {
    record_thread_resolution_observation: [
      ...WORKFLOW_ACTION,
      ["outcome", "RESOLVED, or OBSERVED_PRE_RESOLVED for a pre-read that found it resolved"],
      ["thread_id", "the post-read"],
      ["is_resolved", "the post-read"],
      ["thread_watermark", "the post-read, required for RESOLVED"],
      ["resolved_by_id", "the post-read, required for RESOLVED"],
      ["resolved_by_type", "the post-read, required for RESOLVED"],
    ],
  },
  COMPLETE_THREAD_RESOLUTION: {
    record_automatic_resolution: [
      PUBLICATION_ID,
      PUBLICATION_REVISION,
      WORKFLOW_ID,
      ACTION_ID,
    ],
    ...COMPLETE_ACTION,
  },
  UNRESOLVE_REVIEW_THREAD: {
    mark_workflow_action_executing: [
      ...WORKFLOW_ACTION,
      ["thread_id", "get_autonomous_workflow active_action.target.thread_id"],
      ["is_resolved", "the pre-read"],
      ["thread_watermark", "the pre-read"],
      ["pr_repository_id", "the pre-read"],
      ["pr_number", "the pre-read"],
    ],
  },
  RECONCILE_THREAD_UNRESOLVE: {
    record_thread_unresolve_observation: [
      ...WORKFLOW_ACTION,
      ["outcome", "UNRESOLVED, or OBSERVED_ALREADY_UNRESOLVED"],
      ["repository_id", "the post-read"],
      ["pr_number", "the post-read"],
      ["thread_id", "the post-read"],
      ["is_resolved", "the post-read"],
      ["thread_watermark", "the post-read"],
    ],
  },
  RECORD_AND_COMPLETE_THREAD_UNRESOLVE: {
    record_automatic_unresolve: [
      PUBLICATION_ID,
      PUBLICATION_REVISION,
      WORKFLOW_ID,
      ACTION_ID,
    ],
    record_github_snapshot: REFRESH_SNAPSHOT,
    ...COMPLETE_ACTION,
  },
  PLAN_RETURN_TO_DRAFT: {
    plan_return_to_draft: [WORKFLOW_ID, WORKFLOW_REVISION],
  },
  RETURN_PR_TO_DRAFT: {
    mark_workflow_action_executing: [
      ...WORKFLOW_ACTION,
      ["pr_repository_id", "the pre-read"],
      ["pr_number", "the pre-read"],
      ["base_branch", "the pre-read"],
      ["head_branch", "the pre-read"],
      ["is_draft", "the pre-read"],
    ],
  },
  RECONCILE_RETURN_TO_DRAFT: {
    record_return_to_draft_observation: [
      ...WORKFLOW_ACTION,
      ["outcome", "RETURNED_TO_DRAFT, or OBSERVED_ALREADY_DRAFT"],
      ["repository_id", "the post-read"],
      ["pr_number", "the post-read"],
      ["base_branch", "the post-read"],
      ["head_branch", "the post-read"],
      ["is_draft", "the post-read"],
    ],
  },
  COMPLETE_RETURN_TO_DRAFT: COMPLETE_ACTION,
  PLAN_MARK_PR_READY: {
    plan_mark_pull_request_ready: [WORKFLOW_ID, WORKFLOW_REVISION],
  },
  MARK_PR_READY: {
    mark_workflow_action_executing: [
      ...WORKFLOW_ACTION,
      ["pr_repository_id", "the pre-read"],
      ["pr_number", "the pre-read"],
      ["base_branch", "the pre-read"],
      ["head_branch", "the pre-read"],
      ["head_sha", "the pre-read"],
      ["is_draft", "the pre-read"],
    ],
  },
  RECONCILE_MARK_PR_READY: {
    record_mark_ready_observation: [
      ...WORKFLOW_ACTION,
      ["outcome", "MARKED_READY, or OBSERVED_ALREADY_READY"],
      ["repository_id", "the post-read"],
      ["pr_number", "the post-read"],
      ["base_branch", "the post-read"],
      ["head_branch", "the post-read"],
      ["head_sha", "the post-read"],
      ["is_draft", "the post-read"],
    ],
  },
  COMPLETE_MARK_PR_READY: COMPLETE_ACTION,
  RECORD_FRESH_OBSERVATION_AND_ADVANCE: {
    record_github_snapshot: REFRESH_SNAPSHOT,
    advance_remote_workflow: [WORKFLOW_ID, WORKFLOW_REVISION],
  },
  HUMAN_ARBITRATION: {
    export_human_arbitration: [
      ["review_id", "current_review.review_id"],
      ["expected_state_version", "current_review.state_version"],
    ],
  },
};

// A stopped workflow advertises one next action for every reason it can hold,
// so the reason is what says which call clears it. Keyed by pause reason code,
// with PAUSED for every other reason and CANCELLED for the claims a cancelled
// workflow still owns.
export const WORKFLOW_STOP_INPUTS = {
  CHANGE_SIZE_BUDGET_EXCEEDED: { extend_change_size_budget: BUDGET_EXTENSION },
  LOCAL_CYCLE_BUDGET_EXHAUSTED: { extend_local_cycle_budget: BUDGET_EXTENSION },
  REMOTE_CYCLE_BUDGET_EXHAUSTED: {
    extend_remote_cycle_budget: BUDGET_EXTENSION,
  },
  HISTORY_REWRITE_REQUIRED: {
    cancel_autonomous_workflow: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["operator_label", "the deciding human"],
      ["rationale", "the deciding human"],
    ],
  },
  PAUSED: {
    resume_autonomous_workflow: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["operator_label", "the deciding human"],
      ["rationale", "the deciding human"],
    ],
  },
  CANCELLED: {
    release_workflow_claims: [
      WORKFLOW_ID,
      WORKFLOW_REVISION,
      ["operator_label", "the deciding human"],
      ["rationale", "the deciding human"],
      [
        "reconciled_claims",
        "one reconciliation per still-active get_autonomous_workflow claims[] entry",
      ],
    ],
  },
};

// Every table a declaration can live in, so a test sweeping the declarations
// cannot silently miss one that is added later.
export const DECLARATION_TABLES = [
  REVIEW_ACTION_INPUTS,
  PUBLICATION_ACTION_INPUTS,
  WORKFLOW_ACTION_INPUTS,
  WORKFLOW_STOP_INPUTS,
];

export function reviewRequiredInputs(actionRequired) {
  return REVIEW_ACTION_INPUTS[actionRequired] ?? {};
}

export function publicationRequiredInputs(nextAction) {
  return PUBLICATION_ACTION_INPUTS[nextAction] ?? {};
}

export function workflowRequiredInputs(nextAction, workflow) {
  if (nextAction === "AWAIT_OPERATOR") {
    return (
      WORKFLOW_STOP_INPUTS[workflow.pause?.reason_code] ??
      WORKFLOW_STOP_INPUTS.PAUSED
    );
  }
  // A cancelled workflow still owns whatever it claimed; releasing those is the
  // only call left, and only while some claim is still active.
  if (
    nextAction === "NONE" &&
    workflow.status === "CANCELLED" &&
    (workflow.claims ?? []).some((entry) => entry.disposition === "ACTIVE")
  ) {
    return WORKFLOW_STOP_INPUTS.CANCELLED;
  }
  return WORKFLOW_ACTION_INPUTS[nextAction] ?? {};
}
