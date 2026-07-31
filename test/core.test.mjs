import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exportHumanArbitration,
  finalizeLocalGate,
  getReview,
  getReviewSummary,
  openReview,
  prepareRereview,
  prepareReview,
  readReviewArtifact,
  readSnapshotFile,
  searchSnapshot,
  submitInitialReview,
  submitRereview,
  submitResolutions,
  waitForReviewState,
} from "../src/core.mjs";
import { acquireStateLock } from "../src/storage.mjs";

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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-test-"));
  const repository = path.join(root, "repo");
  const store = path.join(root, "store");
  await fsp.mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Review Bridge Test");
  git(repository, "config", "user.email", "review-bridge@example.invalid");
  await fsp.writeFile(
    path.join(repository, "app.js"),
    "export function divide(a, b) {\n  return a / b;\n}\n",
  );
  await fsp.writeFile(path.join(repository, "README.md"), "# Fixture\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  return { root, repository, store };
}

async function readAll(readChunk) {
  let offset = 0;
  let content = "";
  while (offset != null) {
    const chunk = await readChunk(offset);
    assert.doesNotMatch(chunk.content, /\uFFFD/);
    content += chunk.content;
    offset = chunk.next_offset;
  }
  return content;
}

test("review tasks bind one reviewer provider through the local gate", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");

  await fsp.writeFile(
    path.join(repository, "app.js"),
    "export function divide(a, b) {\n  if (b === 0) return null;\n  return a / b;\n}\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "handle zero divisor");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Return null when dividing by zero.",
    implementationScope: "Guard the zero-divisor case.",
    reviewerProvider: "CODEX_TASK",
  });

  assert.equal(prepared.reviewer_provider, "CODEX_TASK");
  assert.equal(
    (await getReviewSummary(store, prepared.id)).action_required,
    "REVIEWER_INITIAL_REVIEW",
  );
  await assert.rejects(
    openReview(store, prepared.id, "CLAUDE_DESKTOP"),
    /reviewer provider mismatch/,
  );
  await assert.rejects(
    readReviewArtifact(
      store,
      prepared.id,
      1,
      "patch.diff",
      0,
      65_536,
      "CLAUDE_DESKTOP",
    ),
    /reviewer provider mismatch/,
  );
  await assert.rejects(
    readSnapshotFile(
      store,
      prepared.id,
      1,
      "app.js",
      0,
      65_536,
      "CLAUDE_DESKTOP",
    ),
    /reviewer provider mismatch/,
  );
  await assert.rejects(
    searchSnapshot(
      store,
      prepared.id,
      1,
      "divide",
      null,
      100,
      "CLAUDE_DESKTOP",
    ),
    /reviewer provider mismatch/,
  );
  assert.equal(
    (await openReview(store, prepared.id, "CODEX_TASK")).id,
    prepared.id,
  );
  await assert.rejects(
    submitInitialReview(store, prepared.id, [], "CLAUDE_DESKTOP"),
    /reviewer provider mismatch/,
  );
  await submitInitialReview(store, prepared.id, [], "CODEX_TASK");
  const finalized = await finalizeLocalGate(store, prepared.id);
  assert.equal(finalized.gate.reviewer_provider, "CODEX_TASK");
});

test("review preparation rejects unknown reviewer providers", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    prepareReview(store, {
      repositoryPath: repository,
      baseRef: git(repository, "rev-parse", "HEAD"),
      requirement: "Keep reviewer provenance explicit.",
      implementationScope: "Reject unsupported providers.",
      reviewerProvider: "OTHER",
    }),
    /reviewer_provider must be CLAUDE_DESKTOP or CODEX_TASK/,
  );
});

test("legacy review records default their reviewer provider to Claude", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: git(repository, "rev-parse", "HEAD"),
    requirement: "Preserve legacy reviewer compatibility.",
    implementationScope: "Interpret a missing provider as Claude Desktop.",
  });
  const reviewPath = path.join(
    store,
    "reviews",
    prepared.id,
    "review.json",
  );
  const review = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  delete review.reviewer_provider;
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

  assert.equal(
    (await openReview(store, prepared.id, "CLAUDE_DESKTOP"))
      .reviewer_provider,
    "CLAUDE_DESKTOP",
  );
  await assert.rejects(
    openReview(store, prepared.id, "CODEX_TASK"),
    /reviewer provider mismatch/,
  );
  await submitInitialReview(store, prepared.id, []);
  const finalized = await finalizeLocalGate(store, prepared.id);
  assert.equal(finalized.gate.reviewer_provider, "CLAUDE_DESKTOP");
});

async function createGatedParent({
  repository,
  store,
  baseSha,
  requirement = "Review the fixture.",
}) {
  await fsp.writeFile(path.join(repository, "parent.txt"), "parent\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "parent");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement,
    implementationScope: "Create the reviewed parent.",
  });
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);
  return parent;
}

test("successor review binds a clean parent gate and exposes only the exact delta", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");

  await fsp.writeFile(
    path.join(repository, "parent-only.js"),
    "export const parentValue = 1;\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "parent change");
  const parentHead = git(repository, "rev-parse", "HEAD");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Harden the fixture in reviewed increments.",
    implementationScope: "Add the parent behavior.",
  });
  await submitInitialReview(store, parent.id, []);
  const parentGate = await finalizeLocalGate(store, parent.id);

  await fsp.writeFile(
    path.join(repository, "app.js"),
    "export function divide(a, b) {\n  if (b === 0) return null;\n  return a / b;\n}\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "successor change");
  const childHead = git(repository, "rev-parse", "HEAD");
  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Harden the fixture in reviewed increments.",
    implementationScope: "Add the successor behavior.",
    parentReviewId: parent.id,
  });

  assert.equal(child.review_strategy.mode, "SUCCESSOR");
  assert.equal(child.review_strategy.parent_review_id, parent.id);
  assert.equal(child.review_strategy.fallback_reason, null);
  assert.equal(child.rounds[0].successor.parent_head_sha, parentHead);
  assert.equal(child.rounds[0].successor.current_head_sha, childHead);
  assert.equal(
    child.rounds[0].successor.parent_snapshot_hash,
    parentGate.gate.snapshot_hash,
  );
  assert.deepEqual(child.rounds[0].successor.changed_files, ["app.js"]);
  assert.equal(
    child.rounds[0].successor.parent_tree_sha,
    git(repository, "rev-parse", `${parentHead}^{tree}`),
  );
  assert.equal(
    child.rounds[0].successor.current_tree_sha,
    git(repository, "rev-parse", `${childHead}^{tree}`),
  );

  const successorPatch = await readAll((offset) =>
    readReviewArtifact(
      store,
      child.id,
      1,
      "successor.diff",
      offset,
      17,
    ),
  );
  assert.match(successorPatch, /b === 0/);
  assert.doesNotMatch(successorPatch, /parentValue/);
  const fullPatch = await readAll((offset) =>
    readReviewArtifact(store, child.id, 1, "patch.diff", offset, 17),
  );
  assert.match(fullPatch, /parentValue/);

  const successorManifest = JSON.parse(
    await readAll((offset) =>
      readReviewArtifact(
        store,
        child.id,
        1,
        "successor.json",
        offset,
        17,
      ),
    ),
  );
  assert.equal(successorManifest.parent_review_id, parent.id);
  assert.equal(
    successorManifest.parent_reviewer_provider,
    "CLAUDE_DESKTOP",
  );
  assert.equal(successorManifest.parent_gate_sha256.length, 64);
  assert.equal(successorManifest.delta_sha256.length, 64);

  const opened = await openReview(store, child.id);
  assert.deepEqual(
    opened.artifacts.map((artifact) => artifact.name),
    ["successor.diff", "successor.json", "patch.diff", "manifest.json"],
  );

  await submitInitialReview(store, child.id, [
    {
      severity: "minor",
      title: "Confirm null behavior",
      explanation: "Confirm that returning null is the intended contract.",
      path: "app.js",
      line: 2,
    },
  ]);
  await submitResolutions(store, child.id, [
    {
      finding_id: "F-001",
      disposition: "rejected",
      rationale: "Returning null is the stated successor contract.",
    },
  ]);
  const rereview = await prepareRereview(store, child.id);
  assert.equal(rereview.review_strategy.mode, "SUCCESSOR");
  assert.equal(
    rereview.rounds[1].successor.delta_sha256,
    child.rounds[0].successor.delta_sha256,
  );
  await submitRereview(
    store,
    child.id,
    [
      {
        finding_id: "F-001",
        decision: "rebuttal_accepted",
        rationale: "The requirement confirms the null contract.",
      },
    ],
    [],
  );
  const childGate = await finalizeLocalGate(store, child.id);
  assert.equal(childGate.gate.head_sha, childHead);
  assert.equal(
    childGate.gate.snapshot_hash,
    rereview.rounds[1].snapshot_hash,
  );
  const summary = await getReviewSummary(store, child.id);
  assert.deepEqual(summary.review_strategy, child.review_strategy);
});

test("ineligible successor parent falls back to an explicit full review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "app.js"), "parent pending\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "pending parent");
  const parentHead = git(repository, "rev-parse", "HEAD");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Prepare a parent that remains pending.",
  });

  await fsp.writeFile(path.join(repository, "app.js"), "child committed\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "child");
  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Fall back when the parent is not gated.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.equal(child.review_strategy.parent_review_id, parent.id);
  assert.match(child.review_strategy.fallback_reason, /LOCAL_GATE_PASSED/);
  assert.equal(child.rounds[0].successor, null);

  const opened = await openReview(store, child.id);
  assert.deepEqual(
    opened.artifacts.map((artifact) => artifact.name),
    ["patch.diff", "manifest.json"],
  );
  await assert.rejects(
    readReviewArtifact(store, child.id, 1, "successor.diff"),
    /not available for this review round/,
  );

  git(repository, "switch", "--detach", parentHead);
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);
  git(repository, "switch", "main");
  await submitInitialReview(store, child.id, [
    {
      severity: "minor",
      title: "Needs explanation",
      explanation: "Confirm the intentionally minimal fixture.",
    },
  ]);
  await submitResolutions(store, child.id, [
    {
      finding_id: "F-001",
      disposition: "rejected",
      rationale: "The minimal fixture is intentional.",
    },
  ]);
  const rereview = await prepareRereview(store, child.id);
  assert.equal(rereview.review_strategy.mode, "FULL");
  assert.equal(rereview.rounds[1].successor, null);
});

test("a tampered parent gate forces a full review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "app.js"), "reviewed parent\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "reviewed parent");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Create the parent.",
  });
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  const gatePath = path.join(store, "reviews", parent.id, "gate.json");
  const gate = JSON.parse(await fsp.readFile(gatePath, "utf8"));
  gate.head_sha = "0".repeat(40);
  await fsp.writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`);

  await fsp.writeFile(path.join(repository, "app.js"), "successor\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "successor");
  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Reject the tampered parent proof.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.match(child.review_strategy.fallback_reason, /gate does not match/);
  assert.equal(child.rounds[0].successor, null);
});

test("parent reviewer provider drift forces a full review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "app.js"), "reviewed parent\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "reviewed parent");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Create the parent.",
  });
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  const gatePath = path.join(store, "reviews", parent.id, "gate.json");
  const gate = JSON.parse(await fsp.readFile(gatePath, "utf8"));
  gate.reviewer_provider = "CODEX_TASK";
  await fsp.writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`);

  await fsp.writeFile(path.join(repository, "app.js"), "successor\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "successor");
  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Reject parent reviewer provider drift.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.match(child.review_strategy.fallback_reason, /reviewer provider/);
  assert.equal(child.rounds[0].successor, null);
});

test("a malformed parent ledger forces a full review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "app.js"), "reviewed parent\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "reviewed parent");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Create the parent.",
  });
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  const reviewPath = path.join(store, "reviews", parent.id, "review.json");
  const ledger = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  ledger.rounds = null;
  await fsp.writeFile(reviewPath, `${JSON.stringify(ledger, null, 2)}\n`);

  await fsp.writeFile(path.join(repository, "app.js"), "successor\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "successor");
  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Reject the malformed parent proof.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.match(child.review_strategy.fallback_reason, /ledger/);
});

test("tampered parent metadata cannot qualify a successor review", async (t) => {
  for (const scenario of [
    {
      name: "requirement",
      mutate({ ledger }) {
        ledger.requirement = "Tampered requirement.";
        return "Tampered requirement.";
      },
    },
    {
      name: "review id",
      mutate({ ledger, gate }) {
        const otherId = ledger.id.replace(/[a-f0-9]{8}$/, "deadbeef");
        ledger.id = otherId;
        gate.review_id = otherId;
        return ledger.requirement;
      },
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const { root, repository, store } = await fixture();
      t.after(() => fsp.rm(root, { recursive: true, force: true }));
      const baseSha = git(repository, "rev-parse", "HEAD");
      const parent = await createGatedParent({
        repository,
        store,
        baseSha,
      });
      const reviewPath = path.join(
        store,
        "reviews",
        parent.id,
        "review.json",
      );
      const gatePath = path.join(store, "reviews", parent.id, "gate.json");
      const ledger = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
      const gate = JSON.parse(await fsp.readFile(gatePath, "utf8"));
      const requirement = scenario.mutate({ ledger, gate });
      await fsp.writeFile(reviewPath, `${JSON.stringify(ledger, null, 2)}\n`);
      await fsp.writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`);

      await fsp.writeFile(path.join(repository, "child.txt"), "child\n");
      git(repository, "add", ".");
      git(repository, "commit", "-m", "child");
      const child = await prepareReview(store, {
        repositoryPath: repository,
        baseRef: baseSha,
        requirement,
        implementationScope: "Create the successor.",
        parentReviewId: parent.id,
      });
      assert.equal(child.review_strategy.mode, "FULL");
      assert.equal(child.rounds[0].successor, null);
    });
  }
});

test("tampered parent overlay metadata cannot qualify a successor review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "app.js"), "dirty parent\n");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Review the dirty parent.",
  });
  assert.equal(parent.rounds[0].overlays.length, 1);
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  const reviewPath = path.join(store, "reviews", parent.id, "review.json");
  const ledger = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  ledger.rounds[0].overlays = [];
  await fsp.writeFile(reviewPath, `${JSON.stringify(ledger, null, 2)}\n`);
  git(repository, "add", ".");
  git(repository, "commit", "-m", "commit reviewed overlay");

  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Create the successor.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.equal(child.rounds[0].successor, null);
});

test("tampered successor artifacts fail closed on read and clean submission", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  const parent = await createGatedParent({ repository, store, baseSha });
  await fsp.writeFile(path.join(repository, "child.txt"), "child\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "child");
  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Create the successor.",
    parentReviewId: parent.id,
  });
  const roundRoot = path.join(
    store,
    "reviews",
    child.id,
    "rounds",
    "1",
  );
  const deltaPath = path.join(roundRoot, "successor.diff");
  const proofPath = path.join(roundRoot, "successor.json");
  const originalDelta = await fsp.readFile(deltaPath);
  await fsp.writeFile(deltaPath, "tampered delta\n");
  await assert.rejects(
    readReviewArtifact(store, child.id, 1, "successor.diff"),
    /successor artifact integrity check failed/,
  );
  await assert.rejects(
    submitInitialReview(store, child.id, []),
    /successor artifact integrity check failed/,
  );

  await fsp.writeFile(deltaPath, originalDelta);
  const proof = JSON.parse(await fsp.readFile(proofPath, "utf8"));
  proof.changed_files = [];
  await fsp.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  await assert.rejects(
    readReviewArtifact(store, child.id, 1, "successor.json"),
    /successor artifact integrity check failed/,
  );
});

test("tampered successor artifacts prevent local gate finalization", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  const parent = await createGatedParent({ repository, store, baseSha });
  await fsp.writeFile(path.join(repository, "child.txt"), "child\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "child");
  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Create the successor.",
    parentReviewId: parent.id,
  });
  await submitInitialReview(store, child.id, []);
  await fsp.writeFile(
    path.join(
      store,
      "reviews",
      child.id,
      "rounds",
      "1",
      "successor.diff",
    ),
    "tampered delta\n",
  );
  await assert.rejects(
    finalizeLocalGate(store, child.id),
    /successor artifact integrity check failed/,
  );
});

test("linked worktrees from the same repository can use successor mode", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  const parent = await createGatedParent({ repository, store, baseSha });
  const linked = path.join(root, "linked");
  git(repository, "worktree", "add", "-b", "successor", linked);
  await fsp.writeFile(path.join(linked, "child.txt"), "child\n");
  git(linked, "add", ".");
  git(linked, "commit", "-m", "child");

  const child = await prepareReview(store, {
    repositoryPath: linked,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Create the successor in a linked worktree.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "SUCCESSOR");
});

test("dirty current worktrees fall back to full review", async (t) => {
  for (const scenario of [
    {
      name: "modified file",
      async makeDirty(repository) {
        await fsp.writeFile(path.join(repository, "app.js"), "dirty child\n");
      },
      expectedOverlays: 1,
    },
    {
      name: "deleted file",
      async makeDirty(repository) {
        await fsp.unlink(path.join(repository, "child.txt"));
      },
      expectedOverlays: 0,
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const { root, repository, store } = await fixture();
      t.after(() => fsp.rm(root, { recursive: true, force: true }));
      const baseSha = git(repository, "rev-parse", "HEAD");
      const parent = await createGatedParent({ repository, store, baseSha });
      await fsp.writeFile(path.join(repository, "child.txt"), "child\n");
      git(repository, "add", ".");
      git(repository, "commit", "-m", "child");
      await scenario.makeDirty(repository);

      const child = await prepareReview(store, {
        repositoryPath: repository,
        baseRef: baseSha,
        requirement: "Review the fixture.",
        implementationScope: "Reject a dirty successor worktree.",
        parentReviewId: parent.id,
      });
      assert.equal(child.rounds[0].worktree_clean, false);
      assert.equal(child.rounds[0].overlays.length, scenario.expectedOverlays);
      assert.equal(child.review_strategy.mode, "FULL");
      assert.match(
        child.review_strategy.fallback_reason,
        /committed clean worktrees/,
      );
    });
  }
});

test("a parent without a worktree cleanliness commitment falls back to full review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  const parent = await createGatedParent({ repository, store, baseSha });
  const reviewPath = path.join(store, "reviews", parent.id, "review.json");
  const ledger = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  delete ledger.rounds[0].worktree_clean;
  await fsp.writeFile(reviewPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await fsp.writeFile(path.join(repository, "child.txt"), "child\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "child");

  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Reject an old parent ledger.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.match(child.review_strategy.fallback_reason, /snapshot commitment/);
});

test("a tampered worktree cleanliness commitment cannot qualify a successor review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "app.js"), "dirty parent\n");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Review a dirty parent.",
  });
  assert.equal(parent.rounds[0].worktree_clean, false);
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  const reviewPath = path.join(store, "reviews", parent.id, "review.json");
  const ledger = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  ledger.rounds[0].worktree_clean = true;
  await fsp.writeFile(reviewPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await fsp.writeFile(path.join(repository, "child.txt"), "child\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "commit parent and child");

  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Reject a tampered parent commitment.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.match(child.review_strategy.fallback_reason, /snapshot commitment/);
});

test("a divergent parent head falls back to full review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  const parent = await createGatedParent({ repository, store, baseSha });
  git(repository, "switch", "-c", "divergent", baseSha);
  await fsp.writeFile(path.join(repository, "child.txt"), "child\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "divergent child");

  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Reject a divergent parent.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.match(child.review_strategy.fallback_reason, /not an ancestor/);
});

test("a parent from another repository falls back to full review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  const parent = await createGatedParent({ repository, store, baseSha });
  const otherRepository = path.join(root, "other-repo");
  await fsp.mkdir(otherRepository);
  git(otherRepository, "init", "-b", "main");
  git(otherRepository, "config", "user.name", "Review Bridge Test");
  git(
    otherRepository,
    "config",
    "user.email",
    "review-bridge@example.invalid",
  );
  await fsp.writeFile(path.join(otherRepository, "app.js"), "other\n");
  git(otherRepository, "add", ".");
  git(otherRepository, "commit", "-m", "other base");
  const otherBaseSha = git(otherRepository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(otherRepository, "child.txt"), "child\n");
  git(otherRepository, "add", ".");
  git(otherRepository, "commit", "-m", "other child");

  const child = await prepareReview(store, {
    repositoryPath: otherRepository,
    baseRef: otherBaseSha,
    requirement: "Review the fixture.",
    implementationScope: "Reject a parent from another repository.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.match(
    child.review_strategy.fallback_reason,
    /different repository/,
  );
});

test("oversized successor proof generation falls back to full review", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(
    path.join(repository, "large-parent.bin"),
    randomBytes(28 * 1024 * 1024),
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "large parent");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Create the large parent.",
  });
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  await fsp.unlink(path.join(repository, "large-parent.bin"));
  await fsp.writeFile(
    path.join(repository, "large-child.bin"),
    randomBytes(28 * 1024 * 1024),
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "large child");
  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Review the fixture.",
    implementationScope: "Fall back when the successor proof is too large.",
    parentReviewId: parent.id,
  });
  assert.equal(child.review_strategy.mode, "FULL");
  assert.match(
    child.review_strategy.fallback_reason,
    /cannot build successor artifacts/,
  );
  assert.equal(child.rounds[0].successor, null);
});

test("two-round fixed finding reaches a local gate", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  await fsp.writeFile(
    path.join(repository, "app.js"),
    "export function divide(a, b) {\n  if (b === 0) return null;\n  return a / b;\n}\n",
  );
  await fsp.writeFile(
    path.join(repository, "app.test.js"),
    "import { divide } from './app.js';\n",
  );

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Return null when division by zero is requested.",
    implementationScope: "Change app.js and add focused tests.",
  });
  assert.equal(prepared.status, "WAITING_FOR_REVIEW");
  assert.equal(prepared.rounds[0].changed_files.includes("app.test.js"), true);

  const patch = await readReviewArtifact(
    store,
    prepared.id,
    1,
    "patch.diff",
    0,
    200_000,
  );
  assert.match(patch.content, /app\.test\.js/);

  const snapshotted = await readSnapshotFile(store, prepared.id, 1, "app.js");
  assert.match(snapshotted.content, /b === 0/);
  await fsp.writeFile(path.join(repository, "app.js"), "mutated after capture\n");
  const immutable = await readSnapshotFile(store, prepared.id, 1, "app.js");
  assert.equal(immutable.content, snapshotted.content);

  const search = await searchSnapshot(store, prepared.id, 1, "b === 0");
  assert.equal(search.some((result) => result.path === "app.js"), true);

  await submitInitialReview(store, prepared.id, [
    {
      severity: "major",
      title: "Missing behavior test",
      explanation: "The test file imports the function but has no assertion.",
      recommendation: "Add an assertion for division by zero.",
      path: "app.test.js",
      line: 1,
    },
  ]);
  await submitResolutions(store, prepared.id, [
    {
      finding_id: "F-001",
      disposition: "fixed",
      rationale: "Added a focused assertion.",
      evidence: "node --test app.test.js",
    },
  ]);
  await fsp.writeFile(
    path.join(repository, "app.js"),
    "export function divide(a, b) {\n  if (b === 0) return null;\n  return a / b;\n}\n",
  );
  await fsp.writeFile(
    path.join(repository, "app.test.js"),
    "import assert from 'node:assert/strict';\nimport { divide } from './app.js';\nassert.equal(divide(1, 0), null);\n",
  );
  const rereview = await prepareRereview(store, prepared.id);
  assert.equal(rereview.status, "WAITING_FOR_REREVIEW");
  assert.equal(rereview.current_round, 2);

  const clean = await submitRereview(
    store,
    prepared.id,
    [
      {
        finding_id: "F-001",
        decision: "resolved",
        rationale: "The new assertion covers the requested behavior.",
      },
    ],
    [],
  );
  assert.equal(clean.status, "CLEAN");

  const finalized = await finalizeLocalGate(store, prepared.id);
  assert.equal(finalized.gate.status, "LOCAL_GATE_PASSED");
  assert.equal((await getReview(store, prepared.id)).status, "LOCAL_GATE_PASSED");
});

test("unresolved round-two finding escalates to a human", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 1;\n");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Expose a stable value.",
    implementationScope: "Change app.js.",
  });
  await submitInitialReview(store, prepared.id, [
    {
      severity: "major",
      title: "Public contract is unexplained",
      explanation: "The new export has no documented contract.",
    },
  ]);
  await submitResolutions(store, prepared.id, [
    {
      finding_id: "F-001",
      disposition: "rejected",
      rationale: "The repository does not document internal constants.",
    },
  ]);
  await prepareRereview(store, prepared.id);
  const result = await submitRereview(
    store,
    prepared.id,
    [
      {
        finding_id: "F-001",
        decision: "still_open",
        rationale: "This export is public, unlike the cited internal constants.",
      },
    ],
    [],
  );
  assert.equal(result.status, "HUMAN_REQUIRED");
  const reviewPath = path.join(store, "reviews", prepared.id, "review.json");
  const beforeLedger = await fsp.readFile(reviewPath, "utf8");
  const beforeRepositoryStatus = git(repository, "status", "--porcelain");
  const exported = await exportHumanArbitration(
    store,
    prepared.id,
    result.state_version,
  );
  assert.deepEqual(
    await exportHumanArbitration(store, prepared.id, result.state_version),
    exported,
  );
  assert.equal(exported.arbitration.status, "HUMAN_REQUIRED");
  assert.equal(exported.arbitration.requirement, prepared.requirement);
  assert.equal(
    exported.arbitration.implementation_scope,
    prepared.implementation_scope,
  );
  assert.equal(exported.arbitration.snapshots.length, 2);
  assert.deepEqual(
    exported.arbitration.snapshots,
    result.rounds.map((round) => ({
      round: round.round,
      base_sha: round.base_sha,
      head_sha: round.head_sha,
      snapshot_hash: round.snapshot_hash,
    })),
  );
  assert.equal(exported.arbitration.active_findings[0].finding.id, "F-001");
  assert.equal(
    exported.arbitration.active_findings[0].author_resolution.disposition,
    "rejected",
  );
  assert.equal(
    exported.arbitration.active_findings[0].rereview_decision.decision,
    "still_open",
  );
  assert.equal(
    exported.arbitration.human_required_reason.event,
    "REREVIEW_UNRESOLVED",
  );
  assert.match(exported.markdown, /^# Human Arbitration Packet$/m);
  assert.match(exported.markdown, /## Active findings \(1\)/);
  assert.equal(await fsp.readFile(reviewPath, "utf8"), beforeLedger);
  assert.equal(
    git(repository, "status", "--porcelain"),
    beforeRepositoryStatus,
  );
  await assert.rejects(
    exportHumanArbitration(
      store,
      prepared.id,
      result.state_version - 1,
    ),
    /review state_version mismatch/,
  );
});

test("human arbitration export rejects reviews that are not awaiting a human", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 1;\n");
  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Expose a stable value.",
    implementationScope: "Change app.js.",
  });

  await assert.rejects(
    exportHumanArbitration(store, prepared.id, prepared.state_version),
    /review does not require human arbitration/,
  );
  for (const invalidStateVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      exportHumanArbitration(store, prepared.id, invalidStateVersion),
      /expected_state_version must be a non-negative safe integer/,
    );
  }

  await submitInitialReview(store, prepared.id, [
    {
      severity: "major",
      title: "Needs a product decision",
      explanation: "The correct behavior is not specified.",
    },
  ]);
  const escalated = await submitResolutions(store, prepared.id, [
    {
      finding_id: "F-001",
      disposition: "human_required",
      rationale: "A human must choose the intended behavior.",
    },
  ]);
  const exported = await exportHumanArbitration(
    store,
    prepared.id,
    escalated.state_version,
  );
  assert.equal(
    exported.arbitration.human_required_reason.event,
    "AUTHOR_ESCALATED",
  );
  assert.equal(exported.arbitration.snapshots.length, 1);
  assert.equal(
    exported.arbitration.active_findings[0].rereview_decision,
    null,
  );
});

test("compact review summaries support bounded state-change waits", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 2;\n");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Update the exported value.",
    implementationScope: "Change app.js.",
  });
  assert.equal(prepared.state_version, 1);
  assert.equal(prepared.created_at, prepared.updated_at);
  const reviewPath = path.join(store, "reviews", prepared.id, "review.json");
  const ledger = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  ledger.updated_at = "2099-01-01T00:00:00.000Z";
  await fsp.writeFile(reviewPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const summary = await getReviewSummary(store, prepared.id);
  assert.equal(summary.status, "WAITING_FOR_REVIEW");
  assert.equal(summary.action_required, "REVIEWER_INITIAL_REVIEW");
  assert.deepEqual(summary.findings, {
    total: 0,
    active: 0,
    total_by_severity: {},
    active_by_severity: {},
    by_status: {},
  });
  assert.equal(summary.state_version, 1);
  assert.deepEqual(summary.active_findings, []);
  assert.equal(summary.current_snapshot.head_sha, git(repository, "rev-parse", "HEAD"));
  assert.equal(summary.current_snapshot.changed_file_count, 1);
  assert.equal("history" in summary, false);
  assert.equal("rounds" in summary, false);
  assert.equal("requirement" in summary, false);

  const waiting = waitForReviewState(
    store,
    prepared.id,
    summary.state_version,
    1_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await submitInitialReview(store, prepared.id, []);
  const changed = await waiting;
  assert.equal(changed.changed, true);
  assert.equal(changed.timed_out, false);
  assert.equal(changed.summary.status, "CLEAN");
  assert.equal(changed.summary.action_required, "FINALIZE_LOCAL_GATE");
  assert.equal(changed.summary.state_version, 2);
  assert.ok(changed.summary.updated_at < summary.updated_at);

  const timedOut = await waitForReviewState(
    store,
    prepared.id,
    changed.summary.state_version,
    10,
  );
  assert.equal(timedOut.changed, false);
  assert.equal(timedOut.timed_out, true);
  assert.equal(timedOut.summary.status, "CLEAN");
  await assert.rejects(
    waitForReviewState(store, prepared.id, changed.summary.state_version, 30_001),
    /timeout_ms must be between 1 and 30000/,
  );
  for (const invalidStateVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      waitForReviewState(store, prepared.id, invalidStateVersion, 10),
      /known_state_version must be a non-negative safe integer/,
    );
  }
});

test("core review mutations wait behind the review-state lock without changing state", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 2;\n");
  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Update the exported value.",
    implementationScope: "Change app.js.",
  });
  const reviewRoot = path.join(store, "reviews", prepared.id);
  const release = await acquireStateLock({
    directory: reviewRoot,
    reviewId: prepared.id,
    domain: "review",
  });
  let settled = false;
  const mutation = submitInitialReview(store, prepared.id, []).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false);
  const unchanged = await getReview(store, prepared.id);
  assert.equal(unchanged.status, "WAITING_FOR_REVIEW");
  assert.equal(unchanged.state_version, prepared.state_version);
  await release();
  const updated = await mutation;
  assert.equal(updated.status, "CLEAN");
  assert.equal(updated.state_version, prepared.state_version + 1);
});

test("a missing review mutation does not create an empty review directory", async (t) => {
  const { root, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const reviewId = "rb-2026-07-26T000000-000Z-deadbeef";
  await assert.rejects(
    submitInitialReview(store, reviewId, []),
    new RegExp(`review ${reviewId} not found`),
  );
  assert.equal(
    await fsp
      .access(path.join(store, "reviews", reviewId))
      .then(() => true, () => false),
    false,
  );
});

test("compact finding histograms distinguish active and all-time severity", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 3;\n");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Update the exported value.",
    implementationScope: "Change app.js.",
  });
  await submitInitialReview(store, prepared.id, [
    {
      severity: "blocker",
      title: "First finding",
      explanation: "Needs a fix.",
    },
    {
      severity: "major",
      title: "Second finding",
      explanation: "Needs evidence.",
    },
  ]);
  await submitResolutions(store, prepared.id, [
    {
      finding_id: "F-001",
      disposition: "fixed",
      rationale: "Fixed.",
    },
    {
      finding_id: "F-002",
      disposition: "rejected",
      rationale: "Not applicable.",
    },
  ]);
  await prepareRereview(store, prepared.id);
  await submitRereview(
    store,
    prepared.id,
    [
      {
        finding_id: "F-001",
        decision: "resolved",
        rationale: "Verified.",
      },
      {
        finding_id: "F-002",
        decision: "rebuttal_accepted",
        rationale: "Evidence accepted.",
      },
    ],
    [
      {
        severity: "nit",
        title: "New finding",
        explanation: "One small issue remains.",
      },
    ],
  );

  const summary = await getReviewSummary(store, prepared.id);
  assert.deepEqual(summary.findings, {
    total: 3,
    active: 1,
    total_by_severity: { blocker: 1, major: 1, nit: 1 },
    active_by_severity: { nit: 1 },
    by_status: { OPEN: 1, REBUTTAL_ACCEPTED: 1, RESOLVED: 1 },
  });
  assert.deepEqual(
    summary.active_findings.map((finding) => finding.id),
    ["F-003"],
  );
  const exported = await exportHumanArbitration(
    store,
    prepared.id,
    summary.state_version,
  );
  assert.deepEqual(
    exported.arbitration.active_findings.map(({ finding }) => finding.id),
    ["F-003"],
  );
  assert.deepEqual(
    exported.arbitration.resolved_findings.map(({ finding }) => finding.id),
    ["F-001", "F-002"],
  );
  assert.ok(
    exported.markdown.indexOf('"id": "F-003"') <
      exported.markdown.indexOf("## Resolved findings"),
  );
  assert.ok(
    exported.markdown.indexOf('"id": "F-001"') >
      exported.markdown.indexOf("## Resolved findings"),
  );
});

test("finalization fails closed when code changes after a clean verdict", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(repository, "app.js"), "export const safe = true;\n");
  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Expose the safe flag.",
    implementationScope: "Change app.js.",
  });
  await submitInitialReview(store, prepared.id, []);
  await fsp.writeFile(path.join(repository, "app.js"), "export const safe = false;\n");
  await assert.rejects(
    finalizeLocalGate(store, prepared.id),
    /working tree changed after the clean verdict/,
  );
});

test("committed deletions are represented as deleted snapshot files", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const base = git(repository, "rev-parse", "HEAD");
  await fsp.rm(path.join(repository, "README.md"));
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "delete readme");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: base,
    requirement: "Remove the obsolete README.",
    implementationScope: "Delete README.md.",
  });

  assert.deepEqual(prepared.rounds[0].deleted_files, ["README.md"]);
  assert.deepEqual(
    await readSnapshotFile(store, prepared.id, 1, "README.md"),
    { path: "README.md", round: 1, deleted: true },
  );
});

test("chunked artifact and snapshot reads preserve UTF-8 characters", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(repository, "app.js"), "export const message = '你好';\n");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Expose a localized message.",
    implementationScope: "Update app.js with a Chinese message.",
  });
  const patch = await readAll((offset) =>
    readReviewArtifact(store, prepared.id, 1, "patch.diff", offset, 4),
  );
  const snapshot = await readAll((offset) =>
    readSnapshotFile(store, prepared.id, 1, "app.js", offset, 4),
  );

  assert.match(patch, /你好/);
  assert.equal(snapshot, "export const message = '你好';\n");
});

test("snapshot paths preserve literal backslashes", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fileName = "back\\slash.txt";
  await fsp.writeFile(path.join(repository, fileName), "literal backslash\n");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Add a file whose name contains a backslash.",
    implementationScope: `Add ${fileName}.`,
  });

  assert.equal(prepared.rounds[0].changed_files.includes(fileName), true);
  const snapshot = await readSnapshotFile(store, prepared.id, 1, fileName);
  assert.equal(snapshot.content, "literal backslash\n");
});

test("snapshot search preserves paths containing colon-number segments", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const base = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "guide:123"), "search needle\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "add colon path");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: base,
    requirement: "Add the numbered guide.",
    implementationScope: "Add guide:123.",
  });
  const results = await searchSnapshot(store, prepared.id, 1, "search needle");

  assert.deepEqual(results, [
    { path: "guide:123", line: 1, text: "search needle" },
  ]);
});

test("snapshot search reports modified files that are too large to inspect", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const largePath = path.join(repository, "large.bin");
  const content = Buffer.alloc(10 * 1024 * 1024 + 1);
  await fsp.writeFile(largePath, content);
  git(repository, "add", "large.bin");
  git(repository, "commit", "-m", "add large file");
  content[0] = 1;
  await fsp.writeFile(largePath, content);

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Update the large binary.",
    implementationScope: "Modify large.bin.",
  });
  const results = await searchSnapshot(store, prepared.id, 1, "needle");

  assert.deepEqual(results, [
    {
      path: "large.bin",
      skipped: true,
      reason: "modified snapshot file exceeds 10485760 bytes and is not searchable",
    },
  ]);
});

test("build refuses to package a dirty working tree", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-build-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, "scripts"));
  await fsp.copyFile(
    path.resolve("scripts/build.mjs"),
    path.join(root, "scripts", "build.mjs"),
  );
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Review Bridge Test");
  git(root, "config", "user.email", "review-bridge@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  await fsp.writeFile(path.join(root, "dirty.txt"), "not committed\n");

  const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to build from a dirty working tree/);
});

test("the patch index addresses each file's exact section without reading the whole patch", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");

  await fsp.writeFile(
    path.join(repository, "app.js"),
    "export function divide(a, b) {\n  if (b === 0) return null;\n  return a / b;\n}\n",
  );
  // A document whose own content mimics a diff header must not split the index.
  await fsp.writeFile(
    path.join(repository, "NOTES.md"),
    `# Notes\n\ndiff --git a/decoy.js b/decoy.js\nstill the same section\n${"filler line\n".repeat(400)}`,
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "change");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Guard the zero divisor.",
    implementationScope: "Edit app.js and add notes.",
  });
  const opened = await openReview(store, prepared.id);
  const index = opened.current_snapshot.patch_index;

  assert.deepEqual(
    index.map((entry) => entry.path),
    ["NOTES.md", "app.js"],
  );
  assert.equal(opened.current_snapshot.patch_index_truncated, false);
  assert.equal(
    index.reduce((total, entry) => total + entry.bytes, 0),
    opened.current_snapshot.patch_bytes,
  );

  const appEntry = index.find((entry) => entry.path === "app.js");
  const section = await readReviewArtifact(
    store,
    prepared.id,
    1,
    "patch.diff",
    appEntry.offset,
    appEntry.bytes,
  );
  assert.match(section.content, /^diff --git a\/app\.js b\/app\.js\n/);
  assert.match(section.content, /if \(b === 0\) return null;/);
  assert.doesNotMatch(section.content, /filler line/);
  assert.ok(appEntry.bytes < opened.current_snapshot.patch_bytes / 2);
});

test("open_review states each round once and keeps the current snapshot whole", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");

  await fsp.writeFile(path.join(repository, "app.js"), "export const a = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "change");
  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Simplify the module.",
    implementationScope: "Replace divide with a constant.",
  });
  await submitInitialReview(store, prepared.id, [
    {
      severity: "minor",
      title: "Explain the constant",
      explanation: "State why the constant replaces the function.",
    },
  ]);
  await fsp.writeFile(
    path.join(repository, "app.js"),
    "// The module exposes one constant.\nexport const a = 1;\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "explain the constant");
  await submitResolutions(store, prepared.id, [
    {
      finding_id: "F-001",
      disposition: "fixed",
      rationale: "Documented why the constant replaces the function.",
      evidence: "app.js now states the contract.",
    },
  ]);
  await prepareRereview(store, prepared.id);

  const opened = await openReview(store, prepared.id);

  assert.deepEqual(
    opened.rounds.map((round) => round.round),
    [1, 2],
  );
  assert.equal(opened.rounds[0].changed_files, undefined);
  assert.equal(opened.rounds[0].changed_file_count, 1);
  assert.equal(opened.current_snapshot.round, 2);
  assert.deepEqual(opened.current_snapshot.changed_files, ["app.js"]);
  // Round two must not carry a second full copy of itself.
  const serialized = JSON.stringify(opened);
  assert.equal(
    serialized.split(`"snapshot_hash":"${opened.current_snapshot.snapshot_hash}"`)
      .length - 1,
    2,
  );
  assert.deepEqual(opened.findings.length, 1);
});

test("an unattended review selects a verified successor parent and can be forced full", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  const requirement = "Harden the fixture in reviewed increments.";

  await fsp.writeFile(path.join(repository, "parent-only.js"), "export const p = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "parent change");
  const parentHead = git(repository, "rev-parse", "HEAD");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement,
    implementationScope: "Add the parent behavior.",
  });
  assert.equal(parent.review_strategy.mode, "FULL");
  assert.equal(parent.review_strategy.parent_selection, "NONE");
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  await fsp.writeFile(path.join(repository, "child-only.js"), "export const c = 2;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "child change");

  const child = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement,
    implementationScope: "Add the child behavior.",
  });

  assert.equal(child.review_strategy.mode, "SUCCESSOR");
  assert.equal(child.review_strategy.parent_selection, "AUTOMATIC");
  assert.equal(child.review_strategy.parent_review_id, parent.id);
  assert.equal(child.rounds[0].successor.parent_head_sha, parentHead);
  assert.deepEqual(child.rounds[0].successor.changed_files, ["child-only.js"]);
  assert.ok(child.rounds[0].successor.delta_bytes < child.rounds[0].patch_bytes);

  const forced = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement,
    implementationScope: "Add the child behavior.",
    forceFullReview: true,
  });
  assert.equal(forced.review_strategy.mode, "FULL");
  assert.equal(forced.review_strategy.parent_selection, "NONE");
  assert.equal(forced.review_strategy.parent_review_id, null);
  assert.match(forced.review_strategy.fallback_reason, /requested by the author/);
});

test("a drifting requirement blocks an explicit parent but is disclosed in an automatic one", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");

  await fsp.writeFile(path.join(repository, "one.js"), "export const one = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "one");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Implement PR1: the ledger and its owners.",
    implementationScope: "Add one.",
  });
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  await fsp.writeFile(path.join(repository, "two.js"), "export const two = 2;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "two");
  // The same work, described differently on the next round, as authors do.
  const driftedRequirement = "Implement PR1: the ledger, its owners, and the digest.";

  const explicit = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: driftedRequirement,
    implementationScope: "Add two.",
    parentReviewId: parent.id,
  });
  assert.equal(explicit.review_strategy.mode, "FULL");
  assert.equal(explicit.review_strategy.parent_selection, "EXPLICIT");
  assert.match(
    explicit.review_strategy.fallback_reason,
    /same requirement/,
  );

  const automatic = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: driftedRequirement,
    implementationScope: "Add two.",
  });
  assert.equal(automatic.review_strategy.mode, "SUCCESSOR");
  assert.equal(automatic.review_strategy.parent_selection, "AUTOMATIC");
  assert.equal(automatic.rounds[0].successor.requirement_match, false);
  assert.equal(
    automatic.rounds[0].successor.parent_requirement,
    "Implement PR1: the ledger and its owners.",
  );
  assert.deepEqual(automatic.rounds[0].successor.changed_files, ["two.js"]);

  // Round two keeps the disclosed successor instead of silently going full.
  await submitInitialReview(store, automatic.id, [
    {
      severity: "minor",
      title: "Name the constant",
      explanation: "The exported name should state its unit.",
    },
  ]);
  await fsp.writeFile(path.join(repository, "two.js"), "export const twoUnits = 2;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "rename");
  await submitResolutions(store, automatic.id, [
    {
      finding_id: "F-001",
      disposition: "fixed",
      rationale: "Renamed to state the unit.",
      evidence: "two.js exports twoUnits.",
    },
  ]);
  const round2 = await prepareRereview(store, automatic.id);
  assert.equal(round2.review_strategy.mode, "SUCCESSOR");
  assert.equal(round2.review_strategy.parent_selection, "AUTOMATIC");
  assert.equal(round2.rounds[1].successor.requirement_match, false);
});

test("automatic parent selection ignores unrelated and ungated history", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");

  await fsp.writeFile(path.join(repository, "one.js"), "export const one = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "one");
  const gated = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "One requirement.",
    implementationScope: "Add one.",
  });
  await submitInitialReview(store, gated.id, []);
  await finalizeLocalGate(store, gated.id);

  await fsp.writeFile(path.join(repository, "two.js"), "export const two = 2;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "two");

  // A different base is a different reviewed range, so no parent applies.
  const otherBase = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "later.js"), "export const later = 9;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "later");
  const rebased = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: otherBase,
    requirement: "One requirement.",
    implementationScope: "Add later.",
  });
  assert.equal(rebased.review_strategy.mode, "FULL");
  assert.equal(rebased.review_strategy.parent_selection, "NONE");
  assert.equal(rebased.review_strategy.parent_review_id, null);

  // An ungated task with the matching requirement is not a parent either.
  const ungated = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Never gated.",
    implementationScope: "Add two.",
  });
  await fsp.writeFile(path.join(repository, "three.js"), "export const three = 3;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "three");
  const afterUngated = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Never gated.",
    implementationScope: "Add three.",
  });
  // The ungated task is never a parent, so selection reaches past it to the
  // gated one rather than treating the nearest task as reviewed.
  assert.equal(afterUngated.review_strategy.parent_review_id, gated.id);
  assert.notEqual(afterUngated.review_strategy.parent_review_id, ungated.id);
});

test("a truncated patch index still spans the whole patch", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");

  for (let index = 0; index < 405; index += 1) {
    await fsp.writeFile(
      path.join(repository, `f${String(index).padStart(3, "0")}.js`),
      `export const v${index} = ${index};\n`,
    );
  }
  git(repository, "add", ".");
  git(repository, "commit", "-m", "many files");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Add many modules.",
    implementationScope: "Add 405 generated modules.",
  });
  const opened = await openReview(store, prepared.id);
  const index = opened.current_snapshot.patch_index;

  assert.equal(opened.current_snapshot.patch_index_truncated, true);
  assert.equal(index.length, 401);
  const tail = index.at(-1);
  assert.equal(tail.path, null);
  assert.ok(tail.bytes > 0);
  // Coverage is exact: itemized sections plus the remainder equal the patch.
  assert.equal(
    index.reduce((total, entry) => total + entry.bytes, 0),
    opened.current_snapshot.patch_bytes,
  );
  assert.equal(tail.offset + tail.bytes, opened.current_snapshot.patch_bytes);

  // The remainder entry is readable like any itemized section and starts at
  // a section boundary.
  const remainder = await readReviewArtifact(
    store,
    prepared.id,
    1,
    "patch.diff",
    tail.offset,
    200,
  );
  assert.match(remainder.content, /^diff --git /);
});

test("the patch index decodes quoted Git paths", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");

  await fsp.writeFile(path.join(repository, "文档.js"), "export const doc = 1;\n");
  await fsp.writeFile(
    path.join(repository, 'say "hi".js'),
    "export const greeting = 1;\n",
  );
  await fsp.writeFile(
    path.join(repository, "with space.js"),
    "export const spaced = 1;\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "quoted names");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Add awkward filenames.",
    implementationScope: "Add files whose names Git quotes.",
  });
  const opened = await openReview(store, prepared.id);
  const index = opened.current_snapshot.patch_index;

  assert.deepEqual(
    index.map((entry) => entry.path).sort(),
    ['say "hi".js', "with space.js", "文档.js"],
  );
  assert.equal(
    index.reduce((total, entry) => total + entry.bytes, 0),
    opened.current_snapshot.patch_bytes,
  );

  const quoted = index.find((entry) => entry.path === "文档.js");
  const section = await readReviewArtifact(
    store,
    prepared.id,
    1,
    "patch.diff",
    quoted.offset,
    quoted.bytes,
  );
  assert.match(section.content, /export const doc = 1;/);
  assert.doesNotMatch(section.content, /greeting|spaced/);
});

test("automatic parent selection reaches across linked worktrees", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  const requirement = "Harden the fixture in reviewed increments.";

  await fsp.writeFile(path.join(repository, "parent-only.js"), "export const p = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "parent change");
  const parent = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement,
    implementationScope: "Add the parent behavior.",
  });
  await submitInitialReview(store, parent.id, []);
  await finalizeLocalGate(store, parent.id);

  // Continue the same history from a linked worktree of the same repository.
  const worktree = path.join(root, "linked-worktree");
  git(repository, "worktree", "add", "--detach", worktree, "HEAD");
  await fsp.writeFile(path.join(worktree, "child-only.js"), "export const c = 2;\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "child change");

  const child = await prepareReview(store, {
    repositoryPath: worktree,
    baseRef: baseSha,
    requirement,
    implementationScope: "Add the child behavior.",
  });

  assert.equal(child.review_strategy.mode, "SUCCESSOR");
  assert.equal(child.review_strategy.parent_selection, "AUTOMATIC");
  assert.equal(child.review_strategy.parent_review_id, parent.id);
  assert.deepEqual(child.rounds[0].successor.changed_files, ["child-only.js"]);
});
