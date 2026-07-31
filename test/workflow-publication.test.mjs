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
  finalizePublicationGate,
  getAutonomousPreReady,
  getPublication,
  getPublicationSummary,
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
  getAutonomousWorkflowSummary,
  listAutonomousWorkflows,
  markWorkflowActionExecuting,
  planCodexTaskDispatch,
  planDraftPullRequest,
  planWorkflowPush,
  recordCodexTaskObservation,
  recordDraftPullRequestObservation,
  recordPushObservation,
  recordWorkflowHead,
  resumeAutonomousWorkflow,
  startAutonomousWorkflow,
} from "../src/workflow.mjs";
import { atomicWriteCanonicalJson, canonicalJson } from "../src/storage.mjs";
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
      nextAction: "AWAIT_OPERATOR",
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

  // The kill switch has to revoke what it granted.
  await assert.rejects(
    getAutonomousPreReady(state.store, reviewId),
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
