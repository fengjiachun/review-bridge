import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  advanceLocalWorkflow,
  AUTONOMOUS_CAPABILITIES,
  bindWorkflowReview,
  cancelAutonomousWorkflow,
  completeWorkflowAction,
  getAutonomousWorkflow,
  getAutonomousWorkflowSummary,
  markWorkflowActionExecuting,
  pauseAutonomousWorkflow,
  planCodexTaskDispatch,
  recordCodexTaskObservation,
  recordWorkflowHead,
  releaseWorkflowClaims,
  startAutonomousWorkflow,
} from "../src/workflow.mjs";
import { canonicalJson, sha256 } from "../src/storage.mjs";

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
    path.join(os.tmpdir(), "review-bridge-workflow-"),
  );
  const repository = path.join(root, "repo");
  const store = path.join(root, "store");
  await fsp.mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Review Bridge Test");
  git(repository, "config", "user.email", "review-bridge@example.invalid");
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 1;\n");
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
  git(repository, "switch", "-c", "agent/workflow-core");
  return { root, repository, store, baseSha };
}

function workflowInput(repository, baseSha, overrides = {}) {
  return {
    repositoryPath: repository,
    baseRef: baseSha,
    baseSha,
    requirement: "Implement the autonomous local review workflow.",
    implementationScope:
      "Add the workflow ledger, ownership, task dispatch, and local loop.",
    topicBranch: "agent/workflow-core",
    operatorLabel: "Test Operator",
    capabilities: [...AUTONOMOUS_CAPABILITIES],
    publicationTarget: {
      base_repository_id: 101,
      base_owner: "example",
      base_repo: "review-bridge",
      base_branch: "main",
      head_repository_id: 101,
      head_owner: "example",
      head_repo: "review-bridge",
      head_branch: "agent/workflow-core",
      push_remote: "origin",
    },
    ...overrides,
  };
}

async function commitImplementation(repository, content = "export const value = 2;\n") {
  await fsp.writeFile(path.join(repository, "app.js"), content);
  git(repository, "add", ".");
  git(repository, "commit", "-m", "implement workflow fixture");
  return git(repository, "rev-parse", "HEAD");
}

async function prepareBoundWorkflow(fixtureState) {
  const { repository, store, baseSha } = fixtureState;
  const workflow = await startAutonomousWorkflow(
    store,
    workflowInput(repository, baseSha),
  );
  const headSha = await commitImplementation(repository);
  const recorded = await recordWorkflowHead(
    store,
    workflow.workflow_id,
    workflow.revision,
    headSha,
  );
  const review = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: workflow.requirement,
    implementationScope: workflow.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  const bound = await bindWorkflowReview(
    store,
    workflow.workflow_id,
    recorded.revision,
    review.id,
  );
  return { workflow: bound, review, headSha };
}

async function dispatchReviewer(store, workflowId, revision, reviewId) {
  const planned = await planCodexTaskDispatch(
    store,
    workflowId,
    revision,
    reviewId,
  );
  const executing = await markWorkflowActionExecuting(
    store,
    workflowId,
    planned.workflow.revision,
    planned.action.action_id,
  );
  const observed = await recordCodexTaskObservation(
    store,
    workflowId,
    executing.revision,
    planned.action.action_id,
    {
      matchingTaskIds: ["task-123"],
      taskId: "task-123",
      title: planned.dispatch.title,
      prompt: planned.dispatch.prompt,
    },
  );
  const completed = await completeWorkflowAction(
    store,
    workflowId,
    observed.revision,
    planned.action.action_id,
  );
  return { planned, completed };
}

function claimReleaseEvidence(workflow, observedAt = new Date().toISOString()) {
  return workflow.claims
    .filter((claim) => claim.disposition === "ACTIVE")
    .map((claim) => ({
      kind: claim.kind,
      canonical_key_sha256: claim.canonical_key_sha256,
      target: claim.target,
      workflow_revision: workflow.revision,
      present: false,
      observed_at: observedAt,
    }));
}

test("workflow start binds immutable authorization and exclusive claims", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const summary = await getAutonomousWorkflowSummary(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(workflow.status, "ACTIVE");
  assert.equal(workflow.phase, "IMPLEMENTING");
  assert.equal(workflow.revision, 1);
  assert.equal(summary.next_action, "COMMIT_HEAD");
  assert.match(
    workflow.authorization.workflow_authorization_sha256,
    /^[0-9a-f]{64}$/,
  );
  assert.deepEqual(workflow.authorization.capabilities, [
    ...AUTONOMOUS_CAPABILITIES,
  ]);
  assert.equal(workflow.authorization.scope.base_sha, state.baseSha);
  assert.equal(
    workflow.authorization.scope.repository.git_common_dir,
    workflow.repository.git_common_dir,
  );
  assert.equal(workflow.claims.length, 2);
  assert.equal(
    workflow.repository.git_common_dir,
    await fsp.realpath(path.join(state.repository, ".git")),
  );

  await assert.rejects(
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    ),
    /WORKFLOW_OWNERSHIP_CONFLICT/,
  );

  const claims = JSON.parse(
    await fsp.readFile(
      path.join(state.store, "workflow-claims.json"),
      "utf8",
    ),
  );
  assert.equal(claims.claims.length, 2);
  assert.equal(
    claims.claims.every((claim) => claim.disposition === "ACTIVE"),
    true,
  );
});

test("concurrent starts admit exactly one owner", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  const results = await Promise.allSettled([
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    ),
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    ),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "WORKFLOW_OWNERSHIP_CONFLICT");

  const claims = JSON.parse(
    await fsp.readFile(
      path.join(state.store, "workflow-claims.json"),
      "utf8",
    ),
  );
  assert.equal(claims.claims.length, 2);
  assert.equal(new Set(claims.claims.map((entry) => entry.workflow_id)).size, 1);
});

test("claim journal aborts a pre-workflow start and rolls forward a persisted workflow", async (t) => {
  const abortedState = await fixture();
  const recoveredState = await fixture();
  t.after(() => fsp.rm(abortedState.root, { recursive: true, force: true }));
  t.after(() => fsp.rm(recoveredState.root, { recursive: true, force: true }));

  await fsp.mkdir(abortedState.store, { recursive: true, mode: 0o700 });
  const orphanedTransaction = {
    transaction_id: `rbwfct-${"1".repeat(32)}`,
    operation: "START",
    state: "PREPARED",
    workflow_id: "rbwf-2026-01-01T000000-000Z-deadbeef",
    workflow_revision: 1,
    claims: [
      {
        kind: "LOCAL_BRANCH",
        canonical_key_sha256: "2".repeat(64),
      },
    ],
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  await fsp.writeFile(
    path.join(abortedState.store, "workflow-claims.json"),
    `${canonicalJson({
      version: 1,
      claims: [],
      transactions: [orphanedTransaction],
    })}\n`,
    { mode: 0o600 },
  );
  await startAutonomousWorkflow(
    abortedState.store,
    workflowInput(abortedState.repository, abortedState.baseSha),
  );
  const abortedRegistry = JSON.parse(
    await fsp.readFile(
      path.join(abortedState.store, "workflow-claims.json"),
      "utf8",
    ),
  );
  assert.equal(abortedRegistry.transactions[0].state, "ABORTED");

  const workflow = await startAutonomousWorkflow(
    recoveredState.store,
    workflowInput(recoveredState.repository, recoveredState.baseSha),
  );
  const registryPath = path.join(
    recoveredState.store,
    "workflow-claims.json",
  );
  const interruptedRegistry = JSON.parse(
    await fsp.readFile(registryPath, "utf8"),
  );
  const startTransaction = interruptedRegistry.transactions.find(
    (entry) => entry.workflow_id === workflow.workflow_id,
  );
  startTransaction.state = "PREPARED";
  startTransaction.completed_at = null;
  interruptedRegistry.claims = interruptedRegistry.claims.filter(
    (entry) => entry.workflow_id !== workflow.workflow_id,
  );
  await fsp.writeFile(
    registryPath,
    `${canonicalJson(interruptedRegistry)}\n`,
    { mode: 0o600 },
  );

  await getAutonomousWorkflow(
    recoveredState.store,
    workflow.workflow_id,
  );
  const recoveredRegistry = JSON.parse(
    await fsp.readFile(registryPath, "utf8"),
  );
  assert.equal(
    recoveredRegistry.transactions.find(
      (entry) => entry.workflow_id === workflow.workflow_id,
    ).state,
    "COMMITTED",
  );
  assert.equal(
    recoveredRegistry.claims.filter(
      (entry) => entry.workflow_id === workflow.workflow_id,
    ).length,
    2,
  );
});

test("workflow start rejects authorization and repository drift", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  await assert.rejects(
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha, {
        capabilities: AUTONOMOUS_CAPABILITIES.slice(1),
      }),
    ),
    /capabilities must equal the autonomous capability set/,
  );

  await fsp.writeFile(path.join(state.repository, "dirty.txt"), "dirty\n");
  await assert.rejects(
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    ),
    /working tree must be clean/,
  );
});

test("committed heads are clean, descendant, append-only attempts", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commitImplementation(state.repository);
  const dirtyPath = path.join(state.repository, "dirty.txt");
  await fsp.writeFile(dirtyPath, "dirty\n");
  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      workflow.revision,
      headSha,
    ),
    /working tree must be clean/,
  );
  await fsp.unlink(dirtyPath);

  const recorded = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    1,
    headSha,
  );
  assert.equal(recorded.revision, 2);
  assert.equal(recorded.phase, "PREPARE_LOCAL_REVIEW");
  assert.equal(recorded.current_head_sha, headSha);
  assert.deepEqual(recorded.attempts, [
    {
      number: 1,
      head_sha: headSha,
      review_id: null,
      recorded_at: recorded.attempts[0].recorded_at,
    },
  ]);

  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      1,
      headSha,
    ),
    /workflow revision mismatch/,
  );
});

test("initial autonomous review rejects an overlay-bearing snapshot", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commitImplementation(state.repository);
  const recorded = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    headSha,
  );
  await fsp.writeFile(
    path.join(state.repository, "app.js"),
    "export const value = 'uncommitted';\n",
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: workflow.requirement,
    implementationScope: workflow.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });

  await assert.rejects(
    bindWorkflowReview(
      state.store,
      workflow.workflow_id,
      recorded.revision,
      review.id,
    ),
    /WORKFLOW_REVIEW_DIRTY/,
  );
});

test("Codex task dispatch is marker-bound and cannot skip action states", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);

  await assert.rejects(
    advanceLocalWorkflow(
      state.store,
      workflow.workflow_id,
      workflow.revision,
    ),
    /WORKFLOW_REVIEWER_TASK_REQUIRED/,
  );

  const planned = await planCodexTaskDispatch(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  assert.equal(planned.action.status, "PLANNED");
  assert.equal(planned.action.kind, "CREATE_CODEX_REVIEWER_TASK");
  assert.equal(planned.action.ownership_claim.kind, "LOCAL_BRANCH");
  assert.match(
    planned.action.ownership_claim.canonical_key_sha256,
    /^[0-9a-f]{64}$/,
  );
  assert.match(planned.dispatch.marker, /^rbwf-dispatch-[0-9a-f]{32}$/);
  assert.match(planned.dispatch.title, new RegExp(planned.dispatch.marker));
  assert.match(planned.dispatch.prompt, new RegExp(planned.dispatch.marker));
  const reloaded = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  const reloadedSummary = await getAutonomousWorkflowSummary(
    state.store,
    workflow.workflow_id,
  );
  assert.deepEqual(reloaded.active_action.dispatch, planned.dispatch);
  assert.deepEqual(reloadedSummary.active_action.dispatch, planned.dispatch);
  const recoveredActionId = reloaded.active_action.action_id;
  const recoveredDispatch = reloaded.active_action.dispatch;

  await assert.rejects(
    recordCodexTaskObservation(
      state.store,
      workflow.workflow_id,
      planned.workflow.revision,
      recoveredActionId,
      {
        matchingTaskIds: ["task-123"],
        taskId: "task-123",
        title: recoveredDispatch.title,
        prompt: recoveredDispatch.prompt,
      },
    ),
    /action must be EXECUTING/,
  );

  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    recoveredActionId,
  );
  await assert.rejects(
    recordCodexTaskObservation(
      state.store,
      workflow.workflow_id,
      executing.revision,
      recoveredActionId,
      {
        matchingTaskIds: ["task-123", "task-456"],
        taskId: "task-123",
        title: recoveredDispatch.title,
        prompt: recoveredDispatch.prompt,
      },
    ),
    /exactly one matching task/,
  );

  const observed = await recordCodexTaskObservation(
    state.store,
    workflow.workflow_id,
    executing.revision,
    recoveredActionId,
    {
      matchingTaskIds: ["task-123"],
      taskId: "task-123",
      title: recoveredDispatch.title,
      prompt: recoveredDispatch.prompt,
    },
  );
  assert.equal(observed.active_action.status, "OBSERVED");
  const completed = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    observed.revision,
    recoveredActionId,
  );
  assert.equal(completed.active_action, null);
  assert.equal(completed.phase, "WAIT_LOCAL_REVIEW");
  assert.equal(completed.reviewer_task.task_id, "task-123");

  const audit = (
    await fsp.readFile(
      path.join(
        state.store,
        "workflows",
        workflow.workflow_id,
        "action-audit.jsonl",
      ),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    audit.map((event) => event.event),
    [
      "ACTION_PLANNED",
      "ACTION_EXECUTING",
      "ACTION_OBSERVED",
      "ACTION_COMPLETED",
    ],
  );
  assert.equal(audit[0].previous_event_sha256, null);
  assert.match(audit.at(-1).event_sha256, /^[0-9a-f]{64}$/);
});

test("active action tampering fails before another external transition", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  await planCodexTaskDispatch(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const mutations = [
    (action) => {
      action.correlation_marker = `rbwf-dispatch-${"0".repeat(32)}`;
    },
    (action) => {
      action.target.review_id = "rb-tampered-review";
    },
    (action) => {
      action.authorization_sha256 = "0".repeat(64);
    },
    (action) => {
      action.ownership_claim.canonical_key_sha256 = "0".repeat(64);
    },
    (action) => {
      action.status = "EXECUTING";
      action.executing_at = new Date().toISOString();
    },
    (action) => {
      action.dispatch.title = "Tampered task title";
    },
    (action) => {
      action.planned_at = new Date(
        Date.parse(action.planned_at) + 1_000,
      ).toISOString();
    },
  ];

  for (const mutate of mutations) {
    const tampered = structuredClone(stored);
    mutate(tampered.active_action);
    await fsp.writeFile(workflowPath, `${canonicalJson(tampered)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      getAutonomousWorkflow(state.store, workflow.workflow_id),
      /WORKFLOW_ACTION_INVALID|WORKFLOW_AUDIT_CORRUPT/,
    );
  }
});

test("action audit recovery replays one committed event and truncates a partial tail", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const workflowRoot = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
  );
  const workflowPath = path.join(workflowRoot, "workflow.json");
  const auditPath = path.join(workflowRoot, "action-audit.jsonl");
  const beforePlan = await fsp.readFile(workflowPath);

  const planned = await planCodexTaskDispatch(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  await fsp.writeFile(workflowPath, beforePlan, { mode: 0o600 });

  const recovered = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(recovered.revision, planned.workflow.revision);
  assert.equal(recovered.active_action.status, "PLANNED");
  assert.equal(
    recovered.action_audit.last_event_sha256,
    planned.workflow.action_audit.last_event_sha256,
  );

  const committedSize = (await fsp.stat(auditPath)).size;
  await fsp.appendFile(auditPath, '{"partial"', { mode: 0o600 });
  assert.ok((await fsp.stat(auditPath)).size > committedSize);
  assert.equal(
    (await getAutonomousWorkflow(state.store, workflow.workflow_id)).revision,
    planned.workflow.revision,
  );
  assert.equal((await fsp.stat(auditPath)).size, committedSize);
});

test("missing task orchestration pauses with its active intent intact", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const planned = await planCodexTaskDispatch(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  const paused = await pauseAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    {
      reasonCode: "TASK_ORCHESTRATION_UNAVAILABLE",
      blockedAction: "CREATE_CODEX_REVIEWER_TASK",
      evidence: "The Codex client cannot enumerate matching task markers.",
    },
  );
  assert.equal(paused.status, "PAUSED");
  assert.equal(paused.pause.reason_code, "TASK_ORCHESTRATION_UNAVAILABLE");
  assert.equal(paused.active_action.action_id, planned.action.action_id);
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "AWAIT_OPERATOR",
  );
});

test("a clean independent review advances the local workflow to its PR1 boundary", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review, headSha } = await prepareBoundWorkflow(state);
  const { completed } = await dispatchReviewer(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );

  await submitInitialReview(state.store, review.id, [], "CODEX_TASK");
  const clean = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    completed.revision,
  );
  assert.equal(clean.phase, "FINALIZE_LOCAL_GATE");
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "FINALIZE_LOCAL_GATE",
  );

  await finalizeLocalGate(state.store, review.id);
  const gated = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    clean.revision,
  );
  assert.equal(gated.phase, "LOCAL_GATE_PASSED");
  assert.equal(gated.status, "ACTIVE");
  assert.equal(gated.current_head_sha, headSha);
  assert.equal(gated.attempts.at(-1).review_id, review.id);
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "PUBLISH_GATED_HEAD",
  );
});

test("round-two advancement rejects an overlay-bearing snapshot", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const { completed } = await dispatchReviewer(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  await submitInitialReview(
    state.store,
    review.id,
    [
      {
        severity: "major",
        title: "Fix the committed value",
        explanation: "The committed value needs a second revision.",
      },
    ],
    "CODEX_TASK",
  );
  const findings = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    completed.revision,
  );
  const fixedHead = await commitImplementation(
    state.repository,
    "export const value = 3;\n",
  );
  const fixed = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    findings.revision,
    fixedHead,
  );
  await submitResolutions(state.store, review.id, [
    {
      finding_id: "F-001",
      disposition: "fixed",
      rationale: "Committed the requested value.",
      evidence: "The new head contains the fix.",
    },
  ]);
  const responded = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    fixed.revision,
  );
  await fsp.writeFile(
    path.join(state.repository, "overlay.js"),
    "export const overlay = true;\n",
  );
  await prepareRereview(state.store, review.id);

  await assert.rejects(
    advanceLocalWorkflow(
      state.store,
      workflow.workflow_id,
      responded.revision,
    ),
    /WORKFLOW_REVIEW_DIRTY/,
  );
});

test("an author human-required resolution pauses without preparing round two", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const { completed } = await dispatchReviewer(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  await submitInitialReview(
    state.store,
    review.id,
    [
      {
        severity: "major",
        title: "Requires operator policy",
        explanation: "The implementation depends on an operator decision.",
      },
    ],
    "CODEX_TASK",
  );
  const findings = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    completed.revision,
  );
  await submitResolutions(state.store, review.id, [
    {
      finding_id: "F-001",
      disposition: "human_required",
      rationale: "Only the operator can choose the required policy.",
    },
  ]);

  const paused = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    findings.revision,
  );
  assert.equal(paused.status, "PAUSED");
  assert.equal(paused.phase, "PAUSED_HUMAN");
  assert.equal(paused.pause.reason_code, "LOCAL_REVIEW_HUMAN_REQUIRED");
  assert.equal(paused.pause.review_id, review.id);
  const reviewState = await getReviewSummary(state.store, review.id);
  assert.equal(reviewState.status, "HUMAN_REQUIRED");
  assert.equal(reviewState.current_round, 1);
});

test("a resolved round-two review reaches the local gate on the fixed head", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const { completed } = await dispatchReviewer(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  await submitInitialReview(
    state.store,
    review.id,
    [
      {
        severity: "major",
        title: "Fix the committed value",
        explanation: "The committed value needs a second revision.",
      },
    ],
    "CODEX_TASK",
  );
  const findings = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    completed.revision,
  );
  const fixedHead = await commitImplementation(
    state.repository,
    "export const value = 3;\n",
  );
  const fixed = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    findings.revision,
    fixedHead,
  );
  await submitResolutions(state.store, review.id, [
    {
      finding_id: "F-001",
      disposition: "fixed",
      rationale: "Committed the requested value.",
      evidence: "The descendant head contains the fix.",
    },
  ]);
  const responded = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    fixed.revision,
  );
  await prepareRereview(state.store, review.id);
  const waiting = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    responded.revision,
  );
  await submitRereview(
    state.store,
    review.id,
    [
      {
        finding_id: "F-001",
        decision: "resolved",
        rationale: "The committed descendant fixes the finding.",
      },
    ],
    [],
    "CODEX_TASK",
  );
  const clean = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(clean.phase, "FINALIZE_LOCAL_GATE");
  assert.equal(clean.current_review.status, "CLEAN");
  assert.equal(clean.current_review.head_sha, fixedHead);

  await finalizeLocalGate(state.store, review.id);
  const gated = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    clean.revision,
  );
  assert.equal(gated.phase, "LOCAL_GATE_PASSED");
  assert.equal(gated.current_head_sha, fixedHead);
  assert.equal(gated.current_review.status, "LOCAL_GATE_PASSED");
});

test("round-two unresolved findings pause without creating a third round", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const { completed } = await dispatchReviewer(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  await submitInitialReview(
    state.store,
    review.id,
    [
      {
        severity: "major",
        title: "Missing stable contract",
        explanation: "The changed value is undocumented.",
      },
    ],
    "CODEX_TASK",
  );
  const findings = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    completed.revision,
  );
  assert.equal(findings.phase, "ADDRESS_LOCAL_FINDINGS");

  const fixedHead = await commitImplementation(
    state.repository,
    "export const value = 3;\n",
  );
  const fixed = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    findings.revision,
    fixedHead,
  );
  assert.equal(fixed.attempts.length, 2);
  assert.equal(fixed.attempts.at(-1).review_id, review.id);

  await submitResolutions(state.store, review.id, [
    {
      finding_id: "F-001",
      disposition: "fixed",
      rationale: "Updated the contract-bearing value.",
      evidence: "fixture verification",
    },
  ]);
  const responded = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    fixed.revision,
  );
  assert.equal(responded.phase, "PREPARE_REREVIEW");

  await prepareRereview(state.store, review.id);
  const rereview = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    responded.revision,
  );
  assert.equal(rereview.phase, "WAIT_LOCAL_REREVIEW");

  await submitRereview(
    state.store,
    review.id,
    [
      {
        finding_id: "F-001",
        decision: "still_open",
        rationale: "The public contract remains unspecified.",
      },
    ],
    [],
    "CODEX_TASK",
  );
  const paused = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    rereview.revision,
  );
  assert.equal(paused.status, "PAUSED");
  assert.equal(paused.phase, "PAUSED_HUMAN");
  assert.equal(paused.pause.reason_code, "LOCAL_REVIEW_HUMAN_REQUIRED");
  assert.equal(paused.pause.review_id, review.id);
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "HUMAN_ARBITRATION",
  );
  await assert.rejects(
    advanceLocalWorkflow(
      state.store,
      workflow.workflow_id,
      paused.revision,
    ),
    /workflow is not active/,
  );
});

test("cancellation retains claims until exact reconciled release", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "Stop the test workflow.",
    },
  );
  assert.equal(cancelled.status, "CANCELLED");

  await assert.rejects(
    releaseWorkflowClaims(
      state.store,
      workflow.workflow_id,
      cancelled.revision,
      {
        operatorLabel: "Test Operator",
        rationale: "No external objects remain.",
        reconciledClaims: [],
      },
    ),
    /reconciliation must cover every active claim/,
  );

  const released = await releaseWorkflowClaims(
    state.store,
    workflow.workflow_id,
    cancelled.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "No external objects remain.",
      reconciledClaims: claimReleaseEvidence(cancelled),
    },
  );
  assert.equal(
    released.claims.every((claim) => claim.disposition === "RELEASED"),
    true,
  );
  const claims = JSON.parse(
    await fsp.readFile(
      path.join(state.store, "workflow-claims.json"),
      "utf8",
    ),
  );
  assert.equal(
    claims.claims.every((claim) => claim.disposition === "RELEASED"),
    true,
  );
});

test("claim journal rolls back and rolls forward interrupted releases", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "Stop the test workflow.",
    },
  );
  const registryPath = path.join(state.store, "workflow-claims.json");
  const interrupted = JSON.parse(
    await fsp.readFile(registryPath, "utf8"),
  );
  const releaseTransaction = {
    transaction_id: `rbwfct-${"3".repeat(32)}`,
    operation: "RELEASE",
    state: "PREPARED",
    workflow_id: workflow.workflow_id,
    workflow_revision: cancelled.revision,
    claims: cancelled.claims.map((entry) => ({
      kind: entry.kind,
      canonical_key_sha256: entry.canonical_key_sha256,
    })),
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  interrupted.transactions.push(releaseTransaction);
  for (const entry of interrupted.claims) {
    entry.disposition = "RELEASED";
    entry.released_at = releaseTransaction.created_at;
  }
  await fsp.writeFile(
    registryPath,
    `${canonicalJson(interrupted)}\n`,
    { mode: 0o600 },
  );

  await getAutonomousWorkflow(state.store, workflow.workflow_id);
  const rolledBack = JSON.parse(
    await fsp.readFile(registryPath, "utf8"),
  );
  assert.equal(
    rolledBack.transactions.find(
      (entry) =>
        entry.transaction_id === releaseTransaction.transaction_id,
    ).state,
    "ABORTED",
  );
  assert.equal(
    rolledBack.claims.every((entry) => entry.disposition === "ACTIVE"),
    true,
  );

  const released = await releaseWorkflowClaims(
    state.store,
    workflow.workflow_id,
    cancelled.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "No external objects remain.",
      reconciledClaims: claimReleaseEvidence(cancelled),
    },
  );
  const committed = JSON.parse(
    await fsp.readFile(registryPath, "utf8"),
  );
  const committedRelease = committed.transactions.findLast(
    (entry) =>
      entry.workflow_id === workflow.workflow_id &&
      entry.operation === "RELEASE" &&
      entry.state === "COMMITTED",
  );
  committedRelease.state = "PREPARED";
  committedRelease.completed_at = null;
  await fsp.writeFile(
    registryPath,
    `${canonicalJson(committed)}\n`,
    { mode: 0o600 },
  );

  await getAutonomousWorkflow(state.store, workflow.workflow_id);
  const rolledForward = JSON.parse(
    await fsp.readFile(registryPath, "utf8"),
  );
  assert.equal(
    rolledForward.transactions.find(
      (entry) =>
        entry.transaction_id === committedRelease.transaction_id,
    ).state,
    "COMMITTED",
  );
  assert.equal(
    released.claims.every((entry) => entry.disposition === "RELEASED"),
    true,
  );
});

test("claim release rejects stale, future, revision-mismatched, and retargeted evidence", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "Stop before publication.",
    },
  );
  const release = (reconciledClaims) =>
    releaseWorkflowClaims(
      state.store,
      workflow.workflow_id,
      cancelled.revision,
      {
        operatorLabel: "Test Operator",
        rationale: "No claimed object remains.",
        reconciledClaims,
      },
    );

  await assert.rejects(
    release(
      claimReleaseEvidence(
        cancelled,
        new Date(
          Date.parse(cancelled.cancellation.cancelled_at) - 1,
        ).toISOString(),
      ),
    ),
    /WORKFLOW_RELEASE_EVIDENCE_INVALID/,
  );
  await assert.rejects(
    release(
      claimReleaseEvidence(
        cancelled,
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ),
    /WORKFLOW_RELEASE_EVIDENCE_INVALID/,
  );
  const wrongRevision = claimReleaseEvidence(cancelled);
  wrongRevision[0].workflow_revision -= 1;
  await assert.rejects(
    release(wrongRevision),
    /WORKFLOW_RELEASE_EVIDENCE_INVALID/,
  );
  const retargeted = claimReleaseEvidence(cancelled);
  retargeted[0].target = {
    ...retargeted[0].target,
    topic_branch: "agent/other",
  };
  await assert.rejects(
    release(retargeted),
    /WORKFLOW_RELEASE_EVIDENCE_INVALID/,
  );
});

test("unknown workflow schemas and authorization tampering fail closed", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  stored.authorization.operator_label = "Tampered";
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    /workflow authorization digest mismatch/,
  );

  stored.version = 2;
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    /unsupported workflow schema version/,
  );
});

test("authorization digest binds every immutable workflow scope field", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const mutations = [
    (value) => {
      value.repository.path = `${value.repository.path}-other`;
    },
    (value) => {
      value.repository.git_common_dir =
        `${value.repository.git_common_dir}-other`;
    },
    (value) => {
      value.base_ref = "refs/heads/other";
    },
    (value) => {
      value.base_sha = `${value.base_sha[0] === "0" ? "1" : "0"}${value.base_sha.slice(1)}`;
    },
    (value) => {
      value.requirement = "Tampered requirement";
    },
    (value) => {
      value.implementation_scope = "Tampered scope";
    },
    (value) => {
      value.topic_branch = "agent/other";
    },
  ];
  for (const mutate of mutations) {
    const tampered = structuredClone(stored);
    mutate(tampered);
    await fsp.writeFile(workflowPath, `${canonicalJson(tampered)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      getAutonomousWorkflow(state.store, workflow.workflow_id),
      /WORKFLOW_AUTHORIZATION_INVALID/,
    );
  }
});

test("derived ownership claims stay bound to the authorized scope", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const branchClaim = stored.claims.find(
    (entry) => entry.kind === "LOCAL_BRANCH",
  );
  branchClaim.target.topic_branch = "agent/other";
  branchClaim.canonical_key_sha256 = sha256(
    canonicalJson(branchClaim.target),
  );
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    /does not match its authorized scope/,
  );
});

test("an active workflow fails closed after ownership loss", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const claimsPath = path.join(state.store, "workflow-claims.json");
  const claims = JSON.parse(await fsp.readFile(claimsPath, "utf8"));
  claims.claims[0].disposition = "RELEASED";
  claims.claims[0].released_at = new Date().toISOString();
  await fsp.writeFile(claimsPath, `${canonicalJson(claims)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    /WORKFLOW_OWNERSHIP_LOST/,
  );
});
