import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  getReview,
  prepareRereview,
  prepareReview,
  readReviewArtifact,
  readSnapshotFile,
  searchSnapshot,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";

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
