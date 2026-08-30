// The mechanical reachability walk over required_inputs (#92).
//
// Every finding of the #82 review was one defect: a summary declared a call
// the state it was declared for rejects, or omitted the only call that state
// admits. This walk drives workflows into the states real transitions
// produce, reads required_inputs from the real read surfaces, and acts as a
// driver that trusts the declaration: it executes the declared calls, with
// argument values resolved the way each declared source says, and commits
// only what the declaration tells it to commit. A declaration that names a
// refused call fails the turn with that refusal; a declaration that omits
// the exit a state needs fails the subset assertion before anything runs.
//
// Expensive states -- a genuine pre-resolved thread observation, a terminal
// publication under an open action -- are reached through the existing
// publication-chain fixtures and walked from there.

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import test from "node:test";
import {
  finalizeLocalGate,
  getReviewSummary,
  prepareRereview,
  prepareReview,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";
import {
  getPublication,
  getPublicationSummary,
  getThreadResolutionPlan,
  recordAutomaticResolution,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
} from "../src/publication.mjs";
import {
  acknowledgeChangeSizeWarning,
  advanceLocalWorkflow,
  advanceRemoteWorkflow,
  bindWorkflowPublication,
  bindWorkflowReview,
  completeWorkflowAction,
  getAutonomousWorkflow,
  getAutonomousWorkflowSummary,
  markWorkflowActionExecuting,
  planCodexTaskDispatch,
  planDraftPullRequest,
  planMarkPullRequestReady,
  planThreadReply,
  planThreadResolution,
  planWorkflowPush,
  recordCodexTaskObservation,
  recordDraftPullRequestObservation,
  recordMarkReadyObservation,
  recordPushObservation,
  recordThreadReplyObservation,
  recordThreadResolutionObservation,
  recordWorkflowHead,
  releaseWorkflowClaims,
  startAutonomousWorkflow,
} from "../src/workflow.mjs";
import { iso } from "./helpers/github-observation.mjs";
import {
  CODEX_ACTOR_ID,
  PR_NUMBER,
  REPOSITORY_ID,
  draftObservation,
  findingsResult,
  reachObservedThreadResolution,
  readyObservation,
  startInput,
  workflowInput,
} from "./helpers/publication-chain";
import { commit, fixture, TOPIC_BRANCH } from "./helpers/repository-fixture";

// The state-rejection family: every code a transition raises because of the
// ledger state the call was initiated from, enumerated from the fail() sites
// of workflow.mjs and publication.mjs. Included are the status, phase, and
// action-progress guards, the review-transition and split gates, the calls a
// state has already consumed or not yet earned, and the terminal refusals.
// Excluded are argument validation, revision conflicts, identity and
// repository mismatches, and evidence-content refusals: those reject what
// the driver brought, not the state it stood in. Review-side transitions in
// core.mjs raise plain Errors without codes; the walk treats any failure of
// a declared call as a defect, so they are covered by the same assertion.
const STATE_REJECTION_CODES = new Set([
  "WORKFLOW_STATE_INVALID",
  "WORKFLOW_PHASE_INVALID",
  "WORKFLOW_NOT_ACTIVE",
  "WORKFLOW_PAUSED",
  "WORKFLOW_CANCELLED",
  "WORKFLOW_TERMINAL",
  "WORKFLOW_ACTION_STATE_INVALID",
  "WORKFLOW_ACTION_KIND_INVALID",
  "WORKFLOW_REVIEW_TRANSITION_INVALID",
  "WORKFLOW_REVIEW_RAN_AHEAD",
  "WORKFLOW_CHANGE_SIZE_WARNING_UNACKNOWLEDGED",
  "WORKFLOW_CHANGE_SIZE_SPLIT_UNEXECUTED",
  "WORKFLOW_CHANGE_SIZE_BUDGET_EXCEEDED",
  "WORKFLOW_RESUME_INVALID",
  "WORKFLOW_RESUMED",
  "WORKFLOW_CLAIMS_RELEASED",
  "WORKFLOW_CLAIMS_ALREADY_RELEASED",
  "WORKFLOW_RESOLUTION_RECORD_MISSING",
  "WORKFLOW_RESOLUTION_ACTION_MISSING",
  "WORKFLOW_UNRESOLVE_RECORD_MISSING",
  "WORKFLOW_UNRESOLVE_REFRESH_MISSING",
  "WORKFLOW_THREAD_NOT_ELIGIBLE",
  "WORKFLOW_THREAD_NOT_ANSWERED",
  "WORKFLOW_THREAD_NOT_INVALIDATED",
  "WORKFLOW_THREAD_ALREADY_ANSWERED",
  "WORKFLOW_THREAD_ALREADY_RESOLVED",
  "WORKFLOW_THREAD_REPLY_NOT_OBSERVED",
  "WORKFLOW_PUBLICATION_NOT_READY",
  "PUBLICATION_TERMINAL",
  "PUBLICATION_SUPERSEDED",
  "PUBLICATION_ALREADY_STARTED",
  "PUBLICATION_STARTED",
  "PUBLICATION_NOT_READY",
]);

const OPERATOR = "Test Operator";
const walked = new Map();

function coverTurn(kind, action, tools) {
  const key = `${kind}:${action}`;
  const seen = walked.get(key) ?? new Set();
  for (const tool of tools) seen.add(tool);
  walked.set(key, seen);
}

// The declared expected_revision either names the revision the summary
// reported or says it must be re-read after an earlier call in the same
// sequence. The walk takes the declaration literally: a table that forgets
// the re-read hands the driver a consumed revision and the turn goes red on
// the conflict.
function declaredRevision(ctx, summary, fields) {
  const source = fields.find(([field]) => field === "expected_revision")?.[1];
  return /re-read after/.test(source) ? ctx.revision : summary.revision;
}

// Whether the declared head names the cut a split owes. The warning arm ties
// the cut to a split decision, so a driver that decided continue commits the
// fix alone; the split arm states it unconditionally.
function declaresCut(fields, materials) {
  return (
    /\bcut\b/.test(fields.find(([field]) => field === "head_sha")?.[1] ?? "") &&
    materials.decision !== "continue"
  );
}

async function activeTarget(ctx) {
  return (await getAutonomousWorkflow(ctx.store, ctx.workflowId)).active_action
    .target;
}

async function publicationRevision(ctx, reviewId) {
  return (await getPublication(ctx.store, reviewId)).revision;
}

// One probe per declared tool the walked scenarios reach. Every argument is
// resolved from the summary field its declared source names, from the fresh
// read the source names, or from the turn's world materials where the source
// names something outside the ledger (a commit, a posted comment, an
// observation file).
const PROBES = {
  record_workflow_head: async (ctx, summary, fields, m) => {
    const content = declaresCut(fields, m) ? m.cutContent : m.content;
    assert.ok(content, "the turn supplies no commit content");
    const headSha = await commit(ctx.state.repository, content);
    const result = await recordWorkflowHead(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      headSha,
    );
    ctx.revision = result.revision;
  },
  submit_resolutions: async (ctx, summary) => {
    const reviewId =
      summary.current_review?.review_id ?? summary.current_publication?.review_id;
    const review = await getReviewSummary(ctx.store, reviewId);
    const active = review.active_findings ?? [];
    if (active.length === 0) {
      return;
    }
    await submitResolutions(
      ctx.store,
      reviewId,
      active.map((finding) => ({
        finding_id: finding.id,
        disposition: "fixed",
        rationale: "Committed the walked repair.",
        evidence: "The recorded head carries it.",
      })),
    );
  },
  advance_local_workflow: async (ctx, summary, fields) => {
    const result = await advanceLocalWorkflow(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
    );
    ctx.revision = result.revision;
  },
  advance_remote_workflow: async (ctx, summary, fields) => {
    const result = await advanceRemoteWorkflow(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
    );
    ctx.revision = result.revision;
  },
  acknowledge_change_size_warning: async (ctx, summary, fields, m) => {
    assert.ok(m.decision, "the turn supplies no split decision");
    const result = await acknowledgeChangeSizeWarning(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      {
        decision: m.decision,
        rationale: "Walked decision.",
        operatorLabel: OPERATOR,
      },
    );
    ctx.revision = result.revision;
  },
  prepare_review: async (ctx, summary) => {
    const workflow = await getAutonomousWorkflow(ctx.store, ctx.workflowId);
    const cycle = summary.local_review_cycles.at(-1);
    const continued =
      cycle?.addressed_head_sha != null && cycle.followup_review_id == null;
    ctx.prepared = await prepareReview(ctx.store, {
      repositoryPath: workflow.repository.path,
      baseRef: summary.base_sha,
      requirement: workflow.requirement,
      implementationScope: workflow.implementation_scope,
      reviewerProvider: "CODEX_TASK",
      ...(continued
        ? {
            continuedFromReviewId: cycle.continued_from_review_id,
            forceFullReview: true,
          }
        : {}),
    });
  },
  bind_workflow_review: async (ctx, summary, fields) => {
    assert.ok(ctx.prepared, "no prepare_review result to bind");
    const result = await bindWorkflowReview(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      ctx.prepared.id,
    );
    ctx.revision = result.revision;
    ctx.prepared = null;
  },
  plan_codex_task_dispatch: async (ctx, summary, fields) => {
    const result = await planCodexTaskDispatch(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.current_review.review_id,
    );
    ctx.revision = result.workflow.revision;
  },
  mark_workflow_action_executing: async (ctx, summary, fields, m) => {
    const proof = await m.proof?.(ctx, summary);
    const result = await markWorkflowActionExecuting(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.active_action.action_id,
      ...(proof == null ? [] : [proof]),
    );
    ctx.revision = result.revision;
  },
  record_codex_task_observation: async (ctx, summary, fields, m) => {
    const result = await recordCodexTaskObservation(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.active_action.action_id,
      {
        matchingTaskIds: [m.taskId],
        taskId: m.taskId,
        title: summary.active_action.dispatch.title,
        prompt: summary.active_action.dispatch.prompt,
      },
    );
    ctx.revision = result.revision;
  },
  complete_workflow_action: async (ctx, summary, fields) => {
    const result = await completeWorkflowAction(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.active_action.action_id,
    );
    ctx.revision = result.revision;
  },
  prepare_rereview: async (ctx, summary) => {
    await prepareRereview(ctx.store, summary.current_review.review_id);
  },
  finalize_local_gate: async (ctx, summary) => {
    await finalizeLocalGate(ctx.store, summary.current_review.review_id);
  },
  plan_workflow_push: async (ctx, summary, fields) => {
    const result = await planWorkflowPush(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
    );
    ctx.revision = result.workflow.revision;
  },
  record_push_observation: async (ctx, summary, fields) => {
    const result = await recordPushObservation(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.active_action.action_id,
      {
        remoteRefSha: summary.current_head_sha,
        remoteRepositoryId: REPOSITORY_ID,
        remoteUrl: (await activeTarget(ctx)).remote_url,
      },
    );
    ctx.revision = result.revision;
  },
  plan_draft_pull_request: async (ctx, summary, fields) => {
    const result = await planDraftPullRequest(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      { creatorActorId: 555, creatorActorType: "User" },
    );
    ctx.revision = result.workflow.revision;
  },
  record_draft_pull_request_observation: async (ctx, summary, fields) => {
    const result = await recordDraftPullRequestObservation(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.active_action.action_id,
      {
        matchingPrNumbers: [PR_NUMBER],
        prNumber: PR_NUMBER,
        repositoryId: REPOSITORY_ID,
        headRepositoryId: REPOSITORY_ID,
        baseBranch: "main",
        headBranch: TOPIC_BRANCH,
        headSha: summary.current_head_sha,
        draft: true,
        bodyMarker: summary.active_action.dispatch.body_marker,
        creatorActorId: 555,
        creatorActorType: "User",
        url: `https://github.com/example/review-bridge/pull/${PR_NUMBER}`,
      },
    );
    ctx.revision = result.revision;
  },
  start_publication: async (ctx, summary, fields, m) => {
    await startPublication(
      ctx.store,
      startInput(ctx.state, summary.current_review.review_id, {
        workflow_id: ctx.workflowId,
        revision: declaredRevision(ctx, summary, fields),
      }, m.at),
      { clock: () => m.at },
    );
  },
  bind_workflow_publication: async (ctx, summary, fields) => {
    const result = await bindWorkflowPublication(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.current_review.review_id,
    );
    ctx.revision = result.revision;
  },
  plan_mark_pull_request_ready: async (ctx, summary, fields) => {
    const result = await planMarkPullRequestReady(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
    );
    ctx.revision = result.workflow.revision;
  },
  record_mark_ready_observation: async (ctx, summary, fields) => {
    const target = await activeTarget(ctx);
    const result = await recordMarkReadyObservation(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.active_action.action_id,
      {
        outcome: "MARKED_READY",
        repositoryId: target.repository_id,
        prNumber: target.pr_number,
        baseBranch: target.base_branch,
        headBranch: target.head_branch,
        headSha: target.head_sha,
        isDraft: false,
      },
    );
    ctx.revision = result.revision;
  },
  plan_thread_reply: async (ctx, summary, fields) => {
    const plan = await getThreadResolutionPlan(
      ctx.store,
      summary.current_publication.review_id,
    );
    const eligible = plan.threads.find((thread) => thread.eligible);
    assert.ok(eligible, "no eligible thread to reply to");
    const result = await planThreadReply(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      { threadId: eligible.thread_id, actorId: 555, actorType: "User" },
    );
    ctx.revision = result.workflow.revision;
  },
  record_thread_reply_observation: async (ctx, summary, fields, m) => {
    const result = await recordThreadReplyObservation(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.active_action.action_id,
      {
        matchingCommentIds: [m.replyCommentId],
        commentId: m.replyCommentId,
        threadId: (await activeTarget(ctx)).thread_id,
        actorId: 555,
        actorType: "User",
        body: summary.active_action.dispatch.body,
      },
    );
    ctx.revision = result.revision;
  },
  plan_thread_resolution: async (ctx, summary, fields) => {
    const result = await planThreadResolution(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      { threadId: summary.thread_replies.at(-1).thread_id },
    );
    ctx.revision = result.workflow.revision;
  },
  record_thread_resolution_observation: async (ctx, summary, fields) => {
    const target = await activeTarget(ctx);
    const result = await recordThreadResolutionObservation(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      summary.active_action.action_id,
      {
        outcome: "RESOLVED",
        threadId: target.thread_id,
        isResolved: true,
        threadWatermark: target.thread_watermark,
        resolvedById: target.expected_actor_id,
        resolvedByType: target.expected_actor_type,
      },
    );
    ctx.revision = result.revision;
  },
  record_automatic_resolution: async (ctx, summary) => {
    const reviewId = summary.current_publication.review_id;
    await recordAutomaticResolution(ctx.store, reviewId, {
      expectedRevision: await publicationRevision(ctx, reviewId),
      workflowId: ctx.workflowId,
      actionId: summary.active_action.action_id,
    });
  },
  record_github_snapshot: async (ctx, summary, fields, m) => {
    const reviewId =
      summary.current_publication?.review_id ?? summary.review_id;
    const observation = await m.observation(ctx, summary);
    await recordGithubSnapshot(
      ctx.store,
      reviewId,
      {
        expectedRevision: await publicationRevision(ctx, reviewId),
        observation,
      },
      { clock: () => Date.parse(observation.observed_at) + 10 },
    );
  },
  record_codex_review_request: async (ctx, summary, fields, m) => {
    await recordCodexReviewRequest(
      ctx.store,
      summary.review_id,
      {
        expectedRevision: await publicationRevision(ctx, summary.review_id),
        commentId: m.requestCommentId,
        url: `https://github.com/example/review-bridge/issues/${PR_NUMBER}#issuecomment-${m.requestCommentId}`,
        createdAt: iso(m.requestAt),
        requestedHeadSha: summary.head_sha,
      },
      { clock: () => m.requestAt + 10 },
    );
  },
  release_workflow_claims: async (ctx, summary, fields) => {
    const workflow = await getAutonomousWorkflow(ctx.store, ctx.workflowId);
    const observedAt = new Date().toISOString();
    const result = await releaseWorkflowClaims(
      ctx.store,
      ctx.workflowId,
      declaredRevision(ctx, summary, fields),
      {
        operatorLabel: OPERATOR,
        rationale: "The walk merged and removed every claimed object.",
        reconciledClaims: workflow.claims
          .filter((claim) => claim.disposition === "ACTIVE")
          .map((claim) => ({
            kind: claim.kind,
            canonical_key_sha256: claim.canonical_key_sha256,
            target: claim.target,
            workflow_revision: workflow.revision,
            ...(claim.kind === "PULL_REQUEST"
              ? { present: true, open: false }
              : { present: false }),
            observed_at: observedAt,
          })),
      },
    );
    ctx.revision = result.revision;
  },
};

/**
 * Execute one walked turn: run the world's external events, read the real
 * summary, assert the calls this turn needs are declared, then execute the
 * declared calls in declaration order and require the state to have moved.
 */
async function runTurn(ctx, turn) {
  await turn.world?.(ctx);
  const summary = await getAutonomousWorkflowSummary(ctx.store, ctx.workflowId);
  if (turn.expect) {
    assert.equal(
      summary.next_action,
      turn.expect,
      `the walk expected to stand at ${turn.expect}`,
    );
  }
  const declared = summary.required_inputs;
  const tools = turn.use ?? Object.keys(declared);
  for (const tool of tools) {
    assert.ok(
      Object.hasOwn(declared, tool),
      `${summary.next_action} does not declare ${tool}, the exit this walk takes from it`,
    );
  }
  coverTurn("workflow", summary.next_action, tools);
  ctx.revision = summary.revision;
  const materials = turn.materials ?? {};
  for (const tool of tools) {
    try {
      await PROBES[tool](ctx, summary, declared[tool], materials);
    } catch (error) {
      const family = STATE_REJECTION_CODES.has(error?.code)
        ? "a state rejection"
        : "an error";
      assert.fail(
        `${summary.next_action} declares ${tool}, which failed with ${family}: ${error?.code ?? "(no code)"} ${error?.message}`,
      );
    }
  }
  const after = await getAutonomousWorkflowSummary(ctx.store, ctx.workflowId);
  assert.ok(
    after.revision > summary.revision ||
      after.next_action !== summary.next_action,
    `walking ${summary.next_action} left the workflow exactly where it stood`,
  );
  return after;
}

// The same walk over the publication's own read surface, whose declarations
// come from PUBLICATION_ACTION_INPUTS.
async function runPublicationTurn(ctx, reviewId, turn) {
  const summary = await getPublicationSummary(ctx.store, reviewId);
  if (turn.expect) {
    assert.equal(summary.next_action, turn.expect);
  }
  const declared = summary.required_inputs;
  const tools = turn.use ?? Object.keys(declared);
  for (const tool of tools) {
    assert.ok(
      Object.hasOwn(declared, tool),
      `publication ${summary.next_action} does not declare ${tool}`,
    );
  }
  coverTurn("publication", summary.next_action, tools);
  const materials = turn.materials ?? {};
  for (const tool of tools) {
    try {
      await PROBES[tool](ctx, summary, declared[tool], materials);
    } catch (error) {
      const family = STATE_REJECTION_CODES.has(error?.code)
        ? "a state rejection"
        : "an error";
      assert.fail(
        `publication ${summary.next_action} declares ${tool}, which failed with ${family}: ${error?.code ?? "(no code)"} ${error?.message}`,
      );
    }
  }
}

async function walkContext(t, overrides = {}) {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(state.store, {
    ...workflowInput(state.repository, state.baseSha),
    ...overrides,
  });
  return { state, store: state.store, workflowId: workflow.workflow_id };
}

const finding = {
  severity: "major",
  title: "Walked finding",
  explanation: "The walk needs one findings round.",
};

// The action states of one Codex reviewer dispatch, walked.
const dispatchTurns = (label) => [
  { expect: "PLAN_CODEX_TASK_DISPATCH" },
  { expect: "CREATE_CODEX_REVIEWER_TASK" },
  {
    expect: "RECONCILE_CODEX_REVIEWER_TASK",
    materials: { taskId: `task-${label}` },
  },
  { expect: "COMPLETE_CODEX_TASK_DISPATCH" },
];

// Push and draft-pull-request action states, walked. Once the workflow owns a
// pull request the push pre-read owes its draft flag, which is exactly what
// the declared source states.
const publishTurns = () => [
  { expect: "PLAN_PUSH" },
  {
    expect: "PUSH_TOPIC_BRANCH",
    materials: {
      proof: async (ctx) => {
        const workflow = await getAutonomousWorkflow(ctx.store, ctx.workflowId);
        return {
          resolved_repository_id: REPOSITORY_ID,
          resolved_url: workflow.active_action.target.remote_url,
          ...(workflow.pull_request == null
            ? {}
            : { pull_request_is_draft: true }),
        };
      },
    },
  },
  { expect: "RECONCILE_PUSH" },
  { expect: "COMPLETE_PUSH" },
  { expect: "PLAN_DRAFT_PULL_REQUEST" },
  { expect: "CREATE_DRAFT_PULL_REQUEST" },
  { expect: "RECONCILE_DRAFT_PULL_REQUEST" },
  { expect: "COMPLETE_DRAFT_PULL_REQUEST" },
];

const markReadyProof = (isDraft) => ({
  proof: async (ctx) => {
    const target = await activeTarget(ctx);
    return {
      repository_id: target.repository_id,
      pr_number: target.pr_number,
      base_branch: target.base_branch,
      head_branch: target.head_branch,
      ...(target.head_sha == null ? {} : { head_sha: target.head_sha }),
      is_draft: isDraft,
    };
  },
});

// The full loop: implementation, one local findings round, rereview, gate,
// push, draft pull request, publication, the publication's own declared
// request and snapshot, the pre-ready mark, the post-ready observation, the
// terminal advance, and the release a terminal run still owes.
test("the declaration walk closes the clean loop from commit to release", async (t) => {
  const ctx = await walkContext(t);
  await runTurn(ctx, {
    expect: "COMMIT_HEAD",
    materials: { content: "export const value = 2;\n" },
  });
  await runTurn(ctx, { expect: "PREPARE_LOCAL_REVIEW" });
  for (const turn of dispatchTurns("walk-one")) {
    await runTurn(ctx, turn);
  }
  await runTurn(ctx, {
    expect: "WAIT_LOCAL_REVIEW",
    world: async (walk) => {
      const summary = await getAutonomousWorkflowSummary(
        walk.store,
        walk.workflowId,
      );
      await submitInitialReview(
        walk.store,
        summary.current_review.review_id,
        [finding],
        "CODEX_TASK",
      );
    },
  });
  await runTurn(ctx, {
    expect: "ADDRESS_LOCAL_FINDINGS",
    materials: { content: "export const value = 3;\n" },
  });
  await runTurn(ctx, { expect: "PREPARE_REREVIEW" });
  await runTurn(ctx, {
    expect: "WAIT_LOCAL_REREVIEW",
    world: async (walk) => {
      const summary = await getAutonomousWorkflowSummary(
        walk.store,
        walk.workflowId,
      );
      await submitRereview(
        walk.store,
        summary.current_review.review_id,
        [
          {
            finding_id: "F-001",
            decision: "resolved",
            rationale: "The walked head fixes it.",
          },
        ],
        [],
        "CODEX_TASK",
      );
    },
  });
  await runTurn(ctx, { expect: "FINALIZE_LOCAL_GATE" });
  for (const turn of publishTurns()) {
    await runTurn(ctx, turn);
  }
  const startedAt = Date.now();
  await runTurn(ctx, {
    expect: "START_PUBLICATION",
    materials: { at: startedAt },
  });

  const summary = await getAutonomousWorkflowSummary(ctx.store, ctx.workflowId);
  assert.equal(summary.next_action, "WAIT_PUBLICATION");
  const reviewId = summary.current_publication.review_id;
  const requestAt = startedAt + 1_000;
  await runPublicationTurn(ctx, reviewId, {
    expect: "POST_AND_RECORD_CODEX_REVIEW_REQUEST",
    materials: { requestCommentId: 100, requestAt },
  });
  await runPublicationTurn(ctx, reviewId, {
    expect: "RECORD_GITHUB_SNAPSHOT",
    materials: {
      observation: () =>
        draftObservation(ctx.state, summary.current_head_sha, {
          at: startedAt + 2_000,
          requestId: 100,
          requestAt,
        }),
    },
  });
  await runTurn(ctx, { expect: "WAIT_PUBLICATION" });
  await runTurn(ctx, { expect: "PLAN_MARK_PR_READY" });
  await runTurn(ctx, { expect: "MARK_PR_READY", materials: markReadyProof(true) });
  await runTurn(ctx, { expect: "RECONCILE_MARK_PR_READY" });
  await runTurn(ctx, { expect: "COMPLETE_MARK_PR_READY" });
  const merged = await runTurn(ctx, {
    expect: "RECORD_FRESH_OBSERVATION_AND_ADVANCE",
    materials: {
      observation: async (walk) => {
        const workflow = await getAutonomousWorkflow(
          walk.store,
          walk.workflowId,
        );
        const readyAt = Math.max(
          Date.now(),
          Date.parse(workflow.ready_marks.at(-1).recorded_at) + 2_000,
        );
        return readyObservation(walk.state, workflow.current_head_sha, {
          at: readyAt,
          requestId: 100,
          requestAt,
        });
      },
    },
  });
  assert.equal(merged.status, "MERGE_READY");
  await runTurn(ctx, {
    expect: "AWAIT_OPERATOR",
    use: ["release_workflow_claims"],
  });
  const released = await getAutonomousWorkflow(ctx.store, ctx.workflowId);
  assert.ok(
    released.claims.every((claim) => claim.disposition === "RELEASED"),
  );
});

// Five added lines over the one-line base measure six total against a budget
// of eight, exactly the warning threshold, and the crossing is recorded at
// the first bind while the round in flight completes. Content sizes are the
// walk's own dials: the six-line fix measures seven and re-arms a larger
// crossing where a scenario needs one, and the cut drops below every
// acknowledged total.
const WARNING_BUDGET = { changeSizeBudget: 8 };
const FIVE_LINES =
  "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n";
const SIX_LINE_FIX = `${FIVE_LINES}export const f = 6;\n`;
const ONE_LINE_CUT = "export const a = 9;\n";

async function reachCrossedFindings(t, label) {
  const ctx = await walkContext(t, WARNING_BUDGET);
  await runTurn(ctx, { expect: "COMMIT_HEAD", materials: { content: FIVE_LINES } });
  await runTurn(ctx, { expect: "PREPARE_LOCAL_REVIEW" });
  for (const turn of dispatchTurns(label)) {
    await runTurn(ctx, turn);
  }
  await runTurn(ctx, {
    expect: "WAIT_LOCAL_REVIEW",
    world: async (walk) => {
      const summary = await getAutonomousWorkflowSummary(
        walk.store,
        walk.workflowId,
      );
      await submitInitialReview(
        walk.store,
        summary.current_review.review_id,
        [finding],
        "CODEX_TASK",
      );
    },
  });
  return ctx;
}

// #82 round ten, one turn: the crossing is pending among the findings, and a
// driver that trusts the warning arm acknowledges the split and then commits
// what the declared head names. An arm that keeps naming only the fix sends
// the advance at WORKFLOW_CHANGE_SIZE_SPLIT_UNEXECUTED.
test("a split decided among the findings walks through in one pass", async (t) => {
  const ctx = await reachCrossedFindings(t, "walk-split-one");
  const after = await runTurn(ctx, {
    expect: "ADDRESS_LOCAL_FINDINGS",
    use: [
      "acknowledge_change_size_warning",
      "record_workflow_head",
      "submit_resolutions",
      "advance_local_workflow",
    ],
    materials: {
      decision: "split",
      content: SIX_LINE_FIX,
      cutContent: ONE_LINE_CUT,
    },
  });
  assert.equal(after.next_action, "PREPARE_REREVIEW");
});

// The same arm with a driver that stops after the acknowledgment: the next
// summary read stands on an acknowledged, unadmitted split, and the
// declaration it selects has to keep naming the cut. This is the state the
// plain mapping strands, which is why SPLIT_GATED_INPUTS carries this phase.
test("a split acknowledged among the findings still walks out", async (t) => {
  const ctx = await reachCrossedFindings(t, "walk-split-two");
  await runTurn(ctx, {
    expect: "ADDRESS_LOCAL_FINDINGS",
    use: ["acknowledge_change_size_warning"],
    materials: { decision: "split" },
  });
  const after = await runTurn(ctx, {
    expect: "ADDRESS_LOCAL_FINDINGS",
    materials: { cutContent: ONE_LINE_CUT },
  });
  assert.equal(after.next_action, "PREPARE_REREVIEW");
});

// #82 round nine's arm: a continuation round crosses a larger warning, the
// continuation head recording moves the phase on its own, and the split is
// acknowledged where the next round is prepared. The bind measures the
// candidate, so the declaration has to name the cut before it.
test("a split acknowledged where the round is prepared still walks out", async (t) => {
  const ctx = await reachCrossedFindings(t, "walk-split-three");
  await runTurn(ctx, {
    expect: "ADDRESS_LOCAL_FINDINGS",
    use: [
      "acknowledge_change_size_warning",
      "record_workflow_head",
      "submit_resolutions",
      "advance_local_workflow",
    ],
    materials: { decision: "continue", content: SIX_LINE_FIX },
  });
  await runTurn(ctx, { expect: "PREPARE_REREVIEW" });
  await runTurn(ctx, {
    expect: "WAIT_LOCAL_REREVIEW",
    world: async (walk) => {
      const summary = await getAutonomousWorkflowSummary(
        walk.store,
        walk.workflowId,
      );
      await submitRereview(
        walk.store,
        summary.current_review.review_id,
        [
          {
            finding_id: "F-001",
            decision: "resolved",
            rationale: "The walked head fixes it.",
          },
        ],
        [
          {
            severity: "minor",
            title: "Continuation finding",
            explanation: "The rereview raised one more.",
          },
        ],
        "CODEX_TASK",
      );
    },
  });
  // The rereview snapshot over the six-line fix measured seven and re-armed
  // the warning past the acknowledged six. The continuation cycle declares
  // the head recording alone: recording it moves the phase itself.
  const prepare = await runTurn(ctx, {
    expect: "ADDRESS_LOCAL_FINDINGS",
    materials: { content: `${SIX_LINE_FIX}export const g = 8;\n` },
  });
  assert.equal(prepare.next_action, "PREPARE_LOCAL_REVIEW");
  await runTurn(ctx, {
    expect: "PREPARE_LOCAL_REVIEW",
    use: ["acknowledge_change_size_warning"],
    materials: { decision: "split" },
  });
  const bound = await runTurn(ctx, {
    expect: "PREPARE_LOCAL_REVIEW",
    materials: { cutContent: ONE_LINE_CUT },
  });
  assert.equal(bound.next_action, "PLAN_CODEX_TASK_DISPATCH");
});

// A finding thread on the first publication walks the repair, the second
// publication, and the whole thread loop: the declared refresh, the reply
// action, the resolution action, its server-owned record, and the advance
// that is the loop's only exit.
test("the declaration walk answers a finding thread end to end", async (t) => {
  const ctx = await walkContext(t);
  await runTurn(ctx, {
    expect: "COMMIT_HEAD",
    materials: { content: "export const value = 2;\n" },
  });
  await runTurn(ctx, { expect: "PREPARE_LOCAL_REVIEW" });
  for (const turn of dispatchTurns("walk-thread-one")) {
    await runTurn(ctx, turn);
  }
  await runTurn(ctx, {
    expect: "WAIT_LOCAL_REVIEW",
    world: async (walk) => {
      const summary = await getAutonomousWorkflowSummary(
        walk.store,
        walk.workflowId,
      );
      await submitInitialReview(
        walk.store,
        summary.current_review.review_id,
        [],
        "CODEX_TASK",
      );
    },
  });
  await runTurn(ctx, { expect: "FINALIZE_LOCAL_GATE" });
  for (const turn of publishTurns()) {
    await runTurn(ctx, turn);
  }
  const startedAt = Date.now();
  await runTurn(ctx, {
    expect: "START_PUBLICATION",
    materials: { at: startedAt },
  });
  const first = await getAutonomousWorkflowSummary(ctx.store, ctx.workflowId);
  const firstReviewId = first.current_publication.review_id;
  const firstHead = first.current_head_sha;
  const requestAt = startedAt + 1_000;
  await runPublicationTurn(ctx, firstReviewId, {
    expect: "POST_AND_RECORD_CODEX_REVIEW_REQUEST",
    materials: { requestCommentId: 100, requestAt },
  });
  await runPublicationTurn(ctx, firstReviewId, {
    expect: "RECORD_GITHUB_SNAPSHOT",
    materials: {
      observation: () =>
        findingsResult(
          draftObservation(ctx.state, firstHead, {
            at: startedAt + 2_000,
            requestId: 100,
            requestAt,
          }),
        ),
    },
  });
  const repairing = await runTurn(ctx, { expect: "WAIT_PUBLICATION" });
  assert.equal(repairing.next_action, "ADDRESS_REMOTE_FINDINGS");
  await runTurn(ctx, {
    expect: "ADDRESS_REMOTE_FINDINGS",
    materials: { content: "export const value = 3;\n" },
  });
  await runTurn(ctx, { expect: "PREPARE_LOCAL_REVIEW" });
  for (const turn of dispatchTurns("walk-thread-two")) {
    await runTurn(ctx, turn);
  }
  await runTurn(ctx, {
    expect: "WAIT_LOCAL_REVIEW",
    world: async (walk) => {
      const summary = await getAutonomousWorkflowSummary(
        walk.store,
        walk.workflowId,
      );
      await submitInitialReview(
        walk.store,
        summary.current_review.review_id,
        [],
        "CODEX_TASK",
      );
    },
  });
  await runTurn(ctx, { expect: "FINALIZE_LOCAL_GATE" });
  for (const turn of publishTurns()) {
    await runTurn(ctx, turn);
  }

  const codex = {
    id: CODEX_ACTOR_ID,
    type: "Bot",
    login: "chatgpt-codex-connector[bot]",
  };
  const threadAt = startedAt + 20_000;
  const secondSummary = await getAutonomousWorkflowSummary(
    ctx.store,
    ctx.workflowId,
  );
  const secondHead = secondSummary.current_head_sha;
  const findingComment = {
    id: "PRRC_1",
    database_id: 900,
    created_at: iso(threadAt - 5_000),
    updated_at: iso(threadAt - 5_000),
    actor: codex,
    review: {
      id: "PRR_1",
      database_id: 101,
      state: "COMMENTED",
      reviewed_head_sha: firstHead,
      actor: codex,
    },
  };
  const withThread = (payload, at, comments) => {
    payload.review_threads.total_count = 1;
    payload.review_threads.unresolved_count = 1;
    payload.review_threads.threads = [
      {
        id: "PRRT_1",
        is_resolved: false,
        is_outdated: false,
        path: null,
        line: null,
        comment_count: comments.length,
        comments_pagination_complete: true,
        provenance_complete: true,
        comments,
      },
    ];
    payload.review_threads.ancestry = [
      {
        finding_head_sha: firstHead,
        status: "AHEAD",
        descends: true,
        endpoint: `GET /repos/example/review-bridge/compare/${firstHead}...${secondHead}`,
        collected_at: iso(at - 400),
      },
    ];
    return payload;
  };
  await runTurn(ctx, { expect: "START_PUBLICATION", materials: { at: threadAt } });
  const second = await getAutonomousWorkflowSummary(ctx.store, ctx.workflowId);
  const secondReviewId = second.current_publication.review_id;
  const secondRequestAt = threadAt + 1_000;
  await runPublicationTurn(ctx, secondReviewId, {
    expect: "POST_AND_RECORD_CODEX_REVIEW_REQUEST",
    materials: { requestCommentId: 100, requestAt: secondRequestAt },
  });
  await runPublicationTurn(ctx, secondReviewId, {
    expect: "RECORD_GITHUB_SNAPSHOT",
    materials: {
      observation: () =>
        withThread(
          draftObservation(ctx.state, secondHead, {
            at: threadAt + 2_000,
            requestId: 100,
            requestAt: secondRequestAt,
          }),
          threadAt + 2_000,
          [findingComment],
        ),
    },
  });
  const resolving = await runTurn(ctx, { expect: "WAIT_PUBLICATION" });
  assert.equal(resolving.next_action, "PLAN_THREAD_ACTION");
  await runTurn(ctx, {
    expect: "PLAN_THREAD_ACTION",
    use: ["plan_thread_reply"],
  });
  await runTurn(ctx, { expect: "REPLY_TO_CODEX_THREAD" });
  await runTurn(ctx, {
    expect: "RECONCILE_THREAD_REPLY",
    materials: { replyCommentId: 901 },
  });
  await runTurn(ctx, { expect: "COMPLETE_THREAD_REPLY" });

  // The workflow's own reply is an external post the plan cannot see until a
  // fresh snapshot carries it, which is exactly why the loop declares the
  // refresh alongside the planners.
  const repliedAt = threadAt + 60_000;
  const replyComment = {
    id: "PRRC_2",
    database_id: 901,
    created_at: iso(repliedAt - 2_000),
    updated_at: iso(repliedAt - 2_000),
    actor: { id: 555, type: "User", login: "operator" },
    review: null,
  };
  await runTurn(ctx, {
    expect: "PLAN_THREAD_ACTION",
    use: ["record_github_snapshot", "plan_thread_resolution"],
    materials: {
      observation: () =>
        withThread(
          draftObservation(ctx.state, secondHead, {
            at: repliedAt,
            requestId: 100,
            requestAt: secondRequestAt,
          }),
          repliedAt,
          [findingComment, replyComment],
        ),
    },
  });
  await runTurn(ctx, {
    expect: "RESOLVE_REVIEW_THREAD",
    materials: {
      proof: async (walk) => {
        const target = await activeTarget(walk);
        return {
          thread_id: target.thread_id,
          is_resolved: false,
          thread_watermark: target.thread_watermark,
        };
      },
    },
  });
  await runTurn(ctx, { expect: "RECONCILE_THREAD_RESOLUTION" });
  await runTurn(ctx, { expect: "COMPLETE_THREAD_RESOLUTION" });

  // Nothing is left to plan once the resolved thread is observed, and the
  // declared advance is the loop's only exit.
  const resolvedAt = repliedAt + 60_000;
  const preReady = await runTurn(ctx, {
    expect: "PLAN_THREAD_ACTION",
    use: ["record_github_snapshot", "advance_remote_workflow"],
    materials: {
      observation: () => {
        const payload = withThread(
          draftObservation(ctx.state, secondHead, {
            at: resolvedAt,
            requestId: 100,
            requestAt: secondRequestAt,
          }),
          resolvedAt,
          [findingComment, replyComment],
        );
        payload.review_threads.threads[0].is_resolved = true;
        payload.review_threads.unresolved_count = 0;
        return payload;
      },
    },
  });
  assert.equal(preReady.next_action, "PLAN_MARK_PR_READY");
});

// The two branches the async surfaces resolve for COMPLETE_THREAD_RESOLUTION,
// on the states the fixtures already reach. A pre-resolved observation made
// no transition, so it owes no record; a terminal publication refuses the
// record, and completion is permitted exactly there.
test("a pre-resolved thread observation walks to completion", async (t) => {
  const { state, workflow } = await reachObservedThreadResolution(t, {
    outcome: "OBSERVED_PRE_RESOLVED",
  });
  const ctx = { state, store: state.store, workflowId: workflow.workflow_id };
  const summary = await getAutonomousWorkflowSummary(ctx.store, ctx.workflowId);
  assert.deepEqual(Object.keys(summary.required_inputs), [
    "complete_workflow_action",
  ]);
  await runTurn(ctx, { expect: "COMPLETE_THREAD_RESOLUTION" });
});

test("a resolution under a terminal publication walks to completion", async (t) => {
  const { state, workflow, second, repliedObservation, resolveAt } =
    await reachObservedThreadResolution(t, { outcome: "RESOLVED" });
  const ctx = { state, store: state.store, workflowId: workflow.workflow_id };
  const closedAt = resolveAt + 5_000;
  const closedObservation = structuredClone(repliedObservation);
  closedObservation.observed_at = iso(closedAt);
  closedObservation.pull_request.state = "CLOSED";
  const closed = await recordGithubSnapshot(
    state.store,
    second.reviewId,
    { expectedRevision: 6, observation: closedObservation },
    { clock: () => closedAt + 10 },
  );
  assert.equal(closed.terminal.status, "CLOSED");
  const summary = await getAutonomousWorkflowSummary(ctx.store, ctx.workflowId);
  assert.deepEqual(Object.keys(summary.required_inputs), [
    "complete_workflow_action",
  ]);
  await runTurn(ctx, { expect: "COMPLETE_THREAD_RESOLUTION" });
});

// The walked product, held exactly. A next_action losing its walk, or a walk
// silently exercising fewer declared calls, is a coverage regression this
// listing turns red. States real transitions produce that no walk above
// reaches -- the unresolve and return-to-draft action families, the check
// and base repair phases, the operator pauses and arbitration, cancellation,
// and the recovery fallback INSPECT_WORKFLOW -- are the recorded remainder:
// each needs its own invalidation or regression observation, and none of the
// five conditions the projection selects declarations with reaches them.
test("the walk covers the declared product it claims", () => {
  const listing = [...walked.entries()]
    .map(([key, tools]) => `${key} ${[...tools].sort().join(" ")}`)
    .sort();
  assert.deepEqual(listing, [
    "publication:POST_AND_RECORD_CODEX_REVIEW_REQUEST record_codex_review_request",
    "publication:RECORD_GITHUB_SNAPSHOT record_github_snapshot",
    "workflow:ADDRESS_LOCAL_FINDINGS acknowledge_change_size_warning advance_local_workflow record_workflow_head submit_resolutions",
    "workflow:ADDRESS_REMOTE_FINDINGS record_workflow_head",
    "workflow:AWAIT_OPERATOR release_workflow_claims",
    "workflow:COMMIT_HEAD record_workflow_head",
    "workflow:COMPLETE_CODEX_TASK_DISPATCH complete_workflow_action",
    "workflow:COMPLETE_DRAFT_PULL_REQUEST complete_workflow_action",
    "workflow:COMPLETE_MARK_PR_READY complete_workflow_action",
    "workflow:COMPLETE_PUSH complete_workflow_action",
    "workflow:COMPLETE_THREAD_REPLY complete_workflow_action",
    "workflow:COMPLETE_THREAD_RESOLUTION complete_workflow_action record_automatic_resolution",
    "workflow:CREATE_CODEX_REVIEWER_TASK mark_workflow_action_executing",
    "workflow:CREATE_DRAFT_PULL_REQUEST mark_workflow_action_executing",
    "workflow:FINALIZE_LOCAL_GATE advance_local_workflow finalize_local_gate",
    "workflow:MARK_PR_READY mark_workflow_action_executing",
    "workflow:PLAN_CODEX_TASK_DISPATCH plan_codex_task_dispatch",
    "workflow:PLAN_DRAFT_PULL_REQUEST plan_draft_pull_request",
    "workflow:PLAN_MARK_PR_READY plan_mark_pull_request_ready",
    "workflow:PLAN_PUSH plan_workflow_push",
    "workflow:PLAN_THREAD_ACTION advance_remote_workflow plan_thread_reply plan_thread_resolution record_github_snapshot",
    "workflow:PREPARE_LOCAL_REVIEW acknowledge_change_size_warning bind_workflow_review prepare_review record_workflow_head",
    "workflow:PREPARE_REREVIEW advance_local_workflow prepare_rereview",
    "workflow:PUSH_TOPIC_BRANCH mark_workflow_action_executing",
    "workflow:RECONCILE_CODEX_REVIEWER_TASK record_codex_task_observation",
    "workflow:RECONCILE_DRAFT_PULL_REQUEST record_draft_pull_request_observation",
    "workflow:RECONCILE_MARK_PR_READY record_mark_ready_observation",
    "workflow:RECONCILE_PUSH record_push_observation",
    "workflow:RECONCILE_THREAD_REPLY record_thread_reply_observation",
    "workflow:RECONCILE_THREAD_RESOLUTION record_thread_resolution_observation",
    "workflow:RECORD_FRESH_OBSERVATION_AND_ADVANCE advance_remote_workflow record_github_snapshot",
    "workflow:REPLY_TO_CODEX_THREAD mark_workflow_action_executing",
    "workflow:RESOLVE_REVIEW_THREAD mark_workflow_action_executing",
    "workflow:START_PUBLICATION bind_workflow_publication start_publication",
    "workflow:WAIT_LOCAL_REREVIEW advance_local_workflow",
    "workflow:WAIT_LOCAL_REVIEW advance_local_workflow",
    "workflow:WAIT_PUBLICATION advance_remote_workflow",
  ]);
});
