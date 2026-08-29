import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  getReviewSummary,
  openReview,
  prepareRereview,
  prepareReview,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";
import {
  acknowledgeChangeSizeWarning,
  advanceLocalWorkflow,
  AUTONOMOUS_CAPABILITIES,
  bindWorkflowReview,
  cancelAutonomousWorkflow,
  completeWorkflowAction,
  distinctUnresolveFindingReviews,
  extendChangeSizeBudget,
  extendLocalCycleBudget,
  getAutonomousWorkflow,
  getAutonomousWorkflowSummary,
  listAutonomousWorkflows,
  markWorkflowActionExecuting,
  pauseAutonomousWorkflow,
  planCodexTaskDispatch,
  planDraftPullRequest,
  planWorkflowPush,
  recordCodexTaskObservation,
  recordDraftPullRequestObservation,
  recordPushObservation,
  recordWorkflowHead,
  releaseWorkflowClaims,
  resumeAutonomousWorkflow,
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

function workflowAuditEvent(
  workflow,
  {
    sequence,
    previousEventSha256,
    eventId,
    at,
    event = "WORKFLOW_STATE_UPDATED",
    metadata = null,
  },
) {
  const unsigned = {
    version: 1,
    workflow_id: workflow.workflow_id,
    sequence,
    previous_event_sha256: previousEventSha256,
    event_id: eventId,
    at,
    event,
    ...(metadata == null ? {} : { metadata }),
    workflow_revision: workflow.revision,
    action_id: workflow.active_action?.action_id ?? null,
    workflow_state: {
      revision: workflow.revision,
      updated_at: workflow.updated_at,
      status: workflow.status,
      phase: workflow.phase,
      current_head_sha: workflow.current_head_sha,
      pull_request: workflow.pull_request,
      attempts: workflow.attempts,
      active_action: workflow.active_action,
      reviewer_task: workflow.reviewer_task,
      current_review: workflow.current_review,
      progress_fingerprint: workflow.progress_fingerprint,
      pause: workflow.pause,
      cancellation: workflow.cancellation,
      claims: workflow.claims,
      claim_release: workflow.claim_release ?? null,
    },
  };
  const auditEvent = {
    ...unsigned,
    event_sha256: sha256(canonicalJson(unsigned)),
  };
  return {
    event: auditEvent,
    bytes: Buffer.from(`${canonicalJson(auditEvent)}\n`),
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
      ...(claim.kind === "PULL_REQUEST"
        ? { present: true, open: false }
        : { present: false }),
      observed_at: observedAt,
    }));
}

test("repair head keeps every distinct safely drained findings review", () => {
  const first = { result_id: 11, reviewed_head_sha: "a".repeat(40) };
  const second = { result_id: 12, reviewed_head_sha: "b".repeat(40) };
  const current = { result_id: 15, reviewed_head_sha: "e".repeat(40) };
  assert.deepEqual(
    distinctUnresolveFindingReviews(
      [
        {
          publication_review_id: "rb-current",
          reason: "PINNED_CODEX_FOLLOW_UP",
          findings_review: first,
        },
        {
          publication_review_id: "rb-current",
          reason: "PINNED_CODEX_FOLLOW_UP",
          findings_review: second,
        },
        {
          publication_review_id: "rb-current",
          reason: "PINNED_CODEX_FOLLOW_UP",
          findings_review: first,
        },
        {
          publication_review_id: "rb-foreign",
          reason: "PINNED_CODEX_FOLLOW_UP",
          findings_review: { result_id: 13, reviewed_head_sha: "c".repeat(40) },
        },
        {
          publication_review_id: "rb-current",
          reason: "THREAD_RESOLUTION_UNSAFE",
          findings_review: { result_id: 14, reviewed_head_sha: "d".repeat(40) },
        },
      ],
      "rb-current",
      current,
    ),
    [first, second, current],
  );
  assert.deepEqual(
    distinctUnresolveFindingReviews(
      [
        {
          publication_review_id: "rb-current",
          reason: "PINNED_CODEX_FOLLOW_UP",
          findings_review: current,
        },
      ],
      "rb-current",
      current,
    ),
    [current],
  );
});

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

  const stored = JSON.parse(
    await fsp.readFile(
      path.join(
        state.store,
        "workflows",
        workflow.workflow_id,
        "workflow.json",
      ),
      "utf8",
    ),
  );
  assert.equal(stored.claims.length, 2);
  assert.equal(
    stored.claims.every((claim) => claim.disposition === "ACTIVE"),
    true,
  );
  await assert.rejects(
    fsp.stat(path.join(state.store, "workflow-claims.json")),
    (error) => error.code === "ENOENT",
  );
});

test("workflow repository paths normalize to the worktree root", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const subdirectory = path.join(state.repository, "nested");
  await fsp.mkdir(subdirectory);
  const repositoryRoot = await fsp.realpath(state.repository);
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(subdirectory, state.baseSha),
  );
  assert.equal(workflow.repository.path, repositoryRoot);
  assert.equal(
    workflow.authorization.scope.repository.path,
    repositoryRoot,
  );

  const headSha = await commitImplementation(state.repository);
  const recorded = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: subdirectory,
    baseRef: state.baseSha,
    requirement: workflow.requirement,
    implementationScope: workflow.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  const bound = await bindWorkflowReview(
    state.store,
    workflow.workflow_id,
    recorded.revision,
    review.id,
  );
  assert.equal(bound.current_review.review_id, review.id);
});

test("workflow start rejects a ledger that cannot reserve its cancellation", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const escaped = "\0".repeat(200_000);

  await assert.rejects(
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha, {
        requirement: escaped,
        implementationScope: escaped,
      }),
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_CANCELLATION_RESERVE_EXHAUSTED");
      return true;
    },
  );
  await assert.rejects(
    fsp.stat(path.join(state.store, "workflows")),
    (error) => error.code === "ENOENT",
  );

  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  assert.equal(workflow.status, "ACTIVE");
});

test("mutations reserve full cancellation persistence before any write", async (t) => {
  const maxWorkflowBytes = 2 * 1024 * 1024;
  const pessimisticCancelBytes = (candidate) => {
    const released = structuredClone(candidate);
    released.revision = Number.MAX_SAFE_INTEGER;
    released.updated_at = "9999-12-31T23:59:59.999Z";
    released.status = "CANCELLED";
    released.phase = "CANCELLED";
    released.pause = null;
    released.cancellation = {
      operator_label: "\0".repeat(1024),
      rationale: "x".repeat(32 * 1024 - 2),
      cancelled_at: "9999-12-31T23:59:59.999Z",
    };
    released.claims = released.claims.map((entry) => ({
      ...entry,
      disposition: "RELEASED",
      released_at: "9999-12-31T23:59:59.999Z",
    }));
    released.claim_release = {
      operator_label: "\0".repeat(1024),
      rationale: "x".repeat(32 * 1024 - 2),
      released_at: "9999-12-31T23:59:59.999Z",
      reconciliation: released.claims.map((entry) => ({
        kind: entry.kind,
        canonical_key_sha256: entry.canonical_key_sha256,
        target: structuredClone(entry.target),
        workflow_revision: Number.MAX_SAFE_INTEGER,
        present: false,
        observed_at: "9999-12-31T23:59:59.999Z",
      })),
    };
    released.action_audit = {
      next_sequence: Number.MAX_SAFE_INTEGER,
      last_event_sha256: "f".repeat(64),
    };
    return Buffer.byteLength(`${canonicalJson(released)}\n`);
  };
  const runBoundary = async (excessBytes) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const workflow = await startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    );
    const headSha = await commitImplementation(state.repository);
    const workflowRoot = path.join(
      state.store,
      "workflows",
      workflow.workflow_id,
    );
    const workflowPath = path.join(workflowRoot, "workflow.json");
    const auditPath = path.join(workflowRoot, "action-audit.jsonl");
    const auditHeadPath = path.join(
      workflowRoot,
      "action-audit-head.json",
    );
    const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
    stored.padding = "";
    const candidate = structuredClone(stored);
    candidate.current_head_sha = headSha;
    candidate.attempts.push({
      number: candidate.attempts.length + 1,
      head_sha: headSha,
      review_id: null,
      recorded_at: new Date().toISOString(),
    });
    candidate.phase = "PREPARE_LOCAL_REVIEW";
    candidate.revision += 1;
    candidate.updated_at = new Date().toISOString();
    const unpaddedBytes = pessimisticCancelBytes(candidate);
    stored.padding = "x".repeat(
      maxWorkflowBytes - unpaddedBytes + excessBytes,
    );
    candidate.padding = stored.padding;
    assert.equal(
      pessimisticCancelBytes(candidate),
      maxWorkflowBytes + excessBytes,
    );
    await fsp.writeFile(
      workflowPath,
      `${canonicalJson(stored)}\n`,
      { mode: 0o600 },
    );
    return { state, workflow, headSha, workflowPath, auditPath, auditHeadPath };
  };

  // The largest admissible state both mutates and later cancels with a
  // maximum-rationale operator decision that still fits every limit.
  const admitted = await runBoundary(0);
  const recorded = await recordWorkflowHead(
    admitted.state.store,
    admitted.workflow.workflow_id,
    admitted.workflow.revision,
    admitted.headSha,
  );
  assert.equal(recorded.phase, "PREPARE_LOCAL_REVIEW");
  const cancelled = await cancelAutonomousWorkflow(
    admitted.state.store,
    admitted.workflow.workflow_id,
    recorded.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "y".repeat(32 * 1024 - 2),
    },
  );
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(
    (await fsp.stat(admitted.workflowPath)).size <= maxWorkflowBytes,
  );

  // One byte past the reserve is rejected before any artifact changes.
  const rejected = await runBoundary(1);
  const beforeWorkflow = await fsp.readFile(rejected.workflowPath);
  const beforeAudit = await fsp.readFile(rejected.auditPath);
  const beforeAuditHead = await fsp.readFile(rejected.auditHeadPath);
  await assert.rejects(
    recordWorkflowHead(
      rejected.state.store,
      rejected.workflow.workflow_id,
      rejected.workflow.revision,
      rejected.headSha,
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_CANCELLATION_RESERVE_EXHAUSTED");
      return true;
    },
  );
  assert.deepEqual(await fsp.readFile(rejected.workflowPath), beforeWorkflow);
  assert.deepEqual(await fsp.readFile(rejected.auditPath), beforeAudit);
  assert.deepEqual(
    await fsp.readFile(rejected.auditHeadPath),
    beforeAuditHead,
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

  const fulfilled = results.find((result) => result.status === "fulfilled");
  const workflowDirectories = await fsp.readdir(
    path.join(state.store, "workflows"),
  );
  assert.deepEqual(workflowDirectories, [fulfilled.value.workflow_id]);
  assert.equal(
    fulfilled.value.claims.every(
      (claim) => claim.disposition === "ACTIVE",
    ),
    true,
  );
});

test("a crashed start holds no claims and cannot be read or listed", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  const orphanId = "rbwf-2026-01-01T000000-000Z-deadbeef";
  const orphanRoot = path.join(state.store, "workflows", orphanId);
  await fsp.mkdir(orphanRoot, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(orphanRoot, "action-audit.jsonl"), "", {
    mode: 0o600,
  });
  await fsp.writeFile(
    path.join(orphanRoot, "action-audit-head.json"),
    `${canonicalJson({
      version: 1,
      workflow_id: orphanId,
      committed_bytes: 0,
      next_sequence: 1,
      last_event_sha256: null,
    })}\n`,
    { mode: 0o600 },
  );

  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  assert.equal(workflow.status, "ACTIVE");
  await assert.rejects(
    getAutonomousWorkflow(state.store, orphanId),
    /WORKFLOW_NOT_FOUND/,
  );
  const listed = await listAutonomousWorkflows(state.store);
  assert.deepEqual(
    listed.map((entry) => entry.workflow_id),
    [workflow.workflow_id],
  );
});

test("cancelled claims block a successor until their reconciled release", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  const predecessor = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    predecessor.workflow_id,
    predecessor.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "Release the predecessor claims.",
    },
  );

  await assert.rejects(
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_OWNERSHIP_CONFLICT");
      assert.equal(
        error.details.owner_workflow_id,
        predecessor.workflow_id,
      );
      return true;
    },
  );

  await releaseWorkflowClaims(
    state.store,
    predecessor.workflow_id,
    cancelled.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "No external objects remain.",
      reconciledClaims: claimReleaseEvidence(cancelled),
    },
  );

  const successor = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  assert.equal(successor.status, "ACTIVE");
  assert.equal(
    successor.claims.every((claim) => claim.disposition === "ACTIVE"),
    true,
  );
  const predecessorLedger = await getAutonomousWorkflow(
    state.store,
    predecessor.workflow_id,
  );
  assert.equal(
    predecessorLedger.claims.every(
      (claim) => claim.disposition === "RELEASED",
    ),
    true,
  );
});

test("workflow start fails closed when any persisted ledger is unreadable", async (t) => {
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
      rationale: "Free the claims before corrupting the ledger.",
    },
  );
  await releaseWorkflowClaims(
    state.store,
    workflow.workflow_id,
    cancelled.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "No external objects remain.",
      reconciledClaims: claimReleaseEvidence(cancelled),
    },
  );

  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  await fsp.writeFile(workflowPath, "{not json\n", { mode: 0o600 });

  await assert.rejects(
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    ),
    /WORKFLOW_STATE_INVALID/,
  );
  const workflowDirectories = await fsp.readdir(
    path.join(state.store, "workflows"),
  );
  assert.deepEqual(workflowDirectories, [workflow.workflow_id]);
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
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    audit.map((event) => event.event),
    [
      "WORKFLOW_STATE_UPDATED",
      "WORKFLOW_STATE_UPDATED",
      "ACTION_PLANNED",
      "ACTION_EXECUTING",
      "ACTION_OBSERVED",
      "ACTION_COMPLETED",
    ],
  );
  assert.equal(audit[0].previous_event_sha256, null);
  assert.match(audit.at(-1).event_sha256, /^[0-9a-f]{64}$/);
});

test("change-size warning reports headroom without blocking dispatch", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 2 }),
  );
  const headSha = await commitImplementation(state.repository);
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  assert.equal(workflow.status, "ACTIVE");
  assert.equal(workflow.phase, "DISPATCH_CODEX_REVIEWER");
  assert.deepEqual(workflow.current_review.change_size, {
    added_lines: 1,
    deleted_lines: 1,
    total_lines: 2,
    budget: 2,
    warning_threshold: 2,
    warning_threshold_crossed: true,
    remaining_headroom: 0,
    over_budget: false,
  });
});

test("change-size budget pauses before reviewer dispatch and extends auditedly", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 1 }),
  );
  const authorizationDigest =
    started.authorization.workflow_authorization_sha256;
  const headSha = await commitImplementation(state.repository);
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  assert.equal(workflow.status, "PAUSED");
  assert.equal(workflow.phase, "PAUSED_HUMAN");
  assert.equal(workflow.reviewer_task, null);
  assert.equal(workflow.pause.reason_code, "CHANGE_SIZE_BUDGET_EXCEEDED");
  assert.equal(workflow.pause.blocked_action, "DISPATCH_CODEX_REVIEWER");
  assert.equal(workflow.pause.change_size_budget, 1);
  assert.deepEqual(workflow.pause.change_size, {
    added_lines: 1,
    deleted_lines: 1,
    total_lines: 2,
  });
  assert.deepEqual(workflow.current_review.change_size, {
    added_lines: 1,
    deleted_lines: 1,
    total_lines: 2,
    budget: 1,
    warning_threshold: 1,
    warning_threshold_crossed: true,
    remaining_headroom: 0,
    over_budget: true,
  });
  await assert.rejects(
    planCodexTaskDispatch(
      state.store,
      started.workflow_id,
      workflow.revision,
      review.id,
    ),
    /workflow is not active \(status=PAUSED\)/,
  );
  await assert.rejects(
    resumeAutonomousWorkflow(
      state.store,
      started.workflow_id,
      workflow.revision,
      { operatorLabel: "Test Operator", rationale: "Continue." },
    ),
    /budget must be extended/,
  );
  workflow = await extendChangeSizeBudget(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      newBudget: 2,
      operatorLabel: "Test Operator",
      rationale: "The change is cohesive.",
    },
  );
  assert.equal(workflow.change_size_budget, 2);
  assert.equal(
    workflow.authorization.workflow_authorization_sha256,
    authorizationDigest,
  );
  workflow = await resumeAutonomousWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
    { operatorLabel: "Test Operator", rationale: "Continue." },
  );
  assert.equal(workflow.status, "ACTIVE");
  assert.equal(workflow.phase, "DISPATCH_CODEX_REVIEWER");
  const auditPath = path.join(
    state.store,
    "workflows",
    started.workflow_id,
    "action-audit.jsonl",
  );
  const audit = (await fsp.readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const extension = audit.find(
    (event) => event.event === "CHANGE_SIZE_BUDGET_EXTENDED",
  );
  assert.match(extension.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(extension.metadata, {
    old_budget: 1,
    new_budget: 2,
    measured_change_size: 2,
    operator_label: "Test Operator",
    rationale: "The change is cohesive.",
  });
});

test("legacy bound reviews backfill change size before reviewer dispatch", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 3000 }),
  );
  const content = `${Array.from(
    { length: 2001 },
    (_, index) => `export const value${index} = ${index};`,
  ).join("\n")}\n`;
  const headSha = await commitImplementation(state.repository, content);
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  assert.equal(workflow.phase, "DISPATCH_CODEX_REVIEWER");

  const workflowRoot = path.join(
    state.store,
    "workflows",
    started.workflow_id,
  );
  const workflowPath = path.join(workflowRoot, "workflow.json");
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  delete stored.change_size_budget;
  delete stored.current_review.change_size;
  const reviewPath = path.join(
    state.store,
    "reviews",
    review.id,
    "review.json",
  );
  const legacyReview = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  delete legacyReview.rounds[0].change_size;
  await fsp.writeFile(reviewPath, `${canonicalJson(legacyReview)}\n`, {
    mode: 0o600,
  });
  const legacyEvent = workflowAuditEvent(stored, {
    sequence: 1,
    previousEventSha256: null,
    eventId: "b".repeat(32),
    at: stored.updated_at,
  });
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit.jsonl"),
    legacyEvent.bytes,
    { mode: 0o600 },
  );
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit-head.json"),
    `${canonicalJson({
      version: 1,
      workflow_id: started.workflow_id,
      committed_bytes: legacyEvent.bytes.length,
      next_sequence: 2,
      last_event_sha256: legacyEvent.event.event_sha256,
    })}\n`,
    { mode: 0o600 },
  );
  stored.action_audit = {
    next_sequence: 2,
    last_event_sha256: legacyEvent.event.event_sha256,
  };
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });

  const result = await planCodexTaskDispatch(
    state.store,
    started.workflow_id,
    stored.revision,
    review.id,
  );
  assert.equal(result.action, null);
  assert.equal(result.dispatch, null);
  assert.equal(result.workflow.status, "PAUSED");
  assert.equal(result.workflow.pause.reason_code, "CHANGE_SIZE_BUDGET_EXCEEDED");
  assert.equal(result.workflow.pause.change_size_budget, 2000);
  assert.equal(result.workflow.current_review.change_size.total_lines, 2002);
});

test("legacy planned reviewer dispatch rechecks change size before execution", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 3000 }),
  );
  const content = `${Array.from(
    { length: 2001 },
    (_, index) => `export const value${index} = ${index};`,
  ).join("\n")}\n`;
  const headSha = await commitImplementation(state.repository, content);
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  const planned = await planCodexTaskDispatch(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );

  const workflowRoot = path.join(
    state.store,
    "workflows",
    started.workflow_id,
  );
  const workflowPath = path.join(workflowRoot, "workflow.json");
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  delete stored.change_size_budget;
  delete stored.current_review.change_size;
  const reviewPath = path.join(
    state.store,
    "reviews",
    review.id,
    "review.json",
  );
  const legacyReview = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  delete legacyReview.rounds[0].change_size;
  await fsp.writeFile(reviewPath, `${canonicalJson(legacyReview)}\n`, {
    mode: 0o600,
  });
  const legacyEvent = workflowAuditEvent(stored, {
    sequence: 1,
    previousEventSha256: null,
    eventId: "d".repeat(32),
    at: stored.updated_at,
  });
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit.jsonl"),
    legacyEvent.bytes,
    { mode: 0o600 },
  );
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit-head.json"),
    `${canonicalJson({
      version: 1,
      workflow_id: started.workflow_id,
      committed_bytes: legacyEvent.bytes.length,
      next_sequence: 2,
      last_event_sha256: legacyEvent.event.event_sha256,
    })}\n`,
    { mode: 0o600 },
  );
  stored.action_audit = {
    next_sequence: 2,
    last_event_sha256: legacyEvent.event.event_sha256,
  };
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      started.workflow_id,
      stored.revision,
      planned.action.action_id,
    ),
    /change-size budget must be extended before reviewer dispatch/,
  );
  const paused = await getAutonomousWorkflow(
    state.store,
    started.workflow_id,
  );
  assert.equal(paused.revision, stored.revision + 1);
  assert.equal(paused.status, "PAUSED");
  assert.equal(paused.active_action, null);
  assert.equal(paused.pause.reason_code, "CHANGE_SIZE_BUDGET_EXCEEDED");
  assert.equal(paused.pause.change_size_budget, 2000);
  assert.equal(paused.current_review.change_size.total_lines, 2002);
});

test("legacy change-size backfill rejects a same-head review transition", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const workflowRoot = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
  );
  const workflowPath = path.join(workflowRoot, "workflow.json");
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  delete stored.current_review.change_size;
  const legacyEvent = workflowAuditEvent(stored, {
    sequence: 1,
    previousEventSha256: null,
    eventId: "c".repeat(32),
    at: stored.updated_at,
  });
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit.jsonl"),
    legacyEvent.bytes,
    { mode: 0o600 },
  );
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit-head.json"),
    `${canonicalJson({
      version: 1,
      workflow_id: workflow.workflow_id,
      committed_bytes: legacyEvent.bytes.length,
      next_sequence: 2,
      last_event_sha256: legacyEvent.event.event_sha256,
    })}\n`,
    { mode: 0o600 },
  );
  stored.action_audit = {
    next_sequence: 2,
    last_event_sha256: legacyEvent.event.event_sha256,
  };
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });
  await submitInitialReview(
    state.store,
    review.id,
    [{ severity: "major", title: "Defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );

  await assert.rejects(
    planCodexTaskDispatch(
      state.store,
      workflow.workflow_id,
      stored.revision,
      review.id,
    ),
    /bound review cannot backfill its immutable change size/,
  );
  const unchanged = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(unchanged.revision, stored.revision);
  assert.equal(unchanged.active_action, null);
  assert.equal(unchanged.current_review.change_size, undefined);
});

test("an oversized rereview snapshot pauses before reviewer reuse", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 3 }),
  );
  const headSha = await commitImplementation(state.repository);
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  ));
  await submitInitialReview(
    state.store,
    review.id,
    [{ severity: "major", title: "Defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  const fixedHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    fixedHead,
  );
  await submitResolutions(state.store, review.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed." },
  ]);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  await prepareRereview(state.store, review.id);
  const reviewPath = path.join(
    state.store,
    "reviews",
    review.id,
    "review.json",
  );
  const legacyReview = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  delete legacyReview.rounds[1].change_size;
  await fsp.writeFile(reviewPath, `${canonicalJson(legacyReview)}\n`, {
    mode: 0o600,
  });
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.status, "PAUSED");
  assert.equal(workflow.pause.reason_code, "CHANGE_SIZE_BUDGET_EXCEEDED");
  assert.equal(workflow.pause.blocked_action, "REVIEW_CODEX_REREVIEW");
  assert.equal(workflow.pause.resume_phase, "WAIT_LOCAL_REREVIEW");
  assert.deepEqual(workflow.current_review.change_size, {
    added_lines: 5,
    deleted_lines: 1,
    total_lines: 6,
    budget: 3,
    warning_threshold: 3,
    warning_threshold_crossed: true,
    remaining_headroom: 0,
    over_budget: true,
  });
  workflow = await extendChangeSizeBudget(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      newBudget: 6,
      operatorLabel: "Test Operator",
      rationale: "Keep the rereview cohesive.",
    },
  );
  workflow = await resumeAutonomousWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
    { operatorLabel: "Test Operator", rationale: "Continue rereview." },
  );
  assert.equal(workflow.status, "ACTIVE");
  assert.equal(workflow.phase, "WAIT_LOCAL_REREVIEW");
});

test("a crossed change-size warning refuses the next round until a recorded split decision", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 8 }),
  );
  // Base app.js is one line, so five replacement lines measure 5 added + 1
  // deleted = 6 total, exactly the warning threshold ceil(8 * 0.75).
  const headSha = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n",
  );
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  assert.equal(workflow.status, "ACTIVE");
  assert.equal(workflow.phase, "DISPATCH_CODEX_REVIEWER");
  assert.equal(workflow.change_size_warning.total_lines, 6);
  assert.equal(workflow.change_size_warning.acknowledgment, null);
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  ));
  await submitInitialReview(
    state.store,
    review.id,
    [{ severity: "major", title: "Defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.phase, "ADDRESS_LOCAL_FINDINGS");
  const fixedHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    fixedHead,
  );
  await submitResolutions(state.store, review.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed." },
  ]);
  await assert.rejects(
    advanceLocalWorkflow(state.store, started.workflow_id, workflow.revision),
    /WORKFLOW_CHANGE_SIZE_WARNING_UNACKNOWLEDGED.*acknowledge_change_size_warning/,
  );
  const refused = await getAutonomousWorkflow(
    state.store,
    started.workflow_id,
  );
  assert.equal(refused.status, "ACTIVE");
  assert.equal(refused.phase, "ADDRESS_LOCAL_FINDINGS");
  // The advance the crossing refuses is what the summary would otherwise name
  // on its own, so the acknowledgment that clears it belongs in the declaration.
  assert.deepEqual(
    Object.keys(
      (await getAutonomousWorkflowSummary(state.store, started.workflow_id))
        .required_inputs,
    ),
    [
      "record_workflow_head",
      "acknowledge_change_size_warning",
      "advance_local_workflow",
    ],
  );
  workflow = await acknowledgeChangeSizeWarning(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      decision: "continue",
      rationale: "The checkers belong with the change they verify.",
      operatorLabel: "Test Operator",
    },
  );
  assert.deepEqual(workflow.change_size_warning.acknowledgment.decision, "continue");
  assert.equal(workflow.change_size_warning.acknowledgment.total_lines, 6);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.phase, "PREPARE_REREVIEW");
  await prepareRereview(state.store, review.id);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.phase, "WAIT_LOCAL_REREVIEW");
  assert.equal(workflow.change_size_warning.total_lines, 7);
  assert.equal(workflow.change_size_warning.acknowledgment.total_lines, 6);
  await submitRereview(
    state.store,
    review.id,
    [{ finding_id: "F-001", decision: "resolved", rationale: "Verified." }],
    [
      {
        severity: "minor",
        title: "Edge case",
        explanation: "The rereview found a separate edge case.",
      },
    ],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.phase, "ADDRESS_LOCAL_FINDINGS");
  const continuationHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 7;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    continuationHead,
  );
  assert.equal(workflow.phase, "PREPARE_LOCAL_REVIEW");
  const followup = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
    forceFullReview: true,
    continuedFromReviewId: review.id,
  });
  await assert.rejects(
    bindWorkflowReview(
      state.store,
      started.workflow_id,
      workflow.revision,
      followup.id,
    ),
    /WORKFLOW_CHANGE_SIZE_WARNING_UNACKNOWLEDGED.*acknowledge_change_size_warning/,
  );
  workflow = await acknowledgeChangeSizeWarning(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      decision: "split",
      rationale: "Cut the checkers into a follow-up change after this round.",
      operatorLabel: "Test Operator",
    },
  );
  assert.equal(workflow.change_size_warning.acknowledgment.decision, "split");
  assert.equal(workflow.change_size_warning.acknowledgment.total_lines, 7);
  // A recorded split that still targets the head it was decided on keeps the
  // gate closed: binding the unchanged snapshot would proceed without the cut.
  await assert.rejects(
    bindWorkflowReview(
      state.store,
      started.workflow_id,
      workflow.revision,
      followup.id,
    ),
    /WORKFLOW_CHANGE_SIZE_SPLIT_UNEXECUTED/,
  );
  // Re-acknowledging the decision as continue releases it auditedly.
  workflow = await acknowledgeChangeSizeWarning(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      decision: "continue",
      rationale: "The cut is not worth a re-review; continue as one unit.",
      operatorLabel: "Test Operator",
    },
  );
  // The follow-up snapshot measures the same 7 total lines: an equal-size
  // later snapshot is not a new crossing and must not re-arm the demand.
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    followup.id,
  );
  assert.equal(workflow.status, "ACTIVE");
  assert.equal(workflow.phase, "DISPATCH_CODEX_REVIEWER");
  assert.equal(workflow.change_size_warning.total_lines, 7);
  const auditPath = path.join(
    state.store,
    "workflows",
    started.workflow_id,
    "action-audit.jsonl",
  );
  const audit = (await fsp.readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const acknowledgments = audit.filter(
    (event) => event.event === "CHANGE_SIZE_WARNING_ACKNOWLEDGED",
  );
  assert.equal(acknowledgments.length, 3);
  assert.deepEqual(acknowledgments[0].metadata, {
    decision: "continue",
    rationale: "The checkers belong with the change they verify.",
    crossed_total_lines: 6,
    change_size_budget: 8,
    operator_label: "Test Operator",
  });
  assert.deepEqual(acknowledgments[1].metadata, {
    decision: "split",
    rationale: "Cut the checkers into a follow-up change after this round.",
    crossed_total_lines: 7,
    change_size_budget: 8,
    operator_label: "Test Operator",
  });
  assert.deepEqual(acknowledgments[2].metadata, {
    decision: "continue",
    rationale: "The cut is not worth a re-review; continue as one unit.",
    crossed_total_lines: 7,
    change_size_budget: 8,
    operator_label: "Test Operator",
  });
});

test("a split acknowledgment at the continuation bind can commit the intended cut", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 8 }),
  );
  const headSha = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n",
  );
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  ));
  await submitInitialReview(
    state.store,
    review.id,
    [{ severity: "major", title: "Defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  const fixedHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    fixedHead,
  );
  await submitResolutions(state.store, review.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed." },
  ]);
  workflow = await acknowledgeChangeSizeWarning(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      decision: "continue",
      rationale: "Finish the round before deciding the cut.",
      operatorLabel: "Test Operator",
    },
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  await prepareRereview(state.store, review.id);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  await submitRereview(
    state.store,
    review.id,
    [{ finding_id: "F-001", decision: "resolved", rationale: "Verified." }],
    [
      {
        severity: "minor",
        title: "Edge case",
        explanation: "The rereview found a separate edge case.",
      },
    ],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  const addressedHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 7;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    addressedHead,
  );
  assert.equal(workflow.phase, "PREPARE_LOCAL_REVIEW");
  const staleFollowup = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
    forceFullReview: true,
    continuedFromReviewId: review.id,
  });
  await assert.rejects(
    bindWorkflowReview(
      state.store,
      started.workflow_id,
      workflow.revision,
      staleFollowup.id,
    ),
    /acknowledge_change_size_warning/,
  );
  workflow = await acknowledgeChangeSizeWarning(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      decision: "split",
      rationale: "Cut the constants back to the reviewed core.",
      operatorLabel: "Test Operator",
    },
  );
  // The approved cut survives a restart: a controller reading only the
  // ledger can recover what the split is supposed to remove.
  const reloaded = await getAutonomousWorkflow(state.store, started.workflow_id);
  assert.equal(
    reloaded.change_size_warning.acknowledgment.rationale,
    "Cut the constants back to the reviewed core.",
  );
  // The recorded split has not shrunk the change, so the unchanged snapshot
  // cannot be bound before the cut lands.
  await assert.rejects(
    bindWorkflowReview(
      state.store,
      started.workflow_id,
      workflow.revision,
      staleFollowup.id,
    ),
    /WORKFLOW_CHANGE_SIZE_SPLIT_UNEXECUTED/,
  );
  // An empty descendant records no cut and leaves the measurement unchanged:
  // the gate stays closed.
  git(state.repository, "commit", "--allow-empty", "-m", "empty descendant");
  const emptyHead = git(state.repository, "rev-parse", "HEAD");
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    emptyHead,
  );
  await assert.rejects(
    bindWorkflowReview(
      state.store,
      started.workflow_id,
      workflow.revision,
      staleFollowup.id,
    ),
    /WORKFLOW_CHANGE_SIZE_SPLIT_UNEXECUTED/,
  );
  // A change-then-revert sequence restores the same measurement and must not
  // release the gate either.
  await commitImplementation(state.repository, "export const detour = 1;\n");
  const revertedHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 7;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    revertedHead,
  );
  await assert.rejects(
    bindWorkflowReview(
      state.store,
      started.workflow_id,
      workflow.revision,
      staleFollowup.id,
    ),
    /WORKFLOW_CHANGE_SIZE_SPLIT_UNEXECUTED/,
  );
  // Attribute rules that zero a fresh diff cannot release the split at the
  // bind: the candidate snapshot's immutable measurement is the authority.
  const attributesPath = path.join(
    state.repository,
    ".git",
    "info",
    "attributes",
  );
  await fsp.writeFile(attributesPath, "* -diff\n");
  await assert.rejects(
    bindWorkflowReview(
      state.store,
      started.workflow_id,
      workflow.revision,
      staleFollowup.id,
    ),
    /WORKFLOW_CHANGE_SIZE_SPLIT_UNEXECUTED/,
  );
  await fsp.unlink(attributesPath);
  // The intended cut is a descendant head committed from PREPARE_LOCAL_REVIEW;
  // the latest cycle's addressed head must follow it so the follow-up review
  // still carries the open findings.
  const cutHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    cutHead,
  );
  assert.equal(workflow.phase, "PREPARE_LOCAL_REVIEW");
  assert.equal(workflow.current_head_sha, cutHead);
  assert.equal(
    workflow.local_review_cycles.at(-1).addressed_head_sha,
    cutHead,
  );
  assert.equal(workflow.local_review_cycles.at(-1).followup_review_id, null);
  const followup = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
    forceFullReview: true,
    continuedFromReviewId: review.id,
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    followup.id,
  );
  assert.equal(workflow.status, "ACTIVE");
  assert.equal(workflow.phase, "DISPATCH_CODEX_REVIEWER");
  assert.equal(
    workflow.local_review_cycles.at(-1).followup_review_id,
    followup.id,
  );
  assert.equal(workflow.current_review.change_size.total_lines, 4);
  assert.equal(workflow.change_size_warning.total_lines, 7);
  assert.equal(workflow.change_size_warning.acknowledgment.decision, "split");
  // Admitting the smaller round marks the split executed, so later growth of
  // the successor work cannot re-trigger it.
  assert.match(
    workflow.change_size_warning.acknowledgment.executed_at,
    /^\d{4}-\d{2}-\d{2}T/,
  );
});

test("a premature split stays pending until the change shrinks below its crossing", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 8 }),
  );
  const headSha = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n",
  );
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  ));
  await submitInitialReview(
    state.store,
    review.id,
    [{ severity: "major", title: "Defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  // The split is decided before the response's fix commit even exists. Its
  // execution is judged by measured size, so the owed fix cannot discharge
  // it on paper.
  await submitResolutions(state.store, review.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed." },
  ]);
  workflow = await acknowledgeChangeSizeWarning(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      decision: "split",
      rationale: "Split before the fix head lands.",
      operatorLabel: "Test Operator",
    },
  );
  assert.equal(workflow.change_size_warning.acknowledgment.total_lines, 6);
  // The finding fix grows the change to 7 total lines: still at or above the
  // acknowledged crossing, so the split stays pending.
  const fixedHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    fixedHead,
  );
  await assert.rejects(
    advanceLocalWorkflow(state.store, started.workflow_id, workflow.revision),
    /WORKFLOW_CHANGE_SIZE_SPLIT_UNEXECUTED/,
  );
  // Only a head that shrinks the measured change below the acknowledged
  // crossing executes the split.
  const cutHead = await commitImplementation(
    state.repository,
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    cutHead,
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.phase, "PREPARE_REREVIEW");
  // The stamp waits for an immutable measurement: the gate's own diff never
  // marks the split executed.
  assert.equal(
    workflow.change_size_warning.acknowledgment.executed_at ?? null,
    null,
  );
  await prepareRereview(state.store, review.id);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.phase, "WAIT_LOCAL_REREVIEW");
  assert.match(
    workflow.change_size_warning.acknowledgment.executed_at,
    /^\d{4}-\d{2}-\d{2}T/,
  );
});

test("extending the exceeded budget does not satisfy the pending warning acknowledgment", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { changeSizeBudget: 1 }),
  );
  const headSha = await commitImplementation(state.repository);
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  assert.equal(workflow.pause.reason_code, "CHANGE_SIZE_BUDGET_EXCEEDED");
  assert.equal(workflow.change_size_warning.total_lines, 2);
  // The pending crossing cannot be acknowledged from the ceiling pause: no
  // permitted action could commit a split's cut there, so the pause is
  // answered first and the decision is demanded again at the gate.
  await assert.rejects(
    acknowledgeChangeSizeWarning(
      state.store,
      started.workflow_id,
      workflow.revision,
      {
        decision: "split",
        rationale: "Cut it while paused.",
        operatorLabel: "Test Operator",
      },
    ),
    /acknowledged where the next round is prepared/,
  );
  workflow = await extendChangeSizeBudget(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      newBudget: 2,
      operatorLabel: "Test Operator",
      rationale: "The change is cohesive.",
    },
  );
  workflow = await resumeAutonomousWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
    { operatorLabel: "Test Operator", rationale: "Continue." },
  );
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  ));
  await submitInitialReview(
    state.store,
    review.id,
    [{ severity: "major", title: "Defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  const fixedHead = await commitImplementation(
    state.repository,
    "export const value = 3;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    fixedHead,
  );
  await submitResolutions(state.store, review.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed." },
  ]);
  await assert.rejects(
    advanceLocalWorkflow(state.store, started.workflow_id, workflow.revision),
    /acknowledge_change_size_warning/,
  );
  workflow = await acknowledgeChangeSizeWarning(
    state.store,
    started.workflow_id,
    workflow.revision,
    {
      decision: "continue",
      rationale: "The extended budget already admits this cohesive change.",
      operatorLabel: "Test Operator",
    },
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.phase, "PREPARE_REREVIEW");
});

test("acknowledging without an unacknowledged crossing is refused", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  await assert.rejects(
    acknowledgeChangeSizeWarning(
      state.store,
      started.workflow_id,
      started.revision,
      {
        decision: "continue",
        rationale: "Nothing crossed.",
        operatorLabel: "Test Operator",
      },
    ),
    /no unacknowledged change-size warning crossing/,
  );
  await assert.rejects(
    acknowledgeChangeSizeWarning(
      state.store,
      started.workflow_id,
      started.revision,
      {
        decision: "defer",
        rationale: "Invalid decision.",
        operatorLabel: "Test Operator",
      },
    ),
    /decision must be "continue" or "split"/,
  );
  await assert.rejects(
    acknowledgeChangeSizeWarning(
      state.store,
      started.workflow_id,
      started.revision,
      {
        decision: "continue",
        rationale: "x".repeat(32 * 1024),
        operatorLabel: "Test Operator",
      },
    ),
    /rationale exceeds its canonical byte limit/,
  );
});

test("a ledger written before the change-size warning field loads and operates", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  assert.equal(stored.change_size_warning, null);
  delete stored.change_size_warning;
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });
  const summary = await getAutonomousWorkflowSummary(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(summary.change_size_warning, null);
  const { completed } = await dispatchReviewer(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );
  assert.equal(completed.phase, "WAIT_LOCAL_REVIEW");
});

test("a legacy ledger with a crossed measurement gates before the next round", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  // The default budget keeps the fabricated pre-upgrade audit event, which
  // predates every compatibility field, consistent with the stored ledger.
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const crossingLines = Array.from(
    { length: 1600 },
    (_, index) => `export const value${index} = ${index};`,
  );
  const headSha = await commitImplementation(
    state.repository,
    `${crossingLines.join("\n")}\n`,
  );
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    headSha,
  );
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  ));
  await submitInitialReview(
    state.store,
    review.id,
    [{ severity: "major", title: "Defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  crossingLines[0] = "export const firstValue = 0;";
  const fixedHead = await commitImplementation(
    state.repository,
    `${crossingLines.join("\n")}\n`,
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    fixedHead,
  );
  await submitResolutions(state.store, review.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed." },
  ]);
  // Rewrite the ledger as a pre-upgrade one: no warning field anywhere, while
  // the bound measurement already crosses the warning threshold.
  const workflowRoot = path.join(
    state.store,
    "workflows",
    started.workflow_id,
  );
  const workflowPath = path.join(workflowRoot, "workflow.json");
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  delete stored.change_size_warning;
  const legacyEvent = workflowAuditEvent(stored, {
    sequence: 1,
    previousEventSha256: null,
    eventId: "c".repeat(32),
    at: stored.updated_at,
  });
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit.jsonl"),
    legacyEvent.bytes,
    { mode: 0o600 },
  );
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit-head.json"),
    `${canonicalJson({
      version: 1,
      workflow_id: started.workflow_id,
      committed_bytes: legacyEvent.bytes.length,
      next_sequence: 2,
      last_event_sha256: legacyEvent.event.event_sha256,
    })}\n`,
    { mode: 0o600 },
  );
  stored.action_audit = {
    next_sequence: 2,
    last_event_sha256: legacyEvent.event.event_sha256,
  };
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });
  // The crossing is derived from the recorded measurement, so the very first
  // post-upgrade gate check refuses instead of admitting one more round.
  await assert.rejects(
    advanceLocalWorkflow(state.store, started.workflow_id, stored.revision),
    /WORKFLOW_CHANGE_SIZE_WARNING_UNACKNOWLEDGED/,
  );
  workflow = await acknowledgeChangeSizeWarning(
    state.store,
    started.workflow_id,
    stored.revision,
    {
      decision: "continue",
      rationale: "The pre-upgrade crossing is acknowledged as one unit.",
      operatorLabel: "Test Operator",
    },
  );
  assert.equal(workflow.change_size_warning.total_lines, 1601);
  assert.equal(workflow.change_size_warning.acknowledgment.total_lines, 1601);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.phase, "PREPARE_REREVIEW");
});

test("active workflow phases stay bound to the audit chain from initial state onward", async (t) => {
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
  const initial = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const forgedInitial = structuredClone(initial);
  forgedInitial.phase = "LOCAL_GATE_PASSED";
  await fsp.writeFile(
    workflowPath,
    `${canonicalJson(forgedInitial)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    getAutonomousWorkflowSummary(state.store, workflow.workflow_id),
    /WORKFLOW_AUDIT_CORRUPT/,
  );

  await fsp.writeFile(workflowPath, `${canonicalJson(initial)}\n`, {
    mode: 0o600,
  });
  const headSha = await commitImplementation(state.repository);
  const recorded = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    headSha,
  );
  await fsp.writeFile(workflowPath, `${canonicalJson(initial)}\n`, {
    mode: 0o600,
  });
  const recovered = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(recovered.current_head_sha, headSha);
  assert.deepEqual(recovered.attempts, recorded.attempts);
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: workflow.requirement,
    implementationScope: workflow.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  await bindWorkflowReview(
    state.store,
    workflow.workflow_id,
    recovered.revision,
    review.id,
  );
  const bound = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const forgedBound = structuredClone(bound);
  forgedBound.phase = "LOCAL_GATE_PASSED";
  await fsp.writeFile(workflowPath, `${canonicalJson(forgedBound)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    getAutonomousWorkflowSummary(state.store, workflow.workflow_id),
    /WORKFLOW_AUDIT_CORRUPT/,
  );
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

test("pause and cancellation cannot be rewound to a stale active action", async (t) => {
  for (const transition of ["pause", "cancel"]) {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const { workflow, review } = await prepareBoundWorkflow(state);
    const planned = await planCodexTaskDispatch(
      state.store,
      workflow.workflow_id,
      workflow.revision,
      review.id,
    );
    const workflowRoot = path.join(
      state.store,
      "workflows",
      workflow.workflow_id,
    );
    const workflowPath = path.join(workflowRoot, "workflow.json");
    const staleActive = await fsp.readFile(workflowPath);
    const stopped =
      transition === "pause"
        ? await pauseAutonomousWorkflow(
            state.store,
            workflow.workflow_id,
            planned.workflow.revision,
            {
              reasonCode: "TASK_ORCHESTRATION_UNAVAILABLE",
              blockedAction: "CREATE_CODEX_REVIEWER_TASK",
              evidence: "The task provider is unavailable.",
            },
          )
        : await cancelAutonomousWorkflow(
            state.store,
            workflow.workflow_id,
            planned.workflow.revision,
            {
              operatorLabel: "Test Operator",
              rationale: "Cancel before dispatch.",
            },
          );
    const expectedStatus = transition === "pause" ? "PAUSED" : "CANCELLED";
    const expectedPhase =
      transition === "pause" ? "PAUSED_HUMAN" : "CANCELLED";

    await fsp.writeFile(workflowPath, staleActive, { mode: 0o600 });
    const recovered = await getAutonomousWorkflow(
      state.store,
      workflow.workflow_id,
    );
    assert.equal(recovered.status, expectedStatus);
    assert.equal(recovered.phase, expectedPhase);
    assert.deepEqual(recovered.action_audit, stopped.action_audit);

    const forged = JSON.parse(staleActive);
    forged.action_audit = structuredClone(stopped.action_audit);
    await fsp.writeFile(workflowPath, `${canonicalJson(forged)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      getAutonomousWorkflow(state.store, workflow.workflow_id),
      /WORKFLOW_AUDIT_CORRUPT/,
    );

    const audit = (
      await fsp.readFile(path.join(workflowRoot, "action-audit.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      audit.at(-1).event,
      transition === "pause" ? "WORKFLOW_PAUSED" : "WORKFLOW_CANCELLED",
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

test("the audit log reserves cancellation headroom at its ordinary limit", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const workflowRoot = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
  );
  const workflowPath = path.join(workflowRoot, "workflow.json");
  const auditPath = path.join(workflowRoot, "action-audit.jsonl");
  const auditHeadPath = path.join(workflowRoot, "action-audit-head.json");
  const maxAuditBytes = 4 * 1024 * 1024;
  const maxEventBytes = 256 * 1024 + 1;
  const ordinaryLimit = maxAuditBytes - 2 * maxEventBytes;
  const lines = [];
  let previousDigest = null;
  let sequence = 1;
  let committedBytes = 0;
  const auditLine = (paddingLength) =>
    workflowAuditEvent(workflow, {
      sequence,
      previousEventSha256: previousDigest,
      eventId: sequence.toString(16).padStart(32, "0"),
      at: new Date().toISOString(),
      event: "WORKFLOW_AUDIT_PADDING",
      metadata: { padding: "x".repeat(paddingLength) },
    });
  while (committedBytes < ordinaryLimit) {
    const remaining = ordinaryLimit - committedBytes;
    const empty = auditLine(0);
    const paddingLength =
      remaining <= empty.bytes.length + 200_000
        ? remaining - empty.bytes.length
        : 200_000;
    assert.ok(paddingLength >= 0);
    const line = auditLine(paddingLength);
    assert.ok(line.bytes.length <= maxEventBytes);
    lines.push(line.bytes);
    committedBytes += line.bytes.length;
    previousDigest = line.event.event_sha256;
    sequence += 1;
  }
  assert.equal(committedBytes, ordinaryLimit);
  await fsp.writeFile(auditPath, Buffer.concat(lines), { mode: 0o600 });
  await fsp.writeFile(
    auditHeadPath,
    `${canonicalJson({
      version: 1,
      workflow_id: workflow.workflow_id,
      committed_bytes: committedBytes,
      next_sequence: sequence,
      last_event_sha256: previousDigest,
    })}\n`,
    { mode: 0o600 },
  );
  const storedWorkflow = structuredClone(workflow);
  storedWorkflow.action_audit = {
    next_sequence: sequence,
    last_event_sha256: previousDigest,
  };
  await fsp.writeFile(
    workflowPath,
    `${canonicalJson(storedWorkflow)}\n`,
    { mode: 0o600 },
  );
  const maxEscapedCancellationRationale = "\0".repeat(5_461);
  assert.equal(
    Buffer.byteLength(canonicalJson(maxEscapedCancellationRationale)),
    32 * 1024,
  );

  await assert.rejects(
    pauseAutonomousWorkflow(
      state.store,
      workflow.workflow_id,
      workflow.revision,
      {
        reasonCode: "TASK_ORCHESTRATION_UNAVAILABLE",
        blockedAction: "CREATE_CODEX_REVIEWER_TASK",
        evidence: "The action audit is at its ordinary byte limit.",
      },
    ),
    /WORKFLOW_AUDIT_LOG_FULL/,
  );
  assert.equal((await fsp.stat(auditPath)).size, committedBytes);

  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    {
      operatorLabel: "Test Operator",
      rationale: maxEscapedCancellationRationale,
    },
  );
  assert.equal(cancelled.status, "CANCELLED");
  const cancelledAuditBytes = (await fsp.stat(auditPath)).size;
  assert.ok(cancelledAuditBytes > ordinaryLimit);
  assert.ok(cancelledAuditBytes <= maxAuditBytes);
  await assert.rejects(
    fsp.stat(path.join(workflowRoot, "action-audit-terminal.json")),
    (error) => error.code === "ENOENT",
  );
  const recovered = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(recovered.status, "CANCELLED");

  const released = await releaseWorkflowClaims(
    state.store,
    workflow.workflow_id,
    recovered.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "No external objects remain.",
      reconciledClaims: claimReleaseEvidence(recovered),
    },
  );
  assert.equal(
    released.claims.every((claim) => claim.disposition === "RELEASED"),
    true,
  );
});

test("active mutations preserve per-event cancellation headroom", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const workflowRoot = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
  );
  const workflowPath = path.join(workflowRoot, "workflow.json");
  const auditPath = path.join(workflowRoot, "action-audit.jsonl");
  const auditHeadPath = path.join(workflowRoot, "action-audit-head.json");
  const timestamp = new Date().toISOString();
  const stored = structuredClone(workflow);
  stored.revision = 2;
  stored.updated_at = timestamp;
  stored.current_head_sha = state.baseSha;
  stored.attempts = [
    {
      number: 1,
      head_sha: state.baseSha,
      review_id: null,
      recorded_at: timestamp,
      padding: "",
    },
  ];
  const pessimisticCancellation = structuredClone(stored);
  pessimisticCancellation.revision = Number.MAX_SAFE_INTEGER;
  pessimisticCancellation.updated_at = "9999-12-31T23:59:59.999Z";
  pessimisticCancellation.status = "CANCELLED";
  pessimisticCancellation.phase = "CANCELLED";
  pessimisticCancellation.cancellation = {
    operator_label: "\0".repeat(1_024),
    rationale: "x".repeat(32 * 1024 - 2),
    cancelled_at: "9999-12-31T23:59:59.999Z",
  };
  const pessimisticOptions = {
    sequence: Number.MAX_SAFE_INTEGER,
    previousEventSha256: "f".repeat(64),
    eventId: "f".repeat(32),
    at: "9999-12-31T23:59:59.999Z",
    event: "WORKFLOW_CANCELLED",
  };
  const maxEventBytes = 256 * 1024 + 1;
  const unpaddedCancellationBytes = workflowAuditEvent(
    pessimisticCancellation,
    pessimisticOptions,
  ).bytes.length;
  stored.attempts[0].padding = "x".repeat(
    maxEventBytes - unpaddedCancellationBytes - 64,
  );
  pessimisticCancellation.attempts = structuredClone(stored.attempts);
  assert.equal(
    workflowAuditEvent(
      pessimisticCancellation,
      pessimisticOptions,
    ).bytes.length,
    maxEventBytes - 64,
  );

  const seedEvent = workflowAuditEvent(stored, {
    sequence: 1,
    previousEventSha256: null,
    eventId: "1".repeat(32),
    at: timestamp,
  });
  assert.ok(seedEvent.bytes.length <= maxEventBytes);
  await fsp.writeFile(auditPath, seedEvent.bytes, { mode: 0o600 });
  stored.action_audit = {
    next_sequence: 2,
    last_event_sha256: seedEvent.event.event_sha256,
  };
  await fsp.writeFile(
    auditHeadPath,
    `${canonicalJson({
      version: 1,
      workflow_id: workflow.workflow_id,
      committed_bytes: seedEvent.bytes.length,
      next_sequence: 2,
      last_event_sha256: seedEvent.event.event_sha256,
    })}\n`,
    { mode: 0o600 },
  );
  await fsp.writeFile(
    workflowPath,
    `${canonicalJson(stored)}\n`,
    { mode: 0o600 },
  );

  const headSha = await commitImplementation(state.repository);
  const beforeWorkflow = await fsp.readFile(workflowPath);
  const beforeAudit = await fsp.readFile(auditPath);
  const beforeAuditHead = await fsp.readFile(auditHeadPath);
  await assert.rejects(
    recordWorkflowHead(
      state.store,
      workflow.workflow_id,
      stored.revision,
      headSha,
    ),
    (error) => {
      assert.equal(
        error.code,
        "WORKFLOW_CANCELLATION_RESERVE_EXHAUSTED",
      );
      return true;
    },
  );
  assert.deepEqual(await fsp.readFile(workflowPath), beforeWorkflow);
  assert.deepEqual(await fsp.readFile(auditPath), beforeAudit);
  assert.deepEqual(await fsp.readFile(auditHeadPath), beforeAuditHead);

  await assert.rejects(
    cancelAutonomousWorkflow(
      state.store,
      workflow.workflow_id,
      stored.revision,
      {
        operatorLabel: "Test Operator",
        rationale: "\0".repeat(5_462),
      },
    ),
    /canonical byte limit/,
  );
  assert.deepEqual(await fsp.readFile(workflowPath), beforeWorkflow);
  assert.deepEqual(await fsp.readFile(auditPath), beforeAudit);
  assert.deepEqual(await fsp.readFile(auditHeadPath), beforeAuditHead);

  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    stored.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "\0".repeat(5_461),
    },
  );
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok((await fsp.stat(auditPath)).size > beforeAudit.length);
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

  const resumed = await resumeAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    paused.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "The Codex task provider is available again.",
    },
  );
  assert.equal(resumed.status, "ACTIVE");
  assert.equal(resumed.phase, "DISPATCH_CODEX_REVIEWER");
  assert.equal(resumed.pause, null);
  assert.equal(resumed.active_action.action_id, planned.action.action_id);
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "CREATE_CODEX_REVIEWER_TASK",
  );

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
  assert.equal(audit.at(-1).event, "WORKFLOW_RESUMED");
  assert.deepEqual(audit.at(-1).metadata, {
    operator_label: "Test Operator",
    pause_reason_code: "TASK_ORCHESTRATION_UNAVAILABLE",
    rationale: "The Codex task provider is available again.",
    resumed_phase: "DISPATCH_CODEX_REVIEWER",
  });

  const executing = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    resumed.revision,
    planned.action.action_id,
  );
  assert.equal(executing.active_action.status, "EXECUTING");
});

test("workflow listing ignores incomplete directories but surfaces corrupt state", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflowsRoot = path.join(state.store, "workflows");
  await fsp.mkdir(
    path.join(workflowsRoot, "rbwf-2026-07-30T000000-000Z-deadbeef"),
    { recursive: true },
  );
  assert.deepEqual(await listAutonomousWorkflows(state.store), []);

  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  await fsp.writeFile(
    path.join(
      workflowsRoot,
      workflow.workflow_id,
      "workflow.json",
    ),
    "{malformed",
    { mode: 0o600 },
  );
  await assert.rejects(
    listAutonomousWorkflows(state.store),
    /WORKFLOW_STATE_INVALID/,
  );
});

test("workflow listing surfaces missing mandatory audit artifacts", async (t) => {
  for (const artifact of [
    "action-audit.jsonl",
    "action-audit-head.json",
  ]) {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const workflow = await startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    );
    await fsp.rm(
      path.join(
        state.store,
        "workflows",
        workflow.workflow_id,
        artifact,
      ),
    );
    await assert.rejects(
      listAutonomousWorkflows(state.store),
      /WORKFLOW_AUDIT_CORRUPT/,
    );
  }
});

test("a clean review advances through push and draft PR to publication", async (t) => {
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

  await finalizeLocalGate(state.store, review.id);
  const gated = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    clean.revision,
  );
  assert.equal(gated.phase, "LOCAL_GATE_PASSED");
  assert.equal(gated.current_head_sha, headSha);
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "PLAN_PUSH",
  );

  const pushPlanned = await planWorkflowPush(
    state.store,
    workflow.workflow_id,
    gated.revision,
  );
  assert.equal(pushPlanned.workflow.phase, "PUSH_GATED_HEAD");
  assert.equal(pushPlanned.action.kind, "PUSH_TOPIC_BRANCH");
  assert.equal(pushPlanned.action.correlation_marker, null);
  assert.equal(pushPlanned.dispatch, null);
  assert.equal(pushPlanned.action.target.head_sha, headSha);
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      pushPlanned.workflow.revision,
      pushPlanned.action.action_id,
    ),
    /resolved to the authorized repository/,
  );
  await assert.rejects(
    markWorkflowActionExecuting(
      state.store,
      workflow.workflow_id,
      pushPlanned.workflow.revision,
      pushPlanned.action.action_id,
      {
        resolved_repository_id: 999,
        resolved_url: pushPlanned.action.target.remote_url,
      },
    ),
    /resolved to the authorized repository/,
  );
  const pushExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    pushPlanned.workflow.revision,
    pushPlanned.action.action_id,
    {
      resolved_repository_id: 101,
      resolved_url: pushPlanned.action.target.remote_url,
    },
  );
  assert.equal(
    pushExecuting.active_action.executing_proof.resolved_repository_id,
    101,
  );
  const pushProof = {
    remoteRefSha: headSha,
    remoteRepositoryId: 101,
    remoteUrl: pushPlanned.action.target.remote_url,
  };
  await assert.rejects(
    recordPushObservation(
      state.store,
      workflow.workflow_id,
      pushExecuting.revision,
      pushPlanned.action.action_id,
      { ...pushProof, remoteRefSha: state.baseSha },
    ),
    /does not prove the authorized repository and pushed head/,
  );
  await assert.rejects(
    recordPushObservation(
      state.store,
      workflow.workflow_id,
      pushExecuting.revision,
      pushPlanned.action.action_id,
      { ...pushProof, remoteRepositoryId: 999 },
    ),
    /does not prove the authorized repository and pushed head/,
  );
  await assert.rejects(
    recordPushObservation(
      state.store,
      workflow.workflow_id,
      pushExecuting.revision,
      pushPlanned.action.action_id,
      {
        ...pushProof,
        remoteUrl: "ssh://git@github.com/attacker/review-bridge.git",
      },
    ),
    /does not prove the authorized repository and pushed head/,
  );
  const pushObserved = await recordPushObservation(
    state.store,
    workflow.workflow_id,
    pushExecuting.revision,
    pushPlanned.action.action_id,
    pushProof,
  );
  const pushed = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    pushObserved.revision,
    pushPlanned.action.action_id,
  );
  assert.equal(pushed.phase, "ENSURE_DRAFT_PR");
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "PLAN_DRAFT_PULL_REQUEST",
  );

  const prPlanned = await planDraftPullRequest(
    state.store,
    workflow.workflow_id,
    pushed.revision,
    { creatorActorId: 555, creatorActorType: "User" },
  );
  assert.match(prPlanned.action.correlation_marker, /^rbwf-pr-[0-9a-f]{32}$/);
  assert.equal(
    prPlanned.dispatch.body_marker,
    `<!-- ${prPlanned.action.correlation_marker} -->`,
  );
  const prExecuting = await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    prPlanned.workflow.revision,
    prPlanned.action.action_id,
  );
  const prObservation = {
    matchingPrNumbers: [7],
    prNumber: 7,
    repositoryId: 101,
    headRepositoryId: 101,
    baseBranch: "main",
    headBranch: "agent/workflow-core",
    headSha,
    draft: true,
    bodyMarker: `<!-- ${prPlanned.action.correlation_marker} -->`,
    creatorActorId: 555,
    creatorActorType: "User",
    url: "https://github.com/example/review-bridge/pull/7",
  };
  await assert.rejects(
    recordDraftPullRequestObservation(
      state.store,
      workflow.workflow_id,
      prExecuting.revision,
      prPlanned.action.action_id,
      { ...prObservation, draft: false },
    ),
    /WORKFLOW_ACTION_INVALID/,
  );
  await assert.rejects(
    recordDraftPullRequestObservation(
      state.store,
      workflow.workflow_id,
      prExecuting.revision,
      prPlanned.action.action_id,
      { ...prObservation, bodyMarker: "<!-- rbwf-pr-" + "0".repeat(32) + " -->" },
    ),
    /WORKFLOW_ACTION_INVALID/,
  );
  await assert.rejects(
    recordDraftPullRequestObservation(
      state.store,
      workflow.workflow_id,
      prExecuting.revision,
      prPlanned.action.action_id,
      { ...prObservation, headRepositoryId: 999 },
    ),
    /WORKFLOW_ACTION_INVALID/,
  );
  await assert.rejects(
    recordDraftPullRequestObservation(
      state.store,
      workflow.workflow_id,
      prExecuting.revision,
      prPlanned.action.action_id,
      { ...prObservation, creatorActorId: 666 },
    ),
    /WORKFLOW_ACTION_INVALID/,
  );
  const prObserved = await recordDraftPullRequestObservation(
    state.store,
    workflow.workflow_id,
    prExecuting.revision,
    prPlanned.action.action_id,
    prObservation,
  );
  const bound = await completeWorkflowAction(
    state.store,
    workflow.workflow_id,
    prObserved.revision,
    prPlanned.action.action_id,
  );
  assert.equal(bound.phase, "START_PUBLICATION");
  assert.equal(bound.pull_request.pr_number, 7);
  assert.equal(bound.pull_request.repository_id, 101);
  assert.equal(
    bound.claims.filter((entry) => entry.kind === "PULL_REQUEST").length,
    1,
  );
  assert.equal(
    bound.claims.find((entry) => entry.kind === "PULL_REQUEST")
      .created_revision,
    bound.revision,
  );
  assert.equal(
    (await getAutonomousWorkflowSummary(state.store, workflow.workflow_id))
      .next_action,
    "START_PUBLICATION",
  );

  // Cancellation retains all three claims until their reconciled release.
  const cancelled = await cancelAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
    bound.revision,
    {
      operatorLabel: "Test Operator",
      rationale: "Stop after the publication boundary.",
    },
  );
  assert.equal(
    cancelled.claims.filter((entry) => entry.disposition === "ACTIVE").length,
    3,
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
    released.claims.every((entry) => entry.disposition === "RELEASED"),
    true,
  );
});


test("one pull request cannot be claimed by two workflows", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  const drive = async (workflowId, startRevision, reviewId, prNumber, headBranch) => {
    const { completed } = await dispatchReviewer(
      state.store,
      workflowId,
      startRevision,
      reviewId,
    );
    await submitInitialReview(state.store, reviewId, [], "CODEX_TASK");
    const clean = await advanceLocalWorkflow(
      state.store,
      workflowId,
      completed.revision,
    );
    await finalizeLocalGate(state.store, reviewId);
    const gated = await advanceLocalWorkflow(
      state.store,
      workflowId,
      clean.revision,
    );
    const pushPlanned = await planWorkflowPush(
      state.store,
      workflowId,
      gated.revision,
    );
    const pushExecuting = await markWorkflowActionExecuting(
      state.store,
      workflowId,
      pushPlanned.workflow.revision,
      pushPlanned.action.action_id,
      {
        resolved_repository_id: 101,
        resolved_url: pushPlanned.action.target.remote_url,
      },
    );
    const pushObserved = await recordPushObservation(
      state.store,
      workflowId,
      pushExecuting.revision,
      pushPlanned.action.action_id,
      {
        remoteRefSha: pushPlanned.action.target.head_sha,
        remoteRepositoryId: 101,
        remoteUrl: pushPlanned.action.target.remote_url,
      },
    );
    const pushed = await completeWorkflowAction(
      state.store,
      workflowId,
      pushObserved.revision,
      pushPlanned.action.action_id,
    );
    const prPlanned = await planDraftPullRequest(
      state.store,
      workflowId,
      pushed.revision,
      { creatorActorId: 555, creatorActorType: "User" },
    );
    const prExecuting = await markWorkflowActionExecuting(
      state.store,
      workflowId,
      prPlanned.workflow.revision,
      prPlanned.action.action_id,
    );
    const prObserved = await recordDraftPullRequestObservation(
      state.store,
      workflowId,
      prExecuting.revision,
      prPlanned.action.action_id,
      {
        matchingPrNumbers: [prNumber],
        prNumber,
        repositoryId: 101,
        headRepositoryId: 101,
        baseBranch: "main",
        headBranch,
        headSha: prPlanned.action.target.head_sha,
        draft: true,
        bodyMarker: `<!-- ${prPlanned.action.correlation_marker} -->`,
        creatorActorId: 555,
        creatorActorType: "User",
        url: `https://github.com/example/review-bridge/pull/${prNumber}`,
      },
    );
    return { prPlanned, prObserved };
  };

  const first = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commitImplementation(state.repository);
  const firstRecorded = await recordWorkflowHead(
    state.store,
    first.workflow_id,
    first.revision,
    headSha,
  );
  const firstReview = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: first.requirement,
    implementationScope: first.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  const firstBound = await bindWorkflowReview(
    state.store,
    first.workflow_id,
    firstRecorded.revision,
    firstReview.id,
  );
  const firstRun = await drive(
    first.workflow_id,
    firstBound.revision,
    firstReview.id,
    7,
    "agent/workflow-core",
  );
  const firstDone = await completeWorkflowAction(
    state.store,
    first.workflow_id,
    firstRun.prObserved.revision,
    firstRun.prPlanned.action.action_id,
  );
  assert.equal(firstDone.pull_request.pr_number, 7);

  git(state.repository, "switch", "-c", "agent/workflow-alt", state.baseSha);
  const second = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, {
      topicBranch: "agent/workflow-alt",
      publicationTarget: {
        base_repository_id: 101,
        base_owner: "example",
        base_repo: "review-bridge",
        base_branch: "main",
        head_repository_id: 101,
        head_owner: "example",
        head_repo: "review-bridge",
        head_branch: "agent/workflow-alt",
        push_remote: "origin",
      },
    }),
  );
  git(state.repository, "merge", "--ff-only", headSha);
  const secondRecorded = await recordWorkflowHead(
    state.store,
    second.workflow_id,
    second.revision,
    headSha,
  );
  const secondReview = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: second.requirement,
    implementationScope: second.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  const secondBound = await bindWorkflowReview(
    state.store,
    second.workflow_id,
    secondRecorded.revision,
    secondReview.id,
  );
  const secondRun = await drive(
    second.workflow_id,
    secondBound.revision,
    secondReview.id,
    7,
    "agent/workflow-alt",
  );
  await assert.rejects(
    completeWorkflowAction(
      state.store,
      second.workflow_id,
      secondRun.prObserved.revision,
      secondRun.prPlanned.action.action_id,
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_OWNERSHIP_CONFLICT");
      assert.equal(error.details.owner_workflow_id, first.workflow_id);
      return true;
    },
  );
  const blocked = await getAutonomousWorkflow(
    state.store,
    second.workflow_id,
  );
  assert.equal(blocked.phase, "ENSURE_DRAFT_PR");
  assert.equal(blocked.active_action.status, "OBSERVED");
  assert.equal(blocked.pull_request, null);
});


test("a claim committed to the audit but not the ledger still blocks a rival", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  const drive = async (workflowId, startRevision, reviewId, prNumber, headBranch) => {
    const { completed } = await dispatchReviewer(
      state.store,
      workflowId,
      startRevision,
      reviewId,
    );
    await submitInitialReview(state.store, reviewId, [], "CODEX_TASK");
    const clean = await advanceLocalWorkflow(
      state.store,
      workflowId,
      completed.revision,
    );
    await finalizeLocalGate(state.store, reviewId);
    const gated = await advanceLocalWorkflow(
      state.store,
      workflowId,
      clean.revision,
    );
    const pushPlanned = await planWorkflowPush(
      state.store,
      workflowId,
      gated.revision,
    );
    const pushExecuting = await markWorkflowActionExecuting(
      state.store,
      workflowId,
      pushPlanned.workflow.revision,
      pushPlanned.action.action_id,
      {
        resolved_repository_id: 101,
        resolved_url: pushPlanned.action.target.remote_url,
      },
    );
    const pushObserved = await recordPushObservation(
      state.store,
      workflowId,
      pushExecuting.revision,
      pushPlanned.action.action_id,
      {
        remoteRefSha: pushPlanned.action.target.head_sha,
        remoteRepositoryId: 101,
        remoteUrl: pushPlanned.action.target.remote_url,
      },
    );
    const pushed = await completeWorkflowAction(
      state.store,
      workflowId,
      pushObserved.revision,
      pushPlanned.action.action_id,
    );
    const prPlanned = await planDraftPullRequest(
      state.store,
      workflowId,
      pushed.revision,
      { creatorActorId: 555, creatorActorType: "User" },
    );
    const prExecuting = await markWorkflowActionExecuting(
      state.store,
      workflowId,
      prPlanned.workflow.revision,
      prPlanned.action.action_id,
    );
    const prObserved = await recordDraftPullRequestObservation(
      state.store,
      workflowId,
      prExecuting.revision,
      prPlanned.action.action_id,
      {
        matchingPrNumbers: [prNumber],
        prNumber,
        repositoryId: 101,
        headRepositoryId: 101,
        baseBranch: "main",
        headBranch,
        headSha: prPlanned.action.target.head_sha,
        draft: true,
        bodyMarker: `<!-- ${prPlanned.action.correlation_marker} -->`,
        creatorActorId: 555,
        creatorActorType: "User",
        url: `https://github.com/example/review-bridge/pull/${prNumber}`,
      },
    );
    return { prPlanned, prObserved };
  };

  const first = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commitImplementation(state.repository);
  const firstRecorded = await recordWorkflowHead(
    state.store,
    first.workflow_id,
    first.revision,
    headSha,
  );
  const firstReview = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: first.requirement,
    implementationScope: first.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  const firstBound = await bindWorkflowReview(
    state.store,
    first.workflow_id,
    firstRecorded.revision,
    firstReview.id,
  );
  const firstRun = await drive(
    first.workflow_id,
    firstBound.revision,
    firstReview.id,
    7,
    "agent/workflow-core",
  );
  const firstWorkflowPath = path.join(
    state.store,
    "workflows",
    first.workflow_id,
    "workflow.json",
  );
  const staleLedger = await fsp.readFile(firstWorkflowPath);
  const firstDone = await completeWorkflowAction(
    state.store,
    first.workflow_id,
    firstRun.prObserved.revision,
    firstRun.prPlanned.action.action_id,
  );
  assert.equal(firstDone.pull_request.pr_number, 7);
  // Simulate the crash window: the completion's audit event is committed,
  // but the ledger write never landed.
  await fsp.writeFile(firstWorkflowPath, staleLedger, { mode: 0o600 });

  git(state.repository, "switch", "-c", "agent/workflow-alt", state.baseSha);
  const second = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, {
      topicBranch: "agent/workflow-alt",
      publicationTarget: {
        base_repository_id: 101,
        base_owner: "example",
        base_repo: "review-bridge",
        base_branch: "main",
        head_repository_id: 101,
        head_owner: "example",
        head_repo: "review-bridge",
        head_branch: "agent/workflow-alt",
        push_remote: "origin",
      },
    }),
  );
  git(state.repository, "merge", "--ff-only", headSha);
  const secondRecorded = await recordWorkflowHead(
    state.store,
    second.workflow_id,
    second.revision,
    headSha,
  );
  const secondReview = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: second.requirement,
    implementationScope: second.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  const secondBound = await bindWorkflowReview(
    state.store,
    second.workflow_id,
    secondRecorded.revision,
    secondReview.id,
  );
  const secondRun = await drive(
    second.workflow_id,
    secondBound.revision,
    secondReview.id,
    7,
    "agent/workflow-alt",
  );
  await assert.rejects(
    completeWorkflowAction(
      state.store,
      second.workflow_id,
      secondRun.prObserved.revision,
      secondRun.prPlanned.action.action_id,
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_OWNERSHIP_CONFLICT");
      assert.equal(error.details.owner_workflow_id, first.workflow_id);
      return true;
    },
  );
  // The conflict scan's locked load also healed the crashed ledger.
  const healed = await getAutonomousWorkflow(state.store, first.workflow_id);
  assert.equal(healed.pull_request.pr_number, 7);
  assert.equal(
    healed.claims.filter((entry) => entry.kind === "PULL_REQUEST").length,
    1,
  );
});


test("a v0.5.0 ledger without executing_proof still loads and scans", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const planned = await planCodexTaskDispatch(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    review.id,
  );

  // Reconstruct the store shape v0.5.0 persisted: the active action has no
  // executing_proof field anywhere — ledger, audit event, or cursor.
  const workflowRoot = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
  );
  const workflowPath = path.join(workflowRoot, "workflow.json");
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  delete stored.active_action.executing_proof;
  const legacyEvent = workflowAuditEvent(stored, {
    sequence: 1,
    previousEventSha256: null,
    eventId: "a".repeat(32),
    at: stored.updated_at,
    event: "ACTION_PLANNED",
  });
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit.jsonl"),
    legacyEvent.bytes,
    { mode: 0o600 },
  );
  await fsp.writeFile(
    path.join(workflowRoot, "action-audit-head.json"),
    `${canonicalJson({
      version: 1,
      workflow_id: workflow.workflow_id,
      committed_bytes: legacyEvent.bytes.length,
      next_sequence: 2,
      last_event_sha256: legacyEvent.event.event_sha256,
    })}\n`,
    { mode: 0o600 },
  );
  stored.action_audit = {
    next_sequence: 2,
    last_event_sha256: legacyEvent.event.event_sha256,
  };
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });

  const loaded = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(loaded.active_action.status, "PLANNED");

  // The legacy ledger must not poison store-wide claim scans either.
  git(state.repository, "switch", "-c", "agent/workflow-alt", state.baseSha);
  const second = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, {
      topicBranch: "agent/workflow-alt",
      publicationTarget: {
        base_repository_id: 101,
        base_owner: "example",
        base_repo: "review-bridge",
        base_branch: "main",
        head_repository_id: 101,
        head_owner: "example",
        head_repo: "review-bridge",
        head_branch: "agent/workflow-alt",
        push_remote: "origin",
      },
    }),
  );
  assert.equal(second.status, "ACTIVE");
});

test("a drifted or dirty head cannot plan the gated push", async (t) => {
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
  await finalizeLocalGate(state.store, review.id);
  const gated = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    clean.revision,
  );
  assert.equal(gated.current_head_sha, headSha);

  const drifted = await commitImplementation(
    state.repository,
    "export const value = 99;\n",
  );
  assert.notEqual(drifted, headSha);
  await assert.rejects(
    planWorkflowPush(state.store, workflow.workflow_id, gated.revision),
    (error) => {
      assert.equal(error.code, "WORKFLOW_HEAD_MISMATCH");
      return true;
    },
  );
  git(state.repository, "reset", "--hard", headSha);

  await fsp.writeFile(
    path.join(state.repository, "untracked.txt"),
    "dirty\n",
  );
  await assert.rejects(
    planWorkflowPush(state.store, workflow.workflow_id, gated.revision),
    /WORKTREE_DIRTY/,
  );
  await fsp.rm(path.join(state.repository, "untracked.txt"));

  // The intent binds the push URL — the URL git push actually uses — not
  // the fetch URL, and a remote with several push URLs cannot be bound.
  const pushUrl = "ssh://git@github.com/example/review-bridge-push.git";
  git(state.repository, "remote", "set-url", "--push", "origin", pushUrl);
  git(
    state.repository,
    "remote",
    "set-url",
    "--add",
    "--push",
    "origin",
    "ssh://git@github.com/example/review-bridge-push2.git",
  );
  await assert.rejects(
    planWorkflowPush(state.store, workflow.workflow_id, gated.revision),
    /exactly one push URL/,
  );
  git(
    state.repository,
    "remote",
    "set-url",
    "--delete",
    "--push",
    "origin",
    "ssh://git@github.com/example/review-bridge-push2.git",
  );

  // A credential-bearing push URL must be rejected before anything persists.
  for (const credentialUrl of [
    "https://x-access-token:secret@github.com/example/review-bridge.git",
    "https://ghp_token@github.com/example/review-bridge.git",
    "https://github.com/example/review-bridge.git?access_token=secret",
    "https://github.com/example/review-bridge.git#secret-fragment",
  ]) {
    git(state.repository, "remote", "set-url", "--push", "origin", credentialUrl);
    await assert.rejects(
      planWorkflowPush(state.store, workflow.workflow_id, gated.revision),
      /embeds credentials|query or fragment/,
    );
  }
  git(state.repository, "remote", "set-url", "--push", "origin", pushUrl);

  const planned = await planWorkflowPush(
    state.store,
    workflow.workflow_id,
    gated.revision,
  );
  assert.equal(planned.workflow.phase, "PUSH_GATED_HEAD");
  // The bound URL is the push URL as git resolves it (insteadOf rewrites
  // included), so assert on the distinct push-URL identity rather than the
  // raw configured string.
  assert.ok(
    planned.action.target.remote_url.includes("review-bridge-push.git"),
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

test("a rereview prepared before the advance names the ran-ahead wedge", async (t) => {
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
  // The driver skips the AUTHOR_RESPONDED advance and prepares round two
  // directly: the review runs ahead of the workflow.
  await prepareRereview(state.store, review.id);

  await assert.rejects(
    advanceLocalWorkflow(state.store, workflow.workflow_id, fixed.revision),
    (error) => {
      assert.equal(error.code, "WORKFLOW_REVIEW_RAN_AHEAD");
      assert.match(error.message, /cancel the workflow/);
      return true;
    },
  );
  const stuck = await getAutonomousWorkflow(state.store, workflow.workflow_id);
  assert.equal(stuck.phase, "ADDRESS_LOCAL_FINDINGS");

  // The downstream statuses keep the same name: a completed rereview does
  // not turn the wedge back into the generic transition error.
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
  await assert.rejects(
    advanceLocalWorkflow(state.store, workflow.workflow_id, fixed.revision),
    (error) => {
      assert.equal(error.code, "WORKFLOW_REVIEW_RAN_AHEAD");
      return true;
    },
  );
});

test("a consumed continuation re-poll keeps the generic transition error", async (t) => {
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
    [
      {
        severity: "minor",
        title: "New edge case",
        explanation: "The rereview found a separate edge case.",
        recommendation: "Cover it.",
        path: "app.js",
        line: 1,
      },
    ],
    "CODEX_TASK",
  );
  const continuation = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    waiting.revision,
  );
  assert.equal(continuation.phase, "ADDRESS_LOCAL_FINDINGS");
  assert.equal(continuation.current_review.status, "CONTINUABLE_FINDINGS");

  // Every transition was consumed in order, so a re-poll is not a
  // ran-ahead wedge: it keeps the generic transition error.
  await assert.rejects(
    advanceLocalWorkflow(
      state.store,
      workflow.workflow_id,
      continuation.revision,
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_REVIEW_TRANSITION_INVALID");
      return true;
    },
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

  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const beforePause = await fsp.readFile(workflowPath);
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
  await assert.rejects(
    resumeAutonomousWorkflow(
      state.store,
      workflow.workflow_id,
      paused.revision,
      {
        operatorLabel: "Test Operator",
        rationale: "Attempt to bypass arbitration.",
      },
    ),
    /WORKFLOW_RESUME_INVALID/,
  );

  await fsp.writeFile(workflowPath, beforePause, { mode: 0o600 });
  const recovered = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.deepEqual(recovered.current_review, paused.current_review);
  assert.equal(recovered.progress_fingerprint, paused.progress_fingerprint);
  assert.deepEqual(recovered.pause, paused.pause);
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

test("uncontested rereview findings continue through a FULL review and obey the local budget", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, { localCycleBudget: 1 }),
  );
  const firstHead = await commitImplementation(state.repository);
  const recorded = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    firstHead,
  );
  const source = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  let workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    recorded.revision,
    source.id,
  );
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    source.id,
  ));
  await submitInitialReview(
    state.store,
    source.id,
    [{ severity: "major", title: "Initial defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );
  const workflowPath = path.join(
    state.store,
    "workflows",
    started.workflow_id,
    "workflow.json",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  // The ordinary cycle answers findings against its own review, and recording
  // the head leaves the workflow in this phase for the advance.
  assert.equal(workflow.phase, "ADDRESS_LOCAL_FINDINGS");
  assert.deepEqual(
    Object.keys(
      (await getAutonomousWorkflowSummary(state.store, started.workflow_id))
        .required_inputs,
    ),
    ["record_workflow_head", "advance_local_workflow"],
  );
  const fixedHead = await commitImplementation(
    state.repository,
    "export const value = 3;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    fixedHead,
  );
  await submitResolutions(state.store, source.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed it." },
  ]);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  await prepareRereview(state.store, source.id);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  await submitRereview(
    state.store,
    source.id,
    [{ finding_id: "F-001", decision: "resolved", rationale: "Verified." }],
    Array.from({ length: 100 }, (_, index) => ({
      severity: "minor",
      title: `New edge case ${index + 1}`,
      explanation: `The rereview found separate edge case ${index + 1}.`,
      recommendation: "Cover it.",
      path: "app.js",
      line: 1,
    })),
    "CODEX_TASK",
  );
  const beforeAppend = await fsp.readFile(workflowPath);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  await fsp.writeFile(workflowPath, beforeAppend, { mode: 0o600 });
  workflow = await getAutonomousWorkflow(state.store, started.workflow_id);
  assert.equal(workflow.phase, "ADDRESS_LOCAL_FINDINGS");
  assert.equal(
    workflow.local_review_cycles.filter((cycle) => cycle.addressed_head_sha != null)
      .length,
    0,
  );
  assert.equal(workflow.local_review_cycles.length, 1);
  assert.equal(
    workflow.local_review_cycles[0].continued_from_review_id,
    source.id,
  );
  assert.equal(workflow.local_review_cycles[0].findings.length, 100);
  assert.equal(workflow.local_review_cycles[0].findings[0].finding_id, "F-002");
  // The head about to be recorded closes this continuation cycle and moves the
  // phase itself, so the summary must not also name the advance that the phase
  // it lands in refuses.
  assert.deepEqual(
    Object.keys(
      (await getAutonomousWorkflowSummary(state.store, started.workflow_id))
        .required_inputs,
    ),
    ["record_workflow_head"],
  );

  const continuationHead = await commitImplementation(
    state.repository,
    "export const value = 4;\n",
  );
  const beforePatch = await fsp.readFile(workflowPath);
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    continuationHead,
  );
  await fsp.writeFile(workflowPath, beforePatch, { mode: 0o600 });
  workflow = await getAutonomousWorkflow(state.store, started.workflow_id);
  assert.equal(workflow.phase, "PREPARE_LOCAL_REVIEW");
  assert.equal(
    workflow.local_review_cycles.filter((cycle) => cycle.addressed_head_sha != null)
      .length,
    1,
  );
  const followup = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
    forceFullReview: true,
    continuedFromReviewId: source.id,
  });
  const opened = await openReview(state.store, followup.id, "CODEX_TASK");
  assert.equal(opened.review_strategy.mode, "FULL");
  assert.equal(opened.carried_findings.length, 100);
  assert.equal(opened.carried_findings[0].finding_id, "F-002");
  assert.equal("rationale" in opened.carried_findings[0], false);
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    followup.id,
  );
  assert.equal(workflow.local_review_cycles[0].followup_review_id, followup.id);
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    followup.id,
  ));
  const auditPath = path.join(
    state.store,
    "workflows",
    started.workflow_id,
    "action-audit.jsonl",
  );
  const auditAfterDispatch = (await fsp.readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    auditAfterDispatch.some(
      (event) =>
        event.workflow_state.local_review_cycle_update?.kind === "APPEND" &&
        event.workflow_state.local_review_cycle_update.cycle.findings.length ===
          100,
    ),
  );
  assert.ok(
    auditAfterDispatch.some(
      (event) =>
        event.workflow_state.local_review_cycle_update?.kind ===
        "PATCH_LATEST",
    ),
  );
  assert.ok(
    auditAfterDispatch.every(
      (event) => !("local_review_cycles" in event.workflow_state),
    ),
  );
  assert.match(
    auditAfterDispatch.at(-1).workflow_state.local_review_cycles_sha256,
    /^[0-9a-f]{64}$/,
  );

  await submitInitialReview(
    state.store,
    followup.id,
    [{ severity: "major", title: "Follow-up defect", explanation: "Fix it." }],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  const secondFixedHead = await commitImplementation(
    state.repository,
    "export const value = 5;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    secondFixedHead,
  );
  await submitResolutions(state.store, followup.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed again." },
  ]);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  await prepareRereview(state.store, followup.id);
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  await submitRereview(
    state.store,
    followup.id,
    [{ finding_id: "F-001", decision: "resolved", rationale: "Verified." }],
    [{ severity: "minor", title: "Another edge", explanation: "One more." }],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  assert.equal(workflow.status, "PAUSED");
  assert.equal(workflow.pause.reason_code, "LOCAL_CYCLE_BUDGET_EXHAUSTED");
  assert.equal(workflow.local_review_cycles.length, 2);
  assert.equal("local_review_cycles" in workflow.pause, false);
  assert.equal(
    workflow.pause.local_review_cycles_sha256,
    sha256(canonicalJson(workflow.local_review_cycles)),
  );
  await assert.rejects(
    resumeAutonomousWorkflow(state.store, started.workflow_id, workflow.revision, {
      operatorLabel: "Test Operator",
      rationale: "Continue.",
    }),
    /budget must be extended/,
  );
  workflow = await extendLocalCycleBudget(
    state.store,
    started.workflow_id,
    workflow.revision,
    { newBudget: 2, operatorLabel: "Test Operator", rationale: "One more cycle." },
  );
  workflow = await resumeAutonomousWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
    { operatorLabel: "Test Operator", rationale: "Continue." },
  );
  assert.equal(workflow.phase, "ADDRESS_LOCAL_FINDINGS");
  assert.equal(workflow.local_cycle_budget, 2);
});

test("twelve maximum-count local continuation cycles fit the action audit", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  let head = await commitImplementation(state.repository);
  let workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    started.revision,
    head,
  );
  let review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: started.requirement,
    implementationScope: started.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  workflow = await bindWorkflowReview(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  ({ completed: workflow } = await dispatchReviewer(
    state.store,
    started.workflow_id,
    workflow.revision,
    review.id,
  ));

  for (let cycle = 1; cycle <= 12; cycle += 1) {
    await submitInitialReview(
      state.store,
      review.id,
      [{ severity: "major", title: `Defect ${cycle}`, explanation: "Fix it." }],
      "CODEX_TASK",
    );
    workflow = await advanceLocalWorkflow(
      state.store,
      started.workflow_id,
      workflow.revision,
    );
    head = await commitImplementation(
      state.repository,
      `export const value = ${cycle * 2 + 2};\n`,
    );
    workflow = await recordWorkflowHead(
      state.store,
      started.workflow_id,
      workflow.revision,
      head,
    );
    await submitResolutions(state.store, review.id, [
      { finding_id: "F-001", disposition: "fixed", rationale: "Fixed." },
    ]);
    workflow = await advanceLocalWorkflow(
      state.store,
      started.workflow_id,
      workflow.revision,
    );
    await prepareRereview(state.store, review.id);
    workflow = await advanceLocalWorkflow(
      state.store,
      started.workflow_id,
      workflow.revision,
    );
    await submitRereview(
      state.store,
      review.id,
      [{ finding_id: "F-001", decision: "resolved", rationale: "Verified." }],
      Array.from({ length: 100 }, (_, index) => ({
        severity: "minor",
        title: `Cycle ${cycle} edge ${index + 1}`,
        explanation: "A distinct edge case remains.",
      })),
      "CODEX_TASK",
    );
    workflow = await advanceLocalWorkflow(
      state.store,
      started.workflow_id,
      workflow.revision,
    );
    assert.equal(workflow.phase, "ADDRESS_LOCAL_FINDINGS");

    head = await commitImplementation(
      state.repository,
      `export const value = ${cycle * 2 + 3};\n`,
    );
    workflow = await recordWorkflowHead(
      state.store,
      started.workflow_id,
      workflow.revision,
      head,
    );
    const followup = await prepareReview(state.store, {
      repositoryPath: state.repository,
      baseRef: state.baseSha,
      requirement: started.requirement,
      implementationScope: started.implementation_scope,
      reviewerProvider: "CODEX_TASK",
      forceFullReview: true,
      continuedFromReviewId: review.id,
    });
    workflow = await bindWorkflowReview(
      state.store,
      started.workflow_id,
      workflow.revision,
      followup.id,
    );
    review = followup;
    if (cycle < 12) {
      ({ completed: workflow } = await dispatchReviewer(
        state.store,
        started.workflow_id,
        workflow.revision,
        review.id,
      ));
    }
  }

  assert.equal(workflow.local_review_cycles.length, 12);
  const auditPath = path.join(
    state.store,
    "workflows",
    started.workflow_id,
    "action-audit.jsonl",
  );
  const auditBytes = await fsp.readFile(auditPath);
  const events = auditBytes.toString("utf8").trim().split("\n").map(JSON.parse);
  const updates = events
    .map((event) => event.workflow_state.local_review_cycle_update)
    .filter(Boolean);
  assert.equal(updates.filter((update) => update.kind === "APPEND").length, 12);
  assert.equal(
    updates.filter((update) => update.kind === "PATCH_LATEST").length,
    24,
  );
  assert.ok(
    events.every(
      (event) => !("local_review_cycles" in event.workflow_state),
    ),
  );
  assert.ok(
    events.every(
      (event) => Buffer.byteLength(canonicalJson(event)) <= 256 * 1024,
    ),
  );
  assert.ok(auditBytes.length < 4 * 1024 * 1024 - 2 * (256 * 1024 + 1));
});

test("author responses retain the findings phase after unrecorded head drift", async (t) => {
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
      evidence: "The recorded descendant head contains the fix.",
    },
  ]);
  const unrecordedHead = await commitImplementation(
    state.repository,
    "export const value = 4;\n",
  );

  await assert.rejects(
    advanceLocalWorkflow(
      state.store,
      workflow.workflow_id,
      fixed.revision,
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_HEAD_MISMATCH");
      return true;
    },
  );
  const unchanged = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(unchanged.phase, "ADDRESS_LOCAL_FINDINGS");
  assert.equal(unchanged.revision, fixed.revision);

  const recovered = await recordWorkflowHead(
    state.store,
    workflow.workflow_id,
    unchanged.revision,
    unrecordedHead,
  );
  const responded = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    recovered.revision,
  );
  assert.equal(responded.phase, "PREPARE_REREVIEW");
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
    [
      {
        severity: "minor",
        title: "New round-two risk",
        explanation: "The rereview found an additional unresolved risk.",
      },
    ],
    "CODEX_TASK",
  );
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const beforePause = await fsp.readFile(workflowPath);
  const paused = await advanceLocalWorkflow(
    state.store,
    workflow.workflow_id,
    rereview.revision,
  );
  assert.equal(paused.status, "PAUSED");
  assert.equal(paused.phase, "PAUSED_HUMAN");
  assert.equal(paused.pause.reason_code, "LOCAL_REVIEW_HUMAN_REQUIRED");
  assert.equal(paused.pause.review_id, review.id);

  await fsp.writeFile(workflowPath, beforePause, { mode: 0o600 });
  const recovered = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.deepEqual(recovered.current_review, paused.current_review);
  assert.equal(recovered.progress_fingerprint, paused.progress_fingerprint);
  assert.deepEqual(recovered.pause, paused.pause);
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
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const ledgerBeforeRepeat = await fsp.readFile(workflowPath, "utf8");

  await assert.rejects(
    releaseWorkflowClaims(
      state.store,
      workflow.workflow_id,
      released.revision,
      {
        operatorLabel: "Test Operator",
        rationale: "Repeat release must not mutate the ledger.",
        reconciledClaims: [],
      },
    ),
    /WORKFLOW_CLAIMS_ALREADY_RELEASED/,
  );
  assert.equal(await fsp.readFile(workflowPath, "utf8"), ledgerBeforeRepeat);
  const intact = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(intact.revision, released.revision);
  assert.equal(
    intact.claims.every((claim) => claim.disposition === "RELEASED"),
    true,
  );
});

test("a torn claim release cannot be represented in the workflow ledger", async (t) => {
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
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));

  const partial = structuredClone(stored);
  partial.claims[0].disposition = "RELEASED";
  partial.claims[0].released_at = new Date().toISOString();
  await fsp.writeFile(workflowPath, `${canonicalJson(partial)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    /WORKFLOW_CLAIMS_INVALID/,
  );

  const unevidenced = structuredClone(stored);
  const releasedAt = new Date().toISOString();
  for (const entry of unevidenced.claims) {
    entry.disposition = "RELEASED";
    entry.released_at = releasedAt;
  }
  await fsp.writeFile(workflowPath, `${canonicalJson(unevidenced)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    /WORKFLOW_CLAIMS_INVALID/,
  );

  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });
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


test("a verdict recorded before dispatch completion cannot be adopted", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { workflow, review } = await prepareBoundWorkflow(state);
  const planned = await planCodexTaskDispatch(
    state.store,
    workflow.workflow_id,
    workflow.revision,
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
      matchingTaskIds: ["task-early"],
      taskId: "task-early",
      title: planned.dispatch.title,
      prompt: planned.dispatch.prompt,
    },
  );

  // A verdict lands between task observation and dispatch completion: it
  // predates the completed independent task and must not be adopted.
  await submitInitialReview(state.store, review.id, [], "CODEX_TASK");

  await assert.rejects(
    completeWorkflowAction(
      state.store,
      workflow.workflow_id,
      observed.revision,
      planned.action.action_id,
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_REVIEW_TRANSITION_INVALID");
      return true;
    },
  );
  const stuck = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(stuck.phase, "DISPATCH_CODEX_REVIEWER");
  assert.equal(stuck.active_action.status, "OBSERVED");
  assert.equal(stuck.reviewer_task, null);
});


test("one local review cannot serve two workflows", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  const first = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  git(state.repository, "switch", "-c", "agent/workflow-alt");
  const second = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha, {
      topicBranch: "agent/workflow-alt",
      publicationTarget: {
        base_repository_id: 101,
        base_owner: "example",
        base_repo: "review-bridge",
        base_branch: "main",
        head_repository_id: 101,
        head_owner: "example",
        head_repo: "review-bridge",
        head_branch: "agent/workflow-alt",
        push_remote: "origin",
      },
    }),
  );

  const headSha = await commitImplementation(state.repository);
  const secondRecorded = await recordWorkflowHead(
    state.store,
    second.workflow_id,
    second.revision,
    headSha,
  );
  git(state.repository, "switch", "agent/workflow-core");
  git(state.repository, "merge", "--ff-only", headSha);
  const firstRecorded = await recordWorkflowHead(
    state.store,
    first.workflow_id,
    first.revision,
    headSha,
  );

  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: first.requirement,
    implementationScope: first.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  const bound = await bindWorkflowReview(
    state.store,
    first.workflow_id,
    firstRecorded.revision,
    review.id,
  );
  assert.equal(bound.current_review.review_id, review.id);

  git(state.repository, "switch", "agent/workflow-alt");
  await assert.rejects(
    bindWorkflowReview(
      state.store,
      second.workflow_id,
      secondRecorded.revision,
      review.id,
    ),
    (error) => {
      assert.equal(error.code, "WORKFLOW_REVIEW_OWNERSHIP_CONFLICT");
      assert.equal(error.details.owner_workflow_id, first.workflow_id);
      return true;
    },
  );

  // The losing workflow still binds its own separate review.
  const separate = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: second.requirement,
    implementationScope: second.implementation_scope,
    reviewerProvider: "CODEX_TASK",
  });
  const rebound = await bindWorkflowReview(
    state.store,
    second.workflow_id,
    secondRecorded.revision,
    separate.id,
  );
  assert.equal(rebound.current_review.review_id, separate.id);
});

test("a fabricated claim release fails the audit binding and keeps the branch owned", async (t) => {
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
      rationale: "Stop before the tamper attempt.",
    },
  );
  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  const releasedAt = new Date().toISOString();
  const tampered = structuredClone(stored);
  for (const entry of tampered.claims) {
    entry.disposition = "RELEASED";
    entry.released_at = releasedAt;
  }
  tampered.claim_release = {
    operator_label: "Test Operator",
    rationale: "Fabricated release without an audited transition.",
    released_at: releasedAt,
    reconciliation: [],
  };
  tampered.revision += 1;
  await fsp.writeFile(workflowPath, `${canonicalJson(tampered)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    /WORKFLOW_AUDIT_CORRUPT/,
  );
  await assert.rejects(
    startAutonomousWorkflow(
      state.store,
      workflowInput(state.repository, state.baseSha),
    ),
    /WORKFLOW_AUDIT_CORRUPT/,
  );

  // The audited release still works and frees the branch for a successor.
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });
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
    released.claims.every((entry) => entry.disposition === "RELEASED"),
    true,
  );
  const successor = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  assert.equal(successor.status, "ACTIVE");
});

test("an active workflow cannot carry released claims", async (t) => {
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
  const releasedAt = new Date().toISOString();
  for (const entry of stored.claims) {
    entry.disposition = "RELEASED";
    entry.released_at = releasedAt;
  }
  stored.claim_release = {
    operator_label: "Test Operator",
    rationale: "Tampered release on an active workflow.",
    released_at: releasedAt,
    reconciliation: [],
  };
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    /WORKFLOW_CLAIMS_INVALID/,
  );
});
