import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  getAutonomousTerminal,
  getInvalidatedResolutionPlan,
  getPublication,
  recordGithubSnapshot,
} from "../src/publication.mjs";
import {
  advanceRemoteWorkflow,
  getAutonomousWorkflow,
  markWorkflowActionExecuting,
  planThreadUnresolve,
} from "../src/workflow.mjs";
import {
  iso,
  retimeObservation,
} from "./helpers/github-observation.mjs";
import {
  CODEX_ACTOR_ID,
  PR_NUMBER,
  REPOSITORY_ID,
  gateAndPublishHead,
  reachCompletedPreResolvedPostReady,
  reachPostReady,
} from "./helpers/publication-chain";
import { TOPIC_BRANCH } from "./helpers/repository-fixture";

const execFileAsync = promisify(execFile);
const recoveryDriver = fileURLToPath(
  new URL("./helpers/recovery-driver", import.meta.url),
);

test("the complete autonomous narrative reaches a durable MERGE_READY terminal", async (t) => {
  const firstHeadPublisher = (state, workflow, headSha, label) =>
    gateAndPublishHead(state, workflow, headSha, label, {
      localFinding: {
        finding: {
          severity: "major",
          title: "Fix the local implementation",
          explanation: "The first implementation needs a committed repair.",
        },
        fixedContent: "export const value = 20;\n",
        resolution: {
          finding_id: "F-001",
          disposition: "fixed",
          rationale: "Committed the requested local repair.",
          evidence: "The descendant head contains the repair.",
        },
        rereview: {
          finding_id: "F-001",
          decision: "resolved",
          rationale: "The committed descendant fixes the finding.",
        },
      },
    });
  const { state, workflow, second, recordedPostReady, postReadyAt } =
    await reachCompletedPreResolvedPostReady(t, {
      outcome: "RESOLVED",
      firstHeadPublisher,
    });

  const projection = await getAutonomousTerminal(state.store, second.reviewId, {
    clock: () => postReadyAt + 20,
  });
  assert.equal(projection.status, "MERGE_READY");
  assert.equal(projection.observation_revision, recordedPostReady.revision);
  const terminal = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    { clock: () => postReadyAt + 25 },
  );
  assert.equal(terminal.status, "MERGE_READY");
  assert.equal(terminal.phase, "POST_READY");
  assert.equal(terminal.terminal.status, "MERGE_READY");
  assert.equal(terminal.terminal.publication_id, second.reviewId);
  assert.equal(terminal.terminal.observation_revision, recordedPostReady.revision);
  assert.equal(terminal.attempts.length, 3);
  assert.equal(terminal.attempts[0].review_id, terminal.attempts[1].review_id);
  assert.notEqual(terminal.attempts[1].review_id, terminal.attempts[2].review_id);
  assert.equal(terminal.addressed_findings.length, 1);
  assert.equal(terminal.thread_replies.length, 1);
  assert.equal(terminal.thread_resolutions[0].outcome, "RESOLVED");
  assert.equal(terminal.ready_marks.length, 1);

  const reread = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.deepEqual(reread.terminal, terminal.terminal);
});

test("a fresh process reconciles an accepted mark-ready without a duplicate write", async (t) => {
  let providerPath;
  const { state, workflow } = await reachPostReady(t, {
    markReadyRecovery: async ({ state: fixture, workflowId, headSha }) => {
      providerPath = path.join(fixture.root, "mark-ready-provider.json");
      await writeProvider(providerPath, {
        kind: "MARK_PR_READY",
        write_count: 1,
        repository_id: REPOSITORY_ID,
        pr_number: PR_NUMBER,
        base_branch: "main",
        head_branch: TOPIC_BRANCH,
        head_sha: headSha,
        is_draft: false,
      });
      await runFreshRecovery(fixture.store, workflowId, providerPath);
      return getAutonomousWorkflow(fixture.store, workflowId);
    },
  });

  assert.equal(workflow.phase, "POST_READY");
  assert.equal(workflow.ready_marks.length, 1);
  const provider = await readProvider(providerPath);
  assert.equal(provider.write_count, 1);
  assert.equal(provider.recovered_phase, "POST_READY");
  assert.equal(
    (await getAutonomousWorkflow(state.store, workflow.workflow_id)).active_action,
    null,
  );
});

test("a fresh process reconciles an accepted thread unresolve without a duplicate write", async (t) => {
  const { state, workflow, second, recordedPostReady } =
    await reachCompletedPreResolvedPostReady(t, { outcome: "RESOLVED" });
  const publication = await getPublication(state.store, second.reviewId);
  const moved = structuredClone(publication.latest_observation);
  const movedAt = Date.parse(moved.observed_at) + 1_000;
  retimeObservation(moved, movedAt);
  const thread = moved.review_threads.threads[0];
  thread.comment_count += 1;
  thread.comments.push({
    id: "PRRC_recovery_follow_up",
    database_id: 903,
    created_at: iso(movedAt - 100),
    updated_at: iso(movedAt - 100),
    actor: { id: CODEX_ACTOR_ID, type: "Bot", login: "codex" },
    review: null,
  });
  await recordGithubSnapshot(
    state.store,
    second.reviewId,
    { expectedRevision: recordedPostReady.revision, observation: moved },
    { clock: () => movedAt + 10 },
  );
  const unresolving = await advanceRemoteWorkflow(
    state.store,
    workflow.workflow_id,
    workflow.revision,
    { clock: () => movedAt + 20 },
  );
  assert.equal(unresolving.phase, "RESOLVE_CODEX_THREADS");
  const plan = await getInvalidatedResolutionPlan(
    state.store,
    second.reviewId,
  );
  const planned = await planThreadUnresolve(
    state.store,
    workflow.workflow_id,
    unresolving.revision,
    { threadId: thread.id },
  );
  await markWorkflowActionExecuting(
    state.store,
    workflow.workflow_id,
    planned.workflow.revision,
    planned.action.action_id,
    {
      repository_id: REPOSITORY_ID,
      pr_number: PR_NUMBER,
      thread_id: thread.id,
      thread_watermark: plan.new_watermark,
      is_resolved: true,
    },
  );

  const providerPath = path.join(state.root, "unresolve-provider.json");
  await writeProvider(providerPath, {
    kind: "UNRESOLVE_REVIEW_THREAD",
    write_count: 1,
    repository_id: REPOSITORY_ID,
    pr_number: PR_NUMBER,
    thread_id: thread.id,
    thread_watermark: plan.new_watermark,
    observation: moved,
  });
  await runFreshRecovery(state.store, workflow.workflow_id, providerPath);

  const recovered = await getAutonomousWorkflow(
    state.store,
    workflow.workflow_id,
  );
  assert.equal(recovered.phase, "ENSURE_DRAFT_FOR_REPAIR");
  assert.equal(recovered.active_action, null);
  assert.equal(recovered.thread_unresolutions.length, 1);
  assert.equal(recovered.thread_unresolutions[0].action_id, planned.action.action_id);
  const provider = await readProvider(providerPath);
  assert.equal(provider.write_count, 1);
  assert.equal(provider.recovered_phase, "ENSURE_DRAFT_FOR_REPAIR");
});

async function runFreshRecovery(store, workflowId, providerPath) {
  await execFileAsync(process.execPath, [
    recoveryDriver,
    store,
    workflowId,
    providerPath,
  ], { timeout: 120_000 });
}

async function writeProvider(providerPath, provider) {
  await fsp.writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`);
}

async function readProvider(providerPath) {
  return JSON.parse(await fsp.readFile(providerPath, "utf8"));
}
