import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteFile,
  canonicalJson,
  removeAndSync,
  withStateLock,
} from "./storage.mjs";

export const MAX_ROUNDS = 2;
export const DEFAULT_CHANGE_SIZE_BUDGET = 2000;
export const REVIEWER_PROVIDERS = Object.freeze([
  "CLAUDE_DESKTOP",
  "CODEX_TASK",
  "HERMES",
  "DEEPSEEK_HARNESS",
]);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_OVERLAY_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_FIELD = 200_000;
const MAX_FINDINGS = 100;
const MAX_READ_BYTES = 200_000;
const MAX_PATCH_INDEX_ENTRIES = 400;
const MAX_AUTOMATIC_PARENT_CANDIDATES = 3;

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

function assertReviewerProvider(value) {
  if (!REVIEWER_PROVIDERS.includes(value)) {
    throw new Error(
      `reviewer_provider must be one of ${REVIEWER_PROVIDERS.join(", ")}`,
    );
  }
  return value;
}

function reviewerProviderFor(review) {
  return assertReviewerProvider(
    review.reviewer_provider ?? "CLAUDE_DESKTOP",
  );
}

// A ledger written before advisory mode existed carries no field, and a review
// without one is an ordinary gated review.
function isAdvisory(review) {
  return review.advisory === true;
}

// The mechanical fence. An advisory review reports on code this operator did
// not author and cannot answer for, so its terminal is a report: no gate, no
// author loop, no second round. Each refusal is evaluated before the state
// check it precedes, so the advisory reason is the one returned rather than a
// state-machine message that says nothing about why the path is closed.
function assertNotAdvisory(review, refusal) {
  if (isAdvisory(review)) {
    throw new Error(refusal);
  }
}

function requireReviewerProvider(review, expectedProvider) {
  const provider = assertReviewerProvider(expectedProvider);
  const boundProvider = reviewerProviderFor(review);
  if (boundProvider !== provider) {
    throw new Error(
      `reviewer provider mismatch (expected=${boundProvider}, actual=${provider})`,
    );
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

async function resolveRepositoryRoot(repositoryPath) {
  const requestedPath = path.resolve(
    assertString(repositoryPath, "repository_path", { max: 4096 }),
  );
  const topLevel = runGit(requestedPath, ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  return fsp.realpath(topLevel);
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

// Functions suffixed *WhileLocked are called only through this wrapper.
async function withReviewMutationLock(
  storeRoot,
  reviewId,
  operation,
  { allowMissing = false } = {},
) {
  assertReviewId(reviewId);
  if (!allowMissing) {
    await loadReview(storeRoot, reviewId);
  }
  return withStateLock(
    {
      directory: reviewDirectory(storeRoot, reviewId),
      reviewId,
      domain: "review",
    },
    operation,
  );
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
  review.state_version = (review.state_version ?? 0) + 1;
  review.updated_at = now();
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

const DIFF_HEADER = Buffer.from("diff --git ");
const DIFF_HEADER_FOLLOWERS = [
  "index ",
  "old mode ",
  "new mode ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "dissimilarity index ",
  "copy from ",
  "rename from ",
  "--- ",
  "Binary files ",
  "GIT binary patch",
];

// Git quotes a path containing quotes, control bytes, or (by default) any
// non-ASCII byte, C-style: `diff --git "a/\346\226\207" "b/\346\226\207"`.
// The escapes are ASCII, so the header line itself always decodes as UTF-8.
const QUOTED_PATH_ESCAPES = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

function decodeQuotedGitPath(token) {
  const inner = token.slice(1, -1);
  const bytes = [];
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] !== "\\") {
      bytes.push(inner.charCodeAt(index));
      continue;
    }
    index += 1;
    const escape = inner[index];
    if (escape >= "0" && escape <= "7") {
      let octal = escape;
      while (
        octal.length < 3 &&
        inner[index + 1] >= "0" &&
        inner[index + 1] <= "7"
      ) {
        index += 1;
        octal += inner[index];
      }
      bytes.push(parseInt(octal, 8));
    } else if (escape in QUOTED_PATH_ESCAPES) {
      bytes.push(QUOTED_PATH_ESCAPES[escape]);
    } else {
      return null;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return null;
  }
}

function diffHeaderPath(header) {
  let candidate;
  if (header.endsWith('"')) {
    let start = -1;
    for (let index = header.length - 2; index >= 0; index -= 1) {
      if (header[index] !== '"') {
        continue;
      }
      let backslashes = 0;
      for (let j = index - 1; j >= 0 && header[j] === "\\"; j -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        start = index;
        break;
      }
    }
    if (start < 1 || header[start - 1] !== " ") {
      return null;
    }
    const decoded = decodeQuotedGitPath(header.slice(start));
    if (decoded == null || !decoded.startsWith("b/")) {
      return null;
    }
    candidate = decoded.slice(2);
  } else {
    // An unquoted header is `diff --git a/X b/X`, and a filename may legally
    // contain ` b/` (`a/foo b/bar b/foo b/bar`), so searching for the
    // separator is ambiguous. The two sides have equal length, which pins the
    // split to exactly one position; verify it instead of guessing. Renames
    // (`a/old b/new`) fail the check and stay path-null, which the reviewer
    // instructions turn into a mandatory read.
    const content = header.slice(DIFF_HEADER.length);
    const pathLength = (content.length - 5) / 2;
    if (
      !Number.isInteger(pathLength) ||
      pathLength < 1 ||
      !content.startsWith("a/") ||
      content.slice(2 + pathLength, 5 + pathLength) !== " b/" ||
      content.slice(2, 2 + pathLength) !== content.slice(5 + pathLength)
    ) {
      return null;
    }
    candidate = content.slice(5 + pathLength);
  }
  if (candidate === "") {
    return null;
  }
  try {
    return safeRelativePath(candidate);
  } catch {
    return null;
  }
}

// Byte offsets of every per-file section in patch.diff, so a reviewer can read
// only the sections that matter instead of the whole cumulative patch. The
// index is advisory: it is not part of the snapshot commitment, and a reader
// that ignores it still sees the exact same bytes.
export function buildPatchIndex(patch) {
  const starts = [];
  let cursor = 0;
  while (cursor <= patch.length - DIFF_HEADER.length) {
    const found = patch.indexOf(DIFF_HEADER, cursor);
    if (found < 0) {
      break;
    }
    cursor = found + DIFF_HEADER.length;
    if (found !== 0 && patch[found - 1] !== 10) {
      continue;
    }
    let lineEnd = patch.indexOf(10, found);
    if (lineEnd < 0) {
      lineEnd = patch.length;
    }
    let nextEnd = patch.indexOf(10, lineEnd + 1);
    if (nextEnd < 0) {
      nextEnd = patch.length;
    }
    const nextLine = patch.subarray(lineEnd + 1, nextEnd).toString("utf8");
    if (!DIFF_HEADER_FOLLOWERS.some((prefix) => nextLine.startsWith(prefix))) {
      continue;
    }
    // The header must decode fatally: with core.quotePath=false Git emits
    // raw non-UTF-8 filename bytes, and a lossy decode would substitute
    // U+FFFD and label the section with a plausible path that exists in no
    // tree. Undecodable headers stay path-null, which is a mandatory read.
    let header = null;
    try {
      header = new TextDecoder("utf-8", { fatal: true }).decode(
        patch.subarray(found, lineEnd),
      );
    } catch {
      // fall through with header = null
    }
    starts.push({
      offset: found,
      path: header == null ? null : diffHeaderPath(header),
    });
  }
  const entries = starts.map((entry, position) => ({
    path: entry.path,
    offset: entry.offset,
    bytes:
      (position + 1 < starts.length ? starts[position + 1].offset : patch.length) -
      entry.offset,
  }));
  // Coverage is contiguous from offset zero by construction: bytes before the
  // first recognized section — a legitimate separator byte, or a corrupted
  // header — get a leading path-null entry, which the reviewer instructions
  // turn into a mandatory read. Without this, an unrecognized prefix would be
  // the one range no index entry admits to.
  const firstOffset = entries.length > 0 ? entries[0].offset : patch.length;
  if (firstOffset > 0) {
    entries.unshift({ path: null, offset: 0, bytes: firstOffset });
  }
  if (entries.length > MAX_PATCH_INDEX_ENTRIES) {
    // Truncation must not cost coverage: the index always spans the whole
    // patch, so a bounded ledger entry cannot hide the tail from a reviewer.
    // Everything past the cap collapses into one final path-null entry.
    const kept = entries.slice(0, MAX_PATCH_INDEX_ENTRIES);
    const last = kept.at(-1);
    const remainderOffset = last.offset + last.bytes;
    kept.push({
      path: null,
      offset: remainderOffset,
      bytes: patch.length - remainderOffset,
    });
    return { entries: kept, truncated: true };
  }
  return { entries, truncated: false };
}

function appendUntrackedDiff(repositoryPath, relativePath) {
  const output = runGit(
    repositoryPath,
    [
      "-c",
      "core.quotePath=true",
      "diff",
      "--no-index",
      "--binary",
      "--",
      "/dev/null",
      relativePath,
    ],
    { allowExitCodes: [0, 1] },
  );
  return Buffer.from(output);
}

export function patchChangeSize(patch) {
  let inHunk = false;
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of patch.toString("utf8").split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      addedLines += 1;
    } else if (inHunk && line.startsWith("-")) {
      deletedLines += 1;
    }
  }
  return {
    added_lines: addedLines,
    deleted_lines: deletedLines,
    total_lines: addedLines + deletedLines,
  };
}

export function changeSizeWarningThreshold(budget) {
  return Math.ceil(budget * 0.75);
}

export function changeSizeReport(
  changeSize,
  budget = DEFAULT_CHANGE_SIZE_BUDGET,
) {
  if (changeSize == null) return null;
  const warningThreshold = changeSizeWarningThreshold(budget);
  return {
    ...changeSize,
    budget,
    warning_threshold: warningThreshold,
    warning_threshold_crossed: changeSize.total_lines >= warningThreshold,
    remaining_headroom: Math.max(0, budget - changeSize.total_lines),
    over_budget: changeSize.total_lines > budget,
  };
}

async function buildSnapshot({
  repositoryPath,
  baseRef,
  requirement,
  implementationScope,
  roundRoot,
  writeFiles,
}) {
  const repository = await resolveRepositoryRoot(repositoryPath);
  const baseSha = runGit(repository, ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const headSha = runGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
  }).trim();

  const trackedPatch = Buffer.from(
    runGit(repository, [
      // Quoting is forced so diff headers stay decodable UTF-8 for the patch
      // index even when the repository sets core.quotePath=false.
      "-c",
      "core.quotePath=true",
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
  const worktreeClean =
    workingTreeChanges.length === 0 && untracked.length === 0;

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
      worktreeClean,
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
    worktree_clean: worktreeClean,
    patch_bytes: patch.length,
    change_size: patchChangeSize(patch),
  };

  if (writeFiles) {
    await atomicWriteFile(path.join(roundRoot, "patch.diff"), patch);
    await atomicWriteJson(path.join(roundRoot, "manifest.json"), manifest);
  }
  return { manifest, patch };
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function snapshotHashFromReviewRound(
  storeRoot,
  reviewId,
  review,
  round,
  // Callers that already hold the patch bytes pass them in, so hashing and
  // any later use of the content see the same read and cannot be split by a
  // concurrent file swap.
  preloadedPatch = null,
) {
  if (
    !Number.isInteger(round?.round) ||
    !Array.isArray(round.changed_files) ||
    !Array.isArray(round.deleted_files) ||
    !Array.isArray(round.overlays) ||
    typeof round.worktree_clean !== "boolean" ||
    typeof review.requirement !== "string" ||
    typeof review.implementation_scope !== "string"
  ) {
    throw new Error("review round is malformed");
  }
  const patch =
    preloadedPatch ??
    (await fsp.readFile(
      path.join(
        roundDirectory(storeRoot, reviewId, round.round),
        "patch.diff",
      ),
    ));
  if (patch.length !== round.patch_bytes) {
    throw new Error("review patch length does not match its ledger");
  }
  if (
    round.change_size != null &&
    canonicalJson(round.change_size) !== canonicalJson(patchChangeSize(patch))
  ) {
    throw new Error("review change size does not match its immutable patch");
  }
  const hash = crypto.createHash("sha256");
  hash.update(
    JSON.stringify({
      baseSha: round.base_sha,
      headSha: round.head_sha,
      requirement: review.requirement,
      implementationScope: review.implementation_scope,
      changedFiles: round.changed_files,
      deletedFiles: round.deleted_files,
      overlays: round.overlays,
      worktreeClean: round.worktree_clean,
    }),
  );
  hash.update(patch);
  return hash.digest("hex");
}

async function repositoryIdentity(repositoryPath) {
  const commonDirectory = runGit(
    repositoryPath,
    ["rev-parse", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  return fsp.realpath(
    path.isAbsolute(commonDirectory)
      ? commonDirectory
      : path.resolve(repositoryPath, commonDirectory),
  );
}

async function verifySuccessorArtifacts(
  storeRoot,
  reviewId,
  selectedRound,
) {
  if (selectedRound.successor == null) {
    return null;
  }
  try {
    const root = roundDirectory(storeRoot, reviewId, selectedRound.round);
    const [delta, proofBytes] = await Promise.all([
      fsp.readFile(path.join(root, "successor.diff")),
      fsp.readFile(path.join(root, "successor.json")),
    ]);
    if (
      delta.length !== selectedRound.successor.delta_bytes ||
      sha256(delta) !== selectedRound.successor.delta_sha256
    ) {
      throw new Error("successor delta does not match its ledger");
    }
    const proof = JSON.parse(proofBytes.toString("utf8"));
    if (canonicalJson(proof) !== canonicalJson(selectedRound.successor)) {
      throw new Error("successor proof does not match its ledger");
    }
    return {
      "successor.diff": delta,
      "successor.json": proofBytes,
    };
  } catch {
    throw new Error("successor artifact integrity check failed");
  }
}

async function buildSuccessorArtifacts({
  storeRoot,
  parentReviewId,
  repositoryPath,
  requirement,
  manifest,
  roundRoot,
  // An author naming a parent is asserting a continuation, so a requirement
  // mismatch there is an author error and fails closed. Server-side selection
  // asserts nothing: it reports the parent's requirement instead, because the
  // gate attests the reviewed tree, not the prose that motivated the review.
  requireRequirementMatch = true,
}) {
  const fullStrategy = (fallbackReason = null) => ({
    strategy: {
      mode: "FULL",
      parent_review_id: parentReviewId ?? null,
      fallback_reason: fallbackReason,
    },
    successor: null,
  });
  if (parentReviewId == null) {
    return fullStrategy();
  }
  assertReviewId(parentReviewId);

  let parent;
  let gateBytes;
  let gate;
  try {
    parent = await loadReview(storeRoot, parentReviewId);
  } catch {
    return fullStrategy("parent review is unavailable");
  }
  if (parent.id !== parentReviewId) {
    return fullStrategy("parent review id does not match the requested review");
  }
  if (parent.status !== "LOCAL_GATE_PASSED") {
    return fullStrategy("parent review must be LOCAL_GATE_PASSED");
  }
  try {
    gateBytes = await fsp.readFile(
      path.join(reviewDirectory(storeRoot, parentReviewId), "gate.json"),
    );
    gate = JSON.parse(gateBytes.toString("utf8"));
  } catch {
    return fullStrategy("parent gate proof is unavailable");
  }
  if (!Array.isArray(parent.rounds)) {
    return fullStrategy("parent review ledger is malformed");
  }
  const parentRound = parent.rounds.find(
    (round) => round?.snapshot_hash === parent.clean_snapshot_hash,
  );
  if (!parentRound) {
    return fullStrategy(
      "parent clean snapshot is not present in its review ledger",
    );
  }
  const validObjectId = (value) =>
    typeof value === "string" &&
    (value.length === 40 || value.length === 64) &&
    /^[0-9a-f]+$/.test(value);
  if (
    !validObjectId(parentRound.base_sha) ||
    !validObjectId(parentRound.head_sha) ||
    typeof parentRound.snapshot_hash !== "string"
  ) {
    return fullStrategy("parent review ledger is malformed");
  }
  try {
    const snapshotHash = await snapshotHashFromReviewRound(
      storeRoot,
      parentReviewId,
      parent,
      parentRound,
    );
    if (snapshotHash !== parent.clean_snapshot_hash) {
      return fullStrategy(
        "parent review ledger does not match its clean snapshot commitment",
      );
    }
  } catch {
    return fullStrategy(
      "parent review ledger does not match its clean snapshot commitment",
    );
  }
  if (
    gate?.version !== 1 ||
    gate.review_id !== parent.id ||
    gate.status !== "LOCAL_GATE_PASSED" ||
    gate.snapshot_hash !== parent.clean_snapshot_hash ||
    gate.base_sha !== parentRound.base_sha ||
    gate.head_sha !== parentRound.head_sha
  ) {
    return fullStrategy("parent gate does not match the clean parent snapshot");
  }
  let parentReviewerProvider;
  let gateReviewerProvider;
  try {
    parentReviewerProvider = reviewerProviderFor(parent);
    gateReviewerProvider = assertReviewerProvider(
      gate.reviewer_provider ?? "CLAUDE_DESKTOP",
    );
  } catch {
    return fullStrategy("parent reviewer provider is invalid");
  }
  if (gateReviewerProvider !== parentReviewerProvider) {
    return fullStrategy(
      "parent gate reviewer provider does not match the parent review",
    );
  }
  let parentRepositoryIdentity;
  let currentRepositoryIdentity;
  try {
    [parentRepositoryIdentity, currentRepositoryIdentity] = await Promise.all([
      repositoryIdentity(parent.repository_path),
      repositoryIdentity(repositoryPath),
    ]);
  } catch {
    return fullStrategy("cannot verify the parent repository identity");
  }
  if (parentRepositoryIdentity !== currentRepositoryIdentity) {
    return fullStrategy("parent review belongs to a different repository");
  }
  if (parentRound.base_sha !== manifest.base_sha) {
    return fullStrategy("parent and successor must use the same base SHA");
  }
  if (requireRequirementMatch && parent.requirement !== requirement) {
    return fullStrategy("parent and successor must use the same requirement");
  }
  if (
    parentRound.worktree_clean !== true ||
    manifest.worktree_clean !== true
  ) {
    return fullStrategy("successor reviews require committed clean worktrees");
  }
  const ancestorStatus = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", parentRound.head_sha, manifest.head_sha],
    {
      cwd: repositoryPath,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (ancestorStatus.error) {
    return fullStrategy(
      `cannot verify parent ancestry: ${ancestorStatus.error.message}`,
    );
  }
  if (ancestorStatus.status !== 0) {
    return fullStrategy("parent head is not an ancestor of the successor head");
  }

  try {
    const delta = Buffer.from(
      runGit(repositoryPath, [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        parentRound.head_sha,
        manifest.head_sha,
        "--",
      ]),
    );
    const changedFiles = splitNul(
      runGit(repositoryPath, [
        "diff",
        "--name-only",
        "-z",
        parentRound.head_sha,
        manifest.head_sha,
        "--",
      ]),
    ).sort();
    const deletedFiles = splitNul(
      runGit(repositoryPath, [
        "diff",
        "--name-only",
        "--diff-filter=D",
        "-z",
        parentRound.head_sha,
        manifest.head_sha,
        "--",
      ]),
    ).sort();
    const parentTreeSha = runGit(
      repositoryPath,
      ["rev-parse", `${parentRound.head_sha}^{tree}`],
      { encoding: "utf8" },
    ).trim();
    const currentTreeSha = runGit(
      repositoryPath,
      ["rev-parse", `${manifest.head_sha}^{tree}`],
      { encoding: "utf8" },
    ).trim();
    const successor = {
      version: 1,
      parent_review_id: parent.id,
      parent_reviewer_provider: parentReviewerProvider,
      parent_requirement: parent.requirement,
      requirement_match: parent.requirement === requirement,
      parent_snapshot_hash: parent.clean_snapshot_hash,
      parent_gate_sha256: sha256(gateBytes),
      base_sha: manifest.base_sha,
      parent_head_sha: parentRound.head_sha,
      current_head_sha: manifest.head_sha,
      parent_tree_sha: parentTreeSha,
      current_tree_sha: currentTreeSha,
      changed_files: changedFiles,
      deleted_files: deletedFiles,
      delta_bytes: delta.length,
      delta_sha256: sha256(delta),
    };
    await atomicWriteFile(path.join(roundRoot, "successor.diff"), delta);
    await atomicWriteJson(path.join(roundRoot, "successor.json"), successor);
    return {
      strategy: {
        mode: "SUCCESSOR",
        parent_review_id: parent.id,
        fallback_reason: null,
      },
      successor,
    };
  } catch (error) {
    await removeAndSync(path.join(roundRoot, "successor.diff")).catch(() => {});
    await removeAndSync(path.join(roundRoot, "successor.json")).catch(() => {});
    return fullStrategy(`cannot build successor artifacts: ${error.message}`);
  }
}

function publicReview(review) {
  return {
    id: review.id,
    status: review.status,
    created_at: review.created_at,
    updated_at: review.updated_at,
    state_version: review.state_version ?? 0,
    repository_path: review.repository_path,
    base_ref: review.base_ref,
    requirement: review.requirement,
    implementation_scope: review.implementation_scope,
    reviewer_provider: reviewerProviderFor(review),
    advisory: isAdvisory(review),
    review_strategy: review.review_strategy ?? {
      mode: "FULL",
      parent_review_id: null,
      fallback_reason: null,
      parent_selection: "NONE",
    },
    current_round: review.current_round,
    max_rounds: review.max_rounds,
    change_size: changeSizeReport(review.rounds?.at(-1)?.change_size),
    rounds: review.rounds,
    findings: review.findings,
    resolutions: review.resolutions,
    rereview_decisions: review.rereview_decisions,
    carried_findings: review.carried_findings ?? [],
    clean_snapshot_hash: review.clean_snapshot_hash ?? null,
    history: review.history,
  };
}

function actionRequired(status, advisory = false) {
  // An advisory review that has been reviewed is finished: both states it can
  // reach after `WAITING_FOR_REVIEW` are terminal reports. Advertising the
  // gated successors here would send a driver at the three paths the fence
  // refuses.
  if (advisory && ["REVIEW_SUBMITTED", "CLEAN"].includes(status)) {
    return "REPORT_ADVISORY_FINDINGS";
  }
  const actions = {
    WAITING_FOR_REVIEW: "REVIEWER_INITIAL_REVIEW",
    REVIEW_SUBMITTED: "AUTHOR_RESOLUTIONS",
    AUTHOR_RESPONDED: "PREPARE_REREVIEW",
    WAITING_FOR_REREVIEW: "REVIEWER_REREVIEW",
    CLEAN: "FINALIZE_LOCAL_GATE",
    LOCAL_GATE_PASSED: "PUBLISH",
    HUMAN_REQUIRED: "HUMAN_ARBITRATION",
    CONTINUABLE_FINDINGS: "ADDRESS_LOCAL_FINDINGS",
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

const RESOLVED_FINDING_STATUSES = new Set([
  "RESOLVED",
  "REBUTTAL_ACCEPTED",
]);

export function continuationFindingFingerprint(finding) {
  return sha256(
    canonicalJson({
      severity: finding.severity,
      title: finding.title,
      explanation: finding.explanation,
      recommendation: finding.recommendation ?? "",
      path: finding.path ?? null,
      line: finding.line ?? null,
    }),
  );
}

function continuationFindings(review) {
  return review.findings
    .filter((finding) => finding.status === "OPEN")
    .map((finding) => ({
      continued_from_review_id: review.id,
      finding_id: finding.id,
      fingerprint_sha256: continuationFindingFingerprint(finding),
      severity: finding.severity,
      title: finding.title,
      explanation: finding.explanation,
      recommendation: finding.recommendation ?? "",
      ...(finding.path == null ? {} : { path: finding.path }),
      ...(finding.line == null ? {} : { line: finding.line }),
    }));
}

function reviewSummary(review) {
  const currentSnapshot = review.rounds.at(-1) ?? null;
  const activeFindings = review.findings.filter(
    (finding) => !RESOLVED_FINDING_STATUSES.has(finding.status),
  );
  return {
    id: review.id,
    status: review.status,
    created_at: review.created_at,
    updated_at: review.updated_at,
    state_version: review.state_version ?? 0,
    current_round: review.current_round,
    max_rounds: review.max_rounds,
    action_required: actionRequired(review.status, isAdvisory(review)),
    reviewer_provider: reviewerProviderFor(review),
    advisory: isAdvisory(review),
    review_strategy: review.review_strategy ?? {
      mode: "FULL",
      parent_review_id: null,
      fallback_reason: null,
      parent_selection: "NONE",
    },
    current_snapshot:
      currentSnapshot == null
        ? null
        : {
            round: currentSnapshot.round,
            base_sha: currentSnapshot.base_sha,
            head_sha: currentSnapshot.head_sha,
            snapshot_hash: currentSnapshot.snapshot_hash,
            // Equal hashes prove two snapshots are the same bytes, not that
            // those bytes are the committed head: preparations that all capture
            // one dirty worktree agree with each other. A caller comparing
            // snapshots before dispatch needs both, so the flag travels with
            // the hash. A round that records none reads as dirty, which refuses
            // rather than admits.
            worktree_clean: currentSnapshot.worktree_clean === true,
            changed_file_count: currentSnapshot.changed_files.length,
            deleted_file_count: currentSnapshot.deleted_files.length,
            overlay_count: currentSnapshot.overlays.length,
            patch_bytes: currentSnapshot.patch_bytes,
            change_size: changeSizeReport(currentSnapshot.change_size),
          },
    findings: {
      total: review.findings.length,
      active: activeFindings.length,
      total_by_severity: countBy(
        review.findings.map((finding) => finding.severity),
      ),
      active_by_severity: countBy(
        activeFindings.map((finding) => finding.severity),
      ),
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

// Candidate parents for an unattended successor review. Selection is a filter,
// not a guess: a candidate must already be LOCAL_GATE_PASSED for the same
// repository, base SHA, and requirement, and its gated head must be a strict
// ancestor of the head being captured. Every candidate is still put through the
// full successor proof in buildSuccessorArtifacts before it is used.
async function automaticParentCandidates(storeRoot, { manifest, requirement }) {
  const reviewsRoot = path.join(storeRoot, "reviews");
  let entries;
  try {
    entries = await fsp.readdir(reviewsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  // Linked worktrees of one repository have distinct working-directory paths,
  // so candidates are matched on the shared Git repository identity, the same
  // comparison the successor proof itself uses.
  let currentIdentity;
  try {
    currentIdentity = await repositoryIdentity(manifest.repository_path);
  } catch {
    return [];
  }
  const identityCache = new Map([[manifest.repository_path, currentIdentity]]);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    let review;
    try {
      review = await loadReview(storeRoot, entry.name);
    } catch {
      continue;
    }
    if (
      review.status !== "LOCAL_GATE_PASSED" ||
      !Array.isArray(review.rounds)
    ) {
      continue;
    }
    let identity = identityCache.get(review.repository_path);
    if (identity === undefined) {
      try {
        identity = await repositoryIdentity(review.repository_path);
      } catch {
        identity = null;
      }
      identityCache.set(review.repository_path, identity);
    }
    if (identity == null || identity !== currentIdentity) {
      continue;
    }
    const cleanRound = review.rounds.find(
      (round) => round?.snapshot_hash === review.clean_snapshot_hash,
    );
    if (
      !cleanRound ||
      cleanRound.base_sha !== manifest.base_sha ||
      cleanRound.head_sha === manifest.head_sha ||
      cleanRound.worktree_clean !== true
    ) {
      continue;
    }
    const ancestry = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", cleanRound.head_sha, manifest.head_sha],
      {
        cwd: manifest.repository_path,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    if (ancestry.error || ancestry.status !== 0) {
      continue;
    }
    // Rank by how far the gated head is behind the current head. Gate
    // chronology cannot stand in for this: gates land out of commit order
    // across linked worktrees, and a farther parent means a delta that
    // re-includes already-reviewed commits.
    const distanceResult = spawnSync(
      "git",
      [
        "rev-list",
        "--count",
        `${cleanRound.head_sha}..${manifest.head_sha}`,
      ],
      {
        cwd: manifest.repository_path,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const distance = Number(distanceResult.stdout?.trim());
    if (
      distanceResult.error ||
      distanceResult.status !== 0 ||
      !Number.isSafeInteger(distance)
    ) {
      continue;
    }
    // Candidates travel as their validated directory names, never as the
    // ledger's internal id: a corrupted stored id would otherwise throw in
    // the successor proof and abort preparation outright, instead of being
    // rejected by the proof's own id-mismatch fallback.
    candidates.push({ id: entry.name, review, distance });
  }
  // Prefer a parent gated for the same stated requirement, then the nearest
  // gated ancestor — the smallest delta — with gate recency only as a tie
  // break between equally near heads.
  return candidates
    .sort((a, b) => {
      const aMatch = a.review.requirement === requirement ? 0 : 1;
      const bMatch = b.review.requirement === requirement ? 0 : 1;
      return (
        aMatch - bMatch ||
        a.distance - b.distance ||
        String(b.review.updated_at ?? "").localeCompare(
          String(a.review.updated_at ?? ""),
        )
      );
    })
    .slice(0, MAX_AUTOMATIC_PARENT_CANDIDATES)
    .map((candidate) => candidate.id);
}

async function resolveReviewStrategy({
  storeRoot,
  parentReviewId,
  forceFullReview,
  repositoryPath,
  requirement,
  manifest,
  roundRoot,
}) {
  if (forceFullReview) {
    return {
      strategy: {
        mode: "FULL",
        parent_review_id: null,
        fallback_reason: "full review requested by the author",
        parent_selection: "NONE",
      },
      successor: null,
    };
  }
  if (parentReviewId != null) {
    const explicit = await buildSuccessorArtifacts({
      storeRoot,
      parentReviewId,
      repositoryPath,
      requirement,
      manifest,
      roundRoot,
    });
    return {
      ...explicit,
      strategy: { ...explicit.strategy, parent_selection: "EXPLICIT" },
    };
  }
  const candidates = await automaticParentCandidates(storeRoot, {
    manifest,
    requirement,
  });
  let lastFallbackReason = null;
  for (const candidate of candidates) {
    const result = await buildSuccessorArtifacts({
      storeRoot,
      parentReviewId: candidate,
      repositoryPath,
      requirement,
      manifest,
      roundRoot,
      requireRequirementMatch: false,
    });
    if (result.strategy.mode === "SUCCESSOR") {
      return {
        ...result,
        strategy: { ...result.strategy, parent_selection: "AUTOMATIC" },
      };
    }
    lastFallbackReason = `${candidate}: ${result.strategy.fallback_reason}`;
  }
  return {
    strategy: {
      mode: "FULL",
      parent_review_id: null,
      fallback_reason:
        lastFallbackReason == null
          ? null
          : `no verifiable parent (${lastFallbackReason})`,
      parent_selection: "NONE",
    },
    successor: null,
  };
}

export async function prepareReview(
  storeRoot,
  {
    repositoryPath,
    baseRef,
    requirement,
    implementationScope,
    parentReviewId = null,
    forceFullReview = false,
    continuedFromReviewId = null,
    reviewerProvider = "CLAUDE_DESKTOP",
    advisory = false,
  },
) {
  assertString(baseRef, "base_ref", { max: 1024 });
  assertString(requirement, "requirement");
  assertString(implementationScope, "implementation_scope");
  if (parentReviewId != null) {
    assertReviewId(parentReviewId);
  }
  if (continuedFromReviewId != null) {
    assertReviewId(continuedFromReviewId);
    if (!forceFullReview) {
      throw new Error("continued review must set force_full_review");
    }
    if (parentReviewId != null) {
      throw new Error("continued review cannot set parent_review_id");
    }
  }
  assertReviewerProvider(reviewerProvider);
  // Anything but a boolean is refused rather than read as false: a mode whose
  // whole purpose is to close the gate must never be switched off by a typo.
  if (typeof advisory !== "boolean") {
    throw new Error("advisory must be a boolean");
  }
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const continuedReview =
    continuedFromReviewId == null
      ? null
      : await loadReview(storeRoot, continuedFromReviewId);
  if (
    continuedReview != null &&
    (continuedReview.status !== "CONTINUABLE_FINDINGS" ||
      continuedReview.repository_path !== repositoryRoot ||
      continuedReview.requirement !== requirement ||
      continuedReview.implementation_scope !== implementationScope ||
      reviewerProviderFor(continuedReview) !== reviewerProvider)
  ) {
    throw new Error(
      "continued review does not match the repository, requirement, provider, base, scope, and continuable state",
    );
  }
  const carriedFindings =
    continuedReview == null ? [] : continuationFindings(continuedReview);
  if (continuedReview != null && carriedFindings.length === 0) {
    throw new Error("continued review has no open findings");
  }
  const id = createReviewId();
  const root = reviewDirectory(storeRoot, id);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  return withReviewMutationLock(storeRoot, id, async () => {
    const roundRoot = roundDirectory(storeRoot, id, 1);
    const { manifest } = await buildSnapshot({
      repositoryPath,
      baseRef,
      requirement,
      implementationScope,
      roundRoot,
      writeFiles: true,
    });
    if (
      continuedReview != null &&
      manifest.base_sha !== continuedReview.rounds[0]?.base_sha
    ) {
      throw new Error("continued review must preserve the immutable source base");
    }
    if (
      continuedReview != null &&
      manifest.head_sha === continuedReview.rounds.at(-1)?.head_sha
    ) {
      throw new Error("continued review head must change");
    }
    if (continuedReview != null) {
      const sourceHead = continuedReview.rounds.at(-1)?.head_sha;
      const ancestry = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", sourceHead, manifest.head_sha],
        {
          cwd: manifest.repository_path,
          encoding: "utf8",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
      );
      if (ancestry.error || ancestry.status !== 0) {
        throw new Error("continued review head must descend from the source head");
      }
    }
    const successorResult = await resolveReviewStrategy({
      storeRoot,
      parentReviewId,
      forceFullReview,
      repositoryPath: manifest.repository_path,
      requirement,
      manifest,
      roundRoot,
    });
    const timestamp = now();
    const review = {
      version: 1,
      id,
      created_at: timestamp,
      updated_at: timestamp,
      state_version: 1,
      repository_path: manifest.repository_path,
      base_ref: baseRef,
      requirement,
      implementation_scope: implementationScope,
      reviewer_provider: reviewerProvider,
      advisory,
      review_strategy: successorResult.strategy,
      status: "WAITING_FOR_REVIEW",
      current_round: 1,
      max_rounds: MAX_ROUNDS,
      rounds: [{ round: 1, ...manifest, successor: successorResult.successor }],
      findings: [],
      resolutions: [],
      rereview_decisions: [],
      carried_findings: carriedFindings,
      history: [
        {
          at: timestamp,
          event: "REVIEW_PREPARED",
          round: 1,
          mode: successorResult.strategy.mode,
        },
      ],
    };
    await atomicWriteJson(reviewFile(storeRoot, review.id), review);
    return publicReview(review);
  }, { allowMissing: true });
}

export async function listReviews(
  storeRoot,
  statuses = null,
  reviewerProvider = null,
) {
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
  const providerFilter =
    reviewerProvider == null ? null : assertReviewerProvider(reviewerProvider);
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const review = await loadReview(storeRoot, entry.name);
      if (
        (!statusSet || statusSet.has(review.status)) &&
        (providerFilter == null ||
          reviewerProviderFor(review) === providerFilter)
      ) {
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

export async function getReviewSnapshot(storeRoot, reviewId, operation = null) {
  return withReviewMutationLock(storeRoot, reviewId, async () => {
    const review = await loadReview(storeRoot, reviewId);
    const round = review.rounds?.find(
      (entry) => entry.round === review.current_round,
    );
    if (round == null) {
      throw new Error("current review round is missing from its ledger");
    }
    const patch = await fsp.readFile(
      path.join(roundDirectory(storeRoot, reviewId, round.round), "patch.diff"),
    );
    const snapshotHash = await snapshotHashFromReviewRound(
      storeRoot,
      reviewId,
      review,
      round,
      patch,
    );
    if (snapshotHash !== round.snapshot_hash) {
      throw new Error("stored review patch does not match its snapshot commitment");
    }
    if (round.change_size == null) {
      round.change_size = patchChangeSize(patch);
    }
    const snapshot = {
      review: publicReview(review),
      summary: reviewSummary(review),
    };
    return operation == null ? snapshot : operation(snapshot);
  });
}

function arbitrationFinding(
  finding,
  resolutionsByFinding,
  decisionsByFinding,
) {
  return {
    finding,
    author_resolution: resolutionsByFinding.get(finding.id) ?? null,
    rereview_decision: decisionsByFinding.get(finding.id) ?? null,
  };
}

function markdownLiteral(value) {
  return String(value)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function prettySortedJson(value) {
  return JSON.stringify(
    value,
    (_key, current) =>
      current && typeof current === "object" && !Array.isArray(current)
        ? Object.fromEntries(
            Object.keys(current)
              .sort()
              .map((key) => [key, current[key]]),
          )
        : current,
    2,
  );
}

function renderHumanArbitrationMarkdown(arbitration) {
  return `${[
    "# Human Arbitration Packet",
    "> This is a read-only export of the canonical Review Bridge ledger. It does not change review state or authorize publication.",
    "Decide whether each active finding should be upheld or overruled. Resolved findings are context only and must not be treated as open.",
    "## Review identity",
    [
      `- Review ID: \`${arbitration.review_id}\``,
      `- State: \`${arbitration.status}\``,
      `- State version: ${arbitration.state_version}`,
      `- Reviewer provider: \`${arbitration.reviewer_provider}\``,
      `- Review strategy: \`${arbitration.review_strategy.mode}\``,
      `- Current round: ${arbitration.current_round} of ${arbitration.max_rounds}`,
    ].join("\n"),
    "## Requirement",
    markdownLiteral(arbitration.requirement),
    "## Implementation scope",
    markdownLiteral(arbitration.implementation_scope),
    "## Immutable snapshot identity",
    markdownLiteral(prettySortedJson(arbitration.snapshots)),
    "## Why human arbitration is required",
    arbitration.human_required_reason == null
      ? "No reason was recorded."
      : markdownLiteral(prettySortedJson(arbitration.human_required_reason)),
    `## Active findings (${arbitration.active_findings.length})`,
    markdownLiteral(prettySortedJson(arbitration.active_findings)),
    `## Resolved findings (${arbitration.resolved_findings.length})`,
    markdownLiteral(prettySortedJson(arbitration.resolved_findings)),
  ].join("\n\n")}\n`;
}

export async function exportHumanArbitration(
  storeRoot,
  reviewId,
  expectedStateVersion,
) {
  if (
    !Number.isSafeInteger(expectedStateVersion) ||
    expectedStateVersion < 0
  ) {
    throw new Error(
      "expected_state_version must be a non-negative safe integer",
    );
  }
  const review = await loadReview(storeRoot, reviewId);
  const stateVersion = review.state_version ?? 0;
  if (stateVersion !== expectedStateVersion) {
    throw new Error(
      `review state_version mismatch (expected=${expectedStateVersion}, actual=${stateVersion})`,
    );
  }
  if (review.status !== "HUMAN_REQUIRED") {
    throw new Error(
      `review does not require human arbitration (status=${review.status})`,
    );
  }

  const resolutionsByFinding = new Map(
    review.resolutions.map((resolution) => [
      resolution.finding_id,
      resolution,
    ]),
  );
  const decisionsByFinding = new Map(
    review.rereview_decisions.map((decision) => [
      decision.finding_id,
      decision,
    ]),
  );
  const findings = review.findings.map((finding) =>
    arbitrationFinding(finding, resolutionsByFinding, decisionsByFinding),
  );
  const humanRequiredEvents = new Set([
    "AUTHOR_ESCALATED",
    "ROUND_LIMIT_REACHED",
    "REREVIEW_UNRESOLVED",
  ]);
  const humanRequiredReason =
    [...review.history]
      .reverse()
      .find((event) => humanRequiredEvents.has(event.event)) ??
    review.history.at(-1) ??
    null;
  const arbitration = {
    schema_version: 1,
    review_id: review.id,
    status: review.status,
    state_version: stateVersion,
    reviewer_provider: reviewerProviderFor(review),
    review_strategy: review.review_strategy ?? {
      mode: "FULL",
      parent_review_id: null,
      fallback_reason: null,
      parent_selection: "NONE",
    },
    requirement: review.requirement,
    implementation_scope: review.implementation_scope,
    current_round: review.current_round,
    max_rounds: review.max_rounds,
    snapshots: review.rounds.map((round) => ({
      round: round.round,
      base_sha: round.base_sha,
      head_sha: round.head_sha,
      snapshot_hash: round.snapshot_hash,
    })),
    human_required_reason: humanRequiredReason,
    active_findings: findings.filter(
      ({ finding }) => !RESOLVED_FINDING_STATUSES.has(finding.status),
    ),
    resolved_findings: findings.filter(({ finding }) =>
      RESOLVED_FINDING_STATUSES.has(finding.status),
    ),
  };
  return {
    arbitration,
    markdown: renderHumanArbitrationMarkdown(arbitration),
  };
}

export async function waitForReviewState(
  storeRoot,
  reviewId,
  knownStateVersion,
  timeoutMs = 25_000,
) {
  if (
    !Number.isSafeInteger(knownStateVersion) ||
    knownStateVersion < 0
  ) {
    throw new Error("known_state_version must be a non-negative safe integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("timeout_ms must be between 1 and 30000");
  }
  const deadline = Date.now() + timeoutMs;
  let review = await loadReview(storeRoot, reviewId);
  while ((review.state_version ?? 0) === knownStateVersion) {
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

export async function submitInitialReview(
  storeRoot,
  reviewId,
  findingsInput,
  reviewerProvider = "CLAUDE_DESKTOP",
) {
  return withReviewMutationLock(storeRoot, reviewId, () =>
    submitInitialReviewWhileLocked(
      storeRoot,
      reviewId,
      findingsInput,
      reviewerProvider,
    ),
  );
}

async function submitInitialReviewWhileLocked(
  storeRoot,
  reviewId,
  findingsInput,
  reviewerProvider,
) {
  const review = await loadReview(storeRoot, reviewId);
  requireReviewerProvider(review, reviewerProvider);
  if (review.status !== "WAITING_FOR_REVIEW" || review.current_round !== 1) {
    throw new Error(
      `review is not waiting for its initial review (status=${review.status})`,
    );
  }
  if (!Array.isArray(findingsInput) || findingsInput.length > MAX_FINDINGS) {
    throw new Error(
      `findings must be an array with at most ${MAX_FINDINGS} items`,
    );
  }
  const findings = findingsInput.map((finding, index) =>
    normalizeFinding(finding, `F-${String(index + 1).padStart(3, "0")}`, 1),
  );
  review.findings = findings;
  if (findings.length === 0) {
    await verifySuccessorArtifacts(storeRoot, reviewId, review.rounds[0]);
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
  return withReviewMutationLock(storeRoot, reviewId, () =>
    submitResolutionsWhileLocked(storeRoot, reviewId, inputs),
  );
}

async function submitResolutionsWhileLocked(storeRoot, reviewId, inputs) {
  const review = await loadReview(storeRoot, reviewId);
  assertNotAdvisory(
    review,
    "an advisory review has no author loop: its findings are reported to the external author on GitHub, outside this protocol, and no resolution recorded here would answer for their code",
  );
  if (review.status !== "REVIEW_SUBMITTED") {
    throw new Error(
      `review is not waiting for author resolutions (status=${review.status})`,
    );
  }
  if (!Array.isArray(inputs)) {
    throw new Error("resolutions must be an array");
  }
  const openFindings = review.findings.filter(
    (finding) => finding.status === "OPEN",
  );
  const byId = new Map(inputs.map((item) => [item?.finding_id, item]));
  if (
    byId.size !== openFindings.length ||
    inputs.length !== openFindings.length
  ) {
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
      throw new Error(
        "resolution disposition must be fixed, rejected, or human_required",
      );
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
  return withReviewMutationLock(storeRoot, reviewId, () =>
    prepareRereviewWhileLocked(storeRoot, reviewId),
  );
}

async function prepareRereviewWhileLocked(storeRoot, reviewId) {
  const review = await loadReview(storeRoot, reviewId);
  assertNotAdvisory(
    review,
    "an advisory review is a single round by design: a new push to the pull request is a new panel, not a second round on this review",
  );
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
  const roundRoot = roundDirectory(storeRoot, review.id, round);
  const { manifest } = await buildSnapshot({
    repositoryPath: review.repository_path,
    baseRef: review.base_ref,
    requirement: review.requirement,
    implementationScope: review.implementation_scope,
    roundRoot,
    writeFiles: true,
  });
  const successorResult =
    review.review_strategy?.mode === "SUCCESSOR"
      ? await (async () => {
          const rebuilt = await buildSuccessorArtifacts({
            storeRoot,
            parentReviewId: review.review_strategy.parent_review_id,
            repositoryPath: manifest.repository_path,
            requirement: review.requirement,
            manifest,
            roundRoot,
            requireRequirementMatch:
              review.review_strategy.parent_selection !== "AUTOMATIC",
          });
          return {
            ...rebuilt,
            strategy: {
              ...rebuilt.strategy,
              parent_selection:
                review.review_strategy.parent_selection ?? "EXPLICIT",
            },
          };
        })()
      : {
          strategy: review.review_strategy ?? {
            mode: "FULL",
            parent_review_id: null,
            fallback_reason: null,
            parent_selection: "NONE",
          },
          successor: null,
        };
  review.current_round = round;
  review.rounds.push({
    round,
    ...manifest,
    successor: successorResult.successor,
  });
  review.review_strategy = successorResult.strategy;
  review.status = "WAITING_FOR_REREVIEW";
  review.history.push({
    at: now(),
    event: "REREVIEW_PREPARED",
    round,
    mode: successorResult.strategy.mode,
  });
  await saveReview(storeRoot, review);
  return publicReview(review);
}

export async function submitRereview(
  storeRoot,
  reviewId,
  decisionInputs,
  newFindingInputs,
  reviewerProvider = "CLAUDE_DESKTOP",
) {
  return withReviewMutationLock(storeRoot, reviewId, () =>
    submitRereviewWhileLocked(
      storeRoot,
      reviewId,
      decisionInputs,
      newFindingInputs,
      reviewerProvider,
    ),
  );
}

async function submitRereviewWhileLocked(
  storeRoot,
  reviewId,
  decisionInputs,
  newFindingInputs,
  reviewerProvider,
) {
  const review = await loadReview(storeRoot, reviewId);
  requireReviewerProvider(review, reviewerProvider);
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
  let contested = false;
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
    const rationale = assertString(input.rationale, "decision.rationale", {
      max: 20_000,
    });
    const verification =
      decision === "rebuttal_accepted"
        ? assertString(input.verification, "decision.verification", {
            max: 20_000,
          })
        : typeof input.verification === "string"
          ? assertString(input.verification, "decision.verification", {
              max: 20_000,
            })
          : "";
    const record = {
      finding_id: finding.id,
      decision,
      rationale,
      verification,
      submitted_at: now(),
    };
    review.rereview_decisions.push(record);
    if (decision === "resolved") {
      finding.status = "RESOLVED";
    } else if (decision === "rebuttal_accepted") {
      finding.status = "REBUTTAL_ACCEPTED";
    } else {
      finding.status = "STILL_OPEN";
      contested = true;
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
  if (contested) {
    review.status = "HUMAN_REQUIRED";
    review.history.push({
      at: now(),
      event: "REREVIEW_UNRESOLVED",
      round: review.current_round,
      new_findings: newFindings.length,
    });
  } else if (newFindings.length > 0) {
    review.status = "CONTINUABLE_FINDINGS";
    review.history.push({
      at: now(),
      event: "REREVIEW_CONTINUABLE_FINDINGS",
      round: review.current_round,
      new_findings: newFindings.length,
    });
  } else {
    await verifySuccessorArtifacts(
      storeRoot,
      reviewId,
      review.rounds[review.rounds.length - 1],
    );
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
  return withReviewMutationLock(storeRoot, reviewId, () =>
    finalizeLocalGateWhileLocked(storeRoot, reviewId),
  );
}

async function finalizeLocalGateWhileLocked(storeRoot, reviewId) {
  const review = await loadReview(storeRoot, reviewId);
  assertNotAdvisory(
    review,
    "an advisory review is a report, not a gate: it can never attest LOCAL_GATE_PASSED for code this operator did not author",
  );
  if (review.status !== "CLEAN") {
    throw new Error(`only a CLEAN review can be finalized (status=${review.status})`);
  }
  const cleanRound = review.rounds.find(
    (round) => round.snapshot_hash === review.clean_snapshot_hash,
  );
  if (!cleanRound) {
    throw new Error("clean snapshot is not present in the review ledger");
  }
  await verifySuccessorArtifacts(storeRoot, reviewId, cleanRound);
  // The gate attests the snapshot the reviewer actually saw, so the stored
  // patch must still reproduce the committed hash — not merely the right
  // byte length — before the live worktree is compared against it.
  const storedHash = await snapshotHashFromReviewRound(
    storeRoot,
    reviewId,
    review,
    cleanRound,
  );
  if (storedHash !== review.clean_snapshot_hash) {
    throw new Error(
      "stored review patch does not match its snapshot commitment",
    );
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
    reviewer_provider: reviewerProviderFor(review),
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
  reviewerProvider = "CLAUDE_DESKTOP",
) {
  assertReviewId(reviewId);
  if (
    ![
      "successor.diff",
      "successor.json",
      "patch.diff",
      "manifest.json",
    ].includes(artifact)
  ) {
    throw new Error(
      "artifact must be successor.diff, successor.json, patch.diff, or manifest.json",
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_BYTES) {
    throw new Error(`limit must be between 1 and ${MAX_READ_BYTES}`);
  }
  const review = await loadReview(storeRoot, reviewId);
  requireReviewerProvider(review, reviewerProvider);
  const selectedRound = findRound(review, round);
  if (artifact.startsWith("successor.") && selectedRound.successor == null) {
    throw new Error("successor artifact is not available for this review round");
  }
  const verifiedSuccessorArtifacts = artifact.startsWith("successor.")
    ? await verifySuccessorArtifacts(storeRoot, reviewId, selectedRound)
    : null;
  const filePath = path.join(roundDirectory(storeRoot, reviewId, round), artifact);
  const content =
    verifiedSuccessorArtifacts?.[artifact] ?? (await fsp.readFile(filePath));
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
  reviewerProvider = "CLAUDE_DESKTOP",
) {
  const review = await loadReview(storeRoot, reviewId);
  requireReviewerProvider(review, reviewerProvider);
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
  reviewerProvider = "CLAUDE_DESKTOP",
) {
  assertString(pattern, "pattern", { max: 1000 });
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
    throw new Error("max_results must be between 1 and 500");
  }
  const review = await loadReview(storeRoot, reviewId);
  requireReviewerProvider(review, reviewerProvider);
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

function roundDescriptor(round) {
  return {
    round: round.round,
    base_sha: round.base_sha,
    head_sha: round.head_sha,
    snapshot_hash: round.snapshot_hash,
    changed_file_count: round.changed_files.length,
    deleted_file_count: round.deleted_files.length,
    overlay_count: round.overlays.length,
    patch_bytes: round.patch_bytes,
    change_size: changeSizeReport(round.change_size),
    worktree_clean: round.worktree_clean,
    successor:
      round.successor == null
        ? null
        : {
            parent_review_id: round.successor.parent_review_id,
            delta_bytes: round.successor.delta_bytes,
            changed_file_count: round.successor.changed_files.length,
          },
  };
}

// The index is always derived, on demand, from the same immutable patch.diff
// the reviewer reads — never from the mutable review ledger. Deriving both
// from one file makes it structurally impossible for a tampered index to hide
// content the artifact read would return; a stored index would have to be
// separately verified, and it sits outside the snapshot commitment. Before
// the index is served, the patch bytes must also reproduce the round's
// committed snapshot_hash — a same-length corruption would otherwise shift
// which sections the index recognizes. Any failure yields no index at all,
// and the reviewer instructions then require reading the whole patch.
async function patchIndexForRound(storeRoot, reviewId, review, round) {
  try {
    const patch = await fsp.readFile(
      path.join(roundDirectory(storeRoot, reviewId, round.round), "patch.diff"),
    );
    const snapshotHash = await snapshotHashFromReviewRound(
      storeRoot,
      reviewId,
      review,
      round,
      patch,
    );
    if (snapshotHash !== round.snapshot_hash) {
      return { entries: null, truncated: false };
    }
    return buildPatchIndex(patch);
  } catch {
    return { entries: null, truncated: false };
  }
}

export async function openReview(
  storeRoot,
  reviewId,
  reviewerProvider = "CLAUDE_DESKTOP",
) {
  const review = await loadReview(storeRoot, reviewId);
  requireReviewerProvider(review, reviewerProvider);
  const current = findRound(review, review.current_round);
  const patchIndex = await patchIndexForRound(
    storeRoot,
    review.id,
    review,
    current,
  );
  const { rounds, ...rest } = publicReview(review);
  return {
    ...rest,
    rounds: rounds.map(roundDescriptor),
    current_snapshot: {
      ...current,
      patch_index: patchIndex.entries,
      patch_index_truncated: patchIndex.truncated,
    },
    artifacts: [
      ...(current.successor == null
        ? []
        : [
            {
              name: "successor.diff",
              round: review.current_round,
              bytes: current.successor.delta_bytes,
            },
            { name: "successor.json", round: review.current_round },
          ]),
      {
        name: "patch.diff",
        round: review.current_round,
        bytes: current.patch_bytes,
      },
      { name: "manifest.json", round: review.current_round },
    ],
  };
}
