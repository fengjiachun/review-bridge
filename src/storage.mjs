import { execFile, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;
const LOCK_HELPER_ARGUMENT = "--state-lock-helper";
const LOCKF_PATH = "/usr/bin/lockf";
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

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("canonical JSON rejects lone Unicode surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("canonical JSON rejects lone Unicode surrogates");
    }
  }
  return value;
}

function canonicalJsonValue(value) {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(assertUnicodeScalarString(value));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(
          `canonical JSON does not support a sparse array at index ${index}`,
        );
      }
    }
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON only supports plain objects");
    }
    const keys = Object.keys(value);
    for (const key of keys) {
      if (value[key] === undefined) {
        throw new TypeError(
          `canonical JSON does not support undefined at key ${JSON.stringify(key)}`,
        );
      }
    }
    return `{${keys
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(assertUnicodeScalarString(key))}:${canonicalJsonValue(value[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value) {
  return canonicalJsonValue(value);
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
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

export async function atomicWriteCanonicalJson(filePath, value) {
  await atomicWriteFile(filePath, canonicalJsonBytes(value));
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
export async function openSecureFile(
  filePath,
  { maxBytes, requiredMode = 0o600, allowMissing = false, flags = fs.constants.O_RDONLY } = {},
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

export async function readSecureFile(filePath, options = {}) {
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

export async function readSecureJson(filePath, options = {}) {
  const opened = await readSecureFile(filePath, options);
  if (opened == null) {
    return null;
  }
  return JSON.parse(opened.bytes.toString("utf8"));
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
  });
  if (result.status === 0 && result.stdout.trim() !== "") {
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

async function readLock(lockPath, { allowMissing = false, ignoreMode = false } = {}) {
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
    !Number.isFinite(Date.parse(record.acquired_at)) ||
    !Number.isFinite(Date.parse(record.heartbeat_at)) ||
    !["review", "publication"].includes(record.domain) ||
    typeof record.review_id !== "string"
  ) {
    throw invalidLockRecord(lockPath, "required fields are missing or malformed");
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

async function runLockedHelper(payload) {
  const lockPath = payload.lock_path;
  const action = payload.action;
  if (!["ACQUIRE", "HEARTBEAT", "RELEASE"].includes(action)) {
    throw new TypeError("invalid state-lock helper action");
  }
  if (action === "ACQUIRE") {
    if (Date.now() > payload.deadline_ms) {
      return { status: "DEADLINE" };
    }
    const current = await readLock(lockPath, { allowMissing: true });
    if (current != null) {
      if (
        current.domain !== payload.record.domain ||
        current.review_id !== payload.record.review_id
      ) {
        throw invalidLockRecord(lockPath, "domain or review ID does not match");
      }
      const heartbeat = Date.parse(current.heartbeat_at);
      if (Date.now() - heartbeat <= payload.stale_ms) {
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
          `could not conclusively identify stale lock owner pid ${current.pid}; inspect ${lockPath} and retry only after confirming that owner is inactive`,
          {
            path: lockPath,
            pid: current.pid,
            process_start_time: current.process_start_time,
            retryable: false,
          },
        );
      }
    }
    await atomicWriteCanonicalJson(lockPath, payload.record);
    return { status: current == null ? "ACQUIRED" : "RECLAIMED" };
  }

  const current = await readLock(lockPath, {
    allowMissing: true,
    ignoreMode: action === "RELEASE",
  });
  if (current == null) {
    return { status: "MISSING" };
  }
  if (current.owner_token !== payload.owner_token) {
    return { status: "FOREIGN_OWNER" };
  }
  if (action === "HEARTBEAT") {
    current.heartbeat_at = new Date().toISOString();
    await atomicWriteCanonicalJson(lockPath, current);
    return { status: "UPDATED" };
  }
  await removeAndSync(lockPath);
  return { status: "RELEASED" };
}

async function stateLockHelperMain(encodedPayload) {
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    return await runLockedHelper(payload);
  } catch (error) {
    return { status: "ERROR", error: helperError(error) };
  }
}

async function ensureCoordinatorFile(coordinatorPath) {
  const handle = await fsp.open(
    coordinatorPath,
    fs.constants.O_RDWR | fs.constants.O_CREAT,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function invokeStateLockHelper(
  coordinatorPath,
  payload,
) {
  await ensureCoordinatorFile(coordinatorPath);
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const args = [
    "-s",
    "-t",
    "0",
    coordinatorPath,
    process.execPath,
    fileURLToPath(import.meta.url),
    LOCK_HELPER_ARGUMENT,
    encodedPayload,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(LOCKF_PATH, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= 64 * 1024) {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.reduce((total, item) => total + item.length, 0) < 16 * 1024) {
        stderr.push(chunk);
      }
    });
    child.on("error", (error) => {
      reject(
        new StoreError(
          "LOCK_RUNTIME_UNAVAILABLE",
          `could not execute ${LOCKF_PATH}: ${error.message}`,
          { path: LOCKF_PATH },
        ),
      );
    });
    child.on("close", (code) => {
      if (outputBytes > 64 * 1024) {
        reject(new StoreError("LOCK_HELPER_FAILED", "state-lock helper output is too large"));
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        reject(
          new StoreError(
            "LOCK_COORDINATOR_BUSY",
            `${LOCKF_PATH} exited with status ${code}: ${Buffer.concat(stderr)
              .toString("utf8")
              .trim()}`,
            { retryable: true },
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(
          new StoreError(
            "LOCK_HELPER_FAILED",
            `state-lock helper returned invalid JSON: ${error.message}`,
          ),
        );
      }
    });
  });
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
  const directoryStat = await fsp.stat(directory);
  if (!directoryStat.isDirectory()) {
    throw new TypeError("lock directory must be an existing directory");
  }
  const lockPath = path.join(directory, `.${domain}-state.lock`);
  const coordinatorPath = `${lockPath}.guard`;
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const processStart = await ownProcessStartTime();
  const acquiredAt = new Date().toISOString();
  const record = {
    version: 1,
    owner_token: ownerToken,
    pid: process.pid,
    process_start_time: processStart,
    process_start_time_format: PROCESS_START_FORMAT,
    acquired_at: acquiredAt,
    heartbeat_at: acquiredAt,
    domain,
    review_id: reviewId,
  };
  const deadline = Date.now() + waitMs;
  let firstAttempt = true;
  while (true) {
    const remaining = deadline - Date.now();
    if (!firstAttempt && remaining <= 0) {
      const code = lockErrorCode(domain);
      throw new StoreError(code, `${code}: ${reviewId} is busy; reread and retry`, {
        retryable: true,
        review_id: reviewId,
        domain,
      });
    }
    firstAttempt = false;
    let result;
    try {
      result = await invokeStateLockHelper(
        coordinatorPath,
        {
          action: "ACQUIRE",
          lock_path: lockPath,
          record,
          stale_ms: staleMs,
          deadline_ms: deadline,
        },
      );
    } catch (error) {
      if (error?.code !== "LOCK_COORDINATOR_BUSY") {
        throw error;
      }
    }
    if (result?.status === "ERROR") {
      throwHelperError(result);
    }
    if (["ACQUIRED", "RECLAIMED"].includes(result?.status)) {
      break;
    }
    await delay(
      Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())),
    );
  }

  let stopped = false;
  let heartbeatPromise = Promise.resolve();
  let heartbeatError = null;
  const heartbeat = () => {
    heartbeatPromise = heartbeatPromise.then(async () => {
      if (stopped) {
        return;
      }
      try {
        const result = await invokeStateLockHelper(
          coordinatorPath,
          {
            action: "HEARTBEAT",
            lock_path: lockPath,
            owner_token: ownerToken,
          },
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
        heartbeatError = null;
      } catch (error) {
        heartbeatError = error;
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
    try {
      const result = await invokeStateLockHelper(
        coordinatorPath,
        {
          action: "RELEASE",
          lock_path: lockPath,
          owner_token: ownerToken,
        },
      );
      if (result.status === "ERROR") {
        throwHelperError(result);
      }
    } catch (error) {
      cleanupErrors.push(error);
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
  const result = await stateLockHelperMain(process.argv[3] ?? "");
  process.stdout.write(JSON.stringify(result));
}
