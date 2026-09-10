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
import { reviewRequiredInputs } from "./tool-inputs.mjs";

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
const MAX_ERRATA = 100;
const MAX_ERRATUM_TEXT = 20_000;
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

const LEDGER_REVIEW_STATUSES = [
  "WAITING_FOR_REVIEW",
  "REVIEW_SUBMITTED",
  "AUTHOR_RESPONDED",
  "WAITING_FOR_REREVIEW",
  "CLEAN",
  "LOCAL_GATE_PASSED",
  "HUMAN_REQUIRED",
  "CONTINUABLE_FINDINGS",
];
const LEDGER_FINDING_STATUSES = [
  "OPEN",
  "AUTHOR_FIXED",
  "AUTHOR_REJECTED",
  "HUMAN_REQUIRED",
  "RESOLVED",
  "REBUTTAL_ACCEPTED",
  "STILL_OPEN",
];
const LEDGER_DISPOSITIONS = ["fixed", "rejected", "human_required"];
const LEDGER_DECISIONS = ["resolved", "rebuttal_accepted", "still_open"];

// Field tables. Every record kind the review ledger holds has one, placed
// beside the writer that produces it: one entry per field the writer sets,
// with the type, value domain, length bound, timestamp format, or reference
// into the ledger the writer guarantees. The validator checks a record from
// its table and nowhere else, so what the writer sets is what the validator
// checks: a field the writer never sets is refused, a required field that is
// missing is refused, and a field outside its domain is refused by name.
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REVIEW_ID_LEDGER_PATTERN = /^rb-[0-9TZ-]+-[a-f0-9]{8}$/;
const isTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isText = (max, { allowEmpty = false } = {}) => (value) =>
  typeof value === "string" && (allowEmpty || value !== "") && value.length <= max;
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isSha = (value) => SHA_PATTERN.test(value ?? "");
const isDigest = (value) => DIGEST_PATTERN.test(value ?? "");
const isReviewIdValue = (value) => typeof value === "string" && REVIEW_ID_LEDGER_PATTERN.test(value);
const nullOr = (ok) => (value, context) => value === null || ok(value, context);
const oneOf = (values) => (value) => values.includes(value);

// The first way `record` departs from `fields`, named after `label`, or null.
function recordDefect(record, fields, context, label) {
  if (record == null || typeof record !== "object" || Array.isArray(record)) {
    return `${label} is not an object`;
  }
  const known = new Set(fields.map((entry) => entry.field));
  const unknown = Object.keys(record).find((key) => !known.has(key));
  if (unknown != null) {
    return `${label} carries a field the writer never sets: ${unknown}`;
  }
  for (const { field, describe, optional, ok } of fields) {
    if (!(field in record)) {
      if (optional) continue;
      return `${label} has no ${field}`;
    }
    if (!ok(record[field], { ...context, record })) {
      return `${label} ${field} ${JSON.stringify(record[field])} is not ${describe}`;
    }
  }
  return null;
}

// The review strategy prepareReview and prepareRereview record.
const STRATEGY_FIELDS = [
  { field: "mode", describe: "FULL or SUCCESSOR", ok: oneOf(["FULL", "SUCCESSOR"]) },
  { field: "parent_review_id", describe: "null or a review ID", ok: nullOr(isReviewIdValue) },
  { field: "fallback_reason", describe: "null or a string", ok: nullOr((value) => typeof value === "string") },
  { field: "parent_selection", describe: "NONE, EXPLICIT, or AUTOMATIC", optional: true, ok: oneOf(["NONE", "EXPLICIT", "AUTOMATIC"]) },
];

// The history events the writers push, keyed by event: the fields each
// writer records beyond `at` and `event`. Fields that arrived with a later
// release are optional, so a ledger written before them still validates.
const HISTORY_EVENT_FIELDS = {
  REVIEW_PREPARED: [
    { field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
    { field: "mode", describe: "FULL or SUCCESSOR", optional: true, ok: oneOf(["FULL", "SUCCESSOR"]) },
  ],
  INITIAL_REVIEW_CLEAN: [
    { field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
    { field: "errata_watermark", describe: "a non-negative integer", optional: true, ok: isCount },
  ],
  FINDINGS_SUBMITTED: [
    { field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
    { field: "count", describe: "a non-negative integer", optional: true, ok: isCount },
    { field: "errata_watermark", describe: "a non-negative integer", optional: true, ok: isCount },
  ],
  AUTHOR_RESPONDED: [{ field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 }],
  AUTHOR_ESCALATED: [{ field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 }],
  ERRATUM_APPENDED: [
    { field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
    { field: "sequence", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
  ],
  ROUND_LIMIT_REACHED: [],
  REREVIEW_PREPARED: [
    { field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
    { field: "mode", describe: "FULL or SUCCESSOR", optional: true, ok: oneOf(["FULL", "SUCCESSOR"]) },
  ],
  REREVIEW_UNRESOLVED: [
    { field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
    { field: "new_findings", describe: "a non-negative integer", optional: true, ok: isCount },
    { field: "errata_watermark", describe: "a non-negative integer", optional: true, ok: isCount },
  ],
  REREVIEW_CONTINUABLE_FINDINGS: [
    { field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
    { field: "new_findings", describe: "a non-negative integer", optional: true, ok: isCount },
    { field: "errata_watermark", describe: "a non-negative integer", optional: true, ok: isCount },
  ],
  REREVIEW_CLEAN: [
    { field: "round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
    { field: "errata_watermark", describe: "a non-negative integer", optional: true, ok: isCount },
  ],
  LOCAL_GATE_PASSED: [],
  REVIEW_CONTINUED: [{ field: "continued_by_review_id", describe: "a review ID", ok: isReviewIdValue }],
};
const HISTORY_COMMON_FIELDS = [
  { field: "at", describe: "a timestamp", ok: isTimestamp },
  { field: "event", describe: "a history event the writers record", ok: (v) => v in HISTORY_EVENT_FIELDS },
];

// The top-level ledger prepareReview writes and the later writers update.
// Fields that arrived with a later release are optional.
const REVIEW_LEDGER_FIELDS = [
  { field: "version", describe: "1", ok: (v) => v === 1 },
  { field: "id", describe: "a review ID", ok: isReviewIdValue },
  { field: "created_at", describe: "a timestamp", ok: isTimestamp },
  { field: "updated_at", describe: "a timestamp", ok: isTimestamp },
  { field: "state_version", describe: "a positive integer", optional: true, ok: (v) => Number.isInteger(v) && v >= 1 },
  { field: "last_transition_state_version", describe: "a positive integer", optional: true, ok: (v) => Number.isInteger(v) && v >= 1 },
  { field: "repository_path", describe: "a non-empty absolute path", ok: (v) => typeof v === "string" && path.isAbsolute(v) },
  { field: "base_ref", describe: "a non-empty string", ok: isText(4096) },
  { field: "requirement", describe: `a non-empty string of at most ${MAX_TEXT_FIELD} characters`, ok: isText(MAX_TEXT_FIELD) },
  { field: "implementation_scope", describe: `a non-empty string of at most ${MAX_TEXT_FIELD} characters`, ok: isText(MAX_TEXT_FIELD) },
  { field: "reviewer_provider", describe: "a reviewer provider", optional: true, ok: (v) => REVIEWER_PROVIDERS.includes(v) },
  { field: "advisory", describe: "a boolean", optional: true, ok: (v) => typeof v === "boolean" },
  { field: "review_strategy", describe: "a review strategy", optional: true, ok: (v) => recordDefect(v, STRATEGY_FIELDS, {}, "review_strategy") == null },
  { field: "status", describe: "a review status", ok: oneOf(LEDGER_REVIEW_STATUSES) },
  { field: "current_round", describe: "a positive integer", ok: (v) => Number.isInteger(v) && v >= 1 },
  { field: "max_rounds", describe: String(MAX_ROUNDS), ok: (v) => v === MAX_ROUNDS },
  { field: "rounds", describe: "an array", ok: Array.isArray },
  { field: "findings", describe: "an array", ok: Array.isArray },
  { field: "resolutions", describe: "an array", ok: Array.isArray },
  { field: "rereview_decisions", describe: "an array", ok: Array.isArray },
  { field: "errata", describe: "an array", optional: true, ok: Array.isArray },
  { field: "carried_findings", describe: "an array", optional: true, ok: Array.isArray },
  { field: "history", describe: "an array", ok: Array.isArray },
  { field: "last_opened_errata_watermark", describe: "a non-negative integer", optional: true, ok: isCount },
  { field: "clean_snapshot_hash", describe: "null or a digest", optional: true, ok: nullOr(isDigest) },
  { field: "continued_by_review_id", describe: "null or a review ID", optional: true, ok: nullOr(isReviewIdValue) },
];

// The finding status each author disposition and each rereview decision
// leaves behind. The writers below set statuses through these, and the
// validator derives the status every finding should have from the same two
// maps, so the two cannot disagree.
function dispositionStatus(disposition) {
  return { fixed: "AUTHOR_FIXED", rejected: "AUTHOR_REJECTED", human_required: "HUMAN_REQUIRED" }[disposition];
}

function decisionStatus(decision) {
  return { resolved: "RESOLVED", rebuttal_accepted: "REBUTTAL_ACCEPTED", still_open: "STILL_OPEN" }[decision];
}

// The status a finding must carry given the records that name it: OPEN with
// no response, the disposition's status once the author responded, the
// decision's status once the rereviewer decided. A decision with no
// resolution behind it derives to nothing, since no writer produces one.
function derivedFindingStatus(resolution, decision) {
  if (decision != null) return resolution == null ? null : decisionStatus(decision.decision);
  if (resolution != null) return dispositionStatus(resolution.disposition);
  return "OPEN";
}
// Every history event this module records, the statuses it is recorded from,
// the status it leaves the review in, and whether the writer always records
// the round it happened in (`roundBound`). Read from the writers above and
// below; a ledger whose history does not replay through this table was not
// written by them. `null` as a source is the ledger's creation.
const LEDGER_TRANSITIONS = {
  REVIEW_PREPARED: { from: [null], to: "WAITING_FOR_REVIEW", opensRound: true, roundBound: true },
  INITIAL_REVIEW_CLEAN: { from: ["WAITING_FOR_REVIEW"], to: "CLEAN", roundBound: true },
  FINDINGS_SUBMITTED: { from: ["WAITING_FOR_REVIEW"], to: "REVIEW_SUBMITTED", roundBound: true },
  AUTHOR_RESPONDED: { from: ["REVIEW_SUBMITTED"], to: "AUTHOR_RESPONDED", roundBound: true },
  AUTHOR_ESCALATED: { from: ["REVIEW_SUBMITTED"], to: "HUMAN_REQUIRED", roundBound: true },
  ROUND_LIMIT_REACHED: { from: ["AUTHOR_RESPONDED"], to: "HUMAN_REQUIRED" },
  REREVIEW_PREPARED: { from: ["AUTHOR_RESPONDED"], to: "WAITING_FOR_REREVIEW", opensRound: true, roundBound: true },
  REREVIEW_UNRESOLVED: { from: ["WAITING_FOR_REREVIEW"], to: "HUMAN_REQUIRED", roundBound: true },
  REREVIEW_CONTINUABLE_FINDINGS: { from: ["WAITING_FOR_REREVIEW"], to: "CONTINUABLE_FINDINGS", roundBound: true },
  REREVIEW_CLEAN: { from: ["WAITING_FOR_REREVIEW"], to: "CLEAN", roundBound: true },
  LOCAL_GATE_PASSED: { from: ["CLEAN"], to: "LOCAL_GATE_PASSED" },
  REVIEW_CONTINUED: { from: ["CONTINUABLE_FINDINGS"], to: "CONTINUABLE_FINDINGS" },
  // An erratum changes no state; it is refused only where the writer refuses
  // it, which the replay does not second-guess.
  ERRATUM_APPENDED: { from: LEDGER_REVIEW_STATUSES, to: null, roundBound: true },
};

// The round each finding position was raised in, from the history's counts,
// or null when a verdict event that should carry a count does not (a ledger
// older than the field).
function derivedIntroducedRounds(history) {
  const rounds = [];
  for (const entry of history) {
    if (entry.event === "INITIAL_REVIEW_CLEAN" || entry.event === "REREVIEW_CLEAN") continue;
    if (entry.event === "FINDINGS_SUBMITTED") {
      if (!Number.isInteger(entry.count)) return null;
      rounds.push(...Array(entry.count).fill(entry.round));
    } else if (entry.event === "REREVIEW_UNRESOLVED" || entry.event === "REREVIEW_CONTINUABLE_FINDINGS") {
      if (!Number.isInteger(entry.new_findings)) return null;
      rounds.push(...Array(entry.new_findings).fill(entry.round));
    }
  }
  return rounds;
}

// Replays the history through the transition table and returns the status
// and round it ends at, or the first defect.
function replayReviewHistory(history) {
  let status = null;
  let round = 0;
  for (const [index, entry] of history.entries()) {
    const transition = LEDGER_TRANSITIONS[entry?.event];
    if (transition == null) {
      return { defect: `history entry ${index + 1} has unknown event ${JSON.stringify(entry?.event)}` };
    }
    if (typeof entry.at !== "string") {
      return { defect: `history entry ${index + 1} has no timestamp` };
    }
    if (!transition.from.includes(status)) {
      return { defect: `history entry ${index + 1} (${entry.event}) is not a transition from ${status ?? "creation"}` };
    }
    if (transition.opensRound) round += 1;
    // A round-bound event always carries its round: a reader that pairs
    // prepared and verdict events by round finds nothing for one that lost it.
    if (transition.roundBound && !(Number.isInteger(entry.round) && entry.round >= 1)) {
      return { defect: `history entry ${index + 1} (${entry.event}) has no round` };
    }
    if (entry.round != null && entry.round !== round) {
      return { defect: `history entry ${index + 1} (${entry.event}) names round ${entry.round} during round ${round}` };
    }
    if (transition.to != null) status = transition.to;
  }
  return { status, round };
}

// The structural shape a review ledger this module wrote always has. A field
// the state machine would never produce is a ledger edited or rolled back by
// hand, and no reader that combines it with other ledgers may trust it.
function reviewLedgerDefect(review, reviewId) {
  if (review == null || typeof review !== "object" || Array.isArray(review)) {
    return "not a JSON object";
  }
  if (review.id !== reviewId) {
    return `review.json names ${JSON.stringify(review.id ?? null)}, not ${reviewId}`;
  }
  // The top level, then every record kind it holds, each from its writer's
  // own table.
  const top = recordDefect(review, REVIEW_LEDGER_FIELDS, {}, "review ledger");
  if (top != null) return top;
  if (review.review_strategy != null) {
    const defect = recordDefect(review.review_strategy, STRATEGY_FIELDS, {}, "review_strategy");
    if (defect != null) return defect;
  }
  for (const [index, entry] of review.history.entries()) {
    const label = `history entry ${index + 1}${typeof entry?.event === "string" ? ` (${entry.event})` : ""}`;
    // The event picks the table, so an unknown event is named as such rather
    // than as a stray field of an empty table.
    if (entry == null || typeof entry !== "object" || !(entry.event in HISTORY_EVENT_FIELDS)) {
      return `${label} event ${JSON.stringify(entry?.event ?? null)} is not a history event the writers record`;
    }
    const defect = recordDefect(entry, [...HISTORY_COMMON_FIELDS, ...HISTORY_EVENT_FIELDS[entry.event]], { index, review }, label);
    if (defect != null) return defect;
  }
  for (const [index, round] of review.rounds.entries()) {
    const defect = recordDefect(round, ROUND_FIELDS, { index, review }, `round ${round?.round ?? index + 1}`);
    if (defect != null) return defect;
  }
  for (const [index, resolution] of review.resolutions.entries()) {
    const defect = recordDefect(resolution, RESOLUTION_FIELDS, { index, review }, `resolution ${index + 1}`);
    if (defect != null) return defect;
  }
  for (const [index, decision] of review.rereview_decisions.entries()) {
    const defect = recordDefect(decision, REREVIEW_DECISION_FIELDS, { index, review }, `rereview decision ${index + 1}`);
    if (defect != null) return defect;
  }
  for (const [index, erratum] of (review.errata ?? []).entries()) {
    const defect = recordDefect(erratum, ERRATUM_FIELDS, { index, review }, `erratum ${index + 1}`);
    if (defect != null) return defect;
  }
  for (const [index, carried] of (review.carried_findings ?? []).entries()) {
    const defect = recordDefect(carried, CARRIED_FINDING_FIELDS, { index, review }, `carried finding ${index + 1}`);
    if (defect != null) return defect;
  }
  // Every save increments state_version and every history entry rode on a
  // save, so the version can never fall below the history; a transition
  // stamp names a version that has happened. A ledger older than the field
  // has neither to compare.
  const stateVersion = review.state_version ?? review.history.length;
  if (stateVersion < review.history.length) {
    return `state_version ${stateVersion} is below the ${review.history.length} history entries`;
  }
  if (
    review.last_transition_state_version != null &&
    review.last_transition_state_version > stateVersion
  ) {
    return "last_transition_state_version is ahead of state_version";
  }
  // The history must replay to the stored status through the writers' own
  // transitions, and must have opened exactly the rounds the ledger holds.
  const replay = replayReviewHistory(review.history);
  if (replay.defect != null) return replay.defect;
  if (replay.status !== review.status) {
    return `history replays to ${replay.status ?? "no status"}, but status is ${review.status}`;
  }
  if (replay.round !== review.rounds.length) {
    return `history opened ${replay.round} round(s), but the ledger holds ${review.rounds.length}`;
  }
  // Rounds are bounded by the store, and the current round is the last one.
  if (review.rounds.length === 0 || review.rounds.length > MAX_ROUNDS) {
    return `rounds holds ${review.rounds.length} entries`;
  }
  if (review.current_round !== review.rounds.length) {
    return `current_round ${review.current_round} does not name the last of ${review.rounds.length} rounds`;
  }
  // A clean verdict commits to the round it was given on, and only a review
  // with no finding left open can carry one.
  if (["CLEAN", "LOCAL_GATE_PASSED"].includes(review.status)) {
    if (review.clean_snapshot_hash !== review.rounds.at(-1).snapshot_hash) {
      return "clean_snapshot_hash is not the last round's snapshot";
    }
    const open = review.findings.find((finding) => !RESOLVED_FINDING_STATUSES.has(finding?.status));
    if (open != null) {
      return `status is ${review.status} but finding ${JSON.stringify(open.id)} is ${JSON.stringify(open.status)}`;
    }
  } else if (review.clean_snapshot_hash != null) {
    return `status is ${review.status} but a clean_snapshot_hash is recorded`;
  }
  // Findings from the writer's table; then the responses' identities: unique
  // IDs, and every response naming a finding that exists.
  for (const [index, finding] of review.findings.entries()) {
    const defect = findingDefect(finding, index, review);
    if (defect != null) return defect;
  }
  // Which round each finding was raised in is derived from the history's own
  // counts -- FINDINGS_SUBMITTED.count for round one, new_findings for each
  // rereview verdict, findings numbered by position -- and the whole column
  // compared with what is stored. Where an older ledger's history carries no
  // counts, the table's membership check above (a round the ledger holds) is
  // all that can be said: that is the degraded path.
  const introducedRounds = derivedIntroducedRounds(review.history);
  if (introducedRounds != null) {
    if (introducedRounds.length !== review.findings.length) {
      return `history counts ${introducedRounds.length} finding(s), but the ledger holds ${review.findings.length}`;
    }
    for (const [index, finding] of review.findings.entries()) {
      if (finding.introduced_round !== introducedRounds[index]) {
        return `finding ${JSON.stringify(finding.id)} introduced_round ${finding.introduced_round} is not the round its position derives from the history's counts (${introducedRounds[index]})`;
      }
    }
  }
  for (const [key, entries] of [
    ["finding", review.findings.map((finding) => finding.id)],
    ["resolution", review.resolutions.map((resolution) => resolution.finding_id)],
    ["rereview decision", review.rereview_decisions.map((decision) => decision.finding_id)],
  ]) {
    if (entries.some((id) => typeof id !== "string" || id === "")) return `a ${key} has no ID`;
    if (new Set(entries).size !== entries.length) return `${key} IDs are not unique`;
  }
  // Every finding's status is derived from the records that name it and the
  // whole table compared with what is stored, so a record without a finding,
  // a finding whose records were removed, and a status that does not follow
  // from its records are one and the same defect.
  const findingIds = new Set(review.findings.map((finding) => finding.id));
  for (const [key, entries] of [
    ["resolution", review.resolutions],
    ["rereview decision", review.rereview_decisions],
  ]) {
    const orphan = entries.find((entry) => !findingIds.has(entry.finding_id));
    if (orphan != null) {
      return `a ${key} names no finding: ${JSON.stringify(orphan.finding_id)}`;
    }
  }
  const resolutionByFinding = new Map(review.resolutions.map((entry) => [entry.finding_id, entry]));
  const decisionByFinding = new Map(review.rereview_decisions.map((entry) => [entry.finding_id, entry]));
  for (const finding of review.findings) {
    const derived = derivedFindingStatus(
      resolutionByFinding.get(finding.id),
      decisionByFinding.get(finding.id),
    );
    if (derived !== finding.status) {
      return `finding ${JSON.stringify(finding.id)} is ${JSON.stringify(finding.status)} but its records derive ${derived == null ? "no status (a decision with no resolution)" : JSON.stringify(derived)}`;
    }
  }
  return null;
}

// The round fields snapshotHashFromReviewRound hashes or checks the type of.
// A round lacking one is older than the function and cannot be reproduced.
const SNAPSHOT_HASH_INPUTS = [
  ["changed_files", Array.isArray],
  ["deleted_files", Array.isArray],
  ["overlays", Array.isArray],
  ["worktree_clean", (value) => typeof value === "boolean"],
  ["patch_bytes", Number.isInteger],
];

function reviewLedgerInvalid(reviewId, filePath, reason) {
  return Object.assign(new Error(`review ledger ${reviewId} is invalid: ${reason}`), {
    code: "REVIEW_LEDGER_INVALID",
    details: { review_id: reviewId, path: filePath, reason },
  });
}

// A review ledger admitted only when it is one this module could have written:
// the bytes are this module's own serialization, the shape is the state
// machine's, and every round's snapshot commitment is reproduced from the
// immutable manifest and patch beside it, the way the gate reproduces the
// clean round's. For readers that combine the review with other ledgers; the
// tools' own read path is loadReview and is unchanged.
export async function loadValidatedReview(storeRoot, reviewId) {
  assertReviewId(reviewId);
  const filePath = reviewFile(storeRoot, reviewId);
  let bytes;
  try {
    bytes = await fsp.readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw Object.assign(new Error(`review ${reviewId} not found`), {
        code: "REVIEW_NOT_FOUND",
        details: { review_id: reviewId, path: filePath },
      });
    }
    throw error;
  }
  let review;
  try {
    review = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw reviewLedgerInvalid(reviewId, filePath, `not JSON: ${error.message}`);
  }
  const defect = reviewLedgerDefect(review, reviewId);
  if (defect != null) throw reviewLedgerInvalid(reviewId, filePath, defect);
  if (bytes.toString("utf8") !== `${JSON.stringify(review, null, 2)}\n`) {
    throw reviewLedgerInvalid(reviewId, filePath, "bytes are not the store's own serialization");
  }
  for (const round of review.rounds) {
    const directory = roundDirectory(storeRoot, reviewId, round.round);
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(directory, "manifest.json"), "utf8"));
    } catch (error) {
      throw reviewLedgerInvalid(reviewId, filePath, `round ${round.round} manifest unreadable: ${error.message}`);
    }
    for (const key of Object.keys(manifest)) {
      if (!(key in round) || canonicalJson(manifest[key]) !== canonicalJson(round[key])) {
        throw reviewLedgerInvalid(reviewId, filePath, `round ${round.round} ${key} differs from its immutable manifest`);
      }
    }
    // The snapshot commitment is reproduced by the store's own function, the
    // one finalize, rereview, and the gate use. A round written before that
    // function's inputs existed -- worktree_clean above all -- cannot be
    // reproduced by the store at all, and is named as such rather than as a
    // damaged ledger; no second hash format is kept for it.
    const unreproducible = SNAPSHOT_HASH_INPUTS.filter(([field, ok]) => !ok(round[field]));
    if (unreproducible.length > 0) {
      throw Object.assign(
        new Error(
          `review ${reviewId} round ${round.round} predates ${unreproducible.map(([field]) => field).join(", ")}: the store cannot reproduce this round's snapshot hash`,
        ),
        {
          code: "ROUND_SNAPSHOT_UNREPRODUCIBLE",
          details: {
            review_id: reviewId,
            path: filePath,
            round: round.round,
            missing: unreproducible.map(([field]) => field),
            reason: "the store cannot reproduce this round's snapshot hash",
          },
        },
      );
    }
    let reproduced;
    try {
      reproduced = await snapshotHashFromReviewRound(storeRoot, reviewId, review, round);
      await verifySuccessorArtifacts(storeRoot, reviewId, round);
    } catch (error) {
      throw reviewLedgerInvalid(reviewId, filePath, `round ${round.round}: ${error.message}`);
    }
    if (reproduced !== round.snapshot_hash) {
      throw reviewLedgerInvalid(reviewId, filePath, `round ${round.round} snapshot_hash is not reproduced by its patch`);
    }
  }
  return review;
}

async function saveReview(storeRoot, review) {
  review.state_version = (review.state_version ?? 0) + 1;
  review.updated_at = now();
  await atomicWriteJson(reviewFile(storeRoot, review.id), review);
}

// A state-machine transition -- any save that changes review.status or
// advances current_round -- stamps the version it lands at, so the wait can
// tell movement from errata evidence without reconstructing history. Erratum
// appends, served-watermark recordings, and the continuation freeze save
// without the stamp.
async function saveReviewTransition(storeRoot, review) {
  review.last_transition_state_version = (review.state_version ?? 0) + 1;
  await saveReview(storeRoot, review);
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

// The successor proof buildSuccessorArtifacts writes to successor.json and
// into the round. The validator also requires the stored artifact to equal
// the round's copy byte for byte, through verifySuccessorArtifacts.
const SUCCESSOR_FIELDS = [
  { field: "version", describe: "1", ok: (v) => v === 1 },
  { field: "parent_review_id", describe: "a review ID", ok: isReviewIdValue },
  { field: "parent_reviewer_provider", describe: "a reviewer provider", ok: (v) => REVIEWER_PROVIDERS.includes(v) },
  { field: "parent_requirement", describe: "a string", optional: true, ok: (v) => typeof v === "string" },
  { field: "requirement_match", describe: "a boolean", optional: true, ok: (v) => typeof v === "boolean" },
  { field: "parent_snapshot_hash", describe: "a digest", ok: isDigest },
  { field: "parent_gate_sha256", describe: "a digest", ok: isDigest },
  { field: "base_sha", describe: "a commit", ok: isSha },
  { field: "parent_head_sha", describe: "a commit", ok: isSha },
  { field: "current_head_sha", describe: "a commit", ok: isSha },
  { field: "parent_tree_sha", describe: "a tree", ok: isSha },
  { field: "current_tree_sha", describe: "a tree", ok: isSha },
  { field: "changed_files", describe: "a list of paths", ok: isStringList },
  { field: "deleted_files", describe: "a list of paths", ok: isStringList },
  { field: "delta_bytes", describe: "a non-negative integer", ok: isCount },
  { field: "delta_sha256", describe: "a digest", ok: isDigest },
];

// The round buildSnapshot writes to manifest.json plus its position and its
// successor proof. Every manifest key is also compared with manifest.json by
// the validator. change_size arrived with a later release, so it is optional.
const ROUND_FIELDS = [
  { field: "round", describe: "the round's position", ok: (v, { index }) => v === index + 1 },
  { field: "version", describe: "1", ok: (v) => v === 1 },
  { field: "captured_at", describe: "a timestamp", ok: isTimestamp },
  { field: "repository_path", describe: "the review's repository_path", ok: (v, { review }) => v === review.repository_path },
  { field: "base_ref", describe: "the review's base_ref", ok: (v, { review }) => v === review.base_ref },
  { field: "base_sha", describe: "a commit", ok: isSha },
  { field: "head_sha", describe: "a commit", ok: isSha },
  { field: "snapshot_hash", describe: "a digest", ok: isDigest },
  { field: "changed_files", describe: "a list of paths", ok: isStringList },
  { field: "deleted_files", describe: "a list of paths", ok: isStringList },
  { field: "overlays", describe: "a list of overlay records", ok: (v) => Array.isArray(v) && v.every((o) => o != null && typeof o === "object" && typeof o.path === "string") },
  { field: "worktree_clean", describe: "a boolean", optional: true, ok: (v) => typeof v === "boolean" },
  { field: "patch_bytes", describe: "a non-negative integer", ok: isCount },
  {
    field: "change_size",
    describe: "null or {added_lines, deleted_lines, total_lines} that add up",
    optional: true,
    ok: nullOr((v) =>
      v != null && typeof v === "object" && !Array.isArray(v) &&
      Object.keys(v).every((key) => ["added_lines", "deleted_lines", "total_lines"].includes(key)) &&
      isCount(v.added_lines) && isCount(v.deleted_lines) && v.total_lines === v.added_lines + v.deleted_lines),
  },
  // Absent on rounds older than successor reviews; null on a FULL round since.
  { field: "successor", describe: "null or a successor proof", optional: true, ok: nullOr((v) => recordDefect(v, SUCCESSOR_FIELDS, {}, "successor") == null) },
];

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

// The highest erratum sequence a caller can currently see. A ledger written
// before errata existed carries no field and reads as watermark zero.
function errataWatermark(review) {
  return review.errata?.at(-1)?.sequence ?? 0;
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
    errata: review.errata ?? [],
    last_opened_errata_watermark: review.last_opened_errata_watermark ?? 0,
    last_transition_state_version: review.last_transition_state_version ?? null,
    continued_by_review_id: review.continued_by_review_id ?? null,
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

// The carried finding continuationFindings freezes into a continuation.
const CARRIED_FINDING_FIELDS = [
  { field: "continued_from_review_id", describe: "a review ID", ok: isReviewIdValue },
  { field: "finding_id", describe: "a finding ID", ok: (v) => /^F-\d{3,}$/.test(v ?? "") },
  { field: "fingerprint_sha256", describe: "a digest", ok: isDigest },
  { field: "severity", describe: "blocker, major, minor, or nit", ok: oneOf(["blocker", "major", "minor", "nit"]) },
  { field: "title", describe: "a non-empty string of at most 500 characters", ok: isText(500) },
  { field: "explanation", describe: "a non-empty string of at most 20,000 characters", ok: isText(20_000) },
  { field: "recommendation", describe: "a string of at most 20,000 characters", ok: isText(20_000, { allowEmpty: true }) },
  { field: "path", describe: "absent, or a safe relative path", optional: true, ok: (v) => { try { return safeRelativePath(v, "finding.path") === v; } catch { return false; } } },
  { field: "line", describe: "absent, or a positive integer", optional: true, ok: (v) => Number.isInteger(v) && v >= 1 },
];

// The erratum appendReviewErratum records, and the copy continuationErrata
// carries into a continuation with the source it came from.
const ERRATUM_FIELDS = [
  { field: "sequence", describe: "the erratum's position", ok: (v, { index }) => v === index + 1 },
  { field: "at", describe: "a timestamp", ok: isTimestamp },
  {
    field: "round",
    describe: "a round the ledger holds, or a positive integer for an erratum carried from a source review",
    ok: (v, { review, record }) =>
      record.continued_from_review_id != null
        ? Number.isInteger(v) && v >= 1
        : review.rounds.some((round) => round.round === v),
  },
  { field: "text", describe: `a non-empty string of at most ${MAX_ERRATUM_TEXT} characters`, ok: isText(MAX_ERRATUM_TEXT) },
  { field: "continued_from_review_id", describe: "a review ID", optional: true, ok: isReviewIdValue },
];

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

// Errata bind to the requirement text they correct, and a continuation
// carries that text verbatim, so the corrections cross with it — otherwise
// the next reviewer reads claims the author already corrected. Sequences are
// renumbered so the new ledger's watermark stays its own; the source id and
// each entry's original round and timestamp remain as provenance.
function continuationErrata(review) {
  return (review.errata ?? []).map((entry, index) => ({
    sequence: index + 1,
    at: entry.at,
    round: entry.round,
    continued_from_review_id: review.id,
    text: entry.text,
  }));
}

// A continuation freezes its source. The errata copy, the carried findings,
// the freeze marker, and its history event land in one write under the
// source's own mutation lock, so the copy cannot race a concurrent append.
// The marker is written before the continuation ledger exists, so a crash
// between the two writes fails closed: the source freezes rather than staying
// appendable beside a continuation. A source may be re-continued — a bind
// refusal, such as an unexecuted split, abandons the prepared continuation
// and a smaller one is prepared from the same source — so the marker tracks
// the newest continuation and every freeze copies under this lock again.
async function freezeContinuationSource(storeRoot, sourceReviewId, continuationId) {
  return withReviewMutationLock(storeRoot, sourceReviewId, async () => {
    const source = await loadReview(storeRoot, sourceReviewId);
    if (source.status !== "CONTINUABLE_FINDINGS") {
      throw new Error(
        "continued review does not match the repository, requirement, provider, base, scope, and continuable state",
      );
    }
    const carriedFindings = continuationFindings(source);
    if (carriedFindings.length === 0) {
      throw new Error("continued review has no open findings");
    }
    const carriedErrata = continuationErrata(source);
    source.continued_by_review_id = continuationId;
    source.history.push({
      at: now(),
      event: "REVIEW_CONTINUED",
      continued_by_review_id: continuationId,
    });
    await saveReview(storeRoot, source);
    return { carriedFindings, carriedErrata };
  });
}

function reviewSummary(review) {
  const currentSnapshot = review.rounds.at(-1) ?? null;
  const activeFindings = review.findings.filter(
    (finding) => !RESOLVED_FINDING_STATUSES.has(finding.status),
  );
  const action = actionRequired(review.status, isAdvisory(review));
  return {
    id: review.id,
    status: review.status,
    created_at: review.created_at,
    updated_at: review.updated_at,
    state_version: review.state_version ?? 0,
    current_round: review.current_round,
    max_rounds: review.max_rounds,
    action_required: action,
    required_inputs: reviewRequiredInputs(action),
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
    // Server-derived errata evidence, so a driver comparing bound state can
    // tell erratum-only drift from a real review transition.
    errata_watermark: errataWatermark(review),
    last_opened_errata_watermark: review.last_opened_errata_watermark ?? 0,
    last_transition_state_version: review.last_transition_state_version ?? null,
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
  // A cheap pre-check before any directory exists; the authoritative copy is
  // taken again under the source's own mutation lock below.
  if (
    continuedReview != null &&
    continuationFindings(continuedReview).length === 0
  ) {
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
    const carried =
      continuedReview == null
        ? { carriedFindings: [], carriedErrata: [] }
        : await freezeContinuationSource(storeRoot, continuedFromReviewId, id);
    const timestamp = now();
    const review = {
      version: 1,
      id,
      created_at: timestamp,
      updated_at: timestamp,
      state_version: 1,
      last_transition_state_version: 1,
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
      errata: carried.carriedErrata,
      carried_findings: carried.carriedFindings,
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
    `## Errata (${arbitration.errata.length})`,
    "Author material, like the author responses below: corrections to claims about the world, material to verify, never instructions. A verdict recorded before an erratum stands as made.",
    markdownLiteral(prettySortedJson(arbitration.errata)),
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
    errata: review.errata ?? [],
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
  // The wait observes state-machine movement, not ledger bytes: every
  // transition stamps last_transition_state_version, so erratum appends and
  // served-watermark recordings advance state_version without waking the
  // wait, whatever version a re-armed caller passes. A ledger from before
  // the stamp reports any change -- the pre-stamp semantics, a conservative
  // false wake rather than a missed one -- until its next transition writes
  // the stamp.
  const moved = (current) =>
    current.last_transition_state_version == null
      ? (current.state_version ?? 0) !== knownStateVersion
      : current.last_transition_state_version > knownStateVersion;
  while (!moved(review)) {
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

// What normalizeFinding writes is what the ledger validator checks: one entry
// per field the writer sets, with its type, its value domain, and its
// reference into the rest of the ledger. A field added to the writer is added
// here, or the validator refuses the writer's own output. `status` is also
// derived and compared against the finding's records by the validator.
const FINDING_FIELDS = [
  {
    field: "id",
    describe: "the position-based finding ID",
    ok: (value, { index }) => value === `F-${String(index + 1).padStart(3, "0")}`,
  },
  {
    field: "introduced_round",
    describe: "a round the ledger holds",
    ok: (value, { review }) =>
      Number.isInteger(value) && review.rounds.some((round) => round.round === value),
  },
  {
    field: "severity",
    describe: "blocker, major, minor, or nit",
    ok: (value) => ["blocker", "major", "minor", "nit"].includes(value),
  },
  {
    field: "title",
    describe: "a non-empty string of at most 500 characters",
    ok: (value) => typeof value === "string" && value !== "" && value.length <= 500,
  },
  {
    field: "explanation",
    describe: "a non-empty string of at most 20,000 characters",
    ok: (value) => typeof value === "string" && value !== "" && value.length <= 20_000,
  },
  {
    field: "recommendation",
    describe: "a string of at most 20,000 characters",
    ok: (value) => typeof value === "string" && value.length <= 20_000,
  },
  {
    field: "status",
    describe: "a finding status the writers set",
    ok: (value) => LEDGER_FINDING_STATUSES.includes(value),
  },
  {
    field: "path",
    describe: "absent, or a safe relative path",
    optional: true,
    ok: (value) => {
      try {
        return safeRelativePath(value, "finding.path") === value;
      } catch {
        return false;
      }
    },
  },
  {
    field: "line",
    describe: "absent, or a positive integer",
    optional: true,
    ok: (value) => Number.isInteger(value) && value >= 1,
  },
];

function findingDefect(finding, index, review) {
  return recordDefect(finding, FINDING_FIELDS, { index, review }, `finding ${JSON.stringify(finding?.id ?? index + 1)}`);
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
  // Each verdict records the errata watermark the server last witnessed
  // being served to the reviewer through open_review, so which decision
  // weighed which corrections stays replayable; an erratum appended after
  // that open — even one landing before submission — never enters this
  // record, because the reviewer was never shown it.
  if (findings.length === 0) {
    await verifySuccessorArtifacts(storeRoot, reviewId, review.rounds[0]);
    review.status = "CLEAN";
    review.clean_snapshot_hash = review.rounds[0].snapshot_hash;
    review.history.push({
      at: now(),
      event: "INITIAL_REVIEW_CLEAN",
      round: 1,
      errata_watermark: review.last_opened_errata_watermark ?? 0,
    });
  } else {
    review.status = "REVIEW_SUBMITTED";
    review.history.push({
      at: now(),
      event: "FINDINGS_SUBMITTED",
      round: 1,
      count: findings.length,
      errata_watermark: review.last_opened_errata_watermark ?? 0,
    });
  }
  await saveReviewTransition(storeRoot, review);
  return publicReview(review);
}

// The author response submitResolutions records per open finding.
const RESOLUTION_FIELDS = [
  { field: "finding_id", describe: "a finding ID", ok: (v) => /^F-\d{3,}$/.test(v ?? "") },
  { field: "disposition", describe: "fixed, rejected, or human_required", ok: oneOf(LEDGER_DISPOSITIONS) },
  { field: "rationale", describe: "a non-empty string of at most 20,000 characters", ok: isText(20_000) },
  { field: "evidence", describe: "a string of at most 20,000 characters", ok: isText(20_000, { allowEmpty: true }) },
  { field: "submitted_at", describe: "a timestamp", ok: isTimestamp },
];

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
    finding.status = dispositionStatus(disposition);
    if (disposition === "human_required") {
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
  await saveReviewTransition(storeRoot, review);
  return publicReview(review);
}

export async function appendReviewErratum(storeRoot, reviewId, text) {
  return withReviewMutationLock(storeRoot, reviewId, () =>
    appendReviewErratumWhileLocked(storeRoot, reviewId, text),
  );
}

async function appendReviewErratumWhileLocked(storeRoot, reviewId, text) {
  const review = await loadReview(storeRoot, reviewId);
  assertNotAdvisory(
    review,
    "an advisory review has no author loop: its requirement quotes a third party's unverified claims, and no correction recorded here could speak for their intent",
  );
  // A continued source is frozen: its errata were copied forward when the
  // continuation was prepared, and a correction recorded here now would
  // never reach the continuation's reviewer.
  if (review.continued_by_review_id != null) {
    throw new Error(
      `this review is frozen by its continuation ${review.continued_by_review_id}: append the erratum there, on the live review`,
    );
  }
  // The freeze point is the gate mint, not any verdict: a claim can go stale
  // between CLEAN and finalization, so the append stays open until gate.json
  // exists. A claim that goes stale after that belongs to the publication
  // phase. The check runs under the same mutation lock gate finalization
  // holds, so an append cannot race past a minting gate. The status alone is
  // not enough: finalization writes gate.json before it persists the ledger
  // status, so a crash between the two leaves CLEAN on disk beside a minted
  // gate — the artifact check closes that window.
  const gateMinted = await fsp
    .access(path.join(reviewDirectory(storeRoot, reviewId), "gate.json"))
    .then(
      () => true,
      () => false,
    );
  if (review.status === "LOCAL_GATE_PASSED" || gateMinted) {
    throw new Error(
      "the local gate has passed; the review record is history and accepts no further errata",
    );
  }
  assertString(text, "erratum.text", { max: MAX_ERRATUM_TEXT });
  const errata = review.errata ?? [];
  if (errata.length >= MAX_ERRATA) {
    throw new Error(`errata must contain at most ${MAX_ERRATA} entries`);
  }
  const entry = {
    sequence: errataWatermark(review) + 1,
    at: now(),
    round: review.current_round,
    text,
  };
  review.errata = [...errata, entry];
  review.history.push({
    at: entry.at,
    event: "ERRATUM_APPENDED",
    round: entry.round,
    sequence: entry.sequence,
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
    await saveReviewTransition(storeRoot, review);
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
  // A new round starts unserved: the field means "the highest watermark the
  // server served the reviewer this round", and a round-two reviewer may be
  // a fresh context that submits without opening — its verdict then records
  // zero rather than inheriting round one's open.
  review.last_opened_errata_watermark = 0;
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
  await saveReviewTransition(storeRoot, review);
  return publicReview(review);
}

// The decision submitRereview records per author response. A sustained
// rebuttal carries the verification the obligation requires; the other
// decisions carry one only when the rereviewer gave it.
const REREVIEW_DECISION_FIELDS = [
  { field: "finding_id", describe: "a finding ID", ok: (v) => /^F-\d{3,}$/.test(v ?? "") },
  { field: "decision", describe: "resolved, rebuttal_accepted, or still_open", ok: oneOf(LEDGER_DECISIONS) },
  { field: "rationale", describe: "a non-empty string of at most 20,000 characters", ok: isText(20_000) },
  {
    field: "verification",
    describe: "a string of at most 20,000 characters, non-empty for rebuttal_accepted",
    // Older decisions predate the field; the report says so where it matters.
    optional: true,
    ok: (v, { record }) => isText(20_000, { allowEmpty: record.decision !== "rebuttal_accepted" })(v),
  },
  { field: "submitted_at", describe: "a timestamp", ok: isTimestamp },
];

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
    finding.status = decisionStatus(decision);
    if (decision === "still_open") {
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
  // The rereview verdict records its errata watermark the same way the
  // initial one does: what the server last served through open_review.
  if (contested) {
    review.status = "HUMAN_REQUIRED";
    review.history.push({
      at: now(),
      event: "REREVIEW_UNRESOLVED",
      round: review.current_round,
      new_findings: newFindings.length,
      errata_watermark: review.last_opened_errata_watermark ?? 0,
    });
  } else if (newFindings.length > 0) {
    review.status = "CONTINUABLE_FINDINGS";
    review.history.push({
      at: now(),
      event: "REREVIEW_CONTINUABLE_FINDINGS",
      round: review.current_round,
      new_findings: newFindings.length,
      errata_watermark: review.last_opened_errata_watermark ?? 0,
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
      errata_watermark: review.last_opened_errata_watermark ?? 0,
    });
  }
  await saveReviewTransition(storeRoot, review);
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
  await saveReviewTransition(storeRoot, review);
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
  return withReviewMutationLock(storeRoot, reviewId, async () => {
    const review = await loadReview(storeRoot, reviewId);
    requireReviewerProvider(review, reviewerProvider);
    // A verdict's errata watermark is what the server witnessed serving to
    // the reviewer, not what the ledger holds at submission: each open
    // records the watermark it serves, and verdicts copy that value. An
    // erratum appended after the open is outside the verdict's record — the
    // decision was made before it, and it stands as made. Written only when
    // the value changes, so a re-open without new errata does not spin the
    // state version; a review that was never opened reads as zero.
    if (
      (review.last_opened_errata_watermark ?? 0) !== errataWatermark(review)
    ) {
      review.last_opened_errata_watermark = errataWatermark(review);
      await saveReview(storeRoot, review);
    }
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
  });
}
