import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  prepareReview,
  submitInitialReview,
} from "../src/core.mjs";
import {
  acknowledgeCodexReviewAmbiguity,
  finalizePublicationGate,
  getAutonomousPreReady,
  getAutonomousTerminal,
  getPublication,
  getPublicationSummary,
  getThreadResolutionPlan,
  recordAutomaticResolution,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
  threadWatermark,
  verifyPublicationGate,
  withAutonomousTerminalLock,
} from "../src/publication.mjs";
import {
  advanceLocalWorkflow,
  abandonWorkflowAction,
  advanceRemoteWorkflow,
  AUTONOMOUS_CAPABILITIES,
  bindWorkflowPublication,
  bindWorkflowReview,
  cancelAutonomousWorkflow,
  completeWorkflowAction,
  getAutonomousWorkflow,
  getAutonomousWorkflowSummary,
  listAutonomousWorkflows,
  markWorkflowActionExecuting,
  pauseAutonomousWorkflow,
  planCodexTaskDispatch,
  planDraftPullRequest,
  planMarkPullRequestReady,
  planReturnToDraft,
  planThreadReply,
  planThreadResolution,
  planWorkflowPush,
  recordCodexTaskObservation,
  recordDraftPullRequestObservation,
  recordMarkReadyObservation,
  recordReturnToDraftObservation,
  recordPushObservation,
  recordThreadReplyObservation,
  recordThreadResolutionObservation,
  recordWorkflowHead,
  releaseWorkflowClaims,
  resumeAutonomousWorkflow,
  startAutonomousWorkflow,
} from "../src/workflow.mjs";
import {
  acquireStateLock,
  atomicWriteCanonicalJson,
  canonicalJson,
  canonicalJsonBytes,
  sha256,
} from "../src/storage.mjs";
import {
  baseline,
  digest,
  iso,
  observation,
} from "./helpers/github-observation.mjs";

const REPOSITORY_ID = 101;
const PR_NUMBER = 7;
const TOPIC_BRANCH = "agent/workflow-core";
const CODEX_ACTOR_ID = 99;

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "review-bridge-remote-"),
  );
  const repository = path.join(root, "repo");
  const store = path.join(root, "store");
  await fsp.mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Review Bridge Test");
  git(repository, "config", "user.email", "review-bridge@example.invalid");
  await fsp.writeFile(
    path.join(repository, "app.js"),
    "export const value = 1;\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  git(
    repository,
    "remote",
    "add",
    "origin",
    "ssh://git@github.com/example/review-bridge.git",
  );
  const baseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "-c", TOPIC_BRANCH);
  return { root, repository, store, baseSha };
}

function workflowInput(repository, baseSha) {
  return {
    repositoryPath: repository,
    baseRef: baseSha,
    baseSha,
    requirement: "Close the remote review loop.",
    implementationScope: "Add the publication wait and repair phases.",
    topicBranch: TOPIC_BRANCH,
    operatorLabel: "Test Operator",
    capabilities: [...AUTONOMOUS_CAPABILITIES],
    publicationTarget: {
      base_repository_id: REPOSITORY_ID,
      base_owner: "example",
      base_repo: "review-bridge",
      base_branch: "main",
      head_repository_id: REPOSITORY_ID,
      head_owner: "example",
      head_repo: "review-bridge",
      head_branch: TOPIC_BRANCH,
      push_remote: "origin",
    },
  };
}

async function commit(repository, content) {
  await fsp.writeFile(path.join(repository, "app.js"), content);
  git(repository, "add", ".");
  git(repository, "commit", "-m", "change");
  return git(repository, "rev-parse", "HEAD");
}

/**
 * Run one head through local review, gate, push, and draft PR. The head is
 * recorded here unless a repair loop already recorded it.
 */
async function gateAndPublishHead(state, workflow, headSha, label) {
  const summary = await getAutonomousWorkflowSummary(
    state.store,
    workflow.workflow_id,
  );
  const workflowState = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  const recorded =
    summary.phase === "PREPARE_LOCAL_REVIEW"
      ? { revision: workflow.revision }
      : await recordWorkflowHead(
          state.store,
          workflow.workflow_id,
          workflow.revision,
          headSha,
        );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: "Close the remote review loop.",
    implementationScope: "Add the publication wait and repair phases.",
    reviewerProvider: "CODEX_TASK",
  });
  const bound = await bindWorkflowReview(
    state.store,
    workflow.workflow_id,
    recorded.revision,
    review.id,
  );

  const planned = await planCodexTaskDispatch(
    state.store,
    workflow.workflow_id,
    bound.revision,
    review.id,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
  );
  const observed = await recordCodexTaskObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
    {
      matchingTaskIds: [`task-${label}`],
      taskId: `task-${label}`,
      title: planned.dispatch.title,
      prompt: planned.dispatch.prompt,
    },
  );
  const dispatched = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );

  await submitInitialReview(state.store, review.id, [], "CODEX_TASK");
  const clean = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    dispatched.revision,
  );
  await finalizeLocalGate(state.store, review.id);
  const gated = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    clean.revision,
  );
  assert.equal(gated.phase, "LOCAL_GATE_PASSED");

  const pushPlanned = await planWorkflowPush(
    state.store,
    workflow.workflow_id,
    gated.revision,
  );
  const pushExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    pushPlanned.workflow.revision,
    pushPlanned.action.action_id,
    {
      resolved_repository_id: REPOSITORY_ID,
      resolved_url: pushPlanned.action.target.remote_url,
      ...(workflowState?.pull_request == null
        ? {}
        : { pull_request_is_draft: true }),
    },
  );
  const pushObserved = await recordPushObservation(
    state.store,
    workflow.workflow_id,
    pushExecuting.revision,
    pushPlanned.action.action_id,
    {
      remoteRefSha: headSha,
      remoteRepositoryId: REPOSITORY_ID,
      remoteUrl: pushPlanned.action.target.remote_url,
    },
  );
  const pushed = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    pushObserved.revision,
    pushPlanned.action.action_id,
  );

  const prPlanned = await planDraftPullRequest(
    state.store,
    workflow.workflow_id,
    pushed.revision,
    { creatorActorId: 555, creatorActorType: "User" },
  );
  const prExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    prPlanned.workflow.revision,
    prPlanned.action.action_id,
  );
  const prObserved = await recordDraftPullRequestObservation(
    state.store,
    workflow.workflow_id,
    prExecuting.revision,
    prPlanned.action.action_id,
    {
      matchingPrNumbers: [PR_NUMBER],
      prNumber: PR_NUMBER,
      repositoryId: REPOSITORY_ID,
      headRepositoryId: REPOSITORY_ID,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha,
      draft: true,
      bodyMarker: `<!-- ${prPlanned.action.correlation_marker} -->`,
      creatorActorId: 555,
      creatorActorType: "User",
      url: `https://github.com/example/review-bridge/pull/${PR_NUMBER}`,
    },
  );
  const atPublication = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    prObserved.revision,
    prPlanned.action.action_id,
  );
  assert.equal(atPublication.phase, "START_PUBLICATION");
  return { workflow: atPublication, reviewId: review.id };
}

function startInput(state, reviewId, workflow, startedAt) {
  return {
    reviewId,
    repositoryId: REPOSITORY_ID,
    owner: "example",
    repo: "review-bridge",
    prNumber: PR_NUMBER,
    baseBranch: "main",
    headBranch: TOPIC_BRANCH,
    codexActorId: CODEX_ACTOR_ID,
    codexActorType: "Bot",
    codexActorLogin: "chatgpt-codex-connector[bot]",
    codexTriggerMode: "EXPLICIT_ONLY",
    baseline: baseline(startedAt - 100),
    workflowId: workflow.workflow_id,
    expectedWorkflowRevision: workflow.revision,
  };
}

function draftObservation(state, headSha, options) {
  return observation({
    baseSha: state.baseSha,
    headSha,
    repositoryId: REPOSITORY_ID,
    prNumber: PR_NUMBER,
    headBranch: TOPIC_BRANCH,
    owner: "example",
    repo: "review-bridge",
    isDraft: true,
    ...options,
  });
}

/** Reach the remote wait with one recorded draft observation. */
async function reachRemoteWait(state, workflow, reviewId, headSha, at, mutate) {
  await startPublication(
    state.store,
    startInput(state, reviewId, workflow, at),
    { clock: () => at },
  );
  const requestAt = at + 1_000;
  await recordCodexReviewRequest(
    state.store,
    reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: `https://github.com/example/review-bridge/issues/${PR_NUMBER}#issuecomment-100`,
      createdAt: iso(requestAt),
      requestedHeadSha: headSha,
    },
    { clock: () => requestAt + 10 },
  );
  const bound = await bindWorkflowPublication(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    reviewId,
  );
  assert.equal(bound.phase, "WAIT_PUBLICATION");

  const observedAt = at + 2_000;
  const payload = draftObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt,
  });
  await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: 2, observation: mutate ? mutate(payload) : payload },
    { clock: () => observedAt + 10 },
  );
  return { workflow: bound, observedAt };
}

function failingCheck(payload, context = "ci") {
  const collection = payload.required_checks.collection;
  const collectedAt = collection.policy_sources[0].collected_at;
  collection.policy_sources.push({
    kind: "CLASSIC_BRANCH_PROTECTION",
    endpoint: "GET /fixture/classic",
    collected_at: collectedAt,
    status: "COMPLETE",
    result: "SUCCESS",
  });
  const checkRunSource = collection.run_sources.find(
    (source) => source.kind === "CHECK_RUN",
  );
  checkRunSource.item_count = 1;
  checkRunSource.reported_total_count = 1;
  payload.required_checks.policy = "REQUIRED";
  payload.required_checks.requirements = [
    {
      context,
      app_binding: "EXPLICITLY_UNBOUND",
      required_app_id: null,
      binding_sources: [
        {
          kind: "CLASSIC_BRANCH_PROTECTION",
          field: "required_status_checks.contexts",
          raw_representation: "NULL",
        },
      ],
    },
  ];
  payload.required_checks.runs = [
    {
      run_kind: "CHECK_RUN",
      run_id: 501,
      context,
      app_id: 1,
      app_id_source: "CHECK_RUN_APP_ID",
      status: "COMPLETED",
      conclusion: "FAILURE",
      started_at: collection.collected_at,
      completed_at: collection.collected_at,
      head_sha: payload.pull_request.head_sha,
    },
  ];
  return payload;
}

function findingsResult(payload, bodyDigest = digest("codex finding one")) {
  const result = payload.codex_review.results[0];
  result.resource_kind = "PULL_REQUEST_REVIEW";
  result.timestamp_field = "submitted_at";
  result.native_review_state = "COMMENTED";
  result.format = "CODEX_FINDINGS_REVIEW_V1";
  result.verdict = "FINDINGS";
  result.commit_binding = {
    source: "PULL_REQUEST_REVIEW_COMMIT_ID",
    field: "commit_id",
    prefix: null,
  };
  result.attached_review_comments = [
    {
      comment_id: 900,
      actor: { id: CODEX_ACTOR_ID, type: "Bot", login: "codex" },
      commit_id: result.reviewed_head_sha,
      body_sha256: bodyDigest,
    },
  ];
  return payload;
}

test("an autonomous publication binds its workflow at every independent check", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );

  const startedAt = Date.now();
  const ledger = await startPublication(
    state.store,
    startInput(state, reviewId, atPublication, startedAt),
    { clock: () => startedAt },
  );
  assert.equal(ledger.version, 3);
  assert.equal(ledger.workflow_id, workflow.workflow_id);
  assert.match(ledger.workflow_authorization_sha256, /^[0-9a-f]{64}$/);
  // The publication authorization digest keeps its version-2 meaning and is a
  // different value from the workflow authorization digest.
  assert.notEqual(
    ledger.authorization.source_sha256,
    ledger.workflow_authorization_sha256,
  );

  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const tampered = structuredClone(stored);
  tampered.authorization.operator_label = "someone else";
  tampered.authorization.workflow_authorization_sha256 =
    stored.authorization.workflow_authorization_sha256;
  await atomicWriteCanonicalJson(workflowPath, tampered);

  // Every site validates the digest for itself rather than trusting a load.
  await assert.rejects(
    getPublicationSummary(state.store, reviewId),
    /WORKFLOW_AUTHORIZATION_INVALID/,
  );
  await assert.rejects(
    getAutonomousPreReady(state.store, reviewId),
    /WORKFLOW_AUTHORIZATION_INVALID/,
  );
  await assert.rejects(
    recordGithubSnapshot(state.store, reviewId, {
      expectedRevision: 1,
      observation: draftObservation(state, headSha, {
        at: startedAt + 2_000,
        requestId: null,
        requestAt: startedAt + 1_000,
        withResult: false,
      }),
    }),
    /WORKFLOW_AUTHORIZATION_INVALID/,
  );
  await assert.rejects(
    finalizePublicationGate(state.store, reviewId, { expectedRevision: 1 }),
    /WORKFLOW_AUTHORIZATION_INVALID/,
  );

  await atomicWriteCanonicalJson(workflowPath, stored);
  const restored = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(restored.workflow_id, workflow.workflow_id);
});

test("a publication cannot be started for a workflow that does not authorize it", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const startedAt = Date.now();

  await assert.rejects(
    startPublication(
      state.store,
      {
        ...startInput(state, reviewId, atPublication, startedAt),
        expectedWorkflowRevision: atPublication.revision + 1,
      },
      { clock: () => startedAt },
    ),
    /WORKFLOW_REVISION_CONFLICT/,
  );
  await assert.rejects(
    startPublication(
      state.store,
      { ...startInput(state, reviewId, atPublication, startedAt), prNumber: 8 },
      { clock: () => startedAt },
    ),
    /WORKFLOW_AUTHORIZATION_MISMATCH/,
  );
  await assert.rejects(
    startPublication(
      state.store,
      {
        ...startInput(state, reviewId, atPublication, startedAt),
        repositoryId: 999,
      },
      { clock: () => startedAt },
    ),
    /WORKFLOW_AUTHORIZATION_MISMATCH/,
  );
  await assert.rejects(
    startPublication(
      state.store,
      {
        ...startInput(state, reviewId, atPublication, startedAt),
        expectedWorkflowRevision: null,
      },
      { clock: () => startedAt },
    ),
    /INVALID_INPUT/,
  );
});

test("version 1 and 2 publications keep their behavior and cannot bind a workflow", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const startedAt = Date.now();
  const manual = await startPublication(
    state.store,
    {
      ...startInput(state, reviewId, atPublication, startedAt),
      workflowId: null,
      expectedWorkflowRevision: null,
    },
    { clock: () => startedAt },
  );
  assert.equal(manual.version, 2);
  assert.equal("workflow_id" in manual, false);
  assert.equal("workflow_authorization_sha256" in manual, false);

  // A non-autonomous ledger has no autonomous projection at all.
  await assert.rejects(
    getAutonomousPreReady(state.store, reviewId),
    /PUBLICATION_NOT_AUTONOMOUS/,
  );

  // Grafting the workflow binding onto a version-2 ledger fails closed.
  const ledgerPath = path.join(
    state.store,
    "reviews",
    reviewId,
    "publication.json",
  );
  const grafted = JSON.parse(await fsp.readFile(ledgerPath, "utf8"));
  grafted.workflow_id = workflow.workflow_id;
  grafted.workflow_authorization_sha256 = "0".repeat(64);
  await atomicWriteCanonicalJson(ledgerPath, grafted);
  await assert.rejects(
    getPublicationSummary(state.store, reviewId),
    /only a version 3 publication may bind an autonomous workflow/,
  );
});

test("the autonomous projection ignores only the draft flag", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  await reachRemoteWait(state, atPublication, reviewId, headSha, at);

  // The manual path still stops at the draft flag and still proposes the
  // manual mark-ready action.
  const summary = await getPublicationSummary(state.store, reviewId);
  assert.equal(summary.status, "PR_DRAFT");
  assert.equal(summary.next_action, "MARK_PULL_REQUEST_READY");

  const projection = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(projection.status, "READY_TO_MARK");
  assert.equal(projection.blocking_reason, null);
  assert.equal(projection.is_draft, true);
  assert.deepEqual(projection.blockers, []);
});

test("a draft publication with any other blocker never reaches READY_TO_MARK", async (t) => {
  const cases = [
    {
      name: "failed required check",
      mutate: (payload) => failingCheck(payload),
      status: "CHECKS_FAILED",
    },
    {
      name: "machine findings",
      mutate: (payload) => findingsResult(payload),
      status: "CHANGES_REQUIRED",
    },
    {
      name: "unresolved thread",
      mutate: (payload) => {
        payload.review_threads.total_count = 1;
        payload.review_threads.unresolved_count = 1;
        payload.review_threads.threads = [
          { id: "thread-1", is_resolved: false, is_outdated: false },
        ];
        return payload;
      },
      status: "CHANGES_REQUIRED",
    },
    {
      name: "pending review",
      mutate: (payload) => {
        payload.codex_review.results = [];
        return payload;
      },
      status: "GITHUB_REVIEW_PENDING",
    },
    {
      name: "conflicting merge state",
      mutate: (payload) => {
        payload.pull_request.mergeable = "CONFLICTING";
        return payload;
      },
      status: "PR_CONFLICTING",
    },
  ];
  for (const scenario of cases) {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const workflow = await startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    );
    const headSha = await commit(state.repository, "export const value = 2;\n");
    const { workflow: atPublication, reviewId } = await gateAndPublishHead(
      state,
      workflow,
      headSha,
      "one",
    );
    await reachRemoteWait(
      state,
      atPublication,
      reviewId,
      headSha,
      Date.now(),
      scenario.mutate,
    );
    const projection = await getAutonomousPreReady(state.store, reviewId);
    assert.equal(projection.status, scenario.status, scenario.name);
    assert.notEqual(projection.blocking_reason, null, scenario.name);
    assert.notEqual(projection.blockers.length, 0, scenario.name);
  }
});

test("the remote wait routes each blocker to its repair phase or pause", async (t) => {
  const cases = [
    {
      name: "machine findings",
      mutate: (payload) => findingsResult(payload),
      phase: "ADDRESS_REMOTE_FINDINGS",
      nextAction: "ADDRESS_REMOTE_FINDINGS",
    },
    {
      name: "failed required check",
      mutate: (payload) => failingCheck(payload),
      phase: "ADDRESS_CHECK_FAILURE",
      nextAction: "ADDRESS_CHECK_FAILURE",
    },
    {
      name: "ambiguous review",
      mutate: (payload) => {
        payload.codex_review.results[0].verdict = "UNKNOWN";
        return payload;
      },
      phase: "PAUSED_HUMAN",
      pause: "GITHUB_REVIEW_AMBIGUOUS",
      // The remedy is an external acknowledgement, then a fresh observation.
      resumePhase: "WAIT_PUBLICATION",
      nextAction: "AWAIT_OPERATOR",
    },
    {
      name: "conflicting merge state",
      mutate: (payload) => {
        payload.pull_request.mergeable = "CONFLICTING";
        return payload;
      },
      phase: "PAUSED_HUMAN",
      pause: "SEMANTIC_CONFLICT",
      // The remedy is a clean base merge and a new commit, which is only
      // possible from a phase that can record a head.
      resumePhase: "UPDATE_FROM_BASE",
      nextAction: "AWAIT_OPERATOR",
    },
    {
      name: "closed pull request",
      mutate: (payload) => {
        payload.pull_request.state = "CLOSED";
        return payload;
      },
      phase: "PAUSED_HUMAN",
      pause: "PUBLICATION_INVALIDATED",
      // The publication is terminal, so the only remedy inside the workflow is
      // a new head; returning to the wait would strand it forever.
      resumePhase: "IMPLEMENTING",
      nextAction: "AWAIT_OPERATOR",
    },
    {
      name: "clean and pre-ready",
      mutate: null,
      phase: "PRE_READY",
      nextAction: "PLAN_MARK_PR_READY",
    },
    {
      name: "unresolved thread keeps waiting",
      mutate: (payload) => {
        payload.review_threads.total_count = 1;
        payload.review_threads.unresolved_count = 1;
        payload.review_threads.threads = [
          { id: "thread-1", is_resolved: false, is_outdated: false },
        ];
        return payload;
      },
      phase: "WAIT_PUBLICATION",
      nextAction: "WAIT_PUBLICATION",
    },
    {
      name: "pending review keeps waiting",
      mutate: (payload) => {
        payload.codex_review.results = [];
        return payload;
      },
      phase: "WAIT_PUBLICATION",
      nextAction: "WAIT_PUBLICATION",
    },
  ];
  for (const scenario of cases) {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const workflow = await startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    );
    const headSha = await commit(state.repository, "export const value = 2;\n");
    const { workflow: atPublication, reviewId } = await gateAndPublishHead(
      state,
      workflow,
      headSha,
      "one",
    );
    const { workflow: waiting } = await reachRemoteWait(
      state,
      atPublication,
      reviewId,
      headSha,
      Date.now(),
      scenario.mutate,
    );
    const advanced = await advanceRemoteWorkflow(
      state.store,
      workflow.workflow_id,
      waiting.revision,
    );
    assert.equal(advanced.phase, scenario.phase, scenario.name);
    if (scenario.pause) {
      assert.equal(advanced.status, "PAUSED", scenario.name);
      assert.equal(advanced.pause.reason_code, scenario.pause, scenario.name);
      assert.equal(
        advanced.pause.resume_phase,
        scenario.resumePhase,
        scenario.name,
      );
    } else {
      assert.equal(advanced.status, "ACTIVE", scenario.name);
    }
    assert.equal(
      (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
        .next_action,
      scenario.nextAction,
      scenario.name,
    );
  }
});

test("a remote finding returns through a new gated head and a new publication", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const firstHead = await commit(state.repository, "export const value = 2;\n");
  const first = await gateAndPublishHead(state, workflow, firstHead, "one");
  const { workflow: waiting } = await reachRemoteWait(
    state,
    first.workflow,
    first.reviewId,
    firstHead,
    Date.now(),
    (payload) => findingsResult(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_REMOTE_FINDINGS");
  assert.equal(repairing.remote_attempts.length, 1);
  assert.equal(repairing.remote_attempts[0].head_sha, firstHead);
  assert.equal(repairing.current_publication.review_id, first.reviewId);

  const secondHead = await commit(state.repository, "export const value = 3;\n");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    secondHead,
  );
  // The new head rejoins the existing local loop and drops the old
  // publication binding: the previous ledger cannot authorize this head.
  assert.equal(repaired.phase, "PREPARE_LOCAL_REVIEW");
  assert.equal(repaired.current_publication, null);
  assert.equal(repaired.attempts.length, 2);

  const second = await gateAndPublishHead(
    state,
    { workflow_id: workflow.workflow_id, revision: repaired.revision },
    secondHead,
    "two",
  );
  assert.notEqual(second.reviewId, first.reviewId);
  const { workflow: waitingAgain } = await reachRemoteWait(
    state,
    second.workflow,
    second.reviewId,
    secondHead,
    Date.now(),
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waitingAgain.revision,
  );
  assert.equal(preReady.phase, "PRE_READY");

  // The first publication remains on disk as history and still refuses to
  // authorize anything for the new head.
  const historical = await getPublication(state.store, first.reviewId);
  assert.equal(historical.version, 3);
  assert.notEqual(historical.authorization.head_sha, secondHead);
});

/**
 * Drive a workflow to an observed thread-resolution outcome: a finding
 * thread answered by the workflow's own recorded reply, then either resolved
 * by the workflow or found already resolved at the action pre-read.
 */
async function reachObservedThreadResolution(
  t,
  {
    outcome = "RESOLVED",
    // Optional additional resolved threads carried by the first
    // publication's writer-validated observation: each names a second
    // finding this workflow resolved before repairing the first. The
    // factory receives { firstHead } so a test can root the thread in the
    // same finding review that raised PRRT_1.
    firstPublicationThreads = null,
  } = {},
) {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const firstHead = await commit(state.repository, "export const value = 2;\n");
  const first = await gateAndPublishHead(state, workflow, firstHead, "one");
  const extraFirstThreads =
    firstPublicationThreads == null
      ? []
      : firstPublicationThreads({ firstHead });
  const { workflow: waiting } = await reachRemoteWait(
    state,
    first.workflow,
    first.reviewId,
    firstHead,
    Date.now(),
    (payload) => {
      findingsResult(payload);
      if (extraFirstThreads.length > 0) {
        // The first publication observes the second finding already
        // resolved alongside the unresolved first finding: the observation
        // stays exactly valid (counts, provenance, ancestry) so the real
        // recordGithubSnapshot writer accepts it.
        payload.review_threads.total_count = extraFirstThreads.length;
        payload.review_threads.unresolved_count = 0;
        payload.review_threads.threads = extraFirstThreads.map((entry) =>
          structuredClone(entry),
        );
      }
      return payload;
    },
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_REMOTE_FINDINGS");

  // Recording the repair head writes the addressed-by record, derived from
  // the bound publication's own correlated findings review rather than from
  // any caller-supplied identity.
  const secondHead = await commit(state.repository, "export const value = 3;\n");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    secondHead,
  );
  assert.equal(repaired.addressed_findings.length, 1);
  const record = repaired.addressed_findings[0];
  assert.equal(record.number, 1);
  assert.equal(record.publication_review_id, first.reviewId);
  // The revision the repair-phase projection was derived from: start (1),
  // request (2), snapshot (3). Binding it is what makes "the review that
  // blocked" exact rather than approximate.
  assert.equal(record.publication_revision, 3);
  assert.deepEqual(record.findings_review, {
    result_id: 101,
    reviewed_head_sha: firstHead,
  });
  assert.deepEqual(record.addressed_by, [secondHead]);

  // The next publication observes the still-unresolved thread rooted in that
  // review, with a clean result for the repaired head and provider ancestry.
  const second = await gateAndPublishHead(
    state,
    { workflow_id: workflow.workflow_id, revision: repaired.revision },
    secondHead,
    "two",
  );
  const threadAt = Date.now();
  const codex = {
    id: CODEX_ACTOR_ID,
    type: "Bot",
    login: "chatgpt-codex-connector[bot]",
  };
  const { workflow: waitingAgain } = await reachRemoteWait(
    state,
    second.workflow,
    second.reviewId,
    secondHead,
    threadAt,
    (payload) => {
      payload.review_threads.total_count = 1;
      payload.review_threads.unresolved_count = 1;
      payload.review_threads.threads = [
        {
          id: "PRRT_1",
          is_resolved: false,
          is_outdated: false,
          path: null,
          line: null,
          comment_count: 1,
          comments_pagination_complete: true,
          provenance_complete: true,
          comments: [
            {
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
            },
          ],
        },
      ];
      payload.review_threads.ancestry = [
        {
          finding_head_sha: firstHead,
          status: "AHEAD",
          descends: true,
          endpoint: `GET /repos/example/review-bridge/compare/${firstHead}...${secondHead}`,
          collected_at: iso(threadAt + 1_600),
        },
      ];
      return payload;
    },
  );

  const plan = await getThreadResolutionPlan(state.store, second.reviewId);
  assert.equal(plan.workflow_id, workflow.workflow_id);
  assert.equal(plan.head_sha, secondHead);
  assert.equal(plan.threads.length, 1);
  const verdict = plan.threads[0];
  assert.equal(verdict.thread_id, "PRRT_1");
  assert.equal(verdict.eligible, true);
  // The verdict carries what acting on it needs: the commits the reply will
  // name, the exact comment watermark, and one digest binding both to this
  // head, workflow, and observation.
  assert.deepEqual(verdict.addressed_by, [secondHead]);
  assert.match(verdict.thread_watermark, /^[0-9a-f]{64}$/);
  assert.match(verdict.eligibility_sha256, /^[0-9a-f]{64}$/);

  // The lock-free binding read validates the records it hands the predicate.
  // A canonically rewritten ledger whose record drops its commits must fail
  // the read, not reach the eligibility join as evidence.
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const tampered = structuredClone(stored);
  tampered.addressed_findings[0].addressed_by = [];
  await atomicWriteCanonicalJson(workflowPath, tampered);
  await assert.rejects(
    getThreadResolutionPlan(state.store, second.reviewId),
    (error) => error.code === "WORKFLOW_STATE_INVALID",
  );
  await atomicWriteCanonicalJson(workflowPath, stored);

  // The advance leaves the wait: at least one eligible thread means the
  // workflow now owns the next step instead of waiting for an operator.
  const resolving = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waitingAgain.revision,
  );
  assert.equal(resolving.phase, "RESOLVE_CODEX_THREADS");

  // The reply action: server-composed body naming the addressed-by commits,
  // posted, observed, and recorded as the thread's one admitted reply.
  const replyPlanned = await planThreadReply(
    state.store,
    workflow.workflow_id,
    resolving.revision,
    { threadId: "PRRT_1", actorId: 555, actorType: "User" },
  );
  assert.equal(
    replyPlanned.dispatch.body,
    `Fixed in ${secondHead.slice(0, 10)}.\n\n<!-- ${replyPlanned.action.correlation_marker} -->`,
  );
  const replyExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    replyPlanned.workflow.revision,
    replyPlanned.action.action_id,
  );
  const replyObserved = await recordThreadReplyObservation(
    state.store,
    workflow.workflow_id,
    replyExecuting.revision,
    replyPlanned.action.action_id,
    {
      matchingCommentIds: [901],
      commentId: 901,
      threadId: "PRRT_1",
      actorId: 555,
      actorType: "User",
      body: replyPlanned.dispatch.body,
    },
  );
  const replied = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    replyObserved.revision,
    replyPlanned.action.action_id,
  );
  assert.equal(replied.phase, "RESOLVE_CODEX_THREADS");
  assert.equal(replied.active_action, null);
  assert.equal(replied.thread_replies.length, 1);
  const reply = replied.thread_replies[0];
  assert.equal(reply.thread_id, "PRRT_1");
  assert.equal(reply.comment_id, 901);
  assert.deepEqual(reply.actor, { id: 555, type: "User" });
  assert.equal(reply.head_sha, secondHead);
  assert.equal(reply.publication_review_id, second.reviewId);

  // The resolution intent must bind a reply-inclusive watermark: while the
  // latest observation still predates the reply, planning refuses rather
  // than binding a watermark the workflow's own next snapshot would break.
  await assert.rejects(
    planThreadResolution(state.store, workflow.workflow_id, replied.revision, {
      threadId: "PRRT_1",
    }),
    (error) => error.code === "WORKFLOW_THREAD_REPLY_NOT_OBSERVED",
  );

  // A fresh observation carries the reply as a thread comment by the human
  // operator account. Condition 7 admits exactly that recorded comment, so
  // the thread stays eligible; the same comment unrecorded would refuse.
  const repliedAt = Date.now();
  const repliedObservation = draftObservation(state, secondHead, {
    at: repliedAt,
    requestId: 100,
    requestAt: threadAt + 1_000,
  });
  const replyComment = {
    id: "PRRC_2",
    database_id: 901,
    created_at: iso(repliedAt - 2_000),
    updated_at: iso(repliedAt - 2_000),
    actor: { id: 555, type: "User", login: "operator" },
    review: null,
  };
  repliedObservation.review_threads.total_count = 1;
  repliedObservation.review_threads.unresolved_count = 1;
  repliedObservation.review_threads.threads = [
    {
      id: "PRRT_1",
      is_resolved: false,
      is_outdated: false,
      path: null,
      line: null,
      comment_count: 2,
      comments_pagination_complete: true,
      provenance_complete: true,
      comments: [
        {
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
        },
        replyComment,
      ],
    },
  ];
  repliedObservation.review_threads.ancestry = [
    {
      finding_head_sha: firstHead,
      status: "AHEAD",
      descends: true,
      endpoint: `GET /repos/example/review-bridge/compare/${firstHead}...${secondHead}`,
      collected_at: iso(repliedAt - 400),
    },
  ];
  await recordGithubSnapshot(
    state.store,
    second.reviewId,
    { expectedRevision: 3, observation: repliedObservation },
    { clock: () => repliedAt + 2_000 },
  );
  const repliedPlan = await getThreadResolutionPlan(
    state.store,
    second.reviewId,
  );
  assert.equal(repliedPlan.threads.length, 1);
  assert.equal(repliedPlan.threads[0].eligible, true);

  // The exception is the recorded identity, not the account: the same
  // observation with the reply's comment ID shifted by one names a comment
  // no completed action recorded, and the thread refuses again.
  const unrecordedAt = repliedAt + 5_000;
  const unrecordedObservation = structuredClone(repliedObservation);
  unrecordedObservation.observed_at = iso(unrecordedAt);
  const foreign =
    unrecordedObservation.review_threads.threads[0].comments[1];
  foreign.database_id = 902;
  await recordGithubSnapshot(
    state.store,
    second.reviewId,
    { expectedRevision: 4, observation: unrecordedObservation },
    { clock: () => unrecordedAt + 10 },
  );
  const unrecordedPlan = await getThreadResolutionPlan(
    state.store,
    second.reviewId,
  );
  assert.deepEqual(unrecordedPlan.threads[0], {
    thread_id: "PRRT_1",
    path: null,
    line: null,
    is_resolved: false,
    eligible: false,
    reason: "NOT_CODEX_AUTHORED",
  });

  // Back on the true observation, the resolution half runs: intent bound to
  // the reply-inclusive watermark, unresolved pre-read, resolved post-read
  // attributed to the workflow's own actor, server-owned record, and a
  // fresh resolved snapshot that reaches the pre-ready projection.
  const resolveAt = unrecordedAt + 10_000;
  const resolveObservation = structuredClone(repliedObservation);
  resolveObservation.observed_at = iso(resolveAt);
  await recordGithubSnapshot(
    state.store,
    second.reviewId,
    { expectedRevision: 5, observation: resolveObservation },
    { clock: () => resolveAt + 10 },
  );
  const resolvePlan = await getThreadResolutionPlan(
    state.store,
    second.reviewId,
  );
  assert.equal(resolvePlan.threads[0].eligible, true);
  const watermark = resolvePlan.threads[0].thread_watermark;

  const resolutionPlanned = await planThreadResolution(
    state.store,
    workflow.workflow_id,
    replied.revision,
    { threadId: "PRRT_1" },
  );
  assert.deepEqual(resolutionPlanned.action.target, {
    review_id: second.reviewId,
    thread_id: "PRRT_1",
    thread_watermark: watermark,
    eligibility_sha256: resolvePlan.threads[0].eligibility_sha256,
    head_sha: secondHead,
    expected_actor_id: 555,
    expected_actor_type: "User",
    reply_comment_id: 901,
  });
  const resolutionExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    resolutionPlanned.workflow.revision,
    resolutionPlanned.action.action_id,
    {
      thread_id: "PRRT_1",
      is_resolved: outcome === "OBSERVED_PRE_RESOLVED",
      ...(outcome === "RESOLVED" ? { thread_watermark: watermark } : {}),
    },
  );
  // A response attributing the transition to anyone but the action's own
  // actor never becomes an observation -- refused before anything persists,
  // so the true post-read can still be recorded at the same revision.
  if (outcome === "RESOLVED") {
    await assert.rejects(
      recordThreadResolutionObservation(
        state.store,
        workflow.workflow_id,
        resolutionExecuting.revision,
        resolutionPlanned.action.action_id,
        {
          outcome: "RESOLVED",
          threadId: "PRRT_1",
          isResolved: true,
          threadWatermark: watermark,
          resolvedById: 999,
          resolvedByType: "User",
        },
      ),
      (error) => error.code === "WORKFLOW_ACTION_INVALID",
    );
  }

  const resolutionObserved = await recordThreadResolutionObservation(
    state.store,
    workflow.workflow_id,
    resolutionExecuting.revision,
    resolutionPlanned.action.action_id,
    {
      outcome,
      threadId: "PRRT_1",
      isResolved: true,
      ...(outcome === "RESOLVED"
        ? {
            threadWatermark: watermark,
            resolvedById: 555,
            resolvedByType: "User",
          }
        : {}),
    },
  );
  return {
    state,
    workflow,
    first,
    second,
    secondHead,
    codex,
    record,
    workflowPath,
    repliedObservation,
    resolveAt,
    resolvePlan,
    watermark,
    resolutionPlanned,
    resolutionObserved,
    extraFirstThreads,
  };
}

test("an addressed finding's thread becomes eligible in the next publication's plan", async (t) => {
  const {
    state,
    workflow,
    second,
    codex,
    workflowPath,
    repliedObservation,
    resolveAt,
    resolvePlan,
    watermark,
    resolutionPlanned,
    resolutionObserved,
  } = await reachObservedThreadResolution(t);

  // A RESOLVED outcome cannot complete before its server-owned record
  // exists: completing first would let the next snapshot make the record
  // permanently uncreatable, leaving the gate nothing to re-check.
  await assert.rejects(
    completeWorkflowAction(
      state.store,
      workflow.workflow_id,
      resolutionObserved.revision,
      resolutionPlanned.action.action_id,
    ),
    (error) => error.code === "WORKFLOW_RESOLUTION_RECORD_MISSING",
  );

  // An outcome that claims no transition owns nothing to record: the same
  // action reporting OBSERVED_PRE_RESOLVED is not resolution evidence.
  const observedWorkflow = JSON.parse(
    await fsp.readFile(workflowPath, "utf8"),
  );
  const preResolved = structuredClone(observedWorkflow);
  preResolved.active_action.provider_response.outcome =
    "OBSERVED_PRE_RESOLVED";
  await atomicWriteCanonicalJson(workflowPath, preResolved);
  await assert.rejects(
    recordAutomaticResolution(
      state.store,
      second.reviewId,
      {
        expectedRevision: 6,
        workflowId: workflow.workflow_id,
        actionId: resolutionPlanned.action.action_id,
      },
      { clock: () => resolveAt + 2_500 },
    ),
    (error) => error.code === "WORKFLOW_RESOLUTION_ACTION_MISSING",
  );
  await atomicWriteCanonicalJson(workflowPath, observedWorkflow);

  // The record binds the action's own evidence, so only the action can be
  // named: an unknown action has nothing to record.
  await assert.rejects(
    recordAutomaticResolution(
      state.store,
      second.reviewId,
      {
        expectedRevision: 6,
        workflowId: workflow.workflow_id,
        actionId: `${resolutionPlanned.action.action_id}-other`,
      },
      { clock: () => resolveAt + 2_500 },
    ),
    (error) => error.code === "WORKFLOW_RESOLUTION_ACTION_MISSING",
  );
  // Recovery is free to observe before it records. The mutation already
  // happened, so the fresh snapshot shows the thread resolved -- and the
  // record, made from the action's evidence rather than that snapshot, is
  // still creatable. Nothing about this sequence may wedge the workflow.
  const recoveryAt = resolveAt + 5_000;
  const recoveryObservation = structuredClone(repliedObservation);
  recoveryObservation.observed_at = iso(recoveryAt);
  recoveryObservation.review_threads.threads[0].is_resolved = true;
  recoveryObservation.review_threads.unresolved_count = 0;
  const afterRecovery = await recordGithubSnapshot(
    state.store,
    second.reviewId,
    { expectedRevision: 6, observation: recoveryObservation },
    { clock: () => recoveryAt + 10 },
  );

  const withRecord = await recordAutomaticResolution(
    state.store,
    second.reviewId,
    {
      expectedRevision: afterRecovery.revision,
      workflowId: workflow.workflow_id,
      actionId: resolutionPlanned.action.action_id,
    },
    { clock: () => resolveAt + 3_000 },
  );
  assert.equal(withRecord.automatic_resolutions.length, 1);
  const resolutionRecord = withRecord.automatic_resolutions[0];
  assert.equal(resolutionRecord.thread_id, "PRRT_1");
  // Every binding is the intent's, not the snapshot the recovery recorded.
  assert.equal(resolutionRecord.thread_watermark, watermark);
  assert.equal(
    resolutionRecord.eligibility_sha256,
    resolvePlan.threads[0].eligibility_sha256,
  );
  assert.equal(resolutionRecord.reply_comment_id, 901);
  assert.deepEqual(resolutionRecord.actor, { id: 555, type: "User" });
  assert.equal(resolutionRecord.pre_read.is_resolved, false);
  assert.deepEqual(resolutionRecord.post_read.resolved_by, {
    id: 555,
    type: "User",
  });
  // The mutation invalidated whatever was observed before it.
  assert.equal(withRecord.latest_observation, null);
  const recollectionSummary = await getPublicationSummary(
    state.store,
    second.reviewId,
    { clock: () => resolveAt + 3_010 },
  );
  assert.deepEqual(
    {
      status: recollectionSummary.status,
      blocking_reason: recollectionSummary.blocking_reason,
      next_action: recollectionSummary.next_action,
    },
    {
      status: "PR_PENDING",
      blocking_reason: "NO_GITHUB_SNAPSHOT",
      next_action: "RECORD_GITHUB_SNAPSHOT",
    },
  );

  // Recovery re-running the same action's record creation is a no-op, and
  // stays one after the action itself is gone.
  const repeated = await recordAutomaticResolution(
    state.store,
    second.reviewId,
    {
      expectedRevision: withRecord.revision,
      workflowId: workflow.workflow_id,
      actionId: resolutionPlanned.action.action_id,
    },
    { clock: () => resolveAt + 4_000 },
  );
  assert.equal(repeated.revision, withRecord.revision);
  assert.equal(repeated.automatic_resolutions.length, 1);

  const resolved = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    resolutionObserved.revision,
    resolutionPlanned.action.action_id,
  );
  assert.equal(resolved.thread_resolutions.length, 1);
  assert.equal(resolved.thread_resolutions[0].outcome, "RESOLVED");
  const afterCompletion = await recordAutomaticResolution(
    state.store,
    second.reviewId,
    {
      expectedRevision: withRecord.revision,
      workflowId: workflow.workflow_id,
      actionId: resolutionPlanned.action.action_id,
    },
    { clock: () => resolveAt + 5_000 },
  );
  assert.equal(afterCompletion.revision, withRecord.revision);

  // The fresh post-resolution snapshot shows the same watermark resolved,
  // and the autonomous projection reaches READY_TO_MARK through the record
  // revalidation.
  const doneAt = resolveAt + 20_000;
  const doneObservation = structuredClone(repliedObservation);
  doneObservation.observed_at = iso(doneAt);
  doneObservation.review_threads.threads[0].is_resolved = true;
  doneObservation.review_threads.unresolved_count = 0;
  await recordGithubSnapshot(
    state.store,
    second.reviewId,
    { expectedRevision: withRecord.revision, observation: doneObservation },
    { clock: () => doneAt + 10 },
  );
  const continuationSummary = await getPublicationSummary(
    state.store,
    second.reviewId,
    { clock: () => doneAt + 20 },
  );
  assert.deepEqual(
    {
      status: continuationSummary.status,
      blocking_reason: continuationSummary.blocking_reason,
      next_action: continuationSummary.next_action,
    },
    {
      status: "PR_DRAFT",
      blocking_reason: "PR_DRAFT",
      next_action: "MARK_PULL_REQUEST_READY",
    },
  );
  const preReady = await getAutonomousPreReady(state.store, second.reviewId, {
    clock: () => doneAt + 20,
  });
  assert.equal(preReady.status, "READY_TO_MARK");
  const readyWorkflow = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    resolved.revision,
  );
  assert.equal(readyWorkflow.phase, "PRE_READY");

  // Any later watermark change -- here a new Codex follow-up -- invalidates
  // the record even though GitHub still reports the thread resolved.
  const movedAt = doneAt + 10_000;
  const movedObservation = structuredClone(doneObservation);
  movedObservation.observed_at = iso(movedAt);
  const movedThread = movedObservation.review_threads.threads[0];
  movedThread.comment_count = 3;
  movedThread.comments.push({
    id: "PRRC_3",
    database_id: 903,
    created_at: iso(movedAt - 1_000),
    updated_at: iso(movedAt - 1_000),
    actor: codex,
    review: null,
  });
  await recordGithubSnapshot(
    state.store,
    second.reviewId,
    { expectedRevision: withRecord.revision + 1, observation: movedObservation },
    { clock: () => movedAt + 10 },
  );
  const invalidated = await getAutonomousPreReady(
    state.store,
    second.reviewId,
    { clock: () => movedAt + 20 },
  );
  assert.equal(invalidated.status, "CHANGES_REQUIRED");
  assert.equal(invalidated.blocking_reason, "THREAD_RESOLUTION_INVALIDATED");
});

test("a repair head cannot be recorded when the publication no longer names a findings review", async (t) => {
  // The addressed-by record is server-derived from the bound publication. If
  // a fresh observation has withdrawn the correlated findings result, there
  // is no review the record could truthfully name, so the head recording
  // fails closed instead of writing a record without its link.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const firstHead = await commit(state.repository, "export const value = 2;\n");
  const first = await gateAndPublishHead(state, workflow, firstHead, "one");
  const startedAt = Date.now();
  const { workflow: waiting, observedAt } = await reachRemoteWait(
    state,
    first.workflow,
    first.reviewId,
    firstHead,
    startedAt,
    (payload) => findingsResult(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_REMOTE_FINDINGS");

  // A newer snapshot without any result: the publication's evidence now
  // decides GITHUB_REVIEW_PENDING rather than a findings review.
  const laterAt = observedAt + 5_000;
  await recordGithubSnapshot(
    state.store,
    first.reviewId,
    {
      expectedRevision: 3,
      observation: draftObservation(state, firstHead, {
        at: laterAt,
        requestId: 100,
        requestAt: startedAt + 1_000,
        withResult: false,
      }),
    },
    { clock: () => laterAt + 10 },
  );

  const secondHead = await commit(state.repository, "export const value = 3;\n");
  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      repairing.revision,
      secondHead,
    ),
    (error) => error.code === "WORKFLOW_FINDINGS_UNIDENTIFIED",
  );
});

test("a snapshot recorded after entering repair refuses the head even with the same findings", async (t) => {
  // The Codex-raised race: the publication lock is released before the
  // workflow mutation persists, so an intervening snapshot could withdraw or
  // replace the correlated result between the blocking projection and the
  // record. Revision binding closes it: even a snapshot that carries the
  // identical findings review moves the revision past the one that entered
  // the repair phase, and the head recording must refuse rather than record
  // an identity read across it.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const firstHead = await commit(state.repository, "export const value = 2;\n");
  const first = await gateAndPublishHead(state, workflow, firstHead, "one");
  const startedAt = Date.now();
  const { workflow: waiting, observedAt } = await reachRemoteWait(
    state,
    first.workflow,
    first.reviewId,
    firstHead,
    startedAt,
    (payload) => findingsResult(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_REMOTE_FINDINGS");

  const laterAt = observedAt + 5_000;
  await recordGithubSnapshot(
    state.store,
    first.reviewId,
    {
      expectedRevision: 3,
      observation: findingsResult(
        draftObservation(state, firstHead, {
          at: laterAt,
          requestId: 100,
          requestAt: startedAt + 1_000,
        }),
      ),
    },
    { clock: () => laterAt + 10 },
  );

  const secondHead = await commit(state.repository, "export const value = 3;\n");
  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      repairing.revision,
      secondHead,
    ),
    (error) => error.code === "WORKFLOW_FINDINGS_UNIDENTIFIED",
  );
});

test("a repeated blocker without a tree change pauses NO_PROGRESS", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const firstHead = await commit(state.repository, "export const value = 2;\n");
  const first = await gateAndPublishHead(state, workflow, firstHead, "one");
  const { workflow: waiting } = await reachRemoteWait(
    state,
    first.workflow,
    first.reviewId,
    firstHead,
    Date.now(),
    (payload) => findingsResult(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_REMOTE_FINDINGS");

  // An empty commit changes the head but not the tree, and Codex repeats the
  // identical finding body.
  git(state.repository, "commit", "--allow-empty", "-m", "no real change");
  const secondHead = git(state.repository, "rev-parse", "HEAD");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    secondHead,
  );
  const second = await gateAndPublishHead(
    state,
    { workflow_id: workflow.workflow_id, revision: repaired.revision },
    secondHead,
    "two",
  );
  const { workflow: waitingAgain } = await reachRemoteWait(
    state,
    second.workflow,
    second.reviewId,
    secondHead,
    Date.now(),
    (payload) => findingsResult(payload),
  );
  const stalled = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waitingAgain.revision,
  );
  assert.equal(stalled.status, "PAUSED");
  assert.equal(stalled.pause.reason_code, "NO_PROGRESS");
  assert.equal(stalled.remote_attempts.length, 2);
  const evidence = JSON.parse(stalled.pause.evidence);
  assert.equal(evidence.head_sha, secondHead);
  assert.equal(evidence.previous_remote_attempt.head_sha, firstHead);
  assert.equal(
    evidence.previous_remote_attempt.tree_sha,
    evidence.tree_sha,
  );

  // The operator's only remedy is a real change, so the pause must resume
  // where a head can be recorded. Resuming into WAIT_PUBLICATION would make
  // record_workflow_head fail and re-derive the same stall forever.
  assert.equal(stalled.pause.resume_phase, "ADDRESS_REMOTE_FINDINGS");
  const resumed = await resumeAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    stalled.revision,
    { operatorLabel: "Test Operator", rationale: "apply a real fix" },
  );
  assert.equal(resumed.status, "ACTIVE");
  assert.equal(resumed.phase, "ADDRESS_REMOTE_FINDINGS");
  const realFix = await commit(state.repository, "export const value = 9;\n");
  const progressing = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    resumed.revision,
    realFix,
  );
  assert.equal(progressing.phase, "PREPARE_LOCAL_REVIEW");
});

test("a workflow written before the remote fields stays readable and cancellable", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );

  // Reproduce a ledger written before this change: schema version 1 with
  // neither remote field. A released v0.5.0 workflow looks exactly like this.
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  assert.equal(stored.version, 1);
  delete stored.remote_attempts;
  delete stored.current_publication;
  await atomicWriteCanonicalJson(workflowPath, stored);

  const summary = await getAutonomousWorkflowSummary(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(summary.status, "ACTIVE");
  assert.deepEqual(summary.remote_attempts, []);
  assert.equal(summary.current_publication, null);

  // The store-wide claim scan validates every ledger, so an unreadable one
  // would also block starts on unrelated branches.
  const listed = await listAutonomousWorkflows(state.store);
  assert.deepEqual(
    listed.map((entry) => entry.workflow_id),
    [workflow.workflow_id],
  );

  // Cancellation is the path that releases the branch and head-ref claims.
  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    summary.revision,
    { operatorLabel: "Test Operator", rationale: "cleanup" },
  );
  assert.equal(cancelled.status, "CANCELLED");
});

test("a different finding after a real change is progress, not a stall", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const firstHead = await commit(state.repository, "export const value = 2;\n");
  const first = await gateAndPublishHead(state, workflow, firstHead, "one");
  const { workflow: waiting } = await reachRemoteWait(
    state,
    first.workflow,
    first.reviewId,
    firstHead,
    Date.now(),
    (payload) => findingsResult(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const secondHead = await commit(state.repository, "export const value = 3;\n");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    secondHead,
  );
  const second = await gateAndPublishHead(
    state,
    { workflow_id: workflow.workflow_id, revision: repaired.revision },
    secondHead,
    "two",
  );
  const { workflow: waitingAgain } = await reachRemoteWait(
    state,
    second.workflow,
    second.reviewId,
    secondHead,
    Date.now(),
    (payload) => findingsResult(payload, digest("codex finding two")),
  );
  const advanced = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waitingAgain.revision,
  );
  assert.equal(advanced.status, "ACTIVE");
  assert.equal(advanced.phase, "ADDRESS_REMOTE_FINDINGS");
  assert.equal(advanced.remote_attempts.length, 2);
  assert.notEqual(
    advanced.remote_attempts[0].blocker_sha256,
    advanced.remote_attempts[1].blocker_sha256,
  );
});

test("the check fingerprint ignores runs that are not required", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    Date.now(),
    (payload) => failingCheck(payload),
  );
  const withoutNoise = await getAutonomousPreReady(state.store, reviewId);

  // The same required failure, plus an unrelated non-required run that also
  // failed. The status is decided only by declared requirements, so the stall
  // fingerprint must not move either.
  const other = await fixture();
  t.after(() => fsp.rm(other.root, { recursive: true, force: true }));
  const otherWorkflow = await startAutonomousWorkflow(
    other.store,
    workflowInput(other.repository, other.baseSha),
  );
  const otherHead = await commit(other.repository, "export const value = 2;\n");
  const otherPublication = await gateAndPublishHead(
    other,
    otherWorkflow,
    otherHead,
    "one",
  );
  await reachRemoteWait(
    other,
    otherPublication.workflow,
    otherPublication.reviewId,
    otherHead,
    Date.now(),
    (payload) => {
      failingCheck(payload);
      payload.required_checks.runs.push({
        run_kind: "CHECK_RUN",
        run_id: 502,
        context: "flaky-optional",
        app_id: 1,
        app_id_source: "CHECK_RUN_APP_ID",
        status: "COMPLETED",
        conclusion: "FAILURE",
        started_at: payload.required_checks.collection.collected_at,
        completed_at: payload.required_checks.collection.collected_at,
        head_sha: payload.pull_request.head_sha,
      });
      const source = payload.required_checks.collection.run_sources.find(
        (entry) => entry.kind === "CHECK_RUN",
      );
      source.item_count = 2;
      source.reported_total_count = 2;
      return payload;
    },
  );
  const withNoise = await getAutonomousPreReady(
    other.store,
    otherPublication.reviewId,
  );

  assert.equal(withoutNoise.status, "CHECKS_FAILED");
  assert.equal(withNoise.status, "CHECKS_FAILED");
  assert.deepEqual(withNoise.blockers, withoutNoise.blockers);
  assert.equal(withNoise.blocker_sha256, withoutNoise.blocker_sha256);
});

test("expired evidence never routes the remote wait anywhere", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => failingCheck(payload),
  );

  // Twenty minutes later the same observation is well past the freshness
  // window. The manual summary already refuses to act on it.
  const stale = at + 20 * 60 * 1000;
  const summary = await getPublicationSummary(state.store, reviewId, {
    clock: () => stale,
  });
  assert.equal(summary.blocking_reason, "EVIDENCE_STALE");
  assert.equal(summary.next_action, "REFRESH_GITHUB_SNAPSHOT");

  const projection = await getAutonomousPreReady(state.store, reviewId, {
    clock: () => stale,
  });
  assert.equal(projection.status, "EVIDENCE_STALE");
  // The blockers keep naming the underlying failure rather than being replaced
  // by the staleness; the reported status is carried by the digest.
  assert.deepEqual(projection.blockers, [
    "check:CHECK_RUN:ci:unbound:FAILURE",
  ]);

  // Leaving WAIT_PUBLICATION is one way, so acting on expired evidence would
  // force a pointless commit, local review, push, and publication.
  const advanced = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
    { clock: () => stale },
  );
  assert.equal(advanced.status, "ACTIVE");
  assert.equal(advanced.phase, "WAIT_PUBLICATION");
  assert.equal(advanced.remote_attempts.length, 0);

  // Two different stale failures must not share a fingerprint.
  const other = await fixture();
  t.after(() => fsp.rm(other.root, { recursive: true, force: true }));
  const otherWorkflow = await startAutonomousWorkflow(
    other.store,
    workflowInput(other.repository, other.baseSha),
  );
  const otherHead = await commit(other.repository, "export const value = 2;\n");
  const otherPublication = await gateAndPublishHead(
    other,
    otherWorkflow,
    otherHead,
    "one",
  );
  await reachRemoteWait(
    other,
    otherPublication.workflow,
    otherPublication.reviewId,
    otherHead,
    at,
    (payload) => failingCheck(payload, "ci-beta"),
  );
  const otherProjection = await getAutonomousPreReady(
    other.store,
    otherPublication.reviewId,
    { clock: () => stale },
  );
  assert.equal(otherProjection.status, "EVIDENCE_STALE");
  assert.notEqual(otherProjection.blocker_sha256, projection.blocker_sha256);
});

test("cancelling the workflow revokes the publication it authorized", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      return payload;
    },
  );
  assert.equal(
    (await getAutonomousPreReady(state.store, reviewId)).status,
    "READY_TO_MARK",
  );

  await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
    { operatorLabel: "Test Operator", rationale: "abandon this change" },
  );

  // The kill switch has to revoke what it granted -- every mutator, not just
  // the ones that read the projection.
  await assert.rejects(
    getAutonomousPreReady(state.store, reviewId),
    /WORKFLOW_CANCELLED/,
  );
  await assert.rejects(
    recordCodexReviewRequest(state.store, reviewId, {
      expectedRevision: 3,
      commentId: 300,
      url: `https://github.com/example/review-bridge/issues/${PR_NUMBER}#issuecomment-300`,
      createdAt: iso(at + 3_000),
      requestedHeadSha: headSha,
    }),
    /WORKFLOW_CANCELLED/,
  );
  await assert.rejects(
    acknowledgeCodexReviewAmbiguity(state.store, reviewId, {
      expectedRevision: 3,
      headSha,
      requestRefs: [],
      ambiguousResults: [],
      acknowledgement: "NO_FURTHER_RESULTS_EXPECTED",
      operatorLabel: "Test Operator",
      rationale: "should never be accepted after cancellation",
    }),
    /WORKFLOW_CANCELLED/,
  );
  await assert.rejects(
    finalizePublicationGate(state.store, reviewId, { expectedRevision: 3 }),
    /WORKFLOW_CANCELLED/,
  );
  await assert.rejects(
    recordGithubSnapshot(state.store, reviewId, {
      expectedRevision: 3,
      observation: draftObservation(state, headSha, {
        at: at + 4_000,
        requestId: 100,
        requestAt: at + 1_000,
      }),
    }),
    /WORKFLOW_CANCELLED/,
  );

  // The audit trail stays readable: get_publication takes no binding.
  const historical = await getPublication(state.store, reviewId);
  assert.equal(historical.workflow_id, workflow.workflow_id);
});

test("the findings fingerprint dedupes, and a dead-head result fails closed", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    Date.now(),
    (payload) => findingsResult(payload),
  );
  const projection = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(projection.status, "CHANGES_REQUIRED");
  assert.equal(projection.blockers.length, 1);

  // The same finding body reported twice is one blocker, not two.
  const duplicated = await fixture();
  t.after(() => fsp.rm(duplicated.root, { recursive: true, force: true }));
  const duplicatedWorkflow = await startAutonomousWorkflow(
    duplicated.store,
    workflowInput(duplicated.repository, duplicated.baseSha),
  );
  const duplicatedHead = await commit(
    duplicated.repository,
    "export const value = 2;\n",
  );
  const duplicatedPublication = await gateAndPublishHead(
    duplicated,
    duplicatedWorkflow,
    duplicatedHead,
    "one",
  );
  await reachRemoteWait(
    duplicated,
    duplicatedPublication.workflow,
    duplicatedPublication.reviewId,
    duplicatedHead,
    Date.now(),
    (payload) => {
      findingsResult(payload);
      const comments = payload.codex_review.results[0].attached_review_comments;
      comments.push({
        ...structuredClone(comments[0]),
        comment_id: 902,
      });
      return payload;
    },
  );
  const duplicatedProjection = await getAutonomousPreReady(
    duplicated.store,
    duplicatedPublication.reviewId,
  );
  assert.deepEqual(duplicatedProjection.blockers, projection.blockers);
  assert.equal(
    duplicatedProjection.blocker_sha256,
    projection.blocker_sha256,
  );

  // A findings result reviewing an older head decides nothing. It never
  // reaches the fingerprint at all: the correlation rules classify the extra
  // result as ambiguous first, which pauses instead of routing a repair.
  const other = await fixture();
  t.after(() => fsp.rm(other.root, { recursive: true, force: true }));
  const otherWorkflow = await startAutonomousWorkflow(
    other.store,
    workflowInput(other.repository, other.baseSha),
  );
  const otherHead = await commit(other.repository, "export const value = 2;\n");
  const otherPublication = await gateAndPublishHead(
    other,
    otherWorkflow,
    otherHead,
    "one",
  );
  await reachRemoteWait(
    other,
    otherPublication.workflow,
    otherPublication.reviewId,
    otherHead,
    Date.now(),
    (payload) => {
      findingsResult(payload);
      payload.codex_review.preexisting_candidate_results = [];
      const carried = structuredClone(payload.codex_review.results[0]);
      carried.result_id = 777;
      carried.url = `https://github.com/example/review-bridge/pull/${PR_NUMBER}#discussion_r777`;
      carried.reviewed_head_sha = other.baseSha;
      carried.association = "BASELINE_LATE_RESULT";
      carried.attached_review_comments = [
        {
          comment_id: 901,
          actor: { id: CODEX_ACTOR_ID, type: "Bot", login: "codex" },
          commit_id: other.baseSha,
          body_sha256: digest("finding against a dead head"),
        },
      ];
      payload.codex_review.results.push(carried);
      return payload;
    },
  );
  const otherProjection = await getAutonomousPreReady(
    other.store,
    otherPublication.reviewId,
  );
  assert.equal(otherProjection.status, "GITHUB_REVIEW_UNKNOWN");
  assert.notEqual(otherProjection.blocker_sha256, projection.blocker_sha256);
});

test("a blocking status always yields at least one blocker", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );

  // A formal CHANGES_REQUESTED review at the authorized head blocks through a
  // route that constrains neither the verdict nor the attached comments, so
  // the comment-digest arm can narrow it to nothing.
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    Date.now(),
    (payload) => {
      findingsResult(payload);
      payload.codex_review.results[0].native_review_state = "CHANGES_REQUESTED";
      payload.codex_review.results[0].attached_review_comments = [];
      return payload;
    },
  );
  const projection = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(projection.status, "CHANGES_REQUIRED");
  assert.deepEqual(projection.blockers, ["CHANGES_REQUIRED:CHANGES_REQUIRED"]);

  // Routing into a repair phase whose only exit is a commit must never hand
  // the operator an empty blocker set.
  const advanced = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(advanced.phase, "ADDRESS_REMOTE_FINDINGS");
  assert.equal(advanced.remote_attempts.length, 1);
  assert.notEqual(
    advanced.remote_attempts[0].blocker_sha256,
    sha256(canonicalJson([])),
  );
});

test("an acknowledged ambiguity can still ask for the next review", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.codex_review.results[0].verdict = "UNKNOWN";
      return payload;
    },
  );
  const ambiguous = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(ambiguous.status, "GITHUB_REVIEW_UNKNOWN");

  const summary = await getPublicationSummary(state.store, reviewId);
  await acknowledgeCodexReviewAmbiguity(
    state.store,
    reviewId,
    {
      expectedRevision: summary.revision,
      headSha,
      requestRefs: summary.required_request_refs,
      ambiguousResults: summary.required_ambiguous_results,
      acknowledgement: "NO_FURTHER_RESULTS_EXPECTED",
      operatorLabel: "Test Operator",
      rationale: "the ambiguous result was inspected by hand",
    },
    { clock: () => at + 3_000 },
  );

  // The manual summary reaches PR_DRAFT before Codex status, and the pull
  // request is still draft here -- as it is whenever a review request is
  // needed -- so it can never hand back the request body.
  const manual = await getPublicationSummary(state.store, reviewId);
  assert.equal(manual.status, "PR_DRAFT");
  assert.equal(manual.codex_review_request, undefined);

  // The autonomous projection must, or the workflow could acknowledge an
  // ambiguity and then have no way to ask for another review.
  const projection = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(projection.status, "GITHUB_REVIEW_NOT_REQUESTED");
  assert.equal(typeof projection.codex_review_request.body, "string");
  assert.match(projection.codex_review_request.body, /@codex review/);
});

test("an idle remote poll costs neither a revision nor an audit event", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    Date.now(),
    (payload) => {
      payload.codex_review.results = [];
      return payload;
    },
  );
  const first = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(first.phase, "WAIT_PUBLICATION");

  const auditPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "action-audit.jsonl",
  );
  const before = (await fsp.stat(auditPath)).size;
  for (let index = 0; index < 5; index += 1) {
    const idle = await advanceRemoteWorkflow(
      state.store,
      workflow.workflow_id,
      first.revision,
    );
    assert.equal(idle.revision, first.revision);
    assert.equal(idle.phase, "WAIT_PUBLICATION");
  }
  assert.equal((await fsp.stat(auditPath)).size, before);
});

test("projections reporting different statuses never share a blocker digest", async (t) => {
  // Both pairs below collided at some point while this floor was being
  // patched: a stale-but-clean projection first matched a genuinely ready one,
  // then matched an unrelated blocked one once staleness replaced the reason.
  // The digest covers the reported status, so neither can recur however the
  // item list narrows.
  const build = async (mutate) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const workflow = await startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    );
    const headSha = await commit(state.repository, "export const value = 2;\n");
    const { workflow: atPublication, reviewId } = await gateAndPublishHead(
      state,
      workflow,
      headSha,
      "one",
    );
    const at = Date.now();
    await reachRemoteWait(
      state,
      atPublication,
      reviewId,
      headSha,
      at,
      mutate,
    );
    return {
      fresh: await getAutonomousPreReady(state.store, reviewId, {
        clock: () => at + 3_000,
      }),
      stale: await getAutonomousPreReady(state.store, reviewId, {
        clock: () => at + 20 * 60 * 1000,
      }),
    };
  };

  const clean = await build(null);
  // A formal CHANGES_REQUESTED review with no attached comments narrows to
  // nothing, so it relies on the same floor the clean case does.
  const narrowed = await build((payload) => {
    findingsResult(payload);
    payload.codex_review.results[0].native_review_state = "CHANGES_REQUESTED";
    payload.codex_review.results[0].attached_review_comments = [];
    return payload;
  });

  assert.equal(clean.fresh.status, "READY_TO_MARK");
  assert.equal(clean.stale.status, "EVIDENCE_STALE");
  assert.equal(narrowed.stale.status, "EVIDENCE_STALE");
  assert.deepEqual(clean.fresh.blockers, []);
  assert.deepEqual(clean.stale.blockers, []);

  assert.notEqual(clean.stale.blocker_sha256, clean.fresh.blocker_sha256);
  assert.notEqual(clean.stale.blocker_sha256, narrowed.stale.blocker_sha256);
  assert.notEqual(narrowed.stale.blocker_sha256, narrowed.fresh.blocker_sha256);
});

test("a non-adjacent repeat is still no progress", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );

  // Oscillate the tree between two states while the finding stays identical.
  // Every attempt differs from the one immediately before it, so comparing
  // only the last attempt never stalls -- but the third attempt returns to a
  // tree already proven not to clear that finding.
  const contents = [
    "export const value = 2;\n",
    "export const value = 3;\n",
    "export const value = 2;\n",
  ];
  let carried = { workflow_id: workflow.workflow_id, revision: workflow.revision };
  let advanced = null;
  const trees = [];
  for (const [index, content] of contents.entries()) {
    const headSha = await commit(state.repository, content);
    trees.push(
      git(state.repository, "rev-parse", `${headSha}^{tree}`),
    );
    const published = await gateAndPublishHead(
      state,
      carried,
      headSha,
      `attempt-${index}`,
    );
    const { workflow: waiting } = await reachRemoteWait(
      state,
      published.workflow,
      published.reviewId,
      headSha,
      Date.now(),
      (payload) => findingsResult(payload),
    );
    advanced = await advanceRemoteWorkflow(
      state.store,
      workflow.workflow_id,
      waiting.revision,
    );
    if (advanced.status === "PAUSED") {
      break;
    }
    assert.equal(advanced.phase, "ADDRESS_REMOTE_FINDINGS");
    // gateAndPublishHead records the next head itself from a repair phase.
    carried = {
      workflow_id: workflow.workflow_id,
      revision: advanced.revision,
    };
  }
  assert.equal(trees[0], trees[2], "the fixture must actually oscillate");
  assert.equal(advanced.status, "PAUSED");
  assert.equal(advanced.pause.reason_code, "NO_PROGRESS");

  // The match must be against the first attempt, not the one immediately
  // before -- that is the whole point. Two attempts preceded this stop, and
  // the adjacent one had a different tree.
  const evidence = JSON.parse(advanced.pause.evidence);
  assert.equal(advanced.remote_attempts.length, 3);
  assert.equal(evidence.previous_remote_attempt.number, 1);
  assert.equal(evidence.previous_remote_attempt.tree_sha, trees[0]);
  assert.equal(advanced.remote_attempts[1].tree_sha, trees[1]);
  assert.notEqual(trees[1], trees[0]);
});

test("a required history rewrite cannot be resumed", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const recorded = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    headSha,
  );
  const paused = await pauseAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    recorded.revision,
    {
      reasonCode: "HISTORY_REWRITE_REQUIRED",
      blockedAction: "UPDATE_FROM_BASE",
      evidence: "the fresh base does not apply without rewriting history",
    },
  );
  assert.equal(paused.status, "PAUSED");

  // Every recorded head must descend from the last, so a rewritten head is
  // rejected however the workflow resumes. Resuming would re-derive the same
  // stop, so it must say that instead.
  await assert.rejects(
    resumeAutonomousWorkflow(
      state.store,
      workflow.workflow_id,
      paused.revision,
      { operatorLabel: "Test Operator", rationale: "rewrote the branch" },
    ),
    /WORKFLOW_RESUME_INVALID/,
  );
  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    paused.revision,
    { operatorLabel: "Test Operator", rationale: "restart the work" },
  );
  assert.equal(cancelled.status, "CANCELLED");
});

test("an update-required base gap repairs through a new gated head", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    Date.now(),
    (payload) => {
      payload.required_checks.strict_policy = {
        required: true,
        sources: [
          {
            kind: "CLASSIC_BRANCH_PROTECTION",
            field: "required_status_checks.strict",
            value: true,
          },
        ],
      };
      payload.required_checks.collection.policy_sources.push({
        kind: "CLASSIC_BRANCH_PROTECTION",
        endpoint: "GET /fixture/classic",
        collected_at:
          payload.required_checks.collection.policy_sources[0].collected_at,
        status: "COMPLETE",
        result: "SUCCESS",
      });
      payload.pull_request.base_head_comparison.status = "BEHIND";
      return payload;
    },
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "UPDATE_FROM_BASE");
  assert.equal(repairing.remote_attempts.length, 1);

  const updated = await commit(state.repository, "export const value = 4;\n");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    updated,
  );
  assert.equal(repaired.phase, "PREPARE_LOCAL_REVIEW");
  assert.equal(repaired.current_publication, null);
});

test("a superseded publication stops being actionable before the push", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => findingsResult(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_REMOTE_FINDINGS");

  // Commit the repair but do not push. The workflow head has advanced and its
  // binding is cleared, yet the pull request still carries the old head, so
  // every pull-request-side invariant still agrees with the old ledger.
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    await commit(state.repository, "export const value = 3;\n"),
  );
  assert.equal(repaired.current_publication, null);

  // The abandoned ledger must not stay actionable in that window.
  const projection = await getAutonomousPreReady(state.store, reviewId, {
    clock: () => at + 3_000,
  });
  assert.equal(projection.status, "INVALIDATED");
  const summary = await getPublicationSummary(state.store, reviewId, {
    clock: () => at + 3_000,
  });
  assert.equal(summary.status, "INVALIDATED");

  await assert.rejects(
    recordGithubSnapshot(state.store, reviewId, {
      expectedRevision: 3,
      observation: draftObservation(state, headSha, {
        at: at + 4_000,
        requestId: 100,
        requestAt: at + 1_000,
      }),
    }),
    /PUBLICATION_SUPERSEDED/,
  );

  // Checking the superseded commit back out satisfies the local-gate
  // repository check, which is the only thing that would otherwise stand
  // between an abandoned ledger and a finalized gate.
  git(state.repository, "checkout", "--detach", headSha);
  assert.equal(git(state.repository, "rev-parse", "HEAD"), headSha);
  await assert.rejects(
    finalizePublicationGate(state.store, reviewId, { expectedRevision: 3 }),
    /PUBLICATION_SUPERSEDED/,
  );

  // It stays inspectable for audit.
  const historical = await getPublication(state.store, reviewId);
  assert.equal(historical.authorization.head_sha, headSha);
});

test("a gate cannot outlive the workflow head that could replace it", async (t) => {
  // A gate CAN outlive its workflow head: the publication's MERGE_READY is
  // independent of the workflow's phase. A failing required check moves the
  // workflow into a repair phase while the publication stays bound at the same
  // head; if that check later passes, the ledger returns to MERGE_READY and a
  // gate can be minted while the workflow is already sitting in a phase that
  // can record a later head.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    // Draft while the workflow repairs: a repair is never started on a pull
    // request that reviewers can already see. The mint below needs it out of
    // draft, which is what the next observation carries.
    (payload) => failingCheck(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
    { clock: () => at + 2_100 },
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");
  assert.equal(repairing.current_publication.review_id, reviewId);

  // The check is re-run remotely and passes. The head has not moved, so this
  // snapshot is accepted and the ledger returns to MERGE_READY.
  const laterAt = at + 3_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: draftObservation(state, headSha, {
        at: laterAt,
        requestId: 100,
        requestAt: at + 1_000,
        isDraft: false,
      }),
    },
    { clock: () => laterAt + 10 },
  );
  await finalizePublicationGate(
    state.store,
    reviewId,
    { expectedRevision: 4 },
    { clock: () => laterAt + 20 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, reviewId, {
      clock: () => laterAt + 30,
    })).valid,
    true,
  );

  // A gate can only be minted for a pull request out of draft, and a head
  // can only be recorded for one that is not: the repair would push onto
  // something reviewers can already see. So the gate cannot outlive its
  // workflow head by this route at all -- the head simply cannot move while
  // it stands.
  const replacement = await commit(state.repository, "export const value = 3;\n");
  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      repairing.revision,
      replacement,
    ),
    (error) => error.code === "WORKFLOW_PULL_REQUEST_EXPOSED",
  );

  // A repair already under way cannot record that head, and it is not
  // stranded either: the wait admits a repair phase precisely to send it to
  // the undo, which is the only thing that unblocks it.
  const ensuring = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    repairing.revision,
  );
  assert.equal(ensuring.phase, "ENSURE_DRAFT_FOR_REPAIR");
  const returning = await planReturnToDraft(
    state.store,
    workflow.workflow_id,
    ensuring.revision,
  );
  const returningExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    returning.workflow.revision,
    returning.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: false,
    },
  );
  const returningObserved = await recordReturnToDraftObservation(
    state.store,
    workflow.workflow_id,
    returningExecuting.revision,
    returning.action.action_id,
    {
      outcome: "RETURNED_TO_DRAFT",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      isDraft: true,
    },
  );
  const restored = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    returningObserved.revision,
    returning.action.action_id,
  );
  assert.equal(restored.phase, "WAIT_PUBLICATION");

  // The observation that proves it draft again revokes the gate on its way
  // past, and carries the blocker the repair exists for, so the head can
  // finally move -- to a pull request nobody is looking at, with the gate it
  // would have outlived already gone.
  const repairedAt = laterAt + 3_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 4,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: repairedAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => repairedAt + 10 },
  );
  const revoked = await verifyPublicationGate(state.store, reviewId, {
    clock: () => repairedAt + 20,
  });
  assert.equal(revoked.valid, false);

  const rerepairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    restored.revision,
  );
  assert.equal(rerepairing.phase, "ADDRESS_CHECK_FAILURE");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    rerepairing.revision,
    replacement,
  );
  assert.equal(repaired.current_publication, null);
  git(state.repository, "checkout", "--detach", headSha);
  const verified = await verifyPublicationGate(state.store, reviewId, {
    clock: () => repairedAt + 40,
  });
  assert.equal(verified.valid, false);
});

test("the remote wait itself cannot record a later head", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      return payload;
    },
  );
  await finalizePublicationGate(
    state.store,
    reviewId,
    { expectedRevision: 3 },
    { clock: () => at + 3_000 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, reviewId, {
      clock: () => at + 3_100,
    })).valid,
    true,
  );

  // The wait cannot record a head, and the only phase it can reach from a
  // ready projection cannot either.
  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      waiting.revision,
      await commit(state.repository, "export const value = 3;\n"),
    ),
    /WORKFLOW_PHASE_INVALID/,
  );
  git(state.repository, "checkout", "--detach", headSha);
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
    { clock: () => at + 3_150 },
  );
  assert.equal(preReady.phase, "PRE_READY");
  assert.equal(preReady.current_head_sha, headSha);
  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      preReady.revision,
      state.baseSha,
    ),
    /WORKFLOW_PHASE_INVALID/,
  );
});

test("the check fingerprint follows the runs that decided the status", async (t) => {
  // A pinned requirement is decided by the pinned app's latest run only. A
  // failing run from another app, or a superseded earlier rerun, must not move
  // the digest -- it cannot move the status, so letting it move the digest
  // would let an unchanged required failure on the same tree evade the stall
  // detection.
  const build = async (extraRuns, extraRequirements = [], { requiredAppId = 7 } = {}) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const workflow = await startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    );
    const headSha = await commit(state.repository, "export const value = 2;\n");
    const { workflow: atPublication, reviewId } = await gateAndPublishHead(
      state,
      workflow,
      headSha,
      "one",
    );
    await reachRemoteWait(
      state,
      atPublication,
      reviewId,
      headSha,
      Date.now(),
      (payload) => {
        const collection = payload.required_checks.collection;
        const collectedAt = collection.policy_sources[0].collected_at;
        collection.policy_sources.push({
          kind: "CLASSIC_BRANCH_PROTECTION",
          endpoint: "GET /fixture/classic",
          collected_at: collectedAt,
          status: "COMPLETE",
          result: "SUCCESS",
        });
        payload.required_checks.policy = "REQUIRED";
        payload.required_checks.requirements = [
          {
            context: "ci",
            app_binding: "PINNED",
            required_app_id: requiredAppId,
            binding_sources: [
              {
                kind: "CLASSIC_BRANCH_PROTECTION",
                field: "required_status_checks.contexts",
                raw_representation: "NULL",
              },
            ],
          },
          ...extraRequirements,
        ];
        const decisive = {
          run_kind: "CHECK_RUN",
          run_id: 900,
          context: "ci",
          app_id: requiredAppId,
          app_id_source: "CHECK_RUN_APP_ID",
          status: "COMPLETED",
          conclusion: "FAILURE",
          started_at: collection.collected_at,
          completed_at: collection.collected_at,
          head_sha: payload.pull_request.head_sha,
        };
        payload.required_checks.runs = [decisive, ...extraRuns(decisive)];
        for (const kind of ["CHECK_RUN", "COMMIT_STATUS"]) {
          const source = collection.run_sources.find(
            (entry) => entry.kind === kind,
          );
          const count = payload.required_checks.runs.filter(
            (run) => run.run_kind === kind,
          ).length;
          source.item_count = count;
          source.reported_total_count =
            kind === "CHECK_RUN" ? count : null;
        }
        return payload;
      },
    );
    return getAutonomousPreReady(state.store, reviewId);
  };

  const plain = await build(() => []);
  // Another app failing the same context, plus an older superseded rerun of
  // the pinned app. Neither decides the requirement.
  const noisy = await build((decisive) => [
    { ...decisive, run_id: 901, app_id: 8 },
    {
      ...decisive,
      run_id: 899,
      started_at: new Date(
        Date.parse(decisive.started_at) - 60_000,
      ).toISOString(),
    },
  ]);
  // A second requirement pinned to an app that produced no check run, with a
  // failing commit status on its context. checkRequiredRuns treats that
  // requirement as pending and never looks at the commit status, so it decides
  // nothing -- and must not enter the fingerprint either. The first
  // requirement still supplies the actual CHECKS_FAILED.
  const withCommitStatus = await build(
    (decisive) => [
      {
        ...decisive,
        run_kind: "COMMIT_STATUS",
        run_id: 902,
        context: "legacy-ci",
        app_id: null,
        app_id_source: "COMMIT_STATUS_UNAVAILABLE",
      },
    ],
    [
      {
        context: "legacy-ci",
        app_binding: "PINNED",
        required_app_id: 9,
        binding_sources: [
          {
            kind: "CLASSIC_BRANCH_PROTECTION",
            field: "required_status_checks.contexts",
            raw_representation: "NULL",
          },
        ],
      },
    ],
  );

  // The same context failing under a different pinned app is a different
  // actionable check, so it must not serialize to the same key.
  const otherApp = await build(
    (decisive) => [{ ...decisive, run_id: 903, app_id: 11 }],
    [],
    { requiredAppId: 11 },
  );

  assert.equal(plain.status, "CHECKS_FAILED");
  assert.equal(noisy.status, "CHECKS_FAILED");
  assert.deepEqual(noisy.blockers, plain.blockers);
  assert.equal(noisy.blocker_sha256, plain.blocker_sha256);
  assert.deepEqual(withCommitStatus.blockers, plain.blockers);
  assert.equal(withCommitStatus.blocker_sha256, plain.blocker_sha256);
  assert.equal(otherApp.status, "CHECKS_FAILED");
  assert.notEqual(otherApp.blocker_sha256, plain.blocker_sha256);
});

test("the version 3 gate carries both digests and verifies them independently", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  await reachRemoteWait(state, atPublication, reviewId, headSha, at, (payload) => {
    payload.pull_request.is_draft = false;
    return payload;
  });
  const gate = await finalizePublicationGate(
    state.store,
    reviewId,
    { expectedRevision: 3 },
    { clock: () => at + 3_000 },
  );
  assert.equal(gate.version, 3);
  assert.match(gate.authorization_sha256, /^[0-9a-f]{64}$/);
  assert.equal(gate.workflow_id, workflow.workflow_id);
  assert.match(gate.workflow_authorization_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    gate.resolution_sha256,
    sha256(
      canonicalJson({
        automatic_resolutions: [],
        resolution_lifecycle: [],
      }),
    ),
  );
  assert.notEqual(gate.authorization_sha256, gate.workflow_authorization_sha256);

  const verified = await verifyPublicationGate(
    state.store,
    reviewId,
    { clock: () => at + 3_100 },
  );
  assert.equal(verified.valid, true);

  // A gate whose workflow digest no longer matches the workflow ledger is a
  // mismatch, and verification still records its audit event.
  const gatePath = path.join(
    state.store,
    "reviews",
    reviewId,
    "publication-gate.json",
  );
  const storedGate = JSON.parse(await fsp.readFile(gatePath, "utf8"));
  const changedResolutionDigest = structuredClone(storedGate);
  changedResolutionDigest.resolution_sha256 = "2".repeat(64);
  await atomicWriteCanonicalJson(gatePath, changedResolutionDigest);
  const resolutionRejected = await verifyPublicationGate(
    state.store,
    reviewId,
    { clock: () => at + 3_150 },
  );
  assert.equal(resolutionRejected.valid, false);
  assert.equal(resolutionRejected.reason, "GATE_MISMATCH");

  const underBound = structuredClone(storedGate);
  delete underBound.resolution_sha256;
  await atomicWriteCanonicalJson(gatePath, underBound);
  const underBoundRejected = await verifyPublicationGate(
    state.store,
    reviewId,
    { clock: () => at + 3_175 },
  );
  assert.equal(underBoundRejected.valid, false);
  assert.equal(underBoundRejected.reason, "GATE_MISMATCH");
  const underBoundSummary = await getPublicationSummary(
    state.store,
    reviewId,
    { clock: () => at + 3_180 },
  );
  assert.equal(underBoundSummary.status, "MERGE_READY");
  assert.equal(underBoundSummary.gate_state, "INVALID");
  assert.equal(underBoundSummary.blocking_reason, "PUBLICATION_GATE_INVALID");
  assert.equal(underBoundSummary.next_action, "FINALIZE_PUBLICATION_GATE");

  const forged = JSON.parse(await fsp.readFile(gatePath, "utf8"));
  forged.resolution_sha256 = storedGate.resolution_sha256;
  forged.workflow_authorization_sha256 = "1".repeat(64);
  await atomicWriteCanonicalJson(gatePath, forged);
  const rejected = await verifyPublicationGate(
    state.store,
    reviewId,
    { clock: () => at + 3_200 },
  );
  assert.equal(rejected.valid, false);
  assert.equal(rejected.reason, "GATE_MISMATCH");
});

test("the remote wait rejects a publication bound to another head", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );

  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  assert.equal(
    canonicalJson(stored.current_publication.review_id),
    canonicalJson(reviewId),
  );
  assert.equal(stored.current_publication.head_sha, headSha);

  // The workflow head and the bound publication head are validated together.
  await assert.rejects(
    bindWorkflowPublication(
      state.store,
      workflow.workflow_id,
      waiting.revision,
      reviewId,
    ),
    /WORKFLOW_PHASE_INVALID/,
  );
});

test("a cleared draft pull request marks itself ready and then stops", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(preReady.phase, "PRE_READY");

  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  const projection = await getAutonomousPreReady(state.store, reviewId);
  // The intent carries the clearance itself, not a promise that one existed.
  assert.deepEqual(planned.action.target, {
    review_id: reviewId,
    repository_id: REPOSITORY_ID,
    pr_number: PR_NUMBER,
    base_branch: "main",
    head_branch: TOPIC_BRANCH,
    head_sha: headSha,
    publication_revision: projection.revision,
  });

  // A clearance is recorded only from the checkpoint onward, so a PLANNED
  // action carrying one is a ledger claiming a check that never ran.
  const plannedPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const storedPlanned = JSON.parse(await fsp.readFile(plannedPath, "utf8"));
  const forgedClearance = structuredClone(storedPlanned);
  forgedClearance.active_action.cleared_publication_revision = 3;
  await atomicWriteCanonicalJson(plannedPath, forgedClearance);
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
  );
  await atomicWriteCanonicalJson(plannedPath, storedPlanned);

  // The pre-read is the last check before the call, and it binds the exact
  // pull request and head: a drifted head never becomes an executing proof,
  // and neither does a reading that never looked at the draft state.
  // Every field the pre-read binds, one at a time: with the stored target
  // untouched, this validator is the only thing that can object to any of
  // them.
  for (const drifted of [
    { head_sha: "9".repeat(40) },
    { is_draft: null },
    { repository_id: REPOSITORY_ID + 1 },
    { pr_number: PR_NUMBER + 1 },
    { base_branch: "release" },
    { head_branch: "other-topic" },
  ]) {
    await assert.rejects(
      markWorkflowActionExecuting(
        state.store,
        workflow.workflow_id,
        planned.workflow.revision,
        planned.action.action_id,
        {
          repository_id: REPOSITORY_ID,
          pr_number: PR_NUMBER,
          base_branch: "main",
          head_branch: TOPIC_BRANCH,
          head_sha: headSha,
          is_draft: true,
          ...drifted,
        },
      ),
      (error) => error.code === "WORKFLOW_ACTION_INVALID",
    );
  }

  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: true,
    },
  );

  const observe = (overrides) =>
    recordMarkReadyObservation(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
      {
        outcome: "MARKED_READY",
        repositoryId: REPOSITORY_ID,
        prNumber: PR_NUMBER,
        baseBranch: "main",
        headBranch: TOPIC_BRANCH,
        headSha,
        isDraft: false,
        ...overrides,
      },
    );
  // A pull request still draft after the call is not a reconciled mark-ready,
  // and a pre-read that found it draft cannot report it was already ready:
  // this action did issue the call it is reconciling. The reconciliation
  // also has to be about the same pull request the intent named -- the
  // post-read is a second reading, and nothing else re-checks its identity.
  for (const wrong of [
    { isDraft: true },
    { repositoryId: REPOSITORY_ID + 1 },
    { prNumber: PR_NUMBER + 1 },
    { baseBranch: "release" },
    { headBranch: "other-topic" },
    { headSha: "9".repeat(40) },
  ]) {
    await assert.rejects(
      observe(wrong),
      (error) => error.code === "WORKFLOW_ACTION_INVALID",
    );
  }
  await assert.rejects(
    observe({ outcome: "OBSERVED_ALREADY_READY" }),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
  );

  const observed = await observe({});
  const ready = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );
  assert.equal(ready.phase, "POST_READY");
  // The driver must not stop here: a compliant driver follows the
  // server-derived next_action, and the run still owes one fresh post-ready
  // observation before the terminal projection can record MERGE_READY.
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "RECORD_FRESH_OBSERVATION_AND_ADVANCE",
  );
  assert.equal(ready.ready_marks.length, 1);
  assert.deepEqual(
    { ...ready.ready_marks[0], recorded_at: null },
    {
      number: 1,
      outcome: "MARKED_READY",
      action_id: planned.action.action_id,
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      head_sha: headSha,
      publication_review_id: reviewId,
      publication_revision: projection.revision,
      recorded_at: null,
    },
  );

  // The pull request is out of draft, so no repair phase may run without
  // returning it to draft first, and no terminal record exists yet: the
  // controller has not recorded the fresh post-ready observation the terminal
  // projection requires. The advance is legal but idle -- the run is stopped
  // at POST_READY, spends no revision, and records nothing.
  const idle = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    ready.revision,
  );
  assert.equal(idle.phase, "POST_READY");
  assert.equal(idle.status, "ACTIVE");
  assert.equal(idle.revision, ready.revision);
  assert.equal(idle.terminal, null);
});

test("a clearance that regresses at the pre-ready stop routes onward", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(preReady.phase, "PRE_READY");

  // Nothing is planned yet and the clearance regresses. Planning refuses
  // without changing state, and this phase can neither record a head nor be
  // resumed into anything else, so without an advance from here a healthy
  // run would have cancellation as its only exit.
  const blockedAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: blockedAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => blockedAt + 10 },
  );
  await assert.rejects(
    planMarkPullRequestReady(
      state.store,
      workflow.workflow_id,
      preReady.revision,
    ),
    (error) => error.code === "WORKFLOW_PUBLICATION_NOT_READY",
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");
});

test("an idle advance at the pre-ready stop spends no revision", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(preReady.phase, "PRE_READY");

  // Polling a stop that has not moved is the normal shape of this phase now
  // that it is advanceable, so an idle check must cost neither a revision
  // nor an audit event -- the same rule the other two waits follow.
  const idle = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  assert.equal(idle.phase, "PRE_READY");
  assert.equal(idle.revision, preReady.revision);
  assert.deepEqual(idle.action_audit, preReady.action_audit);

  // And the stop still leads where it always did.
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    idle.revision,
  );
  assert.equal(planned.action.kind, "MARK_PR_READY");
});

test("a blocked publication is never plannable for mark-ready", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(preReady.phase, "PRE_READY");

  // The clearance is re-read at plan time, so a blocker that lands after the
  // workflow reached the pre-ready stop refuses the intent rather than
  // riding the earlier projection.
  const blockedAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: blockedAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => blockedAt + 10 },
  );
  await assert.rejects(
    planMarkPullRequestReady(
      state.store,
      workflow.workflow_id,
      preReady.revision,
    ),
    (error) =>
      error.code === "WORKFLOW_PUBLICATION_NOT_READY" &&
      error.details.blocking_reason === "CHECKS_FAILED",
  );
});

test("a pull request found already ready reconciles without claiming it", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  // Recovery after a crash between the call and its record: the pre-read
  // finds this exact head already ready, which is the reconciled completion.
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: false,
    },
  );
  const observation = {
    outcome: "OBSERVED_ALREADY_READY",
    repositoryId: REPOSITORY_ID,
    prNumber: PR_NUMBER,
    baseBranch: "main",
    headBranch: TOPIC_BRANCH,
    headSha,
    isDraft: false,
  };
  // The outcome follows the pre-read, so this one cannot claim the mutation.
  await assert.rejects(
    recordMarkReadyObservation(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
      { ...observation, outcome: "MARKED_READY" },
    ),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
  );
  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
    observation,
  );
  const ready = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );
  assert.equal(ready.phase, "POST_READY");
  assert.equal(ready.ready_marks[0].outcome, "OBSERVED_ALREADY_READY");
});

test("a clearance that regresses after planning stops the mark-ready", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );

  // The intent was planned on a clearance that has since regressed: a
  // required check now fails. The pre-read is honest and the pull request is
  // still the right one, so nothing about the action itself is wrong -- only
  // the evidence it was planned on. Marking ready anyway would expose a head
  // with a failing check, and POST_READY has no route to the repair phase.
  const blockedAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: blockedAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => blockedAt + 10 },
  );
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      planned.workflow.revision,
      planned.action.action_id,
      {
        repository_id: REPOSITORY_ID,
        pr_number: PR_NUMBER,
        base_branch: "main",
        head_branch: TOPIC_BRANCH,
        head_sha: headSha,
        is_draft: true,
      },
    ),
    (error) =>
      error.code === "WORKFLOW_PUBLICATION_NOT_READY" &&
      error.details.blocking_reason === "CHECKS_FAILED" &&
      error.details.action_abandoned === planned.action.action_id,
  );

  // The refusal cannot leave the intent behind: PRE_READY can neither
  // advance, record a head, nor plan again while an action is active, so a
  // refused intent left in place would make cancellation the only exit from
  // a guard that just worked. Nothing external happened, so it is dropped
  // and the workflow is back in the wait.
  const abandoned = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(abandoned.active_action, null);
  assert.equal(abandoned.phase, "WAIT_PUBLICATION");

  // From there the ordinary loop owns it again -- this same failing check
  // routes to ADDRESS_CHECK_FAILURE from the wait, which is what the remote
  // routing test already pins. Here the check passes on a rerun instead, and
  // a fresh observation that clears the same head again is the state
  // this action was always waiting for: a new publication revision is not
  // itself a reason to refuse.
  const clearedAt = blockedAt + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 4,
      observation: draftObservation(state, headSha, {
        at: clearedAt,
        requestId: 100,
        requestAt: at + 1_000,
      }),
    },
    { clock: () => clearedAt + 10 },
  );
  const cleared = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(cleared.status, "READY_TO_MARK");
  assert.notEqual(cleared.revision, planned.action.target.publication_revision);
  const backAtPreReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    abandoned.revision,
  );
  assert.equal(backAtPreReady.phase, "PRE_READY");
  const replanned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    backAtPreReady.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    replanned.workflow.revision,
    replanned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: true,
    },
  );
  assert.equal(executing.active_action.status, "EXECUTING");

  // Once the action is executing the checkpoint is done: it guarded the one
  // call this action makes, and there is no second one to guard. A driver
  // that crashed there reconciles by observing the pull request, and the
  // pre-read it already recorded decides what it may claim.
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      executing.revision,
      replanned.action.action_id,
      {
        repository_id: REPOSITORY_ID,
        pr_number: PR_NUMBER,
        base_branch: "main",
        head_branch: TOPIC_BRANCH,
        head_sha: headSha,
        is_draft: true,
      },
    ),
    (error) => error.code === "WORKFLOW_ACTION_STATE_INVALID",
  );
  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    replanned.action.action_id,
    {
      outcome: "MARKED_READY",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha,
      isDraft: false,
    },
  );
  const ready = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    replanned.action.action_id,
  );
  assert.equal(ready.phase, "POST_READY");
  assert.equal(ready.ready_marks[0].outcome, "MARKED_READY");
});

test("a resolution whose publication went terminal still closes its action", async (t) => {
  const { state, workflow, second, repliedObservation, resolveAt, resolutionPlanned, resolutionObserved } =
    await reachObservedThreadResolution(t);

  // The mutation landed, and then the pull request closed. A terminal ledger
  // refuses every write, so the resolution record can never be created --
  // not late, uncreatable.
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
  await assert.rejects(
    recordAutomaticResolution(
      state.store,
      second.reviewId,
      {
        expectedRevision: closed.revision,
        workflowId: workflow.workflow_id,
        actionId: resolutionPlanned.action.action_id,
      },
      { clock: () => closedAt + 3_000 },
    ),
    (error) => error.code === "PUBLICATION_TERMINAL",
  );

  // Holding the action open for a record that cannot exist would strand the
  // workflow on a dead publication with no exit but cancellation. Nothing is
  // lost by closing it: no gate of a terminal publication can pass, so the
  // record has nothing left to protect.
  const resolved = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    resolutionObserved.revision,
    resolutionPlanned.action.action_id,
  );
  assert.equal(resolved.thread_resolutions.length, 1);
  assert.equal(resolved.thread_resolutions[0].outcome, "RESOLVED");
  assert.equal(resolved.active_action, null);
});

test("a crashed mark-ready is abandoned on recorded evidence, not testimony", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  // The whole publication timeline sits before the action executes, so its
  // observations are older than the write they would have to have missed.
  const at = Date.now() - 120_000;
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: true,
    },
  );

  // The driver died between the checkpoint and the call. The observation the
  // ledger already holds shows a draft pull request, but it was taken before
  // the call could have happened, so it says nothing about it.
  await assert.rejects(
    abandonWorkflowAction(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
    ),
    (error) => error.code === "WORKFLOW_ACTION_NOT_ABANDONABLE",
  );

  // A fresh observation taken after the crash does say something: the pull
  // request is a draft on this head, so no mark-ready this action might have
  // issued still stands. The clearance regressed while the driver was gone.
  const blockedAt = Date.now() + 5_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: blockedAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => blockedAt + 10 },
  );
  const abandoned = await abandonWorkflowAction(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
  );
  assert.equal(abandoned.active_action, null);
  assert.equal(abandoned.phase, "WAIT_PUBLICATION");
  assert.equal(abandoned.ready_marks.length, 0);

  // And the repair the regression asked for is ordinary work again.
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    abandoned.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");
});
test("an exposed pull request is not evidence that a mark-ready left nothing", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: true,
    },
  );

  // The call landed. The action stays: dropping it would erase the record of
  // a mutation this workflow performed, and the ledger says so.
  const readyAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: draftObservation(state, headSha, {
        at: readyAt,
        requestId: 100,
        requestAt: at + 1_000,
        isDraft: false,
      }),
    },
    { clock: () => readyAt + 10 },
  );
  await assert.rejects(
    abandonWorkflowAction(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
    ),
    (error) => error.code === "WORKFLOW_ACTION_NOT_ABANDONABLE",
  );
  const held = await getAutonomousWorkflow(state.store, workflow.workflow_id);
  assert.equal(held.active_action.status, "EXECUTING");

  // Its reconciliation is the honest one: the pre-read found it draft, so
  // this action issued the call that made it ready.
  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    held.revision,
    planned.action.action_id,
    {
      outcome: "MARKED_READY",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha,
      isDraft: false,
    },
  );
  const ready = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );
  assert.equal(ready.phase, "POST_READY");
});

test("a busy publication lock never destroys the planned mark-ready", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );

  // The checkpoint cannot read the clearance because someone else holds the
  // publication lock. That is "ask again", not "this intent is wrong": a
  // durable intent must never be destroyed over lock contention.
  const release = await acquireStateLock({
    directory: path.join(state.store, "reviews", reviewId),
    reviewId,
    domain: "publication",
  });
  try {
    await assert.rejects(
      markWorkflowActionExecuting(
        state.store,
        workflow.workflow_id,
        planned.workflow.revision,
        planned.action.action_id,
        {
          repository_id: REPOSITORY_ID,
          pr_number: PR_NUMBER,
          base_branch: "main",
          head_branch: TOPIC_BRANCH,
          head_sha: headSha,
          is_draft: true,
        },
      ),
      (error) =>
        error.details?.retryable === true &&
        error.details.action_abandoned === undefined,
    );
  } finally {
    await release();
  }
  const intact = await getAutonomousWorkflow(state.store, workflow.workflow_id);
  assert.equal(intact.active_action.action_id, planned.action.action_id);
  assert.equal(intact.active_action.status, "PLANNED");
  assert.equal(intact.phase, "PRE_READY");
});

test("the ready record names the clearance the checkpoint read", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );

  // An ordinary refreshed observation lands between planning and the call.
  // It clears the same head, so the checkpoint passes -- and from here the
  // plan-time revision and the one that authorizes the write differ, which
  // is what the completed record has to get right.
  const refreshedAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: draftObservation(state, headSha, {
        at: refreshedAt,
        requestId: 100,
        requestAt: at + 1_000,
      }),
    },
    { clock: () => refreshedAt + 10 },
  );
  const refreshed = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(refreshed.status, "READY_TO_MARK");
  assert.notEqual(refreshed.revision, planned.action.target.publication_revision);

  const proof = {
    repository_id: REPOSITORY_ID,
    pr_number: PR_NUMBER,
    base_branch: "main",
    head_branch: TOPIC_BRANCH,
    head_sha: headSha,
    is_draft: true,
  };
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    proof,
  );
  assert.equal(
    executing.active_action.cleared_publication_revision,
    refreshed.revision,
  );

  // The whole target is validated on every load against the workflow's own
  // publication, pull request, and authorization -- not only the parts the
  // action ID digest or the executing proof happen to cover. A target
  // pointing at another publication is refused even though every other
  // recorded field still agrees.
  const targetPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const storedTarget = JSON.parse(await fsp.readFile(targetPath, "utf8"));
  // Each of these is rewritten in the stored action *and* in the executing
  // proof that mirrors it, so the proof's own cross-check agrees and the
  // target validator is the only thing left to object. The action ID digest
  // covers none of them either: it is built from the pull-request number and
  // head SHA alone. The repository is deliberately not in this list -- the
  // claim binding rejects a rewritten repository before any action
  // validation runs, so no tamper can isolate that conjunct.
  for (const tamper of [
    (target) => {
      target.review_id = `${reviewId}-other`;
    },
    (target) => {
      target.publication_revision = 0;
    },
    (target, action) => {
      target.base_branch = "release";
      action.executing_proof.base_branch = "release";
    },
    (target, action) => {
      target.head_branch = "other-topic";
      action.executing_proof.head_branch = "other-topic";
    },
  ]) {
    const repointed = structuredClone(storedTarget);
    tamper(repointed.active_action.target, repointed.active_action);
    await atomicWriteCanonicalJson(targetPath, repointed);
    await assert.rejects(
      getAutonomousWorkflow(state.store, workflow.workflow_id),
      (error) => error.code === "WORKFLOW_ACTION_INVALID",
    );
    await atomicWriteCanonicalJson(targetPath, storedTarget);
  }

  // The clearance the checkpoint accepted is part of the action from here
  // on, because the completed record names it: a ledger missing it is
  // invalid rather than silently plan-time.
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const storedExecuting = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const withoutClearance = structuredClone(storedExecuting);
  delete withoutClearance.active_action.cleared_publication_revision;
  await atomicWriteCanonicalJson(workflowPath, withoutClearance);
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
  );
  await atomicWriteCanonicalJson(workflowPath, storedExecuting);

  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
    {
      outcome: "MARKED_READY",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha,
      isDraft: false,
    },
  );
  const ready = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );
  assert.equal(ready.ready_marks[0].publication_revision, refreshed.revision);
  assert.notEqual(
    ready.ready_marks[0].publication_revision,
    planned.action.target.publication_revision,
  );

  // And the stored record is validated on every read, so a rewritten outcome
  // cannot pass as evidence of a mark this workflow performed.
  const storedReady = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const forgedReady = structuredClone(storedReady);
  forgedReady.ready_marks[0].outcome = "MARKED_READY_BY_HAND";
  await atomicWriteCanonicalJson(workflowPath, forgedReady);
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) => error.code === "WORKFLOW_STATE_INVALID",
  );
  await atomicWriteCanonicalJson(workflowPath, storedReady);
});

test("a regressed clearance never returns an already-ready pull request to the loop", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );

  // The pre-read finds the pull request already out of draft -- an earlier
  // attempt, or someone else -- and the clearance has regressed in the
  // meantime.
  const blockedAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: blockedAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => blockedAt + 10 },
  );
  const alreadyReadyProof = {
    repository_id: REPOSITORY_ID,
    pr_number: PR_NUMBER,
    base_branch: "main",
    head_branch: TOPIC_BRANCH,
    head_sha: headSha,
    is_draft: false,
  };
  // Dropping this intent into the wait would hand the workflow back to a
  // repair loop that pushes onto a pull request reviewers can already see.
  // It is dropped into the undo instead, which is the only thing that makes
  // the repair legal again.
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      planned.workflow.revision,
      planned.action.action_id,
      alreadyReadyProof,
    ),
    (error) =>
      error.code === "WORKFLOW_PUBLICATION_NOT_READY" &&
      error.details.action_abandoned === planned.action.action_id,
  );
  const ensuring = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(ensuring.phase, "ENSURE_DRAFT_FOR_REPAIR");
  assert.equal(ensuring.active_action, null);

  // From there the undo runs and the ordinary loop owns the blocker again.
  const returning = await planReturnToDraft(
    state.store,
    workflow.workflow_id,
    ensuring.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    returning.workflow.revision,
    returning.action.action_id,
    alreadyReadyProof,
  );
  const observed = await recordReturnToDraftObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    returning.action.action_id,
    {
      outcome: "RETURNED_TO_DRAFT",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      isDraft: true,
    },
  );
  const restored = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    returning.action.action_id,
  );
  assert.equal(restored.phase, "WAIT_PUBLICATION");

  const draftAt = blockedAt + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 4,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: draftAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => draftAt + 10 },
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    restored.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");
});

test("a repair returns the pull request to draft before it starts", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  // Someone marked the pull request ready while the workflow was waiting,
  // and the same observation carries a failing check. Repairing would push a
  // new head onto a pull request reviewers can already see.
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      return failingCheck(payload);
    },
  );
  const ensuring = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(ensuring.phase, "ENSURE_DRAFT_FOR_REPAIR");

  // The undo phase records no head of its own, so the repair cannot sneak
  // past it either.
  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      ensuring.revision,
      await commit(state.repository, "export const value = 3;\n"),
    ),
    (error) => error.code === "WORKFLOW_PHASE_INVALID",
  );

  const planned = await planReturnToDraft(
    state.store,
    workflow.workflow_id,
    ensuring.revision,
  );
  assert.deepEqual(planned.action.target, {
    review_id: reviewId,
    repository_id: REPOSITORY_ID,
    pr_number: PR_NUMBER,
    base_branch: "main",
    head_branch: TOPIC_BRANCH,
    head_sha: headSha,
  });
  const proof = {
    repository_id: REPOSITORY_ID,
    pr_number: PR_NUMBER,
    base_branch: "main",
    head_branch: TOPIC_BRANCH,
    head_sha: headSha,
    is_draft: false,
  };
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    proof,
  );
  // A pull request still ready after the call is not a reconciled undo, and
  // the outcome follows the pre-read here too: one this action found ready
  // is one it put back, and one already draft is not.
  await assert.rejects(
    recordReturnToDraftObservation(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
      {
        outcome: "RETURNED_TO_DRAFT",
        repositoryId: REPOSITORY_ID,
        prNumber: PR_NUMBER,
        baseBranch: "main",
        headBranch: TOPIC_BRANCH,
        isDraft: false,
      },
    ),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
  );
  await assert.rejects(
    recordReturnToDraftObservation(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
      {
        outcome: "OBSERVED_ALREADY_DRAFT",
        repositoryId: REPOSITORY_ID,
        prNumber: PR_NUMBER,
        baseBranch: "main",
        headBranch: TOPIC_BRANCH,
        isDraft: true,
      },
    ),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
  );
  const observed = await recordReturnToDraftObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
    {
      outcome: "RETURNED_TO_DRAFT",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      isDraft: true,
    },
  );
  const restored = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );
  assert.equal(restored.phase, "WAIT_PUBLICATION");

  // With the pull request draft again the blocked repair is ordinary work.
  const draftAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: draftAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => draftAt + 10 },
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    restored.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    await commit(state.repository, "export const value = 4;\n"),
  );
  assert.equal(repaired.phase, "PREPARE_LOCAL_REVIEW");
});

test("a cleared publication still marks a visible pull request ready", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  // Same exposure, no blocker. Nothing is repaired here, so nothing is
  // pushed: the stop is reachable and the action reconciles what it finds.
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      return payload;
    },
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(preReady.phase, "PRE_READY");
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: false,
    },
  );
  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
    {
      outcome: "OBSERVED_ALREADY_READY",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha,
      isDraft: false,
    },
  );
  const ready = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );
  assert.equal(ready.phase, "POST_READY");
  assert.equal(ready.ready_marks[0].outcome, "OBSERVED_ALREADY_READY");
});

test("a repair diverted through the undo is not a repeated attempt", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => failingCheck(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");
  assert.equal(repairing.remote_attempts.length, 1);

  // Someone marks the pull request ready while the repair is under way.
  const exposedAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: exposedAt,
          requestId: 100,
          requestAt: at + 1_000,
          isDraft: false,
        }),
      ),
    },
    { clock: () => exposedAt + 10 },
  );
  const ensuring = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    repairing.revision,
  );
  assert.equal(ensuring.phase, "ENSURE_DRAFT_FOR_REPAIR");
  // The repair it was diverted out of never ran, so it is marked rather than
  // counted -- the operator's record stays, the stall comparison skips it.
  assert.equal(ensuring.remote_attempts.length, 1);
  assert.notEqual(ensuring.remote_attempts[0].diverted_at, undefined);

  const planned = await planReturnToDraft(
    state.store,
    workflow.workflow_id,
    ensuring.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: false,
    },
  );
  const observed = await recordReturnToDraftObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
    {
      outcome: "RETURNED_TO_DRAFT",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      isDraft: true,
    },
  );
  const restored = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );

  // Back in draft with the same failing check, the repair resumes rather
  // than stalling on a position it never actually tried.
  const draftAgainAt = exposedAt + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 4,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: draftAgainAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => draftAgainAt + 10 },
  );
  const rerepairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    restored.revision,
  );
  assert.equal(rerepairing.phase, "ADDRESS_CHECK_FAILURE");
  assert.equal(rerepairing.remote_attempts.length, 2);
  assert.equal(rerepairing.remote_attempts[1].diverted_at, undefined);

  // The mark is what the stall comparison skips, so a forged one would
  // silently disable it. It is validated on every load like the rest of the
  // attempt.
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const forged = structuredClone(stored);
  forged.remote_attempts[1].diverted_at = "whenever";
  await atomicWriteCanonicalJson(workflowPath, forged);
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) =>
      error instanceof TypeError && /diverted_at/.test(error.message),
  );
  await atomicWriteCanonicalJson(workflowPath, stored);
});

test("an exposed pull request reaches the undo even when the blocker also pauses", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => failingCheck(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");

  // The pull request is readied and the merge state turns conflicting in the
  // same observation. The pause's own remedy is a repair phase, which cannot
  // record a head while the pull request is visible, so the undo comes first
  // or the workflow pauses and resumes forever.
  const exposedAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: (() => {
        const payload = draftObservation(state, headSha, {
          at: exposedAt,
          requestId: 100,
          requestAt: at + 1_000,
          isDraft: false,
        });
        payload.pull_request.mergeable = "CONFLICTING";
        return payload;
      })(),
    },
    { clock: () => exposedAt + 10 },
  );
  const ensuring = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    repairing.revision,
  );
  assert.equal(ensuring.phase, "ENSURE_DRAFT_FOR_REPAIR");
});

test("a terminal publication is not sent to an undo it cannot run", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );

  // The pull request merged before the call. The checkpoint refuses, and the
  // dropped intent must not land in a phase whose only action would try to
  // return a merged pull request to draft.
  const mergedAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: (() => {
        const payload = draftObservation(state, headSha, {
          at: mergedAt,
          requestId: 100,
          requestAt: at + 1_000,
          isDraft: false,
        });
        payload.pull_request.state = "CLOSED";
        payload.pull_request.merged = true;
        return payload;
      })(),
    },
    { clock: () => mergedAt + 10 },
  );
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      planned.workflow.revision,
      planned.action.action_id,
      {
        repository_id: REPOSITORY_ID,
        pr_number: PR_NUMBER,
        base_branch: "main",
        head_branch: TOPIC_BRANCH,
        head_sha: headSha,
        is_draft: false,
      },
    ),
    (error) => error.code === "WORKFLOW_PUBLICATION_NOT_READY",
  );
  const dropped = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(dropped.phase, "WAIT_PUBLICATION");

  // From the wait the terminal publication is the operator's, as it always was.
  const paused = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    dropped.revision,
  );
  assert.equal(paused.phase, "PAUSED_HUMAN");
  assert.equal(paused.pause.reason_code, "PUBLICATION_INVALIDATED");
});

test("a terminal publication stops deciding what the pull request is", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  // The observation that invalidates the publication also shows the pull
  // request visible. That reading is now frozen: a terminal ledger refuses
  // every further snapshot, so nothing can ever report the pull request as a
  // draft again through it. Routing on it would loop forever.
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      payload.pull_request.reviewed_base_current_base_comparison.status =
        "DIVERGED";
      return payload;
    },
  );
  const projection = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(projection.status, "INVALIDATED");
  assert.equal(projection.is_draft, false);
  const laterAt = at + 10_000;
  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      reviewId,
      {
        expectedRevision: 3,
        observation: draftObservation(state, headSha, {
          at: laterAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      },
      { clock: () => laterAt + 10 },
    ),
    (error) => error.code === "PUBLICATION_TERMINAL",
  );

  // So the workflow stops asking it: the pause is the ordinary one, and the
  // head it resumes to record is not refused on evidence that can never
  // change. The publication started for that head reads the pull request
  // afresh, which is where the guarantee comes back.
  const paused = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(paused.phase, "PAUSED_HUMAN");
  assert.equal(paused.pause.reason_code, "PUBLICATION_INVALIDATED");
  const resumed = await resumeAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    paused.revision,
    { operatorLabel: "jeremy", rationale: "start a new head" },
  );
  assert.equal(resumed.phase, "IMPLEMENTING");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    resumed.revision,
    await commit(state.repository, "export const value = 3;\n"),
  );
  assert.equal(repaired.phase, "PREPARE_LOCAL_REVIEW");
  assert.equal(repaired.current_publication, null);
});

test("a merged pull request ends the run instead of starting a cycle", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      payload.pull_request.state = "CLOSED";
      payload.pull_request.merged = true;
      return payload;
    },
  );
  const paused = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(paused.pause.reason_code, "PUBLICATION_INVALIDATED");

  // Resuming would send it to record a head, run a whole local review, and
  // discover at the push that the pull request it would land on is gone.
  // The workflow is over; cancelling is what is left, and it is cheap
  // because the claim release wants exactly this proof.
  await assert.rejects(
    resumeAutonomousWorkflow(
      state.store,
      workflow.workflow_id,
      paused.revision,
      { operatorLabel: "jeremy", rationale: "try to continue" },
    ),
    (error) => error.code === "WORKFLOW_RESUME_INVALID",
  );
});
test("the undo phase has an exit when the exposure resolves itself", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      return failingCheck(payload);
    },
  );
  const ensuring = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(ensuring.phase, "ENSURE_DRAFT_FOR_REPAIR");

  // Someone else put it back in draft. The phase's action has nothing left
  // to do, so the phase must not be where the workflow stays.
  const draftAgainAt = at + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: draftAgainAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => draftAgainAt + 10 },
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    ensuring.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");
});

test("a repair phase on a draft pull request cannot be advanced", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => failingCheck(payload),
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");

  // A repair phase is admitted to the advance only to be sent to the undo.
  // With the pull request draft there is nothing to undo, and re-deriving
  // the blocker here is what the phase exists to prevent.
  await assert.rejects(
    advanceRemoteWorkflow(
      state.store,
      workflow.workflow_id,
      repairing.revision,
    ),
    (error) => error.code === "WORKFLOW_PHASE_INVALID",
  );
});

test("an undo stranded by a merged pull request can be abandoned", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now() - 120_000;
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      return failingCheck(payload);
    },
  );
  const ensuring = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(ensuring.phase, "ENSURE_DRAFT_FOR_REPAIR");
  const planned = await planReturnToDraft(
    state.store,
    workflow.workflow_id,
    ensuring.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: false,
    },
  );

  // The pull request is merged while the undo is in flight. It can never
  // report the draft state this action's reconciliation requires, and no
  // head will be pushed to it either, so the action is settled by that.
  const mergedAt = Date.now() + 5_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: (() => {
        const payload = draftObservation(state, headSha, {
          at: mergedAt,
          requestId: 100,
          requestAt: at + 1_000,
          isDraft: false,
        });
        payload.pull_request.state = "CLOSED";
        payload.pull_request.merged = true;
        return payload;
      })(),
    },
    { clock: () => mergedAt + 10 },
  );
  const abandoned = await abandonWorkflowAction(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
  );
  assert.equal(abandoned.active_action, null);
  assert.equal(abandoned.phase, "WAIT_PUBLICATION");

  // And the merged publication is the operator's, as it always was.
  const paused = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    abandoned.revision,
  );
  assert.equal(paused.phase, "PAUSED_HUMAN");
  assert.equal(paused.pause.reason_code, "PUBLICATION_INVALIDATED");
});

test("an undo whose pull request is still returnable is not abandonable", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now() - 120_000;
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      return failingCheck(payload);
    },
  );
  const ensuring = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planReturnToDraft(
    state.store,
    workflow.workflow_id,
    ensuring.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: false,
    },
  );

  // Still open and still visible: this action has work to do, and dropping
  // it would leave the exposure it was planned to undo.
  const stillAt = Date.now() + 5_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: stillAt,
          requestId: 100,
          requestAt: at + 1_000,
          isDraft: false,
        }),
      ),
    },
    { clock: () => stillAt + 10 },
  );
  await assert.rejects(
    abandonWorkflowAction(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
    ),
    (error) => error.code === "WORKFLOW_ACTION_NOT_ABANDONABLE",
  );
});

test("stale evidence cannot abandon an action either", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: true,
    },
  );

  // The observation is recorded after the action executes and shows a draft
  // pull request -- but by the time the abandon asks, it has aged out. The
  // projection declines to answer on expired evidence, and so must this.
  const recordedAt = Date.now() + 1_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 3,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: recordedAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => recordedAt + 10 },
  );
  await assert.rejects(
    abandonWorkflowAction(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
      { clock: () => recordedAt + 10 * 60_000 },
    ),
    (error) => error.code === "WORKFLOW_ACTION_NOT_ABANDONABLE",
  );
});

test("a gated head is not pushed onto a pull request reviewers can see", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  // The publication dies with the pull request visible. Its reading is
  // frozen there, so nothing it says can gate the next head -- and the next
  // head is pushed to that same pull request.
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
    (payload) => {
      payload.pull_request.is_draft = false;
      payload.pull_request.reviewed_base_current_base_comparison.status =
        "DIVERGED";
      return payload;
    },
  );
  const paused = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  const resumed = await resumeAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    paused.revision,
    { operatorLabel: "jeremy", rationale: "start a new head" },
  );
  const secondHead = await commit(state.repository, "export const value = 3;\n");
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    resumed.revision,
    secondHead,
  );
  assert.equal(repaired.current_publication, null);

  // Local gate for the new head, then the push. The pre-read is the only
  // evidence left about the pull request, and it says visible.
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: "Close the remote review loop.",
    implementationScope: "Add the publication wait and repair phases.",
    reviewerProvider: "CODEX_TASK",
  });
  const bound = await bindWorkflowReview(
    state.store,
    workflow.workflow_id,
    repaired.revision,
    review.id,
  );
  const taskPlanned = await planCodexTaskDispatch(
    state.store,
    workflow.workflow_id,
    bound.revision,
    review.id,
  );
  const taskExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    taskPlanned.workflow.revision,
    taskPlanned.action.action_id,
  );
  const taskObserved = await recordCodexTaskObservation(
    state.store,
    workflow.workflow_id,
    taskExecuting.revision,
    taskPlanned.action.action_id,
    {
      matchingTaskIds: ["task-two"],
      taskId: "task-two",
      title: taskPlanned.dispatch.title,
      prompt: taskPlanned.dispatch.prompt,
    },
  );
  const dispatched = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    taskObserved.revision,
    taskPlanned.action.action_id,
  );
  await submitInitialReview(state.store, review.id, [], "CODEX_TASK");
  const clean = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    dispatched.revision,
  );
  await finalizeLocalGate(state.store, review.id);
  const gated = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    clean.revision,
  );
  assert.equal(gated.phase, "LOCAL_GATE_PASSED");

  const pushPlanned = await planWorkflowPush(
    state.store,
    workflow.workflow_id,
    gated.revision,
  );
  // The pre-read must answer at all: a push that does not say what the pull
  // request is cannot be the last check before it lands on one.
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      pushPlanned.workflow.revision,
      pushPlanned.action.action_id,
      {
        resolved_repository_id: REPOSITORY_ID,
        resolved_url: pushPlanned.action.target.remote_url,
      },
    ),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
  );
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      pushPlanned.workflow.revision,
      pushPlanned.action.action_id,
      {
        resolved_repository_id: REPOSITORY_ID,
        resolved_url: pushPlanned.action.target.remote_url,
        pull_request_is_draft: false,
      },
    ),
    (error) =>
      error.code === "WORKFLOW_PULL_REQUEST_EXPOSED" &&
      error.details.action_abandoned === pushPlanned.action.action_id,
  );

  // The refusal is not a stop: it hands the workflow to the undo, which
  // needs no publication to run, and the push follows once the pull request
  // is a draft again.
  const ensuring = await getAutonomousWorkflow(state.store, workflow.workflow_id);
  assert.equal(ensuring.phase, "ENSURE_DRAFT_FOR_REPAIR");
  const undo = await planReturnToDraft(
    state.store,
    workflow.workflow_id,
    ensuring.revision,
  );
  assert.equal(undo.action.target.review_id, null);
  // The pull request still carries the first head -- the push that would
  // have moved it is the one just refused -- so a pre-read that reported the
  // workflow's current head would be a lie. This action does not ask for
  // one: it changes what the pull request is, not what it points at.
  const undoExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    undo.workflow.revision,
    undo.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      is_draft: false,
    },
  );
  const undoObserved = await recordReturnToDraftObservation(
    state.store,
    workflow.workflow_id,
    undoExecuting.revision,
    undo.action.action_id,
    {
      outcome: "RETURNED_TO_DRAFT",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      isDraft: true,
    },
  );
  const restored = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    undoObserved.revision,
    undo.action.action_id,
  );
  assert.equal(restored.phase, "LOCAL_GATE_PASSED");

  const replanned = await planWorkflowPush(
    state.store,
    workflow.workflow_id,
    restored.revision,
  );
  const pushing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    replanned.workflow.revision,
    replanned.action.action_id,
    {
      resolved_repository_id: REPOSITORY_ID,
      resolved_url: replanned.action.target.remote_url,
      pull_request_is_draft: true,
    },
  );
  assert.equal(pushing.active_action.status, "EXECUTING");
});

/* ---------------------------------------------------------------------------
 * RFC 0003 item 3: the autonomous_terminal projection and the terminal record.
 * ------------------------------------------------------------------------- */

/** A complete post-ready (non-draft) observation. */
function readyObservation(state, headSha, options) {
  return draftObservation(state, headSha, { ...options, isDraft: false });
}

/** Walk a workflow through mark-ready into POST_READY. */
async function reachPostReady(t, { startedAtOffset = 0 } = {}) {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now() + startedAtOffset;
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(preReady.phase, "PRE_READY");
  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  const clearance = await getAutonomousPreReady(state.store, reviewId);
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: headSha,
      is_draft: true,
    },
  );
  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
    {
      outcome: "MARKED_READY",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha,
      isDraft: false,
    },
  );
  const ready = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );
  assert.equal(ready.phase, "POST_READY");
  return { state, workflow: ready, reviewId, headSha, at, clearanceRevision: clearance.revision };
}

function publicationFilePath(state, reviewId) {
  return path.join(state.store, "reviews", reviewId, "publication.json");
}

async function editPublication(state, reviewId, mutate) {
  const filePath = publicationFilePath(state, reviewId);
  const ledger = JSON.parse(await fsp.readFile(filePath, "utf8"));
  mutate(ledger);
  await atomicWriteCanonicalJson(filePath, ledger);
}

function codexActor() {
  return { id: CODEX_ACTOR_ID, type: "Bot", login: "chatgpt-codex-connector[bot]" };
}

/** A resolved Codex-rooted thread whose root review examined the gated head. */
function resolvedThread(headSha, { threadId = "PRRT_1", comments = null } = {}) {
  const codex = codexActor();
  const at = Date.now();
  const root = {
    id: "PRRC_1",
    database_id: 900,
    created_at: iso(at - 5_000),
    updated_at: iso(at - 5_000),
    actor: codex,
    review: {
      id: "PRR_1",
      database_id: 101,
      state: "COMMENTED",
      reviewed_head_sha: headSha,
      actor: codex,
    },
  };
  const all = comments ?? [root];
  return {
    id: threadId,
    is_resolved: true,
    is_outdated: false,
    path: null,
    line: null,
    comment_count: all.length,
    comments_pagination_complete: true,
    provenance_complete: true,
    comments: all,
  };
}

/** A server-owned automatic-resolution record in the stored shape. */
function resolutionRecord({
  number,
  actionId,
  threadId = "PRRT_1",
  watermark,
  headSha,
  recordedRevision,
}) {
  const at = Date.now();
  return {
    number,
    action_id: actionId,
    thread_id: threadId,
    thread_watermark: watermark,
    eligibility_sha256: digest(`eligibility-${actionId}`),
    head_sha: headSha,
    actor: { id: 555, type: "User" },
    reply_comment_id: 901,
    pre_read: { observed_at: iso(at - 3_000), is_resolved: false },
    post_read: {
      observed_at: iso(at - 2_000),
      is_resolved: true,
      resolved_by: { id: 555, type: "User" },
    },
    recorded_at: iso(at - 1_000),
    recorded_revision: recordedRevision,
  };
}

function invalidatedEvent({ number, threadId = "PRRT_1", recordId, priorWatermark, newWatermark }) {
  return {
    kind: "INVALIDATED",
    number,
    thread_id: threadId,
    record_id: recordId,
    prior_watermark: priorWatermark,
    new_watermark: newWatermark,
    follow_up_comments: [],
    reason: "pinned codex feedback",
    at: iso(Date.now()),
  };
}

function unresolveEvent({ number, threadId = "PRRT_1", recordId }) {
  return {
    kind: "UNRESOLVED_FOR_REPAIR",
    number,
    thread_id: threadId,
    record_id: recordId,
    action_id: `unresolve-${recordId}`,
    at: iso(Date.now()),
  };
}

function supersedeEvent({ number, threadId = "PRRT_1", predecessorId, successorId, invalidationEvent, unresolveEvent }) {
  return {
    kind: "SUPERSEDES",
    number,
    thread_id: threadId,
    predecessor_id: predecessorId,
    successor_id: successorId,
    invalidation_event: invalidationEvent,
    unresolve_event: unresolveEvent,
    at: iso(Date.now()),
  };
}

test("a newer MERGE_READY revision with one pre-ready source stays POST_READY", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const readyAt = Date.parse(workflow.ready_marks[0].recorded_at);
  const observedAt = readyAt + 2_000;
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  const staleStatusSource = payload.required_checks.collection.run_sources.find(
    (source) => source.kind === "COMMIT_STATUS",
  );
  staleStatusSource.collected_at = iso(readyAt - 1);

  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  assert.equal(recorded.revision, clearanceRevision + 1);
  const persisted = await getPublication(state.store, reviewId);
  assert.ok(Date.parse(persisted.latest_observation.observed_at) > readyAt);
  assert.ok(Date.parse(persisted.latest_observation.recorded_at) > readyAt);
  const projection = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(projection.status, "MERGE_READY");
  assert.equal(projection.oldest_collection_at, iso(readyAt - 1));

  const refused = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(refused.status, "ACTIVE");
  assert.equal(refused.phase, "POST_READY");
  assert.equal(refused.terminal, null);
  assert.equal(refused.revision, workflow.revision);
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "RECORD_FRESH_OBSERVATION_AND_ADVANCE",
  );
});

test("post-ready freshness is strict at the ready-mark timestamp boundary", async (t) => {
  const cases = [
    { label: "equal is rejected", oldestOffset: 0, terminalizes: false },
    { label: "+1ms is accepted", oldestOffset: 1, terminalizes: true },
  ];
  let ran = 0;

  for (const item of cases) {
    await t.test(item.label, async (t) => {
      ran += 1;
      const { state, workflow, reviewId, headSha, at, clearanceRevision } =
        await reachPostReady(t);
      const readyAt = Date.parse(workflow.ready_marks[0].recorded_at);
      // BASE_BRANCH_METADATA is the fixture's oldest collection source.
      const observedAt = readyAt + 900 + item.oldestOffset;
      const payload = readyObservation(state, headSha, {
        at: observedAt,
        requestId: 100,
        requestAt: at + 1_000,
      });
      if (item.terminalizes) {
        failingCheck(payload);
        payload.required_checks.runs[0].conclusion = "SUCCESS";
        payload.required_checks.runs[0].started_at = iso(readyAt - 10_000);
        payload.required_checks.runs[0].completed_at = iso(readyAt - 9_000);
      }
      await recordGithubSnapshot(
        state.store,
        reviewId,
        { expectedRevision: clearanceRevision, observation: payload },
        { clock: () => observedAt + 10 },
      );
      const projection = await getAutonomousTerminal(state.store, reviewId);
      assert.equal(projection.status, "MERGE_READY", item.label);
      assert.equal(
        projection.oldest_collection_at,
        iso(readyAt + item.oldestOffset),
        item.label,
      );

      const advanced = await advanceRemoteWorkflow(
        state.store,
        workflow.workflow_id,
        workflow.revision,
      );
      assert.equal(
        advanced.status,
        item.terminalizes ? "MERGE_READY" : "ACTIVE",
        item.label,
      );
      assert.equal(advanced.phase, "POST_READY", item.label);
      assert.equal(advanced.terminal == null, !item.terminalizes, item.label);
      assert.equal(
        advanced.revision,
        workflow.revision + (item.terminalizes ? 1 : 0),
        item.label,
      );
    });
  }
  assert.equal(ran, cases.length);
});

test("every canonical observation source family participates in post-ready freshness", async (t) => {
  function source(collection, kind) {
    return [
      ...(collection.sources ?? []),
      ...(collection.policy_sources ?? []),
      ...(collection.run_sources ?? []),
    ].find((entry) => entry.kind === kind);
  }

  const cases = [
    ["pull request", (payload, staleAt) => {
      source(payload.pull_request.collection, "PULL_REQUEST").collected_at = staleAt;
    }],
    ["base metadata", (payload, staleAt) => {
      source(payload.pull_request.collection, "BASE_BRANCH_METADATA").collected_at = staleAt;
    }],
    ["base-head comparison", (payload, staleAt) => {
      source(payload.pull_request.collection, "BASE_HEAD_COMPARISON").collected_at = staleAt;
    }],
    ["reviewed-base comparison", (payload, staleAt) => {
      source(
        payload.pull_request.collection,
        "REVIEWED_BASE_CURRENT_BASE_COMPARISON",
      ).collected_at = staleAt;
    }],
    ["required-check policy", (payload, staleAt) => {
      source(payload.required_checks.collection, "APPLICABLE_RULES").collected_at =
        staleAt;
    }],
    ["required-check run", (payload, staleAt) => {
      source(payload.required_checks.collection, "CHECK_RUN").collected_at = staleAt;
    }],
    ["Codex issue comments", (payload, staleAt) => {
      source(payload.codex_review.collection, "ISSUE_COMMENTS").collected_at = staleAt;
    }],
    ["Codex reviews", (payload, staleAt) => {
      source(payload.codex_review.collection, "PULL_REQUEST_REVIEWS").collected_at =
        staleAt;
    }],
    ["Codex review comments", (payload, staleAt) => {
      source(
        payload.codex_review.collection,
        "PULL_REQUEST_REVIEW_COMMENTS",
      ).collected_at = staleAt;
    }],
    ["review threads", (payload, staleAt) => {
      payload.review_threads.collection.collected_at = staleAt;
      source(
        payload.review_threads.collection,
        "PULL_REQUEST_REVIEW_THREADS",
      ).collected_at = staleAt;
    }],
  ];
  let ran = 0;

  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      ran += 1;
      const { state, workflow, reviewId, headSha, at, clearanceRevision } =
        await reachPostReady(t);
      const readyAt = Date.parse(workflow.ready_marks[0].recorded_at);
      const observedAt = readyAt + 2_000;
      const staleAt = iso(readyAt - 1);
      const payload = readyObservation(state, headSha, {
        at: observedAt,
        requestId: 100,
        requestAt: at + 1_000,
      });
      mutate(payload, staleAt);

      await recordGithubSnapshot(
        state.store,
        reviewId,
        { expectedRevision: clearanceRevision, observation: payload },
        { clock: () => observedAt + 10 },
      );
      const projection = await getAutonomousTerminal(state.store, reviewId);
      assert.equal(projection.status, "MERGE_READY", label);
      assert.equal(projection.oldest_collection_at, staleAt, label);
      const refused = await advanceRemoteWorkflow(
        state.store,
        workflow.workflow_id,
        workflow.revision,
      );
      assert.equal(refused.status, "ACTIVE", label);
      assert.equal(refused.phase, "POST_READY", label);
      assert.equal(refused.terminal, null, label);
      assert.equal(refused.revision, workflow.revision, label);
      assert.equal(
        (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
          .next_action,
        "RECORD_FRESH_OBSERVATION_AND_ADVANCE",
        label,
      );
    });
  }
  assert.equal(ran, cases.length);
});

test("a stale referenced review-thread ancestry comparison stays POST_READY", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const readyAt = Date.parse(workflow.ready_marks.at(-1).recorded_at);
  const observedAt = readyAt + 2_000;
  const staleAt = iso(readyAt - 1);
  const findingHeadSha = "a".repeat(40);
  const thread = resolvedThread(findingHeadSha);
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  payload.review_threads.total_count = 1;
  payload.review_threads.unresolved_count = 0;
  payload.review_threads.threads = [thread];
  payload.review_threads.ancestry = [
    {
      finding_head_sha: findingHeadSha,
      status: "AHEAD",
      descends: true,
      endpoint: `GET /repos/example/review-bridge/compare/${findingHeadSha}...${headSha}`,
      collected_at: staleAt,
    },
  ];

  // Every ordinary collection and source is fresh. Only the comparison used
  // to establish descent for this thread sits on the stale side of ready.
  for (const collection of [
    payload.pull_request.collection,
    payload.required_checks.collection,
    payload.codex_review.collection,
    payload.review_threads.collection,
  ]) {
    for (const collectedAt of [
      collection.collected_at,
      ...(collection.sources ?? []).map((source) => source.collected_at),
      ...(collection.policy_sources ?? []).map((source) => source.collected_at),
      ...(collection.run_sources ?? []).map((source) => source.collected_at),
    ]) {
      assert.ok(Date.parse(collectedAt) > readyAt);
    }
  }

  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [
      resolutionRecord({
        number: 1,
        actionId: "act-ancestry",
        watermark: threadWatermark(thread),
        headSha,
        recordedRevision: recorded.revision,
      }),
    ];
  });

  const projection = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(projection.status, "MERGE_READY");
  assert.equal(projection.oldest_collection_at, staleAt);
  const refused = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(refused.status, "ACTIVE");
  assert.equal(refused.phase, "POST_READY");
  assert.equal(refused.terminal, null);
  assert.equal(refused.revision, workflow.revision);
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "RECORD_FRESH_OBSERVATION_AND_ADVANCE",
  );
});

test("an observation timestamp before its collection is rejected before terminal freshness", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const readyAt = Date.parse(workflow.ready_marks[0].recorded_at);
  const observedAt = readyAt + 2_000;
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  payload.observed_at = iso(readyAt - 1);

  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      reviewId,
      { expectedRevision: clearanceRevision, observation: payload },
      { clock: () => observedAt + 10 },
    ),
    (error) => {
      assert.equal(error.code, "INVALID_INPUT");
      assert.match(
        error.message,
        /observation\.observed_at must not precede a collection/,
      );
      return true;
    },
  );
  assert.equal((await getPublication(state.store, reviewId)).revision, clearanceRevision);
});

test("historical provider event timestamps do not make a fresh post-ready collection stale", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t, { startedAtOffset: -2_000 });
  const readyAt = Date.parse(workflow.ready_marks[0].recorded_at);
  const observedAt = readyAt + 2_000;
  const historicalAt = readyAt - 60_000;
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  failingCheck(payload);
  payload.required_checks.runs[0].conclusion = "SUCCESS";
  payload.required_checks.runs[0].started_at = iso(historicalAt);
  payload.required_checks.runs[0].completed_at = iso(historicalAt + 1_000);

  assert.ok(Date.parse(payload.required_checks.runs[0].completed_at) < readyAt);
  assert.ok(Date.parse(payload.codex_review.requests[0].event_at) < readyAt);
  assert.ok(Date.parse(payload.codex_review.results[0].event_at) < readyAt);
  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  assert.equal(recorded.revision, clearanceRevision + 1);
  const projection = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(projection.status, "MERGE_READY");
  assert.ok(Date.parse(projection.oldest_collection_at) > readyAt);

  const done = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(done.status, "MERGE_READY");
  assert.notEqual(done.terminal, null);
  assert.equal(done.terminal.observation_revision, recorded.revision);
});

test("the terminal projection records MERGE_READY and the workflow stops with a terminal record", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  assert.equal(workflow.status, "ACTIVE");
  assert.equal(workflow.ready_marks.length, 1);
  assert.equal(workflow.ready_marks[0].publication_revision, clearanceRevision);

  // The terminal projection never evaluates the pre-mark-ready observation:
  // it shows a draft pull request, which is not a successful run.
  const before = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(before.status, "PR_DRAFT");
  assert.notEqual(before.blocking_reason, null);
  assert.notEqual(before.blockers.length, 0);

  // Without a fresh post-ready observation the workflow stays stopped: the
  // advance is legal but idle, and spends no revision.
  const idle = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(idle.phase, "POST_READY");
  assert.equal(idle.status, "ACTIVE");
  assert.equal(idle.revision, workflow.revision);
  assert.equal(idle.terminal, null);

  // The controller records one fresh complete observation of the ready pull
  // request, and only then may the run reach its terminal state.
  const observedAt = Date.parse(workflow.ready_marks[0].recorded_at) + 2_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: readyObservation(state, headSha, { at: observedAt, requestId: 100, requestAt: at + 1_000 }) },
    { clock: () => observedAt + 10 },
  );
  const terminal = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(terminal.status, "MERGE_READY");
  assert.ok(
    Date.parse(terminal.oldest_collection_at) >
      Date.parse(workflow.ready_marks[0].recorded_at),
  );
  assert.equal(terminal.blocking_reason, null);
  assert.deepEqual(terminal.blockers, []);
  assert.equal(terminal.observation_revision, clearanceRevision + 1);
  assert.match(terminal.observation_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    terminal.resolution_sha256,
    sha256(canonicalJson({ automatic_resolutions: [], resolution_lifecycle: [] })),
  );
  assert.equal(terminal.ready_exception_sha256, null);
  assert.deepEqual(terminal.human_review_requirements, []);
  assert.equal(terminal.workflow_authorization_sha256, workflow.authorization.workflow_authorization_sha256);

  const done = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(done.status, "MERGE_READY");
  assert.equal(done.phase, "POST_READY");
  assert.equal(done.revision, workflow.revision + 1);
  assert.notEqual(done.terminal, null);
  assert.equal(done.terminal.status, "MERGE_READY");
  assert.equal(done.terminal.workflow_revision, done.revision);
  assert.deepEqual(done.terminal.pull_request, {
    repository_id: REPOSITORY_ID,
    pr_number: PR_NUMBER,
    url: `https://github.com/example/review-bridge/pull/${PR_NUMBER}`,
  });
  assert.equal(done.terminal.head_sha, headSha);
  assert.equal(done.terminal.local_review_id, reviewId);
  assert.equal(done.terminal.publication_id, reviewId);
  assert.equal(done.terminal.observation_revision, clearanceRevision + 1);
  assert.match(done.terminal.observation_sha256, /^[0-9a-f]{64}$/);
  assert.match(done.terminal.publication_authorization_sha256, /^[0-9a-f]{64}$/);
  assert.equal(done.terminal.workflow_authorization_sha256, terminal.workflow_authorization_sha256);
  assert.equal(done.terminal.resolution_sha256, terminal.resolution_sha256);
  assert.equal(done.terminal.ready_exception_sha256, null);
  assert.deepEqual(done.terminal.human_review_requirements, []);
  assert.match(done.terminal.recorded_at, /^[0-9T:.Z-]+$/);

  // The run stops: the summary names the terminal state, and no further
  // advance, pause, or resume is possible. The workflow never called
  // verify_publication_gate -- no gate file exists -- and merging stays the
  // operator's manual act.
  const summary = await getAutonomousWorkflowSummary(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(summary.status, "MERGE_READY");
  assert.equal(summary.next_action, "AWAIT_OPERATOR");
  assert.equal(summary.terminal.status, "MERGE_READY");
  await assert.rejects(
    advanceRemoteWorkflow(state.store, workflow.workflow_id, done.revision),
    (error) => error.code === "WORKFLOW_NOT_ACTIVE",
  );
  await assert.rejects(
    pauseAutonomousWorkflow(state.store, workflow.workflow_id, done.revision, {
      reasonCode: "NO_PROGRESS",
      blockedAction: "WAIT_PUBLICATION",
      evidence: "x",
    }),
    (error) => error.code === "WORKFLOW_NOT_ACTIVE",
  );
  const full = await getAutonomousWorkflow(state.store, workflow.workflow_id);
  assert.equal(full.terminal.status, "MERGE_READY");
  await assert.rejects(
    fsp.access(path.join(state.store, "reviews", reviewId, "publication-gate.json")),
    (error) => error.code === "ENOENT",
  );
  // The manual merge path stays readable: the binding reader accepts the
  // terminal workflow, so finalization and verification can still run later.
  const reread = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(reread.status, "READY_TO_MARK");
});

test("a repair publication reuses workflow-owned resolution proof from its ancestor", async (t) => {
  const {
    state,
    currentPublication,
    currentRecordedReady,
    currentReadyAt,
  } = await reachRepairAncestorProof(t);

  // Design A: both shared consumers should recover the historical proof. The
  // pre-Design-A implementation instead reports THREAD_RESOLUTION_RECORD_MISSING
  // because it inspects only this publication's empty record arrays.
  const terminal = await getAutonomousTerminal(
    state.store,
    currentPublication.reviewId,
  );
  const summary = await getPublicationSummary(
    state.store,
    currentPublication.reviewId,
  );
  let manualGate = { ok: true, code: null, blockingReason: null };
  try {
    await finalizePublicationGate(
      state.store,
      currentPublication.reviewId,
      { expectedRevision: currentRecordedReady.revision },
      { clock: () => currentReadyAt + 20 },
    );
  } catch (error) {
    manualGate = {
      ok: false,
      code: error.code,
      blockingReason: error.details?.blocking_reason ?? null,
    };
  }
  assert.deepEqual(
    {
      terminal: {
        status: terminal.status,
        blockingReason: terminal.blocking_reason,
      },
      summary: {
        status: summary.status,
        blockingReason: summary.blocking_reason,
        nextAction: summary.next_action,
      },
      manualGate,
    },
    {
      terminal: { status: "MERGE_READY", blockingReason: null },
      summary: {
        status: "MERGE_READY",
        blockingReason: null,
        nextAction: "FINALIZE_PUBLICATION_GATE",
      },
      manualGate: { ok: true, code: null, blockingReason: null },
    },
  );
});

/**
 * Drive one workflow through a workflow-owned automatic resolution on an old
 * publication, a check regression that returns the pull request to draft, a
 * repair head, and a descendant publication that observes the same fully
 * provenanced resolved thread without recording any automatic resolution of
 * its own. The descendant is left POST_READY with one fresh ready
 * observation, exactly the state Design A must clear from the historical
 * proof. Returns the objects the shared consumers and the mutation controls
 * need.
 */
async function reachRepairAncestorProof(t, { extraProofs = [] } = {}) {
  // extraProofs: array of { threadId, actionId, source: "old" | "first" }.
  // Each names a second historical resolution proof whose thread is carried
  // by every writer-validated source and current observation; the server-owned
  // source record and workflow outcome that bind the proof are appended after
  // the observations commit.
  const firstProofs = extraProofs.filter((entry) => entry.source === "first");
  const {
    state,
    workflow,
    first,
    second: oldPublication,
    secondHead: oldHead,
    record: addressedFinding,
    repliedObservation,
    resolveAt,
    watermark,
    resolutionPlanned,
    resolutionObserved,
    extraFirstThreads,
  } = await reachObservedThreadResolution(t, {
    ...(firstProofs.length > 0
      ? {
          firstPublicationThreads: ({ firstHead }) =>
            firstProofs.map((entry) =>
              resolvedThread(firstHead, { threadId: entry.threadId }),
            ),
        }
      : {}),
  });
  const firstHead = (
    await getPublication(state.store, first.reviewId)
  ).authorization.head_sha;
  const threadById = new Map(
    extraFirstThreads.map((thread) => [thread.id, thread]),
  );
  const entries = extraProofs.map((spec) => {
    const onFirst = spec.source === "first";
    const sourcePublication = onFirst ? first : oldPublication;
    const sourceHead = onFirst ? firstHead : oldHead;
    // Reuse the exact threads the first publication's writer-validated
    // observation already committed so every watermark stays identical.
    const thread = onFirst
      ? threadById.get(spec.threadId)
      : resolvedThread(firstHead, { threadId: spec.threadId });
    return {
      ...spec,
      sourcePublication,
      sourceHead,
      thread,
      watermark: threadWatermark(thread),
    };
  });
  const sourceExtraThreads = entries
    .filter((entry) => entry.sourcePublication.reviewId === oldPublication.reviewId)
    .map((entry) => entry.thread);
  const currentExtraThreads = entries.map((entry) => entry.thread);
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );

  const thread = structuredClone(
    repliedObservation.review_threads.threads[0],
  );
  thread.is_resolved = true;
  assert.equal(thread.id, "PRRT_1");
  assert.equal(thread.provenance_complete, true);
  assert.equal(thread.comments_pagination_complete, true);
  assert.equal(threadWatermark(thread), watermark);

  const withResolvedThread = (payload, headSha, collectedAt, extraThreads = []) => {
    const threads = [
      structuredClone(thread),
      ...extraThreads.map((entry) => structuredClone(entry)),
    ];
    payload.review_threads.total_count = threads.length;
    payload.review_threads.unresolved_count = 0;
    payload.review_threads.threads = threads;
    payload.review_threads.ancestry = [
      {
        finding_head_sha: addressedFinding.findings_review.reviewed_head_sha,
        status: "AHEAD",
        descends: true,
        endpoint: `GET /repos/example/review-bridge/compare/${addressedFinding.findings_review.reviewed_head_sha}...${headSha}`,
        collected_at: iso(collectedAt),
      },
    ];
    return payload;
  };

  // Persist the server-owned record before completing the action that made
  // the transition. This is the proof the later publication must discover in
  // workflow history instead of requiring a duplicate record of its own.
  const oldBeforeRecord = await getPublication(
    state.store,
    oldPublication.reviewId,
  );
  const oldWithRecord = await recordAutomaticResolution(
    state.store,
    oldPublication.reviewId,
    {
      expectedRevision: oldBeforeRecord.revision,
      workflowId: workflow.workflow_id,
      actionId: resolutionPlanned.action.action_id,
    },
    { clock: () => resolveAt + 3_000 },
  );
  const resolved = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    resolutionObserved.revision,
    resolutionPlanned.action.action_id,
  );
  assert.deepEqual(
    resolved.thread_resolutions.map((entry) => ({
      action_id: entry.action_id,
      thread_id: entry.thread_id,
      outcome: entry.outcome,
      head_sha: entry.head_sha,
      thread_watermark: entry.thread_watermark,
      publication_review_id: entry.publication_review_id,
    })),
    [
      {
        action_id: resolutionPlanned.action.action_id,
        thread_id: "PRRT_1",
        outcome: "RESOLVED",
        head_sha: oldHead,
        thread_watermark: watermark,
        publication_review_id: oldPublication.reviewId,
      },
    ],
  );

  const oldResolvedAt = resolveAt + 20_000;
  const oldResolvedObservation = structuredClone(repliedObservation);
  oldResolvedObservation.observed_at = iso(oldResolvedAt);
  withResolvedThread(oldResolvedObservation, oldHead, oldResolvedAt - 400, sourceExtraThreads);
  const oldResolved = await recordGithubSnapshot(
    state.store,
    oldPublication.reviewId,
    {
      expectedRevision: oldWithRecord.revision,
      observation: oldResolvedObservation,
    },
    { clock: () => oldResolvedAt + 10 },
  );
  const oldPreReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    resolved.revision,
  );
  assert.equal(oldPreReady.phase, "PRE_READY");

  // Expose the old head, then regress a required check. The real workflow
  // must undo the ready state before it may commit and record the repair.
  const oldMark = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    oldPreReady.revision,
  );
  const oldMarkExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    oldMark.workflow.revision,
    oldMark.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: oldHead,
      is_draft: true,
    },
  );
  const oldMarkObserved = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    oldMarkExecuting.revision,
    oldMark.action.action_id,
    {
      outcome: "MARKED_READY",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha: oldHead,
      isDraft: false,
    },
  );
  const oldPostReady = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    oldMarkObserved.revision,
    oldMark.action.action_id,
  );
  assert.equal(oldPostReady.phase, "POST_READY");

  const regressionAt = Math.max(
    Date.parse(oldPostReady.ready_marks.at(-1).recorded_at) + 2_000,
    oldResolvedAt + 5_000,
  );
  const regressionObservation = structuredClone(oldResolvedObservation);
  regressionObservation.observed_at = iso(regressionAt);
  regressionObservation.pull_request.is_draft = false;
  withResolvedThread(regressionObservation, oldHead, regressionAt - 400, sourceExtraThreads);
  const regressed = await recordGithubSnapshot(
    state.store,
    oldPublication.reviewId,
    {
      expectedRevision: oldResolved.revision,
      observation: failingCheck(regressionObservation),
    },
    { clock: () => regressionAt + 10 },
  );
  const ensuringDraft = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    oldPostReady.revision,
  );
  assert.equal(ensuringDraft.phase, "ENSURE_DRAFT_FOR_REPAIR");

  const undo = await planReturnToDraft(
    state.store,
    workflow.workflow_id,
    ensuringDraft.revision,
  );
  const undoExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    undo.workflow.revision,
    undo.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: oldHead,
      is_draft: false,
    },
  );
  const undoObserved = await recordReturnToDraftObservation(
    state.store,
    workflow.workflow_id,
    undoExecuting.revision,
    undo.action.action_id,
    {
      outcome: "RETURNED_TO_DRAFT",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      isDraft: true,
    },
  );
  const restored = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    undoObserved.revision,
    undo.action.action_id,
  );
  assert.equal(restored.phase, "WAIT_PUBLICATION");

  const draftAgainAt = regressionAt + 5_000;
  const draftAgainObservation = structuredClone(regressionObservation);
  draftAgainObservation.observed_at = iso(draftAgainAt);
  draftAgainObservation.pull_request.is_draft = true;
  withResolvedThread(draftAgainObservation, oldHead, draftAgainAt - 400, sourceExtraThreads);
  await recordGithubSnapshot(
    state.store,
    oldPublication.reviewId,
    {
      expectedRevision: regressed.revision,
      observation: draftAgainObservation,
    },
    { clock: () => draftAgainAt + 10 },
  );
  const repairing = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    restored.revision,
  );
  assert.equal(repairing.phase, "ADDRESS_CHECK_FAILURE");

  const repairHead = await commit(
    state.repository,
    "export const value = 4;\n",
  );
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    repairHead,
  );
  assert.equal(repaired.phase, "PREPARE_LOCAL_REVIEW");
  assert.equal(repaired.current_publication, null);

  const currentPublication = await gateAndPublishHead(
    state,
    { workflow_id: workflow.workflow_id, revision: repaired.revision },
    repairHead,
    "three",
  );
  assert.notEqual(currentPublication.reviewId, oldPublication.reviewId);
  const currentAt = draftAgainAt + 5_000;
  const { workflow: currentWait } = await reachRemoteWait(
    state,
    currentPublication.workflow,
    currentPublication.reviewId,
    repairHead,
    currentAt,
    (payload) =>
      withResolvedThread(payload, repairHead, currentAt + 1_600),
  );
  const currentPreReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    currentWait.revision,
  );
  assert.equal(currentPreReady.phase, "PRE_READY");

  const currentMark = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    currentPreReady.revision,
  );
  const currentClearance = await getAutonomousPreReady(
    state.store,
    currentPublication.reviewId,
  );
  assert.equal(currentClearance.status, "READY_TO_MARK");
  const currentMarkExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    currentMark.workflow.revision,
    currentMark.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: repairHead,
      is_draft: true,
    },
  );
  const currentMarkObserved = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    currentMarkExecuting.revision,
    currentMark.action.action_id,
    {
      outcome: "MARKED_READY",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha: repairHead,
      isDraft: false,
    },
  );
  const currentPostReady = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    currentMarkObserved.revision,
    currentMark.action.action_id,
  );
  assert.equal(currentPostReady.phase, "POST_READY");

  const currentReadyAt = Math.max(
    Date.parse(currentPostReady.ready_marks.at(-1).recorded_at) + 2_000,
    currentAt + 10_000,
  );
  const currentRecordedReady = await recordGithubSnapshot(
    state.store,
    currentPublication.reviewId,
    {
      expectedRevision: currentClearance.revision,
      observation: withResolvedThread(
        readyObservation(state, repairHead, {
          at: currentReadyAt,
          requestId: 100,
          requestAt: currentAt + 1_000,
        }),
        repairHead,
        currentReadyAt - 400,
        currentExtraThreads,
      ),
    },
    { clock: () => currentReadyAt + 10 },
  );
  assert.ok(
    Date.parse(
      currentRecordedReady.latest_observation.review_threads.collection
        .collected_at,
    ) > Date.parse(currentPostReady.ready_marks.at(-1).recorded_at),
  );

  // Setup proof: the workflow's attempt lineage connects the historical
  // publication head to this descendant repair head. The historical ledger
  // owns one exact active record; the current ledger owns none, but observes
  // the same fully-provenanced resolved thread at the same watermark.
  const finalWorkflow = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.deepEqual(
    finalWorkflow.attempts.slice(-2).map((attempt) => attempt.head_sha),
    [oldHead, repairHead],
  );
  const historical = await getPublication(
    state.store,
    oldPublication.reviewId,
  );
  assert.deepEqual(
    historical.automatic_resolutions.map((entry) => ({
      number: entry.number,
      action_id: entry.action_id,
      thread_id: entry.thread_id,
      thread_watermark: entry.thread_watermark,
      head_sha: entry.head_sha,
      reply_comment_id: entry.reply_comment_id,
      actor: entry.actor,
      recorded_revision: entry.recorded_revision,
    })),
    [
      {
        number: 1,
        action_id: resolutionPlanned.action.action_id,
        thread_id: "PRRT_1",
        thread_watermark: watermark,
        head_sha: oldHead,
        reply_comment_id: 901,
        actor: { id: 555, type: "User" },
        recorded_revision: oldWithRecord.revision,
      },
    ],
  );
  assert.deepEqual(historical.resolution_lifecycle ?? [], []);

  const current = await getPublication(
    state.store,
    currentPublication.reviewId,
  );
  assert.deepEqual(
    {
      automatic_resolutions: current.automatic_resolutions,
      resolution_lifecycle: current.resolution_lifecycle ?? [],
    },
    { automatic_resolutions: [], resolution_lifecycle: [] },
  );
  const currentThread = current.latest_observation.review_threads.threads[0];
  assert.equal(currentThread.id, "PRRT_1");
  assert.equal(currentThread.is_resolved, true);
  assert.equal(currentThread.provenance_complete, true);
  assert.equal(currentThread.comments_pagination_complete, true);
  assert.deepEqual(currentThread.comments, thread.comments);
  assert.equal(threadWatermark(currentThread), watermark);

  // Each additional proof is bound by the server-owned source record and the
  // workflow outcome only after every source/current observation carrying its
  // thread has been committed by the real recordGithubSnapshot writer above
  // (and after the audit-validating workflow read above). No public API can
  // author a record or outcome for a synthetic action, so this is the only
  // direct write. Assert the persisted observations are exactly the shapes
  // the writer accepted: exact counts, provenance, pagination, and ancestry.
  for (const entry of entries) {
    const sourceLedger = await getPublication(
      state.store,
      entry.sourcePublication.reviewId,
    );
    const persistedSource = await appendHistoricalResolutionProof(state, {
      workflowPath,
      sourceReviewId: entry.sourcePublication.reviewId,
      headSha: entry.sourceHead,
      thread: entry.thread,
      actionId: entry.actionId,
      recordedRevision: sourceLedger.revision,
    });
    const onFirst = entry.sourcePublication.reviewId === first.reviewId;
    assertWriterValidatedReviewThreads(
      persistedSource.latest_observation,
      onFirst ? [entry.threadId] : ["PRRT_1", entry.threadId],
      onFirst ? [] : [firstHead],
    );
  }
  if (entries.length > 0) {
    const persistedCurrent = await getPublication(
      state.store,
      currentPublication.reviewId,
    );
    assertWriterValidatedReviewThreads(
      persistedCurrent.latest_observation,
      ["PRRT_1", ...entries.map((entry) => entry.threadId)],
      [firstHead],
    );
  }

  return {
    state,
    workflow,
    workflowPath,
    oldPublication,
    currentPublication,
    firstPublication: first,
    repairHead,
    oldHead,
    firstHead,
    watermark,
    resolutionPlanned,
    currentRecordedReady,
    currentReadyAt,
    extraProofResults: entries,
  };
}

test("historical resolution proof mutation controls fail closed at every consumer", async (t) => {
  const {
    state,
    workflowPath,
    oldPublication,
    currentPublication,
    currentRecordedReady,
    currentReadyAt,
    watermark,
    oldHead,
    repairHead,
  } = await reachRepairAncestorProof(t);
  const oldPath = publicationFilePath(state, oldPublication.reviewId);
  const currentPath = publicationFilePath(state, currentPublication.reviewId);

  // Sanity: the untouched scenario clears everywhere, so every case below is
  // blocked by its own mutation and not by a broken setup.
  assert.equal(
    (await getAutonomousTerminal(state.store, currentPublication.reviewId))
      .status,
    "MERGE_READY",
  );

  const storedOld = JSON.parse(await fsp.readFile(oldPath, "utf8"));
  const storedCurrent = JSON.parse(await fsp.readFile(currentPath, "utf8"));
  const storedWorkflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const otherHead =
    oldHead === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
  const otherDigest = digest("mismatched historical proof");

  // Each case mutates one persisted field or class and must fail closed at
  // the terminal projection, the summary replay override, and the manual
  // finalization gate. `reason === null` means the mutation makes the binding
  // reader reject the workflow ledger outright.
  const cases = [
    {
      label: "historical publication missing",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      deleteOld: true,
    },
    {
      label: "historical publication substituted by another valid publication",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.authorization.head_sha = otherHead;
      },
    },
    {
      label: "old workflow binding/authorization identity mismatch",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.workflow_authorization_sha256 = otherDigest;
      },
    },
    {
      label: "unrelated PR target on the source publication",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.target.pr_number = PR_NUMBER + 1;
      },
    },
    {
      label: "old action mismatch",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.automatic_resolutions[0].action_id = "act-substitute";
      },
    },
    {
      label: "old thread mismatch",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.automatic_resolutions[0].thread_id = "PRRT_OTHER";
      },
    },
    {
      label: "old watermark mismatch",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.automatic_resolutions[0].thread_watermark = otherDigest;
      },
    },
    {
      label: "named historical record absent",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.automatic_resolutions = [];
      },
    },
    {
      label: "old lifecycle invalidated",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.resolution_lifecycle = [
          invalidatedEvent({
            number: 1,
            recordId: old.automatic_resolutions[0].action_id,
            priorWatermark: old.automatic_resolutions[0].thread_watermark,
            newWatermark: otherDigest,
          }),
        ];
      },
    },
    {
      label: "old lifecycle unresolved for repair",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.resolution_lifecycle = [
          unresolveEvent({
            number: 1,
            recordId: old.automatic_resolutions[0].action_id,
          }),
        ];
      },
    },
    {
      label: "old lifecycle orphaned",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        old.automatic_resolutions = [];
        old.resolution_lifecycle = [
          invalidatedEvent({
            number: 1,
            recordId: "act-ghost",
            priorWatermark: old.automatic_resolutions[0]?.thread_watermark ?? watermark,
            newWatermark: otherDigest,
          }),
        ];
      },
    },
    {
      label: "old record supersession evidence",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      // Retiring the outcome record by a supersession is inherently
      // unreplayable at the same source head: the frontier requires the
      // successor to prove a new head while the active record must match the
      // source observation's head, so any attempt leaves the outcome thread
      // without an active record and the proof blocked.
      apply(old) {
        const retired = old.automatic_resolutions[0];
        const successor = structuredClone(retired);
        successor.number = 2;
        successor.action_id = "act-successor";
        successor.thread_watermark = otherDigest;
        old.automatic_resolutions = [retired, successor];
        old.resolution_lifecycle = [
          invalidatedEvent({
            number: 1,
            recordId: retired.action_id,
            priorWatermark: retired.thread_watermark,
            newWatermark: otherDigest,
          }),
          unresolveEvent({ number: 2, recordId: retired.action_id }),
          supersedeEvent({
            number: 3,
            predecessorId: retired.action_id,
            successorId: "act-successor",
            invalidationEvent: 1,
            unresolveEvent: 2,
          }),
        ];
      },
    },
    {
      label: "old lifecycle chain broken",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(old) {
        const retired = old.automatic_resolutions[0];
        old.resolution_lifecycle = [
          invalidatedEvent({
            number: 1,
            recordId: retired.action_id,
            priorWatermark: retired.thread_watermark,
            newWatermark: otherDigest,
          }),
          unresolveEvent({ number: 2, recordId: retired.action_id }),
          supersedeEvent({
            number: 3,
            predecessorId: retired.action_id,
            successorId: "act-missing",
            invalidationEvent: 1,
            unresolveEvent: 2,
          }),
        ];
      },
    },
    {
      label: "current thread unresolved",
      reason: "UNRESOLVED_REVIEW_THREADS",
      apply(_old, current) {
        current.latest_observation.review_threads.unresolved_count = 1;
        current.latest_observation.review_threads.threads[0].is_resolved =
          false;
      },
    },
    {
      label: "current thread provenance incomplete",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, current) {
        current.latest_observation.review_threads.threads[0]
          .provenance_complete = false;
      },
    },
    {
      label: "current thread watermark changed",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, current) {
        const thread =
          current.latest_observation.review_threads.threads[0];
        thread.comments.push({
          id: "PRRC_WM",
          database_id: 903,
          created_at: iso(currentReadyAt - 300),
          updated_at: iso(currentReadyAt - 300),
          actor: codexActor(),
          review: null,
        });
        thread.comment_count = thread.comments.length;
      },
    },
    {
      label: "current foreign participation",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, current) {
        const thread =
          current.latest_observation.review_threads.threads[0];
        thread.comments.push({
          id: "PRRC_FOREIGN",
          database_id: 904,
          created_at: iso(currentReadyAt - 300),
          updated_at: iso(currentReadyAt - 300),
          actor: { id: 777, type: "User", login: "foreign" },
          review: null,
        });
        thread.comment_count = thread.comments.length;
      },
    },
    {
      label: "old head absent from the attempt lineage",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, _current, workflow) {
        workflow.attempts = workflow.attempts
          .filter((attempt) => attempt.head_sha !== oldHead)
          .map((attempt, index) => ({ ...attempt, number: index + 1 }));
      },
    },
    {
      label: "current head absent from the attempt lineage",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, _current, workflow) {
        workflow.attempts = workflow.attempts
          .filter((attempt) => attempt.head_sha !== repairHead)
          .map((attempt, index) => ({ ...attempt, number: index + 1 }));
      },
    },
    {
      label: "duplicate head in the attempt lineage",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, _current, workflow) {
        const duplicate = structuredClone(
          workflow.attempts.find((attempt) => attempt.head_sha === oldHead),
        );
        workflow.attempts.push(duplicate);
        workflow.attempts = workflow.attempts.map((attempt, index) => ({
          ...attempt,
          number: index + 1,
        }));
      },
    },
    {
      label: "reversed attempt lineage",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, _current, workflow) {
        const swapped = workflow.attempts.map((attempt) => ({
          ...attempt,
          head_sha:
            attempt.head_sha === oldHead
              ? repairHead
              : attempt.head_sha === repairHead
                ? oldHead
                : attempt.head_sha,
        }));
        workflow.attempts = swapped;
      },
    },
    {
      label: "malformed attempt lineage",
      reason: null,
      apply(_old, _current, workflow) {
        workflow.attempts[workflow.attempts.length - 1].head_sha =
          "not-a-sha";
      },
    },
    {
      label: "unrelated workflow outcome head",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, _current, workflow) {
        workflow.thread_resolutions[0].head_sha = otherHead;
      },
    },
    {
      label: "unrelated workflow outcome thread",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, _current, workflow) {
        workflow.thread_resolutions[0].thread_id = "PRRT_OTHER";
      },
    },
    {
      label: "unrelated workflow outcome watermark",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, _current, workflow) {
        workflow.thread_resolutions[0].thread_watermark = otherDigest;
      },
    },
    {
      label: "workflow outcome no longer names a different publication",
      reason: "THREAD_RESOLUTION_RECORD_MISSING",
      apply(_old, _current, workflow) {
        workflow.thread_resolutions[0].publication_review_id =
          currentPublication.reviewId;
      },
    },
  ];

  for (const { label, reason, deleteOld = false, apply } of cases) {
    const old = structuredClone(storedOld);
    const current = structuredClone(storedCurrent);
    const workflow = structuredClone(storedWorkflow);
    if (apply != null) {
      apply(old, current, workflow);
    }
    if (deleteOld) {
      await fsp.rm(oldPath);
    } else {
      await atomicWriteCanonicalJson(oldPath, old);
    }
    await atomicWriteCanonicalJson(currentPath, current);
    await atomicWriteCanonicalJson(workflowPath, workflow);
    try {
      if (reason === null) {
        await assert.rejects(
          getAutonomousTerminal(state.store, currentPublication.reviewId),
          (error) => error.code === "WORKFLOW_STATE_INVALID",
          `${label}: terminal projection`,
        );
        await assert.rejects(
          getPublicationSummary(state.store, currentPublication.reviewId),
          (error) => error.code === "WORKFLOW_STATE_INVALID",
          `${label}: summary`,
        );
        await assert.rejects(
          finalizePublicationGate(
            state.store,
            currentPublication.reviewId,
            { expectedRevision: currentRecordedReady.revision },
            { clock: () => currentReadyAt + 20 },
          ),
          (error) => error.code === "WORKFLOW_STATE_INVALID",
          `${label}: manual gate`,
        );
      } else {
        const terminal = await getAutonomousTerminal(
          state.store,
          currentPublication.reviewId,
        );
        assert.equal(terminal.status, "CHANGES_REQUIRED", label);
        assert.equal(terminal.blocking_reason, reason, label);
        const summary = await getPublicationSummary(
          state.store,
          currentPublication.reviewId,
        );
        assert.equal(summary.status, "CHANGES_REQUIRED", label);
        assert.equal(summary.blocking_reason, reason, label);
        assert.notEqual(
          summary.next_action,
          "FINALIZE_PUBLICATION_GATE",
          label,
        );
        await assert.rejects(
          finalizePublicationGate(
            state.store,
            currentPublication.reviewId,
            { expectedRevision: currentRecordedReady.revision },
            { clock: () => currentReadyAt + 20 },
          ),
          (error) => error.code === "PUBLICATION_NOT_READY",
          `${label}: manual gate`,
        );
      }
    } finally {
      await atomicWriteCanonicalJson(oldPath, storedOld);
      await atomicWriteCanonicalJson(currentPath, storedCurrent);
      await atomicWriteCanonicalJson(workflowPath, storedWorkflow);
    }
  }
});

test("post-gate historical proof substitution causes GATE_MISMATCH", async (t) => {
  const {
    state,
    workflowPath,
    oldPublication,
    currentPublication,
    currentRecordedReady,
    currentReadyAt,
  } = await reachRepairAncestorProof(t);
  const oldPath = publicationFilePath(state, oldPublication.reviewId);

  // The gate is minted over the historical proof; the effective digest binds
  // the current resolution set plus the sorted historical references.
  await finalizePublicationGate(
    state.store,
    currentPublication.reviewId,
    { expectedRevision: currentRecordedReady.revision },
    { clock: () => currentReadyAt + 20 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, currentPublication.reviewId, {
      clock: () => currentReadyAt + 30,
    })).valid,
    true,
  );

  const storedOld = JSON.parse(await fsp.readFile(oldPath, "utf8"));
  const storedWorkflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const substitutions = [
    {
      label: "source active record digest substitution",
      replayClean: true,
      apply(old) {
        old.automatic_resolutions[0].eligibility_sha256 = digest(
          "eligibility-substitute",
        );
      },
    },
    {
      label: "source lifecycle evidence substitution",
      replayClean: true,
      apply(old) {
        old.resolution_lifecycle = [
          invalidatedEvent({
            number: 1,
            threadId: "PRRT_OTHER",
            recordId: "act-ghost",
            priorWatermark: digest("prior-other"),
            newWatermark: digest("moved-other"),
          }),
        ];
      },
    },
    {
      label: "source publication revision substitution",
      // A bare revision bump leaves the source ledger structurally invalid
      // (the history cursor must end at exactly the revision it claims, and
      // its updated_at must match), so the source cannot even be read back
      // under its lock. The replay itself fails closed before any gate
      // comparison: the thread keeps the recordless blocker, and verification
      // still names GATE_MISMATCH.
      replayClean: false,
      apply(old) {
        old.revision += 1;
        old.updated_at = new Date(
          Date.parse(old.updated_at) + 1_000,
        ).toISOString();
      },
    },
    {
      label: "workflow outcome head substitution",
      replayClean: false,
      apply(_old, workflow) {
        workflow.thread_resolutions[0].head_sha =
          workflow.thread_resolutions[0].head_sha === "f".repeat(40)
            ? "e".repeat(40)
            : "f".repeat(40);
      },
    },
  ];

  for (const { label, replayClean, apply } of substitutions) {
    const old = structuredClone(storedOld);
    const workflow = structuredClone(storedWorkflow);
    apply(old, workflow);
    await atomicWriteCanonicalJson(oldPath, old);
    await atomicWriteCanonicalJson(workflowPath, workflow);
    try {
      const terminal = await getAutonomousTerminal(
        state.store,
        currentPublication.reviewId,
      );
      if (replayClean) {
        // The substitution leaves the replay untouched: the resolution proof
        // still qualifies, so the projection stays MERGE_READY and the gate is
        // reached. The gate was minted over the effective digest that binds
        // the sorted historical references, so the substituted evidence fails
        // verification below with GATE_MISMATCH.
        assert.equal(terminal.status, "MERGE_READY", label);
      } else {
        // The substitution breaks the replay itself, so the terminal must
        // name the exact recordless blocker before the gate is ever
        // compared; verification then still fails with GATE_MISMATCH.
        assert.equal(terminal.status, "CHANGES_REQUIRED", label);
        assert.equal(
          terminal.blocking_reason,
          "THREAD_RESOLUTION_RECORD_MISSING",
          label,
        );
      }
      const rejected = await verifyPublicationGate(
        state.store,
        currentPublication.reviewId,
        { clock: () => currentReadyAt + 40 },
      );
      assert.equal(rejected.valid, false, label);
      assert.equal(rejected.reason, "GATE_MISMATCH", label);
    } finally {
      await atomicWriteCanonicalJson(oldPath, storedOld);
      await atomicWriteCanonicalJson(workflowPath, storedWorkflow);
    }
  }
});

test("historical proof source lock contention propagates retryable PUBLICATION_BUSY", async (t) => {
  const { state, oldPublication, currentPublication } =
    await reachRepairAncestorProof(t);
  const release = await acquireStateLock({
    directory: path.join(state.store, "reviews", oldPublication.reviewId),
    reviewId: oldPublication.reviewId,
    domain: "publication",
  });
  try {
    // The terminal projection holds the current publication lock and then
    // needs the ancestor publication lock. A locked source must propagate
    // retryable PUBLICATION_BUSY -- never read through it, and never degrade
    // to a missing-record verdict the driver would misread as evidence.
    await assert.rejects(
      getAutonomousTerminal(state.store, currentPublication.reviewId),
      (error) =>
        error.code === "PUBLICATION_BUSY" &&
        error.details?.retryable === true,
    );
  } finally {
    await release();
  }
});

async function reachCompletedPreResolvedPostReady(t) {
  const {
    state,
    workflow,
    second,
    secondHead,
    workflowPath,
    repliedObservation,
    resolveAt,
    resolutionPlanned,
    resolutionObserved,
  } = await reachObservedThreadResolution(t, {
    outcome: "OBSERVED_PRE_RESOLVED",
  });

  const resolved = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    resolutionObserved.revision,
    resolutionPlanned.action.action_id,
  );
  assert.equal(resolved.thread_resolutions.length, 1);
  assert.equal(
    resolved.thread_resolutions[0].outcome,
    "OBSERVED_PRE_RESOLVED",
  );
  assert.equal(
    (await getPublication(state.store, second.reviewId)).automatic_resolutions
      .length,
    0,
  );

  const resolvedAt = resolveAt + 20_000;
  const resolvedObservation = structuredClone(repliedObservation);
  resolvedObservation.observed_at = iso(resolvedAt);
  resolvedObservation.review_threads.unresolved_count = 0;
  resolvedObservation.review_threads.threads[0].is_resolved = true;
  const beforeResolvedSnapshot = await getPublication(
    state.store,
    second.reviewId,
  );
  const recordedResolved = await recordGithubSnapshot(
    state.store,
    second.reviewId,
    {
      expectedRevision: beforeResolvedSnapshot.revision,
      observation: resolvedObservation,
    },
    { clock: () => resolvedAt + 10 },
  );
  const preReady = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    resolved.revision,
  );
  assert.equal(preReady.phase, "PRE_READY");

  const planned = await planMarkPullRequestReady(
    state.store,
    workflow.workflow_id,
    preReady.revision,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      base_branch: "main",
      head_branch: TOPIC_BRANCH,
      head_sha: secondHead,
      is_draft: true,
    },
  );
  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    planned.action.action_id,
    {
      outcome: "MARKED_READY",
      repositoryId: REPOSITORY_ID,
      prNumber: PR_NUMBER,
      baseBranch: "main",
      headBranch: TOPIC_BRANCH,
      headSha: secondHead,
      isDraft: false,
    },
  );
  const postReady = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    planned.action.action_id,
  );
  assert.equal(postReady.phase, "POST_READY");

  const postReadyAt = resolvedAt + 10_000;
  const postReadyObservation = structuredClone(resolvedObservation);
  postReadyObservation.observed_at = iso(postReadyAt);
  postReadyObservation.pull_request.is_draft = false;
  const recordedPostReady = await recordGithubSnapshot(
    state.store,
    second.reviewId,
    {
      expectedRevision: recordedResolved.revision,
      observation: postReadyObservation,
    },
    { clock: () => postReadyAt + 10 },
  );

  return {
    state,
    workflow,
    second,
    secondHead,
    workflowPath,
    resolvedObservation,
    recordedPostReady,
    postReadyAt,
  };
}

async function assertPreResolvedTerminalAndGateBlocked(
  state,
  reviewId,
  expectedRevision,
  expectedReason,
  label,
  clockAt,
) {
  const terminal = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(terminal.status, "CHANGES_REQUIRED", label);
  assert.equal(terminal.blocking_reason, expectedReason, label);
  assert.deepEqual(
    terminal.blockers,
    [`thread_resolution:${expectedReason}:PRRT_1`],
    label,
  );
  const summary = await getPublicationSummary(state.store, reviewId);
  assert.equal(summary.status, "CHANGES_REQUIRED", label);
  assert.equal(summary.blocking_reason, expectedReason, label);
  assert.notEqual(summary.next_action, "FINALIZE_PUBLICATION_GATE", label);
  await assert.rejects(
    finalizePublicationGate(
      state.store,
      reviewId,
      { expectedRevision },
      { clock: () => clockAt },
    ),
    (error) => error.code === "PUBLICATION_NOT_READY",
    label,
  );
}

test("a completed pre-resolved workflow action satisfies terminal replay without an automatic-resolution record", async (t) => {
  const { state, second, recordedPostReady, postReadyAt } =
    await reachCompletedPreResolvedPostReady(t);

  const terminal = await getAutonomousTerminal(state.store, second.reviewId);
  let gateError = null;
  try {
    await finalizePublicationGate(
      state.store,
      second.reviewId,
      {
        expectedRevision: recordedPostReady.revision,
      },
      { clock: () => postReadyAt + 20 },
    );
  } catch (error) {
    gateError = error.code;
  }
  assert.deepEqual(
    {
      status: terminal.status,
      blockingReason: terminal.blocking_reason,
      gateError,
    },
    { status: "MERGE_READY", blockingReason: null, gateError: null },
  );
});

test("pre-resolved negative controls reject every mismatched workflow outcome binding", async (t) => {
  const { state, second, workflowPath, recordedPostReady, postReadyAt } =
    await reachCompletedPreResolvedPostReady(t);
  const storedWorkflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const otherHead =
    storedWorkflow.thread_resolutions[0].head_sha === "f".repeat(40)
      ? "e".repeat(40)
      : "f".repeat(40);
  const mismatches = [
    ["outcome", (record) => (record.outcome = "RESOLVED")],
    ["thread_id", (record) => (record.thread_id = "PRRT_OTHER")],
    [
      "publication_review_id",
      (record) =>
        (record.publication_review_id = `${record.publication_review_id}-other`),
    ],
    ["head_sha", (record) => (record.head_sha = otherHead)],
    [
      "thread_watermark",
      (record) =>
        (record.thread_watermark = digest("mismatched pre-resolved watermark")),
    ],
  ];

  for (const [field, mutate] of mismatches) {
    const tampered = structuredClone(storedWorkflow);
    mutate(tampered.thread_resolutions[0]);
    await atomicWriteCanonicalJson(workflowPath, tampered);
    try {
      await assertPreResolvedTerminalAndGateBlocked(
        state,
        second.reviewId,
        recordedPostReady.revision,
        "THREAD_RESOLUTION_RECORD_MISSING",
        `mismatched ${field}`,
        postReadyAt + 20,
      );
    } finally {
      await atomicWriteCanonicalJson(workflowPath, storedWorkflow);
    }
  }
});

test("pre-resolved negative controls fail closed on incomplete provenance and foreign participation", async (t) => {
  const { state, second, workflowPath, recordedPostReady, postReadyAt } =
    await reachCompletedPreResolvedPostReady(t);
  const publicationPath = publicationFilePath(state, second.reviewId);
  const storedWorkflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const storedPublication = JSON.parse(
    await fsp.readFile(publicationPath, "utf8"),
  );
  const cases = [
    {
      label: "incomplete current thread provenance",
      expectedReason: "THREAD_RESOLUTION_RECORD_MISSING",
      mutate(_workflow, publication) {
        publication.latest_observation.review_threads.threads[0].provenance_complete =
          false;
      },
    },
    {
      label: "foreign participation on an otherwise matching outcome",
      expectedReason: "THREAD_RESOLUTION_UNSAFE",
      mutate(workflow, publication) {
        const thread =
          publication.latest_observation.review_threads.threads[0];
        thread.comments.push({
          id: "PRRC_FOREIGN",
          database_id: 902,
          created_at: iso(postReadyAt - 500),
          updated_at: iso(postReadyAt - 500),
          actor: { id: 777, type: "User", login: "foreign" },
          review: null,
        });
        thread.comment_count = thread.comments.length;
        workflow.thread_resolutions[0].thread_watermark =
          threadWatermark(thread);
      },
    },
  ];

  for (const { label, expectedReason, mutate } of cases) {
    const workflow = structuredClone(storedWorkflow);
    const publication = structuredClone(storedPublication);
    mutate(workflow, publication);
    await atomicWriteCanonicalJson(workflowPath, workflow);
    await atomicWriteCanonicalJson(publicationPath, publication);
    try {
      await assertPreResolvedTerminalAndGateBlocked(
        state,
        second.reviewId,
        recordedPostReady.revision,
        expectedReason,
        label,
        postReadyAt + 20,
      );
    } finally {
      await atomicWriteCanonicalJson(workflowPath, storedWorkflow);
      await atomicWriteCanonicalJson(publicationPath, storedPublication);
    }
  }
});

test("pre-resolved negative controls reject invalid projected workflow resolution records", async (t) => {
  const { state, second, workflowPath, recordedPostReady, postReadyAt } =
    await reachCompletedPreResolvedPostReady(t);
  const storedWorkflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const invalidRecords = [
    ["thread_id shape", (record) => (record.thread_id = null)],
    ["outcome shape", (record) => (record.outcome = null)],
    ["action_id shape", (record) => (record.action_id = null)],
    [
      "thread_watermark shape",
      (record) => (record.thread_watermark = "not-a-digest"),
    ],
    ["head_sha shape", (record) => (record.head_sha = "not-a-sha")],
    [
      "publication_review_id shape",
      (record) => (record.publication_review_id = null),
    ],
    ["record number/order", (record) => (record.number = 2)],
    [
      "duplicate thread",
      (_record, workflow) => {
        const duplicate = structuredClone(workflow.thread_resolutions[0]);
        duplicate.number = 2;
        duplicate.action_id = `${duplicate.action_id}-duplicate`;
        workflow.thread_resolutions.push(duplicate);
      },
    ],
  ];

  for (const [label, mutate] of invalidRecords) {
    const tampered = structuredClone(storedWorkflow);
    mutate(tampered.thread_resolutions[0], tampered);
    await atomicWriteCanonicalJson(workflowPath, tampered);
    try {
      for (const [consumer, consume] of [
        [
          "terminal projection",
          () => getAutonomousTerminal(state.store, second.reviewId),
        ],
        [
          "manual gate",
          () =>
            finalizePublicationGate(
              state.store,
              second.reviewId,
              {
                expectedRevision: recordedPostReady.revision,
              },
              { clock: () => postReadyAt + 20 },
            ),
        ],
      ]) {
        await assert.rejects(
          consume(),
          (error) => error.code === "WORKFLOW_STATE_INVALID",
          `${label}: ${consumer}`,
        );
      }
    } finally {
      await atomicWriteCanonicalJson(workflowPath, storedWorkflow);
    }
  }
});

test("a terminal workflow can release its claims after the operator merges", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const readyAt = Date.parse(workflow.ready_marks.at(-1).recorded_at);
  const observedAt = readyAt + 2_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: readyObservation(state, headSha, { at: observedAt, requestId: 100, requestAt: at + 1_000 }) },
    { clock: () => observedAt + 10 },
  );
  const done = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(done.status, "MERGE_READY");
  assert.equal(
    done.claims.every((claim) => claim.disposition === "ACTIVE"),
    true,
  );
  // The operator merged and deleted the branches: the documented
  // reconciliation cleanup must be able to release the claims of a terminal
  // workflow, or the topic branch is owned forever and a later workflow
  // reusing it is rejected.
  const released = await releaseWorkflowClaims(
    state.store,
    workflow.workflow_id,
    done.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "The pull request merged and the topic branch was deleted.",
      reconciledClaims: done.claims
        .filter((claim) => claim.disposition === "ACTIVE")
        .map((claim) => ({
          kind: claim.kind,
          canonical_key_sha256: claim.canonical_key_sha256,
          target: claim.target,
          workflow_revision: done.revision,
          ...(claim.kind === "PULL_REQUEST"
            ? { present: true, open: false }
            : { present: false }),
          observed_at: new Date().toISOString(),
        })),
    },
  );
  assert.equal(released.status, "MERGE_READY");
  assert.equal(
    released.claims.every((claim) => claim.disposition === "RELEASED"),
    true,
  );
  assert.equal(released.claim_release != null, true);
  const reread = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(reread.status, "MERGE_READY");
  assert.equal(
    reread.claims.every((claim) => claim.disposition === "RELEASED"),
    true,
  );
});

test("a post-ready observation that is not MERGE_READY blocks the terminal projection", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const observedAt = at + 2_000;

  // An unresolved thread in the post-ready observation: the terminal
  // projection reports the derived blocker, never a terminal state.
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  payload.review_threads.total_count = 1;
  payload.review_threads.unresolved_count = 1;
  payload.review_threads.threads = [
    { id: "PRRT_HUMAN", is_resolved: false, is_outdated: false, path: null, line: null },
  ];
  const blockedLedger = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  const blocked = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(blocked.status, "CHANGES_REQUIRED");
  assert.equal(blocked.blocking_reason, "UNRESOLVED_REVIEW_THREADS");
  assert.notEqual(blocked.blockers.length, 0);

  // A draft pull request in the post-ready observation is not a success: the
  // terminal projection is the one projection that does not ignore the flag.
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: blockedLedger.revision,
      observation: draftObservation(state, headSha, {
        at: observedAt + 4_000,
        requestId: 100,
        requestAt: at + 1_000,
      }),
    },
    { clock: () => observedAt + 4_010 },
  );
  const draft = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(draft.status, "PR_DRAFT");

  // Expired evidence never mints a terminal record either.
  const stale = await getAutonomousTerminal(state.store, reviewId, {
    clock: () => observedAt + 10 + 6 * 60 * 1000,
  });
  assert.equal(stale.status, "EVIDENCE_STALE");

  const stillStopped = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(stillStopped.phase, "POST_READY");
  assert.equal(stillStopped.terminal, null);
  // The blocked evaluation is recorded on the publication binding, so a
  // controller that follows only next_action stops for the operator instead
  // of re-collecting snapshots forever.
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "AWAIT_OPERATOR",
  );
});

test("a new thread comment between mark-ready and the terminal observation blocks autonomous_terminal", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const observedAt = at + 2_000;
  const thread = resolvedThread(headSha);
  const watermark = threadWatermark(thread);
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  payload.review_threads.total_count = 1;
  payload.review_threads.unresolved_count = 0;
  payload.review_threads.threads = [thread];
  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [
      resolutionRecord({
        number: 1,
        actionId: "act-1",
        watermark,
        headSha,
        recordedRevision: recorded.revision,
      }),
    ];
  });
  const clear = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(clear.status, "MERGE_READY");

  // A comment arrives after mark-ready: the thread watermark moves, so the
  // active record no longer matches and the terminal projection fails closed
  // even though the publication status is still MERGE_READY.
  const codex = codexActor();
  const movedThread = resolvedThread(headSha, {
    comments: [
      ...thread.comments,
      {
        id: "PRRC_2",
        database_id: 902,
        created_at: iso(observedAt + 500),
        updated_at: iso(observedAt + 500),
        actor: codex,
        review: null,
      },
    ],
  });
  const movedPayload = readyObservation(state, headSha, {
    at: observedAt + 2_000,
    requestId: 100,
    requestAt: at + 1_000,
  });
  movedPayload.review_threads.total_count = 1;
  movedPayload.review_threads.unresolved_count = 0;
  movedPayload.review_threads.threads = [movedThread];
  await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: recorded.revision, observation: movedPayload },
    { clock: () => observedAt + 2_010 },
  );
  const blocked = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(blocked.status, "CHANGES_REQUIRED");
  assert.equal(blocked.blocking_reason, "THREAD_RESOLUTION_INVALIDATED");
  assert.deepEqual(blocked.blockers, [
    "thread_resolution:THREAD_RESOLUTION_INVALIDATED:PRRT_1",
  ]);
  const stopped = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(stopped.phase, "POST_READY");
  assert.equal(stopped.terminal, null);
});

test("the terminal replay accepts one linear supersession chain and blocks every broken chain", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(
    state,
    workflow,
    headSha,
    "one",
  );
  const at = Date.now();
  const { workflow: waiting } = await reachRemoteWait(
    state,
    atPublication,
    reviewId,
    headSha,
    at,
  );
  // The terminal projection only replays over a derived MERGE_READY, so this
  // test drives the ledger directly: a ready observation with one resolved
  // thread, then records and lifecycle events injected in the stored shape.
  const thread = resolvedThread(headSha);
  const finalWatermark = threadWatermark(thread);
  const payload = readyObservation(state, headSha, {
    at: at + 20_000,
    requestId: 100,
    requestAt: at + 1_000,
  });
  payload.review_threads.total_count = 1;
  payload.review_threads.unresolved_count = 0;
  payload.review_threads.threads = [thread];
  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: 3, observation: payload },
    { clock: () => at + 20_010 },
  );
  const earlierWatermark = digest("earlier watermark");
  const earlierHead = "a".repeat(40);
  const recordOne = resolutionRecord({
    number: 1,
    actionId: "act-1",
    watermark: earlierWatermark,
    headSha: earlierHead,
    recordedRevision: 3,
  });
  const recordTwo = resolutionRecord({
    number: 2,
    actionId: "act-2",
    watermark: finalWatermark,
    headSha,
    recordedRevision: recorded.revision,
  });

  // A valid chain: the predecessor is retired by an invalidation, a
  // compensating unresolve, and a supersession to a successor whose fresh
  // watermark matches the final observation. The superseded predecessor is
  // audit evidence and is never compared against the current watermark.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [recordOne, recordTwo];
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-1",
        priorWatermark: earlierWatermark,
        newWatermark: finalWatermark,
      }),
      unresolveEvent({ number: 2, recordId: "act-1" }),
      supersedeEvent({
        number: 3,
        predecessorId: "act-1",
        successorId: "act-2",
        invalidationEvent: 1,
        unresolveEvent: 2,
      }),
    ];
  });
  const valid = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(valid.status, "MERGE_READY", "a linear supersession chain replays");
  assert.deepEqual(valid.blockers, []);

  await finalizePublicationGate(
    state.store,
    reviewId,
    { expectedRevision: recorded.revision },
    { clock: () => at + 20_020 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, reviewId, {
      clock: () => at + 20_030,
    })).valid,
    true,
  );
  await editPublication(state, reviewId, (ledger) => {
    ledger.resolution_lifecycle[0].reason = "same replay, different evidence";
  });
  const lifecycleSubstitution = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(lifecycleSubstitution.status, "MERGE_READY");
  assert.deepEqual(lifecycleSubstitution.blockers, []);
  const lifecycleRejected = await verifyPublicationGate(state.store, reviewId, {
    clock: () => at + 20_040,
  });
  assert.equal(lifecycleRejected.valid, false);
  assert.equal(lifecycleRejected.reason, "GATE_MISMATCH");

  // Missing unresolve: the supersession cannot be replayed without the
  // compensating unresolve its own binding names.
  await editPublication(state, reviewId, (ledger) => {
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-1",
        priorWatermark: earlierWatermark,
        newWatermark: finalWatermark,
      }),
      unresolveEvent({ number: 2, recordId: "act-1" }),
      supersedeEvent({
        number: 3,
        predecessorId: "act-1",
        successorId: "act-2",
        invalidationEvent: 1,
        unresolveEvent: 99,
      }),
    ];
  });
  const missingUnresolve = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(missingUnresolve.blocking_reason, "THREAD_RESOLUTION_CHAIN_BROKEN");

  // A fork: one predecessor to two successors is not a chain.
  const recordThree = resolutionRecord({
    number: 3,
    actionId: "act-3",
    threadId: "PRRT_1",
    watermark: digest("third watermark"),
    headSha: "b".repeat(40),
    recordedRevision: recorded.revision + 1,
  });
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [recordOne, recordTwo, recordThree];
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-1",
        priorWatermark: earlierWatermark,
        newWatermark: finalWatermark,
      }),
      unresolveEvent({ number: 2, recordId: "act-1" }),
      supersedeEvent({
        number: 3,
        predecessorId: "act-1",
        successorId: "act-2",
        invalidationEvent: 1,
        unresolveEvent: 2,
      }),
      supersedeEvent({
        number: 4,
        predecessorId: "act-1",
        successorId: "act-3",
        invalidationEvent: 1,
        unresolveEvent: 2,
      }),
    ];
  });
  const fork = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(fork.blocking_reason, "THREAD_RESOLUTION_CHAIN_BROKEN");

  // A cycle: the successor map is injective but nothing has a head, so no
  // single chain covers the records.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [recordOne, recordTwo];
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-1",
        priorWatermark: earlierWatermark,
        newWatermark: finalWatermark,
      }),
      unresolveEvent({ number: 2, recordId: "act-1" }),
      supersedeEvent({
        number: 3,
        predecessorId: "act-1",
        successorId: "act-2",
        invalidationEvent: 1,
        unresolveEvent: 2,
      }),
      supersedeEvent({
        number: 4,
        predecessorId: "act-2",
        successorId: "act-1",
        invalidationEvent: 1,
        unresolveEvent: 2,
      }),
    ];
  });
  const cycle = await getAutonomousTerminal(state.store, reviewId);
  assert.notEqual(cycle.status, "MERGE_READY");
  assert.notEqual(cycle.blocking_reason, null);

  // Two records with no supersession: an extra active record, not a chain.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [recordOne, recordTwo];
    ledger.resolution_lifecycle = [];
  });
  const extra = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(extra.blocking_reason, "THREAD_RESOLUTION_RECORD_EXTRA");

  // A supersession naming a successor record that does not exist.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [recordOne];
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-1",
        priorWatermark: earlierWatermark,
        newWatermark: finalWatermark,
      }),
      unresolveEvent({ number: 2, recordId: "act-1" }),
      supersedeEvent({
        number: 3,
        predecessorId: "act-1",
        successorId: "act-missing",
        invalidationEvent: 1,
        unresolveEvent: 2,
      }),
    ];
  });
  const missing = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(missing.blocking_reason, "THREAD_RESOLUTION_RECORD_MISSING");

  // An invalidation of the active record with no supersession after it is an
  // invalidated active frontier.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [
      resolutionRecord({
        number: 1,
        actionId: "act-1",
        watermark: finalWatermark,
        headSha,
        recordedRevision: recorded.revision,
      }),
    ];
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-1",
        priorWatermark: finalWatermark,
        newWatermark: digest("moved again"),
      }),
    ];
  });
  const invalidated = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(invalidated.blocking_reason, "THREAD_RESOLUTION_INVALIDATED");

  // Orphan lifecycle events with no resolution records are missing-record
  // evidence: every event kind names a record that must exist, and the
  // terminal projection must never accept an orphan event as proof of
  // nothing.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [];
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-ghost",
        priorWatermark: finalWatermark,
        newWatermark: digest("moved again"),
      }),
    ];
  });
  const orphan = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(orphan.blocking_reason, "THREAD_RESOLUTION_RECORD_MISSING");
  // The pre-ready gate must reach the same verdict: a recordless blocker
  // must not read as "no invalidation" once it reaches derivePublication.
  const orphanGate = await getAutonomousPreReady(state.store, reviewId);
  assert.equal(orphanGate.blocking_reason, "THREAD_RESOLUTION_INVALIDATED");

  // A mixed ledger: one thread with a valid chain and another with only an
  // orphan lifecycle event. The event-only thread must still block the
  // terminal projection; one thread's valid records cannot hide another
  // thread's missing record.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [recordOne, recordTwo];
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-1",
        priorWatermark: earlierWatermark,
        newWatermark: finalWatermark,
      }),
      unresolveEvent({ number: 2, recordId: "act-1" }),
      supersedeEvent({
        number: 3,
        predecessorId: "act-1",
        successorId: "act-2",
        invalidationEvent: 1,
        unresolveEvent: 2,
      }),
      invalidatedEvent({
        number: 4,
        threadId: "PRRT_GHOST",
        recordId: "act-ghost",
        priorWatermark: finalWatermark,
        newWatermark: digest("moved again"),
      }),
    ];
  });
  const mixed = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(mixed.blocking_reason, "THREAD_RESOLUTION_RECORD_MISSING");

  // A resolved thread with no active record is not a workflow-owned
  // resolution: a human, or unknown provenance, resolved it externally, and
  // the terminal claim must not mint over it however clean the derived gate
  // looks (it sees only the unresolved count).
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [];
    ledger.resolution_lifecycle = [];
    ledger.latest_observation.review_threads = {
      ...ledger.latest_observation.review_threads,
      total_count: 1,
      unresolved_count: 0,
      threads: [
        {
          id: "PRRT_HUMAN_RESOLVED",
          is_resolved: true,
          is_outdated: false,
          path: null,
          line: null,
        },
      ],
    };
  });
  const humanResolved = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(humanResolved.blocking_reason, "THREAD_RESOLUTION_RECORD_MISSING");
  // The manual merge path must reach the same verdict: finalizing a gate
  // over evidence the terminal replay rejects must fail, or the operator
  // could merge over a resolution the autonomous projection refuses.
  await assert.rejects(
    finalizePublicationGate(state.store, reviewId, {
      expectedRevision: recorded.revision,
    }),
    (error) => error.code === "PUBLICATION_NOT_READY",
  );
  // The summary must reflect the same verdict, or a summary-driven manual
  // flow would keep advertising FINALIZE_PUBLICATION_GATE and retry a
  // finalization that deterministically throws.
  const summary = await getPublicationSummary(state.store, reviewId);
  assert.equal(summary.status, "CHANGES_REQUIRED");
  assert.equal(summary.blocking_reason, "THREAD_RESOLUTION_RECORD_MISSING");
  assert.notEqual(summary.next_action, "FINALIZE_PUBLICATION_GATE");

  // A successor on an unrelated head is not a descendant: the active record
  // must be at the head the observation covers, or the terminal claim would
  // mint over a resolution that never happened at the head it evaluates.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [
      resolutionRecord({
        number: 1,
        actionId: "act-1",
        threadId: "PRRT_1",
        watermark: earlierWatermark,
        headSha: "c".repeat(40),
        recordedRevision: recorded.revision,
      }),
      resolutionRecord({
        number: 2,
        actionId: "act-2",
        threadId: "PRRT_1",
        watermark: finalWatermark,
        headSha: "d".repeat(40),
        recordedRevision: recorded.revision + 1,
      }),
    ];
    ledger.resolution_lifecycle = [
      invalidatedEvent({
        number: 1,
        recordId: "act-1",
        priorWatermark: earlierWatermark,
        newWatermark: finalWatermark,
      }),
      unresolveEvent({ number: 2, recordId: "act-1" }),
      supersedeEvent({
        number: 3,
        predecessorId: "act-1",
        successorId: "act-2",
        invalidationEvent: 1,
        unresolveEvent: 2,
      }),
    ];
  });
  const unrelatedHead = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(unrelatedHead.blocking_reason, "THREAD_RESOLUTION_CHAIN_BROKEN");
});

test("the final gate rejects replay-valid same-revision resolution evidence substitution", async (t) => {
  const { state, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const observedAt = at + 2_000;
  const thread = resolvedThread(headSha);
  const watermark = threadWatermark(thread);
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  payload.review_threads.total_count = 1;
  payload.review_threads.unresolved_count = 0;
  payload.review_threads.threads = [thread];
  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [
      resolutionRecord({
        number: 1,
        actionId: "act-original",
        watermark,
        headSha,
        recordedRevision: recorded.revision,
      }),
    ];
  });
  await finalizePublicationGate(
    state.store,
    reviewId,
    { expectedRevision: recorded.revision },
    { clock: () => observedAt + 20 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, reviewId, {
      clock: () => observedAt + 30,
    })).valid,
    true,
  );

  // Replace the record at the same publication revision with a different,
  // structurally valid record that still covers the active thread exactly.
  // Replay alone remains clean, so only the final gate's resolution-set
  // binding can detect the substitution.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions[0].action_id = "act-substitute";
    ledger.automatic_resolutions[0].eligibility_sha256 = digest(
      "eligibility-act-substitute",
    );
  });
  const replayClean = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(replayClean.status, "MERGE_READY");
  assert.deepEqual(replayClean.blockers, []);

  const rejected = await verifyPublicationGate(state.store, reviewId, {
    clock: () => observedAt + 40,
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.reason, "GATE_MISMATCH");
});

test("the manual gate verification refuses evidence the terminal replay rejects", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const observedAt = at + 2_000;
  const thread = resolvedThread(headSha);
  const watermark = threadWatermark(thread);
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  payload.review_threads.total_count = 1;
  payload.review_threads.unresolved_count = 0;
  payload.review_threads.threads = [thread];
  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [
      resolutionRecord({
        number: 1,
        actionId: "act-1",
        watermark,
        headSha,
        recordedRevision: recorded.revision,
      }),
    ];
  });
  // The gate can be minted while the record covers the resolved thread.
  await finalizePublicationGate(
    state.store,
    reviewId,
    { expectedRevision: recorded.revision },
    { clock: () => observedAt + 20 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, reviewId, {
      clock: () => observedAt + 30,
    })).valid,
    true,
  );
  // Removing the record leaves the resolved thread recordless; the manual
  // verification must refuse the gate over evidence the terminal replay
  // rejects, even though the observation digest itself is unchanged.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [];
  });
  const revoked = await verifyPublicationGate(state.store, reviewId, {
    clock: () => observedAt + 40,
  });
  assert.equal(revoked.valid, false);
});

test("the terminal replay refuses human participation in an active record's thread", async (t) => {
  const { state, reviewId, headSha, at, clearanceRevision } = await reachPostReady(t);
  const observedAt = at + 2_000;
  const human = { id: 555, type: "User", login: "human" };
  const thread = resolvedThread(headSha, {
    comments: [
      {
        id: "PRRC_1",
        database_id: 900,
        created_at: iso(observedAt - 5_000),
        updated_at: iso(observedAt - 5_000),
        actor: codexActor(),
        review: {
          id: "PRR_1",
          database_id: 101,
          state: "COMMENTED",
          reviewed_head_sha: headSha,
          actor: codexActor(),
        },
      },
      {
        id: "PRRC_2",
        database_id: 901,
        created_at: iso(observedAt - 1_000),
        updated_at: iso(observedAt - 1_000),
        actor: human,
        review: null,
      },
    ],
  });
  const watermark = threadWatermark(thread);
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  payload.review_threads.total_count = 1;
  payload.review_threads.unresolved_count = 0;
  payload.review_threads.threads = [thread];
  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  // A record that matches the watermark exactly still cannot mint a terminal
  // record for a thread a human participated in: the record's own watermark
  // proves only that the sequence is unchanged, not that it was eligible.
  await editPublication(state, reviewId, (ledger) => {
    ledger.automatic_resolutions = [
      resolutionRecord({
        number: 1,
        actionId: "act-1",
        watermark,
        headSha,
        recordedRevision: recorded.revision,
      }),
    ];
  });
  const blocked = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(blocked.status, "CHANGES_REQUIRED");
  assert.equal(blocked.blocking_reason, "THREAD_RESOLUTION_UNSAFE");
  assert.deepEqual(blocked.blockers, [
    "thread_resolution:THREAD_RESOLUTION_UNSAFE:PRRT_1",
  ]);
});

test("a post-ready check failure returns the ready pull request to draft before repair", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const observedAt = at + 2_000;
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  failingCheck(payload);
  await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: payload },
    { clock: () => observedAt + 10 },
  );
  // The terminal projection reports the failed check, and the advance sends
  // the visible pull request back to draft before any repair commit may be
  // made -- the same exposure rule that guards the ordinary repair phases.
  const projection = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(projection.status, "CHECKS_FAILED");
  const advanced = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(advanced.phase, "ENSURE_DRAFT_FOR_REPAIR");
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "PLAN_RETURN_TO_DRAFT",
  );
});

test("the terminal record requires an observation recorded after the clearance", async (t) => {
  const { state, workflow, reviewId, headSha, at, clearanceRevision } =
    await reachPostReady(t);
  const readyAt = Date.parse(workflow.ready_marks.at(-1).recorded_at);
  const observedAt = readyAt + 2_000;

  // A ready observation edited onto the ledger at the clearance revision is
  // indistinguishable to the projection -- it reports MERGE_READY -- but the
  // workflow still refuses to record a terminal entry over it: the RFC's
  // "one fresh complete observation" is recorded *after* the mark-ready
  // action consumed its clearance, and the revision comparison is what makes
  // that structural rather than a clock.
  const payload = readyObservation(state, headSha, {
    at: observedAt,
    requestId: 100,
    requestAt: at + 1_000,
  });
  await editPublication(state, reviewId, (ledger) => {
    ledger.latest_observation = { ...payload, recorded_at: iso(observedAt + 10) };
  });
  const projection = await getAutonomousTerminal(state.store, reviewId);
  assert.equal(projection.status, "MERGE_READY");
  assert.equal(projection.revision, clearanceRevision);
  const refused = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(refused.phase, "POST_READY");
  assert.equal(refused.status, "ACTIVE");
  assert.equal(refused.terminal, null);

  // The genuinely fresh observation (a later revision) is what authorizes it.
  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    { expectedRevision: clearanceRevision, observation: readyObservation(state, headSha, { at: observedAt + 1_000, requestId: 100, requestAt: at + 1_000 }) },
    { clock: () => observedAt + 1_010 },
  );
  assert.equal(recorded.revision, clearanceRevision + 1);
  const done = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(done.status, "MERGE_READY");
  assert.equal(done.terminal.observation_revision, clearanceRevision + 1);
});

test("a terminal workflow ledger cannot be tampered into a different claim", async (t) => {
  const { state, workflow, reviewId, headSha, at } = await reachPostReady(t);
  const readyAt = Date.parse(workflow.ready_marks.at(-1).recorded_at);
  const observedAt = readyAt + 2_000;
  const recorded = await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision:
        workflow.ready_marks[0].publication_revision,
      observation: readyObservation(state, headSha, {
        at: observedAt,
        requestId: 100,
        requestAt: at + 1_000,
      }),
    },
    { clock: () => observedAt + 10 },
  );
  assert.ok(recorded.revision);
  const done = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
  );
  assert.equal(done.status, "MERGE_READY");

  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const tampered = structuredClone(stored);
  tampered.terminal.status = "MERGED";
  await atomicWriteCanonicalJson(workflowPath, tampered);
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) => error.code === "WORKFLOW_STATE_INVALID",
  );
  await atomicWriteCanonicalJson(workflowPath, stored);

  // The terminal status without the terminal record is equally invalid.
  const bare = structuredClone(stored);
  bare.terminal = null;
  await atomicWriteCanonicalJson(workflowPath, bare);
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) => error.code === "WORKFLOW_STATE_INVALID",
  );
  await atomicWriteCanonicalJson(workflowPath, stored);
});

test("historical resolution proof mutation controls reject source latest observation evidence", async (t) => {
  const {
    state,
    workflowPath,
    oldPublication,
    currentPublication,
    currentRecordedReady,
    currentReadyAt,
  } = await reachRepairAncestorProof(t);
  const oldPath = publicationFilePath(state, oldPublication.reviewId);
  const currentPath = publicationFilePath(state, currentPublication.reviewId);

  // Sanity: the untouched scenario clears everywhere, so every case below is
  // blocked by its own source-observation mutation and not by a broken setup.
  assert.equal(
    (await getAutonomousTerminal(state.store, currentPublication.reviewId))
      .status,
    "MERGE_READY",
  );

  const storedOld = JSON.parse(await fsp.readFile(oldPath, "utf8"));
  const storedCurrent = JSON.parse(await fsp.readFile(currentPath, "utf8"));
  const storedWorkflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const baselineSourceThread =
    storedOld.latest_observation.review_threads.threads[0];

  // Each case mutates the source publication's latest persisted observation --
  // the positive evidence the historical qualification must demand -- while
  // every other link stays valid. Where the mutation itself moves the thread
  // watermark, the bound source record and workflow outcome are updated to the
  // moved watermark too, so the named conjunct is the only failing one.
  const cases = [
    {
      label: "source latest observation cleared",
      apply(old) {
        old.latest_observation = null;
      },
    },
    {
      label: "source thread unresolved at the same watermark",
      apply(old) {
        old.latest_observation.review_threads.threads[0].is_resolved = false;
      },
    },
    {
      label: "source target thread absent",
      apply(old) {
        old.latest_observation.review_threads.threads = [];
      },
    },
    {
      label: "source review_threads collection incomplete",
      apply(old) {
        old.latest_observation.review_threads.collection.status =
          "INCOMPLETE";
      },
    },
    {
      label: "source thread provenance incomplete",
      apply(old) {
        old.latest_observation.review_threads.threads[0].provenance_complete =
          false;
      },
    },
    {
      label: "source thread comments pagination incomplete",
      apply(old) {
        old.latest_observation.review_threads.threads[0]
          .comments_pagination_complete = false;
      },
    },
    {
      label: "source thread watermark changed",
      apply(old) {
        const thread =
          old.latest_observation.review_threads.threads[0];
        thread.comments.push({
          id: "PRRC_WM_SRC",
          database_id: 905,
          created_at: iso(currentReadyAt - 300),
          updated_at: iso(currentReadyAt - 300),
          actor: codexActor(),
          review: null,
        });
        thread.comment_count = thread.comments.length;
      },
    },
    {
      label: "source thread foreign participation",
      // The source ledger's codex_actor is the policy fact that decides
      // whether the source thread's comments are foreign, and it sits outside
      // the watermark entirely: mutating it makes the source unsafe while
      // every comment, count, record, outcome, and current thread stays
      // byte-identical (prove below), so the source safety predicate is the
      // only failing conjunct -- never an earlier watermark mismatch. The
      // stored-ledger validator pins the persisted Codex result evidence
      // (codex_result_history and the baseline candidate results) to the same
      // policy actor, so the actor identity is rewritten consistently there
      // too -- preserving every non-actor field -- and the source still loads
      // as a valid ledger whose only change is the re-pinned policy actor.
      apply(old) {
        old.target.codex_actor = {
          ...old.target.codex_actor,
          id: CODEX_ACTOR_ID - 1,
        };
        for (const entry of old.codex_result_history ?? []) {
          if (entry.actor?.id === CODEX_ACTOR_ID) {
            entry.actor = { ...entry.actor, id: CODEX_ACTOR_ID - 1 };
          }
        }
        for (const entry of old.codex_review_baseline.candidate_results ?? []) {
          if (entry.actor?.id === CODEX_ACTOR_ID) {
            entry.actor = { ...entry.actor, id: CODEX_ACTOR_ID - 1 };
          }
        }
      },
      prove: async (old, current, workflow) => {
        const sourceThread = old.latest_observation.review_threads.threads[0];
        assert.deepEqual(
          sourceThread,
          baselineSourceThread,
          "source thread evidence must stay byte-identical",
        );
        assert.equal(
          threadWatermark(sourceThread),
          threadWatermark(baselineSourceThread),
          "source thread watermark must not move",
        );
        assert.equal(
          sourceThread.comment_count,
          sourceThread.comments.length,
          "source thread comment count unchanged",
        );
        assert.equal(
          old.automatic_resolutions[0].thread_watermark,
          storedOld.automatic_resolutions[0].thread_watermark,
          "source record watermark unchanged",
        );
        assert.deepEqual(
          workflow.thread_resolutions,
          storedWorkflow.thread_resolutions,
          "workflow outcomes unchanged",
        );
        assert.equal(
          old.automatic_resolutions[0].thread_watermark,
          workflow.thread_resolutions[0].thread_watermark,
          "source record and outcome watermarks stay equal",
        );
        const currentThread =
          current.latest_observation.review_threads.threads[0];
        assert.equal(
          threadWatermark(currentThread),
          workflow.thread_resolutions[0].thread_watermark,
          "current thread watermark still equals the outcome",
        );
        assert.equal(
          current.target.codex_actor.id,
          CODEX_ACTOR_ID,
          "current actor policy untouched",
        );
        assert.equal(
          old.latest_observation.review_threads.collection.status,
          "COMPLETE",
          "source observation collection still complete",
        );
        assert.equal(
          old.authorization.head_sha,
          storedOld.authorization.head_sha,
          "source authorization head unchanged",
        );
      },
    },
  ];

  for (const { label, apply, prove } of cases) {
    const old = structuredClone(storedOld);
    const current = structuredClone(storedCurrent);
    const workflow = structuredClone(storedWorkflow);
    apply(old, current, workflow);
    await prove?.(old, current, workflow);
    await atomicWriteCanonicalJson(oldPath, old);
    await atomicWriteCanonicalJson(currentPath, current);
    await atomicWriteCanonicalJson(workflowPath, workflow);
    try {
      const terminal = await getAutonomousTerminal(
        state.store,
        currentPublication.reviewId,
      );
      assert.equal(terminal.status, "CHANGES_REQUIRED", label);
      assert.equal(
        terminal.blocking_reason,
        "THREAD_RESOLUTION_RECORD_MISSING",
        label,
      );
      const summary = await getPublicationSummary(
        state.store,
        currentPublication.reviewId,
      );
      assert.equal(summary.status, "CHANGES_REQUIRED", label);
      assert.equal(
        summary.blocking_reason,
        "THREAD_RESOLUTION_RECORD_MISSING",
        label,
      );
      assert.notEqual(
        summary.next_action,
        "FINALIZE_PUBLICATION_GATE",
        label,
      );
      await assert.rejects(
        finalizePublicationGate(
          state.store,
          currentPublication.reviewId,
          { expectedRevision: currentRecordedReady.revision },
          { clock: () => currentReadyAt + 20 },
        ),
        (error) => error.code === "PUBLICATION_NOT_READY",
        `${label}: manual gate`,
      );
    } finally {
      await atomicWriteCanonicalJson(oldPath, storedOld);
      await atomicWriteCanonicalJson(currentPath, storedCurrent);
      await atomicWriteCanonicalJson(workflowPath, storedWorkflow);
    }
  }
});

test("historical resolution proof mutation controls reject source authorization mutations", async (t) => {
  const {
    state,
    oldPublication,
    currentPublication,
    currentRecordedReady,
    currentReadyAt,
  } = await reachRepairAncestorProof(t);
  const oldPath = publicationFilePath(state, oldPublication.reviewId);
  const currentPath = publicationFilePath(state, currentPublication.reviewId);
  // The repair-ancestor lifecycle authorizes every publication in
  // EXPLICIT_ONLY mode, so the bound authorization artifact is a local gate.
  const localGatePath = path.join(
    state.store,
    "reviews",
    oldPublication.reviewId,
    "gate.json",
  );

  // Sanity: the untouched scenario clears everywhere.
  assert.equal(
    (await getAutonomousTerminal(state.store, currentPublication.reviewId))
      .status,
    "MERGE_READY",
  );

  const storedOld = JSON.parse(await fsp.readFile(oldPath, "utf8"));
  const storedCurrent = JSON.parse(await fsp.readFile(currentPath, "utf8"));
  const storedArtifact = await fsp.readFile(localGatePath, "utf8");

  const otherDigest = digest("mismatched source authorization");
  const cases = [
    {
      label: "source authorization digest substituted in the ledger",
      artifact: "keep",
      apply(old) {
        old.authorization.source_sha256 = otherDigest;
      },
    },
    {
      label: "source bound authorization artifact missing",
      artifact: "remove",
      apply() {},
    },
    {
      label: "source bound authorization artifact corrupt",
      artifact: "corrupt",
      apply() {},
    },
    {
      label: "source bound authorization artifact substituted",
      // A different structurally valid local gate: the snapshot hash moves so
      // the artifact bytes (and therefore its bound source_sha256) differ from
      // what the ledger authorizes, while every other field -- review
      // identity, heads, provider -- stays valid.
      artifact: "substitute",
      apply() {},
    },
  ];

  for (const { label, artifact, apply } of cases) {
    const old = structuredClone(storedOld);
    const current = structuredClone(storedCurrent);
    apply(old);
    await atomicWriteCanonicalJson(oldPath, old);
    await atomicWriteCanonicalJson(currentPath, current);
    if (artifact === "remove") {
      await fsp.rm(localGatePath);
    } else if (artifact === "corrupt") {
      await fsp.writeFile(localGatePath, "{ not canonical json", {
        mode: 0o600,
      });
    } else if (artifact === "substitute") {
      const substituted = JSON.parse(storedArtifact);
      substituted.snapshot_hash = digest("substituted local gate snapshot");
      await atomicWriteCanonicalJson(localGatePath, substituted);
    }
    try {
      const terminal = await getAutonomousTerminal(
        state.store,
        currentPublication.reviewId,
      );
      assert.equal(terminal.status, "CHANGES_REQUIRED", label);
      assert.equal(
        terminal.blocking_reason,
        "THREAD_RESOLUTION_RECORD_MISSING",
        label,
      );
      const summary = await getPublicationSummary(
        state.store,
        currentPublication.reviewId,
      );
      assert.equal(summary.status, "CHANGES_REQUIRED", label);
      assert.equal(
        summary.blocking_reason,
        "THREAD_RESOLUTION_RECORD_MISSING",
        label,
      );
      assert.notEqual(
        summary.next_action,
        "FINALIZE_PUBLICATION_GATE",
        label,
      );
      await assert.rejects(
        finalizePublicationGate(
          state.store,
          currentPublication.reviewId,
          { expectedRevision: currentRecordedReady.revision },
          { clock: () => currentReadyAt + 20 },
        ),
        (error) => error.code === "PUBLICATION_NOT_READY",
        `${label}: manual gate`,
      );
    } finally {
      await atomicWriteCanonicalJson(oldPath, storedOld);
      await atomicWriteCanonicalJson(currentPath, storedCurrent);
      await fsp.writeFile(localGatePath, storedArtifact, {
        mode: 0o600,
      });
    }
  }
});

test("post-gate source authority substitution never verifies valid", async (t) => {
  const {
    state,
    workflowPath,
    oldPublication,
    currentPublication,
    currentRecordedReady,
    currentReadyAt,
  } = await reachRepairAncestorProof(t);
  const oldPath = publicationFilePath(state, oldPublication.reviewId);
  const localGatePath = path.join(
    state.store,
    "reviews",
    oldPublication.reviewId,
    "gate.json",
  );

  // The gate is minted over the historical proof; the effective digest binds
  // the current resolution set plus the sorted historical references, each of
  // which separately binds the source publication's own authorization digest.
  await finalizePublicationGate(
    state.store,
    currentPublication.reviewId,
    { expectedRevision: currentRecordedReady.revision },
    { clock: () => currentReadyAt + 20 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, currentPublication.reviewId, {
      clock: () => currentReadyAt + 30,
    })).valid,
    true,
  );

  const storedOld = JSON.parse(await fsp.readFile(oldPath, "utf8"));
  const storedWorkflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const storedArtifact = await fsp.readFile(localGatePath, "utf8");
  const otherDigest = digest("post-gate source authorization");

  const substitutions = [
    {
      label: "replay-invalid ledger authorization digest substitution",
      replayClean: false,
      async apply() {
        const old = structuredClone(storedOld);
        old.authorization.source_sha256 = otherDigest;
        await atomicWriteCanonicalJson(oldPath, old);
      },
    },
    {
      label: "replay-invalid bound authorization artifact substitution",
      replayClean: false,
      async apply() {
        const substituted = JSON.parse(storedArtifact);
        substituted.snapshot_hash = digest("substituted post-gate snapshot");
        await atomicWriteCanonicalJson(localGatePath, substituted);
      },
    },
    {
      label: "replay-clean consistent source authority substitution",
      // The artifact and the ledger's authorization digest are replaced
      // together, so the source still revalidates under its own lock and the
      // proof still qualifies -- but the bound source_authorization_sha256 is
      // a different digest, so the gate minted over the old authority fails
      // verification with GATE_MISMATCH.
      replayClean: true,
      async apply() {
        const old = structuredClone(storedOld);
        const substituted = JSON.parse(storedArtifact);
        substituted.snapshot_hash = digest("substituted consistent snapshot");
        await atomicWriteCanonicalJson(localGatePath, substituted);
        old.authorization.source_sha256 = sha256(
          canonicalJsonBytes(substituted),
        );
        await atomicWriteCanonicalJson(oldPath, old);
      },
    },
  ];

  for (const { label, replayClean, apply } of substitutions) {
    await apply();
    try {
      const terminal = await getAutonomousTerminal(
        state.store,
        currentPublication.reviewId,
        { clock: () => currentReadyAt + 40 },
      );
      if (replayClean) {
        // The substitution leaves the replay untouched: the resolution proof
        // still qualifies, so the projection stays MERGE_READY and the gate is
        // reached. The gate was minted over the effective digest that binds
        // the sorted historical references, so the substituted authority fails
        // verification below with GATE_MISMATCH.
        assert.equal(terminal.status, "MERGE_READY", label);
      } else {
        // The substitution breaks the source revalidation itself, so the
        // terminal must name the exact recordless blocker before the gate is
        // ever compared; verification then still fails with GATE_MISMATCH.
        assert.equal(terminal.status, "CHANGES_REQUIRED", label);
        assert.equal(
          terminal.blocking_reason,
          "THREAD_RESOLUTION_RECORD_MISSING",
          label,
        );
      }
      const rejected = await verifyPublicationGate(
        state.store,
        currentPublication.reviewId,
        { clock: () => currentReadyAt + 50 },
      );
      assert.equal(rejected.valid, false, label);
      assert.equal(rejected.reason, "GATE_MISMATCH", label);
    } finally {
      await atomicWriteCanonicalJson(oldPath, storedOld);
      await atomicWriteCanonicalJson(workflowPath, storedWorkflow);
      await fsp.writeFile(localGatePath, storedArtifact, { mode: 0o600 });
    }
  }
});

test("withAutonomousTerminalLock retains the historical source lock and post-release mutations fail verification", async (t) => {
  const {
    state,
    oldPublication,
    currentPublication,
    currentRecordedReady,
    currentReadyAt,
  } = await reachRepairAncestorProof(t);
  const oldPath = publicationFilePath(state, oldPublication.reviewId);
  const oldDirectory = path.join(
    state.store,
    "reviews",
    oldPublication.reviewId,
  );
  const storedOld = JSON.parse(await fsp.readFile(oldPath, "utf8"));

  // Mint the gate over the historical proof, then prove the authority path
  // (the same retained-lock callback the workflow terminal write uses) keeps
  // the source lock for the whole operation -- not merely through
  // qualification -- and that a coordinated source mutation after release
  // cannot escape the bound digest.
  await finalizePublicationGate(
    state.store,
    currentPublication.reviewId,
    { expectedRevision: currentRecordedReady.revision },
    { clock: () => currentReadyAt + 20 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, currentPublication.reviewId, {
      clock: () => currentReadyAt + 30,
    })).valid,
    true,
  );

  await withAutonomousTerminalLock(
    state.store,
    currentPublication.reviewId,
    async (current) => {
      assert.equal(current.status, "MERGE_READY");
      // While the callback runs the ancestor publication lock must still be
      // held: a bounded acquisition attempt fails retryable PUBLICATION_BUSY,
      // never reads through the locked source and never degrades to a
      // missing-record verdict.
      await assert.rejects(
        acquireStateLock({
          directory: oldDirectory,
          reviewId: oldPublication.reviewId,
          domain: "publication",
          waitMs: 150,
        }),
        (error) =>
          error.code === "PUBLICATION_BUSY" &&
          error.details?.retryable === true,
        "source lock retained through the authority-consuming callback",
      );
    },
    { clock: () => currentReadyAt + 40 },
  );

  // After the callback releases the source lock, a coordinated mutation may
  // proceed...
  const mutated = structuredClone(storedOld);
  mutated.automatic_resolutions[0].eligibility_sha256 = digest(
    "post-gate source eligibility",
  );
  await atomicWriteCanonicalJson(oldPath, mutated);
  try {
    // ...but the gate minted over the stale proof must fail verification.
    const rejected = await verifyPublicationGate(
      state.store,
      currentPublication.reviewId,
      { clock: () => currentReadyAt + 50 },
    );
    assert.equal(rejected.valid, false);
    assert.equal(rejected.reason, "GATE_MISMATCH");
  } finally {
    await atomicWriteCanonicalJson(oldPath, storedOld);
  }
});

test("the workflow records its MERGE_READY terminal over the historical resolution proof", async (t) => {
  const {
    state,
    workflow,
    currentPublication,
    currentReadyAt,
  } = await reachRepairAncestorProof(t);

  // The descendant is POST_READY with one fresh ready observation and no
  // automatic-resolution record of its own; only the historical proof clears
  // the terminal replay. The real terminal path must mint the workflow's
  // MERGE_READY record over that proof and bind the exact digests the
  // terminal projection revalidated.
  const before = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(before.phase, "POST_READY");
  assert.equal(before.terminal, null);

  const projection = await getAutonomousTerminal(
    state.store,
    currentPublication.reviewId,
    { clock: () => currentReadyAt + 20 },
  );
  assert.equal(projection.status, "MERGE_READY");
  assert.equal(projection.blocking_reason, null);

  const terminalWorkflow = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    before.revision,
    { clock: () => currentReadyAt + 25 },
  );
  assert.equal(terminalWorkflow.status, "MERGE_READY");
  assert.equal(terminalWorkflow.terminal.status, "MERGE_READY");
  assert.equal(terminalWorkflow.terminal.publication_id, currentPublication.reviewId);
  assert.equal(
    terminalWorkflow.terminal.observation_revision,
    projection.revision,
  );
  assert.equal(
    terminalWorkflow.terminal.observation_sha256,
    projection.observation_sha256,
  );
  assert.equal(
    terminalWorkflow.terminal.publication_authorization_sha256,
    projection.publication_authorization_sha256,
  );
  assert.equal(
    terminalWorkflow.terminal.workflow_authorization_sha256,
    projection.workflow_authorization_sha256,
  );
  assert.equal(
    terminalWorkflow.terminal.resolution_sha256,
    projection.resolution_sha256,
  );

  // The record survives a fresh workflow read, and the terminal publication
  // stops accepting further snapshots.
  const reread = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(reread.terminal.status, "MERGE_READY");
  assert.equal(
    reread.terminal.resolution_sha256,
    projection.resolution_sha256,
  );
});

test("the workflow terminal binds the freshly revalidated projection, not the earlier one", async (t) => {
  const {
    state,
    workflow,
    oldPublication,
    currentPublication,
    currentReadyAt,
  } = await reachRepairAncestorProof(t);
  const oldPath = publicationFilePath(state, oldPublication.reviewId);

  // Precompute a replay-clean ancestor ledger mutation: the active record's
  // eligibility digest is not part of any replay-validity link, but it is
  // bound into the proof's record digest and source resolution digest, so it
  // moves the effective resolution digest while every link that keeps the
  // terminal projection MERGE_READY stays intact (exactly the substitution
  // the post-gate tests prove replay-clean and digest-sensitive).
  const storedOld = JSON.parse(await fsp.readFile(oldPath, "utf8"));
  const mutatedOld = structuredClone(storedOld);
  mutatedOld.automatic_resolutions[0].eligibility_sha256 = digest(
    "terminal-toctou-eligibility",
  );

  const before = await getAutonomousWorkflow(state.store, workflow.workflow_id);
  assert.equal(before.phase, "POST_READY");
  assert.equal(before.terminal, null);

  // The stable projection the advance reads first: computed over the original
  // source, before the mutation lands anywhere.
  const first = await getAutonomousTerminal(
    state.store,
    currentPublication.reviewId,
    { clock: () => currentReadyAt + 20 },
  );
  assert.equal(first.status, "MERGE_READY");

  // advanceRemoteWorkflow reads the provided clock exactly twice on the
  // POST_READY terminal path: once at the first projection's entry and once
  // at the retained-lock revalidation's entry. The second call happens while
  // the current publication lock is held but before the ancestor publication
  // lock has been acquired, so the source file is unlocked at exactly that
  // seam: land the precomputed replay-clean mutation there with a direct
  // synchronous canonical write (matching canonicalJsonBytes/0o600), and the
  // revalidation reads the mutated source while the first projection never
  // saw it. If the clock is ever called a different number of times the
  // count assertion below fails the test instead of relying on an
  // undocumented barrier.
  let calls = 0;
  const advanceClock = () => {
    calls += 1;
    if (calls === 2) {
      writeFileSync(oldPath, canonicalJsonBytes(mutatedOld), { mode: 0o600 });
    }
    return currentReadyAt + 25;
  };

  let done;
  try {
    done = await advanceRemoteWorkflow(
      state.store,
      workflow.workflow_id,
      before.revision,
      { clock: advanceClock },
    );
    assert.equal(calls, 2, "the advance must read the clock exactly twice");

    // The mutation landed between the first projection and the locked
    // revalidation, so the freshly recomputed digest differs from the first
    // while the current publication revision and status are unchanged.
    const expected = await getAutonomousTerminal(
      state.store,
      currentPublication.reviewId,
      { clock: () => currentReadyAt + 30 },
    );
    assert.equal(expected.status, "MERGE_READY");
    assert.equal(expected.revision, first.revision);
    assert.notEqual(
      expected.resolution_sha256,
      first.resolution_sha256,
      "the eligibility mutation must move the effective resolution digest",
    );

    assert.equal(done.status, "MERGE_READY");
    assert.equal(done.terminal.status, "MERGE_READY");
    // The terminal record is the run's success claim and must bind what the
    // locked revalidation actually proved -- the second digest -- never the
    // stale first projection's.
    assert.equal(
      done.terminal.resolution_sha256,
      expected.resolution_sha256,
    );
    assert.notEqual(done.terminal.resolution_sha256, first.resolution_sha256);
    // Every other projection-derived bound field also comes from the fresh
    // revalidation; the mutation leaves them unchanged, so they must still
    // match it exactly.
    assert.equal(done.terminal.observation_revision, expected.revision);
    assert.equal(done.terminal.observation_sha256, expected.observation_sha256);
    assert.equal(
      done.terminal.publication_authorization_sha256,
      expected.publication_authorization_sha256,
    );
    assert.equal(
      done.terminal.workflow_authorization_sha256,
      expected.workflow_authorization_sha256,
    );
    assert.equal(
      done.terminal.ready_exception_sha256,
      expected.ready_exception_sha256,
    );
    assert.deepEqual(
      done.terminal.human_review_requirements,
      expected.human_review_requirements,
    );
  } finally {
    // Restore the source so no mutated evidence survives the test.
    await atomicWriteCanonicalJson(oldPath, storedOld);
  }
});

/**
 * Assert the exact persisted review-thread shape the real recordGithubSnapshot
 * writer requires and commits: exact counts, complete provenance and comment
 * pagination, and an ancestry set covering exactly the referenced finding
 * heads (threads rooted in the gated head itself need no entry).
 */
function assertWriterValidatedReviewThreads(
  observation,
  expectedThreadIds,
  expectedFindingHeads,
) {
  const threads = observation.review_threads.threads;
  assert.equal(
    observation.review_threads.total_count,
    threads.length,
    "total_count must equal the persisted thread count",
  );
  assert.equal(
    observation.review_threads.unresolved_count,
    threads.filter((thread) => thread.is_resolved === false).length,
    "unresolved_count must match the persisted threads",
  );
  assert.deepEqual(
    threads.map((thread) => thread.id).sort(),
    [...expectedThreadIds].sort(),
    "persisted thread ids",
  );
  for (const thread of threads) {
    assert.equal(thread.provenance_complete, true);
    assert.equal(thread.comments_pagination_complete, true);
  }
  assert.deepEqual(
    (observation.review_threads.ancestry ?? [])
      .map((entry) => entry.finding_head_sha)
      .sort(),
    [...expectedFindingHeads].sort(),
    "ancestry must cover exactly the referenced finding heads",
  );
}

/**
 * Append the server-owned record and workflow outcome that bind one
 * additional historical resolution proof. The observation evidence itself is
 * already committed by the real recordGithubSnapshot writer inside the setup
 * (source and current observations carry the extra thread from the first
 * writer-accepted snapshot onward); no public API can author a record or
 * outcome for a synthetic action, so this narrow mutation is the only direct
 * write left. Returns the persisted source ledger.
 */
async function appendHistoricalResolutionProof(
  state,
  {
    workflowPath,
    sourceReviewId,
    headSha,
    thread,
    actionId,
    recordedRevision,
  },
) {
  const sourcePath = publicationFilePath(state, sourceReviewId);
  const workflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const source = JSON.parse(await fsp.readFile(sourcePath, "utf8"));
  const watermark = threadWatermark(thread);

  const records = source.automatic_resolutions ?? [];
  records.push(
    resolutionRecord({
      number: records.length + 1,
      actionId,
      threadId: thread.id,
      watermark,
      headSha,
      recordedRevision,
    }),
  );
  source.automatic_resolutions = records;
  workflow.thread_resolutions.push({
    number: workflow.thread_resolutions.length + 1,
    thread_id: thread.id,
    outcome: "RESOLVED",
    action_id: actionId,
    thread_watermark: watermark,
    head_sha: headSha,
    publication_review_id: sourceReviewId,
    recorded_at: iso(Date.now()),
  });

  await atomicWriteCanonicalJson(sourcePath, source);
  await atomicWriteCanonicalJson(workflowPath, workflow);
  return source;
}

test("multi-proof non-ASCII thread IDs bind an insertion-order-independent terminal digest", async (t) => {
  const {
    state,
    workflowPath,
    currentPublication,
    currentReadyAt,
    extraProofResults,
  } = await reachRepairAncestorProof(t, {
    extraProofs: [
      { threadId: "PRRT_α", actionId: "act-alpha", source: "old" },
    ],
  });
  const currentPath = publicationFilePath(state, currentPublication.reviewId);

  // A second resolved thread at the same source head whose ID is non-ASCII:
  // the effective digest must order the two historical references by code
  // unit, not by locale or by insertion order, so no environment locale and
  // no input order can change the bound digest. The thread's observation
  // evidence was committed by the real recordGithubSnapshot writer during the
  // setup; only the server-owned record and workflow outcome were appended.
  const secondThreadId = "PRRT_α";
  const secondWatermark = extraProofResults[0].watermark;
  assert.match(secondWatermark, /^[0-9a-f]{64}$/);

  const storedWorkflow = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const storedCurrent = JSON.parse(await fsp.readFile(currentPath, "utf8"));

  const terminalDigest = async () => {
    const terminal = await getAutonomousTerminal(
      state.store,
      currentPublication.reviewId,
      { clock: () => currentReadyAt + 20 },
    );
    assert.equal(terminal.status, "MERGE_READY");
    assert.deepEqual(terminal.blockers, []);
    return terminal.resolution_sha256;
  };

  const first = await terminalDigest();
  assert.match(first, /^[0-9a-f]{64}$/);

  // Reversing the workflow's completed-outcome order (and renumbering the
  // outcomes, as the binding requires) must not change the bound digest: the
  // references are bound sorted by thread id in code-unit order, never by the
  // order the outcomes were recorded.
  const reversedWorkflow = structuredClone(storedWorkflow);
  reversedWorkflow.thread_resolutions.reverse();
  reversedWorkflow.thread_resolutions = reversedWorkflow.thread_resolutions.map(
    (resolution, index) => ({ ...resolution, number: index + 1 }),
  );
  await atomicWriteCanonicalJson(workflowPath, reversedWorkflow);
  try {
    assert.equal(await terminalDigest(), first, "workflow outcome order");
  } finally {
    await atomicWriteCanonicalJson(workflowPath, storedWorkflow);
  }

  // Reversing the observation's thread order must not change it either.
  const reversedCurrent = structuredClone(storedCurrent);
  reversedCurrent.latest_observation.review_threads.threads.reverse();
  await atomicWriteCanonicalJson(currentPath, reversedCurrent);
  try {
    assert.equal(await terminalDigest(), first, "observation thread order");
  } finally {
    await atomicWriteCanonicalJson(currentPath, storedCurrent);
  }

  // The second proof participates in the bound digest: dropping it from the
  // current observation changes the digest.
  const singleProof = structuredClone(storedCurrent);
  singleProof.latest_observation.review_threads.threads =
    singleProof.latest_observation.review_threads.threads.filter(
      (thread) => thread.id !== secondThreadId,
    );
  await atomicWriteCanonicalJson(currentPath, singleProof);
  try {
    assert.notEqual(await terminalDigest(), first, "dropped proof");
  } finally {
    await atomicWriteCanonicalJson(currentPath, storedCurrent);
  }
});

test("two distinct ancestor source publications exercise newest-to-oldest acquisition", async (t) => {
  const {
    state,
    workflow,
    workflowPath,
    firstPublication,
    oldPublication,
    currentPublication,
    currentRecordedReady,
    currentReadyAt,
    oldHead,
    firstHead,
  } = await reachRepairAncestorProof(t, {
    extraProofs: [
      { threadId: "PRRT_β", actionId: "act-beta", source: "first" },
    ],
  });
  const oldPath = publicationFilePath(state, oldPublication.reviewId);
  const firstPath = publicationFilePath(state, firstPublication.reviewId);

  // The first publication is an older ancestor of the same workflow: its head
  // precedes the old publication's head in the recorded attempt lineage. Both
  // ancestors' observations were accepted by the real recordGithubSnapshot
  // writer (PRRT_β resolved on the first publication, PRRT_1 on the old).
  // The lineage is read from the persisted workflow ledger directly: after
  // the synthetic second outcome is appended, the audit-validating reader
  // intentionally refuses the ledger, so the raw recorded attempt order is
  // the honest persisted fact to assert.
  const attemptHeads = JSON.parse(
    await fsp.readFile(workflowPath, "utf8"),
  ).attempts.map((attempt) => attempt.head_sha);
  assert.ok(attemptHeads.indexOf(firstHead) < attemptHeads.indexOf(oldHead));

  // Sanity: both proofs qualify and the projection reaches MERGE_READY.
  const terminal = await getAutonomousTerminal(
    state.store,
    currentPublication.reviewId,
    { clock: () => currentReadyAt + 20 },
  );
  assert.equal(terminal.status, "MERGE_READY");
  assert.deepEqual(terminal.blockers, []);
  assert.match(terminal.resolution_sha256, /^[0-9a-f]{64}$/);

  // Newest-to-oldest lock order. Hold the oldest ancestor's lock, start a
  // consumer asynchronously, and poll with bounded competing acquisitions of
  // the newest ancestor: while the consumer is blocked on the oldest lock it
  // must already hold the newest one, so every competing newest acquisition
  // returns retryable PUBLICATION_BUSY. A reversed implementation would
  // attempt the oldest first, never reach the newest, and fail the poll.
  let releaseOldest = null;
  let consumer = null;
  try {
    releaseOldest = await acquireStateLock({
      directory: path.join(state.store, "reviews", firstPublication.reviewId),
      reviewId: firstPublication.reviewId,
      domain: "publication",
    });
    consumer = getAutonomousTerminal(state.store, currentPublication.reviewId, {
      clock: () => currentReadyAt + 20,
    });
    let newestHeldByConsumer = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !newestHeldByConsumer) {
      try {
        const releaseProbe = await acquireStateLock({
          directory: path.join(state.store, "reviews", oldPublication.reviewId),
          reviewId: oldPublication.reviewId,
          domain: "publication",
          waitMs: 100,
        });
        // The consumer never held the newest source: either it has not
        // reached the sources yet (retry) or the acquisition order is
        // reversed (deadline expires below).
        await releaseProbe();
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        if (
          error?.code === "PUBLICATION_BUSY" &&
          error?.details?.retryable === true
        ) {
          newestHeldByConsumer = true;
        } else {
          throw error;
        }
      }
    }
    assert.equal(
      newestHeldByConsumer,
      true,
      "consumer must acquire the newest ancestor source while blocked on the oldest",
    );
    await releaseOldest();
    releaseOldest = null;
    const result = await consumer;
    consumer = null;
    assert.equal(result.status, "MERGE_READY");
    assert.deepEqual(result.blockers, []);
  } finally {
    if (releaseOldest != null) {
      await releaseOldest();
    }
    if (consumer != null) {
      await consumer.catch(() => {});
    }
  }

  // The bound digest covers both sources: a post-gate mutation of either
  // ancestor fails verification with GATE_MISMATCH.
  await finalizePublicationGate(
    state.store,
    currentPublication.reviewId,
    { expectedRevision: currentRecordedReady.revision },
    { clock: () => currentReadyAt + 30 },
  );
  assert.equal(
    (await verifyPublicationGate(state.store, currentPublication.reviewId, {
      clock: () => currentReadyAt + 40,
    })).valid,
    true,
  );

  const storedOld = JSON.parse(await fsp.readFile(oldPath, "utf8"));
  const storedFirst = JSON.parse(await fsp.readFile(firstPath, "utf8"));
  for (const [label, sourcePath, storedSource] of [
    ["oldest ancestor", firstPath, storedFirst],
    ["newest ancestor", oldPath, storedOld],
  ]) {
    const mutated = structuredClone(storedSource);
    mutated.automatic_resolutions[0].eligibility_sha256 = digest(
      `post-gate ${label}`,
    );
    await atomicWriteCanonicalJson(sourcePath, mutated);
    try {
      const rejected = await verifyPublicationGate(
        state.store,
        currentPublication.reviewId,
        { clock: () => currentReadyAt + 50 },
      );
      assert.equal(rejected.valid, false, label);
      assert.equal(rejected.reason, "GATE_MISMATCH", label);
    } finally {
      await atomicWriteCanonicalJson(sourcePath, storedSource);
    }
  }

  // Lock contention on either source publication propagates retryable
  // PUBLICATION_BUSY: both ancestors are acquired and consumed under their
  // own locks, never read from an unlocked snapshot.
  for (const [label, reviewId] of [
    ["oldest source", firstPublication.reviewId],
    ["newest source", oldPublication.reviewId],
  ]) {
    const release = await acquireStateLock({
      directory: path.join(state.store, "reviews", reviewId),
      reviewId,
      domain: "publication",
    });
    try {
      await assert.rejects(
        getAutonomousTerminal(state.store, currentPublication.reviewId),
        (error) =>
          error.code === "PUBLICATION_BUSY" &&
          error.details?.retryable === true,
        `${label} lock contention`,
      );
    } finally {
      await release();
    }
  }
});

test("two historical proofs from one source publication retain one source lock", async (t) => {
  const { state, oldPublication, currentPublication, currentReadyAt } =
    await reachRepairAncestorProof(t, {
      extraProofs: [
        { threadId: "PRRT_α", actionId: "act-alpha", source: "old" },
      ],
    });

  // Two outcomes name the same source publication, so the effective context
  // must acquire that one source lock exactly once and retain it through the
  // operation callback: a competing acquisition inside the retained callback
  // is retryable PUBLICATION_BUSY. A second self-acquisition would block the
  // consumer on its own lock and time it out, so the MERGE_READY assertion
  // below catches that regression too.
  const terminal = await withAutonomousTerminalLock(
    state.store,
    currentPublication.reviewId,
    async (current) => {
      assert.equal(current.status, "MERGE_READY");
      assert.deepEqual(current.blockers, []);
      await assert.rejects(
        acquireStateLock({
          directory: path.join(state.store, "reviews", oldPublication.reviewId),
          reviewId: oldPublication.reviewId,
          domain: "publication",
          waitMs: 200,
        }),
        (error) =>
          error.code === "PUBLICATION_BUSY" &&
          error.details?.retryable === true,
        "competing acquisition of the same source inside the retained callback",
      );
      return current;
    },
    { clock: () => currentReadyAt + 20 },
  );
  assert.equal(terminal.status, "MERGE_READY");
});
