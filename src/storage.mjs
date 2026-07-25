import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;

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
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
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

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

export async function removeAndSync(filePath) {
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

export async function readSecureFile(
  filePath,
  { maxBytes, requiredMode = 0o600, allowMissing = false, flags = fs.constants.O_RDONLY } = {},
) {
  let handle;
  try {
    handle = await fsp.open(
      filePath,
      flags | (fs.constants.O_NOFOLLOW ?? 0),
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
    return { handle, stat, bytes: await handle.readFile() };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function readSecureJson(filePath, options = {}) {
  const opened = await readSecureFile(filePath, options);
  if (opened == null) {
    return null;
  }
  try {
    return JSON.parse(opened.bytes.toString("utf8"));
  } finally {
    await opened.handle.close();
  }
}

function processStartTime(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout.trim() !== "") {
    return result.stdout.trim();
  }
  return null;
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
  const actualStartTime = processStartTime(pid);
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

async function readLock(lockPath) {
  const opened = await readSecureFile(lockPath, {
    maxBytes: 16 * 1024,
    requiredMode: 0o600,
  });
  try {
    return JSON.parse(opened.bytes.toString("utf8"));
  } finally {
    await opened.handle.close();
  }
}

async function tryReclaim(lockPath, staleMs, currentTime) {
  let record;
  try {
    record = await readLock(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    return false;
  }
  const heartbeat = Date.parse(record.heartbeat_at);
  if (
    !Number.isFinite(heartbeat) ||
    currentTime - heartbeat <= staleMs ||
    !Number.isSafeInteger(record.pid) ||
    typeof record.process_start_time !== "string" ||
    typeof record.owner_token !== "string"
  ) {
    return false;
  }
  if (processIdentityStatus(record.pid, record.process_start_time) !== "DEAD") {
    return false;
  }
  let current;
  try {
    current = await readLock(lockPath);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  if (current.owner_token !== record.owner_token) {
    return false;
  }
  await fsp.unlink(lockPath);
  await syncDirectory(path.dirname(lockPath));
  return true;
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
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, `.${domain}-state.lock`);
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const processStart = processStartTime(process.pid);
  if (processStart == null) {
    throw new StoreError(
      "LOCK_OWNER_UNKNOWN",
      "could not determine the current process start time",
    );
  }
  const acquiredAt = new Date().toISOString();
  const record = {
    version: 1,
    owner_token: ownerToken,
    pid: process.pid,
    process_start_time: processStart,
    acquired_at: acquiredAt,
    heartbeat_at: acquiredAt,
    domain,
    review_id: reviewId,
  };
  const deadline = Date.now() + waitMs;
  let handle;
  while (handle == null) {
    try {
      handle = await fsp.open(
        lockPath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(canonicalJsonBytes(record));
      await handle.sync();
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = null;
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await tryReclaim(lockPath, staleMs, Date.now())) {
        continue;
      }
      if (Date.now() >= deadline) {
        const code = lockErrorCode(domain);
        throw new StoreError(code, `${code}: ${reviewId} is busy; reread and retry`, {
          retryable: true,
          review_id: reviewId,
          domain,
        });
      }
      await delay(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  let stopped = false;
  let heartbeatPromise = Promise.resolve();
  const heartbeat = () => {
    heartbeatPromise = heartbeatPromise.then(async () => {
      if (stopped) {
        return;
      }
      record.heartbeat_at = new Date().toISOString();
      const bytes = canonicalJsonBytes(record);
      await handle.truncate(0);
      await handle.write(bytes, 0, bytes.length, 0);
      await handle.sync();
    });
    heartbeatPromise.catch(() => {});
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
    await handle.close();
    let current;
    try {
      current = await readLock(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (current.owner_token === ownerToken) {
      await fsp.unlink(lockPath);
      await syncDirectory(directory);
    }
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
