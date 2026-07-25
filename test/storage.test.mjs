import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireStateLock,
  atomicWriteCanonicalJson,
  canonicalJson,
  readSecureJson,
  StoreError,
  withStateLock,
} from "../src/storage.mjs";

test("canonical publication JSON is stable across key ordering", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
    canonicalJson({ a: { x: 3, y: 2 }, z: 1 }),
  );
  assert.throws(
    () => canonicalJson({ invalid: "\ud800" }),
    /lone Unicode surrogates/,
  );
});

test("durable private JSON rejects mode drift without changing it", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-store-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
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

test("state locks serialize one review and keep lock domains independent", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-lock-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
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
      waitMs: 20,
    },
    async () => {},
  );
  await releaseReview();
  assert.equal(
    await fsp
      .access(path.join(root, ".review-state.lock"))
      .then(() => true, () => false),
    false,
  );
});

test("a stale lock is reclaimed only after its exact process identity is dead", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-lock-stale-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".review-state.lock");
  await fsp.writeFile(
    lockPath,
    `${canonicalJson({
      version: 1,
      owner_token: "1".repeat(32),
      pid: 999_999_999,
      process_start_time: "dead process",
      acquired_at: "2000-01-01T00:00:00.000Z",
      heartbeat_at: "2000-01-01T00:00:00.000Z",
      domain: "review",
      review_id: "rb-test",
    })}\n`,
    { mode: 0o600 },
  );
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    waitMs: 100,
    staleMs: 1,
  });
  const current = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  assert.notEqual(current.owner_token, "1".repeat(32));
  await release();
});

test("lock release never removes a path whose owner token changed", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-lock-token-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".review-state.lock");
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const replacement = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  replacement.owner_token = "f".repeat(32);
  await fsp.writeFile(lockPath, `${canonicalJson(replacement)}\n`, {
    mode: 0o600,
  });
  await release();
  assert.equal(
    JSON.parse(await fsp.readFile(lockPath, "utf8")).owner_token,
    "f".repeat(32),
  );
});
