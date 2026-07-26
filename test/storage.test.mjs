import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireStateLock,
  atomicWriteCanonicalJson,
  canonicalJson,
  readSecureFile,
  readSecureJson,
  StoreError,
  withStateLock,
} from "../src/storage.mjs";

const PROCESS_START_FORMAT = "darwin-ps-lstart-c-utc-v1";

async function temporaryDirectory(t, prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function exists(filePath) {
  return fsp.access(filePath).then(() => true, () => false);
}

test("canonical publication JSON is stable and rejects lossy values", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
    canonicalJson({ a: { x: 3, y: 2 }, z: 1 }),
  );
  assert.throws(
    () => canonicalJson({ invalid: "\ud800" }),
    /lone Unicode surrogates/,
  );
  assert.throws(
    () => canonicalJson({ invalid: new Date() }),
    /only supports plain objects/,
  );
  assert.throws(
    () => canonicalJson({ invalid: undefined }),
    /undefined at key "invalid"/,
  );
  assert.throws(
    () => canonicalJson(new Array(1)),
    /sparse array at index 0/,
  );
});

test("durable private JSON rejects mode drift without changing it", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-store-");
  const file = path.join(root, "publication.json");
  await atomicWriteCanonicalJson(file, { version: 1 });
  assert.deepEqual(await readSecureJson(file, { maxBytes: 1024 }), { version: 1 });

  await fsp.chmod(file, 0o644);
  await assert.rejects(
    readSecureJson(file, { maxBytes: 1024 }),
    (error) =>
      error instanceof StoreError &&
      error.code === "STORE_MODE_MISMATCH" &&
      error.details.actual_mode === "0644",
  );
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o644);
});

test("secure reads close descriptors and reject a symlink final component", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-secure-read-");
  const file = path.join(root, "value.json");
  const link = path.join(root, "link.json");
  await atomicWriteCanonicalJson(file, { version: 1 });
  const opened = await readSecureFile(file, { maxBytes: 1024 });
  assert.match(opened.bytes.toString("utf8"), /"version":1/);
  await fsp.symlink(file, link);
  await assert.rejects(
    readSecureFile(link, { maxBytes: 1024 }),
    (error) => error?.code === "ELOOP",
  );
});

test("state locks serialize one review and keep lock domains independent", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-");
  const releaseReview = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 20,
    }),
    (error) => error instanceof StoreError && error.code === "REVIEW_BUSY",
  );
  await withStateLock(
    {
      directory: root,
      reviewId: "rb-test",
      domain: "publication",
      waitMs: 500,
    },
    async () => {},
  );
  await releaseReview();
  assert.equal(await exists(path.join(root, ".review-state.lock")), false);

  const releaseAgain = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    waitMs: 500,
  });
  await releaseAgain();
});

test("a stale heartbeat never steals a matching live process identity", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-live-");
  const lockPath = path.join(root, ".review-state.lock");
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const live = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  live.heartbeat_at = "2000-01-01T00:00:00.000Z";
  await atomicWriteCanonicalJson(lockPath, live);

  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 20,
      staleMs: 1,
    }),
    (error) => error instanceof StoreError && error.code === "REVIEW_BUSY",
  );
  await release();
});

test("a reused PID identity and a dead PID are reclaimable", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-stale-");
  const lockPath = path.join(root, ".review-state.lock");
  const firstRelease = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const reused = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  reused.process_start_time = "Mon Jan  1 00:00:00 2001";
  reused.heartbeat_at = "2000-01-01T00:00:00.000Z";
  await atomicWriteCanonicalJson(lockPath, reused);
  const replacementRelease = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    waitMs: 200,
    staleMs: 1,
  });
  await firstRelease();
  await replacementRelease();

  await atomicWriteCanonicalJson(lockPath, {
    version: 1,
    owner_token: "1".repeat(32),
    pid: 999_999_999,
    process_start_time: "Mon Jan  1 00:00:00 2001",
    process_start_time_format: PROCESS_START_FORMAT,
    acquired_at: "2000-01-01T00:00:00.000Z",
    heartbeat_at: "2000-01-01T00:00:00.000Z",
    domain: "review",
    review_id: "rb-test",
  });
  const deadRelease = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    waitMs: 200,
    staleMs: 1,
  });
  await deadRelease();
});

test("concurrent stale reclaim admits exactly one owner", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-race-");
  const lockPath = path.join(root, ".review-state.lock");
  await atomicWriteCanonicalJson(lockPath, {
    version: 1,
    owner_token: "1".repeat(32),
    pid: 999_999_999,
    process_start_time: "Mon Jan  1 00:00:00 2001",
    process_start_time_format: PROCESS_START_FORMAT,
    acquired_at: "2000-01-01T00:00:00.000Z",
    heartbeat_at: "2000-01-01T00:00:00.000Z",
    domain: "review",
    review_id: "rb-test",
  });
  const contenders = await Promise.allSettled([
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 250,
      staleMs: 1,
    }),
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 250,
      staleMs: 1,
    }),
  ]);
  const winners = contenders.filter((result) => result.status === "fulfilled");
  const losers = contenders.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, "REVIEW_BUSY");
  await winners[0].value();
});

test("a malformed lock fails immediately with an actionable error", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-invalid-");
  const lockPath = path.join(root, ".review-state.lock");
  await fsp.writeFile(lockPath, "", { mode: 0o600 });
  const started = Date.now();
  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 1_000,
      staleMs: 1,
    }),
    (error) =>
      error instanceof StoreError &&
      error.code === "LOCK_RECORD_INVALID" &&
      error.details.path === lockPath &&
      error.details.retryable === false,
  );
  assert.ok(Date.now() - started < 900);
});

test("withStateLock releases after an operation throws", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-throw-");
  const sentinel = new Error("sentinel");
  await assert.rejects(
    withStateLock(
      {
        directory: root,
        reviewId: "rb-test",
        domain: "review",
      },
      async () => {
        throw sentinel;
      },
    ),
    (error) => error === sentinel,
  );
  assert.equal(await exists(path.join(root, ".review-state.lock")), false);
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    waitMs: 500,
  });
  await release();
});

test("a transient heartbeat failure does not poison release", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-heartbeat-");
  const lockPath = path.join(root, ".review-state.lock");
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    heartbeatMs: 20,
  });
  await fsp.chmod(lockPath, 0o644);
  await new Promise((resolve) => setTimeout(resolve, 35));
  await fsp.chmod(lockPath, 0o600);
  await new Promise((resolve) => setTimeout(resolve, 35));
  await release();
  assert.equal(await exists(lockPath), false);
});

test("lock release never removes a replacement owner inode", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-token-");
  const lockPath = path.join(root, ".review-state.lock");
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const replacement = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  replacement.owner_token = "f".repeat(32);
  await fsp.unlink(lockPath);
  await atomicWriteCanonicalJson(lockPath, replacement);
  await release();
  assert.equal(
    JSON.parse(await fsp.readFile(lockPath, "utf8")).owner_token,
    "f".repeat(32),
  );
});
