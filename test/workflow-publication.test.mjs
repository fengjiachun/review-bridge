import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  getPublication,
  getPublicationSummary,
  getThreadResolutionPlan,
  recordAutomaticResolution,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
  verifyPublicationGate,
} from "../src/publication.mjs";
import {
  advanceLocalWorkflow,
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
  resumeAutonomousWorkflow,
  startAutonomousWorkflow,
} from "../src/workflow.mjs";
import {
  acquireStateLock,
  atomicWriteCanonicalJson,
  canonicalJson,
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
 * Drive a workflow to an observed, workflow-owned thread resolution: a
 * finding thread answered by the workflow's own recorded reply, resolved
 * on a re-read watermark, with the action OBSERVED and its publication
 * record not yet created. Both the eligibility walk and the completion
 * rules start from exactly this state, so it is built once.
 */
async function reachObservedThreadResolution(t) {
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
      is_resolved: false,
      thread_watermark: watermark,
    },
  );
  // A response attributing the transition to anyone but the action's own
  // actor never becomes an observation -- refused before anything persists,
  // so the true post-read can still be recorded at the same revision.
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

  const resolutionObserved = await recordThreadResolutionObservation(
    state.store,
    workflow.workflow_id,
    resolutionExecuting.revision,
    resolutionPlanned.action.action_id,
    {
      outcome: "RESOLVED",
      threadId: "PRRT_1",
      isResolved: true,
      threadWatermark: watermark,
      resolvedById: 555,
      resolvedByType: "User",
    },
  );
  return {
    state,
    workflow,
    first,
    second,
    codex,
    record,
    workflowPath,
    repliedObservation,
    resolveAt,
    resolvePlan,
    watermark,
    resolutionPlanned,
    resolutionObserved,
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

  // The manual summary reaches PR_DRAFT before Codex status, and this rollout
  // is draft for its whole life, so it can never hand back the request body.
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

test("a gate minted before supersession stops verifying after it", async (t) => {
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
    (payload) => {
      payload.pull_request.is_draft = false;
      return failingCheck(payload);
    },
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

  // Now the repair lands. Refusing to mint a new gate is not enough: the one
  // already minted must stop carrying authority for a head the workflow has
  // replaced.
  const repaired = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    repairing.revision,
    await commit(state.repository, "export const value = 3;\n"),
  );
  assert.equal(repaired.current_publication, null);
  git(state.repository, "checkout", "--detach", headSha);
  const verified = await verifyPublicationGate(state.store, reviewId, {
    clock: () => laterAt + 40,
  });
  assert.equal(verified.valid, false);
  assert.equal(verified.reason, "GATE_MISMATCH");
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
  const forged = JSON.parse(await fsp.readFile(gatePath, "utf8"));
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

  // The pre-read is the last check before the call, and it binds the exact
  // pull request and head: a drifted head never becomes an executing proof.
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
        head_sha: "9".repeat(40),
        is_draft: true,
      },
    ),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
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
  // A pull request still draft after the call is not a reconciled mark-ready.
  await assert.rejects(
    observe({ isDraft: true }),
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
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "AWAIT_OPERATOR",
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

  // The pull request is out of draft, so no repair phase may run: this stage
  // cannot return it to draft, and advancing anyway would let the workflow
  // rewrite an exposed head.
  await assert.rejects(
    advanceRemoteWorkflow(state.store, workflow.workflow_id, ready.revision),
    (error) => error.code === "WORKFLOW_PHASE_INVALID",
  );
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

  // The same refusal on an executing action never drops it. A pre-read
  // reporting the pull request still draft is not proof the call did not
  // land -- a timeout or a lagging read says exactly that while it does --
  // and GitHub attests no actor for a draft transition, so nothing can
  // settle it. The intent survives as the record of what to reconcile.
  const regressedAt = clearedAt + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 5,
      observation: failingCheck(
        draftObservation(state, headSha, {
          at: regressedAt,
          requestId: 100,
          requestAt: at + 1_000,
        }),
      ),
    },
    { clock: () => regressedAt + 10 },
  );
  const stillDraftProof = {
    repository_id: REPOSITORY_ID,
    pr_number: PR_NUMBER,
    base_branch: "main",
    head_branch: TOPIC_BRANCH,
    head_sha: headSha,
    is_draft: true,
  };
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      executing.revision,
      replanned.action.action_id,
      stillDraftProof,
    ),
    (error) =>
      error.code === "WORKFLOW_PUBLICATION_NOT_READY" &&
      error.details.action_abandoned === undefined,
  );
  const surviving = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(surviving.active_action.status, "EXECUTING");

  // Its exit is the pause that exists for exactly this: an external write
  // whose outcome the driver cannot establish.
  const paused = await pauseAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    surviving.revision,
    {
      reasonCode: "EXTERNAL_ACTION_INDETERMINATE",
      blockedAction: "MARK_PR_READY",
      evidence: "the clearance regressed while the mark-ready call was in flight",
    },
  );
  assert.equal(paused.phase, "PAUSED_HUMAN");

  // And once the publication clears again the operator resumes into the same
  // checkpoint, which now passes: recovery re-stamps the pre-read and the
  // outcome follows the reading that preceded the surviving call.
  const recoveredAt = regressedAt + 10_000;
  await recordGithubSnapshot(
    state.store,
    reviewId,
    {
      expectedRevision: 6,
      observation: draftObservation(state, headSha, {
        at: recoveredAt,
        requestId: 100,
        requestAt: at + 1_000,
      }),
    },
    { clock: () => recoveredAt + 10 },
  );
  const resumed = await resumeAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    paused.revision,
    {
      operatorLabel: "jeremy",
      rationale: "the pull request is still draft and the checks pass again",
    },
  );
  assert.equal(resumed.phase, "PRE_READY");
  assert.equal(resumed.active_action.status, "EXECUTING");

  // The operator's reconciliation found the pull request already ready. The
  // stored pre-read is stale -- it says draft -- but claiming nothing needs
  // no permission, so the honest report is available without a re-entry and
  // without choosing between a false claim and cancelling the workflow.
  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    resumed.revision,
    replanned.action.action_id,
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
    replanned.action.action_id,
  );
  assert.equal(ready.phase, "POST_READY");
  assert.equal(ready.ready_marks[0].outcome, "OBSERVED_ALREADY_READY");
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

test("a crashed mark-ready re-enters its own pre-write checkpoint", async (t) => {
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

  // The driver died between this checkpoint and the provider call. Recovery
  // re-enters the external write, so it re-enters the checkpoint that guards
  // it: a clearance that regressed while the driver was gone refuses here,
  // exactly as it would have before the crash.
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
  // The pre-read says the call landed -- the pull request is out of draft --
  // so the refusal cannot drop the intent: that intent is the only record of
  // what still has to be reconciled.
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      executing.revision,
      planned.action.action_id,
      { ...proof, is_draft: false },
    ),
    (error) =>
      error.code === "WORKFLOW_PUBLICATION_NOT_READY" &&
      error.details.action_abandoned === undefined,
  );
  const stillExecuting = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(stillExecuting.active_action.status, "EXECUTING");

  // Once it clears again, the re-entry succeeds and re-stamps the pre-read,
  // so the outcome is decided by what the recovering driver actually saw
  // rather than by a reading from before the crash.
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
  const reentered = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    stillExecuting.revision,
    planned.action.action_id,
    { ...proof, is_draft: false },
  );
  assert.equal(reentered.active_action.status, "EXECUTING");
  assert.equal(reentered.active_action.executing_proof.is_draft, false);
  // The checkpoint's clearance is part of the action from EXECUTING onward,
  // because the completed record names it. A ledger missing it is invalid,
  // not silently plan-time.
  const executingPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const storedExecuting = JSON.parse(await fsp.readFile(executingPath, "utf8"));
  const withoutClearance = structuredClone(storedExecuting);
  delete withoutClearance.active_action.cleared_publication_revision;
  await atomicWriteCanonicalJson(executingPath, withoutClearance);
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) => error.code === "WORKFLOW_ACTION_INVALID",
  );
  await atomicWriteCanonicalJson(executingPath, storedExecuting);

  const observed = await recordMarkReadyObservation(
    state.store,
    workflow.workflow_id,
    reentered.revision,
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
  // And the stored record is validated on every read, so a rewritten
  // outcome cannot pass as evidence of a mark this workflow performed.
  const readyPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const storedReady = JSON.parse(await fsp.readFile(readyPath, "utf8"));
  const forgedReady = structuredClone(storedReady);
  forgedReady.ready_marks[0].outcome = "MARKED_READY_BY_HAND";
  await atomicWriteCanonicalJson(readyPath, forgedReady);
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) => error.code === "WORKFLOW_STATE_INVALID",
  );
  await atomicWriteCanonicalJson(readyPath, storedReady);
  // The record names the clearance that authorized the write, which here is
  // the one the re-entry read -- not the one the plan read two publication
  // revisions earlier.
  const clearedRevision = (await getAutonomousPreReady(state.store, reviewId))
    .revision;
  assert.equal(ready.ready_marks[0].publication_revision, clearedRevision);
  assert.notEqual(
    ready.ready_marks[0].publication_revision,
    planned.action.target.publication_revision,
  );
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
