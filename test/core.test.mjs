import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  getReview,
  getReviewSummary,
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
  assert.equal(summary.action_required, "CLAUDE_INITIAL_REVIEW");
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
    summary.status,
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

test("state waits observe an older reviewer that does not increment state_version", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 2;\n");
  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: "HEAD",
    requirement: "Update the exported value.",
    implementationScope: "Change app.js.",
  });
  const reviewPath = path.join(store, "reviews", prepared.id, "review.json");
  const ledger = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  ledger.status = "REVIEW_SUBMITTED";
  await fsp.writeFile(reviewPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: 0o600,
  });

  const result = await waitForReviewState(
    store,
    prepared.id,
    prepared.state_version,
    100,
    "WAITING_FOR_REVIEW",
  );
  assert.equal(result.changed, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.summary.status, "REVIEW_SUBMITTED");
  assert.equal(result.summary.state_version, prepared.state_version);
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
