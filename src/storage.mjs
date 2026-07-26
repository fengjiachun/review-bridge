import { execFile, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;
const LOCK_HELPER_COMMAND_TIMEOUT_MS = 5_000;
const PROCESS_PROBE_TIMEOUT_MS = 2_000;
const LOCK_HELPER_ARGUMENT = "--state-lock-helper";
const LOCKF_PATH = "/usr/bin/lockf";
const LOCKF_BUSY_EXIT = 75;
const PS_PATH = "/bin/ps";
const PROCESS_START_FORMAT = "darwin-ps-lstart-c-utc-v1";
const execFileAsync = promisify(execFile);
let ownProcessStartTimePromise;

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.details = details;
  }
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteFile(filePath, data, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomBytes(16).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fsp.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      mode,
    );
    await handle.chmod(mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value)}\n`);
}

async function removeAndSync(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  await syncDirectory(path.dirname(filePath));
  return true;
}

// O_NOFOLLOW protects the final component. Callers must supply a trusted private
// parent directory, as Review Bridge does for its 0700 per-review store.
async function openSecureFile(
  filePath,
  {
    maxBytes,
    requiredMode = 0o600,
    allowMissing = false,
    flags = fs.constants.O_RDONLY,
  } = {},
) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new StoreError(
      "STORE_NOFOLLOW_UNAVAILABLE",
      "this runtime does not provide O_NOFOLLOW for private store reads",
      { path: filePath },
    );
  }
  let handle;
  try {
    handle = await fsp.open(
      filePath,
      flags | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new StoreError(
        "STORE_FILE_TYPE_INVALID",
        `${filePath} must be a regular file`,
        { path: filePath },
      );
    }
    const actualMode = stat.mode & 0o777;
    if (requiredMode != null && actualMode !== requiredMode) {
      throw new StoreError(
        "STORE_MODE_MISMATCH",
        `${filePath} has mode ${actualMode.toString(8)}; run chmod 0600 and retry`,
        {
          path: filePath,
          actual_mode: actualMode.toString(8).padStart(4, "0"),
          required_mode: requiredMode.toString(8).padStart(4, "0"),
        },
      );
    }
    if (maxBytes != null && stat.size > maxBytes) {
      throw new StoreError(
        "STORE_FILE_TOO_LARGE",
        `${filePath} exceeds ${maxBytes} bytes`,
        { path: filePath, size: stat.size, max_bytes: maxBytes },
      );
    }
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readSecureFile(filePath, options = {}) {
  const opened = await openSecureFile(filePath, options);
  if (opened == null) {
    return null;
  }
  try {
    return {
      stat: opened.stat,
      bytes: await opened.handle.readFile(),
    };
  } finally {
    await opened.handle.close();
  }
}

function stableProcessEnvironment() {
  return {
    ...process.env,
    LC_ALL: "C",
    LC_TIME: "C",
    TZ: "UTC",
  };
}

function processStartTimeSync(pid) {
  const result = spawnSync(PS_PATH, ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: stableProcessEnvironment(),
    timeout: PROCESS_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (
    result.status === 0 &&
    typeof result.stdout === "string" &&
    result.stdout.trim() !== ""
  ) {
    return result.stdout.trim();
  }
  return null;
}

async function ownProcessStartTime() {
  ownProcessStartTimePromise ??= execFileAsync(
    PS_PATH,
    ["-o", "lstart=", "-p", String(process.pid)],
    {
      encoding: "utf8",
      env: stableProcessEnvironment(),
      timeout: PROCESS_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  ).then(({ stdout }) => {
    const value = stdout.trim();
    if (value === "") {
      throw new StoreError(
        "LOCK_RUNTIME_UNAVAILABLE",
        `${PS_PATH} did not return this process's start time`,
        { path: PS_PATH },
      );
    }
    return value;
  }).catch((error) => {
    if (error instanceof StoreError) {
      throw error;
    }
    throw new StoreError(
      "LOCK_RUNTIME_UNAVAILABLE",
      `could not execute ${PS_PATH}: ${error.message}`,
      { path: PS_PATH },
    );
  });
  try {
    return await ownProcessStartTimePromise;
  } catch (error) {
    ownProcessStartTimePromise = null;
    throw error;
  }
}

function processIdentityStatus(pid, expectedStartTime) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return "DEAD";
    }
    if (error?.code !== "EPERM") {
      return "UNKNOWN";
    }
  }
  const actualStartTime = processStartTimeSync(pid);
  if (actualStartTime == null) {
    return "UNKNOWN";
  }
  return actualStartTime === expectedStartTime ? "ALIVE" : "DEAD";
}

function lockErrorCode(domain) {
  return domain === "review" ? "REVIEW_BUSY" : "PUBLICATION_BUSY";
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function invalidLockRecord(lockPath, message) {
  return new StoreError(
    "LOCK_RECORD_INVALID",
    `${lockPath} is not a valid state-lock record: ${message}; inspect it and remove it only after confirming no owner is active`,
    { path: lockPath, retryable: false },
  );
}

async function readLock(
  lockPath,
  { allowMissing = false, ignoreMode = false } = {},
) {
  let opened;
  try {
    opened = await readSecureFile(lockPath, {
      allowMissing,
      maxBytes: 16 * 1024,
      requiredMode: ignoreMode ? null : 0o600,
    });
  } catch (error) {
    if (error instanceof StoreError || error?.code === "ENOENT") {
      throw error;
    }
    throw invalidLockRecord(lockPath, error.message);
  }
  if (opened == null) {
    return null;
  }
  let record;
  try {
    record = JSON.parse(opened.bytes.toString("utf8"));
  } catch (error) {
    throw invalidLockRecord(lockPath, error.message);
  }
  if (
    record == null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.version !== 1 ||
    typeof record.owner_token !== "string" ||
    !/^[0-9a-f]{32}$/.test(record.owner_token) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    record.process_start_time_format !== PROCESS_START_FORMAT ||
    typeof record.process_start_time !== "string" ||
    record.process_start_time === "" ||
    typeof record.acquired_at !== "string" ||
    !Number.isFinite(Date.parse(record.acquired_at)) ||
    typeof record.heartbeat_at !== "string" ||
    !Number.isFinite(Date.parse(record.heartbeat_at)) ||
    !["review", "publication"].includes(record.domain) ||
    typeof record.review_id !== "string"
  ) {
    throw invalidLockRecord(
      lockPath,
      "required fields are missing or malformed",
    );
  }
  return record;
}

function helperError(error) {
  return {
    code: error?.code ?? "LOCK_HELPER_FAILED",
    message: error?.message ?? String(error),
    details: error?.details ?? {},
  };
}

function throwHelperError(result) {
  throw new StoreError(
    result.error?.code ?? "LOCK_HELPER_FAILED",
    result.error?.message ?? "state-lock helper failed",
    result.error?.details ?? {},
  );
}

async function acquireRecordUnderGuard(payload) {
  if (Date.now() > payload.deadline_ms) {
    return { status: "DEADLINE" };
  }
  const current = await readLock(payload.lock_path, { allowMissing: true });
  if (current != null) {
    if (
      current.domain !== payload.record.domain ||
      current.review_id !== payload.record.review_id
    ) {
      throw invalidLockRecord(
        payload.lock_path,
        "domain or review ID does not match",
      );
    }
    if (Date.now() - Date.parse(current.heartbeat_at) <= payload.stale_ms) {
      return { status: "BUSY" };
    }
    const identity = processIdentityStatus(
      current.pid,
      current.process_start_time,
    );
    if (identity === "ALIVE") {
      return { status: "BUSY" };
    }
    if (identity === "UNKNOWN") {
      throw new StoreError(
        "LOCK_OWNER_UNKNOWN",
        `could not conclusively identify stale lock owner pid ${current.pid}; inspect ${payload.lock_path} and retry only after confirming that owner is inactive`,
        {
          path: payload.lock_path,
          pid: current.pid,
          process_start_time: current.process_start_time,
          retryable: false,
        },
      );
    }
  }
  const timestamp = new Date().toISOString();
  const record = {
    ...payload.record,
    acquired_at: timestamp,
    heartbeat_at: timestamp,
  };
  await atomicWriteJson(payload.lock_path, record);
  return {
    status: current == null ? "ACQUIRED" : "RECLAIMED",
  };
}

async function updateRecordUnderGuard(payload) {
  const current = await readLock(payload.lock_path, {
    allowMissing: true,
    ignoreMode: payload.action === "RELEASE",
  });
  if (current == null) {
    return { status: "MISSING" };
  }
  if (current.owner_token !== payload.owner_token) {
    return { status: "FOREIGN_OWNER" };
  }
  if (payload.action === "HEARTBEAT") {
    current.heartbeat_at = new Date().toISOString();
    await atomicWriteJson(payload.lock_path, current);
    return { status: "UPDATED" };
  }
  if (payload.action !== "RELEASE") {
    throw new TypeError("invalid state-lock holder command");
  }
  await removeAndSync(payload.lock_path);
  return { status: "RELEASED" };
}

function writeHelperMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runHelperAction(payload, acquired) {
  if (!acquired && payload.action === "ACQUIRE") {
    return acquireRecordUnderGuard(payload);
  }
  if (!acquired && payload.action === "RELEASE_ONCE") {
    return updateRecordUnderGuard({ ...payload, action: "RELEASE" });
  }
  if (
    acquired &&
    ["HEARTBEAT", "RELEASE"].includes(payload.action)
  ) {
    return updateRecordUnderGuard(payload);
  }
  throw new TypeError("invalid state-lock holder action sequence");
}

async function stateLockHelperMain() {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  let acquired = false;
  for await (const line of lines) {
    let payload;
    try {
      payload = JSON.parse(line);
      const result = await runHelperAction(payload, acquired);
      writeHelperMessage(result);
      if (["ACQUIRED", "RECLAIMED"].includes(result.status)) {
        acquired = true;
        continue;
      }
      if (!acquired || payload.action === "RELEASE") {
        return;
      }
    } catch (error) {
      writeHelperMessage({ status: "ERROR", error: helperError(error) });
      return;
    }
  }
  // EOF means the parent disappeared. Keep the record for stale-owner recovery;
  // lockf releases the advisory guard automatically when this helper exits.
}

function coordinatorError(coordinatorPath, error) {
  if (error instanceof StoreError) {
    return error;
  }
  return new StoreError(
    "LOCK_COORDINATOR_INVALID",
    `cannot use state-lock coordinator ${coordinatorPath}: ${error.message}`,
    { path: coordinatorPath, cause_code: error?.code ?? null },
  );
}

async function ensureCoordinatorFile(coordinatorPath) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new StoreError(
      "STORE_NOFOLLOW_UNAVAILABLE",
      "this runtime does not provide O_NOFOLLOW for lock coordination",
      { path: coordinatorPath },
    );
  }
  let handle;
  try {
    handle = await fsp.open(
      coordinatorPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(path.dirname(coordinatorPath));
    return;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code !== "EEXIST") {
      throw coordinatorError(coordinatorPath, error);
    }
  }

  try {
    const opened = await openSecureFile(coordinatorPath, {
      flags: fs.constants.O_RDWR,
      maxBytes: 0,
      requiredMode: 0o600,
    });
    await opened.handle.close();
  } catch (error) {
    throw coordinatorError(coordinatorPath, error);
  }
}

function lockfExitError(code, signal, stderr) {
  if (code === LOCKF_BUSY_EXIT) {
    return new StoreError(
      "LOCK_COORDINATOR_BUSY",
      "state-lock coordinator is held by another process",
      { retryable: true },
    );
  }
  return new StoreError(
    "LOCK_HELPER_FAILED",
    signal == null
      ? `${LOCKF_PATH} exited with status ${code}: ${stderr}`
      : `${LOCKF_PATH} was terminated by ${signal}: ${stderr}`,
    {
      retryable: false,
      exit_status: code,
      signal,
      stderr,
    },
  );
}

function spawnHolderProcess(coordinatorPath) {
  const child = spawn(
    LOCKF_PATH,
    [
      "-s",
      "-k",
      "-t",
      "0",
      coordinatorPath,
      process.execPath,
      fileURLToPath(import.meta.url),
      LOCK_HELPER_ARGUMENT,
    ],
    {
      detached: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let stderrText = "";
  let closedError = null;
  const messages = [];
  const waiters = [];

  function rejectWaiters(error) {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    if (Buffer.byteLength(stdoutBuffer, "utf8") > 64 * 1024) {
      const error = new StoreError(
        "LOCK_HELPER_FAILED",
        "state-lock helper output is too large",
      );
      closedError = killProcessGroup(error);
      rejectWaiters(closedError);
      return;
    }
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const failure = new StoreError(
          "LOCK_HELPER_FAILED",
          `state-lock helper returned invalid JSON: ${error.message}`,
        );
        closedError = killProcessGroup(failure);
        rejectWaiters(closedError);
        return;
      }
      const waiter = waiters.shift();
      if (waiter == null) {
        messages.push(message);
      } else {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (Buffer.byteLength(stderrText, "utf8") < 16 * 1024) {
      stderrText += chunk;
    }
  });
  child.on("error", (error) => {
    closedError = new StoreError(
      "LOCK_RUNTIME_UNAVAILABLE",
      `could not execute ${LOCKF_PATH}: ${error.message}`,
      { path: LOCKF_PATH },
    );
    rejectWaiters(closedError);
  });
  child.on("close", (code, signal) => {
    closedError ??= lockfExitError(code, signal, stderrText.trim());
    rejectWaiters(closedError);
  });

  function nextMessage(timeoutMs) {
    if (messages.length > 0) {
      return Promise.resolve(messages.shift());
    }
    if (closedError != null) {
      return Promise.reject(closedError);
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        const error = new StoreError(
          "LOCK_HELPER_TIMEOUT",
          `state-lock helper did not respond within ${timeoutMs}ms`,
          { retryable: false, timeout_ms: timeoutMs },
        );
        closedError = killProcessGroup(error);
        reject(closedError);
      }, timeoutMs);
      waiter.timer.unref();
      waiters.push(waiter);
    });
  }

  async function send(payload, timeoutMs) {
    const response = nextMessage(timeoutMs);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  function killProcessGroup(cause) {
    if (!Number.isSafeInteger(child.pid)) {
      return cause;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code === "ESRCH") {
        return cause;
      }
      return new StoreError(
        "LOCK_HELPER_KILL_FAILED",
        `state-lock helper could not be terminated after ${cause.message}: ${error.message}`,
        {
          retryable: false,
          cause_code: cause.code ?? null,
          kill_code: error?.code ?? null,
        },
      );
    }
    return cause;
  }

  return {
    send,
    end: () => child.stdin.end(),
    kill: (cause) => killProcessGroup(cause),
  };
}

async function startHolder(coordinatorPath, payload, timeoutMs) {
  await ensureCoordinatorFile(coordinatorPath);
  const holder = spawnHolderProcess(coordinatorPath);
  try {
    return {
      holder,
      response: await holder.send(payload, timeoutMs),
    };
  } catch (error) {
    throw holder.kill(error);
  }
}

async function releaseRecordOnce(
  coordinatorPath,
  lockPath,
  ownerToken,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new StoreError(
        "LOCK_HELPER_TIMEOUT",
        "timed out while cleaning up the state-lock record",
        { retryable: false, timeout_ms: timeoutMs },
      );
    }
    try {
      const { holder, response } = await startHolder(
        coordinatorPath,
        {
          action: "RELEASE_ONCE",
          lock_path: lockPath,
          owner_token: ownerToken,
        },
        Math.min(remaining, LOCK_HELPER_COMMAND_TIMEOUT_MS),
      );
      holder.end();
      if (response.status === "ERROR") {
        throwHelperError(response);
      }
      return response;
    } catch (error) {
      if (error?.code !== "LOCK_COORDINATOR_BUSY") {
        throw error;
      }
      await delay(Math.min(LOCK_POLL_MS, remaining));
    }
  }
}

async function cleanupFailedAcquire(
  coordinatorPath,
  lockPath,
  ownerToken,
  reviewId,
) {
  try {
    await releaseRecordOnce(
      coordinatorPath,
      lockPath,
      ownerToken,
      LOCK_HELPER_COMMAND_TIMEOUT_MS,
    );
  } catch (error) {
    emitCleanupWarning(reviewId, [error]);
  }
}

function emitCleanupWarning(reviewId, errors) {
  if (errors.length === 0) {
    return;
  }
  process.emitWarning(
    `state-lock cleanup for ${reviewId} encountered: ${errors
      .map((error) => error.message)
      .join("; ")}`,
    { code: "REVIEW_BRIDGE_LOCK_CLEANUP" },
  );
}

export async function acquireStateLock({
  directory,
  reviewId,
  domain,
  waitMs = LOCK_WAIT_MS,
  staleMs = LOCK_STALE_MS,
  heartbeatMs = LOCK_HEARTBEAT_MS,
}) {
  if (!["review", "publication"].includes(domain)) {
    throw new TypeError("lock domain must be review or publication");
  }
  for (const [name, value] of [
    ["waitMs", waitMs],
    ["staleMs", staleMs],
    ["heartbeatMs", heartbeatMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (heartbeatMs >= staleMs) {
    throw new TypeError("heartbeatMs must be less than staleMs");
  }
  const directoryStat = await fsp.stat(directory);
  if (!directoryStat.isDirectory()) {
    throw new TypeError("lock directory must be an existing directory");
  }
  const lockPath = path.join(directory, `.${domain}-state.lock`);
  const coordinatorPath = `${lockPath}.guard`;
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const processStart = await ownProcessStartTime();
  const record = {
    version: 1,
    owner_token: ownerToken,
    pid: process.pid,
    process_start_time: processStart,
    process_start_time_format: PROCESS_START_FORMAT,
    domain,
    review_id: reviewId,
  };
  const deadline = Date.now() + waitMs;
  let firstAttempt = true;
  let holder;
  while (true) {
    const remaining = deadline - Date.now();
    if (!firstAttempt && remaining <= LOCK_POLL_MS) {
      if (remaining > 0) {
        await delay(remaining);
      }
      const code = lockErrorCode(domain);
      throw new StoreError(
        code,
        `${code}: ${reviewId} is busy; reread and retry`,
        {
          retryable: true,
          review_id: reviewId,
          domain,
        },
      );
    }
    firstAttempt = false;
    try {
      const started = await startHolder(
        coordinatorPath,
        {
          action: "ACQUIRE",
          lock_path: lockPath,
          record,
          stale_ms: staleMs,
          deadline_ms: deadline,
        },
        Math.min(
          Math.max(1, remaining),
          LOCK_HELPER_COMMAND_TIMEOUT_MS,
        ),
      );
      if (started.response.status === "ERROR") {
        started.holder.end();
        throwHelperError(started.response);
      }
      if (["ACQUIRED", "RECLAIMED"].includes(started.response.status)) {
        holder = started.holder;
        break;
      }
      started.holder.end();
    } catch (error) {
      if (error?.code === "LOCK_COORDINATOR_BUSY") {
        await delay(
          Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())),
        );
        continue;
      }
      if (
        [
          "LOCK_HELPER_FAILED",
          "LOCK_HELPER_KILL_FAILED",
          "LOCK_HELPER_TIMEOUT",
        ].includes(error?.code)
      ) {
        await cleanupFailedAcquire(
          coordinatorPath,
          lockPath,
          ownerToken,
          reviewId,
        );
      }
      throw error;
    }
    await delay(
      Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())),
    );
  }

  let stopped = false;
  let heartbeatPromise = Promise.resolve();
  let heartbeatError = null;
  let holderUsable = true;
  const heartbeat = () => {
    heartbeatPromise = heartbeatPromise.then(async () => {
      if (stopped || !holderUsable) {
        return;
      }
      try {
        const result = await holder.send(
          {
            action: "HEARTBEAT",
            lock_path: lockPath,
            owner_token: ownerToken,
          },
          LOCK_HELPER_COMMAND_TIMEOUT_MS,
        );
        if (result.status === "ERROR") {
          throwHelperError(result);
        }
        if (result.status !== "UPDATED") {
          throw new StoreError(
            "LOCK_OWNERSHIP_LOST",
            `state-lock heartbeat for ${reviewId} found ${result.status}`,
            { review_id: reviewId, domain, status: result.status },
          );
        }
      } catch (error) {
        holderUsable = false;
        heartbeatError = holder.kill(error);
      }
    });
  };
  const timer = setInterval(heartbeat, heartbeatMs);
  timer.unref();

  return async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    await heartbeatPromise;
    const cleanupErrors = [];
    if (heartbeatError != null) {
      cleanupErrors.push(heartbeatError);
    }
    let released = false;
    if (holderUsable) {
      try {
        const result = await holder.send(
          {
            action: "RELEASE",
            lock_path: lockPath,
            owner_token: ownerToken,
          },
          LOCK_HELPER_COMMAND_TIMEOUT_MS,
        );
        holder.end();
        if (result.status === "ERROR") {
          throwHelperError(result);
        }
        if (["MISSING", "FOREIGN_OWNER"].includes(result.status)) {
          cleanupErrors.push(
            new StoreError(
              "LOCK_OWNERSHIP_LOST",
              `state-lock release for ${reviewId} found ${result.status}`,
              { review_id: reviewId, domain, status: result.status },
            ),
          );
        }
        released = ["RELEASED", "MISSING", "FOREIGN_OWNER"].includes(
          result.status,
        );
      } catch (error) {
        holderUsable = false;
        cleanupErrors.push(holder.kill(error));
      }
    }
    if (!released) {
      try {
        await releaseRecordOnce(
          coordinatorPath,
          lockPath,
          ownerToken,
          LOCK_HELPER_COMMAND_TIMEOUT_MS,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    emitCleanupWarning(reviewId, cleanupErrors);
  };
}

export async function withStateLock(options, operation) {
  const release = await acquireStateLock(options);
  try {
    return await operation();
  } finally {
    await release();
  }
}

if (process.argv[2] === LOCK_HELPER_ARGUMENT) {
  await stateLockHelperMain();
}
