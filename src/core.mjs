import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_ROUNDS = 2;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_OVERLAY_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_FIELD = 200_000;
const MAX_FINDINGS = 100;
const MAX_READ_BYTES = 200_000;

function now() {
  return new Date().toISOString();
}

export function defaultStoreRoot() {
  if (process.env.REVIEW_BRIDGE_HOME) {
    return path.resolve(process.env.REVIEW_BRIDGE_HOME);
  }
  return path.join(os.homedir(), "Library", "Application Support", "ReviewBridge");
}

function assertString(value, name, { allowEmpty = false, max = MAX_TEXT_FIELD } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new Error(`${name} exceeds ${max} characters`);
  }
  return value;
}

function assertReviewId(reviewId) {
  if (typeof reviewId !== "string" || !/^rb-[0-9TZ-]+-[a-f0-9]{8}$/.test(reviewId)) {
    throw new Error("invalid review_id");
  }
}

function safeRelativePath(value, name = "path") {
  assertString(value, name, { max: 4096 });
  const normalized = value.replace(/^\.\/+/, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`${name} must be a repository-relative path`);
  }
  return normalized;
}

function splitNul(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function runGit(repositoryPath, args, options = {}) {
  const {
    allowExitCodes = [0],
    encoding = "buffer",
    maxBuffer = MAX_GIT_OUTPUT,
  } = options;
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: encoding === "buffer" ? undefined : encoding,
    maxBuffer,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error) {
    throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (!allowExitCodes.includes(result.status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr || "";
    throw new Error(`git ${args[0]} failed (${result.status}): ${stderr.trim()}`);
  }
  return result.stdout;
}

async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, filePath);
}

async function writePrivateFile(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, data, { mode: 0o600 });
}

function reviewDirectory(storeRoot, reviewId) {
  assertReviewId(reviewId);
  return path.join(storeRoot, "reviews", reviewId);
}

function roundDirectory(storeRoot, reviewId, round) {
  if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) {
    throw new Error("invalid review round");
  }
  return path.join(reviewDirectory(storeRoot, reviewId), "rounds", String(round));
}

function reviewFile(storeRoot, reviewId) {
  return path.join(reviewDirectory(storeRoot, reviewId), "review.json");
}

async function loadJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

export async function loadReview(storeRoot, reviewId) {
  assertReviewId(reviewId);
  try {
    return await loadJson(reviewFile(storeRoot, reviewId));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`review ${reviewId} not found`);
    }
    throw error;
  }
}

async function saveReview(storeRoot, review) {
  // v0.1 assumes one state transition at a time. Atomic replacement prevents
  // corruption, but concurrent author and reviewer writes can still lose updates.
  const previous = Date.parse(review.updated_at);
  review.updated_at = new Date(
    Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0),
  ).toISOString();
  await atomicWriteJson(reviewFile(storeRoot, review.id), review);
}

function createReviewId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  return `rb-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

async function captureOverlay(repositoryPath, roundRoot, relativePath) {
  const safePath = safeRelativePath(relativePath);
  const source = path.join(repositoryPath, safePath);
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) {
    return {
      path: safePath,
      type: "symlink",
      target: await fsp.readlink(source),
    };
  }
  if (!stat.isFile()) {
    return { path: safePath, type: "unsupported" };
  }
  if (stat.size > MAX_OVERLAY_BYTES) {
    return { path: safePath, type: "too_large", size: stat.size };
  }
  const destination = path.join(roundRoot, "files", safePath);
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.copyFile(source, destination);
  await fsp.chmod(destination, 0o600);
  const content = await fsp.readFile(destination);
  return {
    path: safePath,
    type: "file",
    size: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

function appendUntrackedDiff(repositoryPath, relativePath) {
  const output = runGit(
    repositoryPath,
    ["diff", "--no-index", "--binary", "--", "/dev/null", relativePath],
    { allowExitCodes: [0, 1] },
  );
  return Buffer.from(output);
}

async function buildSnapshot({
  repositoryPath,
  baseRef,
  requirement,
  implementationScope,
  roundRoot,
  writeFiles,
}) {
  const requestedPath = path.resolve(assertString(repositoryPath, "repository_path", { max: 4096 }));
  const topLevel = runGit(requestedPath, ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const repository = await fsp.realpath(topLevel);
  const baseSha = runGit(repository, ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const headSha = runGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
  }).trim();

  const trackedPatch = Buffer.from(
    runGit(repository, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      baseSha,
      "--",
    ]),
  );
  const changedFromBase = splitNul(
    runGit(repository, ["diff", "--name-only", "-z", baseSha, "--"]),
  );
  const workingTreeChanges = splitNul(
    runGit(repository, ["diff", "--name-only", "-z", "HEAD", "--"]),
  );
  const workingTreeDeleted = new Set(
    splitNul(
      runGit(repository, [
        "diff",
        "--name-only",
        "--diff-filter=D",
        "-z",
        "HEAD",
        "--",
      ]),
    ),
  );
  const deletedFromBase = new Set(
    splitNul(
      runGit(repository, [
        "diff",
        "--name-only",
        "--diff-filter=D",
        "-z",
        baseSha,
        "--",
      ]),
    ),
  );
  const untracked = splitNul(
    runGit(repository, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );

  const patchParts = [trackedPatch];
  for (const relativePath of untracked) {
    patchParts.push(Buffer.from("\n"));
    patchParts.push(appendUntrackedDiff(repository, safeRelativePath(relativePath)));
  }
  const patch = Buffer.concat(patchParts);

  const overlays = [];
  if (writeFiles) {
    await fsp.mkdir(roundRoot, { recursive: true, mode: 0o700 });
    for (const relativePath of [...new Set([...workingTreeChanges, ...untracked])].sort()) {
      if (!workingTreeDeleted.has(relativePath)) {
        overlays.push(await captureOverlay(repository, roundRoot, relativePath));
      }
    }
  } else {
    for (const relativePath of [...new Set([...workingTreeChanges, ...untracked])].sort()) {
      if (workingTreeDeleted.has(relativePath)) {
        continue;
      }
      const safePath = safeRelativePath(relativePath);
      const source = path.join(repository, safePath);
      const stat = await fsp.lstat(source);
      if (stat.isSymbolicLink()) {
        overlays.push({
          path: safePath,
          type: "symlink",
          target: await fsp.readlink(source),
        });
      } else if (stat.isFile() && stat.size <= MAX_OVERLAY_BYTES) {
        const content = await fsp.readFile(source);
        overlays.push({
          path: safePath,
          type: "file",
          size: content.length,
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
        });
      } else if (stat.isFile()) {
        overlays.push({ path: safePath, type: "too_large", size: stat.size });
      } else {
        overlays.push({ path: safePath, type: "unsupported" });
      }
    }
  }

  const changedFiles = [...new Set([...changedFromBase, ...untracked])].sort();
  const untrackedPaths = new Set(untracked);
  const deletedFiles = [...deletedFromBase]
    .filter((relativePath) => !untrackedPaths.has(relativePath))
    .sort();
  const hash = crypto.createHash("sha256");
  hash.update(
    JSON.stringify({
      baseSha,
      headSha,
      requirement,
      implementationScope,
      changedFiles,
      deletedFiles,
      overlays,
    }),
  );
  hash.update(patch);
  const snapshotHash = hash.digest("hex");

  const manifest = {
    version: 1,
    captured_at: now(),
    repository_path: repository,
    base_ref: baseRef,
    base_sha: baseSha,
    head_sha: headSha,
    snapshot_hash: snapshotHash,
    changed_files: changedFiles,
    deleted_files: deletedFiles,
    overlays,
    patch_bytes: patch.length,
  };

  if (writeFiles) {
    await writePrivateFile(path.join(roundRoot, "patch.diff"), patch);
    await atomicWriteJson(path.join(roundRoot, "manifest.json"), manifest);
  }
  return { manifest, patch };
}

function publicReview(review) {
  return {
    id: review.id,
    status: review.status,
    created_at: review.created_at,
    updated_at: review.updated_at,
    repository_path: review.repository_path,
    base_ref: review.base_ref,
    requirement: review.requirement,
    implementation_scope: review.implementation_scope,
    current_round: review.current_round,
    max_rounds: review.max_rounds,
    rounds: review.rounds,
    findings: review.findings,
    resolutions: review.resolutions,
    rereview_decisions: review.rereview_decisions,
    clean_snapshot_hash: review.clean_snapshot_hash ?? null,
    history: review.history,
  };
}

function actionRequired(status) {
  const actions = {
    WAITING_FOR_REVIEW: "CLAUDE_INITIAL_REVIEW",
    REVIEW_SUBMITTED: "AUTHOR_RESOLUTIONS",
    AUTHOR_RESPONDED: "PREPARE_REREVIEW",
    WAITING_FOR_REREVIEW: "CLAUDE_REREVIEW",
    CLEAN: "FINALIZE_LOCAL_GATE",
    LOCAL_GATE_PASSED: "PUBLISH",
    HUMAN_REQUIRED: "HUMAN_ARBITRATION",
  };
  return actions[status] ?? "INSPECT_REVIEW";
}

function countBy(values) {
  const result = {};
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort());
}

function reviewSummary(review) {
  const currentSnapshot = review.rounds.at(-1) ?? null;
  const activeFindings = review.findings.filter(
    (finding) =>
      !["RESOLVED", "REBUTTAL_ACCEPTED"].includes(finding.status),
  );
  return {
    id: review.id,
    status: review.status,
    created_at: review.created_at,
    updated_at: review.updated_at,
    current_round: review.current_round,
    max_rounds: review.max_rounds,
    action_required: actionRequired(review.status),
    current_snapshot:
      currentSnapshot == null
        ? null
        : {
            round: currentSnapshot.round,
            base_sha: currentSnapshot.base_sha,
            head_sha: currentSnapshot.head_sha,
            snapshot_hash: currentSnapshot.snapshot_hash,
            changed_file_count: currentSnapshot.changed_files.length,
            deleted_file_count: currentSnapshot.deleted_files.length,
            overlay_count: currentSnapshot.overlays.length,
            patch_bytes: currentSnapshot.patch_bytes,
          },
    findings: {
      total: review.findings.length,
      active: activeFindings.length,
      by_severity: countBy(review.findings.map((finding) => finding.severity)),
      by_status: countBy(review.findings.map((finding) => finding.status)),
    },
    active_findings: activeFindings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      status: finding.status,
      ...(finding.path == null ? {} : { path: finding.path }),
      ...(finding.line == null ? {} : { line: finding.line }),
    })),
    latest_event: review.history.at(-1) ?? null,
    clean_snapshot_hash: review.clean_snapshot_hash ?? null,
  };
}

export async function prepareReview(
  storeRoot,
  { repositoryPath, baseRef, requirement, implementationScope },
) {
  assertString(baseRef, "base_ref", { max: 1024 });
  assertString(requirement, "requirement");
  assertString(implementationScope, "implementation_scope");
  const id = createReviewId();
  const root = reviewDirectory(storeRoot, id);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const roundRoot = roundDirectory(storeRoot, id, 1);
  const { manifest } = await buildSnapshot({
    repositoryPath,
    baseRef,
    requirement,
    implementationScope,
    roundRoot,
    writeFiles: true,
  });
  const timestamp = now();
  const review = {
    version: 1,
    id,
    created_at: timestamp,
    updated_at: timestamp,
    repository_path: manifest.repository_path,
    base_ref: baseRef,
    requirement,
    implementation_scope: implementationScope,
    status: "WAITING_FOR_REVIEW",
    current_round: 1,
    max_rounds: MAX_ROUNDS,
    rounds: [{ round: 1, ...manifest }],
    findings: [],
    resolutions: [],
    rereview_decisions: [],
    history: [{ at: timestamp, event: "REVIEW_PREPARED", round: 1 }],
  };
  await saveReview(storeRoot, review);
  return publicReview(review);
}

export async function listReviews(storeRoot, statuses = null) {
  const reviewsRoot = path.join(storeRoot, "reviews");
  let entries;
  try {
    entries = await fsp.readdir(reviewsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const statusSet =
    statuses && statuses.length > 0 ? new Set(statuses.map(String)) : null;
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const review = await loadReview(storeRoot, entry.name);
      if (!statusSet || statusSet.has(review.status)) {
        result.push(publicReview(review));
      }
    } catch {
      // Ignore incomplete directories; normal writes are atomic.
    }
  }
  return result.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function getReview(storeRoot, reviewId) {
  return publicReview(await loadReview(storeRoot, reviewId));
}

export async function getReviewSummary(storeRoot, reviewId) {
  return reviewSummary(await loadReview(storeRoot, reviewId));
}

export async function waitForReviewState(
  storeRoot,
  reviewId,
  knownUpdatedAt,
  timeoutMs = 30_000,
) {
  assertString(knownUpdatedAt, "known_updated_at", { max: 100 });
  if (!Number.isFinite(Date.parse(knownUpdatedAt))) {
    throw new Error("known_updated_at must be an ISO timestamp");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("timeout_ms must be between 1 and 60000");
  }

  const deadline = Date.now() + timeoutMs;
  let review = await loadReview(storeRoot, reviewId);
  while (review.updated_at === knownUpdatedAt) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        changed: false,
        timed_out: true,
        summary: reviewSummary(review),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    review = await loadReview(storeRoot, reviewId);
  }
  return {
    changed: true,
    timed_out: false,
    summary: reviewSummary(review),
  };
}

function normalizeFinding(input, id, round) {
  if (!input || typeof input !== "object") {
    throw new Error("each finding must be an object");
  }
  const severity = String(input.severity ?? "");
  if (!["blocker", "major", "minor", "nit"].includes(severity)) {
    throw new Error("finding severity must be blocker, major, minor, or nit");
  }
  const finding = {
    id,
    introduced_round: round,
    severity,
    title: assertString(input.title, "finding.title", { max: 500 }),
    explanation: assertString(input.explanation, "finding.explanation", {
      max: 20_000,
    }),
    recommendation:
      typeof input.recommendation === "string"
        ? assertString(input.recommendation, "finding.recommendation", {
            allowEmpty: true,
            max: 20_000,
          })
        : "",
    status: "OPEN",
  };
  if (input.path != null && input.path !== "") {
    finding.path = safeRelativePath(input.path, "finding.path");
  }
  if (input.line != null) {
    if (!Number.isInteger(input.line) || input.line < 1) {
      throw new Error("finding.line must be a positive integer");
    }
    finding.line = input.line;
  }
  return finding;
}

export async function submitInitialReview(storeRoot, reviewId, findingsInput) {
  const review = await loadReview(storeRoot, reviewId);
  if (review.status !== "WAITING_FOR_REVIEW" || review.current_round !== 1) {
    throw new Error(`review is not waiting for its initial review (status=${review.status})`);
  }
  if (!Array.isArray(findingsInput) || findingsInput.length > MAX_FINDINGS) {
    throw new Error(`findings must be an array with at most ${MAX_FINDINGS} items`);
  }
  const findings = findingsInput.map((finding, index) =>
    normalizeFinding(finding, `F-${String(index + 1).padStart(3, "0")}`, 1),
  );
  review.findings = findings;
  if (findings.length === 0) {
    review.status = "CLEAN";
    review.clean_snapshot_hash = review.rounds[0].snapshot_hash;
    review.history.push({ at: now(), event: "INITIAL_REVIEW_CLEAN", round: 1 });
  } else {
    review.status = "REVIEW_SUBMITTED";
    review.history.push({
      at: now(),
      event: "FINDINGS_SUBMITTED",
      round: 1,
      count: findings.length,
    });
  }
  await saveReview(storeRoot, review);
  return publicReview(review);
}

export async function submitResolutions(storeRoot, reviewId, inputs) {
  const review = await loadReview(storeRoot, reviewId);
  if (review.status !== "REVIEW_SUBMITTED") {
    throw new Error(`review is not waiting for author resolutions (status=${review.status})`);
  }
  if (!Array.isArray(inputs)) {
    throw new Error("resolutions must be an array");
  }
  const openFindings = review.findings.filter((finding) => finding.status === "OPEN");
  const byId = new Map(inputs.map((item) => [item?.finding_id, item]));
  if (byId.size !== openFindings.length || inputs.length !== openFindings.length) {
    throw new Error("provide exactly one resolution for every open finding");
  }
  const resolutions = [];
  let humanRequired = false;
  for (const finding of openFindings) {
    const input = byId.get(finding.id);
    if (!input) {
      throw new Error(`missing resolution for ${finding.id}`);
    }
    const disposition = String(input.disposition ?? "");
    if (!["fixed", "rejected", "human_required"].includes(disposition)) {
      throw new Error("resolution disposition must be fixed, rejected, or human_required");
    }
    const resolution = {
      finding_id: finding.id,
      disposition,
      rationale: assertString(input.rationale, "resolution.rationale", {
        max: 20_000,
      }),
      evidence:
        typeof input.evidence === "string"
          ? assertString(input.evidence, "resolution.evidence", {
              allowEmpty: true,
              max: 20_000,
            })
          : "",
      submitted_at: now(),
    };
    resolutions.push(resolution);
    if (disposition === "fixed") {
      finding.status = "AUTHOR_FIXED";
    } else if (disposition === "rejected") {
      finding.status = "AUTHOR_REJECTED";
    } else {
      finding.status = "HUMAN_REQUIRED";
      humanRequired = true;
    }
  }
  review.resolutions.push(...resolutions);
  review.status = humanRequired ? "HUMAN_REQUIRED" : "AUTHOR_RESPONDED";
  review.history.push({
    at: now(),
    event: humanRequired ? "AUTHOR_ESCALATED" : "AUTHOR_RESPONDED",
    round: review.current_round,
  });
  await saveReview(storeRoot, review);
  return publicReview(review);
}

export async function prepareRereview(storeRoot, reviewId) {
  const review = await loadReview(storeRoot, reviewId);
  if (review.status !== "AUTHOR_RESPONDED") {
    throw new Error(`review is not ready for rereview (status=${review.status})`);
  }
  if (review.current_round >= review.max_rounds) {
    review.status = "HUMAN_REQUIRED";
    review.history.push({ at: now(), event: "ROUND_LIMIT_REACHED" });
    await saveReview(storeRoot, review);
    return publicReview(review);
  }
  const round = review.current_round + 1;
  const { manifest } = await buildSnapshot({
    repositoryPath: review.repository_path,
    baseRef: review.base_ref,
    requirement: review.requirement,
    implementationScope: review.implementation_scope,
    roundRoot: roundDirectory(storeRoot, review.id, round),
    writeFiles: true,
  });
  review.current_round = round;
  review.rounds.push({ round, ...manifest });
  review.status = "WAITING_FOR_REREVIEW";
  review.history.push({ at: now(), event: "REREVIEW_PREPARED", round });
  await saveReview(storeRoot, review);
  return publicReview(review);
}

export async function submitRereview(
  storeRoot,
  reviewId,
  decisionInputs,
  newFindingInputs,
) {
  const review = await loadReview(storeRoot, reviewId);
  if (review.status !== "WAITING_FOR_REREVIEW") {
    throw new Error(`review is not waiting for rereview (status=${review.status})`);
  }
  if (!Array.isArray(decisionInputs) || !Array.isArray(newFindingInputs)) {
    throw new Error("decisions and new_findings must be arrays");
  }
  if (newFindingInputs.length > MAX_FINDINGS) {
    throw new Error(`new_findings must contain at most ${MAX_FINDINGS} items`);
  }
  const awaiting = review.findings.filter((finding) =>
    ["AUTHOR_FIXED", "AUTHOR_REJECTED"].includes(finding.status),
  );
  const byId = new Map(decisionInputs.map((item) => [item?.finding_id, item]));
  if (byId.size !== awaiting.length || decisionInputs.length !== awaiting.length) {
    throw new Error("provide exactly one rereview decision for every author response");
  }
  let unresolved = false;
  for (const finding of awaiting) {
    const input = byId.get(finding.id);
    if (!input) {
      throw new Error(`missing rereview decision for ${finding.id}`);
    }
    const decision = String(input.decision ?? "");
    if (!["resolved", "rebuttal_accepted", "still_open"].includes(decision)) {
      throw new Error(
        "rereview decision must be resolved, rebuttal_accepted, or still_open",
      );
    }
    const record = {
      finding_id: finding.id,
      decision,
      rationale: assertString(input.rationale, "decision.rationale", {
        max: 20_000,
      }),
      submitted_at: now(),
    };
    review.rereview_decisions.push(record);
    if (decision === "resolved") {
      finding.status = "RESOLVED";
    } else if (decision === "rebuttal_accepted") {
      finding.status = "REBUTTAL_ACCEPTED";
    } else {
      finding.status = "STILL_OPEN";
      unresolved = true;
    }
  }

  let nextFindingNumber = review.findings.length + 1;
  const newFindings = newFindingInputs.map((finding) =>
    normalizeFinding(
      finding,
      `F-${String(nextFindingNumber++).padStart(3, "0")}`,
      review.current_round,
    ),
  );
  review.findings.push(...newFindings);
  if (newFindings.length > 0) {
    unresolved = true;
  }

  if (unresolved) {
    review.status = "HUMAN_REQUIRED";
    review.history.push({
      at: now(),
      event: "REREVIEW_UNRESOLVED",
      round: review.current_round,
      new_findings: newFindings.length,
    });
  } else {
    review.status = "CLEAN";
    review.clean_snapshot_hash =
      review.rounds[review.rounds.length - 1].snapshot_hash;
    review.history.push({
      at: now(),
      event: "REREVIEW_CLEAN",
      round: review.current_round,
    });
  }
  await saveReview(storeRoot, review);
  return publicReview(review);
}

export async function finalizeLocalGate(storeRoot, reviewId) {
  const review = await loadReview(storeRoot, reviewId);
  if (review.status !== "CLEAN") {
    throw new Error(`only a CLEAN review can be finalized (status=${review.status})`);
  }
  const { manifest } = await buildSnapshot({
    repositoryPath: review.repository_path,
    baseRef: review.base_ref,
    requirement: review.requirement,
    implementationScope: review.implementation_scope,
    roundRoot: "",
    writeFiles: false,
  });
  if (manifest.snapshot_hash !== review.clean_snapshot_hash) {
    throw new Error(
      "working tree changed after the clean verdict; create a new review task",
    );
  }
  const gate = {
    version: 1,
    review_id: review.id,
    passed_at: now(),
    snapshot_hash: review.clean_snapshot_hash,
    base_sha: manifest.base_sha,
    head_sha: manifest.head_sha,
    status: "LOCAL_GATE_PASSED",
  };
  await atomicWriteJson(path.join(reviewDirectory(storeRoot, review.id), "gate.json"), gate);
  review.status = "LOCAL_GATE_PASSED";
  review.history.push({ at: now(), event: "LOCAL_GATE_PASSED" });
  await saveReview(storeRoot, review);
  return { review: publicReview(review), gate };
}

export async function readReviewArtifact(
  storeRoot,
  reviewId,
  round,
  artifact,
  offset = 0,
  limit = 65_536,
) {
  assertReviewId(reviewId);
  if (!["patch.diff", "manifest.json"].includes(artifact)) {
    throw new Error("artifact must be patch.diff or manifest.json");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_BYTES) {
    throw new Error(`limit must be between 1 and ${MAX_READ_BYTES}`);
  }
  const filePath = path.join(roundDirectory(storeRoot, reviewId, round), artifact);
  const content = await fsp.readFile(filePath);
  return {
    artifact,
    round,
    ...bufferResult(content, offset, limit),
  };
}

function findRound(review, round) {
  const selected = review.rounds.find((entry) => entry.round === round);
  if (!selected) {
    throw new Error(`round ${round} does not exist`);
  }
  return selected;
}

function bufferResult(content, offset, limit) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_BYTES) {
    throw new Error(`limit must be between 1 and ${MAX_READ_BYTES}`);
  }
  let binary = content.includes(0);
  if (!binary) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      binary = true;
    }
  }
  if (binary) {
    const chunk = content.subarray(offset, offset + limit);
    return {
      offset,
      next_offset:
        offset + chunk.length < content.length ? offset + chunk.length : null,
      total_bytes: content.length,
      encoding: "base64",
      content: chunk.toString("base64"),
    };
  }

  let start = Math.min(offset, content.length);
  while (start < content.length && (content[start] & 0xc0) === 0x80) {
    start += 1;
  }
  let end = Math.min(start + limit, content.length);
  if (end < content.length) {
    while (end > start && (content[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end === start) {
      end = Math.min(start + 1, content.length);
      while (end < content.length && (content[end] & 0xc0) === 0x80) {
        end += 1;
      }
    }
  }
  const chunk = content.subarray(start, end);
  return {
    offset: start,
    next_offset: end < content.length ? end : null,
    total_bytes: content.length,
    encoding: "utf8",
    content: chunk.toString("utf8"),
  };
}

export async function readSnapshotFile(
  storeRoot,
  reviewId,
  round,
  relativePath,
  offset = 0,
  limit = 65_536,
) {
  const review = await loadReview(storeRoot, reviewId);
  const selectedRound = findRound(review, round);
  const safePath = safeRelativePath(relativePath);
  if (selectedRound.deleted_files.includes(safePath)) {
    return { path: safePath, round, deleted: true };
  }
  const overlay = selectedRound.overlays.find((entry) => entry.path === safePath);
  if (overlay?.type === "symlink") {
    return { path: safePath, round, type: "symlink", target: overlay.target };
  }
  if (overlay?.type === "too_large") {
    throw new Error(`snapshot file exceeds ${MAX_OVERLAY_BYTES} bytes`);
  }
  if (overlay?.type === "unsupported") {
    throw new Error("snapshot path is not a regular file");
  }
  let content;
  if (overlay?.type === "file") {
    content = await fsp.readFile(
      path.join(roundDirectory(storeRoot, reviewId, round), "files", safePath),
    );
  } else {
    content = Buffer.from(
      runGit(review.repository_path, ["show", `${selectedRound.head_sha}:${safePath}`]),
    );
  }
  return {
    path: safePath,
    round,
    deleted: false,
    ...bufferResult(content, offset, limit),
  };
}

export async function searchSnapshot(
  storeRoot,
  reviewId,
  round,
  pattern,
  pathPrefix = null,
  maxResults = 100,
) {
  assertString(pattern, "pattern", { max: 1000 });
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
    throw new Error("max_results must be between 1 and 500");
  }
  const review = await loadReview(storeRoot, reviewId);
  const selectedRound = findRound(review, round);
  const prefix =
    pathPrefix == null || pathPrefix === ""
      ? null
      : safeRelativePath(pathPrefix, "path_prefix");
  const args = [
    "grep",
    "-n",
    "-z",
    "-I",
    "-F",
    "-e",
    pattern,
    selectedRound.head_sha,
    "--",
  ];
  if (prefix) {
    args.push(prefix);
  }
  const output = runGit(review.repository_path, args, {
    allowExitCodes: [0, 1],
  });
  const overlayPaths = new Set(selectedRound.overlays.map((entry) => entry.path));
  const deletedPaths = new Set(selectedRound.deleted_files);
  const results = [];
  for (const overlay of selectedRound.overlays) {
    if (
      overlay.type === "too_large" &&
      (!prefix || overlay.path.startsWith(prefix))
    ) {
      results.push({
        path: overlay.path,
        skipped: true,
        reason: `modified snapshot file exceeds ${MAX_OVERLAY_BYTES} bytes and is not searchable`,
      });
      if (results.length >= maxResults) {
        return results;
      }
    }
  }
  const treePrefix = `${selectedRound.head_sha}:`;
  let cursor = 0;
  while (cursor < output.length) {
    const pathEnd = output.indexOf(0, cursor);
    const lineEnd = pathEnd === -1 ? -1 : output.indexOf(0, pathEnd + 1);
    const recordEnd = lineEnd === -1 ? -1 : output.indexOf(10, lineEnd + 1);
    if (pathEnd === -1 || lineEnd === -1 || recordEnd === -1) {
      break;
    }
    const treePath = output.subarray(cursor, pathEnd).toString("utf8");
    const filePath = treePath.startsWith(treePrefix)
      ? treePath.slice(treePrefix.length)
      : treePath;
    const lineNumber = output.subarray(pathEnd + 1, lineEnd).toString("utf8");
    const text = output.subarray(lineEnd + 1, recordEnd).toString("utf8");
    if (!overlayPaths.has(filePath) && !deletedPaths.has(filePath)) {
      results.push({ path: filePath, line: Number(lineNumber), text });
    }
    if (results.length >= maxResults) {
      return results;
    }
    cursor = recordEnd + 1;
  }
  for (const overlay of selectedRound.overlays) {
    if (
      overlay.type !== "file" ||
      (prefix && !overlay.path.startsWith(prefix))
    ) {
      continue;
    }
    const content = await fsp.readFile(
      path.join(roundDirectory(storeRoot, reviewId, round), "files", overlay.path),
    );
    if (content.includes(0)) {
      continue;
    }
    const lines = content.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(pattern)) {
        results.push({ path: overlay.path, line: index + 1, text: lines[index] });
        if (results.length >= maxResults) {
          return results;
        }
      }
    }
  }
  return results;
}

export async function openReview(storeRoot, reviewId) {
  const review = await loadReview(storeRoot, reviewId);
  const current = findRound(review, review.current_round);
  return {
    ...publicReview(review),
    current_snapshot: current,
    artifacts: [
      {
        name: "patch.diff",
        round: review.current_round,
        bytes: current.patch_bytes,
      },
      { name: "manifest.json", round: review.current_round },
    ],
  };
}
