import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireStateLock,
  atomicWriteFile,
  StoreError,
  withStateLock,
} from "../src/storage.mjs";

const PROCESS_START_FORMAT = "darwin-ps-lstart-c-utc-v1";
const STORAGE_MODULE_URL = new URL("../src/storage.mjs", import.meta.url).href;
const STORAGE_MODULE_PATH = fileURLToPath(STORAGE_MODULE_URL);

async function temporaryDirectory(t, prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function exists(filePath) {
  return fsp.access(filePath).then(() => true, () => false);
}

async function writeLockRecord(filePath, record) {
  await atomicWriteFile(filePath, `${JSON.stringify(record)}\n`);
}

async function captureWarnings(operation) {
  const originalEmitWarning = process.emitWarning;
  const warnings = [];
  process.emitWarning = (warning, options) => {
    warnings.push({ warning: String(warning), options });
  };
  try {
    await operation();
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  return warnings;
}

async function writeDirectorySyncFailureHook(hookPath) {
  await fsp.writeFile(
    hookPath,
    [
      '"use strict";',
      'const fs = require("node:fs");',
      'const fsp = require("node:fs/promises");',
      "const originalOpen = fsp.open;",
      "fsp.open = async function (filePath, flags, ...rest) {",
      "  if (",
      "    filePath === process.env.REVIEW_BRIDGE_TEST_SYNC_DIRECTORY &&",
      "    flags === fs.constants.O_RDONLY",
      "  ) {",
      "    try {",
      "      const marker = fs.openSync(",
      '        process.env.REVIEW_BRIDGE_TEST_SYNC_MARKER, "wx", 0o600',
      "      );",
      "      fs.closeSync(marker);",
      "    } catch (error) {",
      '      if (error.code !== "EEXIST") throw error;',
      "      return originalOpen.call(this, filePath, flags, ...rest);",
      "    }",
      '    const error = new Error("injected post-rename directory sync failure");',
      '    error.code = "EIO";',
      "    throw error;",
      "  }",
      "  return originalOpen.call(this, filePath, flags, ...rest);",
      "};",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function waitForProcessExit(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      assert.fail(`process ${pid} did not exit within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function stateLockProcesses(coordinatorPath) {
  const processes = spawnSync(
    "/bin/ps",
    ["-ww", "-axo", "pid=,ppid=,command="],
    {
      encoding: "utf8",
    },
  );
  assert.equal(processes.status, 0, processes.stderr);
  const rows = processes.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      command: match[3],
    }));
  const lockfRows = rows.filter(
    (row) =>
      row.command.startsWith("/usr/bin/lockf ") &&
      row.command.includes(` ${coordinatorPath} `),
  );
  assert.equal(lockfRows.length, 1);
  const marker = `${STORAGE_MODULE_PATH} --state-lock-helper`;
  const helperRows = rows.filter(
    (row) =>
      row.parentPid === lockfRows[0].pid &&
      row.command.startsWith(`${process.execPath} `) &&
      row.command.includes(marker),
  );
  assert.equal(helperRows.length, 1);
  return {
    helperPid: helperRows[0].pid,
    lockfPid: lockfRows[0].pid,
  };
}

test("atomic writes are durable private replacements", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-store-");
  const file = path.join(root, "review.json");
  await atomicWriteFile(file, '{"version":1}\n');
  assert.equal(await fsp.readFile(file, "utf8"), '{"version":1}\n');
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
});

test("post-rename sync failures report an indeterminate write", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-store-sync-failure-");
  const file = path.join(root, "review.json");
  const hookPath = path.join(root, "fail-directory-sync.cjs");
  const markerPath = path.join(root, "directory-sync-failed");
  await writeDirectorySyncFailureHook(hookPath);

  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "const { atomicWriteFile } = await import(",
        "  process.env.REVIEW_BRIDGE_TEST_STORAGE_MODULE",
        ");",
        "try {",
        "  await atomicWriteFile(",
        "    process.env.REVIEW_BRIDGE_TEST_WRITE_PATH,",
        '    "{\\"version\\":2}\\n",',
        "  );",
        "} catch (error) {",
        "  console.log(JSON.stringify({",
        "    code: error.code,",
        "    message: error.message,",
        "    details: error.details,",
        "  }));",
        "  process.exit(17);",
        "}",
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${hookPath}`]
          .filter(Boolean)
          .join(" "),
        REVIEW_BRIDGE_TEST_STORAGE_MODULE: STORAGE_MODULE_URL,
        REVIEW_BRIDGE_TEST_SYNC_DIRECTORY: root,
        REVIEW_BRIDGE_TEST_SYNC_MARKER: markerPath,
        REVIEW_BRIDGE_TEST_WRITE_PATH: file,
      },
    },
  );
  assert.equal(child.status, 17, child.stderr);
  const payload = JSON.parse(child.stdout.trim());
  assert.equal(payload.code, "STORE_WRITE_INDETERMINATE");
  assert.match(payload.message, /reread state before retrying/i);
  assert.deepEqual(payload.details, {
    retryable: false,
    path: file,
    cause_code: "EIO",
    state_may_have_changed: true,
  });
  assert.equal(await fsp.readFile(file, "utf8"), '{"version":2}\n');
});

test("lock record reads reject mode drift without changing it", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-mode-");
  const lockPath = path.join(root, ".review-state.lock");
  await writeLockRecord(lockPath, {
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
  await fsp.chmod(lockPath, 0o644);
  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
    }),
    (error) =>
      error instanceof StoreError &&
      error.code === "STORE_MODE_MISMATCH" &&
      error.details.actual_mode === "0644",
  );
  assert.equal((await fsp.stat(lockPath)).mode & 0o777, 0o644);
});

test("state locks serialize one review and keep lock domains independent", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-");
  const releaseReview = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const reviewGuard = path.join(root, ".review-state.lock.guard");
  const guardInode = (await fsp.stat(reviewGuard)).ino;
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
  assert.equal((await fsp.stat(reviewGuard)).ino, guardInode);
  assert.equal((await fsp.stat(reviewGuard)).mode & 0o777, 0o600);

  const releaseAgain = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    waitMs: 500,
  });
  await releaseAgain();
});

test("a contended lock timestamps its actual acquisition", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-timestamp-");
  const lockPath = path.join(root, ".review-state.lock");
  const releaseFirst = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const second = acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    waitMs: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const firstReleaseStarted = Date.now();
  await releaseFirst();
  const releaseSecond = await second;
  const record = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  assert.ok(Date.parse(record.acquired_at) >= firstReleaseStarted);
  assert.equal(record.heartbeat_at, record.acquired_at);
  await releaseSecond();
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
  await release();
  live.heartbeat_at = "2000-01-01T00:00:00.000Z";
  await writeLockRecord(lockPath, live);

  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 500,
      staleMs: 1_000,
      heartbeatMs: 100,
    }),
    (error) => error instanceof StoreError && error.code === "REVIEW_BUSY",
  );
  await fsp.unlink(lockPath);
});

test("an inconclusive owner probe fails closed without changing the record", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-owner-unknown-");
  const lockPath = path.join(root, ".review-state.lock");
  const hookPath = path.join(root, "fail-owner-probe.cjs");
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const stale = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  await release();
  stale.heartbeat_at = "2000-01-01T00:00:00.000Z";
  await writeLockRecord(lockPath, stale);
  await fsp.writeFile(
    hookPath,
    [
      '"use strict";',
      'const childProcess = require("node:child_process");',
      'const { syncBuiltinESMExports } = require("node:module");',
      "const originalSpawnSync = childProcess.spawnSync;",
      "childProcess.spawnSync = function (file, args, ...rest) {",
      "  if (",
      '    file === "/bin/ps" &&',
      "    args.includes(process.env.REVIEW_BRIDGE_TEST_UNKNOWN_PID)",
      "  ) {",
      "    return { status: 1, stdout: '', stderr: 'injected probe failure' };",
      "  }",
      "  return originalSpawnSync.call(this, file, args, ...rest);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const previousNodeOptions = process.env.NODE_OPTIONS;
  const previousUnknownPid =
    process.env.REVIEW_BRIDGE_TEST_UNKNOWN_PID;
  process.env.NODE_OPTIONS = [previousNodeOptions, `--require=${hookPath}`]
    .filter(Boolean)
    .join(" ");
  process.env.REVIEW_BRIDGE_TEST_UNKNOWN_PID = String(stale.pid);
  try {
    await assert.rejects(
      acquireStateLock({
        directory: root,
        reviewId: "rb-test",
        domain: "review",
        waitMs: 500,
        staleMs: 1_000,
        heartbeatMs: 100,
      }),
      (error) =>
        error instanceof StoreError &&
        error.code === "LOCK_OWNER_UNKNOWN" &&
        error.details.retryable === false &&
        error.details.path === lockPath &&
        error.details.pid === stale.pid,
    );
  } finally {
    if (previousNodeOptions == null) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
    if (previousUnknownPid == null) {
      delete process.env.REVIEW_BRIDGE_TEST_UNKNOWN_PID;
    } else {
      process.env.REVIEW_BRIDGE_TEST_UNKNOWN_PID = previousUnknownPid;
    }
  }
  assert.deepEqual(
    JSON.parse(await fsp.readFile(lockPath, "utf8")),
    stale,
  );
  await fsp.unlink(lockPath);
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
  await firstRelease();
  reused.process_start_time = "Mon Jan  1 00:00:00 2001";
  reused.heartbeat_at = "2000-01-01T00:00:00.000Z";
  await writeLockRecord(lockPath, reused);
  const replacementRelease = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    waitMs: 500,
    staleMs: 1_000,
    heartbeatMs: 100,
  });
  await replacementRelease();

  await writeLockRecord(lockPath, {
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
    waitMs: 500,
    staleMs: 1_000,
    heartbeatMs: 100,
  });
  await deadRelease();
});

test("concurrent stale reclaim admits exactly one owner", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-race-");
  const lockPath = path.join(root, ".review-state.lock");
  await writeLockRecord(lockPath, {
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
      waitMs: 500,
      staleMs: 1_000,
      heartbeatMs: 100,
    }),
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 500,
      staleMs: 1_000,
      heartbeatMs: 100,
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
  const privatePrefix = "deadbeef";
  await fsp.writeFile(
    lockPath,
    `${privatePrefix}${"1".repeat(32)}`,
    { mode: 0o600 },
  );
  const started = Date.now();
  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 1_000,
      staleMs: 2_000,
      heartbeatMs: 100,
    }),
    (error) =>
      error instanceof StoreError &&
      error.code === "LOCK_RECORD_INVALID" &&
      error.details.path === lockPath &&
      error.details.retryable === false &&
      error.message.includes("content is not valid JSON") &&
      !error.message.includes(privatePrefix),
  );
  assert.ok(Date.now() - started < 900);
});

test("a coordinator symlink is rejected without changing its target", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-symlink-");
  const target = path.join(root, "target");
  const coordinator = path.join(root, ".review-state.lock.guard");
  await fsp.writeFile(target, "", { mode: 0o600 });
  await fsp.symlink(target, coordinator);
  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
    }),
    (error) =>
      error instanceof StoreError &&
      error.code === "LOCK_COORDINATOR_INVALID" &&
      error.details.path === coordinator,
  );
  assert.equal((await fsp.stat(target)).size, 0);
});

test("lock timing configuration rejects an unsafe heartbeat interval", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-timing-");
  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 500,
      staleMs: 1_000,
      heartbeatMs: 1_000,
    }),
    /heartbeatMs must be less than staleMs/,
  );
});

test("an expired acquisition budget returns retryable REVIEW_BUSY", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-deadline-");
  await assert.rejects(
    acquireStateLock({
      directory: root,
      reviewId: "rb-test",
      domain: "review",
      waitMs: 1,
    }),
    (error) =>
      error instanceof StoreError &&
      error.code === "REVIEW_BUSY" &&
      error.details.retryable === true,
  );
});

test("an unexpected post-write acquire failure cleans up its record", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-acquire-cleanup-");
  const lockPath = path.join(root, ".review-state.lock");
  const hookPath = path.join(root, "fail-directory-sync.cjs");
  const markerPath = path.join(root, "directory-sync-failed");
  await writeDirectorySyncFailureHook(hookPath);

  const previousNodeOptions = process.env.NODE_OPTIONS;
  const previousSyncDirectory =
    process.env.REVIEW_BRIDGE_TEST_SYNC_DIRECTORY;
  const previousSyncMarker = process.env.REVIEW_BRIDGE_TEST_SYNC_MARKER;
  process.env.NODE_OPTIONS = [previousNodeOptions, `--require=${hookPath}`]
    .filter(Boolean)
    .join(" ");
  process.env.REVIEW_BRIDGE_TEST_SYNC_DIRECTORY = root;
  process.env.REVIEW_BRIDGE_TEST_SYNC_MARKER = markerPath;
  try {
    const warnings = await captureWarnings(async () => {
      await assert.rejects(
        acquireStateLock({
          directory: root,
          reviewId: "rb-test",
          domain: "review",
        }),
        (error) =>
          error instanceof StoreError &&
          error.code === "STORE_WRITE_INDETERMINATE" &&
          error.details.cause_code === "EIO" &&
          error.details.state_may_have_changed === true,
      );
    });
    assert.deepEqual(warnings, []);
  } finally {
    if (previousNodeOptions == null) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
    if (previousSyncDirectory == null) {
      delete process.env.REVIEW_BRIDGE_TEST_SYNC_DIRECTORY;
    } else {
      process.env.REVIEW_BRIDGE_TEST_SYNC_DIRECTORY =
        previousSyncDirectory;
    }
    if (previousSyncMarker == null) {
      delete process.env.REVIEW_BRIDGE_TEST_SYNC_MARKER;
    } else {
      process.env.REVIEW_BRIDGE_TEST_SYNC_MARKER = previousSyncMarker;
    }
  }
  assert.equal(await exists(markerPath), true);
  assert.equal(await exists(lockPath), false);
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

test("withStateLock preserves null and undefined rejections", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-falsy-");
  for (const thrown of [null, undefined]) {
    let caught = false;
    try {
      await withStateLock(
        {
          directory: root,
          reviewId: "rb-test",
          domain: "review",
        },
        async () => {
          throw thrown;
        },
      );
    } catch (error) {
      caught = true;
      assert.equal(error, thrown);
    }
    assert.equal(caught, true);
  }
});

test("a transient heartbeat failure does not poison release", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-heartbeat-");
  const lockPath = path.join(root, ".review-state.lock");
  const warnings = await captureWarnings(async () => {
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
  });
  assert.deepEqual(
    warnings.map(({ options }) => options?.code),
    ["REVIEW_BRIDGE_LOCK_CLEANUP"],
  );
  assert.equal(await exists(lockPath), false);
});

test("an untrustworthy heartbeat remains caller-visible after repair", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-heartbeat-invalid-");
  const lockPath = path.join(root, ".review-state.lock");
  const coordinatorPath = `${lockPath}.guard`;
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    heartbeatMs: 20,
  });
  const original = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  const { helperPid } = stateLockProcesses(coordinatorPath);
  await fsp.writeFile(lockPath, "not json\n", { mode: 0o600 });
  await waitForProcessExit(helperPid);
  await writeLockRecord(lockPath, original);

  const warnings = await captureWarnings(async () => {
    await assert.rejects(
      release(),
      (error) =>
        error instanceof StoreError &&
        error.code === "LOCK_OWNERSHIP_LOST" &&
        error.details.status === "RECORD_UNTRUSTWORTHY" &&
        error.details.cause_code === "LOCK_RECORD_INVALID" &&
        error.details.state_may_have_changed === true,
    );
  });
  assert.deepEqual(warnings, []);
  assert.equal(await exists(lockPath), false);
});

test("lock release reports a replacement owner without removing it", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-token-");
  const lockPath = path.join(root, ".review-state.lock");
  const warnings = await captureWarnings(async () => {
    await assert.rejects(
      withStateLock(
        {
          directory: root,
          reviewId: "rb-test",
          domain: "review",
        },
        async () => {
          const replacement = JSON.parse(
            await fsp.readFile(lockPath, "utf8"),
          );
          replacement.owner_token = "f".repeat(32);
          await fsp.unlink(lockPath);
          await writeLockRecord(lockPath, replacement);
        },
      ),
      (error) =>
        error instanceof StoreError &&
        error.code === "LOCK_OWNERSHIP_LOST" &&
        error.details.status === "FOREIGN_OWNER" &&
        error.details.state_may_have_changed === true &&
        /may already have been applied; reread the review/.test(error.message),
    );
  });
  assert.deepEqual(warnings, []);
  assert.equal(
    JSON.parse(await fsp.readFile(lockPath, "utf8")).owner_token,
    "f".repeat(32),
  );
});

test("lock release reports an untrustworthy replacement record", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-invalid-release-");
  const lockPath = path.join(root, ".review-state.lock");
  const warnings = await captureWarnings(async () => {
    await assert.rejects(
      withStateLock(
        {
          directory: root,
          reviewId: "rb-test",
          domain: "review",
        },
        async () => {
          await fsp.writeFile(lockPath, "not json\n", { mode: 0o600 });
          return "MUTATION_APPLIED";
        },
      ),
      (error) =>
        error instanceof StoreError &&
        error.code === "LOCK_OWNERSHIP_LOST" &&
        error.details.status === "RECORD_UNTRUSTWORTHY" &&
        error.details.cause_code === "LOCK_RECORD_INVALID" &&
        error.details.state_may_have_changed === true &&
        /may already have been applied; reread the review/.test(error.message),
    );
  });
  assert.deepEqual(warnings, []);
  assert.equal(await fsp.readFile(lockPath, "utf8"), "not json\n");
});

test("operation and ownership-loss errors retain a structured lock code", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-combined-");
  const lockPath = path.join(root, ".review-state.lock");
  const operationError = new StoreError("OPERATION_FAILED", "operation failed");
  await assert.rejects(
    withStateLock(
      {
        directory: root,
        reviewId: "rb-test",
        domain: "review",
      },
      async () => {
        const replacement = JSON.parse(
          await fsp.readFile(lockPath, "utf8"),
        );
        replacement.owner_token = "f".repeat(32);
        await fsp.unlink(lockPath);
        await writeLockRecord(lockPath, replacement);
        throw operationError;
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === operationError &&
      error.code === "LOCK_OWNERSHIP_LOST" &&
      error.details.retryable === false &&
      error.details.operation_code === "OPERATION_FAILED" &&
      error.details.operation_message === "operation failed" &&
      error.details.release_code === "LOCK_OWNERSHIP_LOST",
  );
  assert.equal(
    JSON.parse(await fsp.readFile(lockPath, "utf8")).owner_token,
    "f".repeat(32),
  );
});

test("lock owner tokens never appear in helper process arguments", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-argv-");
  const lockPath = path.join(root, ".review-state.lock");
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const record = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  const processes = spawnSync("/bin/ps", ["-ww", "-axo", "command="], {
    encoding: "utf8",
  });
  assert.equal(processes.status, 0, processes.stderr);
  assert.equal(processes.stdout.includes(record.owner_token), false);
  await release();
});

test("helper exit preserves live-owner exclusion and token-safe cleanup", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-helper-exit-");
  const lockPath = path.join(root, ".review-state.lock");
  const coordinatorPath = `${lockPath}.guard`;
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    heartbeatMs: 20,
  });
  const warnings = await captureWarnings(async () => {
    try {
      const { helperPid } = stateLockProcesses(coordinatorPath);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(stateLockProcesses(coordinatorPath).helperPid, helperPid);
      process.kill(helperPid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const live = JSON.parse(await fsp.readFile(lockPath, "utf8"));
      live.heartbeat_at = "2000-01-01T00:00:00.000Z";
      await writeLockRecord(lockPath, live);
      await assert.rejects(
        acquireStateLock({
          directory: root,
          reviewId: "rb-test",
          domain: "review",
          waitMs: 500,
          staleMs: 1_000,
          heartbeatMs: 100,
        }),
        (error) => error instanceof StoreError && error.code === "REVIEW_BUSY",
      );
    } finally {
      await release();
    }
  });
  assert.deepEqual(
    warnings.map(({ options }) => options?.code),
    ["REVIEW_BRIDGE_LOCK_CLEANUP"],
  );
  assert.match(warnings[0].warning, /\/usr\/bin\/lockf exited with status 70/);
  assert.equal(await exists(lockPath), false);
  const releaseNext = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  await releaseNext();
});

test("a failed final cleanup is non-retryable and caller-visible", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-cleanup-failed-");
  const lockPath = path.join(root, ".review-state.lock");
  const coordinatorPath = `${lockPath}.guard`;
  const mutationPath = path.join(root, "mutation-applied");

  try {
    const warnings = await captureWarnings(async () => {
      await assert.rejects(
        withStateLock(
          {
            directory: root,
            reviewId: "rb-test",
            domain: "review",
          },
          async () => {
            await fsp.writeFile(mutationPath, "applied\n");
            const { helperPid, lockfPid } =
              stateLockProcesses(coordinatorPath);
            process.kill(helperPid, "SIGKILL");
            await waitForProcessExit(helperPid);
            await waitForProcessExit(lockfPid);
            await fsp.chmod(coordinatorPath, 0o000);
          },
        ),
        (error) => {
          assert.ok(error instanceof StoreError);
          assert.equal(error.code, "LOCK_CLEANUP_FAILED");
          assert.equal(error.details.retryable, false);
          assert.equal(error.details.path, lockPath);
          assert.equal(error.details.cause_code, "LOCK_COORDINATOR_INVALID");
          assert.equal(error.details.state_may_have_changed, true);
          return true;
        },
      );
    });
    assert.deepEqual(
      warnings.map(({ options }) => options?.code),
      ["REVIEW_BRIDGE_LOCK_CLEANUP"],
    );
    assert.equal(await fsp.readFile(mutationPath, "utf8"), "applied\n");
    assert.equal(await exists(lockPath), true);
  } finally {
    await fsp.chmod(coordinatorPath, 0o600).catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
  }
});

test("a hung helper is killed as one process group before cleanup", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-timeout-");
  const lockPath = path.join(root, ".review-state.lock");
  const coordinatorPath = `${lockPath}.guard`;
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
  });
  const { helperPid, lockfPid } = stateLockProcesses(coordinatorPath);
  process.kill(helperPid, "SIGSTOP");
  const started = Date.now();
  const warnings = await captureWarnings(release);
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 4_500 && elapsed < 7_000, `elapsed=${elapsed}`);
  assert.deepEqual(
    warnings.map(({ options }) => options?.code),
    ["REVIEW_BRIDGE_LOCK_CLEANUP"],
  );
  assert.match(
    warnings[0].warning,
    /LOCK_HELPER_TIMEOUT: state-lock helper did not respond within 5000ms/,
  );
  assert.doesNotMatch(warnings[0].warning, /LOCK_HELPER_KILL_FAILED/);
  await waitForProcessExit(helperPid);
  await waitForProcessExit(lockfPid);
  assert.equal(await exists(lockPath), false);
});

test("a blocked event loop does not time out a completed heartbeat", async (t) => {
  const root = await temporaryDirectory(t, "review-bridge-lock-blocked-loop-");
  const release = await acquireStateLock({
    directory: root,
    reviewId: "rb-test",
    domain: "review",
    heartbeatMs: 20,
  });
  const warnings = await captureWarnings(async () => {
    await new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          await fsp.readFile(path.join(root, ".review-state.lock"));
          const blocked = spawnSync("/bin/sleep", ["6"]);
          assert.equal(blocked.status, 0, blocked.stderr?.toString("utf8"));
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 20);
    });
    await new Promise((resolve) => setImmediate(resolve));
    await release();
  });
  assert.deepEqual(warnings, []);
});
