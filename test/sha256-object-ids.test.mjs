import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  prepareRereview,
  prepareReview,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";
import { adaptCodexEvidence } from "../src/github-adapter.mjs";
import { normalizeGithubObservation } from "../src/github-observation.mjs";
import {
  createObjectIdWidthScope,
  isLocalObjectId,
} from "../src/object-id.mjs";
import {
  authorizeRemotePublication,
  getPublication,
  startPublication,
} from "../src/publication.mjs";
import { buildScorecard } from "../src/scorecard.mjs";
import { atomicWriteCanonicalJson, canonicalJson } from "../src/storage.mjs";
import {
  advanceLocalWorkflow,
  bindWorkflowReview,
  completeWorkflowAction,
  getAutonomousWorkflow,
  markWorkflowActionExecuting,
  planCodexTaskDispatch,
  recordCodexTaskObservation,
  recordWorkflowHead,
  startAutonomousWorkflow,
} from "../src/workflow.mjs";
import { commit, fixture, git } from "./helpers/repository-fixture";
import {
  gateAndPublishHead,
  gateHeadLocally,
  publicationFilePath,
  reachRemoteWait,
  startInput,
  workflowInput,
} from "./helpers/publication-chain";

const SHA1_WIDTH = 40;
const SHA256_WIDTH = 64;

function sha256Fixture() {
  return fixture({ objectFormat: "sha256" });
}

const LOCAL_FINDING = {
  finding: {
    severity: "major",
    title: "Name the constant",
    explanation: "value is not a name.",
  },
  fixedContent: "export const namedValue = 2;\n",
  resolution: {
    finding_id: "F-001",
    disposition: "fixed",
    rationale: "Renamed the constant.",
  },
  rereview: {
    finding_id: "F-001",
    decision: "resolved",
    rationale: "The rename landed.",
  },
};

/** Bind a prepared review to the workflow and run it past its dispatch. */
async function dispatchReviewer(state, workflowId, revision, reviewId) {
  const bound = await bindWorkflowReview(
    state.store,
    workflowId,
    revision,
    reviewId,
  );
  const planned = await planCodexTaskDispatch(
    state.store,
    workflowId,
    bound.revision,
    reviewId,
  );
  const executing = await markWorkflowActionExecuting(
    state.store,
    workflowId,
    planned.workflow.revision,
    planned.action.action_id,
  );
  const observed = await recordCodexTaskObservation(
    state.store,
    workflowId,
    executing.revision,
    planned.action.action_id,
    {
      matchingTaskIds: [`task-${reviewId}`],
      taskId: `task-${reviewId}`,
      title: planned.dispatch.title,
      prompt: planned.dispatch.prompt,
    },
  );
  return completeWorkflowAction(
    state.store,
    workflowId,
    observed.revision,
    planned.action.action_id,
  );
}

test("the local object-id judge accepts both Git object-id widths", () => {
  assert.equal(isLocalObjectId("a".repeat(SHA1_WIDTH)), true);
  assert.equal(isLocalObjectId("a".repeat(SHA256_WIDTH)), true);
  for (const width of [0, 7, 39, 41, 63, 65]) {
    assert.equal(isLocalObjectId("a".repeat(width)), false, `width ${width}`);
  }
  assert.equal(isLocalObjectId("A".repeat(SHA1_WIDTH)), false);
  assert.equal(isLocalObjectId("g".repeat(SHA256_WIDTH)), false);
  for (const value of [null, undefined, 40, {}]) {
    assert.equal(isLocalObjectId(value), false, String(value));
  }
});

test("an object-id width scope pins the first width it admits", () => {
  const scope = createObjectIdWidthScope();
  assert.equal(scope.width, null);
  assert.equal(scope.admit("a".repeat(SHA256_WIDTH)), true);
  assert.equal(scope.width, SHA256_WIDTH);
  assert.equal(scope.admit("b".repeat(SHA256_WIDTH)), true);
  assert.equal(scope.admit("c".repeat(SHA1_WIDTH)), false);
  // A refused id does not repin the scope: the first width stays the width.
  assert.equal(scope.width, SHA256_WIDTH);

  const narrow = createObjectIdWidthScope();
  assert.equal(narrow.admit("a".repeat(SHA1_WIDTH)), true);
  assert.equal(narrow.admit("b".repeat(SHA256_WIDTH)), false);
});

test("a sha256 repository runs a full local review and local gate", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  assert.equal(
    git(state.repository, "rev-parse", "--show-object-format"),
    "sha256",
  );
  assert.equal(state.baseSha.length, SHA256_WIDTH);
  const headSha = await commit(state.repository, "export const value = 2;\n");
  assert.equal(headSha.length, SHA256_WIDTH);

  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: "Review a sha256 repository.",
    implementationScope: "Change app.js.",
  });
  assert.equal(review.status, "WAITING_FOR_REVIEW");
  await submitInitialReview(state.store, review.id, [LOCAL_FINDING.finding]);
  await commit(state.repository, LOCAL_FINDING.fixedContent);
  await submitResolutions(state.store, review.id, [LOCAL_FINDING.resolution]);
  await prepareRereview(state.store, review.id);
  await submitRereview(state.store, review.id, [LOCAL_FINDING.rereview], []);

  const gated = await finalizeLocalGate(state.store, review.id);
  assert.equal(gated.review.status, "LOCAL_GATE_PASSED");
  assert.equal(gated.gate.head_sha.length, SHA256_WIDTH);
  assert.equal(gated.gate.base_sha, state.baseSha);
});

test("a sha256 repository runs the autonomous workflow's local arc", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  assert.equal(workflow.base_sha.length, SHA256_WIDTH);
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const gated = await gateHeadLocally(state, workflow, headSha, "sha256", {
    localFinding: LOCAL_FINDING,
  });
  assert.equal(gated.workflow.phase, "LOCAL_GATE_PASSED");
  assert.equal(gated.headSha.length, SHA256_WIDTH);

  const stored = await getAutonomousWorkflow(state.store, workflow.workflow_id);
  assert.equal(stored.current_head_sha, gated.headSha);
  assert.equal(stored.base_sha, state.baseSha);
});

test("a sha256 repository records a local continuation cycle's addressed head", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
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
  workflow = await dispatchReviewer(
    state,
    started.workflow_id,
    workflow.revision,
    review.id,
  );
  await submitInitialReview(
    state.store,
    review.id,
    [LOCAL_FINDING.finding],
    "CODEX_TASK",
  );
  workflow = await advanceLocalWorkflow(
    state.store,
    started.workflow_id,
    workflow.revision,
  );
  const fixedHead = await commit(state.repository, LOCAL_FINDING.fixedContent);
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    fixedHead,
  );
  await submitResolutions(state.store, review.id, [LOCAL_FINDING.resolution]);
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
  // The rereview clears the first finding and raises a new one, which is what
  // opens a continuation cycle rather than a gate.
  await submitRereview(
    state.store,
    review.id,
    [LOCAL_FINDING.rereview],
    [
      {
        severity: "minor",
        title: "Cover the new branch",
        explanation: "The rereview found a separate edge case.",
        recommendation: "Cover it.",
        path: "app.js",
        line: 1,
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
  assert.equal(workflow.local_review_cycles.length, 1);
  assert.equal(workflow.local_review_cycles[0].addressed_head_sha, null);

  const addressedHead = await commit(
    state.repository,
    "export const namedValue = 3;\n",
  );
  workflow = await recordWorkflowHead(
    state.store,
    started.workflow_id,
    workflow.revision,
    addressedHead,
  );
  assert.equal(addressedHead.length, SHA256_WIDTH);
  assert.equal(
    workflow.local_review_cycles[0].addressed_head_sha,
    addressedHead,
  );

  // The scorecard reads the same cycle through its own guard.
  const scorecard = await buildScorecard(state.store);
  assert.deepEqual(scorecard.skipped_workflows, []);
  assert.equal(scorecard.workflows.local_cycles.started, 1);
  assert.equal(scorecard.workflows.local_cycles.addressed, 1);
});

test("a workflow ledger mixing object-id widths is refused by name", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  await gateHeadLocally(state, workflow, headSha, "sha256");

  const workflowPath = path.join(
    state.store,
    "workflows",
    workflow.workflow_id,
    "workflow.json",
  );
  const stored = JSON.parse(await fsp.readFile(workflowPath, "utf8"));
  assert.equal(stored.base_sha.length, SHA256_WIDTH);
  stored.current_review.head_sha = "a".repeat(SHA1_WIDTH);
  await fsp.writeFile(workflowPath, `${canonicalJson(stored)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    getAutonomousWorkflow(state.store, workflow.workflow_id),
    (error) => {
      assert.equal(error.code, "OBJECT_ID_WIDTH_MIXED");
      assert.match(error.message, /object-id width/);
      return true;
    },
  );
});

test("a publication ledger mixing object-id widths is refused by name", async (t) => {
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
  await reachRemoteWait(state, atPublication, reviewId, headSha, Date.now());

  const ledgerPath = publicationFilePath(state, reviewId);
  const ledger = JSON.parse(await fsp.readFile(ledgerPath, "utf8"));
  assert.equal(ledger.authorization.head_sha.length, SHA1_WIDTH);
  ledger.authorization.head_sha = "a".repeat(SHA256_WIDTH);
  await atomicWriteCanonicalJson(ledgerPath, ledger);

  await assert.rejects(getPublication(state.store, reviewId), (error) => {
    assert.equal(error.code, "OBJECT_ID_WIDTH_MIXED");
    assert.match(error.message, /object-id width/);
    return true;
  });
});

test("remote authorization on a sha256 repository is refused by name", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const headSha = await commit(state.repository, "export const value = 2;\n");

  await assert.rejects(
    authorizeRemotePublication(state.store, {
      repositoryPath: state.repository,
      baseSha: state.baseSha,
      headSha,
      acknowledgement: "LOCAL_REVIEW_SKIPPED",
      operatorLabel: "Test Operator",
      rationale: "Publishing without a local review.",
    }),
    (error) => {
      assert.equal(error.code, "REPOSITORY_OBJECT_FORMAT_UNPUBLISHABLE");
      assert.match(error.message, /GitHub does not host sha256 repositories/);
      assert.equal(error.details.object_format, "sha256");
      return true;
    },
  );
  // The refusal is the repository's, not the head's: both ids passed the
  // local guard on the way in.
  assert.equal(isLocalObjectId(state.baseSha), true);
  assert.equal(isLocalObjectId(headSha), true);
});

test("starting a publication over a sha256 local gate is refused by name", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(
    state.store,
    workflowInput(state.repository, state.baseSha),
  );
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const gated = await gateHeadLocally(state, workflow, headSha, "sha256");

  await assert.rejects(
    startPublication(
      state.store,
      startInput(state, gated.reviewId, gated.workflow, Date.now()),
    ),
    (error) => {
      assert.equal(error.code, "REPOSITORY_OBJECT_FORMAT_UNPUBLISHABLE");
      assert.match(error.message, /GitHub does not host sha256 repositories/);
      return true;
    },
  );
});

test("the observation schema keeps GitHub's own object ids at 40", async (t) => {
  const wide = "a".repeat(SHA256_WIDTH);
  const cases = [
    {
      name: "pull_request.head_sha",
      mutate: (payload) => {
        payload.pull_request.head_sha = wide;
        return payload;
      },
    },
    {
      name: "base_head_comparison.head_sha",
      mutate: (payload) => {
        payload.pull_request.base_head_comparison.head_sha = wide;
        return payload;
      },
    },
    {
      name: "BASE_BRANCH_METADATA.branch_tip_sha",
      mutate: (payload) => {
        for (const source of payload.pull_request.collection.sources) {
          if (source.kind === "BASE_BRANCH_METADATA") {
            source.branch_tip_sha = wide;
          }
        }
        return payload;
      },
    },
    {
      name: "BRANCH_METADATA.branch_tip_sha",
      mutate: (payload) => {
        for (const source of payload.required_checks.collection
          .policy_sources) {
          if (source.kind === "BRANCH_METADATA") {
            source.branch_tip_sha = wide;
          }
        }
        return payload;
      },
    },
    {
      name: "result reviewed_head_sha",
      mutate: (payload) => {
        payload.codex_review.results[0].reviewed_head_sha = wide;
        return payload;
      },
    },
    {
      name: "ancestry finding_head_sha",
      // The ancestry's own guard reads the head before the entry is matched
      // to a thread, so it refuses the width under its own name.
      expected: /ancestry finding head/,
      mutate: (payload) => {
        payload.review_threads.ancestry = [
          {
            finding_head_sha: wide,
            status: "AHEAD",
            descends: true,
            endpoint: `GET /repos/example/review-bridge/compare/${wide}...x`,
            collected_at: payload.observed_at,
          },
        ];
        return payload;
      },
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
    await assert.rejects(
      reachRemoteWait(
        state,
        atPublication,
        reviewId,
        headSha,
        Date.now(),
        scenario.mutate,
      ),
      scenario.expected ?? /must be a 40-character lowercase Git SHA/,
      scenario.name,
    );
  }
});

test("the adapter keeps a review's commit_id at 40 and widens its authorization head", () => {
  const collection = {
    status: "COMPLETE",
    collected_at: "2026-07-27T00:00:00.000Z",
    adapter_version: 1,
  };
  const expectedActor = { id: 99, type: "Bot" };
  const emptyFeeds = {
    issue_comments: [],
    pull_request_reviews: [],
    pull_request_review_comments: [],
  };

  // A sha256 authorization head is a local object id and passes the judge.
  const adapted = adaptCodexEvidence({
    collection,
    expected_actor: expectedActor,
    authorization_head_sha: "a".repeat(SHA256_WIDTH),
    ...emptyFeeds,
  });
  assert.deepEqual(adapted.results, []);

  for (const width of [39, 41, 63, 65]) {
    assert.throws(
      () =>
        adaptCodexEvidence({
          collection,
          expected_actor: expectedActor,
          authorization_head_sha: "a".repeat(width),
          ...emptyFeeds,
        }),
      /authorization_head_sha must be a full lowercase Git SHA/,
      `width ${width}`,
    );
  }

  // The commit_id beside it is GitHub's. A review whose commit_id is not a
  // 40-character SHA binds no reviewed head, which is how the adapter has
  // always read a malformed one -- widening the local judge did not widen it.
  const review = {
    id: 5,
    body: "Codex Review: findings",
    commit_id: "a".repeat(SHA256_WIDTH),
    user: { id: 99, type: "Bot" },
    html_url: "https://github.com/owner/repo/pull/7#pullrequestreview-5",
    submitted_at: "2026-07-27T00:00:02.000Z",
    state: "COMMENTED",
  };
  const withReview = adaptCodexEvidence({
    collection,
    expected_actor: expectedActor,
    authorization_head_sha: "a".repeat(SHA1_WIDTH),
    ...emptyFeeds,
    pull_request_reviews: [review],
  });
  assert.equal(withReview.results.length, 1);
  assert.equal(withReview.results[0].reviewed_head_sha, null);
  assert.equal(withReview.results[0].commit_binding, null);
});

test("the observation normalizer reads its authorization head with the local judge", () => {
  const publication = (headSha) => ({
    version: 2,
    review_id: "rb-2026-07-27T000000-000Z-00000000",
    revision: 4,
    authorization: {
      mode: "REMOTE_ONLY",
      base_sha: "a".repeat(headSha.length),
      head_sha: headSha,
    },
    target: {
      repository_id: 42,
      owner: "owner",
      repo: "repo",
      pr_number: 7,
      base_branch: "main",
      head_branch: "agent/change",
      codex_actor: { id: 99, type: "Bot", login_at_start: "codex[bot]" },
    },
  });
  const authorizationRefusal =
    /publication authorization must contain full base and head SHAs/;

  // The raw collection is deliberately empty: both widths get past the
  // authorization guard and stop at the first feed instead. Nothing here
  // fabricates a GitHub feed, which could not carry a 64-character id.
  for (const width of [SHA1_WIDTH, SHA256_WIDTH]) {
    assert.throws(
      () => normalizeGithubObservation(publication("b".repeat(width)), {}),
      /pull_request must be an object/,
      `width ${width}`,
    );
  }
  for (const width of [39, 41, 63, 65]) {
    assert.throws(
      () => normalizeGithubObservation(publication("b".repeat(width)), {}),
      authorizationRefusal,
      `width ${width}`,
    );
  }
});
