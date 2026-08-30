import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  codexRequestBody,
  isCodexRequestId,
} from "./codex-request.mjs";
import { loadReview, REVIEWER_PROVIDERS } from "./core.mjs";
// One derivation of the App's notice markers, shared with the adapter that
// records them. A notice is only non-blocking because its body carries a
// marker, so the claim has to be checked here against that body.
import { codexAppNoticeMarker } from "./github-adapter.mjs";
// One derivation of thread completeness, shared with the normalizer that
// records it. Two copies of this rule would be two things to keep in step.
import { threadProvenanceComplete } from "./github-observation.mjs";
import {
  atomicWriteCanonicalJson,
  canonicalJson,
  canonicalJsonBytes,
  readSecureFile,
  readSecureJson,
  removeAndSync,
  sha256,
  StoreError,
  withStateLock,
} from "./storage.mjs";
import { publicationRequiredInputs } from "./tool-inputs.mjs";
import { readWorkflowBinding, WORKFLOW_ID_RE } from "./workflow-binding.mjs";

const SUPPORTED_PUBLICATION_VERSIONS = [1, 2, 3];
const MAX_PUBLICATION_BYTES = 10 * 1024 * 1024;
const TERMINAL_RESERVE_BYTES = 64 * 1024;
const MAX_OBSERVATION_BYTES = 6 * 1024 * 1024;
const MAX_BASELINE_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_EVENT_BYTES = 16 * 1024;
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_MS = 30 * 1000;
const MAX_ATOMIC_WINDOW_MS = 2 * 60 * 1000;
const POST_VISIBILITY_GRACE_MS = 30 * 1000;
// How long a terminal/gate consumer waits for a historical ancestor
// publication's lock before reporting PUBLICATION_BUSY. The wait is shorter
// than the default because the caller already holds the current publication
// lock: an ancestor mutation is brief, and a still-locked source must fail
// closed as retryable contention instead of stalling the current projection.
const HISTORICAL_ANCESTOR_LOCK_WAIT_MS = 1_000;
const BODY_REQUEST = "@codex review";
const REQUEST_BODY_SHA256 = sha256(Buffer.from(BODY_REQUEST, "utf8"));

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const RESOURCE_KINDS = new Set([
  "ISSUE_COMMENT",
  "PULL_REQUEST_REVIEW",
  "PULL_REQUEST_REVIEW_COMMENT",
]);
const TERMINAL_STATUSES = new Set(["INVALIDATED", "CLOSED", "MERGED"]);
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const AUDIT_EVENT_KEYS = new Set([
  "version",
  "review_id",
  "sequence",
  "event_id",
  "previous_event_sha256",
  "event",
  "outcome",
  "normalized_reason",
  "at",
  "publication_revision",
  "head_sha",
  "github_observation_sha256",
  "gate_sha256",
  "expires_at",
]);
const VERIFICATION_FAILURE_REASONS = new Set([
  "GATE_MISSING_OR_MALFORMED",
  "GATE_MISMATCH",
  "EVIDENCE_STALE",
]);

class PublicationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "PublicationError";
    this.code = code;
    this.details = details;
  }
}

export { PublicationError };

function fail(code, message, details) {
  throw new PublicationError(code, message, details);
}

function isJsonObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(content, code, message) {
  let value;
  try {
    value = JSON.parse(
      typeof content === "string" ? content : content.toString("utf8"),
    );
  } catch {
    fail(code, message);
  }
  if (!isJsonObject(value)) {
    fail(code, message);
  }
  return value;
}

// Observations are collector output, not model output. Reading the collector's
// file directly keeps a multi-megabyte payload out of the transcript entirely;
// the ledger validates the same bytes either way.
export async function readObservationFile(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    fail("INVALID_INPUT", "observation_path must be a non-empty string");
  }
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch (error) {
    fail(
      "OBSERVATION_FILE_UNREADABLE",
      `cannot read observation file: ${error.message}`,
      { path: resolved, retryable: false },
    );
  }
  if (!stat.isFile()) {
    fail("OBSERVATION_FILE_UNREADABLE", "observation_path is not a regular file", {
      path: resolved,
      retryable: false,
    });
  }
  if (stat.size > MAX_OBSERVATION_BYTES) {
    fail(
      "OBSERVATION_FILE_TOO_LARGE",
      `observation file exceeds ${MAX_OBSERVATION_BYTES} bytes`,
      { path: resolved, bytes: stat.size, retryable: false },
    );
  }
  const content = await fsp.readFile(resolved);
  return parseJsonObject(
    content,
    "OBSERVATION_FILE_MALFORMED",
    "observation file is not a JSON object",
  );
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function publicationDirectory(storeRoot, reviewId) {
  if (typeof reviewId !== "string" || !/^rb-[0-9TZ-]+-[a-f0-9]{8}$/.test(reviewId)) {
    fail("INVALID_INPUT", "invalid review_id");
  }
  return path.join(storeRoot, "reviews", reviewId);
}

function createPublicationId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  return `rb-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function correlatedRequestIdFor(reviewId, revision, headSha) {
  return `rbreq-${sha256(
    Buffer.from(
      `${reviewId}\0${revision}\0${headSha}`,
      "utf8",
    ),
  ).slice(0, 32)}`;
}

function correlatedRequestId(ledger) {
  return correlatedRequestIdFor(
    ledger.review_id,
    ledger.revision,
    authorizationForLedger(ledger).head_sha,
  );
}

function correlatedRequestBody(requestId) {
  try {
    return codexRequestBody(requestId);
  } catch {
    fail("INVALID_INPUT", "request_id is invalid");
  }
}

function correlatedRequest(ledger) {
  const requestId = correlatedRequestId(ledger);
  const body = correlatedRequestBody(requestId);
  return {
    request_id: requestId,
    body,
    body_sha256: sha256(Buffer.from(body, "utf8")),
  };
}

function publicationRequest(ledger) {
  return ledger.codex_review_baseline.collection.adapter_version === 2
    ? correlatedRequest(ledger)
    : {
        body: BODY_REQUEST,
        body_sha256: REQUEST_BODY_SHA256,
      };
}

function pathsFor(storeRoot, reviewId) {
  const directory = publicationDirectory(storeRoot, reviewId);
  return {
    directory,
    review: path.join(directory, "review.json"),
    localGate: path.join(directory, "gate.json"),
    remoteAuthorization: path.join(directory, "remote-authorization.json"),
    publication: path.join(directory, "publication.json"),
    gate: path.join(directory, "publication-gate.json"),
    auditLog: path.join(directory, "publication-gate-audit.jsonl"),
    auditHead: path.join(directory, "publication-gate-audit-head.json"),
  };
}

function assertObject(value, name) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_INPUT", `${name} must be an object`);
  }
  return value;
}

function assertArray(value, name, max = 10_000) {
  if (!Array.isArray(value) || value.length > max) {
    fail("INVALID_INPUT", `${name} must be an array with at most ${max} entries`);
  }
  return value;
}

function assertString(value, name, max = 200_000) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    fail("INVALID_INPUT", `${name} must be a non-empty string`);
  }
  return value;
}

function assertEnum(value, allowed, name) {
  if (!allowed.includes(value)) {
    fail("INVALID_INPUT", `${name} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function assertId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_INPUT", `${name} must be a positive safe integer`);
  }
  return value;
}

function assertRevision(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_INPUT", "expected_revision must be a positive safe integer");
  }
}

function assertSha(value, name) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    fail("INVALID_INPUT", `${name} must be a 40-character lowercase Git SHA`);
  }
  return value;
}

function assertDigest(value, name) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    fail("INVALID_INPUT", `${name} must be a 64-character lowercase SHA-256`);
  }
  return value;
}

function timestampMs(value, name) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  ) {
    fail("INVALID_INPUT", `${name} must be canonical UTC RFC 3339 milliseconds`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("INVALID_INPUT", `${name} is not a valid canonical timestamp`);
  }
  return milliseconds;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function canonicalRequestTimestamp(value) {
  if (isCanonicalTimestamp(value)) {
    return value;
  }
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  ) {
    const normalized = new Date(value).toISOString();
    if (normalized.replace(".000Z", "Z") === value) {
      return normalized;
    }
  }
  fail(
    "INVALID_INPUT",
    "created_at must be a canonical UTC RFC 3339 timestamp",
  );
}

function assertUrl(value, name) {
  assertString(value, name, 4096);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("INVALID_INPUT", `${name} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail("INVALID_INPUT", `${name} must be a credential-free HTTPS URL`);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function canonicalDigest(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertStoredCanonicalJson(value, expected, code, message) {
  try {
    if (canonicalJson(value) === expected) {
      return;
    }
  } catch {}
  fail(code, message);
}

function assertStoredCanonicalJsonBytes(value, expected, code, message) {
  try {
    if (expected.equals(canonicalJsonBytes(value))) {
      return;
    }
  } catch {}
  fail(code, message);
}

function assertExactKeys(value, allowedKeys, name) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail("INVALID_INPUT", `${name} contains unexpected field ${unexpected[0]}`);
  }
}

// The shapes the snapshot projection can reproduce. Applied both to a stored
// baseline at start and to the projected partitions at snapshot time: a key
// either side accepts alone is a baseline the comparison can never satisfy.
function baselineRequestKeys(item, adapterVersion) {
  return [
    "resource_id",
    "resource_kind",
    "url",
    "event_at",
    "timestamp_field",
    "body_sha256",
    ...(adapterVersion === 2 ? ["request_id"] : []),
    ...("issuance" in item ? ["issuance"] : []),
    "actor",
  ];
}

function baselineResultKeys(adapterVersion) {
  return [
    "result_id",
    "resource_kind",
    "native_review_state",
    "url",
    "event_at",
    "timestamp_field",
    "actor",
    "reviewed_head_sha",
    "commit_binding",
    "attached_review_comments",
    "body_sha256",
    ...(adapterVersion === 2 ? ["request_id"] : []),
  ];
}

function assertBaselineShape(
  requests,
  results,
  adapterVersion,
  requestsName,
  resultsName,
) {
  for (const [index, item] of requests.entries()) {
    assertExactKeys(
      item,
      baselineRequestKeys(item, adapterVersion),
      `${requestsName}[${index}]`,
    );
    assertExactKeys(
      item.actor,
      ["id", "type"],
      `${requestsName}[${index}].actor`,
    );
    if ("issuance" in item) {
      assertExactKeys(
        item.issuance,
        ["review_id", "recorded_revision", "requested_head_sha"],
        `${requestsName}[${index}].issuance`,
      );
    }
  }
  for (const [index, item] of results.entries()) {
    assertExactKeys(
      item,
      baselineResultKeys(adapterVersion),
      `${resultsName}[${index}]`,
    );
    assertExactKeys(
      item.actor,
      ["id", "type"],
      `${resultsName}[${index}].actor`,
    );
  }
}

function sameIdentitySet(left, right, idField = "resource_id") {
  if (left.length !== right.length) {
    return false;
  }
  const rightByIdentity = new Map(
    right.map((item) => [resourceIdentity(item, idField), item]),
  );
  return left.every((item) => {
    const expected = rightByIdentity.get(resourceIdentity(item, idField));
    return expected != null && sameCanonical(item, expected);
  });
}

function uniqueBy(items, key, name) {
  const seen = new Set();
  for (const item of items) {
    const identity = key(item);
    if (seen.has(identity)) {
      fail("INVALID_INPUT", `${name} contains duplicate ${identity}`);
    }
    seen.add(identity);
  }
}

function resourceIdentity(item, idField = "resource_id") {
  assertEnum(item.resource_kind, [...RESOURCE_KINDS], "resource_kind");
  return `${item.resource_kind}:${assertId(item[idField], idField)}`;
}

function sourceTimes(collection, name) {
  assertObject(collection, name);
  assertEnum(collection.status, ["COMPLETE", "INCOMPLETE", "UNKNOWN"], `${name}.status`);
  const parent = timestampMs(collection.collected_at, `${name}.collected_at`);
  const sources = [
    ...(collection.sources ?? []),
    ...(collection.policy_sources ?? []),
    ...(collection.run_sources ?? []),
  ];
  assertArray(sources, `${name} sources`);
  const times = sources.map((source, index) => {
    assertObject(source, `${name} source ${index}`);
    assertString(source.kind, `${name} source kind`, 100);
    assertString(source.endpoint, `${name} source endpoint`, 1000);
    return timestampMs(source.collected_at, `${name} source collected_at`);
  });
  if (times.length > 0 && parent !== Math.max(...times)) {
    fail("INVALID_INPUT", `${name}.collected_at must equal its latest source time`);
  }
  return [parent, ...times];
}

function requireSourceKinds(collection, expected, name) {
  if (collection.status !== "COMPLETE") {
    return;
  }
  const sources = [
    ...(collection.sources ?? []),
    ...(collection.policy_sources ?? []),
    ...(collection.run_sources ?? []),
  ];
  const kinds = sources.map((source) => source.kind);
  uniqueBy(sources, (source) => source.kind, `${name} sources`);
  for (const kind of expected) {
    if (!kinds.includes(kind)) {
      fail("INVALID_INPUT", `${name} is missing ${kind}`);
    }
  }
  for (const source of sources) {
    const outcomes = ["status", "result"]
      .filter((field) => field in source)
      .map((field) =>
        assertEnum(
          source[field],
          [
            "COMPLETE",
            "INCOMPLETE",
            "UNKNOWN",
            "SUCCESS",
            "NOT_CONFIGURED",
            "ERROR",
          ],
          `${name}.${source.kind}.${field}`,
        ),
      );
    if (outcomes.length === 0) {
      fail("INVALID_INPUT", `${name}.${source.kind} has no outcome`);
    }
    if (
      collection.status === "COMPLETE" &&
      outcomes.some(
        (outcome) => !["COMPLETE", "SUCCESS", "NOT_CONFIGURED"].includes(outcome),
      )
    ) {
      fail("INVALID_INPUT", `${name}.${source.kind} is not complete`);
    }
    if ("pagination_complete" in source && typeof source.pagination_complete !== "boolean") {
      fail("INVALID_INPUT", `${name}.${source.kind}.pagination_complete must be boolean`);
    }
    if (source.pagination_complete === true) {
      assertId(source.page_count, `${name}.${source.kind}.page_count`);
    }
  }
}

function requireAtomicPage(collection, kind, name) {
  // Gated on COMPLETE like its two neighbours, and for the same reason: a
  // collection that does not claim completeness is not claiming evidence. The
  // gate returns EVIDENCE_INCOMPLETE for such a thread collection before it
  // ever reads unresolved_count, so nothing it records can decide anything.
  // Checking unconditionally would instead make an openly incomplete
  // collection unrecordable, which is a state the schema deliberately allows.
  if (collection.status !== "COMPLETE") {
    return;
  }
  const source = [
    ...(collection.sources ?? []),
    ...(collection.policy_sources ?? []),
    ...(collection.run_sources ?? []),
  ].find((entry) => entry.kind === kind);
  if (source?.page_count !== 1) {
    fail("INVALID_INPUT", `${name}.${kind} must be a single atomic page`);
  }
}

function requireCompletePagination(collection, kinds, name) {
  if (collection.status !== "COMPLETE") {
    return;
  }
  const sources = [
    ...(collection.sources ?? []),
    ...(collection.policy_sources ?? []),
    ...(collection.run_sources ?? []),
  ];
  for (const kind of kinds) {
    const source = sources.find((entry) => entry.kind === kind);
    if (
      !source ||
      source.pagination_complete !== true ||
      !Number.isSafeInteger(source.page_count) ||
      source.page_count <= 0
    ) {
      fail("INVALID_INPUT", `${name}.${kind} must prove complete pagination`);
    }
  }
}

function validateFreshTimes(times, createdAt, currentMs, name) {
  const createdMs = timestampMs(createdAt, "publication.created_at");
  for (const milliseconds of times) {
    if (milliseconds < createdMs) {
      fail("INVALID_INPUT", `${name} predates publication creation`);
    }
    if (currentMs - milliseconds > MAX_AGE_MS) {
      fail("EVIDENCE_STALE", `${name} is older than five minutes`);
    }
    if (milliseconds - currentMs > MAX_FUTURE_MS) {
      fail("EVIDENCE_FUTURE", `${name} is more than 30 seconds in the future`);
    }
  }
  if (Math.max(...times) - Math.min(...times) > MAX_ATOMIC_WINDOW_MS) {
    fail("EVIDENCE_NOT_ATOMIC", `${name} spans more than two minutes`);
  }
}

function validateBaseline(input, currentMs, createdAt = null, expectedActor = null) {
  const baseline = clone(assertObject(input, "codex_review_baseline"));
  const observedMs = timestampMs(baseline.observed_at, "baseline.observed_at");
  const collection = assertObject(baseline.collection, "baseline.collection");
  if (
    collection.status !== "COMPLETE" ||
    ![1, 2].includes(collection.adapter_version)
  ) {
    fail(
      "INVALID_INPUT",
      "publication baseline must be complete and use adapter version 1 or 2",
    );
  }
  requireSourceKinds(
    collection,
    ["ISSUE_COMMENTS", "PULL_REQUEST_REVIEWS", "PULL_REQUEST_REVIEW_COMMENTS"],
    "baseline.collection",
  );
  requireCompletePagination(
    collection,
    ["ISSUE_COMMENTS", "PULL_REQUEST_REVIEWS", "PULL_REQUEST_REVIEW_COMMENTS"],
    "baseline.collection",
  );
  const times = [observedMs, ...sourceTimes(collection, "baseline.collection")];
  const lowerBound = createdAt ?? new Date(currentMs - MAX_AGE_MS).toISOString();
  validateFreshTimes(times, lowerBound, currentMs, "publication baseline");
  if (observedMs < Math.max(...times.slice(1))) {
    fail("INVALID_INPUT", "baseline.observed_at must not precede a source collection");
  }
  const requests = assertArray(
    baseline.requests,
    "baseline.requests",
    Number.MAX_SAFE_INTEGER,
  );
  const results = assertArray(
    baseline.candidate_results,
    "baseline.candidate_results",
    Number.MAX_SAFE_INTEGER,
  );
  if (requests.length + results.length > 5_000) {
    fail("PUBLICATION_LIMIT_EXCEEDED", "baseline exceeds 5,000 evidence entries");
  }
  if (
    requests.some(
      (request) => isJsonObject(request) && "issuance" in request,
    )
  ) {
    fail(
      "INVALID_INPUT",
      "baseline request issuance provenance is server-derived",
    );
  }
  validateRequestFacts(requests, "baseline.requests", { baseline: true });
  validateResultFacts(results, "baseline.candidate_results", {
    baseline: true,
    expectedActor,
  });
  assertBaselineShape(
    requests,
    results,
    collection.adapter_version,
    "baseline.requests",
    "baseline.candidate_results",
  );
  if (
    collection.adapter_version === 2 &&
    (requests.some((request) => !("request_id" in request)) ||
      results.some((result) => !("request_id" in result)))
  ) {
    fail(
      "INVALID_INPUT",
      "adapter version 2 baseline objects must include request_id",
    );
  }
  if (results.some((result) => result.native_review_state === "PENDING")) {
    fail("INVALID_INPUT", "baseline cannot contain a pending Codex formal review");
  }
  if (canonicalJsonBytes(baseline).length > MAX_BASELINE_BYTES) {
    fail("PUBLICATION_LIMIT_EXCEEDED", "baseline exceeds 2 MiB");
  }
  return baseline;
}

function validateRequestFacts(items, name, { baseline = false } = {}) {
  uniqueBy(items, (item) => resourceIdentity(item), name);
  for (const [index, item] of items.entries()) {
    assertObject(item, `${name}[${index}]`);
    resourceIdentity(item);
    assertUrl(item.url, `${name}[${index}].url`);
    timestampMs(item.event_at, `${name}[${index}].event_at`);
    const expectedTimestamp =
      item.resource_kind === "PULL_REQUEST_REVIEW" ? "submitted_at" : "created_at";
    if (item.timestamp_field !== expectedTimestamp) {
      fail("INVALID_INPUT", `${name}[${index}] has wrong timestamp_field`);
    }
    assertDigest(item.body_sha256, `${name}[${index}].body_sha256`);
    if (
      "request_id" in item &&
      item.request_id !== null &&
      !isCodexRequestId(item.request_id)
    ) {
      fail("INVALID_INPUT", `${name}[${index}].request_id is invalid`);
    }
    if ("issuance" in item) {
      const issuance = assertObject(
        item.issuance,
        `${name}[${index}].issuance`,
      );
      assertExactKeys(
        issuance,
        ["review_id", "recorded_revision", "requested_head_sha"],
        `${name}[${index}].issuance`,
      );
      publicationDirectory("/store", issuance.review_id);
      if (
        !Number.isSafeInteger(issuance.recorded_revision) ||
        issuance.recorded_revision < 2
      ) {
        fail(
          "INVALID_INPUT",
          `${name}[${index}].issuance.recorded_revision is invalid`,
        );
      }
      assertSha(
        issuance.requested_head_sha,
        `${name}[${index}].issuance.requested_head_sha`,
      );
      if (
        item.request_id !==
        correlatedRequestIdFor(
          issuance.review_id,
          issuance.recorded_revision - 1,
          issuance.requested_head_sha,
        )
      ) {
        fail(
          "INVALID_INPUT",
          `${name}[${index}].issuance does not authenticate request_id`,
        );
      }
    }
    if (baseline) {
      assertObject(item.actor, `${name}[${index}].actor`);
      assertId(item.actor.id, `${name}[${index}].actor.id`);
      assertEnum(item.actor.type, ["Bot", "User", "Organization"], `${name}[${index}].actor.type`);
    }
  }
}

function validateResultFacts(
  items,
  name,
  { baseline = false, expectedActor = null } = {},
) {
  uniqueBy(items, (item) => resourceIdentity(item, "result_id"), name);
  for (const [index, item] of items.entries()) {
    assertObject(item, `${name}[${index}]`);
    resourceIdentity(item, "result_id");
    assertUrl(item.url, `${name}[${index}].url`);
    timestampMs(item.event_at, `${name}[${index}].event_at`);
    const expectedTimestamp =
      item.resource_kind === "PULL_REQUEST_REVIEW" ? "submitted_at" : "created_at";
    if (item.timestamp_field !== expectedTimestamp) {
      fail("INVALID_INPUT", `${name}[${index}] has wrong timestamp_field`);
    }
    assertObject(item.actor, `${name}[${index}].actor`);
    assertId(item.actor.id, `${name}[${index}].actor.id`);
    assertString(item.actor.type, `${name}[${index}].actor.type`, 100);
    if (
      expectedActor &&
      (item.actor.id !== expectedActor.id || item.actor.type !== expectedActor.type)
    ) {
      fail("INVALID_INPUT", `${name}[${index}] does not match the pinned Codex actor`);
    }
    assertDigest(item.body_sha256, `${name}[${index}].body_sha256`);
    if (
      "request_id" in item &&
      item.request_id !== null &&
      !isCodexRequestId(item.request_id)
    ) {
      fail("INVALID_INPUT", `${name}[${index}].request_id is invalid`);
    }
    if (item.reviewed_head_sha != null) {
      assertSha(item.reviewed_head_sha, `${name}[${index}].reviewed_head_sha`);
    }
    assertArray(
      item.attached_review_comments ?? [],
      `${name}[${index}].attached_review_comments`,
    );
    if (item.resource_kind === "PULL_REQUEST_REVIEW") {
      assertEnum(
        item.native_review_state,
        ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"],
        `${name}[${index}].native_review_state`,
      );
    } else if (item.native_review_state !== null) {
      fail("INVALID_INPUT", `${name}[${index}] cannot have a native review state`);
    }
    for (const attachment of item.attached_review_comments ?? []) {
      assertId(attachment.comment_id, `${name}[${index}] attachment comment_id`);
      assertId(attachment.actor?.id, `${name}[${index}] attachment actor.id`);
      assertString(
        attachment.actor?.type,
        `${name}[${index}] attachment actor.type`,
        100,
      );
      assertSha(attachment.commit_id, `${name}[${index}] attachment commit_id`);
      assertDigest(
        attachment.body_sha256,
        `${name}[${index}] attachment body_sha256`,
      );
    }
    uniqueBy(
      item.attached_review_comments ?? [],
      (attachment) => attachment.comment_id,
      `${name}[${index}] attached comments`,
    );
    if (!baseline) {
      assertEnum(item.association, [
        "UNSOLICITED",
        "BASELINE_LATE_RESULT",
        "SINGLE_OPEN_REQUEST",
        "CORRELATED_REQUEST_ID",
        "AMBIGUOUS",
      ], `${name}[${index}].association`);
      assertEnum(item.verdict, ["CLEAN", "FINDINGS", "UNKNOWN"], `${name}[${index}].verdict`);
      if (
        item.association === "SINGLE_OPEN_REQUEST" ||
        item.association === "CORRELATED_REQUEST_ID" ||
        item.association === "BASELINE_LATE_RESULT"
      ) {
        assertObject(item.request_ref, `${name}[${index}].request_ref`);
        resourceIdentity(item.request_ref);
      } else if (
        item.association === "UNSOLICITED" ||
        item.association === "AMBIGUOUS"
      ) {
        if (item.request_ref !== null) {
          fail("INVALID_INPUT", `${name}[${index}] must have a null request_ref`);
        }
      }
    }
  }
}

function validateObservation(input, ledger, currentMs) {
  const observation = clone(assertObject(input, "observation"));
  if ("recorded_at" in observation) {
    fail("INVALID_INPUT", "observation.recorded_at is server-authored");
  }
  if (canonicalJsonBytes(observation).length > MAX_OBSERVATION_BYTES) {
    fail("PUBLICATION_LIMIT_EXCEEDED", "observation exceeds 6 MiB");
  }
  const observedMs = timestampMs(observation.observed_at, "observation.observed_at");
  const pullRequest = assertObject(observation.pull_request, "observation.pull_request");
  const requiredChecks = assertObject(
    observation.required_checks,
    "observation.required_checks",
  );
  const codexReview = assertObject(observation.codex_review, "observation.codex_review");
  const reviewThreads = assertObject(
    observation.review_threads,
    "observation.review_threads",
  );
  const collections = [
    ["pull_request.collection", assertObject(pullRequest.collection, "pull_request.collection")],
    [
      "required_checks.collection",
      assertObject(requiredChecks.collection, "required_checks.collection"),
    ],
    ["codex_review.collection", assertObject(codexReview.collection, "codex_review.collection")],
    [
      "review_threads.collection",
      assertObject(reviewThreads.collection, "review_threads.collection"),
    ],
  ];
  requireSourceKinds(
    pullRequest.collection,
    [
      "PULL_REQUEST",
      "BASE_BRANCH_METADATA",
      "BASE_HEAD_COMPARISON",
      "REVIEWED_BASE_CURRENT_BASE_COMPARISON",
    ],
    "pull_request.collection",
  );
  requireCompletePagination(
    requiredChecks.collection,
    ["APPLICABLE_RULES", "CHECK_RUN", "COMMIT_STATUS"],
    "required_checks.collection",
  );
  // Both run kinds carry state that decides the gate, so like the review
  // threads neither can be assembled from several instants. decidingRunsFor
  // makes no distinction between them, so neither does this. The collector
  // issues one request each; the observation arrives as caller-supplied JSON,
  // so the rule has to hold here too.
  for (const kind of ["CHECK_RUN", "COMMIT_STATUS"]) {
    requireAtomicPage(
      requiredChecks.collection,
      kind,
      "required_checks.collection",
    );
  }
  requireSourceKinds(
    requiredChecks.collection,
    ["APPLICABLE_RULES", "BRANCH_METADATA", "CHECK_RUN", "COMMIT_STATUS"],
    "required_checks.collection",
  );
  requireCompletePagination(
    codexReview.collection,
    ["ISSUE_COMMENTS", "PULL_REQUEST_REVIEWS", "PULL_REQUEST_REVIEW_COMMENTS"],
    "codex_review.collection",
  );
  requireSourceKinds(
    codexReview.collection,
    ["ISSUE_COMMENTS", "PULL_REQUEST_REVIEWS", "PULL_REQUEST_REVIEW_COMMENTS"],
    "codex_review.collection",
  );
  requireCompletePagination(
    reviewThreads.collection,
    ["PULL_REQUEST_REVIEW_THREADS"],
    "review_threads.collection",
  );
  // A thread's resolved flag mutates in place, so unresolving one between two
  // pages changes no total, no identity and no pageInfo, and the value read
  // earlier is recorded as fact -- the same shape as a check run updated after
  // its page was read, and equally invisible to a count. The collector refuses anything but a single page; the observation
  // arrives here as caller-supplied JSON, so the ledger has to say it too or
  // the invariant holds in only one of the two layers that state it.
  requireAtomicPage(
    reviewThreads.collection,
    "PULL_REQUEST_REVIEW_THREADS",
    "review_threads.collection",
  );
  requireSourceKinds(
    reviewThreads.collection,
    ["PULL_REQUEST_REVIEW_THREADS"],
    "review_threads.collection",
  );
  if (
    codexReview.collection.status === "COMPLETE" &&
    codexReview.collection.adapter_version !==
      ledger.codex_review_baseline.collection.adapter_version
  ) {
    fail(
      "INVALID_INPUT",
      "Codex collection adapter version must match the publication baseline",
    );
  }
  const allTimes = [observedMs];
  for (const [name, collection] of collections) {
    allTimes.push(...sourceTimes(collection, name));
  }
  // Every ancestry comparison read, not merely the summary source's latest:
  // one stale compare would otherwise ride in under a fresh sibling, and
  // eligibility would trust its descends value.
  for (const entry of reviewThreads.ancestry ?? []) {
    allTimes.push(
      timestampMs(entry.collected_at, "review_threads.ancestry collected_at"),
    );
  }
  validateFreshTimes(allTimes, ledger.created_at, currentMs, "GitHub observation");
  if (observedMs < Math.max(...allTimes.slice(1))) {
    fail("INVALID_INPUT", "observation.observed_at must not precede a collection");
  }

  const arrays = [
    requiredChecks.requirements ?? [],
    requiredChecks.runs ?? [],
    reviewThreads.threads ?? [],
    codexReview.preexisting_requests ?? [],
    codexReview.preexisting_candidate_results ?? [],
    codexReview.requests ?? [],
    codexReview.unbound_requests ?? [],
    codexReview.unsupported_requests ?? [],
    codexReview.foreign_actor_objects ?? [],
    codexReview.app_notices ?? [],
    codexReview.results ?? [],
  ];
  for (const [index, value] of arrays.entries()) {
    assertArray(
      value,
      `observation evidence array ${index}`,
      Number.MAX_SAFE_INTEGER,
    );
  }
  const nestedAttachments = (codexReview.results ?? []).reduce(
    (sum, result) => sum + (result.attached_review_comments?.length ?? 0),
    0,
  );
  if (arrays.reduce((sum, array) => sum + array.length, 0) + nestedAttachments > 10_000) {
    fail("PUBLICATION_LIMIT_EXCEEDED", "observation exceeds 10,000 evidence entries");
  }
  if ((requiredChecks.requirements ?? []).length > 1_000) {
    fail("PUBLICATION_LIMIT_EXCEEDED", "requirements exceeds 1,000 entries");
  }
  const baselineConflict = validateCodexPartitions(codexReview, ledger);
  validatePullRequest(pullRequest);
  validateChecks(requiredChecks, pullRequest, ledger.target);
  validateThreads(reviewThreads, authorizationForLedger(ledger).head_sha);
  observation.recorded_at = new Date(currentMs).toISOString();
  return { observation, baselineConflict };
}

function validatePullRequest(pullRequest) {
  assertId(pullRequest.repository_id, "pull_request.repository_id");
  assertId(pullRequest.number, "pull_request.number");
  assertUrl(pullRequest.url, "pull_request.url");
  assertEnum(pullRequest.state, ["OPEN", "CLOSED"], "pull_request.state");
  if (typeof pullRequest.is_merged !== "boolean" || typeof pullRequest.is_draft !== "boolean") {
    fail("INVALID_INPUT", "pull request merge and draft fields must be boolean");
  }
  for (const field of ["head_sha", "pr_reported_base_sha", "base_sha"]) {
    assertSha(pullRequest[field], `pull_request.${field}`);
  }
  assertString(pullRequest.head_branch, "pull_request.head_branch", 255);
  assertString(pullRequest.base_branch, "pull_request.base_branch", 255);
  assertEnum(
    pullRequest.mergeable,
    ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
    "pull_request.mergeable",
  );
  if (pullRequest.collection.status === "COMPLETE") {
    const baseSource = pullRequest.collection.sources?.find(
      (source) => source.kind === "BASE_BRANCH_METADATA",
    );
    assertSha(baseSource?.branch_tip_sha, "BASE_BRANCH_METADATA.branch_tip_sha");
  }
  if (pullRequest.is_merged) {
    if (
      pullRequest.state !== "CLOSED" ||
      pullRequest.merged_at == null ||
      pullRequest.merge_commit_sha == null
    ) {
      fail("INVALID_INPUT", "merged pull request fields are inconsistent");
    }
    timestampMs(pullRequest.merged_at, "pull_request.merged_at");
    assertSha(pullRequest.merge_commit_sha, "pull_request.merge_commit_sha");
  } else if (pullRequest.merged_at != null || pullRequest.merge_commit_sha != null) {
    fail("INVALID_INPUT", "open or unmerged pull request cannot carry merge evidence");
  }
  for (const [name, comparison] of [
    ["base_head_comparison", pullRequest.base_head_comparison],
    [
      "reviewed_base_current_base_comparison",
      pullRequest.reviewed_base_current_base_comparison,
    ],
  ]) {
    assertObject(comparison, `pull_request.${name}`);
    assertEnum(
      comparison.status,
      ["AHEAD", "IDENTICAL", "BEHIND", "DIVERGED", "UNKNOWN"],
      `pull_request.${name}.status`,
    );
    assertSha(comparison.base_sha, `pull_request.${name}.base_sha`);
    assertSha(comparison.head_sha, `pull_request.${name}.head_sha`);
  }
}

function validateChecks(requiredChecks, pullRequest, target) {
  assertEnum(
    requiredChecks.policy,
    ["REQUIRED", "STRICT_ONLY", "NONE_CONFIGURED"],
    "required_checks.policy",
  );
  assertObject(requiredChecks.strict_policy, "required_checks.strict_policy");
  if (typeof requiredChecks.strict_policy.required !== "boolean") {
    fail("INVALID_INPUT", "strict_policy.required must be boolean");
  }
  assertArray(requiredChecks.strict_policy.sources ?? [], "strict_policy.sources");
  const requirements = assertArray(
    requiredChecks.requirements ?? [],
    "required_checks.requirements",
    1_000,
  );
  const runs = assertArray(requiredChecks.runs ?? [], "required_checks.runs");
  uniqueBy(
    requirements,
    (item) => `${item.context}:${item.app_binding}:${item.required_app_id ?? "null"}`,
    "required checks",
  );
  uniqueBy(runs, (item) => `${item.run_kind}:${item.run_id}`, "required check runs");
  for (const requirement of requirements) {
    assertString(requirement.context, "requirement.context", 255);
    assertEnum(requirement.app_binding, ["PINNED", "EXPLICITLY_UNBOUND"], "app_binding");
    if (requirement.app_binding === "PINNED") {
      assertId(requirement.required_app_id, "required_app_id");
    } else if (requirement.required_app_id !== null) {
      fail("INVALID_INPUT", "explicitly unbound requirement must have null app ID");
    }
    const bindingSources = assertArray(
      requirement.binding_sources,
      "requirement.binding_sources",
    );
    if (bindingSources.length === 0) {
      fail("INVALID_INPUT", "requirement must retain at least one binding source");
    }
    for (const source of bindingSources) {
      assertEnum(
        source.kind,
        ["APPLICABLE_RULES", "CLASSIC_BRANCH_PROTECTION"],
        "requirement binding source kind",
      );
      assertString(source.field, "requirement binding source field", 500);
      assertEnum(
        source.raw_representation,
        ["POSITIVE_INTEGER", "NEGATIVE_ONE", "NULL", "ABSENT"],
        "requirement raw representation",
      );
    }
  }
  for (const run of runs) {
    assertId(run.run_id, "run_id");
    assertEnum(run.run_kind, ["CHECK_RUN", "COMMIT_STATUS"], "run_kind");
    assertString(run.context, "run.context", 255);
    assertSha(run.head_sha, "run.head_sha");
    timestampMs(run.started_at, "run.started_at");
    assertString(run.status, "run.status", 100);
    if (run.run_kind === "CHECK_RUN") {
      assertId(run.app_id, "run.app_id");
      if (run.app_id_source !== "CHECK_RUN_APP_ID") {
        fail("INVALID_INPUT", "check run must use CHECK_RUN_APP_ID");
      }
    } else if (run.app_id !== null || run.app_id_source !== "COMMIT_STATUS_UNAVAILABLE") {
      fail("INVALID_INPUT", "commit status cannot claim an App ID");
    }
    if (run.status === "COMPLETED") {
      timestampMs(run.completed_at, "run.completed_at");
      if (run.conclusion !== null) {
        assertString(run.conclusion, "run.conclusion", 100);
      }
    } else if (
      [
        "QUEUED",
        "IN_PROGRESS",
        "WAITING",
        "REQUESTED",
        "PENDING",
      ].includes(run.status) &&
      (run.completed_at !== null || run.conclusion !== null)
    ) {
      fail("INVALID_INPUT", "non-completed run must have null completion fields");
    }
  }
  if (requiredChecks.collection.status !== "COMPLETE") {
    return;
  }
  const runSources = requiredChecks.collection.run_sources ?? [];
  for (const kind of ["CHECK_RUN", "COMMIT_STATUS"]) {
    const source = runSources.find((entry) => entry.kind === kind);
    const count = runs.filter((run) => run.run_kind === kind).length;
    if (
      !source ||
      source.status !== "COMPLETE" ||
      source.pagination_complete !== true ||
      source.item_count !== count ||
      (kind === "CHECK_RUN" && source.reported_total_count !== count) ||
      (kind === "COMMIT_STATUS" && source.reported_total_count !== null)
    ) {
      fail("INVALID_INPUT", `${kind} collection counts are inconsistent`);
    }
  }
  const checkRunSource = runSources.find((source) => source.kind === "CHECK_RUN");
  if (!checkRunSource.endpoint.includes("filter=all")) {
    fail("INVALID_INPUT", "check-run collection must use filter=all");
  }
  const branchSource = requiredChecks.collection.policy_sources?.find(
    (source) => source.kind === "BRANCH_METADATA",
  );
  assertSha(branchSource?.branch_tip_sha, "BRANCH_METADATA.branch_tip_sha");
  if (typeof branchSource.protected !== "boolean") {
    fail("INVALID_INPUT", "BRANCH_METADATA.protected must be boolean");
  }
  const policySources = requiredChecks.collection.policy_sources;
  const classicSource = policySources.find(
    (source) => source.kind === "CLASSIC_BRANCH_PROTECTION",
  );
  if (branchSource.protected && !classicSource) {
    fail(
      "INVALID_INPUT",
      "protected branches require an explicit classic-protection source",
    );
  }
  const applicableRulesContributed =
    requirements.some((requirement) =>
      requirement.binding_sources.some(
        (source) => source.kind === "APPLICABLE_RULES",
      ),
    ) ||
    requiredChecks.strict_policy.sources.some(
      (source) => source.kind === "APPLICABLE_RULES",
    );
  if (!classicSource && applicableRulesContributed) {
    fail(
      "INVALID_INPUT",
      "classic protection may be omitted only for an unprotected branch with empty applicable rules",
    );
  }
  if (classicSource?.result === "NOT_CONFIGURED") {
    const encodedRepository =
      `/repos/${encodeURIComponent(target.owner)}/` +
      encodeURIComponent(target.repo);
    const expectedClassicEndpoint =
      `GET ${encodedRepository}/branches/` +
      `${encodeURIComponent(target.base_branch)}/protection`;
    if (
      classicSource.endpoint !== expectedClassicEndpoint ||
      classicSource.http_status !== 404
    ) {
      fail(
        "INVALID_INPUT",
        "classic-protection NOT_CONFIGURED must prove the exact target HTTP 404",
      );
    }
    const appPermission = policySources.find(
      (source) => source.kind === "GITHUB_APP_INSTALLATION_PERMISSIONS",
    );
    const oauthPermission = policySources.find(
      (source) => source.kind === "GITHUB_OAUTH_REPOSITORY_PERMISSIONS",
    );
    const appPermissionValid =
      appPermission?.result === "SUCCESS" &&
      appPermission.endpoint === `GET ${encodedRepository}/installation` &&
      appPermission.credential_type === "GITHUB_APP" &&
      appPermission.field === "permissions.administration" &&
      ["READ", "WRITE"].includes(appPermission.level);
    const oauthPermissionValid =
      oauthPermission?.result === "SUCCESS" &&
      oauthPermission.endpoint === `GET ${encodedRepository}` &&
      oauthPermission.credential_type === "OAUTH_SCOPE_TOKEN" &&
      oauthPermission.field === "x-oauth-scopes+permissions.admin" &&
      oauthPermission.level === "ADMIN" &&
      oauthPermission.scope === "repo";
    if (!appPermissionValid && !oauthPermissionValid) {
      fail(
        "INVALID_INPUT",
        "classic-protection NOT_CONFIGURED requires endpoint-specific administration proof",
      );
    }
    const classicCollectedAt = timestampMs(
      classicSource.collected_at,
      "CLASSIC_BRANCH_PROTECTION.collected_at",
    );
    const permissionFollowsClassic =
      (appPermissionValid &&
        timestampMs(
          appPermission.collected_at,
          "GITHUB_APP_INSTALLATION_PERMISSIONS.collected_at",
        ) >= classicCollectedAt) ||
      (oauthPermissionValid &&
        timestampMs(
          oauthPermission.collected_at,
          "GITHUB_OAUTH_REPOSITORY_PERMISSIONS.collected_at",
        ) >= classicCollectedAt);
    if (!permissionFollowsClassic) {
      fail(
        "INVALID_INPUT",
        "administration proof must not precede the classic-protection 404",
      );
    }
  }
  for (const source of requiredChecks.strict_policy.sources ?? []) {
    assertEnum(
      source.kind,
      ["APPLICABLE_RULES", "CLASSIC_BRANCH_PROTECTION"],
      "strict policy source kind",
    );
    assertString(source.field, "strict policy source field", 500);
    if (typeof source.value !== "boolean") {
      fail("INVALID_INPUT", "strict policy sources must identify boolean flags");
    }
  }
  if (
    requiredChecks.strict_policy.required !==
    requiredChecks.strict_policy.sources.some((source) => source.value)
  ) {
    fail("INVALID_INPUT", "strict policy provenance contradicts required flag");
  }
  for (const run of runs) {
    if (run.head_sha !== pullRequest.head_sha) {
      fail("INVALID_INPUT", "required check run is bound to another head");
    }
  }
}

/**
 * A thread's provenance has to be complete enough to replay who wrote it and
 * which formal review it belongs to, because that is what later decides
 * whether the workflow may resolve it. Partial evidence is rejected rather
 * than recorded, so an absent field can never read as an established fact.
 */
function validateThreadProvenance(thread) {
  if (thread.comments === undefined) {
    // No provenance was collected. A claim about it without the evidence
    // behind it is exactly what must not be storable.
    for (const field of [
      "comment_count",
      "comments_pagination_complete",
      "provenance_complete",
    ]) {
      if (field in thread) {
        fail(
          "INVALID_INPUT",
          `thread ${field} requires the comments it summarizes`,
        );
      }
    }
    return;
  }
  const comments = assertArray(thread.comments, "thread.comments", 1_000);
  if (thread.comments_pagination_complete !== undefined &&
      typeof thread.comments_pagination_complete !== "boolean") {
    fail("INVALID_INPUT", "thread comment pagination flag must be boolean");
  }
  if (thread.comment_count !== null) {
    assertId(thread.comment_count, "thread.comment_count");
  }
  // Both identifiers, not just one. The node ID is what the later watermark
  // and resolution joins key on, so a duplicate there would leave the identity
  // this evidence exists to establish ambiguous.
  //
  // Database-ID uniqueness is also load-bearing for the ordering rule below:
  // it is what makes (created_at, database_id) a total order, and so what
  // makes the positional root a single determined comment. Removing it as
  // redundant with the node ID would silently undo that.
  uniqueBy(comments, (comment) => comment.database_id, "thread comments");
  uniqueBy(comments, (comment) => comment.id, "thread comment node ids");
  // The root is comments[0], which is only meaningful if the sequence is
  // ordered. GitHub returns thread comments oldest first, but nothing in the
  // recorded evidence says so, and the whole thread-to-review binding hangs
  // off the first entry -- so require the order rather than assume it.
  // Ordered by creation time, then by database ID. GitHub timestamps can
  // collide, and creation time alone would leave either ordering acceptable
  // for the colliding pair -- which would let a reordered observation put a
  // reply first and bind the thread to the reply's review. The second key
  // makes the order total, so the root is a single determined comment.
  let previous = null;
  for (const comment of comments) {
    const at = timestampMs(comment.created_at, "thread comment created_at");
    const key = [at, comment.database_id];
    if (
      previous !== null &&
      (key[0] < previous[0] ||
        (key[0] === previous[0] && key[1] < previous[1]))
    ) {
      fail("INVALID_INPUT", "thread comments are not in creation order");
    }
    previous = key;
  }
  for (const comment of comments) {
    assertString(comment.id, "thread comment id", 255);
    assertId(comment.database_id, "thread comment database_id");
    timestampMs(comment.created_at, "thread comment created_at");
    timestampMs(comment.updated_at, "thread comment updated_at");
    assertObject(comment.actor, "thread comment actor");
    if (comment.review !== null) {
      const review = assertObject(comment.review, "thread comment review");
      assertString(review.id, "thread review id", 255);
      assertId(review.database_id, "thread review database_id");
      // GitHub's normalized enum, exactly: the eligibility predicate compares
      // against DISMISSED, so an unknown spelling must fail closed here rather
      // than slide past the unsupported-dismissal guard as a plain string.
      assertEnum(
        review.state,
        ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"],
        "thread review state",
      );
      assertObject(review.actor, "thread review actor");
      if (review.reviewed_head_sha !== null) {
        assertSha(review.reviewed_head_sha, "thread review reviewed_head_sha");
      }
    }
  }
  // Completeness is a recorded fact, not an admission requirement. A thread
  // deeper than one comment page, or one whose author GitHub can no longer
  // resolve, is still a real thread; refusing the whole observation for it
  // would stall the publication behind something no fix can change. It is
  // re-derived here so a caller cannot claim an eligibility it lacks.
  if (thread.provenance_complete !== threadProvenanceComplete(thread)) {
    fail(
      "INVALID_INPUT",
      "thread provenance completeness disagrees with its evidence",
    );
  }
}

function validateThreadAncestry(reviewThreads, gatedHeadSha) {
  const entries = assertArray(
    reviewThreads.ancestry ?? [],
    "review_threads.ancestry",
  );
  uniqueBy(
    entries,
    (entry) => assertString(entry.finding_head_sha, "ancestry finding head", 40),
    "thread ancestry entries",
  );
  const byHead = new Map();
  for (const entry of entries) {
    if (!/^[0-9a-f]{40}$/.test(entry.finding_head_sha ?? "")) {
      fail("INVALID_INPUT", "ancestry finding head must be a full SHA");
    }
    assertEnum(
      entry.status,
      ["AHEAD", "IDENTICAL", "BEHIND", "DIVERGED", "UNKNOWN"],
      "ancestry status",
    );
    // descends is a derivation, not a fact of its own: recompute it so a
    // caller cannot assert descent alongside a status that denies it.
    if (
      entry.descends !==
      (entry.status === "IDENTICAL" || entry.status === "AHEAD")
    ) {
      fail("INVALID_INPUT", "ancestry descent disagrees with its status");
    }
    assertString(entry.endpoint, "ancestry endpoint", 1024);
    timestampMs(entry.collected_at, "ancestry collected_at");
    byHead.set(entry.finding_head_sha, entry);
  }
  // Exactly the finding heads the threads reference, no more and no fewer. A
  // missing head would let a thread escape the descent question; an extra one
  // is evidence about nothing this observation contains. The gated head itself
  // needs no comparison and must be omitted.
  const referenced = new Set();
  for (const thread of reviewThreads.threads ?? []) {
    const head = thread.comments?.[0]?.review?.reviewed_head_sha;
    if (typeof head === "string" && head !== gatedHeadSha) {
      referenced.add(head);
    }
  }
  for (const head of referenced) {
    if (!byHead.has(head)) {
      fail("INVALID_INPUT", "thread ancestry is missing a referenced finding head");
    }
  }
  for (const head of byHead.keys()) {
    if (!referenced.has(head)) {
      fail("INVALID_INPUT", "thread ancestry covers a head no thread references");
    }
  }
  return byHead;
}

function validateThreads(reviewThreads, gatedHeadSha) {
  const threads = assertArray(reviewThreads.threads ?? [], "review_threads.threads");
  uniqueBy(threads, (thread) => assertString(thread.id, "thread.id", 255), "threads");
  for (const thread of threads) {
    if (
      typeof thread.is_resolved !== "boolean" ||
      typeof thread.is_outdated !== "boolean"
    ) {
      fail("INVALID_INPUT", "thread resolution and outdated fields must be boolean");
    }
    validateThreadProvenance(thread);
  }
  validateThreadAncestry(reviewThreads, gatedHeadSha);
  if (
    reviewThreads.total_count !== threads.length ||
    reviewThreads.unresolved_count !==
      threads.filter((thread) => thread.is_resolved === false).length
  ) {
    fail("INVALID_INPUT", "review thread counts are inconsistent");
  }
}

function validateCodexPartitions(codexReview, ledger) {
  const adapterVersion =
    ledger.codex_review_baseline.collection.adapter_version;
  const baselineRequests = assertArray(
    codexReview.preexisting_requests ?? [],
    "codex_review.preexisting_requests",
    5_000,
  );
  const baselineResults = assertArray(
    codexReview.preexisting_candidate_results ?? [],
    "codex_review.preexisting_candidate_results",
    5_000,
  );
  validateRequestFacts(
    baselineRequests,
    "codex_review.preexisting_requests",
    { baseline: true },
  );
  validateResultFacts(
    baselineResults,
    "codex_review.preexisting_candidate_results",
    {
      baseline: true,
      expectedActor: ledger.target.codex_actor,
    },
  );
  assertBaselineShape(
    baselineRequests,
    baselineResults,
    adapterVersion,
    "codex_review.preexisting_requests",
    "codex_review.preexisting_candidate_results",
  );
  const baselineConflict =
    !sameIdentitySet(
      baselineRequests,
      ledger.codex_review_baseline.requests.map(projectBaselineRequest),
    ) ||
    !sameIdentitySet(
      baselineResults,
      ledger.codex_review_baseline.candidate_results.map(projectBaselineResult),
      "result_id",
    );
  const requests = assertArray(codexReview.requests ?? [], "codex_review.requests");
  const unbound = assertArray(
    codexReview.unbound_requests ?? [],
    "codex_review.unbound_requests",
  );
  const unsupported = assertArray(
    codexReview.unsupported_requests ?? [],
    "codex_review.unsupported_requests",
  );
  const results = assertArray(codexReview.results ?? [], "codex_review.results");
  const appNotices = assertArray(
    codexReview.app_notices ?? [],
    "codex_review.app_notices",
  );
  const foreignActorObjects = assertArray(
    codexReview.foreign_actor_objects ?? [],
    "codex_review.foreign_actor_objects",
  );
  for (const [name, items] of [
    ["codex_review.app_notices", appNotices],
    ["codex_review.foreign_actor_objects", foreignActorObjects],
  ]) {
    for (const [index, item] of items.entries()) {
      assertObject(item, `${name}[${index}]`);
    }
  }
  validateRequestFacts(unbound, "codex_review.unbound_requests");
  validateRequestFacts(unsupported, "codex_review.unsupported_requests");
  for (const item of unbound) {
    if (
      adapterVersion === 2 &&
      (!isCodexRequestId(item.request_id) ||
        item.body_sha256 !==
          sha256(
            Buffer.from(
              correlatedRequestBody(item.request_id),
              "utf8",
            ),
          ))
    ) {
      fail(
        "INVALID_INPUT",
        "version 2 unbound request is not canonical",
      );
    }
    if (
      item.resource_kind !== "ISSUE_COMMENT" ||
      item.reason !== "MISSING_POST_BINDING"
    ) {
      fail("INVALID_INPUT", "unbound request must be an issue comment with MISSING_POST_BINDING");
    }
  }
  for (const item of unsupported) {
    assertEnum(
      item.reason,
      ["WRONG_RESOURCE_KIND", "NON_EXACT_TRIGGER_SHAPE"],
      "unsupported request reason",
    );
  }
  validateResultFacts(results, "codex_review.results", {
    expectedActor: ledger.target.codex_actor,
  });
  if (
    adapterVersion === 2 &&
    results.some((result) => !("request_id" in result))
  ) {
    fail("INVALID_INPUT", "version 2 results must include request_id");
  }
  const allIdentities = [];
  for (const item of [
    ...baselineRequests,
    ...baselineResults.map((result) => ({
      ...result,
      resource_id: result.result_id,
    })),
    ...requests.map((request) => ({
      ...request,
      resource_id: request.comment_id,
    })),
    ...unbound,
    ...unsupported,
    ...results.map((result) => ({ ...result, resource_id: result.result_id })),
    ...foreignActorObjects,
    ...appNotices,
  ]) {
    allIdentities.push(resourceIdentity(item));
  }
  if (new Set(allIdentities).size !== allIdentities.length) {
    fail("INVALID_INPUT", "Codex object appears in multiple adapter partitions");
  }
  for (const request of requests) {
    assertId(request.comment_id, "request.comment_id");
    const expectedBody =
      adapterVersion === 2
        ? correlatedRequestBody(request.request_id)
        : BODY_REQUEST;
    const expectedBodySha256 =
      adapterVersion === 2
        ? sha256(Buffer.from(expectedBody, "utf8"))
        : REQUEST_BODY_SHA256;
    if (
      request.resource_kind !== "ISSUE_COMMENT" ||
      request.body !== expectedBody ||
      request.body_sha256 !== expectedBodySha256 ||
      request.timestamp_field !== "created_at"
    ) {
      fail("INVALID_INPUT", "recognized request is not the exact workflow issue comment");
    }
    assertSha(request.requested_head_sha, "request.requested_head_sha");
  }
  for (const foreign of foreignActorObjects) {
    assertUrl(foreign.url, "foreign_actor_object.url");
    timestampMs(foreign.event_at, "foreign_actor_object.event_at");
    assertObject(foreign.actor, "foreign_actor_object.actor");
    assertId(foreign.actor.id, "foreign_actor_object.actor.id");
    assertString(foreign.actor.type, "foreign_actor_object.actor.type", 100);
    if (
      foreign.actor.id === ledger.target.codex_actor.id &&
      foreign.actor.type === ledger.target.codex_actor.type
    ) {
      fail(
        "INVALID_INPUT",
        "pinned Codex actor cannot appear in the foreign partition",
      );
    }
    assertDigest(foreign.body_sha256, "foreign_actor_object.body_sha256");
  }
  for (const notice of appNotices) {
    assertUrl(notice.url, "app_notice.url");
    timestampMs(notice.event_at, "app_notice.event_at");
    if (
      notice.timestamp_field !==
      (notice.resource_kind === "PULL_REQUEST_REVIEW"
        ? "submitted_at"
        : "created_at")
    ) {
      fail("INVALID_INPUT", "app notice has wrong timestamp_field");
    }
    assertEnum(
      notice.marker,
      ["codex-pull-request-review-summary", "codex-environment-notice"],
      "app_notice.marker",
    );
    assertDigest(notice.body_sha256, "app_notice.body_sha256");
    assertString(notice.body, "app_notice.body");
    if (sha256(Buffer.from(notice.body, "utf8")) !== notice.body_sha256) {
      fail("INVALID_INPUT", "app notice body does not match its digest");
    }
    if (codexAppNoticeMarker(notice.body) !== notice.marker) {
      fail("INVALID_INPUT", "app notice body does not carry its marker");
    }
    assertObject(notice.actor, "app_notice.actor");
    if (
      notice.actor.id !== ledger.target.codex_actor.id ||
      notice.actor.type !== ledger.target.codex_actor.type
    ) {
      fail(
        "INVALID_INPUT",
        "app notice must carry the pinned Codex actor",
      );
    }
  }
  return baselineConflict
    ? "immutable Codex baseline object disappeared or changed"
    : null;
}

function projectBaselineRequest(item) {
  const { classification: _classification, reason: _reason, ...facts } = item;
  return facts;
}

function projectBaselineResult(item) {
  const {
    classification: _classification,
    reason: _reason,
    ...facts
  } = item;
  return facts;
}

function baselineRequestClassification(request, adapterVersion) {
  if (
    adapterVersion === 2 &&
    request.resource_kind === "ISSUE_COMMENT" &&
    isCodexRequestId(request.request_id) &&
    request.body_sha256 ===
      sha256(Buffer.from(correlatedRequestBody(request.request_id), "utf8"))
  ) {
    return { classification: "BASELINE_CORRELATED", reason: null };
  }
  if (
    request.resource_kind === "ISSUE_COMMENT" &&
    request.body_sha256 === REQUEST_BODY_SHA256
  ) {
    return { classification: "BASELINE_EXACT", reason: null };
  }
  return {
    classification: "BASELINE_UNSUPPORTED",
    reason:
      adapterVersion === 1 &&
      request.body_sha256 !== REQUEST_BODY_SHA256
        ? "NON_EXACT_TRIGGER_SHAPE"
        : request.resource_kind !== "ISSUE_COMMENT"
        ? "WRONG_RESOURCE_KIND"
        : "NON_EXACT_TRIGGER_SHAPE",
  };
}

function normalizeBaseline(baseline, recordedAt, issuances = new Map()) {
  const adapterVersion = baseline.collection.adapter_version;
  return {
    ...baseline,
    recorded_at: recordedAt,
    requests: baseline.requests.map((request) => ({
      ...request,
      ...(issuances.has(resourceIdentity(request))
        ? { issuance: issuances.get(resourceIdentity(request)) }
        : {}),
      ...baselineRequestClassification(request, adapterVersion),
    })),
    candidate_results: baseline.candidate_results.map((result) => ({
      ...result,
      classification: "BASELINE_CANDIDATE_RESULT",
      reason: null,
    })),
  };
}

const PUBLICATION_STATUSES = [
  "PR_PENDING",
  "EVIDENCE_INCOMPLETE",
  "PR_DRAFT",
  "PR_STATE_PENDING",
  "PR_CONFLICTING",
  "PR_UPDATE_REQUIRED",
  "CHECKS_PENDING",
  "CHECKS_FAILED",
  "GITHUB_REVIEW_UNKNOWN",
  "GITHUB_REVIEW_NOT_REQUESTED",
  "GITHUB_REVIEW_PENDING",
  "CHANGES_REQUIRED",
  "MERGE_READY",
  "INVALIDATED",
  "CLOSED",
  "MERGED",
];

function authorizationForLedger(ledger) {
  if (ledger.version === 1) {
    return {
      mode: "LOCAL_GATE",
      head_sha: ledger.local_gate.head_sha,
      base_sha: ledger.local_gate.base_sha,
      snapshot_hash: ledger.local_gate.snapshot_hash,
      source_sha256: ledger.local_gate.gate_sha256,
      reviewer_provider:
        ledger.local_gate.reviewer_provider ?? "CLAUDE_DESKTOP",
      acknowledgement: null,
      operator_label: null,
      rationale: null,
      authorized_at: null,
    };
  }
  return {
    ...ledger.authorization,
    reviewer_provider:
      ledger.authorization.mode === "LOCAL_GATE"
        ? ledger.authorization.reviewer_provider ?? "CLAUDE_DESKTOP"
        : null,
  };
}

/**
 * Revalidate a version-3 ledger's workflow binding against the workflow ledger
 * itself. Every caller runs this independently: start, snapshot recording, the
 * autonomous projection, finalization, and gate verification each re-derive the
 * digest from the workflow file rather than trusting an earlier check or the
 * copy stored in the gate.
 *
 * Returns null for version 1 and 2, which never bind a workflow.
 */
/**
 * @param {boolean} mutating whether the caller is about to write. A mutator
 * refuses a superseded publication outright; a read reports it as INVALIDATED
 * through `workflowHeadConflict` so the ledger stays inspectable.
 */
async function requireWorkflowBinding(storeRoot, ledger, { mutating = false } = {}) {
  if (ledger.version !== 3) {
    return null;
  }
  const binding = await readWorkflowBinding(storeRoot, ledger.workflow_id);
  if (
    binding.workflow_id !== ledger.workflow_id ||
    binding.workflow_authorization_sha256 !==
      ledger.workflow_authorization_sha256
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_MISMATCH",
      "publication workflow authorization does not match the workflow ledger",
    );
  }
  // Cancellation is the operator's kill switch, so it has to revoke what it
  // authorized: a cancelled workflow's publication must stop projecting,
  // recording, finalizing, and verifying. A paused workflow is still live and
  // stays readable. `get_publication` takes no binding, so the audit trail of
  // a cancelled workflow remains readable either way.
  if (binding.status === "CANCELLED") {
    fail(
      "WORKFLOW_CANCELLED",
      "the workflow that authorized this publication was cancelled",
    );
  }
  const authorized = binding.publication_target;
  const target = ledger.target;
  if (
    authorized.base_repository_id !== target.repository_id ||
    authorized.base_owner !== target.owner ||
    authorized.base_repo !== target.repo ||
    authorized.base_branch !== target.base_branch ||
    authorized.head_branch !== target.head_branch
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_MISMATCH",
      "publication target does not match the authorized workflow publication target",
    );
  }
  if (
    binding.pull_request == null ||
    binding.pull_request.repository_id !== target.repository_id ||
    binding.pull_request.pr_number !== target.pr_number
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_MISMATCH",
      "publication pull request is not the workflow-owned pull request",
    );
  }
  if (mutating && workflowHeadConflict(binding, ledger) != null) {
    fail(
      "PUBLICATION_SUPERSEDED",
      "the workflow recorded a later head, so this publication can no longer be written to",
    );
  }
  return binding;
}

/**
 * A publication is superseded the moment its workflow records a later head.
 *
 * The pull-request identity check in derivePublication only catches head drift
 * from the pull-request side, which leaves the window between a repair commit
 * and its push: the workflow has moved on and cleared its binding, but the pull
 * request still carries the old head, so every other invariant still agrees and
 * the abandoned ledger would keep projecting READY_TO_MARK and could still mint
 * a gate for a head the workflow has replaced.
 *
 * Reads report this as INVALIDATED rather than throwing, so a superseded ledger
 * stays inspectable; mutators refuse outright.
 */
function workflowHeadConflict(binding, ledger) {
  if (binding == null) {
    return null;
  }
  const authorization = authorizationForLedger(ledger);
  if (binding.current_head_sha === authorization.head_sha) {
    return null;
  }
  return "workflow head advanced past the publication authorization";
}

/**
 * Validate the workflow a new autonomous publication is about to bind. Start is
 * the one site that also pins the workflow's revision, phase, and current head:
 * later sites must stay readable after the workflow moves on, and report a
 * stale ledger through the ordinary INVALIDATED decision instead of throwing.
 */
async function requireStartWorkflowBinding(
  storeRoot,
  workflowId,
  {
    expectedWorkflowRevision,
    headSha,
    repositoryId,
    owner,
    repo,
    prNumber,
    baseBranch,
    headBranch,
    authorizationMode,
  },
) {
  if (authorizationMode !== "LOCAL_GATE") {
    fail(
      "INVALID_INPUT",
      "an autonomous publication requires a LOCAL_GATE authorization",
    );
  }
  const binding = await readWorkflowBinding(storeRoot, workflowId);
  if (binding.revision !== expectedWorkflowRevision) {
    fail("WORKFLOW_REVISION_CONFLICT", "workflow revision changed", {
      expected: expectedWorkflowRevision,
      actual: binding.revision,
      retryable: true,
    });
  }
  if (binding.status !== "ACTIVE") {
    fail("WORKFLOW_NOT_ACTIVE", `workflow is ${binding.status}`);
  }
  if (binding.phase !== "START_PUBLICATION") {
    fail(
      "WORKFLOW_PHASE_INVALID",
      `workflow phase ${binding.phase} cannot start a publication`,
    );
  }
  if (binding.current_head_sha !== headSha) {
    fail(
      "WORKFLOW_HEAD_MISMATCH",
      "publication authorization head is not the current workflow head",
    );
  }
  const authorized = binding.publication_target;
  if (
    authorized.base_repository_id !== repositoryId ||
    authorized.base_owner !== owner ||
    authorized.base_repo !== repo ||
    authorized.base_branch !== baseBranch ||
    authorized.head_branch !== headBranch
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_MISMATCH",
      "publication target does not match the authorized workflow publication target",
    );
  }
  if (
    binding.pull_request == null ||
    binding.pull_request.repository_id !== repositoryId ||
    binding.pull_request.pr_number !== prNumber
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_MISMATCH",
      "publication pull request is not the workflow-owned pull request",
    );
  }
  return binding;
}

function requireStoredReviewId(ledger, reviewId) {
  if (ledger.review_id !== reviewId) {
    fail(
      "PUBLICATION_STORE_INVALID",
      "publication review_id does not match the requested review",
    );
  }
}

function validateStoredLedger(ledger) {
  assertObject(ledger, "publication");
  if (!SUPPORTED_PUBLICATION_VERSIONS.includes(ledger.version)) {
    fail(
      "UNSUPPORTED_PUBLICATION_VERSION",
      "only publication schema versions 1, 2, and 3 are supported",
    );
  }
  assertRevision(ledger.revision);
  publicationDirectory("/store", ledger.review_id);
  timestampMs(ledger.created_at, "publication.created_at");
  timestampMs(ledger.updated_at, "publication.updated_at");
  if (ledger.version === 3) {
    if (
      typeof ledger.workflow_id !== "string" ||
      !WORKFLOW_ID_RE.test(ledger.workflow_id)
    ) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "version 3 publication workflow_id is invalid",
      );
    }
    assertDigest(
      ledger.workflow_authorization_sha256,
      "publication.workflow_authorization_sha256",
    );
    // A version-3 ledger written before automatic resolution has no array;
    // it reads as none recorded, exactly like an empty one.
    const resolutions = ledger.automatic_resolutions ?? [];
    if (!Array.isArray(resolutions)) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "publication.automatic_resolutions is malformed",
      );
    }
    // A thread may carry several records once a proven successor supersedes
    // its predecessor (RFC 0003 "Automatic thread resolution"). Supersession
    // is a read-side replay concern, so this validator is structural only:
    // which record is active, and whether the chain is sound, is decided by
    // `resolutionFrontier` when a projection or gate evaluates the ledger.
    for (const [index, record] of resolutions.entries()) {
      assertObject(record, "automatic-resolution record");
      if (record.number !== index + 1) {
        fail(
          "PUBLICATION_STORE_INVALID",
          "automatic-resolution numbers must be sequential",
        );
      }
      assertString(record.action_id, "automatic-resolution action_id", 1024);
      assertString(record.thread_id, "automatic-resolution thread_id", 1024);
      assertDigest(
        record.thread_watermark,
        "automatic-resolution thread_watermark",
      );
      assertDigest(
        record.eligibility_sha256,
        "automatic-resolution eligibility_sha256",
      );
      assertSha(record.head_sha, "automatic-resolution head_sha");
      assertObject(record.actor, "automatic-resolution actor");
      assertId(record.actor.id, "automatic-resolution actor id");
      assertString(record.actor.type, "automatic-resolution actor type", 100);
      assertId(record.reply_comment_id, "automatic-resolution reply_comment_id");
      const preRead = assertObject(
        record.pre_read,
        "automatic-resolution pre_read",
      );
      timestampMs(preRead.observed_at, "automatic-resolution pre_read observed_at");
      const postRead = assertObject(
        record.post_read,
        "automatic-resolution post_read",
      );
      timestampMs(
        postRead.observed_at,
        "automatic-resolution post_read observed_at",
      );
      const resolvedBy = assertObject(
        postRead.resolved_by,
        "automatic-resolution resolved_by",
      );
      // The record is only ever the proven shape: an unresolved pre-read, a
      // resolved post-read on the same watermark, and the workflow's own
      // actor as the resolver. Any other combination is not storable.
      if (
        preRead.is_resolved !== false ||
        postRead.is_resolved !== true ||
        resolvedBy.id !== record.actor.id ||
        resolvedBy.type !== record.actor.type
      ) {
        fail(
          "PUBLICATION_STORE_INVALID",
          "automatic-resolution record does not prove an owned transition",
        );
      }
      timestampMs(record.recorded_at, "automatic-resolution recorded_at");
      assertRevision(record.recorded_revision);
    }
    // Lifecycle events are the supersession chain's audit trail: an
    // invalidation, the compensating unresolve, and the supersession that
    // retires the predecessor. The writer ships with the compensating-unresolve
    // rollout; this validator is structural so a chain is storable and the
    // terminal replay (which decides what is active) can report a broken one
    // fail-closed instead of refusing to read it.
    const lifecycle = ledger.resolution_lifecycle ?? [];
    if (!Array.isArray(lifecycle)) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "publication.resolution_lifecycle is malformed",
      );
    }
    for (const [index, event] of lifecycle.entries()) {
      assertObject(event, "resolution-lifecycle event");
      if (event.number !== index + 1) {
        fail(
          "PUBLICATION_STORE_INVALID",
          "resolution-lifecycle numbers must be sequential",
        );
      }
      assertString(event.thread_id, "resolution-lifecycle thread_id", 1024);
      timestampMs(event.at, "resolution-lifecycle at");
      if (event.kind === "INVALIDATED") {
        assertString(event.record_id, "resolution-lifecycle record_id", 1024);
        assertDigest(
          event.prior_watermark,
          "resolution-lifecycle prior_watermark",
        );
        assertDigest(event.new_watermark, "resolution-lifecycle new_watermark");
        if (!Array.isArray(event.follow_up_comments)) {
          fail(
            "PUBLICATION_STORE_INVALID",
            "resolution-lifecycle follow_up_comments is malformed",
          );
        }
        for (const comment of event.follow_up_comments) {
          assertObject(comment, "resolution-lifecycle follow-up comment");
          assertId(comment.comment_id, "resolution-lifecycle comment_id");
          assertObject(comment.actor, "resolution-lifecycle comment actor");
          assertId(comment.actor.id, "resolution-lifecycle comment actor id");
          assertString(
            comment.actor.type,
            "resolution-lifecycle comment actor type",
            100,
          );
          timestampMs(
            comment.created_at,
            "resolution-lifecycle comment created_at",
          );
        }
        assertString(event.reason, "resolution-lifecycle reason", 1024);
      } else if (event.kind === "UNRESOLVED_FOR_REPAIR") {
        assertString(event.record_id, "resolution-lifecycle record_id", 1024);
        assertString(event.action_id, "resolution-lifecycle action_id", 1024);
      } else if (event.kind === "SUPERSEDES") {
        assertString(
          event.predecessor_id,
          "resolution-lifecycle predecessor_id",
          1024,
        );
        assertString(
          event.successor_id,
          "resolution-lifecycle successor_id",
          1024,
        );
        if (
          !Number.isSafeInteger(event.invalidation_event) ||
          event.invalidation_event < 1 ||
          !Number.isSafeInteger(event.unresolve_event) ||
          event.unresolve_event < 1
        ) {
          fail(
            "PUBLICATION_STORE_INVALID",
            "resolution-lifecycle SUPERSEDES event bindings are invalid",
          );
        }
      } else {
        fail(
          "PUBLICATION_STORE_INVALID",
          "resolution-lifecycle event kind is invalid",
        );
      }
    }
  } else if (
    "workflow_id" in ledger ||
    "workflow_authorization_sha256" in ledger ||
    "automatic_resolutions" in ledger ||
    "resolution_lifecycle" in ledger
  ) {
    fail(
      "PUBLICATION_STORE_INVALID",
      "only a version 3 publication may bind an autonomous workflow",
    );
  }
  if (ledger.version === 1) {
    assertObject(ledger.local_gate, "publication.local_gate");
    assertSha(ledger.local_gate.head_sha, "publication.local_gate.head_sha");
    assertSha(ledger.local_gate.base_sha, "publication.local_gate.base_sha");
    assertDigest(
      ledger.local_gate.snapshot_hash,
      "publication.local_gate.snapshot_hash",
    );
    assertDigest(
      ledger.local_gate.gate_sha256,
      "publication.local_gate.gate_sha256",
    );
    assertEnum(
      ledger.local_gate.reviewer_provider ?? "CLAUDE_DESKTOP",
      REVIEWER_PROVIDERS,
      "publication.local_gate.reviewer_provider",
    );
  } else {
    if ("local_gate" in ledger) {
      fail("PUBLICATION_STORE_INVALID", "version 2 publication cannot contain local_gate");
    }
    const authorization = assertObject(
      ledger.authorization,
      "publication.authorization",
    );
    assertEnum(
      authorization.mode,
      ["LOCAL_GATE", "REMOTE_ONLY"],
      "publication.authorization.mode",
    );
    assertSha(authorization.head_sha, "publication.authorization.head_sha");
    assertSha(authorization.base_sha, "publication.authorization.base_sha");
    assertDigest(
      authorization.source_sha256,
      "publication.authorization.source_sha256",
    );
    if (authorization.mode === "LOCAL_GATE") {
      assertEnum(
        authorization.reviewer_provider ?? "CLAUDE_DESKTOP",
        REVIEWER_PROVIDERS,
        "publication.authorization.reviewer_provider",
      );
      assertDigest(
        authorization.snapshot_hash,
        "publication.authorization.snapshot_hash",
      );
      if (
        authorization.acknowledgement !== null ||
        authorization.operator_label !== null ||
        authorization.rationale !== null ||
        authorization.authorized_at !== null
      ) {
        fail(
          "PUBLICATION_STORE_INVALID",
          "local-gate authorization cannot contain a remote-only acknowledgement",
        );
      }
    } else {
      if ((authorization.reviewer_provider ?? null) !== null) {
        fail(
          "PUBLICATION_STORE_INVALID",
          "remote-only authorization cannot contain a reviewer provider",
        );
      }
      if (authorization.snapshot_hash !== null) {
        fail(
          "PUBLICATION_STORE_INVALID",
          "remote-only authorization cannot contain a snapshot hash",
        );
      }
      if (authorization.acknowledgement !== "LOCAL_REVIEW_SKIPPED") {
        fail(
          "PUBLICATION_STORE_INVALID",
          "remote-only authorization acknowledgement changed",
        );
      }
      assertString(
        authorization.operator_label,
        "publication.authorization.operator_label",
        500,
      );
      assertString(
        authorization.rationale,
        "publication.authorization.rationale",
        20_000,
      );
      timestampMs(
        authorization.authorized_at,
        "publication.authorization.authorized_at",
      );
    }
  }
  const publicationAuthorization = authorizationForLedger(ledger);
  const target = assertObject(ledger.target, "publication.target");
  assertId(target.repository_id, "publication.target.repository_id");
  assertId(target.pr_number, "publication.target.pr_number");
  assertString(target.owner, "publication.target.owner", 255);
  assertString(target.repo, "publication.target.repo", 255);
  assertString(target.base_branch, "publication.target.base_branch", 255);
  assertString(target.head_branch, "publication.target.head_branch", 255);
  assertObject(target.codex_actor, "publication.target.codex_actor");
  assertId(target.codex_actor.id, "publication.target.codex_actor.id");
  if (target.codex_actor.type !== "Bot") {
    fail("PUBLICATION_STORE_INVALID", "stored Codex actor must have type Bot");
  }
  assertString(
    target.codex_actor.login_at_start,
    "publication.target.codex_actor.login_at_start",
    255,
  );
  assertObject(
    target.codex_trigger_policy,
    "publication.target.codex_trigger_policy",
  );
  assertEnum(
    target.codex_trigger_policy.mode,
    ["EXPLICIT_ONLY", "AUTOMATIC_QUIESCENCE_ACKNOWLEDGED"],
    "publication.target.codex_trigger_policy.mode",
  );
  const baseline = assertObject(
    ledger.codex_review_baseline,
    "publication.codex_review_baseline",
  );
  if (![1, 2].includes(baseline.collection?.adapter_version)) {
    fail("PUBLICATION_STORE_INVALID", "stored baseline adapter version changed");
  }
  assertArray(baseline.requests, "publication baseline requests", 5_000);
  assertArray(
    baseline.candidate_results,
    "publication baseline results",
    5_000,
  );
  validateRequestFacts(baseline.requests, "publication baseline requests", {
    baseline: true,
  });
  validateResultFacts(
    baseline.candidate_results,
    "publication baseline results",
    { baseline: true, expectedActor: target.codex_actor },
  );
  if (
    baseline.collection.adapter_version === 2 &&
    (baseline.requests.some((request) => !("request_id" in request)) ||
      baseline.candidate_results.some((result) => !("request_id" in result)))
  ) {
    fail(
      "PUBLICATION_STORE_INVALID",
      "stored adapter version 2 baseline is missing request_id",
    );
  }
  for (const request of baseline.requests) {
    const expected = baselineRequestClassification(
      request,
      baseline.collection.adapter_version,
    );
    if (
      request.classification !== expected.classification ||
      request.reason !== expected.reason
    ) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "stored baseline request classification changed",
      );
    }
  }
  const requestHistory = assertArray(
    ledger.codex_request_history,
    "publication request history",
  );
  uniqueBy(
    requestHistory,
    (item) => resourceIdentity(item),
    "publication request history",
  );
  for (const item of requestHistory) {
    assertEnum(
      item.classification,
      ["RECOGNIZED", "UNBOUND", "UNSUPPORTED"],
      "request history classification",
    );
    assertEnum(
      item.binding_source,
      ["RECORDED_AT_POST", "OBSERVED_UNBOUND", "OBSERVED_UNSUPPORTED"],
      "request history binding_source",
    );
    assertUrl(item.url, "request history url");
    timestampMs(item.event_at, "request history event_at");
    timestampMs(item.recorded_at, "request history recorded_at");
    assertDigest(item.body_sha256, "request history body_sha256");
    if (
      !Number.isSafeInteger(item.recorded_revision) ||
      item.recorded_revision < 1 ||
      item.recorded_revision > ledger.revision
    ) {
      fail("PUBLICATION_STORE_INVALID", "request history revision is invalid");
    }
    if (item.classification === "RECOGNIZED") {
      assertSha(item.requested_head_sha, "request history requested_head_sha");
      if (
        baseline.collection.adapter_version === 2 &&
        !isCodexRequestId(item.request_id)
      ) {
        fail(
          "PUBLICATION_STORE_INVALID",
          "version 2 recognized request_id is invalid",
        );
      }
    } else if (
      baseline.collection.adapter_version === 2 &&
      item.classification === "UNBOUND" &&
      (!isCodexRequestId(item.request_id) ||
        item.body_sha256 !==
          sha256(
            Buffer.from(
              correlatedRequestBody(item.request_id),
              "utf8",
            ),
          ))
    ) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "stored version 2 unbound request is not canonical",
      );
    } else if (item.requested_head_sha !== null) {
      fail("PUBLICATION_STORE_INVALID", "unbound request history cannot carry a head");
    }
  }
  const resultHistory = assertArray(
    ledger.codex_result_history,
    "publication result history",
  );
  validateResultFacts(resultHistory, "publication result history", {
    baseline: true,
    expectedActor: target.codex_actor,
  });
  const acknowledgements = assertArray(
    ledger.codex_review_ambiguity_acknowledgements,
    "publication acknowledgements",
    1_000,
  );
  for (const item of acknowledgements) {
    assertString(item.acknowledgement_id, "acknowledgement_id", 255);
    assertSha(item.head_sha, "acknowledgement head_sha");
    assertArray(item.closed_requests, "acknowledgement closed_requests", 1_000);
    assertArray(item.closed_results, "acknowledgement closed_results", 1_000);
    if (item.acknowledgement !== "NO_FURTHER_RESULTS_EXPECTED") {
      fail("PUBLICATION_STORE_INVALID", "stored acknowledgement enum changed");
    }
    assertDigest(
      item.backing_observation_sha256,
      "acknowledgement backing_observation_sha256",
    );
    timestampMs(item.acknowledged_at, "acknowledgement acknowledged_at");
  }
  const history = assertArray(ledger.history, "publication history");
  if (history.length === 0 || history.length > 10_000) {
    fail("PUBLICATION_STORE_INVALID", "publication history length is invalid");
  }
  for (const [index, event] of history.entries()) {
    assertEnum(
      event.event,
      [
        "PUBLICATION_STARTED",
        "CODEX_REVIEW_REQUEST_RECORDED",
        "GITHUB_SNAPSHOT_RECORDED",
        "CODEX_REVIEW_AMBIGUITY_ACKNOWLEDGED",
        "AUTOMATIC_RESOLUTION_RECORDED",
        "AUTOMATIC_RESOLUTION_UNRESOLVED",
      ],
      "publication history event",
    );
    if (event.revision !== index + 1) {
      fail("PUBLICATION_STORE_INVALID", "publication history revisions are not contiguous");
    }
    timestampMs(event.at, "publication history at");
    assertEnum(event.status, PUBLICATION_STATUSES, "publication history status");
    if (event.head_sha !== publicationAuthorization.head_sha) {
      fail("PUBLICATION_STORE_INVALID", "publication history head changed");
    }
    // These mutating events clear the observation: a posted request or a
    // thread resolution-state change makes the prior pull-request snapshot
    // stale.
    if (
      event.event === "CODEX_REVIEW_REQUEST_RECORDED" ||
      event.event === "AUTOMATIC_RESOLUTION_RECORDED" ||
      event.event === "AUTOMATIC_RESOLUTION_UNRESOLVED"
    ) {
      if (event.cleared_observation_sha256 !== null) {
        assertDigest(
          event.cleared_observation_sha256,
          "request history cleared_observation_sha256",
        );
      }
    } else if ("cleared_observation_sha256" in event) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "only request or thread-mutation history may carry cleared_observation_sha256",
      );
    }
    if (
      event.event === "AUTOMATIC_RESOLUTION_RECORDED" ||
      event.event === "AUTOMATIC_RESOLUTION_UNRESOLVED"
    ) {
      assertString(event.thread_id, "resolution history thread_id", 1024);
    } else if ("thread_id" in event) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "only resolution-recorded history may carry thread_id",
      );
    }
    if (event.event === "AUTOMATIC_RESOLUTION_UNRESOLVED") {
      assertString(event.record_id, "unresolve history record_id", 1024);
      assertString(event.action_id, "unresolve history action_id", 1024);
    } else if ("record_id" in event || "action_id" in event) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "only unresolve history may carry record_id and action_id",
      );
    }
  }
  if (
    history.at(-1).revision !== ledger.revision ||
    history.at(-1).at !== ledger.updated_at
  ) {
    fail("PUBLICATION_STORE_INVALID", "publication revision cursor is inconsistent");
  }
  assertEnum(ledger.status, PUBLICATION_STATUSES, "publication status");
  if (ledger.terminal != null) {
    assertObject(ledger.terminal, "publication terminal");
    assertEnum(
      ledger.terminal.status,
      ["INVALIDATED", "CLOSED", "MERGED"],
      "publication terminal status",
    );
    if (
      ledger.status !== ledger.terminal.status ||
      ledger.terminal.revision !== ledger.revision
    ) {
      fail("PUBLICATION_STORE_INVALID", "terminal cursor is inconsistent");
    }
  } else if (TERMINAL_STATUSES.has(ledger.status)) {
    fail("PUBLICATION_STORE_INVALID", "terminal status is missing its terminal record");
  }
  assertLedgerSize(ledger);
}

function runGit(repositoryPath, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) {
    fail("LOCAL_REPOSITORY_ERROR", `git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function readLocalGate(paths, reviewId, { verifyRepository = false } = {}) {
  const opened = await readSecureFile(paths.localGate, {
    maxBytes: 1024 * 1024,
    requiredMode: 0o600,
  });
  try {
    return await validateOpenedLocalGate(paths, reviewId, opened, {
      verifyRepository,
    });
  } finally {
    await opened.handle.close();
  }
}

async function validateOpenedLocalGate(
  paths,
  reviewId,
  opened,
  { verifyRepository = false } = {},
) {
  const gate = parseJsonObject(
    opened.bytes,
    "LOCAL_GATE_INVALID",
    "local gate is not a JSON object",
  );
  if (
    gate.version !== 1 ||
    gate.review_id !== reviewId ||
    gate.status !== "LOCAL_GATE_PASSED"
  ) {
    fail("LOCAL_GATE_INVALID", "local gate is not a version 1 LOCAL_GATE_PASSED gate");
  }
  assertSha(gate.head_sha, "local_gate.head_sha");
  assertSha(gate.base_sha, "local_gate.base_sha");
  assertDigest(gate.snapshot_hash, "local_gate.snapshot_hash");
  const review = await loadReview(path.dirname(path.dirname(paths.directory)), reviewId);
  if (review.status !== "LOCAL_GATE_PASSED") {
    fail("LOCAL_GATE_INVALID", `review status is ${review.status}`);
  }
  const reviewProvider = review.reviewer_provider ?? "CLAUDE_DESKTOP";
  const gateProvider = gate.reviewer_provider ?? "CLAUDE_DESKTOP";
  if (
    !REVIEWER_PROVIDERS.includes(reviewProvider) ||
    !REVIEWER_PROVIDERS.includes(gateProvider) ||
    gateProvider !== reviewProvider
  ) {
    fail("LOCAL_GATE_INVALID", "local gate reviewer provider does not match review");
  }
  if (verifyRepository) {
    const head = runGit(review.repository_path, ["rev-parse", "HEAD^{commit}"]);
    const dirty = runGit(review.repository_path, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (head !== gate.head_sha) {
      fail("LOCAL_HEAD_MISMATCH", "local HEAD differs from the local gate");
    }
    if (dirty !== "") {
      fail("LOCAL_WORKTREE_DIRTY", "local working tree must be clean");
    }
  }
  return {
    gate: { ...gate, reviewer_provider: gateProvider },
    gate_sha256: sha256(opened.bytes),
    review,
  };
}

function normalizedLocalGate(localGate) {
  return {
    mode: "LOCAL_GATE",
    head_sha: localGate.gate.head_sha,
    base_sha: localGate.gate.base_sha,
    snapshot_hash: localGate.gate.snapshot_hash,
    source_sha256: localGate.gate_sha256,
    reviewer_provider: localGate.gate.reviewer_provider,
    acknowledgement: null,
    operator_label: null,
    rationale: null,
    authorized_at: null,
    repository_path: localGate.review.repository_path,
  };
}

function verifyRemoteRepository(authorization) {
  let base;
  try {
    base = runGit(authorization.repository_path, [
      "rev-parse",
      `${authorization.base_sha}^{commit}`,
    ]);
  } catch {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "base_sha is not an available commit in the local repository",
    );
  }
  if (base !== authorization.base_sha) {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "base_sha does not resolve to the authorized commit",
    );
  }
  const head = runGit(authorization.repository_path, [
    "rev-parse",
    "HEAD^{commit}",
  ]);
  if (head !== authorization.head_sha) {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "local HEAD differs from the remote authorization",
    );
  }
  try {
    runGit(authorization.repository_path, [
      "merge-base",
      "--is-ancestor",
      authorization.base_sha,
      authorization.head_sha,
    ]);
  } catch {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "base_sha must be an ancestor of head_sha",
    );
  }
  const dirty = runGit(authorization.repository_path, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (dirty !== "") {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "local working tree must be clean",
    );
  }
}

function validateOpenedRemoteAuthorization(
  reviewId,
  opened,
  { verifyRepository = false } = {},
) {
  const authorization = parseJsonObject(
    opened.bytes,
    "REMOTE_AUTHORIZATION_INVALID",
    "remote authorization is not a JSON object",
  );
  assertStoredCanonicalJsonBytes(
    authorization,
    opened.bytes,
    "REMOTE_AUTHORIZATION_INVALID",
    "remote authorization is not canonical JSON",
  );
  if (
    authorization.version !== 1 ||
    authorization.review_id !== reviewId ||
    authorization.mode !== "REMOTE_ONLY"
  ) {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "remote authorization identity or version changed",
    );
  }
  if (
    typeof authorization.repository_path !== "string" ||
    authorization.repository_path.trim() === "" ||
    authorization.repository_path.length > 4096 ||
    !path.isAbsolute(authorization.repository_path)
  ) {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "remote authorization repository_path must be a non-empty absolute path",
    );
  }
  if (!SHA_RE.test(authorization.base_sha ?? "")) {
    fail("REMOTE_AUTHORIZATION_INVALID", "remote authorization base_sha is invalid");
  }
  if (!SHA_RE.test(authorization.head_sha ?? "")) {
    fail("REMOTE_AUTHORIZATION_INVALID", "remote authorization head_sha is invalid");
  }
  if ((authorization.reviewer_provider ?? null) !== null) {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "remote authorization cannot contain a reviewer provider",
    );
  }
  if (authorization.acknowledgement !== "LOCAL_REVIEW_SKIPPED") {
    fail(
      "REMOTE_AUTHORIZATION_INVALID",
      "remote authorization must acknowledge LOCAL_REVIEW_SKIPPED",
    );
  }
  if (
    typeof authorization.operator_label !== "string" ||
    authorization.operator_label.trim() === "" ||
    authorization.operator_label.length > 500
  ) {
    fail("REMOTE_AUTHORIZATION_INVALID", "remote authorization operator_label is invalid");
  }
  if (
    typeof authorization.rationale !== "string" ||
    authorization.rationale.trim() === "" ||
    authorization.rationale.length > 20_000
  ) {
    fail("REMOTE_AUTHORIZATION_INVALID", "remote authorization rationale is invalid");
  }
  if (!isCanonicalTimestamp(authorization.authorized_at)) {
    fail("REMOTE_AUTHORIZATION_INVALID", "remote authorization authorized_at is invalid");
  }
  if (verifyRepository) {
    verifyRemoteRepository(authorization);
  }
  return {
    ...authorization,
    snapshot_hash: null,
    source_sha256: sha256(opened.bytes),
    reviewer_provider: null,
  };
}

async function readRemoteAuthorization(
  paths,
  reviewId,
  { verifyRepository = false } = {},
) {
  const opened = await readSecureFile(paths.remoteAuthorization, {
    maxBytes: 1024 * 1024,
    requiredMode: 0o600,
  });
  try {
    return validateOpenedRemoteAuthorization(reviewId, opened, {
      verifyRepository,
    });
  } finally {
    await opened.handle.close();
  }
}

async function readStartAuthorization(
  paths,
  reviewId,
  { verifyRepository = false } = {},
) {
  const hasLocalGate = await pathExists(paths.localGate);
  const hasRemoteAuthorization = await pathExists(paths.remoteAuthorization);
  if (hasLocalGate === hasRemoteAuthorization) {
    fail(
      "PUBLICATION_AUTHORIZATION_INVALID",
      hasLocalGate
        ? "local and remote publication authorizations both exist"
        : "no local or remote publication authorization exists",
    );
  }
  if (hasLocalGate) {
    return normalizedLocalGate(
      await readLocalGate(paths, reviewId, { verifyRepository }),
    );
  }
  return readRemoteAuthorization(paths, reviewId, { verifyRepository });
}

async function readBoundAuthorization(
  paths,
  reviewId,
  ledger,
  { verifyRepository = false } = {},
) {
  const expected = authorizationForLedger(ledger);
  const actual = await readStartAuthorization(paths, reviewId, {
    verifyRepository,
  });
  const errorCode =
    expected.mode === "LOCAL_GATE"
      ? "LOCAL_GATE_INVALID"
      : "REMOTE_AUTHORIZATION_INVALID";
  if (
    actual.mode !== expected.mode ||
    actual.head_sha !== expected.head_sha ||
    actual.base_sha !== expected.base_sha ||
    actual.source_sha256 !== expected.source_sha256 ||
    actual.reviewer_provider !== expected.reviewer_provider
  ) {
    fail(errorCode, "publication authorization changed");
  }
  return actual;
}

async function openAuthorizationFiles(
  paths,
  reviewId,
  { verifyRepository = false } = {},
) {
  const opened = [];
  try {
    const publicationFile = await readSecureFile(paths.publication, {
      maxBytes: MAX_PUBLICATION_BYTES,
      requiredMode: 0o600,
    });
    opened.push(publicationFile);
    const ledger = parseJsonObject(
      publicationFile.bytes,
      "PUBLICATION_STORE_INVALID",
      "publication.json is not a JSON object",
    );
    if (!SUPPORTED_PUBLICATION_VERSIONS.includes(ledger.version)) {
      fail(
        "UNSUPPORTED_PUBLICATION_VERSION",
        "only publication schema versions 1, 2, and 3 are supported",
      );
    }
    assertStoredCanonicalJsonBytes(
      ledger,
      publicationFile.bytes,
      "PUBLICATION_STORE_INVALID",
      "publication.json is not canonical JSON",
    );
    validateStoredLedger(ledger);
    requireStoredReviewId(ledger, reviewId);
    const expectedAuthorization = authorizationForLedger(ledger);
    const usesLocalGate = expectedAuthorization.mode === "LOCAL_GATE";
    const unexpectedPath = usesLocalGate
      ? paths.remoteAuthorization
      : paths.localGate;
    if (await pathExists(unexpectedPath)) {
      fail(
        usesLocalGate ? "LOCAL_GATE_INVALID" : "REMOTE_AUTHORIZATION_INVALID",
        "a conflicting publication authorization exists",
      );
    }
    const authorizationFile = await readSecureFile(
      usesLocalGate ? paths.localGate : paths.remoteAuthorization,
      {
        maxBytes: 1024 * 1024,
        requiredMode: 0o600,
      },
    );
    opened.push(authorizationFile);
    const sourceAuthorization = usesLocalGate
      ? normalizedLocalGate(
          await validateOpenedLocalGate(
            paths,
            reviewId,
            authorizationFile,
            { verifyRepository },
          ),
        )
      : validateOpenedRemoteAuthorization(reviewId, authorizationFile, {
          verifyRepository,
        });
    if (
      sourceAuthorization.head_sha !== expectedAuthorization.head_sha ||
      sourceAuthorization.base_sha !== expectedAuthorization.base_sha ||
      sourceAuthorization.source_sha256 !== expectedAuthorization.source_sha256 ||
      sourceAuthorization.reviewer_provider !==
        expectedAuthorization.reviewer_provider
    ) {
      fail(
        usesLocalGate ? "LOCAL_GATE_INVALID" : "REMOTE_AUTHORIZATION_INVALID",
        "publication authorization changed",
      );
    }
    const publicationGateFile = await readSecureFile(paths.gate, {
      maxBytes: MAX_PUBLICATION_BYTES,
      requiredMode: 0o600,
      allowMissing: true,
    });
    if (publicationGateFile != null) {
      opened.push(publicationGateFile);
    }
    let publicationGate = null;
    let gateParseError = false;
    if (publicationGateFile != null) {
      try {
        publicationGate = JSON.parse(publicationGateFile.bytes.toString("utf8"));
        if (
          !isJsonObject(publicationGate) ||
          !publicationGateFile.bytes.equals(canonicalJsonBytes(publicationGate))
        ) {
          gateParseError = true;
        }
      } catch {
        publicationGate = null;
        gateParseError = true;
      }
    }
    return {
      opened,
      sourceAuthorization,
      ledger,
      publicationGate,
      publicationGateBytes: publicationGateFile?.bytes ?? null,
      gateParseError,
    };
  } catch (error) {
    await Promise.all(opened.map((entry) => entry.handle.close().catch(() => {})));
    throw error;
  }
}

async function closeAuthorizationFiles(authorization) {
  await Promise.all(
    authorization.opened.map((entry) => entry.handle.close()),
  );
}

async function loadPublicationFile(
  paths,
  reviewId,
  { allowMissing = false } = {},
) {
  const opened = await readSecureFile(paths.publication, {
    maxBytes: MAX_PUBLICATION_BYTES,
    requiredMode: 0o600,
    allowMissing,
  });
  if (opened == null) {
    return null;
  }
  try {
    const ledger = parseJsonObject(
      opened.bytes,
      "PUBLICATION_STORE_INVALID",
      "publication.json is not a JSON object",
    );
    if (!SUPPORTED_PUBLICATION_VERSIONS.includes(ledger.version)) {
      fail(
        "UNSUPPORTED_PUBLICATION_VERSION",
        "only publication schema versions 1, 2, and 3 are supported",
      );
    }
    assertStoredCanonicalJsonBytes(
      ledger,
      opened.bytes,
      "PUBLICATION_STORE_INVALID",
      "publication.json is not canonical JSON",
    );
    validateStoredLedger(ledger);
    requireStoredReviewId(ledger, reviewId);
    return ledger;
  } finally {
    await opened.handle.close();
  }
}

function issuanceFacts(item) {
  return {
    resource_id: item.resource_id,
    resource_kind: item.resource_kind,
    url: item.url,
    event_at: item.event_at,
    timestamp_field: item.timestamp_field,
    body_sha256: item.body_sha256,
    request_id: item.request_id,
  };
}

async function findBaselineIssuances(
  storeRoot,
  currentReviewId,
  target,
  baseline,
) {
  if (baseline.collection.adapter_version !== 2) {
    return new Map();
  }
  let entries;
  try {
    entries = await fsp.readdir(path.join(storeRoot, "reviews"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
  if (entries.length > 10_000) {
    return new Map();
  }
  const candidates = new Map(
    baseline.requests
      .filter(
        (request) =>
          baselineRequestClassification(request, 2).classification ===
          "BASELINE_CORRELATED",
      )
      .map((request) => [resourceIdentity(request), request]),
  );
  const matches = new Map();
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === currentReviewId ||
      !/^rb-[0-9TZ-]+-[a-f0-9]{8}$/.test(entry.name)
    ) {
      continue;
    }
    let ledger;
    try {
      ledger = await loadPublicationFile(
        pathsFor(storeRoot, entry.name),
        entry.name,
        { allowMissing: true },
      );
    } catch {
      continue;
    }
    if (
      ledger == null ||
      ledger.codex_review_baseline.collection.adapter_version !== 2 ||
      ledger.target.repository_id !== target.repository_id ||
      ledger.target.owner !== target.owner ||
      ledger.target.repo !== target.repo ||
      ledger.target.pr_number !== target.pr_number
    ) {
      continue;
    }
    const authorizedHead = authorizationForLedger(ledger).head_sha;
    for (const history of ledger.codex_request_history) {
      const identity = resourceIdentity(history);
      const request = candidates.get(identity);
      if (
        request == null ||
        history.classification !== "RECOGNIZED" ||
        history.binding_source !== "RECORDED_AT_POST" ||
        history.recorded_revision < 2 ||
        history.requested_head_sha !== authorizedHead ||
        history.request_id !==
          correlatedRequestIdFor(
            ledger.review_id,
            history.recorded_revision - 1,
            authorizedHead,
          ) ||
        history.body_sha256 !==
          sha256(
            Buffer.from(correlatedRequestBody(history.request_id), "utf8"),
          ) ||
        !sameCanonical(issuanceFacts(history), issuanceFacts(request))
      ) {
        continue;
      }
      const existing = matches.get(identity) ?? [];
      existing.push({
        review_id: ledger.review_id,
        recorded_revision: history.recorded_revision,
        requested_head_sha: authorizedHead,
      });
      matches.set(identity, existing);
    }
  }
  return new Map(
    [...matches]
      .filter(([, values]) => values.length === 1)
      .map(([identity, values]) => [identity, values[0]]),
  );
}

function requireRevision(ledger, expectedRevision) {
  assertRevision(expectedRevision);
  if (ledger.revision !== expectedRevision) {
    fail(
      "PUBLICATION_REVISION_CONFLICT",
      `expected revision ${expectedRevision}, current revision is ${ledger.revision}`,
      { expected_revision: expectedRevision, current_revision: ledger.revision },
    );
  }
}

function requireMutable(ledger) {
  if (ledger.terminal != null || TERMINAL_STATUSES.has(ledger.status)) {
    fail("PUBLICATION_TERMINAL", `publication is terminal (${ledger.status})`);
  }
}

function requestHistoryFacts(entry) {
  return {
    resource_id: entry.resource_id,
    resource_kind: entry.resource_kind,
    url: entry.url,
    event_at: entry.event_at,
    timestamp_field: entry.timestamp_field,
    body_sha256: entry.body_sha256,
    ...("request_id" in entry ? { request_id: entry.request_id } : {}),
    ...(entry.classification === "RECOGNIZED"
      ? { requested_head_sha: entry.requested_head_sha }
      : { reason: entry.reason }),
  };
}

function observationRequestFacts(item, classification) {
  if (classification === "RECOGNIZED") {
    return {
      resource_id: item.comment_id,
      resource_kind: item.resource_kind,
      url: item.url,
      event_at: item.event_at,
      timestamp_field: item.timestamp_field,
      body_sha256: item.body_sha256,
      ...("request_id" in item ? { request_id: item.request_id } : {}),
      requested_head_sha: item.requested_head_sha,
    };
  }
  return {
    resource_id: item.resource_id,
    resource_kind: item.resource_kind,
    url: item.url,
    event_at: item.event_at,
    timestamp_field: item.timestamp_field,
    body_sha256: item.body_sha256,
    ...("request_id" in item ? { request_id: item.request_id } : {}),
    reason: item.reason,
  };
}

function resultHistoryFacts(entry) {
  return {
    result_id: entry.result_id,
    resource_kind: entry.resource_kind,
    native_review_state: entry.native_review_state,
    url: entry.url,
    event_at: entry.event_at,
    timestamp_field: entry.timestamp_field,
    actor: entry.actor,
    reviewed_head_sha: entry.reviewed_head_sha,
    commit_binding: entry.commit_binding,
    attached_review_comments: entry.attached_review_comments,
    body_sha256: entry.body_sha256,
    ...("request_id" in entry ? { request_id: entry.request_id } : {}),
  };
}

function observationResultFacts(item) {
  return {
    result_id: item.result_id,
    resource_kind: item.resource_kind,
    native_review_state: item.native_review_state,
    url: item.url,
    event_at: item.event_at,
    timestamp_field: item.timestamp_field,
    actor: { id: item.actor.id, type: item.actor.type },
    reviewed_head_sha: item.reviewed_head_sha,
    commit_binding: item.commit_binding,
    attached_review_comments: item.attached_review_comments ?? [],
    body_sha256: item.body_sha256,
    ...("request_id" in item ? { request_id: item.request_id } : {}),
  };
}

function reconcileHistories(ledger, observation, nextRevision, currentMs) {
  const collection = observation.codex_review.collection;
  if (collection.status !== "COMPLETE") {
    return { conflict: null, visibilityGrace: false };
  }
  const currentRequests = [
    ...observation.codex_review.requests.map((item) => ({
      classification: "RECOGNIZED",
      item,
      identity: `ISSUE_COMMENT:${item.comment_id}`,
    })),
    ...observation.codex_review.unbound_requests.map((item) => ({
      classification: "UNBOUND",
      item,
      identity: resourceIdentity(item),
    })),
    ...observation.codex_review.unsupported_requests.map((item) => ({
      classification: "UNSUPPORTED",
      item,
      identity: resourceIdentity(item),
    })),
  ];
  uniqueBy(currentRequests, (entry) => entry.identity, "active request partitions");
  const requestMap = new Map(currentRequests.map((entry) => [entry.identity, entry]));
  const collectionMs = Date.parse(collection.collected_at);
  let visibilityGrace = false;
  for (const stored of ledger.codex_request_history) {
    const identity = `${stored.resource_kind}:${stored.resource_id}`;
    const current = requestMap.get(identity);
    if (!current) {
      if (
        stored.binding_source === "RECORDED_AT_POST" &&
        collectionMs >= Date.parse(stored.event_at) &&
        collectionMs - Date.parse(stored.recorded_at) <=
          POST_VISIBILITY_GRACE_MS
      ) {
        visibilityGrace = true;
        continue;
      }
      return { conflict: `request ${identity} disappeared`, visibilityGrace: false };
    }
    if (
      stored.classification !== current.classification ||
      !sameCanonical(
        requestHistoryFacts(stored),
        observationRequestFacts(current.item, current.classification),
      )
    ) {
      return { conflict: `request ${identity} changed`, visibilityGrace: false };
    }
  }
  if (!visibilityGrace) {
    const known = new Set(
      ledger.codex_request_history.map(
        (entry) => `${entry.resource_kind}:${entry.resource_id}`,
      ),
    );
    for (const current of currentRequests) {
      if (known.has(current.identity)) {
        continue;
      }
      if (current.classification === "RECOGNIZED") {
        return {
          conflict: `recognized request ${current.identity} lacks a post-time binding`,
          visibilityGrace: false,
        };
      }
      ledger.codex_request_history.push({
        resource_id: current.item.resource_id,
        resource_kind: current.item.resource_kind,
        classification: current.classification,
        binding_source:
          current.classification === "UNBOUND"
            ? "OBSERVED_UNBOUND"
            : "OBSERVED_UNSUPPORTED",
        url: current.item.url,
        event_at: current.item.event_at,
        timestamp_field: current.item.timestamp_field,
        recorded_at: observation.recorded_at,
        recorded_revision: nextRevision,
        body_sha256: current.item.body_sha256,
        ...("request_id" in current.item
          ? { request_id: current.item.request_id }
          : {}),
        requested_head_sha: null,
        reason: current.item.reason,
      });
    }
  }

  const currentResults = new Map(
    observation.codex_review.results.map((item) => [
      `${item.resource_kind}:${item.result_id}`,
      item,
    ]),
  );
  for (const stored of ledger.codex_result_history) {
    const identity = `${stored.resource_kind}:${stored.result_id}`;
    const current = currentResults.get(identity);
    if (!current) {
      return { conflict: `Codex result ${identity} disappeared`, visibilityGrace: false };
    }
    if (!sameCanonical(resultHistoryFacts(stored), observationResultFacts(current))) {
      return { conflict: `Codex result ${identity} changed`, visibilityGrace: false };
    }
  }
  if (!visibilityGrace) {
    const knownResults = new Set(
      ledger.codex_result_history.map(
        (entry) => `${entry.resource_kind}:${entry.result_id}`,
      ),
    );
    for (const result of observation.codex_review.results) {
      const identity = `${result.resource_kind}:${result.result_id}`;
      if (!knownResults.has(identity)) {
        ledger.codex_result_history.push({
          ...observationResultFacts(result),
          recorded_at: observation.recorded_at,
        });
      }
    }
  }
  return { conflict: null, visibilityGrace };
}

function closedRequestIdentities(ledger) {
  return new Set(
    ledger.codex_review_ambiguity_acknowledgements.flatMap((acknowledgement) =>
      acknowledgement.closed_requests.map(
        (item) => `${item.resource_kind}:${item.resource_id}`,
      ),
    ),
  );
}

function closedResultIdentities(ledger) {
  return new Set(
    ledger.codex_review_ambiguity_acknowledgements.flatMap((acknowledgement) =>
      acknowledgement.closed_results.map(
        (item) => `${item.resource_kind}:${item.result_id}`,
      ),
    ),
  );
}

function correlationRequestBeforeResult(request, result) {
  const difference = Date.parse(request.event_at) - Date.parse(result.event_at);
  if (difference !== 0) {
    return difference < 0;
  }
  if (request.resource_kind !== result.resource_kind) {
    return false;
  }
  return request.resource_id < result.result_id;
}

function correlationRequestCompatible(request, result) {
  const requestedHeadSha =
    request.requested_head_sha ?? request.issuance?.requested_head_sha;
  if (requestedHeadSha == null) {
    return true;
  }
  if (result.resource_kind === "PULL_REQUEST_REVIEW") {
    return result.reviewed_head_sha === requestedHeadSha;
  }
  const prefix = result.commit_binding?.prefix;
  return (
    typeof prefix === "string" &&
    requestedHeadSha.startsWith(prefix)
  );
}

function replayResultAssociations(ledger) {
  if (ledger.codex_review_baseline.collection.adapter_version === 2) {
    return replayCorrelatedResultAssociations(ledger);
  }
  const closedRequests = closedRequestIdentities(ledger);
  const closedResults = closedResultIdentities(ledger);
  const recognized = ledger.codex_request_history.filter(
    (item) =>
      item.classification === "RECOGNIZED" &&
      !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
  );
  const unbound = ledger.codex_request_history.filter(
    (item) =>
      item.classification === "UNBOUND" &&
      !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
  );
  const baseline = ledger.codex_review_baseline.requests.filter(
    (item) => !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
  );
  const matched = new Set();
  const replayed = new Map();
  let activeWasOpened = false;
  const results = [...ledger.latest_observation.codex_review.results]
    .filter(
      (result) =>
        !closedResults.has(`${result.resource_kind}:${result.result_id}`),
    )
    .sort(
      (left, right) =>
        Date.parse(left.event_at) - Date.parse(right.event_at) ||
        (left.resource_kind === right.resource_kind
          ? left.result_id - right.result_id
          : 0),
    );
  for (const result of results) {
    const tiedAcrossKinds = [...recognized, ...unbound, ...baseline].some(
      (request) =>
        !closedRequests.has(
          `${request.resource_kind}:${request.resource_id}`,
        ) &&
        request.event_at === result.event_at &&
        request.resource_kind !== result.resource_kind &&
        correlationRequestCompatible(request, result),
    );
    const priorRecognized = recognized.filter(
      (request) =>
        !closedRequests.has(
          `${request.resource_kind}:${request.resource_id}`,
        ) &&
        correlationRequestBeforeResult(request, result) &&
        correlationRequestCompatible(request, result),
    );
    activeWasOpened ||= recognized.some(
      (request) =>
        !closedRequests.has(
          `${request.resource_kind}:${request.resource_id}`,
        ) &&
        correlationRequestBeforeResult(request, result),
    );
    if (tiedAcrossKinds) {
      replayed.set(`${result.resource_kind}:${result.result_id}`, {
        association: "AMBIGUOUS",
        request_ref: null,
      });
      continue;
    }
    const openRecognized = priorRecognized.filter(
      (request) =>
        !matched.has(`${request.resource_kind}:${request.resource_id}`),
    );
    const openUnbound = unbound.filter((request) =>
      correlationRequestBeforeResult(request, result),
    );
    const openBaseline = baseline.filter((request) =>
      correlationRequestBeforeResult(request, result),
    );
    const candidates = [...openRecognized, ...openUnbound, ...openBaseline];
    let replay;
    if (candidates.length === 0) {
      replay = {
        association: activeWasOpened ? "AMBIGUOUS" : "UNSOLICITED",
        request_ref: null,
      };
    } else if (
      candidates.length === 1 &&
      openRecognized.length === 1 &&
      openUnbound.length === 0 &&
      openBaseline.length === 0
    ) {
      const request = openRecognized[0];
      replay = {
        association: "SINGLE_OPEN_REQUEST",
        request_ref: {
          resource_kind: request.resource_kind,
          resource_id: request.resource_id,
        },
      };
      matched.add(`${request.resource_kind}:${request.resource_id}`);
    } else if (
      candidates.length === 1 &&
      openBaseline.length === 1 &&
      openRecognized.length === 0 &&
      openUnbound.length === 0
    ) {
      replay = {
        association: "BASELINE_LATE_RESULT",
        request_ref: {
          resource_kind: openBaseline[0].resource_kind,
          resource_id: openBaseline[0].resource_id,
        },
      };
    } else {
      replay = { association: "AMBIGUOUS", request_ref: null };
    }
    replayed.set(`${result.resource_kind}:${result.result_id}`, replay);
  }
  return replayed;
}

function replayCorrelatedResultAssociations(ledger) {
  const closedRequests = closedRequestIdentities(ledger);
  const closedResults = closedResultIdentities(ledger);
  const recognized = ledger.codex_request_history.filter(
    (item) =>
      item.classification === "RECOGNIZED" &&
      !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
  );
  const unbound = ledger.codex_request_history.filter(
    (item) =>
      item.classification === "UNBOUND" &&
      !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
  );
  const baseline = ledger.codex_review_baseline.requests.filter(
    (item) =>
      item.classification === "BASELINE_CORRELATED" &&
      !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
  );
  const matched = new Set();
  const replayed = new Map();
  for (const result of ledger.latest_observation.codex_review.results) {
    const resultIdentity = `${result.resource_kind}:${result.result_id}`;
    if (closedResults.has(resultIdentity)) {
      continue;
    }
    if (!isCodexRequestId(result.request_id)) {
      const recognizedMatches = recognized.filter(
        (request) =>
          !matched.has(`${request.resource_kind}:${request.resource_id}`) &&
          correlationRequestBeforeResult(request, result) &&
          correlationRequestCompatible(request, result),
      );
      const unboundMatches = unbound.filter((request) =>
        correlationRequestBeforeResult(request, result),
      );
      const baselineMatches = baseline.filter(
        (request) =>
          correlationRequestBeforeResult(request, result) &&
          correlationRequestCompatible(request, result),
      );
      if (
        recognizedMatches.length === 1 &&
        unboundMatches.length === 0 &&
        baselineMatches.length === 0
      ) {
        const request = recognizedMatches[0];
        replayed.set(resultIdentity, {
          association: "SINGLE_OPEN_REQUEST",
          request_ref: {
            resource_kind: request.resource_kind,
            resource_id: request.resource_id,
          },
        });
        matched.add(`${request.resource_kind}:${request.resource_id}`);
      } else {
        replayed.set(resultIdentity, {
          association: [...recognized, ...unbound, ...baselineMatches].some(
            (request) => correlationRequestBeforeResult(request, result),
          )
            ? "AMBIGUOUS"
            : "UNSOLICITED",
          request_ref: null,
        });
      }
      continue;
    }
    const matches = (items) =>
      items.filter(
        (request) =>
          request.request_id === result.request_id &&
          correlationRequestBeforeResult(request, result),
      );
    const recognizedCandidates = matches(recognized);
    const recognizedMatches = recognizedCandidates.filter(
      (request) =>
        !matched.has(`${request.resource_kind}:${request.resource_id}`),
    );
    const unboundMatches = matches(unbound);
    const baselineMatches = matches(baseline);
    let replay;
    if (
      recognizedMatches.length === 1 &&
      unboundMatches.length === 0 &&
      baselineMatches.length === 0 &&
      correlationRequestCompatible(recognizedMatches[0], result)
    ) {
      const request = recognizedMatches[0];
      replay = {
        association: "CORRELATED_REQUEST_ID",
        request_ref: {
          resource_kind: request.resource_kind,
          resource_id: request.resource_id,
        },
      };
      matched.add(`${request.resource_kind}:${request.resource_id}`);
    } else if (
      recognizedMatches.length === 0 &&
      unboundMatches.length === 0 &&
      baselineMatches.length === 1
    ) {
      replay = {
        association: "BASELINE_LATE_RESULT",
        request_ref: {
          resource_kind: baselineMatches[0].resource_kind,
          resource_id: baselineMatches[0].resource_id,
        },
      };
    } else {
      replay = {
        association:
          recognizedCandidates.length +
            unboundMatches.length +
            baselineMatches.length >
          0
            ? "AMBIGUOUS"
            : "UNSOLICITED",
        request_ref: null,
      };
    }
    replayed.set(resultIdentity, replay);
  }
  return replayed;
}

/**
 * The runs that actually decide a requirement: at most one per kind, filtered
 * to the pinned app when the requirement pins one, and the latest by start
 * time then run ID. Both the status and the progress fingerprint select
 * through here, so a run that cannot change the status cannot change the
 * fingerprint either.
 */
function decidingRunsFor(requirement, runs) {
  const byKind = new Map();
  for (const kind of ["CHECK_RUN", "COMMIT_STATUS"]) {
    let matches = runs.filter(
      (run) => run.run_kind === kind && run.context === requirement.context,
    );
    if (kind === "CHECK_RUN" && requirement.app_binding === "PINNED") {
      matches = matches.filter(
        (run) => run.app_id === requirement.required_app_id,
      );
    }
    if (matches.length > 0) {
      matches.sort(
        (left, right) =>
          Date.parse(left.started_at) - Date.parse(right.started_at) ||
          left.run_id - right.run_id,
      );
      byKind.set(kind, matches.at(-1));
    }
  }
  // A pinned requirement with no run from its app decides nothing at all: a
  // commit status cannot stand in for the pinned check, so it is not a
  // deciding run either. Keeping this rule inside the selection is what makes
  // the two callers agree -- applied after the call it reached only one.
  if (requirement.app_binding === "PINNED" && !byKind.has("CHECK_RUN")) {
    return new Map();
  }
  return byKind;
}

function checkRequiredRuns(requiredChecks) {
  if (requiredChecks.collection.status !== "COMPLETE") {
    return "EVIDENCE_INCOMPLETE";
  }
  const requirements = requiredChecks.requirements;
  const strict = requiredChecks.strict_policy?.required;
  if (typeof strict !== "boolean") {
    return "EVIDENCE_INCOMPLETE";
  }
  if (
    !(
      (requiredChecks.policy === "REQUIRED" && requirements.length > 0) ||
      (requiredChecks.policy === "STRICT_ONLY" &&
        requirements.length === 0 &&
        strict) ||
      (requiredChecks.policy === "NONE_CONFIGURED" &&
        requirements.length === 0 &&
        !strict)
    )
  ) {
    return "EVIDENCE_INCOMPLETE";
  }
  if (requiredChecks.policy !== "REQUIRED") {
    return null;
  }
  let pending = false;
  for (const requirement of requirements) {
    const byKind = decidingRunsFor(requirement, requiredChecks.runs);
    if (byKind.size === 0) {
      pending = true;
      continue;
    }
    for (const run of byKind.values()) {
      if (
        ![
          "QUEUED",
          "IN_PROGRESS",
          "WAITING",
          "REQUESTED",
          "PENDING",
          "COMPLETED",
        ].includes(run.status)
      ) {
        return "EVIDENCE_INCOMPLETE";
      }
      if (run.status !== "COMPLETED" || run.conclusion === "STALE") {
        pending = true;
      } else if (FAILING_CONCLUSIONS.has(run.conclusion)) {
        return "CHECKS_FAILED";
      } else if (!PASSING_CONCLUSIONS.has(run.conclusion)) {
        return "EVIDENCE_INCOMPLETE";
      }
    }
  }
  return pending ? "CHECKS_PENDING" : null;
}

function activeCorrelation(ledger) {
  const closedRequests = closedRequestIdentities(ledger);
  const closedResults = closedResultIdentities(ledger);
  const openBaseline = ledger.codex_review_baseline.requests
    .filter(
      (item) =>
        item.classification !== "BASELINE_CORRELATED" &&
        !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
    )
    .map((item) => ({
      resource_kind: item.resource_kind,
      resource_id: item.resource_id,
    }));
  const openUnbound = ledger.codex_request_history
    .filter(
      (item) =>
        item.classification !== "RECOGNIZED" &&
        !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
    )
    .map((item) => ({
      resource_kind: item.resource_kind,
      resource_id: item.resource_id,
    }));
  const recognized = ledger.codex_request_history.filter(
    (item) =>
      item.classification === "RECOGNIZED" &&
      !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
  );
  const replayed = replayResultAssociations(ledger);
  const ambiguousResults = ledger.latest_observation.codex_review.results
    .filter(
      (item) => {
        const identity = `${item.resource_kind}:${item.result_id}`;
        if (closedResults.has(identity)) {
          return false;
        }
        const replay = replayed.get(identity);
        if (
          replay?.association === "UNSOLICITED" ||
          replay?.association === "BASELINE_LATE_RESULT"
        ) {
          return (
            item.association !== replay.association ||
            !sameCanonical(item.request_ref, replay.request_ref)
          );
        }
        return (
          replay == null ||
          replay.association === "AMBIGUOUS" ||
          item.association !== replay.association ||
          !sameCanonical(item.request_ref, replay.request_ref) ||
          item.verdict === "UNKNOWN" ||
          item.native_review_state === "DISMISSED" ||
          ![
            "CODEX_CLEAN_COMMENT_V1",
            "CODEX_FINDINGS_REVIEW_V1",
            "CODEX_CLEAN_COMMENT_V2",
            "CODEX_FINDINGS_REVIEW_V2",
          ].includes(
            item.format,
          )
        );
      },
    )
    .map((item) => ({
      resource_kind: item.resource_kind,
      result_id: item.result_id,
    }));
  return {
    openBaseline,
    openUnbound,
    recognized,
    ambiguousResults,
    replayed,
  };
}

// The exact comment sequence a thread eligibility or resolution proof binds.
// RFC 0003: "Eligibility and resolution audit entries bind that exact
// watermark, not merely the thread ID or its latest timestamp." Comment
// edits move updated_at, so an edited body invalidates the watermark even
// though bodies themselves are not stored. The resolved flag deliberately
// stays out: the resolution sequence reads it separately, before and after
// the mutation, against one unchanged comment watermark.
export function threadWatermark(thread) {
  if (thread.provenance_complete !== true) {
    fail(
      "INVALID_INPUT",
      "a thread watermark requires complete thread provenance",
    );
  }
  return sha256(
    canonicalJson({
      thread_id: thread.id,
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        database_id: comment.database_id,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        actor: {
          id: comment.actor.id ?? null,
          type: comment.actor.type ?? null,
        },
      })),
    }),
  );
}

// Whether the recorded evidence permits the workflow to resolve a thread by
// itself. Pure derivation over one observation and the ledger's correlation:
// deciding to act is this function's business, acting is not.
//
// The discharge is the correlated CLEAN result on the gated head. Codex read
// the current code and raised nothing, so a finding still true of that code
// would have been raised again. This is why an older thread may be resolved,
// and it is worth being precise about what that costs: nothing beyond what
// merging already costs, since the same CLEAN is what allows the merge at all.
// An eligible thread is one the workflow has already been told is answered.
//
// is_outdated deliberately does not appear below. GitHub sets it when the diff
// hunk a thread was anchored to no longer exists, which is evidence the code
// moved, not evidence the finding was addressed -- a line can be displaced by
// an unrelated edit. It is the most tempting shortcut here and the wrong one.
// context: { cleanForGatedHead, ancestryByHead, workflow }, where workflow is
// the reading of the bound workflow ledger (readWorkflowBinding) -- attempt
// heads and addressed-finding records included -- or null when the
// publication is not workflow-bound.
export function threadResolutionEligibility(ledger, thread, context) {
  const authorization = authorizationForLedger(ledger);
  const codexActor = ledger.target.codex_actor;
  const refuse = (reason) => ({ eligible: false, reason });

  // Without complete provenance the thread cannot be replayed at all, so
  // nothing below it could be established rather than assumed.
  if (thread.provenance_complete !== true) {
    return refuse("PROVENANCE_INCOMPLETE");
  }
  if (thread.is_resolved === true) {
    return refuse("ALREADY_RESOLVED");
  }
  // A thread this workflow already resolved once cannot become eligible
  // again by being unresolved: whoever undid the resolution is a participant
  // contesting it, and re-resolving would start a war with them. The
  // invalidated record independently blocks the gate; the operator decides.
  if (
    (ledger.automatic_resolutions ?? []).some(
      (record) => record.thread_id === thread.id,
    )
  ) {
    return refuse("THREAD_PREVIOUSLY_RESOLVED");
  }

  const isCodex = (actor) =>
    actor?.id === codexActor.id && actor?.type === codexActor.type;
  // Every comment, not merely the first. A human reply is a participant whose
  // objection this workflow was never authorized to dismiss, and it does not
  // stop being one because a bot opened the thread.
  //
  // RFC condition 7's sole exception: the workflow's own recorded reply --
  // the exact comment a completed reply action for this same thread recorded
  // by database ID and authenticated actor. Matching the recorded identity is
  // what separates it from any other comment by the same human account: an
  // operator writing in the thread by hand is a participant, not a step of
  // this workflow, and still refuses. Never the root -- a reply answers the
  // finding, it cannot be the finding.
  const replies = context.workflow?.thread_replies ?? [];
  const isRecordedReply = (comment, index) =>
    index > 0 &&
    replies.some(
      (reply) =>
        reply.thread_id === thread.id &&
        reply.comment_id === comment.database_id &&
        reply.actor.id === comment.actor?.id &&
        reply.actor.type === comment.actor?.type,
    );
  if (
    !thread.comments.every(
      (comment, index) =>
        isCodex(comment.actor) || isRecordedReply(comment, index),
    )
  ) {
    return refuse("NOT_CODEX_AUTHORED");
  }
  const review = thread.comments[0].review;
  if (!isCodex(review.actor)) {
    return refuse("NOT_CODEX_AUTHORED");
  }

  // RFC condition 8's second clause: a finding whose review was dismissed has
  // been answered through a path this workflow does not own, and resolving on
  // top of a dismissal would launder that path into a workflow decision.
  if (review.state === "DISMISSED") {
    return refuse("REVIEW_DISMISSED");
  }

  // A thread raised against the very head the CLEAN examined would mean the
  // same review both raised and did not raise it. That is a contradiction in
  // the evidence rather than a discharge, so it refuses instead of resolving.
  if (review.reviewed_head_sha === authorization.head_sha) {
    return refuse("RAISED_AGAINST_GATED_HEAD");
  }

  // The finding must belong to this workflow's own line of work: a head this
  // workflow published and recorded. A thread from any other history -- an
  // operator's manual push, another workflow, a foreign PR -- is not ours to
  // answer, whatever else the evidence says.
  const workflow = context.workflow;
  if (workflow === null) {
    return refuse("WORKFLOW_NOT_BOUND");
  }
  if (workflow.status !== "ACTIVE") {
    return refuse("WORKFLOW_NOT_ACTIVE");
  }
  // An ACTIVE workflow is not enough: a publication that has reached a
  // terminal state, or whose head the workflow has already moved past,
  // decides nothing further, and a plan built on it would be a plan for a
  // publication that no longer exists.
  if (context.publicationTerminal) {
    return refuse("PUBLICATION_TERMINAL");
  }
  if (workflow.current_head_sha !== authorization.head_sha) {
    return refuse("PUBLICATION_SUPERSEDED");
  }
  if (!workflow.attempt_head_shas.includes(review.reviewed_head_sha)) {
    return refuse("FINDING_HEAD_NOT_OURS");
  }


  // The gated head must still descend from the finding head. A force-push
  // that discarded the fix leaves the finding unanswered however clean the
  // new head is about its own contents.
  const ancestry = context.ancestryByHead.get(review.reviewed_head_sha);
  if (ancestry?.descends !== true) {
    return refuse("DESCENT_UNPROVEN");
  }

  if (!context.cleanForGatedHead) {
    return refuse("NO_CLEAN_RESULT_FOR_GATED_HEAD");
  }
  // RFC 0003 eligibility condition 3: the workflow must record the finding as
  // addressed by one or more commits. The addressed-by record is also the
  // structural link the RFC's never-eligible rule demands -- a thread must
  // tie to the correlated Codex review, not merely to the Codex actor. The
  // correlated FINDINGS result for an earlier head lives in that head's own
  // publication ledger, which this publication does not hold: each attempt
  // starts a fresh one whose baseline swallows earlier reviews as
  // pre-existing, so membership in this ledger's recorded results can only
  // ever express "observed". The record carries the link across publications
  // instead: it is server-derived when the repair head is recorded, from the
  // very review whose correlated result blocked that publication, and it
  // names that review by ID and reviewed head. A thread rooted in any other
  // review -- an unsolicited in-window one included -- matches no record and
  // refuses here.
  const addressed = workflow.addressed_findings.filter(
    (record) =>
      record.findings_review.result_id === review.database_id &&
      record.findings_review.reviewed_head_sha === review.reviewed_head_sha &&
      record.addressed_by.length > 0,
  );
  if (addressed.length === 0) {
    return refuse("FIX_NOT_RECORDED");
  }
  // The commits travel with the verdict: they are what the reply action
  // names, so the reply can never claim more than the record it answers.
  return {
    eligible: true,
    addressed_by: addressed.flatMap((record) => record.addressed_by),
  };
}

// The full Codex verdict for the gated head: the status codexStatus reports,
// plus the deciding formal review whenever that status is CHANGES_REQUIRED.
// The identity travels into the workflow's addressed-by record, so it must
// come from the same selection that decided the status -- a parallel lookup
// could name a different review than the one that blocked.
function codexDecision(ledger) {
  const status = (value) => ({ status: value, findingsReview: null });
  const observation = ledger.latest_observation;
  const authorization = authorizationForLedger(ledger);
  const correlation = activeCorrelation(ledger);
  if (
    correlation.openBaseline.length > 0 ||
    correlation.openUnbound.length > 0 ||
    correlation.ambiguousResults.length > 0
  ) {
    return status("GITHUB_REVIEW_UNKNOWN");
  }
  if (correlation.recognized.length === 0) {
    return status("GITHUB_REVIEW_NOT_REQUESTED");
  }
  const latest = [...correlation.recognized].sort(
    (left, right) =>
      Date.parse(left.event_at) - Date.parse(right.event_at) ||
      left.resource_id - right.resource_id,
  ).at(-1);
  const adapterVersionTwo =
    ledger.codex_review_baseline.collection.adapter_version === 2;
  const results = observation.codex_review.results.filter(
    (result) => {
      const replay = correlation.replayed.get(
        `${result.resource_kind}:${result.result_id}`,
      );
      return (
        (replay?.association === "SINGLE_OPEN_REQUEST" ||
          (adapterVersionTwo &&
            replay?.association === "CORRELATED_REQUEST_ID")) &&
        replay.request_ref?.resource_kind === latest.resource_kind &&
        replay.request_ref?.resource_id === latest.resource_id
      );
    },
  );
  if (results.length === 0) {
    return status("GITHUB_REVIEW_PENDING");
  }
  if (results.length !== 1) {
    return status("GITHUB_REVIEW_UNKNOWN");
  }
  const result = results[0];
  const resultReplay = correlation.replayed.get(
    `${result.resource_kind}:${result.result_id}`,
  );
  const idCorrelated =
    resultReplay?.association === "CORRELATED_REQUEST_ID";
  const earlierUnanswered =
    resultReplay?.association === "SINGLE_OPEN_REQUEST" &&
    correlation.recognized
    .filter((request) => request.resource_id !== latest.resource_id)
    .some(
      (request) =>
        !observation.codex_review.results.some(
          (result) => {
            const replay = correlation.replayed.get(
              `${result.resource_kind}:${result.result_id}`,
            );
            return (
              replay?.association === "SINGLE_OPEN_REQUEST" &&
              replay.request_ref?.resource_kind === request.resource_kind &&
              replay.request_ref?.resource_id === request.resource_id &&
              Date.parse(result.event_at) <= Date.parse(latest.event_at)
            );
          },
        ),
    );
  if (earlierUnanswered) {
    return status("GITHUB_REVIEW_UNKNOWN");
  }
  if (result.actor.id !== ledger.target.codex_actor.id || result.actor.type !== "Bot") {
    return status("GITHUB_REVIEW_UNKNOWN");
  }
  const changesRequired = () => ({
    status: "CHANGES_REQUIRED",
    findingsReview: {
      result_id: result.result_id,
      reviewed_head_sha: result.reviewed_head_sha,
    },
  });
  if (
    result.resource_kind === "PULL_REQUEST_REVIEW" &&
    result.native_review_state === "CHANGES_REQUESTED" &&
    result.reviewed_head_sha === authorization.head_sha
  ) {
    return changesRequired();
  }
  if (result.native_review_state === "DISMISSED") {
    return status("GITHUB_REVIEW_UNKNOWN");
  }
  if (
    result.format ===
    (idCorrelated ? "CODEX_CLEAN_COMMENT_V2" : "CODEX_CLEAN_COMMENT_V1")
  ) {
    if (
      result.resource_kind !== "ISSUE_COMMENT" ||
      result.native_review_state !== null ||
      result.verdict !== "CLEAN" ||
      (adapterVersionTwo &&
        (idCorrelated
          ? result.request_id !== latest.request_id
          : result.request_id !== null)) ||
      result.reviewed_head_sha !== authorization.head_sha ||
      result.commit_binding?.source !==
        "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD" ||
      result.commit_binding?.field !== "body.reviewed_commit" ||
      !/^[0-9a-f]{10,40}$/.test(result.commit_binding?.prefix ?? "") ||
      !authorization.head_sha.startsWith(result.commit_binding.prefix)
    ) {
      return status("GITHUB_REVIEW_UNKNOWN");
    }
    return status(null);
  }
  if (
    result.format ===
    (idCorrelated ? "CODEX_FINDINGS_REVIEW_V2" : "CODEX_FINDINGS_REVIEW_V1")
  ) {
    if (
      result.resource_kind !== "PULL_REQUEST_REVIEW" ||
      !["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(
        result.native_review_state,
      ) ||
      result.verdict !== "FINDINGS" ||
      (adapterVersionTwo &&
        (idCorrelated
          ? result.request_id !== latest.request_id
          : result.request_id !== null)) ||
      result.reviewed_head_sha !== authorization.head_sha ||
      result.commit_binding?.source !== "PULL_REQUEST_REVIEW_COMMIT_ID" ||
      result.commit_binding?.field !== "commit_id" ||
      (result.attached_review_comments?.length ?? 0) === 0 ||
      result.attached_review_comments.some(
        (comment) =>
          comment.actor.id !== ledger.target.codex_actor.id ||
          comment.actor.type !== "Bot" ||
          comment.commit_id !== result.reviewed_head_sha,
      )
    ) {
      return status("GITHUB_REVIEW_UNKNOWN");
    }
    return changesRequired();
  }
  return status("GITHUB_REVIEW_UNKNOWN");
}

function codexStatus(ledger) {
  return codexDecision(ledger).status;
}

function publicationDecision(
  status,
  blockingReason = status === "MERGE_READY" ? null : status,
  terminalReason = null,
) {
  return {
    status,
    blockingReason,
    ...(terminalReason == null ? {} : { terminalReason }),
  };
}

function derivePublication(
  ledger,
  { historyConflict = null, visibilityGrace = false, ignoreDraft = false } = {},
) {
  if (ledger.terminal != null) {
    return publicationDecision(
      ledger.terminal.status,
      ledger.terminal.reason,
      ledger.terminal.reason,
    );
  }
  const observation = ledger.latest_observation;
  if (observation == null) {
    return publicationDecision("PR_PENDING", "NO_GITHUB_SNAPSHOT");
  }
  if (observation.pull_request.collection.status !== "COMPLETE") {
    return publicationDecision(
      "EVIDENCE_INCOMPLETE",
      "PULL_REQUEST_COLLECTION_INCOMPLETE",
    );
  }
  const pullRequest = observation.pull_request;
  const target = ledger.target;
  const authorization = authorizationForLedger(ledger);
  if (
    pullRequest.repository_id !== target.repository_id ||
    pullRequest.number !== target.pr_number ||
    pullRequest.base_branch !== target.base_branch ||
    pullRequest.head_branch !== target.head_branch ||
    pullRequest.head_sha !== authorization.head_sha
  ) {
    const reason =
      "pull request identity or head differs from the publication authorization";
    return publicationDecision("INVALIDATED", reason, reason);
  }
  const pullBaseSource = pullRequest.collection.sources.find(
    (source) => source.kind === "BASE_BRANCH_METADATA",
  );
  const checksBaseSource = observation.required_checks.collection.policy_sources?.find(
    (source) => source.kind === "BRANCH_METADATA",
  );
  if (
    !pullBaseSource ||
    !checksBaseSource ||
    pullRequest.base_sha !== pullBaseSource.branch_tip_sha ||
    pullRequest.base_sha !== checksBaseSource.branch_tip_sha ||
    Date.parse(pullBaseSource.collected_at) >= Date.parse(checksBaseSource.collected_at)
  ) {
    return publicationDecision(
      "EVIDENCE_INCOMPLETE",
      "BASE_BRANCH_EVIDENCE_INCOHERENT",
    );
  }
  const ancestry = pullRequest.reviewed_base_current_base_comparison;
  if (
    ancestry.base_sha !== authorization.base_sha ||
    ancestry.head_sha !== pullRequest.base_sha ||
    ancestry.status === "UNKNOWN"
  ) {
    return publicationDecision(
      "EVIDENCE_INCOMPLETE",
      "REVIEWED_BASE_ANCESTRY_INCOMPLETE",
    );
  }
  if (["BEHIND", "DIVERGED"].includes(ancestry.status)) {
    const reason = "target base no longer preserves the reviewed base";
    return publicationDecision("INVALIDATED", reason, reason);
  }
  if (pullRequest.is_merged) {
    const reason = "pull request merged";
    return publicationDecision("MERGED", reason, reason);
  }
  if (pullRequest.state === "CLOSED") {
    const reason = "pull request closed without merge";
    return publicationDecision("CLOSED", reason, reason);
  }
  if (
    [
      observation.required_checks.collection,
      observation.codex_review.collection,
      observation.review_threads.collection,
    ].some((collection) => collection.status !== "COMPLETE") ||
    visibilityGrace ||
    observation.codex_review.results.some(
      (result) =>
        result.resource_kind === "PULL_REQUEST_REVIEW" &&
        result.native_review_state === "PENDING",
    )
  ) {
    return publicationDecision(
      "EVIDENCE_INCOMPLETE",
      "GITHUB_COLLECTION_INCOMPLETE",
    );
  }
  if (historyConflict) {
    return publicationDecision("INVALIDATED", historyConflict, historyConflict);
  }
  if (pullRequest.is_draft && !ignoreDraft) {
    return publicationDecision("PR_DRAFT");
  }
  if (pullRequest.mergeable === "UNKNOWN") {
    return publicationDecision("PR_STATE_PENDING");
  }
  if (pullRequest.mergeable === "CONFLICTING") {
    return publicationDecision("PR_CONFLICTING");
  }
  if (observation.required_checks.strict_policy?.required) {
    const comparison = pullRequest.base_head_comparison;
    if (
      comparison.base_sha !== pullRequest.base_sha ||
      comparison.head_sha !== pullRequest.head_sha ||
      comparison.status === "UNKNOWN"
    ) {
      return publicationDecision(
        "EVIDENCE_INCOMPLETE",
        "STRICT_BASE_COMPARISON_INCOMPLETE",
      );
    }
    if (["BEHIND", "DIVERGED"].includes(comparison.status)) {
      return publicationDecision("PR_UPDATE_REQUIRED");
    }
  }
  const checks = checkRequiredRuns(observation.required_checks);
  if (checks) {
    return publicationDecision(checks);
  }
  const codex = codexStatus(ledger);
  if (codex) {
    return publicationDecision(codex);
  }
  // Every automatic-resolution record must still be true of the current
  // observation before anything else about threads is concluded. A record
  // whose thread moved -- new comments, unresolved again, or no longer
  // verifiable -- blocks with its own reason rather than letting the
  // unresolved count absorb it: the workflow must not treat a contested
  // resolution as merely one more thread to resolve.
  if (invalidatedAutomaticResolution(ledger) != null) {
    return publicationDecision(
      "CHANGES_REQUIRED",
      "THREAD_RESOLUTION_INVALIDATED",
    );
  }
  if (observation.review_threads.unresolved_count > 0) {
    return publicationDecision(
      "CHANGES_REQUIRED",
      "UNRESOLVED_REVIEW_THREADS",
    );
  }
  return publicationDecision("MERGE_READY");
}

// The first automatic-resolution record the current observation no longer
// supports, or null when every record still holds. A resolved thread proves
// nothing about who resolved it, so the record's exact watermark is the whole
// claim: the thread it bound, unchanged, now resolved. Anything else --
// thread gone, provenance no longer complete, watermark moved, or resolution
// undone -- invalidates the record.
//
// The comparison runs over the active frontier only. A record a SUPERSEDES
// event retired is audit evidence, not a live claim, so it is never compared
// against the current watermark as though it were still active; a chain that
// cannot be replayed as one linear frontier blocks through its own reason.
function invalidatedAutomaticResolution(ledger) {
  const frontier = resolutionFrontier(ledger);
  if (frontier.blockers.length > 0) {
    // A blocker invalidates the frontier even when it names no record
    // (orphan lifecycle events with no resolution records). The single
    // caller only tests for null, so return the blocker itself, not its
    // nullable record -- a recordless blocker must not read as "no
    // invalidation".
    return frontier.blockers[0];
  }
  const threads = new Map(
    ledger.latest_observation.review_threads.threads.map((thread) => [
      thread.id,
      thread,
    ]),
  );
  for (const record of frontier.active.values()) {
    const thread = threads.get(record.thread_id);
    if (
      thread == null ||
      thread.provenance_complete !== true ||
      thread.is_resolved !== true ||
      threadWatermark(thread) !== record.thread_watermark
    ) {
      return record;
    }
  }
  return null;
}

/**
 * Replay one thread's automatic-resolution records and lifecycle events into
 * its active frontier.
 *
 * A valid chain per thread is one linear sequence of records in which every
 * predecessor is retired by exactly one SUPERSEDES event whose invalidation
 * and compensating-unresolve events are present, ordered, and bound to that
 * predecessor. The last record is active; every earlier record is superseded
 * audit evidence. Fork, cycle, gap, missing record, extra record, missing
 * unresolve, event misordering, or a successor that proves nothing new all
 * block with their own reason instead of being folded into the watermark
 * comparison -- the terminal projection must never treat a contested chain as
 * a resolved thread merely because the active record happens to match.
 *
 * The replay is structural: it needs no observation. Whether the active
 * record still matches the observation's thread watermark is the caller's
 * comparison (`invalidatedAutomaticResolution` for the gate, the terminal
 * projection for the post-ready evaluation), so the two share exactly one
 * notion of what is active and cannot disagree about it.
 */
function resolutionFrontier(ledger) {
  const records = ledger.automatic_resolutions ?? [];
  const events = ledger.resolution_lifecycle ?? [];
  const active = new Map();
  const blockers = [];
  const blocked = (reason, threadId, record = null) => {
    blockers.push({ reason, thread_id: threadId, record });
  };
  if (records.length === 0) {
    if (events.length > 0) {
      // Lifecycle events with no resolution records are orphan evidence:
      // every event kind names a record that must exist, so the named
      // record is missing and the frontier cannot be replayed. The terminal
      // projection must never accept an orphan INVALIDATED,
      // UNRESOLVED_FOR_REPAIR, or SUPERSEDES as though it proved nothing.
      const orphanThreads = [
        ...new Set(events.map((event) => event.thread_id)),
      ];
      for (const threadId of orphanThreads) {
        blocked("THREAD_RESOLUTION_RECORD_MISSING", threadId);
      }
    }
    return { active, blockers };
  }
  const byThread = new Map();
  for (const record of records) {
    if (!byThread.has(record.thread_id)) {
      byThread.set(record.thread_id, []);
    }
    byThread.get(record.thread_id).push(record);
  }
  // Threads that appear only in lifecycle events -- with no resolution
  // records at all -- are orphan evidence even when other threads carry
  // valid chains: a mixed ledger must not let one thread's records hide
  // another thread's missing record.
  for (const threadId of new Set(events.map((event) => event.thread_id))) {
    if (!byThread.has(threadId)) {
      blocked("THREAD_RESOLUTION_RECORD_MISSING", threadId);
    }
  }
  for (const [threadId, threadRecords] of byThread) {
    const sorted = [...threadRecords].sort((left, right) => left.number - right.number);
    const byActionId = new Map(sorted.map((record) => [record.action_id, record]));
    const firstRecord = sorted[0];
    const threadEvents = events.filter((event) => event.thread_id === threadId);
    const supersedes = threadEvents.filter((event) => event.kind === "SUPERSEDES");
    const invalidated = threadEvents.filter((event) => event.kind === "INVALIDATED");
    const unresolved = threadEvents.filter((event) => event.kind === "UNRESOLVED_FOR_REPAIR");
    // Every event reference must resolve to a stored record. A SUPERSEDES
    // naming a record that does not exist is a missing record, not a chain
    // that can be replayed around it.
    let broken = false;
    for (const event of supersedes) {
      if (
        !byActionId.has(event.predecessor_id) ||
        !byActionId.has(event.successor_id)
      ) {
        blocked("THREAD_RESOLUTION_RECORD_MISSING", threadId, firstRecord);
        broken = true;
        break;
      }
    }
    if (broken) continue;
    for (const event of invalidated) {
      if (!byActionId.has(event.record_id)) {
        blocked("THREAD_RESOLUTION_RECORD_MISSING", threadId, firstRecord);
        broken = true;
        break;
      }
    }
    if (broken) continue;
    for (const event of unresolved) {
      if (!byActionId.has(event.record_id)) {
        blocked("THREAD_RESOLUTION_RECORD_MISSING", threadId, firstRecord);
        broken = true;
        break;
      }
    }
    if (broken) continue;
    // One successor per record and one predecessor per record: a fork (one
    // predecessor to two successors) or a shared successor is not a chain.
    const successorOf = new Map();
    const predecessorOf = new Map();
    for (const event of supersedes) {
      if (
        successorOf.has(event.predecessor_id) ||
        predecessorOf.has(event.successor_id)
      ) {
        blocked("THREAD_RESOLUTION_CHAIN_BROKEN", threadId, firstRecord);
        broken = true;
        break;
      }
      successorOf.set(event.predecessor_id, event.successor_id);
      predecessorOf.set(event.successor_id, event.predecessor_id);
    }
    if (broken) continue;
    // Walk every chain from its head record. Exactly one chain must cover
    // every record of the thread; a second chain, an unreachable record, or a
    // cycle (which the injective successor map renders as a component with no
    // head) means the frontier is not one linear supersession chain.
    const chains = [];
    for (const record of sorted) {
      if (predecessorOf.has(record.action_id)) {
        continue;
      }
      const chain = [];
      let current = record;
      while (current != null) {
        chain.push(current);
        const nextId = successorOf.get(current.action_id);
        current = nextId == null ? null : byActionId.get(nextId);
      }
      chains.push(chain);
    }
    if (chains.length !== 1) {
      blocked("THREAD_RESOLUTION_RECORD_EXTRA", threadId, firstRecord);
      continue;
    }
    const chain = chains[0];
    if (chain.length !== sorted.length) {
      blocked("THREAD_RESOLUTION_RECORD_EXTRA", threadId, firstRecord);
      continue;
    }
    // Every transition needs its invalidation and compensating unresolve,
    // in order, before the SUPERSEDES that retires the predecessor.
    const eventIndex = new Map(events.map((event, index) => [event, index]));
    for (let position = 0; position < chain.length - 1; position += 1) {
      const predecessor = chain[position];
      const successor = chain[position + 1];
      const supersede = supersedes.find(
        (event) =>
          event.predecessor_id === predecessor.action_id &&
          event.successor_id === successor.action_id,
      );
      if (supersede == null) {
        blocked("THREAD_RESOLUTION_CHAIN_BROKEN", threadId, firstRecord);
        broken = true;
        break;
      }
      const invalidation = events[supersede.invalidation_event - 1];
      const unresolveEvent = events[supersede.unresolve_event - 1];
      if (
        invalidation?.kind !== "INVALIDATED" ||
        invalidation.record_id !== predecessor.action_id ||
        invalidation.prior_watermark !== predecessor.thread_watermark ||
        unresolveEvent?.kind !== "UNRESOLVED_FOR_REPAIR" ||
        unresolveEvent.record_id !== predecessor.action_id ||
        eventIndex.get(invalidation) >= eventIndex.get(unresolveEvent) ||
        eventIndex.get(unresolveEvent) >= eventIndex.get(supersede)
      ) {
        // A supersession whose invalidation or compensating unresolve is
        // missing, misbound, or out of order cannot be replayed; a missing
        // unresolve is the RFC's named case and the rest are the same broken
        // chain.
        blocked("THREAD_RESOLUTION_CHAIN_BROKEN", threadId, firstRecord);
        broken = true;
        break;
      }
      // The successor must prove something new: a later record, a fresh
      // watermark, and a head that differs from the one the finding blocked.
      // Without that there is no fix to supersede with, however the events
      // are arranged.
      if (
        successor.recorded_revision <= predecessor.recorded_revision ||
        successor.thread_watermark === predecessor.thread_watermark ||
        successor.head_sha === predecessor.head_sha
      ) {
        blocked("THREAD_RESOLUTION_CHAIN_BROKEN", threadId, firstRecord);
        broken = true;
        break;
      }
    }
    if (broken) continue;
    const activeRecord = chain[chain.length - 1];
    // An invalidation of the active record -- with no SUPERSEDES after it --
    // is an invalidated active frontier. A compensating unresolve bound to it
    // is the same state wearing its consequence: neither has been retired.
    if (
      invalidated.some((event) => event.record_id === activeRecord.action_id) ||
      unresolved.some((event) => event.record_id === activeRecord.action_id)
    ) {
      blocked(
        "THREAD_RESOLUTION_INVALIDATED",
        threadId,
        activeRecord,
      );
      continue;
    }
    // The active record's resolution must be at the head the observation
    // covers. A successor on an unrelated or rewritten head passes the
    // inequality check without ever having been recorded against the head
    // the replay evaluates, so the terminal claim would mint over a
    // resolution that never happened there. The pure replay cannot verify
    // git descent -- the SUPERSEDES writer's ancestry check is the RFC's
    // other half -- but this is the strongest structural proof available.
    if (
      activeRecord.head_sha !==
      (ledger.latest_observation?.pull_request?.head_sha ?? null)
    ) {
      blocked("THREAD_RESOLUTION_CHAIN_BROKEN", threadId, activeRecord);
      continue;
    }
    active.set(threadId, activeRecord);
  }
  return { active, blockers };
}

// The digest the terminal record binds over every automatic-resolution record
// and lifecycle event the replay consumed. RFC 0003: the final gate and the
// terminal record both bind the record-and-lifecycle-set digest.
function resolutionSetDigest(ledger) {
  return sha256(
    canonicalJson({
      automatic_resolutions: ledger.automatic_resolutions ?? [],
      resolution_lifecycle: ledger.resolution_lifecycle ?? [],
    }),
  );
}

// Whether a comment that is not the Codex root is not the workflow's own
// recorded reply either. Mirrors the eligibility rule's sole exception: an
// operator writing in the thread by hand is a participant, not a step of this
// workflow. The active record's watermark cannot carry this check alone -- a
// record is bound to the watermark that included the comment sequence at
// creation, so a thread that was never eligible could still replay -- which is
// why the terminal projection asks the question directly.
function threadHasForeignParticipation(ledger, binding, thread) {
  if (thread.provenance_complete !== true || !Array.isArray(thread.comments)) {
    return false;
  }
  const codexActor = ledger.target.codex_actor;
  const replies = binding?.thread_replies ?? [];
  return thread.comments.some((comment, index) => {
    if (index === 0) {
      return (
        comment.actor?.id !== codexActor.id ||
        comment.actor?.type !== codexActor.type
      );
    }
    if (
      comment.actor?.id === codexActor.id &&
      comment.actor?.type === codexActor.type
    ) {
      return false;
    }
    return !replies.some(
      (reply) =>
        reply.thread_id === thread.id &&
        reply.comment_id === comment.database_id &&
        reply.actor.id === comment.actor?.id &&
        reply.actor.type === comment.actor?.type,
    );
  });
}

function matchingPreResolvedWorkflowOutcome(ledger, binding, thread) {
  if (thread.provenance_complete !== true) {
    return false;
  }
  const headSha = ledger.latest_observation?.pull_request?.head_sha;
  const watermark = threadWatermark(thread);
  return (binding?.thread_resolutions ?? []).some(
    (resolution) =>
      resolution.outcome === "OBSERVED_PRE_RESOLVED" &&
      resolution.thread_id === thread.id &&
      resolution.publication_review_id === ledger.review_id &&
      resolution.head_sha === headSha &&
      resolution.thread_watermark === watermark,
  );
}

// The terminal projection's replay: every blocking reason the RFC names, over
// the frontier plus the post-ready observation's thread watermarks. Returns an
// empty list only when every chain replays and every active record still
// matches its thread exactly.
//
// `resolutionContext` is the precomputed effective resolution context for the
// operation (see `withEffectiveResolutionContext`). Its `proofs` map carries
// the threads whose resolution is proven by a validated historical ancestor
// publication; those threads are covered exactly like pre-resolved outcomes
// and never reported RECORD_MISSING. When no context is supplied the replay
// behaves exactly as before, so every caller that predates Design A keeps its
// verdict.
function terminalResolutionBlockers(ledger, binding, resolutionContext = null) {
  const frontier = resolutionFrontier(ledger);
  const blockers = [...frontier.blockers];
  const threads = new Map(
    (ledger.latest_observation?.review_threads?.threads ?? []).map((thread) => [
      thread.id,
      thread,
    ]),
  );
  for (const [threadId, record] of frontier.active) {
    const thread = threads.get(threadId);
    if (
      thread == null ||
      thread.provenance_complete !== true ||
      thread.is_resolved !== true ||
      threadWatermark(thread) !== record.thread_watermark
    ) {
      blockers.push({
        reason: "THREAD_RESOLUTION_INVALIDATED",
        thread_id: threadId,
        record,
      });
      continue;
    }
    if (threadHasForeignParticipation(ledger, binding, thread)) {
      blockers.push({
        reason: "THREAD_RESOLUTION_UNSAFE",
        thread_id: threadId,
        record,
      });
    }
  }
  // A resolved thread with no active record ordinarily has unknown ownership,
  // so the terminal claim must not mint over it. The two recordless workflow
  // paths are an action whose pre-read found this exact thread already
  // resolved -- its completed outcome binds the same publication, head, and
  // watermark but deliberately owns no automatic-resolution record -- and a
  // later publication reusing the workflow-owned resolution proof its
  // ancestor publication recorded, which the precomputed context qualified
  // against the same lineage, source, and current-thread evidence.
  const alreadyBlocked = new Set(
    blockers.map((blocker) => blocker.thread_id),
  );
  for (const thread of ledger.latest_observation?.review_threads?.threads ??
    []) {
    if (
      thread.is_resolved === true &&
      !frontier.active.has(thread.id) &&
      !alreadyBlocked.has(thread.id)
    ) {
      if (
        matchingPreResolvedWorkflowOutcome(ledger, binding, thread) ||
        resolutionContext?.proofs?.has(thread.id)
      ) {
        if (threadHasForeignParticipation(ledger, binding, thread)) {
          blockers.push({
            reason: "THREAD_RESOLUTION_UNSAFE",
            thread_id: thread.id,
            record: null,
          });
        }
        continue;
      }
      blockers.push({
        reason: "THREAD_RESOLUTION_RECORD_MISSING",
        thread_id: thread.id,
        record: null,
      });
    }
  }
  return blockers;
}

/**
 * Whether one workflow attempt strictly precedes another in the recorded
 * attempt history, each appearing exactly once. The lineage is the durable
 * `workflow.attempts` order (oldest first): a duplicated, absent, or
 * reordered head cannot prove that the historical resolution's head is an
 * ancestor of the current authorization head.
 */
function validAttemptLineage(attemptHeadHistory, oldHead, currentHead) {
  let oldIndex = -1;
  let currentIndex = -1;
  for (let index = 0; index < attemptHeadHistory.length; index += 1) {
    const head = attemptHeadHistory[index];
    if (head === oldHead) {
      if (oldIndex !== -1) {
        return false;
      }
      oldIndex = index;
    }
    if (head === currentHead) {
      if (currentIndex !== -1) {
        return false;
      }
      currentIndex = index;
    }
  }
  return oldIndex !== -1 && currentIndex !== -1 && oldIndex < currentIndex;
}

function attemptIndex(attemptHeadHistory, head) {
  return attemptHeadHistory.indexOf(head);
}

// The digest a terminal record or final gate binds when the replay consumed a
// validated historical resolution proof. The current resolution set digest is
// wrapped together with the sorted historical references, so no proof can be
// substituted, dropped, or added after the fact without changing the bound
// digest. With no proofs the exact existing resolutionSetDigest output is
// preserved, so v3 gates minted without historical context and v1/v2 gates
// never see a different value.
function effectiveResolutionDigest(currentDigest, proofs) {
  if (proofs.size === 0) {
    return currentDigest;
  }
  // Code-unit string order, not localeCompare: the digest must be stable
  // across runtimes and locales, and no environment locale may influence
  // which references the bound digest names.
  const historical = [...proofs.values()].sort((left, right) => {
    if (left.thread_id < right.thread_id) {
      return -1;
    }
    if (left.thread_id > right.thread_id) {
      return 1;
    }
    return 0;
  });
  return sha256(
    canonicalJson({
      resolution_sha256: currentDigest,
      historical,
    }),
  );
}

async function withAncestorPublicationLock(paths, reviewId, operation) {
  return withStateLock(
    {
      directory: paths.directory,
      reviewId,
      domain: "publication",
      waitMs: HISTORICAL_ANCESTOR_LOCK_WAIT_MS,
    },
    operation,
  );
}

/**
 * Validate one historical resolution outcome against the ancestor publication
 * it names, under that publication's retained lock, and return the reference
 * that binds the proof into the effective digest. Returns null when any link
 * fails: missing or substituted source, broken binding or authorization
 * identity, a missing/corrupt/substituted bound authorization artifact, a
 * source head that does not match the outcome, a source frontier that does
 * not actively own the exact outcome, a source latest observation that no
 * longer shows the exact thread resolved and complete at the record's
 * watermark, unsafe participation, or a current thread that no longer
 * matches. A null leaves the thread blocked exactly as a recordless thread is
 * blocked today.
 *
 * Lock order: the caller already holds the current publication lock, and this
 * runs under the ancestor publication lock retained by
 * `withEffectiveResolutionContext` (newest-to-oldest across outcomes).
 * Publication locks never acquire the workflow lock (binding reads are
 * lock-free), so no cycle exists between the workflow lock, the current
 * publication lock, and the ancestor publication locks.
 */
async function qualifyHistoricalProof(
  storeRoot,
  ledger,
  binding,
  thread,
  outcome,
) {
  const ancestorPaths = pathsFor(storeRoot, outcome.publication_review_id);
  try {
    const ancestorLedger = await loadPublicationFile(
      ancestorPaths,
      outcome.publication_review_id,
      { allowMissing: true },
    );
    if (ancestorLedger == null) {
      // The named historical publication no longer exists: there is no
      // source ledger to prove the resolution from.
      return null;
    }
    const ancestorBinding = await requireWorkflowBinding(
      storeRoot,
      ancestorLedger,
    );
    if (
      ancestorBinding == null ||
      ancestorBinding.workflow_id !== binding?.workflow_id ||
      ancestorBinding.workflow_authorization_sha256 !==
        binding?.workflow_authorization_sha256
    ) {
      // The source publication is not bound to this workflow under this
      // authorization, so its record cannot prove this workflow's
      // resolution.
      return null;
    }
    const currentTarget = ledger.target;
    const ancestorTarget = ancestorLedger.target;
    if (
      ancestorTarget.repository_id !== currentTarget.repository_id ||
      ancestorTarget.owner !== currentTarget.owner ||
      ancestorTarget.repo !== currentTarget.repo ||
      ancestorTarget.pr_number !== currentTarget.pr_number ||
      ancestorTarget.base_branch !== currentTarget.base_branch ||
      ancestorTarget.head_branch !== currentTarget.head_branch
    ) {
      // The source publication belongs to a different pull request or
      // target: its thread resolution decides nothing for this one.
      return null;
    }
    // Revalidate the source publication's bound authorization artifact under
    // the retained source lock, exactly as every other consumer does: the
    // local gate or remote authorization must exist, be well-formed, match
    // the ledger's authorization, and be the only authorization present. A
    // missing, corrupt, or substituted artifact means the ledger's
    // authorization facts cannot be trusted, so the source cannot prove the
    // outcome.
    const sourceAuthorization = await readBoundAuthorization(
      ancestorPaths,
      outcome.publication_review_id,
      ancestorLedger,
    );
    if (sourceAuthorization.head_sha !== outcome.head_sha) {
      // The source publication's validated authorization head is not the
      // head the workflow outcome recorded, so the record cannot be the
      // outcome's.
      return null;
    }
    // Replay the ancestor's complete automatic-resolution records and
    // lifecycle events. Only the exact outcome action/thread/head/
    // watermark as the active frontier record qualifies; missing,
    // retired, invalidated, orphaned, broken, substituted, or unrelated
    // evidence leaves the thread blocked.
    const ancestorFrontier = resolutionFrontier(ancestorLedger);
    const activeRecord = ancestorFrontier.active.get(outcome.thread_id);
    if (
      activeRecord == null ||
      activeRecord.action_id !== outcome.action_id ||
      activeRecord.thread_id !== outcome.thread_id ||
      activeRecord.head_sha !== outcome.head_sha ||
      activeRecord.thread_watermark !== outcome.thread_watermark
    ) {
      return null;
    }
    // The source's latest persisted observation must still show the exact
    // thread resolved, complete, at the record's watermark, under a complete
    // review-thread collection, and free of foreign participation under the
    // same policy that guards active records and pre-resolved outcomes. The
    // observation is mandatory: absence of source observation is not proof,
    // so a cleared observation (latest_observation is null) never qualifies
    // the thread, whatever the frontier alone would conclude. The only
    // accepted visibility boundary is a human toggle that leaves the
    // persisted resolution visible -- the source observation still positively
    // shows the thread -- never the absence of the observation itself.
    const ancestorObservation = ancestorLedger.latest_observation;
    if (ancestorObservation == null) {
      return null;
    }
    const reviewThreads = ancestorObservation.review_threads;
    const sourceThreads = reviewThreads?.threads;
    if (
      !Array.isArray(sourceThreads) ||
      reviewThreads.collection?.status !== "COMPLETE"
    ) {
      return null;
    }
    const sourceThread = sourceThreads.find(
      (candidate) => candidate.id === outcome.thread_id,
    );
    if (
      sourceThread == null ||
      sourceThread.is_resolved !== true ||
      sourceThread.provenance_complete !== true ||
      sourceThread.comments_pagination_complete !== true ||
      threadWatermark(sourceThread) !== activeRecord.thread_watermark
    ) {
      return null;
    }
    if (
      threadHasForeignParticipation(
        ancestorLedger,
        ancestorBinding,
        sourceThread,
      )
    ) {
      return null;
    }
    // The current thread must still be resolved, complete, at the exact same
    // watermark, and free of foreign participation under the same policy that
    // guards active records and pre-resolved outcomes.
    if (
      thread.provenance_complete !== true ||
      thread.comments_pagination_complete !== true ||
      threadWatermark(thread) !== outcome.thread_watermark
    ) {
      return null;
    }
    if (threadHasForeignParticipation(ledger, binding, thread)) {
      return null;
    }
    return {
      thread_id: thread.id,
      source_publication_review_id: ancestorLedger.review_id,
      source_publication_revision: ancestorLedger.revision,
      // The source publication's own authorization digest (the local gate or
      // remote authorization artifact), bound separately from the workflow
      // authorization digest below.
      source_authorization_sha256: sourceAuthorization.source_sha256,
      workflow_authorization_sha256:
        ancestorBinding.workflow_authorization_sha256,
      source_resolution_sha256: resolutionSetDigest(ancestorLedger),
      action_id: activeRecord.action_id,
      record_digest: sha256(canonicalJson(activeRecord)),
    };
  } catch (error) {
    // Lock contention on the source publication is the one failure that must
    // propagate as retryable PUBLICATION_BUSY: the evidence may be mid-write
    // and the caller must reread and retry, never silently degrade to success
    // or to a missing-record verdict. Any other source failure means the
    // source cannot qualify, so the thread stays blocked by the ordinary
    // recordless path.
    if (error?.code === "PUBLICATION_BUSY") {
      throw error;
    }
    return null;
  }
}

/**
 * Precompute, once per operation, the effective resolution context every
 * safety consumer shares: the autonomous terminal projection, the summary
 * replay override, manual finalization, and gate assessment/verification.
 *
 * A current resolved thread that owns no active record and is not covered by
 * the exact current-head OBSERVED_PRE_RESOLVED exception may reuse a
 * workflow-owned automatic-resolution proof from an ancestor publication when
 * every link qualifies: an exact historical RESOLVED outcome, an ordered
 * unique attempt lineage from the outcome head to the current authorization
 * head, a source publication that revalidates under its own lock (including
 * its bound authorization artifact and its latest observation), a source
 * frontier whose active record is exactly the outcome, and a current thread
 * that still matches. Threads that fail any link keep the ordinary
 * fail-closed verdict (THREAD_RESOLUTION_RECORD_MISSING and friends).
 *
 * The authority-consuming operation runs inside the retained-lock callback:
 * every unique ancestor publication lock is acquired once, newest-to-oldest
 * by workflow attempt order, and held -- together with the validated
 * authorization evidence the proofs were read under -- until `operation`
 * returns. No consumer reads a source from an unlocked snapshot, and no
 * source lock is released before the write the digest authorizes commits.
 * The current publication lock is already held by every caller, and
 * publication-lock paths never acquire the workflow lock (binding reads are
 * lock-free), so the acyclic order is: workflow lock (when held) -> current
 * publication -> source ancestors newest-to-oldest. Source lock contention
 * propagates retryable PUBLICATION_BUSY and never maps to a missing-record or
 * success verdict.
 *
 * The returned `effectiveDigest` preserves the exact `resolutionSetDigest`
 * output when no proofs exist, so empty-context behavior and v1/v2
 * compatibility are unchanged.
 */
async function withEffectiveResolutionContext(
  storeRoot,
  ledger,
  binding,
  operation,
) {
  const currentDigest = resolutionSetDigest(ledger);
  if (
    ledger.version !== 3 ||
    ledger.latest_observation?.review_threads == null
  ) {
    return operation({ proofs: new Map(), effectiveDigest: currentDigest });
  }
  const frontier = resolutionFrontier(ledger);
  const currentHead = authorizationForLedger(ledger).head_sha;
  const attemptHeadHistory = binding?.attempt_head_history ?? [];
  const candidates = [];
  for (const thread of ledger.latest_observation.review_threads.threads ?? []) {
    if (
      thread.is_resolved !== true ||
      frontier.active.has(thread.id) ||
      matchingPreResolvedWorkflowOutcome(ledger, binding, thread)
    ) {
      continue;
    }
    const outcome = (binding?.thread_resolutions ?? []).findLast(
      (resolution) =>
        resolution.outcome === "RESOLVED" &&
        resolution.thread_id === thread.id &&
        resolution.publication_review_id !== ledger.review_id,
    );
    if (outcome == null) {
      continue;
    }
    if (
      !validAttemptLineage(attemptHeadHistory, outcome.head_sha, currentHead)
    ) {
      continue;
    }
    candidates.push({ thread, outcome });
  }
  // Acquire ancestor publication locks newest-to-oldest by attempt order so
  // concurrent operations over the same lineage cannot deadlock on each
  // other's source locks. Multiple threads from the same source publication
  // share one lock acquisition.
  candidates.sort(
    (left, right) =>
      attemptIndex(attemptHeadHistory, right.outcome.head_sha) -
      attemptIndex(attemptHeadHistory, left.outcome.head_sha),
  );
  const sources = [];
  const sourcesByReviewId = new Map();
  for (const { outcome } of candidates) {
    const headIndex = attemptIndex(attemptHeadHistory, outcome.head_sha);
    const existing = sourcesByReviewId.get(outcome.publication_review_id);
    if (existing == null) {
      const entry = { reviewId: outcome.publication_review_id, headIndex };
      sourcesByReviewId.set(outcome.publication_review_id, entry);
      sources.push(entry);
    } else if (headIndex > existing.headIndex) {
      existing.headIndex = headIndex;
    }
  }
  sources.sort((left, right) => right.headIndex - left.headIndex);
  return acquireSourceLocks(storeRoot, sources, 0, async () => {
    const proofs = new Map();
    for (const { thread, outcome } of candidates) {
      const proof = await qualifyHistoricalProof(
        storeRoot,
        ledger,
        binding,
        thread,
        outcome,
      );
      if (proof != null) {
        proofs.set(thread.id, proof);
      }
    }
    return operation({
      proofs,
      effectiveDigest: effectiveResolutionDigest(currentDigest, proofs),
    });
  });
}

// Recursively hold every unique ancestor publication lock, newest-to-oldest,
// for the duration of `operation`. Release unwinds oldest-to-newest; combined
// with the newest-first acquisition this keeps the global lock order
// deterministic so concurrent consumers of the same lineage never deadlock.
async function acquireSourceLocks(storeRoot, sources, position, operation) {
  if (position >= sources.length) {
    return operation();
  }
  const reviewId = sources[position].reviewId;
  return withAncestorPublicationLock(
    pathsFor(storeRoot, reviewId),
    reviewId,
    () => acquireSourceLocks(storeRoot, sources, position + 1, operation),
  );
}

export function derivePublicationStatus(ledger) {
  return derivePublication(clone(ledger));
}

function publicationLock(paths, reviewId, operation) {
  return withStateLock(
    {
      directory: paths.directory,
      reviewId,
      domain: "publication",
    },
    operation,
  );
}

function assertLedgerSize(ledger) {
  const bytes = canonicalJsonBytes(ledger).length;
  const limit =
    ledger.terminal == null
      ? MAX_PUBLICATION_BYTES - TERMINAL_RESERVE_BYTES
      : MAX_PUBLICATION_BYTES;
  if (bytes > limit) {
    fail(
      "PUBLICATION_LIMIT_EXCEEDED",
      `publication ledger would exceed ${limit} bytes`,
    );
  }
  const acknowledgements = ledger.codex_review_ambiguity_acknowledgements;
  if (acknowledgements.length > 1_000) {
    fail("PUBLICATION_LIMIT_EXCEEDED", "publication has more than 1,000 acknowledgements");
  }
  for (const acknowledgement of acknowledgements) {
    if (
      acknowledgement.closed_requests.length +
        acknowledgement.closed_results.length >
      1_000
    ) {
      fail(
        "PUBLICATION_LIMIT_EXCEEDED",
        "one acknowledgement has more than 1,000 references",
      );
    }
  }
  const arrays = [
    ledger.codex_request_history,
    ledger.codex_result_history,
    acknowledgements,
    ledger.history,
  ];
  if (arrays.some((array) => array.length > 10_000)) {
    fail("PUBLICATION_LIMIT_EXCEEDED", "one monotonic ledger array exceeds 10,000 entries");
  }
  const aggregate =
    arrays.reduce((sum, array) => sum + array.length, 0) +
    acknowledgements.reduce(
      (sum, acknowledgement) =>
        sum +
        acknowledgement.closed_requests.length +
        acknowledgement.closed_results.length,
      0,
    );
  if (
    ledger.terminal == null &&
    (ledger.history.length > 9_999 || aggregate > 19_999)
  ) {
    fail(
      "PUBLICATION_LIMIT_EXCEEDED",
      "non-terminal monotonic state exhausted its reserved terminal capacity",
    );
  }
  if (aggregate > 20_000) {
    fail("PUBLICATION_LIMIT_EXCEEDED", "monotonic publication state exceeds 20,000 entries");
  }
}

function monotonicEntryCount(ledger) {
  return (
    ledger.codex_request_history.length +
    ledger.codex_result_history.length +
    ledger.codex_review_ambiguity_acknowledgements.length +
    ledger.history.length +
    ledger.codex_review_ambiguity_acknowledgements.reduce(
      (sum, acknowledgement) =>
        sum +
        acknowledgement.closed_requests.length +
        acknowledgement.closed_results.length,
      0,
    )
  );
}

function mandatoryStateExceedsNonterminalCapacity(ledger) {
  const minimal = { ...ledger, latest_observation: null };
  return (
    ledger.codex_request_history.length > 10_000 ||
    ledger.codex_result_history.length > 10_000 ||
    ledger.codex_review_ambiguity_acknowledgements.length > 1_000 ||
    ledger.history.length > 9_999 ||
    monotonicEntryCount(ledger) > 19_999 ||
    canonicalJsonBytes(minimal).length >
      MAX_PUBLICATION_BYTES - TERMINAL_RESERVE_BYTES
  );
}

function capacityTerminal(original, candidate) {
  if (
    candidate.terminal != null ||
    !mandatoryStateExceedsNonterminalCapacity(candidate)
  ) {
    return candidate;
  }
  const historyEvent = candidate.history.at(-1);
  const terminal = clone(original);
  terminal.revision = candidate.revision;
  terminal.updated_at = candidate.updated_at;
  terminal.latest_observation = null;
  terminal.status = "INVALIDATED";
  terminal.terminal = {
    status: "INVALIDATED",
    at: candidate.updated_at,
    revision: candidate.revision,
    reason: "server-owned monotonic publication state exceeds version 1 capacity",
  };
  terminal.history.push({
    ...historyEvent,
    status: "INVALIDATED",
  });
  return terminal;
}

async function saveLedger(paths, ledger) {
  assertLedgerSize(ledger);
  await atomicWriteCanonicalJson(paths.publication, ledger);
}

async function revokeGate(paths) {
  await removeAndSync(paths.gate);
}

async function pathExists(filePath) {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function createEmptyPrivateFile(filePath) {
  const handle = await fsp.open(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fsp.open(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function emptyAuditHead(reviewId) {
  return {
    version: 1,
    review_id: reviewId,
    committed_bytes: 0,
    next_sequence: 1,
    last_event_sha256: null,
  };
}

async function validatedAuditHeadTemporaries(paths) {
  const prefix = `${path.basename(paths.auditHead)}.`;
  const pattern = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{32}\\.tmp$`,
  );
  const entries = await fsp.readdir(paths.directory, { withFileTypes: true });
  const temporaries = [];
  for (const entry of entries) {
    if (!pattern.test(entry.name)) {
      continue;
    }
    const temporary = path.join(paths.directory, entry.name);
    const stat = await fsp.lstat(temporary);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail("AUDIT_STATE_INVALID", `${temporary} must be a regular non-symlink temporary`);
    }
    temporaries.push(temporary);
  }
  return temporaries;
}

async function cleanupAuditHeadTemporaries(paths) {
  const temporaries = await validatedAuditHeadTemporaries(paths);
  for (const temporary of temporaries) {
    await fsp.unlink(temporary);
  }
  if (temporaries.length > 0) {
    const directory = await fsp.open(paths.directory, fs.constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function initializeAudit(paths, reviewId) {
  const [logExists, headExists] = await Promise.all([
    pathExists(paths.auditLog),
    pathExists(paths.auditHead),
  ]);
  if (!logExists && headExists) {
    fail("AUDIT_STATE_INVALID", "audit head exists without its log");
  }
  if (!logExists) {
    await createEmptyPrivateFile(paths.auditLog);
  }
  const openedLog = await openAuditLog(paths.auditLog);
  try {
    if (openedLog.stat.size !== 0) {
      fail("AUDIT_STATE_INVALID", "pre-start audit log must be empty");
    }
  } finally {
    await openedLog.handle.close();
  }
  if (!headExists) {
    await cleanupAuditHeadTemporaries(paths);
    await atomicWriteCanonicalJson(paths.auditHead, emptyAuditHead(reviewId));
    return;
  }
  const head = await readSecureJson(paths.auditHead, {
    requiredMode: 0o600,
    maxBytes: 16 * 1024,
  });
  assertStoredCanonicalJson(
    head,
    canonicalJson(emptyAuditHead(reviewId)),
    "AUDIT_STATE_INVALID",
    "pre-start audit head is not the empty version 1 cursor",
  );
  await cleanupAuditHeadTemporaries(paths);
}

async function openAuditLog(filePath, { readOnly = false } = {}) {
  const handle = await fsp.open(
    filePath,
    (readOnly
      ? fs.constants.O_RDONLY
      : fs.constants.O_RDWR | fs.constants.O_APPEND) |
      (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new StoreError("STORE_FILE_TYPE_INVALID", `${filePath} must be a regular file`);
    }
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      throw new StoreError(
        "STORE_MODE_MISMATCH",
        `${filePath} has mode ${mode.toString(8)}; run chmod 0600 and retry`,
        {
          path: filePath,
          actual_mode: mode.toString(8).padStart(4, "0"),
          required_mode: "0600",
        },
      );
    }
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function validateAuditEvent(event, reviewId, head) {
  const keys = isJsonObject(event) ? Object.keys(event) : [];
  if (
    !isJsonObject(event) ||
    keys.length !== AUDIT_EVENT_KEYS.size ||
    keys.some((key) => !AUDIT_EVENT_KEYS.has(key)) ||
    event.version !== 1 ||
    event.review_id !== reviewId ||
    event.sequence !== head.next_sequence ||
    event.previous_event_sha256 !== head.last_event_sha256 ||
    !/^[0-9a-f]{32}$/.test(event.event_id)
  ) {
    fail("AUDIT_CORRUPT", "audit event does not match the committed cursor");
  }
  const validAt = isCanonicalTimestamp(event.at);
  const validExpiresAt =
    event.expires_at === null || isCanonicalTimestamp(event.expires_at);
  const validRevision =
    event.publication_revision === null ||
    (Number.isSafeInteger(event.publication_revision) &&
      event.publication_revision > 0);
  const validHead =
    event.head_sha === null ||
    (typeof event.head_sha === "string" && SHA_RE.test(event.head_sha));
  const validObservationDigest =
    event.github_observation_sha256 === null ||
    (typeof event.github_observation_sha256 === "string" &&
      DIGEST_RE.test(event.github_observation_sha256));
  const validGateDigest =
    event.gate_sha256 === null ||
    (typeof event.gate_sha256 === "string" &&
      DIGEST_RE.test(event.gate_sha256));
  const validReason =
    event.normalized_reason === null ||
    VERIFICATION_FAILURE_REASONS.has(event.normalized_reason);
  const validPreviousDigest =
    event.sequence === 1
      ? event.previous_event_sha256 === null
      : typeof event.previous_event_sha256 === "string" &&
        DIGEST_RE.test(event.previous_event_sha256);
  if (
    !["GATE_FINALIZATION_PASSED", "GATE_VERIFIED"].includes(event.event) ||
    !["SUCCESS", "FAILURE"].includes(event.outcome) ||
    !validAt ||
    !validExpiresAt ||
    !validRevision ||
    !validHead ||
    !validObservationDigest ||
    !validGateDigest ||
    !validReason ||
    !validPreviousDigest
  ) {
    fail("AUDIT_CORRUPT", "audit event fields are invalid");
  }
  const hasCompleteIdentity =
    event.publication_revision !== null &&
    event.head_sha !== null &&
    event.github_observation_sha256 !== null &&
    event.gate_sha256 !== null &&
    event.expires_at !== null;
  const invalidSuccess =
    event.normalized_reason !== null ||
    !hasCompleteIdentity ||
    Date.parse(event.at) > Date.parse(event.expires_at);
  if (event.event === "GATE_FINALIZATION_PASSED") {
    if (event.outcome !== "SUCCESS" || invalidSuccess) {
      fail("AUDIT_CORRUPT", "audit event semantics are invalid");
    }
    return;
  }
  if (
    (event.outcome === "SUCCESS" && invalidSuccess) ||
    (event.outcome === "FAILURE" && event.normalized_reason === null)
  ) {
    fail("AUDIT_CORRUPT", "audit event semantics are invalid");
  }
}

async function readRange(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      length - total,
      position + total,
    );
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

async function validateLastCommittedAuditRecord(handle, head, reviewId) {
  if (head.committed_bytes === 0) {
    if (head.next_sequence !== 1 || head.last_event_sha256 !== null) {
      fail("AUDIT_CORRUPT", "empty audit cursor is inconsistent");
    }
    return;
  }
  const start = Math.max(
    0,
    head.committed_bytes - (MAX_AUDIT_EVENT_BYTES + 2),
  );
  const suffix = await readRange(handle, head.committed_bytes - start, start);
  if (suffix.at(-1) !== 0x0a) {
    fail("AUDIT_CORRUPT", "committed audit prefix is not newline terminated");
  }
  const priorNewline = suffix.lastIndexOf(0x0a, suffix.length - 2);
  const eventBytes = suffix.subarray(priorNewline + 1, suffix.length - 1);
  if (
    eventBytes.length === 0 ||
    eventBytes.length > MAX_AUDIT_EVENT_BYTES ||
    sha256(eventBytes) !== head.last_event_sha256
  ) {
    fail("AUDIT_CORRUPT", "last committed audit record disagrees with the cursor");
  }
  const event = parseJsonObject(
    eventBytes,
    "AUDIT_CORRUPT",
    "last committed audit record is malformed",
  );
  assertStoredCanonicalJson(
    event,
    eventBytes.toString("utf8"),
    "AUDIT_CORRUPT",
    "last committed audit record is not canonical",
  );
  validateAuditEvent(event, reviewId, {
    next_sequence: head.next_sequence - 1,
    last_event_sha256: event.previous_event_sha256,
  });
}

async function planAuditRecovery(reviewId, opened, head) {
  if (
    head.version !== 1 ||
    head.review_id !== reviewId ||
    !Number.isSafeInteger(head.committed_bytes) ||
    head.committed_bytes < 0 ||
    !Number.isSafeInteger(head.next_sequence) ||
    head.next_sequence < 1 ||
    (head.last_event_sha256 !== null && !DIGEST_RE.test(head.last_event_sha256))
  ) {
    fail("AUDIT_CORRUPT", "audit head is malformed");
  }
  if (opened.stat.size < head.committed_bytes) {
    fail("AUDIT_CORRUPT", "audit log is shorter than the committed cursor");
  }
  await validateLastCommittedAuditRecord(opened.handle, head, reviewId);
  const tailLength = opened.stat.size - head.committed_bytes;
  if (tailLength === 0) {
    return { action: "NONE", head };
  }
  if (tailLength > MAX_AUDIT_EVENT_BYTES + 1) {
    fail("AUDIT_CORRUPT", "audit crash tail exceeds one event");
  }
  const tail = await readRange(opened.handle, tailLength, head.committed_bytes);
  if (tail.length !== tailLength) {
    fail("AUDIT_CORRUPT", "audit log changed during recovery preflight");
  }
  const newlines = [...tail].filter((byte) => byte === 0x0a).length;
  if (newlines === 0) {
    return { action: "TRUNCATE", head };
  }
  if (newlines !== 1 || tail.at(-1) !== 0x0a) {
    fail("AUDIT_CORRUPT", "audit crash tail contains multiple or trailing records");
  }
  const eventBytes = tail.subarray(0, -1);
  const event = parseJsonObject(
    eventBytes,
    "AUDIT_CORRUPT",
    "complete audit crash tail is malformed",
  );
  assertStoredCanonicalJson(
    event,
    eventBytes.toString("utf8"),
    "AUDIT_CORRUPT",
    "complete audit crash tail is not canonical",
  );
  validateAuditEvent(event, reviewId, head);
  return {
    action: "ADOPT",
    head: {
      version: 1,
      review_id: reviewId,
      committed_bytes: opened.stat.size,
      next_sequence: head.next_sequence + 1,
      last_event_sha256: sha256(eventBytes),
    },
  };
}

async function applyAuditRecovery(paths, opened, recovery) {
  if (recovery.action === "TRUNCATE") {
    await opened.handle.truncate(recovery.head.committed_bytes);
    await opened.handle.sync();
  } else if (recovery.action === "ADOPT") {
    await atomicWriteCanonicalJson(paths.auditHead, recovery.head);
  }
  return recovery.head;
}

async function openAuditSession(paths, reviewId) {
  const opened = await openAuditLog(paths.auditLog);
  try {
    const openedHead = await readSecureFile(paths.auditHead, {
      requiredMode: 0o600,
      maxBytes: 16 * 1024,
    });
    try {
      let head = parseJsonObject(
        openedHead.bytes,
        "AUDIT_CORRUPT",
        "audit head is malformed",
      );
      assertStoredCanonicalJsonBytes(
        head,
        openedHead.bytes,
        "AUDIT_CORRUPT",
        "audit head is not canonical JSON",
      );
      const recovery = await planAuditRecovery(reviewId, opened, head);
      await cleanupAuditHeadTemporaries(paths);
      head = await applyAuditRecovery(paths, opened, recovery);
      return { opened, openedHead, head };
    } catch (error) {
      await openedHead.handle.close();
      throw error;
    }
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

async function closeAuditSession(session) {
  await Promise.all([
    session.opened.handle.close(),
    session.openedHead.handle.close(),
  ]);
}

async function inspectCommittedAudit(handle, committedBytes, reviewId) {
  const chunkBytes = 64 * 1024;
  let position = 0;
  let pending = Buffer.alloc(0);
  let eventCount = 0;
  let previous = null;
  while (position < committedBytes) {
    const requested = Math.min(chunkBytes, committedBytes - position);
    const chunk = await readRange(handle, requested, position);
    if (chunk.length !== requested) {
      fail("AUDIT_CORRUPT", "audit log changed during inspection");
    }
    position += chunk.length;
    const buffered =
      pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let lineStart = 0;
    let newline = buffered.indexOf(0x0a, lineStart);
    while (newline !== -1) {
      const eventBytes = buffered.subarray(lineStart, newline);
      eventCount += 1;
      if (
        eventBytes.length === 0 ||
        eventBytes.length > MAX_AUDIT_EVENT_BYTES
      ) {
        fail("AUDIT_CORRUPT", `audit event ${eventCount} has invalid size`);
      }
      const line = eventBytes.toString("utf8");
      const event = parseJsonObject(
        line,
        "AUDIT_CORRUPT",
        `audit event ${eventCount} is malformed`,
      );
      assertStoredCanonicalJson(
        event,
        line,
        "AUDIT_CORRUPT",
        `audit event ${eventCount} is not canonical`,
      );
      validateAuditEvent(event, reviewId, {
        next_sequence: eventCount,
        last_event_sha256: previous,
      });
      previous = sha256(eventBytes);
      lineStart = newline + 1;
      newline = buffered.indexOf(0x0a, lineStart);
    }
    pending = Buffer.from(buffered.subarray(lineStart));
    if (pending.length > MAX_AUDIT_EVENT_BYTES) {
      fail("AUDIT_CORRUPT", `audit event ${eventCount + 1} has invalid size`);
    }
  }
  if (pending.length !== 0) {
    fail("AUDIT_CORRUPT", "committed audit prefix is not newline terminated");
  }
  return { eventCount, lastEventSha256: previous };
}

export async function inspectPublicationAudit(storeRoot, reviewId) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const openedLog = await openAuditLog(paths.auditLog, { readOnly: true });
    let openedHead;
    try {
      openedHead = await readSecureFile(paths.auditHead, {
        requiredMode: 0o600,
        maxBytes: 16 * 1024,
      });
      const head = parseJsonObject(
        openedHead.bytes,
        "AUDIT_CORRUPT",
        "audit head is malformed",
      );
      assertStoredCanonicalJsonBytes(
        head,
        openedHead.bytes,
        "AUDIT_CORRUPT",
        "audit head is not canonical JSON",
      );
      if (
        head.version !== 1 ||
        head.review_id !== reviewId ||
        !Number.isSafeInteger(head.committed_bytes) ||
        head.committed_bytes < 0 ||
        head.committed_bytes > openedLog.stat.size ||
        !Number.isSafeInteger(head.next_sequence) ||
        head.next_sequence < 1 ||
        (head.last_event_sha256 !== null &&
          !DIGEST_RE.test(head.last_event_sha256))
      ) {
        fail("AUDIT_CORRUPT", "audit head is inconsistent");
      }
      const { eventCount, lastEventSha256 } = await inspectCommittedAudit(
        openedLog.handle,
        head.committed_bytes,
        reviewId,
      );
      if (
        head.next_sequence !== eventCount + 1 ||
        head.last_event_sha256 !== lastEventSha256
      ) {
        fail("AUDIT_CORRUPT", "audit chain does not match its committed cursor");
      }
      return {
        valid: true,
        review_id: reviewId,
        event_count: eventCount,
        committed_bytes: head.committed_bytes,
        last_event_sha256: lastEventSha256,
        uncommitted_tail_bytes:
          openedLog.stat.size - head.committed_bytes,
      };
    } finally {
      await Promise.all([
        openedLog.handle.close(),
        openedHead?.handle.close(),
      ]);
    }
  });
}

async function appendAuditEvent(paths, reviewId, fields, existingSession = null) {
  const session = existingSession ?? (await openAuditSession(paths, reviewId));
  const { opened } = session;
  try {
    const head = session.head;
    const event = {
      version: 1,
      review_id: reviewId,
      sequence: head.next_sequence,
      event_id: crypto.randomBytes(16).toString("hex"),
      previous_event_sha256: head.last_event_sha256,
      ...fields,
    };
    validateAuditEvent(event, reviewId, head);
    const eventBytes = Buffer.from(canonicalJson(event), "utf8");
    if (eventBytes.length > MAX_AUDIT_EVENT_BYTES) {
      fail("AUDIT_EVENT_TOO_LARGE", "audit event exceeds 16 KiB");
    }
    const line = Buffer.concat([eventBytes, Buffer.from("\n")]);
    let written = 0;
    while (written < line.length) {
      const result = await opened.handle.write(
        line,
        written,
        line.length - written,
        null,
      );
      if (result.bytesWritten <= 0) {
        fail("AUDIT_WRITE_FAILED", "audit append made no progress");
      }
      written += result.bytesWritten;
    }
    await opened.handle.sync();
    const nextHead = {
      version: 1,
      review_id: reviewId,
      committed_bytes: head.committed_bytes + line.length,
      next_sequence: head.next_sequence + 1,
      last_event_sha256: sha256(eventBytes),
    };
    await atomicWriteCanonicalJson(paths.auditHead, nextHead);
    session.head = nextHead;
    return event;
  } finally {
    if (existingSession == null) {
      await closeAuditSession(session);
    }
  }
}

function observationTimes(observation) {
  const times = [timestampMs(observation.observed_at, "observation.observed_at")];
  for (const [name, collection] of [
    ["pull_request.collection", observation.pull_request.collection],
    ["required_checks.collection", observation.required_checks.collection],
    ["codex_review.collection", observation.codex_review.collection],
    ["review_threads.collection", observation.review_threads.collection],
  ]) {
    times.push(...sourceTimes(collection, name));
  }
  // Each ancestry read on its own, exactly as at ingest: the summary source
  // carries only the latest, so without these a comparison near the age limit
  // stays alive until its freshest sibling expires.
  for (const entry of observation.review_threads.ancestry ?? []) {
    times.push(
      timestampMs(entry.collected_at, "review_threads.ancestry collected_at"),
    );
  }
  return times;
}

function oldestObservationAt(observation) {
  return new Date(Math.min(...observationTimes(observation))).toISOString();
}

function expiresAtFor(ledger) {
  const observation = ledger.latest_observation;
  const minimum = Math.min(
    timestampMs(observation.recorded_at, "observation.recorded_at"),
    ...observationTimes(observation),
  );
  return new Date(minimum + MAX_AGE_MS).toISOString();
}

function validateStoredObservationFresh(ledger, currentMs) {
  if (ledger.latest_observation == null) {
    fail("EVIDENCE_STALE", "record a fresh GitHub snapshot first");
  }
  const times = [
    timestampMs(ledger.latest_observation.recorded_at, "observation.recorded_at"),
    ...observationTimes(ledger.latest_observation),
  ];
  validateFreshTimes(times, ledger.created_at, currentMs, "stored GitHub observation");
  return times;
}

export async function authorizeRemotePublication(
  storeRoot,
  {
    repositoryPath,
    baseSha,
    headSha,
    acknowledgement,
    operatorLabel,
    rationale,
  },
  { clock = Date.now } = {},
) {
  assertString(repositoryPath, "repository_path", 4096);
  assertSha(baseSha, "base_sha");
  assertSha(headSha, "head_sha");
  if (acknowledgement !== "LOCAL_REVIEW_SKIPPED") {
    fail(
      "INVALID_INPUT",
      "acknowledgement must be LOCAL_REVIEW_SKIPPED",
    );
  }
  assertString(operatorLabel, "operator_label", 500);
  assertString(rationale, "rationale", 20_000);
  const requestedPath = path.resolve(repositoryPath);
  let repositoryRoot;
  try {
    repositoryRoot = await fsp.realpath(
      runGit(requestedPath, ["rev-parse", "--show-toplevel"]),
    );
  } catch (error) {
    if (error instanceof PublicationError) {
      throw error;
    }
    fail("LOCAL_REPOSITORY_ERROR", "repository_path is not an accessible Git repository");
  }
  const authorizedAt = new Date(clock()).toISOString();
  const repositoryBinding = {
    repository_path: repositoryRoot,
    base_sha: baseSha,
    head_sha: headSha,
  };
  verifyRemoteRepository(repositoryBinding);
  const reviewId = createPublicationId();
  const paths = pathsFor(storeRoot, reviewId);
  await fsp.mkdir(path.dirname(paths.directory), {
    recursive: true,
    mode: 0o700,
  });
  await fsp.mkdir(paths.directory, { mode: 0o700 });
  return publicationLock(paths, reviewId, async () => {
    const authorization = {
      version: 1,
      review_id: reviewId,
      mode: "REMOTE_ONLY",
      authorized_at: authorizedAt,
      repository_path: repositoryRoot,
      base_sha: baseSha,
      head_sha: headSha,
      reviewer_provider: null,
      acknowledgement,
      operator_label: operatorLabel,
      rationale,
    };
    verifyRemoteRepository(authorization);
    await atomicWriteCanonicalJson(paths.remoteAuthorization, authorization);
    return authorization;
  });
}

export async function startPublication(
  storeRoot,
  {
    reviewId,
    repositoryId,
    owner,
    repo,
    prNumber,
    baseBranch,
    headBranch,
    codexActorId,
    codexActorType,
    codexActorLogin,
    codexTriggerMode,
    operatorLabel = null,
    rationale = null,
    baseline,
    workflowId = null,
    expectedWorkflowRevision = null,
  },
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    assertId(repositoryId, "repository_id");
    assertId(prNumber, "pr_number");
    assertString(owner, "owner", 255);
    assertString(repo, "repo", 255);
    assertString(baseBranch, "base_branch", 255);
    assertString(headBranch, "head_branch", 255);
    assertId(codexActorId, "codex_actor_id");
    if (codexActorType !== "Bot") {
      fail("INVALID_INPUT", "codex_actor_type must be Bot");
    }
    assertString(codexActorLogin, "codex_actor_login", 255);
    assertEnum(
      codexTriggerMode,
      ["EXPLICIT_ONLY", "AUTOMATIC_QUIESCENCE_ACKNOWLEDGED"],
      "codex_trigger_mode",
    );
    if (codexTriggerMode === "EXPLICIT_ONLY") {
      if (operatorLabel != null || rationale != null) {
        fail("INVALID_INPUT", "explicit-only mode cannot include an acknowledgement");
      }
    } else {
      assertString(operatorLabel, "operator_label", 500);
      assertString(rationale, "rationale", 20_000);
    }
    if ((workflowId == null) !== (expectedWorkflowRevision == null)) {
      fail(
        "INVALID_INPUT",
        "an autonomous publication requires both workflow_id and expected_workflow_revision",
      );
    }
    const sourceAuthorization = await readStartAuthorization(
      paths,
      reviewId,
      { verifyRepository: true },
    );
    const workflowBinding =
      workflowId == null
        ? null
        : await requireStartWorkflowBinding(storeRoot, workflowId, {
            expectedWorkflowRevision,
            headSha: sourceAuthorization.head_sha,
            repositoryId,
            owner,
            repo,
            prNumber,
            baseBranch,
            headBranch,
            authorizationMode: sourceAuthorization.mode,
          });
    const existing = await loadPublicationFile(paths, reviewId, {
      allowMissing: true,
    });
    if (existing != null || (await pathExists(paths.gate))) {
      fail("PUBLICATION_ALREADY_STARTED", "publication state already exists");
    }
    const timestamp = new Date(currentMs).toISOString();
    const validatedBaseline = validateBaseline(baseline, currentMs, null, {
      id: codexActorId,
      type: "Bot",
    });
    const baselineAge =
      currentMs - Date.parse(validatedBaseline.observed_at);
    if (
      codexTriggerMode === "AUTOMATIC_QUIESCENCE_ACKNOWLEDGED" &&
      (baselineAge < 0 || baselineAge > MAX_FUTURE_MS)
    ) {
      fail(
        "INVALID_INPUT",
        "automatic-quiescence acknowledgement requires a completed baseline from the last 30 seconds",
      );
    }
    const baselineIssuances = await findBaselineIssuances(
      storeRoot,
      reviewId,
      {
        repository_id: repositoryId,
        owner,
        repo,
        pr_number: prNumber,
      },
      validatedBaseline,
    );
    const normalizedBaseline = normalizeBaseline(
      validatedBaseline,
      timestamp,
      baselineIssuances,
    );
    const ledger = {
      version: workflowBinding == null ? 2 : 3,
      revision: 1,
      review_id: reviewId,
      created_at: timestamp,
      updated_at: timestamp,
      ...(workflowBinding == null
        ? {}
        : {
            workflow_id: workflowBinding.workflow_id,
            workflow_authorization_sha256:
              workflowBinding.workflow_authorization_sha256,
            automatic_resolutions: [],
          }),
      authorization: {
        mode: sourceAuthorization.mode,
        head_sha: sourceAuthorization.head_sha,
        base_sha: sourceAuthorization.base_sha,
        snapshot_hash: sourceAuthorization.snapshot_hash,
        source_sha256: sourceAuthorization.source_sha256,
        reviewer_provider: sourceAuthorization.reviewer_provider,
        acknowledgement: sourceAuthorization.acknowledgement,
        operator_label: sourceAuthorization.operator_label,
        rationale: sourceAuthorization.rationale,
        authorized_at: sourceAuthorization.authorized_at,
      },
      target: {
        repository_id: repositoryId,
        owner,
        repo,
        pr_number: prNumber,
        base_branch: baseBranch,
        head_branch: headBranch,
        codex_actor: {
          id: codexActorId,
          type: "Bot",
          login_at_start: codexActorLogin,
        },
        codex_trigger_policy: {
          mode: codexTriggerMode,
          operator_label:
            codexTriggerMode === "EXPLICIT_ONLY" ? null : operatorLabel,
          rationale: codexTriggerMode === "EXPLICIT_ONLY" ? null : rationale,
          acknowledged_at:
            codexTriggerMode === "EXPLICIT_ONLY" ? null : timestamp,
        },
      },
      terminal: null,
      codex_review_baseline: normalizedBaseline,
      codex_review_ambiguity_acknowledgements: [],
      codex_request_history: [],
      codex_result_history: [],
      latest_observation: null,
      status: "PR_PENDING",
      history: [
        {
          at: timestamp,
          event: "PUBLICATION_STARTED",
          revision: 1,
          status: "PR_PENDING",
          head_sha: sourceAuthorization.head_sha,
        },
      ],
    };
    assertLedgerSize(ledger);
    await initializeAudit(paths, reviewId);
    await saveLedger(paths, ledger);
    return ledger;
  });
}

export async function getPublication(storeRoot, reviewId) {
  const paths = pathsFor(storeRoot, reviewId);
  const ledger = await loadPublicationFile(paths, reviewId, {
    allowMissing: true,
  });
  if (ledger == null) {
    fail("PUBLICATION_NOT_FOUND", `publication for ${reviewId} not found`);
  }
  return ledger;
}

function completedUnresolveRecordIds(binding, reviewId) {
  return new Set(
    (binding?.thread_unresolutions ?? [])
      .filter((entry) => entry.publication_review_id === reviewId)
      .map((entry) => entry.record_id),
  );
}

// The evidence a compensating-unresolve action must preserve before the
// workflow may advance to a new head. The invalidated record itself is
// deliberately absent from the active frontier; every other active record
// must remain usable as historical proof after this publication freezes.
export function projectUnresolveCompletionEvidence(
  ledger,
  binding,
  { recordId, actionId, newWatermark },
) {
  const invalidated = (ledger.resolution_lifecycle ?? []).find(
    (event) =>
      event.kind === "INVALIDATED" &&
      event.record_id === recordId &&
      event.new_watermark === newWatermark,
  );
  const unresolved = (ledger.resolution_lifecycle ?? []).find(
    (event) =>
      event.kind === "UNRESOLVED_FOR_REPAIR" &&
      event.record_id === recordId &&
      event.action_id === actionId,
  );
  const lifecycleRecorded = invalidated != null && unresolved != null;
  const observation = ledger.latest_observation;
  const blockers = [];
  const concurrentInvalidations = [];
  let targetUnsafe = false;
  if (lifecycleRecorded && observation != null) {
    const eventAt = Date.parse(unresolved.at);
    if (
      Date.parse(observation.recorded_at) <= eventAt ||
      Date.parse(oldestObservationAt(observation)) <= eventAt
    ) {
      blockers.push({
        reason: "OBSERVATION_NOT_FRESH",
        thread_id: null,
        record_id: null,
      });
    }
    const frontier = resolutionFrontier(ledger);
    const completedUnresolves = completedUnresolveRecordIds(
      binding,
      ledger.review_id,
    );
    const reviewThreads = observation.review_threads;
    const threads = new Map(
      (reviewThreads?.threads ?? []).map((thread) => [thread.id, thread]),
    );
    const targetThread = threads.get(invalidated.thread_id);
    let targetReason = null;
    const targetComments = new Map(
      (targetThread?.comments ?? []).map((comment) => [
        comment.database_id,
        comment,
      ]),
    );
    const preservesInvalidation = (invalidated.follow_up_comments ?? []).every(
      (followUp) => {
        const comment = targetComments.get(followUp.comment_id);
        return (
          comment != null &&
          comment.actor?.id === followUp.actor?.id &&
          comment.actor?.type === followUp.actor?.type &&
          comment.created_at === followUp.created_at
        );
      },
    );
    if (reviewThreads?.collection?.status !== "COMPLETE") {
      targetReason = "THREAD_COLLECTION_INCOMPLETE";
    } else if (targetThread == null) {
      targetReason = "THREAD_MISSING";
    } else if (targetThread.provenance_complete !== true) {
      targetReason = "THREAD_PROVENANCE_INCOMPLETE";
    } else if (targetThread.comments_pagination_complete !== true) {
      targetReason = "THREAD_PAGINATION_INCOMPLETE";
    } else if (targetThread.is_resolved !== false) {
      targetReason = "THREAD_RESOLVED";
    } else if (!preservesInvalidation) {
      targetReason = "THREAD_INVALIDATION_EVIDENCE_MISSING";
    }
    targetUnsafe =
      targetReason == null &&
      threadHasForeignParticipation(ledger, binding, targetThread);
    if (targetReason != null) {
      blockers.push({
        reason: targetReason,
        thread_id: invalidated.thread_id,
        record_id: recordId,
      });
    }
    for (const blocker of frontier.blockers) {
      const expectedInvalidation =
        blocker.reason === "THREAD_RESOLUTION_INVALIDATED" &&
        ((blocker.record?.action_id === recordId &&
          blocker.thread_id === invalidated.thread_id) ||
          completedUnresolves.has(blocker.record?.action_id));
      if (!expectedInvalidation) {
        blockers.push({
          reason: blocker.reason,
          thread_id: blocker.thread_id,
          record_id: blocker.record?.action_id ?? null,
        });
      }
    }
    for (const [threadId, record] of frontier.active) {
      const thread = threads.get(threadId);
      let reason = null;
      if (reviewThreads?.collection?.status !== "COMPLETE") {
        reason = "THREAD_COLLECTION_INCOMPLETE";
      } else if (thread == null) {
        reason = "THREAD_MISSING";
      } else if (thread.provenance_complete !== true) {
        reason = "THREAD_PROVENANCE_INCOMPLETE";
      } else if (thread.comments_pagination_complete !== true) {
        reason = "THREAD_PAGINATION_INCOMPLETE";
      } else {
        const watermarkMatches =
          threadWatermark(thread) === record.thread_watermark;
        const foreignParticipation = threadHasForeignParticipation(
          ledger,
          binding,
          thread,
        );
        if (
          thread.is_resolved !== true ||
          !watermarkMatches ||
          foreignParticipation
        ) {
          concurrentInvalidations.push({
            reason:
              thread.is_resolved !== true
                ? "THREAD_UNRESOLVED"
                : !watermarkMatches
                  ? "THREAD_WATERMARK_MISMATCH"
                  : "THREAD_RESOLUTION_UNSAFE",
            thread_id: threadId,
            record_id: record.action_id,
          });
        }
      }
      if (reason != null) {
        blockers.push({
          reason,
          thread_id: threadId,
          record_id: record.action_id,
        });
      }
    }
  }
  return {
    terminal: ledger.terminal,
    lifecycle_recorded: lifecycleRecorded,
    observation_refreshed:
      lifecycleRecorded && observation != null && blockers.length === 0,
    concurrent_invalidations: concurrentInvalidations,
    target_unsafe:
      lifecycleRecorded && observation != null && targetUnsafe === true,
    blockers,
  };
}

// Keep the publication stable until the workflow action commits. Otherwise a
// concurrent snapshot could replace a qualifying refresh with degraded proof
// between projection and completion.
export async function withUnresolveCompletionEvidenceLock(
  storeRoot,
  reviewId,
  target,
  operation,
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const ledger = await loadPublicationFile(paths, reviewId);
    const binding = await requireWorkflowBinding(storeRoot, ledger);
    return operation(
      projectUnresolveCompletionEvidence(ledger, binding, target),
    );
  });
}

function assessPublicationGate(
  ledger,
  publicationAuthorization,
  sourceAuthorization,
  gate,
  gateParseError,
  currentMs,
  workflowBinding = null,
  resolutionContext = null,
) {
  if (gateParseError) {
    return { state: "MALFORMED", reviewerProvider: null, expiresAt: null };
  }
  if (gate == null) {
    return { state: "ABSENT", reviewerProvider: null, expiresAt: null };
  }
  // The publication's MERGE_READY is independent of the workflow's phase: a
  // failing check parks the workflow in a repair phase while the ledger stays
  // bound at the same head, and if that check later passes a gate can be
  // minted while the workflow is already somewhere that can record a later
  // head. Refusing to mint a new gate is therefore not enough -- the conflict
  // has to reach the status this assessment checks, or an already-minted gate
  // keeps carrying authority for a head the workflow has replaced.
  const derived = derivePublication(ledger, {
    historyConflict: workflowHeadConflict(workflowBinding, ledger),
  });
  const expectedExpiresAt =
    ledger.latest_observation == null ? null : expiresAtFor(ledger);
  const gateReviewerProvider =
    gate.reviewer_provider ??
    (publicationAuthorization.mode === "LOCAL_GATE"
      ? "CLAUDE_DESKTOP"
      : null);
  const workflowBindingMatches =
    ledger.version !== 3
      ? !("workflow_id" in gate) &&
        !("workflow_authorization_sha256" in gate)
      : workflowBinding != null &&
        gate.workflow_id === ledger.workflow_id &&
        gate.workflow_id === workflowBinding.workflow_id &&
        gate.workflow_authorization_sha256 ===
          ledger.workflow_authorization_sha256 &&
        gate.workflow_authorization_sha256 ===
          workflowBinding.workflow_authorization_sha256 &&
        gate.resolution_sha256 ===
          (resolutionContext?.effectiveDigest ?? resolutionSetDigest(ledger));
  const authorizationBindingMatches =
    ledger.version === 1
      ? gate.version === 1 &&
        gate.local_gate_sha256 === publicationAuthorization.source_sha256
      : gate.version === ledger.version &&
        gate.authorization_mode === publicationAuthorization.mode &&
        gate.authorization_sha256 === publicationAuthorization.source_sha256;
  if (
    !authorizationBindingMatches ||
    !workflowBindingMatches ||
    gate.review_id !== ledger.review_id ||
    gate.issuance_committed !== true ||
    gate.status !== "MERGE_READY" ||
    gate.publication_revision !== ledger.revision ||
    gate.head_sha !== publicationAuthorization.head_sha ||
    gateReviewerProvider !== publicationAuthorization.reviewer_provider ||
    sourceAuthorization.source_sha256 !== publicationAuthorization.source_sha256 ||
    gate.github_observation_sha256 !== canonicalDigest(ledger.latest_observation) ||
    gate.expires_at !== expectedExpiresAt ||
    derived.status !== "MERGE_READY" ||
    // The terminal replay is the same evidence the autonomous terminal
    // projection refuses a success claim over; a gate minted before the
    // evidence moved must not keep verifying over what the replay rejects.
    (ledger.version === 3 &&
      workflowBinding != null &&
      terminalResolutionBlockers(
        ledger,
        workflowBinding,
        resolutionContext,
      ).length > 0)
  ) {
    return { state: "INVALID", reviewerProvider: null, expiresAt: null };
  }
  if (currentMs > Date.parse(expectedExpiresAt)) {
    return {
      state: "EXPIRED",
      reviewerProvider: gateReviewerProvider,
      expiresAt: expectedExpiresAt,
    };
  }
  return {
    state: "PRESENT",
    reviewerProvider: gateReviewerProvider,
    expiresAt: expectedExpiresAt,
  };
}

function nextPublicationAction(ledger, derived, gateState, evidenceStale) {
  if (ledger.terminal != null || ["CLOSED", "INVALIDATED", "MERGED"].includes(derived.status)) {
    return "NONE";
  }
  if (evidenceStale) {
    return "REFRESH_GITHUB_SNAPSHOT";
  }
  if (ledger.latest_observation == null) {
    if (
      ledger.codex_review_baseline.requests.some(
        (request) => request.classification !== "BASELINE_CORRELATED",
      ) ||
      ledger.codex_request_history.length > 0
    ) {
      return "RECORD_GITHUB_SNAPSHOT";
    }
    return "POST_AND_RECORD_CODEX_REVIEW_REQUEST";
  }
  switch (derived.status) {
    case "MERGE_READY":
      if (gateState === "PRESENT") {
        return "VERIFY_PUBLICATION_GATE";
      }
      return gateState === "MALFORMED"
        ? "REFRESH_GITHUB_SNAPSHOT"
        : "FINALIZE_PUBLICATION_GATE";
    case "GITHUB_REVIEW_UNKNOWN":
      return "ACKNOWLEDGE_CODEX_REVIEW_AMBIGUITY";
    case "GITHUB_REVIEW_NOT_REQUESTED":
      return "POST_AND_RECORD_CODEX_REVIEW_REQUEST";
    case "CHECKS_FAILED":
      return "FIX_REQUIRED_CHECKS";
    case "CHANGES_REQUIRED":
      return "ADDRESS_GITHUB_REVIEW_FEEDBACK";
    case "PR_DRAFT":
      return "MARK_PULL_REQUEST_READY";
    case "PR_CONFLICTING":
      return "RESOLVE_PULL_REQUEST_CONFLICTS";
    case "PR_UPDATE_REQUIRED":
      return "START_NEW_PUBLICATION_AUTHORIZATION";
    default:
      return "REFRESH_GITHUB_SNAPSHOT";
  }
}

export async function getPublicationSummary(
  storeRoot,
  reviewId,
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    const authorization = await openAuthorizationFiles(paths, reviewId);
    try {
      const ledger = authorization.ledger;
      const workflowBinding = await requireWorkflowBinding(storeRoot, ledger);
      // The summary computation and its gate assessment run inside the
      // retained source-lock callback so a historical proof can never be read
      // from an unlocked snapshot.
      return await withEffectiveResolutionContext(
        storeRoot,
        ledger,
        workflowBinding,
        async (resolutionContext) => {
          const publicationAuthorization = authorizationForLedger(ledger);
          const derived = derivePublication(ledger, {
            historyConflict: workflowHeadConflict(workflowBinding, ledger),
          });
          const gate = assessPublicationGate(
            ledger,
            publicationAuthorization,
            authorization.sourceAuthorization,
            authorization.publicationGate,
            authorization.gateParseError,
            currentMs,
            workflowBinding,
            resolutionContext,
          );
          const evidenceStale =
            ledger.terminal == null &&
            ledger.latest_observation != null &&
            currentMs > Date.parse(expiresAtFor(ledger));
          // The terminal replay is the same evidence the autonomous terminal
          // projection refuses a success claim over, and the same evidence
          // the finalization and verification paths now require clean. The
          // summary must reflect it too, or a summary-driven manual flow
          // would keep advertising FINALIZE_PUBLICATION_GATE and retry a
          // finalization that deterministically throws.
          const terminalBlockers =
            ledger.version === 3
              ? terminalResolutionBlockers(
                  ledger,
                  workflowBinding,
                  resolutionContext,
                )
              : [];
          const replayOverridesDerived =
            derived.status === "MERGE_READY" && terminalBlockers.length > 0;
          const effectiveStatus = replayOverridesDerived
            ? "CHANGES_REQUIRED"
            : derived.status;
          const blockingReason = evidenceStale
            ? "EVIDENCE_STALE"
            : replayOverridesDerived
              ? terminalBlockers[0].reason
              : derived.status === "MERGE_READY" && gate.state === "INVALID"
                ? "PUBLICATION_GATE_INVALID"
                : derived.status === "MERGE_READY" &&
                    gate.state === "MALFORMED"
                  ? "PUBLICATION_GATE_MALFORMED"
                  : derived.blockingReason;
          const closure =
            ledger.latest_observation == null
              ? { requests: [], results: [] }
              : ambiguityClosure(ledger);
          const nextAction = nextPublicationAction(
            ledger,
            { ...derived, status: effectiveStatus },
            gate.state,
            evidenceStale,
          );
          return {
            review_id: ledger.review_id,
            revision: ledger.revision,
            status: effectiveStatus,
            authorization_mode: publicationAuthorization.mode,
            base_sha: publicationAuthorization.base_sha,
            head_sha: publicationAuthorization.head_sha,
            target: {
              owner: ledger.target.owner,
              repo: ledger.target.repo,
              pr_number: ledger.target.pr_number,
              base_branch: ledger.target.base_branch,
              head_branch: ledger.target.head_branch,
            },
            latest_observed_at:
              ledger.latest_observation?.observed_at ?? null,
            blocking_reason: blockingReason,
            next_action: nextAction,
            ...(nextAction === "POST_AND_RECORD_CODEX_REVIEW_REQUEST"
              ? { codex_review_request: publicationRequest(ledger) }
              : {}),
            required_request_refs: clone(closure.requests),
            required_ambiguous_results: clone(closure.results),
            required_inputs: publicationRequiredInputs(nextAction),
            gate_state: gate.state,
            // Rounded down, so the reported window is never wider than the
            // one the expiry comparison enforces.
            gate_expires_in_seconds:
              gate.state === "PRESENT"
                ? Math.floor((Date.parse(gate.expiresAt) - currentMs) / 1000)
                : null,
          };
        },
      );
    } finally {
      await closeAuthorizationFiles(authorization);
    }
  });
}

/**
 * The exact blocking items behind a projection status, normalized so that two
 * attempts can be compared for progress. Titles, bodies, timestamps, run IDs,
 * and URLs are excluded: only identities that a fix has to change.
 *
 * A blocking status always yields at least one entry. An arm that narrows its
 * items -- to declared requirements, or to results at the authorized head --
 * can otherwise produce an empty set for a status that does block, leaving the
 * operator with a repair phase and nothing to act on. The status-and-reason
 * pair is the floor every other arm already falls through to.
 */
function normalizedBlockers(ledger, derived) {
  const specific = specificBlockers(ledger, derived);
  if (specific.length > 0 || derived.status === "MERGE_READY") {
    return specific;
  }
  return [`${derived.status}:${derived.blockingReason ?? ""}`];
}

/**
 * The comparison key for progress. It covers the reported status as well as
 * the blocking items, so two projections that report different statuses can
 * never share a key however their item lists narrow. Keeping the status out of
 * it made the blocker list carry two jobs -- naming the items and
 * distinguishing the states -- and balancing those against each other is what
 * went wrong every time this was patched.
 *
 * It is strictly more discriminating than hashing the items alone: identical
 * status and items still match, and a status change is a real change.
 */
function blockerDigest(status, blockers) {
  return sha256(canonicalJson({ status, blockers }));
}

function specificBlockers(ledger, derived) {
  const observation = ledger.latest_observation;
  if (derived.status === "MERGE_READY" || observation == null) {
    return [];
  }
  if (derived.status === "CHECKS_FAILED") {
    // Select exactly what decided the status. Matching on context alone would
    // also pull in another app's run under a pinned requirement and superseded
    // reruns, and those can move the digest without moving the status -- which
    // would let an unchanged required failure on the same tree slip past the
    // stall detection this feeds.
    return [
      ...new Set(
        observation.required_checks.requirements.flatMap((requirement) =>
          [
            ...decidingRunsFor(
              requirement,
              observation.required_checks.runs,
            ).values(),
          ]
            .filter((run) => FAILING_CONCLUSIONS.has(run.conclusion))
            // The pinned app is part of the identity: two requirements can
            // share a context while pinning different apps, and a failure
            // moving between them is a different actionable check, not the
            // same one repeating. Rerun-specific IDs stay out.
            .map(
              (run) =>
                `check:${run.run_kind}:${run.context}:${
                  requirement.app_binding === "PINNED"
                    ? `app${requirement.required_app_id}`
                    : "unbound"
                }:${run.conclusion}`,
            ),
        ),
      ),
    ].sort();
  }
  if (
    derived.status === "CHANGES_REQUIRED" &&
    derived.blockingReason === "UNRESOLVED_REVIEW_THREADS"
  ) {
    return [`threads:${observation.review_threads.unresolved_count}`];
  }
  if (derived.status === "CHANGES_REQUIRED") {
    // Every Codex round mints new comment IDs, so identity here is the comment
    // body digest: a genuinely repeated finding hashes the same, a reworded or
    // different one does not. Only results reviewing the authorized head
    // count -- a result carried over from a dead head decides nothing, exactly
    // as with the non-required check runs above.
    const authorizedHead = authorizationForLedger(ledger).head_sha;
    return [
      ...new Set(
        observation.codex_review.results
          .filter(
            (result) =>
              result.verdict === "FINDINGS" &&
              result.reviewed_head_sha === authorizedHead,
          )
          .flatMap((result) =>
            (result.attached_review_comments ?? []).map(
              (comment) => `finding:${comment.body_sha256}`,
            ),
          ),
      ),
    ].sort();
  }
  return [`${derived.status}:${derived.blockingReason ?? ""}`];
}

/**
 * Pure projection for the autonomous workflow: every publication invariant in
 * its normal fail-closed order, with the draft flag alone ignored.
 *
 * It shares one evaluator with the manual path, so a blocker can never pass
 * here and fail there. `getPublicationSummary` keeps reporting `PR_DRAFT` and
 * `MARK_PULL_REQUEST_READY` unchanged.
 */
// The plan every thread produces, eligible or not. A refusal reason per thread
// is the point rather than a filtered list: an operator asking why a pull
// request will not merge needs the thread that refused and the word for why.
export async function getThreadResolutionPlan(storeRoot, reviewId) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const authorization = await openAuthorizationFiles(paths, reviewId);
    try {
      const ledger = authorization.ledger;
      const observation = ledger.latest_observation;
      // One condition from the caller's side: there is no complete thread
      // evidence to plan from. The gate treats an incomplete collection as
      // establishing nothing, and a plan derived from it would be a list of
      // decisions about threads that may not be all of them.
      if (
        observation == null ||
        observation.review_threads.collection.status !== "COMPLETE"
      ) {
        fail(
          "PUBLICATION_THREAD_EVIDENCE_MISSING",
          "no complete review-thread collection has been recorded",
        );
      }
      const cleanForGatedHead = codexStatus(ledger) === null;
      // The same revalidation the gate performs -- digest, target and pull
      // request comparisons included. Reading the workflow file directly would
      // trust a restored or swapped workflow whose authorization no longer
      // matches this publication, and report its heads as ours.
      const workflow = await requireWorkflowBinding(storeRoot, ledger, {
        mutating: false,
      });
      const ancestryByHead = new Map(
        (observation.review_threads.ancestry ?? []).map((entry) => [
          entry.finding_head_sha,
          entry,
        ]),
      );
      const context = {
        cleanForGatedHead,
        ancestryByHead,
        workflow,
        publicationTerminal: ledger.terminal != null,
      };
      const headSha = authorizationForLedger(ledger).head_sha;
      const observationSha256 = canonicalDigest(observation);
      return {
        review_id: reviewId,
        head_sha: headSha,
        clean_for_gated_head: cleanForGatedHead,
        workflow_id: workflow?.workflow_id ?? null,
        observation_sha256: observationSha256,
        threads: observation.review_threads.threads.map((thread) => {
          const verdict = threadResolutionEligibility(ledger, thread, context);
          if (!verdict.eligible) {
            return {
              thread_id: thread.id,
              path: thread.path,
              line: thread.line,
              is_resolved: thread.is_resolved,
              ...verdict,
            };
          }
          // What an eligible verdict is worth acting on: the exact comment
          // sequence it was derived over, and one digest binding that
          // sequence to this head, workflow, and observation. A resolution
          // intent carries these, and the gate later refuses any action
          // whose watermark the live thread no longer matches.
          const watermark = threadWatermark(thread);
          return {
            thread_id: thread.id,
            path: thread.path,
            line: thread.line,
            is_resolved: thread.is_resolved,
            ...verdict,
            // The comments behind the watermark, by database ID: what lets a
            // caller require its recorded reply to be inside the watermark
            // it is about to bind, rather than one observation behind it.
            comment_database_ids: thread.comments.map(
              (comment) => comment.database_id,
            ),
            thread_watermark: watermark,
            eligibility_sha256: sha256(
              canonicalJson({
                thread_id: thread.id,
                thread_watermark: watermark,
                head_sha: headSha,
                workflow_id: workflow.workflow_id,
                observation_sha256: observationSha256,
              }),
            ),
          };
        }),
      };
    } finally {
      await closeAuthorizationFiles(authorization);
    }
  });
}

/**
 * The correlated Codex findings review this publication currently holds
 * against its gated head, or null when its recorded evidence decides no such
 * review. This is what the workflow's addressed-by record names: the identity
 * comes from the same selection that derived CHANGES_REQUIRED, so the record
 * can only ever name the review that actually blocked.
 *
 * Deliberately not a projection: no staleness clock. The question is
 * historical -- which finding was this repair answering -- and the answer
 * must not disappear because the repair took longer than the evidence
 * freshness window.
 */
export async function getPublicationFindingsReview(storeRoot, reviewId) {
  return withPublicationFindingsReviewLock(
    storeRoot,
    reviewId,
    async (findings) => findings,
  );
}

export async function withPublicationFindingsReviewLock(
  storeRoot,
  reviewId,
  operation,
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const authorization = await openAuthorizationFiles(paths, reviewId);
    try {
      const ledger = authorization.ledger;
      const decision =
        ledger.latest_observation == null ? null : codexDecision(ledger);
      return await operation({
        review_id: reviewId,
        // The revision this identity was derived from. The callback remains
        // under the publication lock, so callers can carry this binding
        // through a related mutation without an intervening snapshot.
        revision: ledger.revision,
        workflow_id: ledger.workflow_id ?? null,
        head_sha: authorizationForLedger(ledger).head_sha,
        findings_review: decision?.findingsReview ?? null,
      });
    } finally {
      await closeAuthorizationFiles(authorization);
    }
  });
}

export async function getAutonomousPreReady(
  storeRoot,
  reviewId,
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    const authorization = await openAuthorizationFiles(paths, reviewId);
    try {
      const ledger = authorization.ledger;
      if (ledger.version !== 3) {
        fail(
          "PUBLICATION_NOT_AUTONOMOUS",
          "only a version 3 publication has an autonomous projection",
        );
      }
      const binding = await requireWorkflowBinding(storeRoot, ledger);
      const publicationAuthorization = authorizationForLedger(ledger);
      const derived = derivePublication(ledger, {
        ignoreDraft: true,
        historyConflict: workflowHeadConflict(binding, ledger),
      });
      const evidenceStale =
        ledger.terminal == null &&
        ledger.latest_observation != null &&
        currentMs > Date.parse(expiresAtFor(ledger));
      const blockingReason = evidenceStale
        ? "EVIDENCE_STALE"
        : derived.blockingReason;
      const ready = !evidenceStale && derived.status === "MERGE_READY";
      // Staleness is its own status, not a note on another one. A consumer
      // switching on `status` must never be able to act on expired evidence by
      // forgetting to also read `blocking_reason`.
      const status = evidenceStale
        ? "EVIDENCE_STALE"
        : ready
          ? "READY_TO_MARK"
          : derived.status;
      // The blockers describe the underlying derived state; the reported
      // status is carried by the digest rather than folded into this list.
      const blockers = normalizedBlockers(ledger, derived);
      return {
        review_id: ledger.review_id,
        revision: ledger.revision,
        workflow_id: ledger.workflow_id,
        workflow_revision: binding.revision,
        status,
        blocking_reason: ready ? null : blockingReason,
        blockers,
        blocker_sha256: blockerDigest(status, blockers),
        // The manual summary reaches PR_DRAFT before it evaluates Codex status,
        // so it never offers this body while a pull request is draft -- which
        // is the whole time an autonomous run needs it, since the run asks for
        // review long before it marks anything ready. Without it the workflow
        // could acknowledge an ambiguity and then have no way to ask for the
        // next review, because the version-2 request ID is server-derived and
        // has no other source.
        ...(status === "GITHUB_REVIEW_NOT_REQUESTED"
          ? { codex_review_request: publicationRequest(ledger) }
          : {}),
        head_sha: publicationAuthorization.head_sha,
        is_draft: ledger.latest_observation?.pull_request?.is_draft ?? null,
        latest_observed_at: ledger.latest_observation?.observed_at ?? null,
        // The server stamped this one; observed_at is the provider's word for
        // when it looked. A consumer ordering an observation against its own
        // writes needs the stamp it authored.
        latest_recorded_at: ledger.latest_observation?.recorded_at ?? null,
      };
    } finally {
      await closeAuthorizationFiles(authorization);
    }
  });
}

/**
 * The post-ready terminal projection: the only proof that a run that has
 * marked its pull request ready may record its terminal `MERGE_READY` entry.
 *
 * It requires the publication's derived status to be `MERGE_READY`, then
 * independently revalidates the workflow binding, both authorization digests,
 * the exact head, and the complete automatic-resolution record and lifecycle
 * replay against the same post-ready observation. Unlike the pre-ready
 * projection it does not ignore the draft flag: a pull request that is draft
 * again is not a successful run, whatever else clears.
 *
 * The workflow side is the only place that knows whether the observation being
 * evaluated was recorded after the mark-ready action consumed its clearance,
 * so the freshness half of "one fresh complete observation" is enforced there
 * (advanceRemoteWorkflow) against the ready mark's recorded clearance
 * revision. This projection reports `MERGE_READY` only over the evidence it
 * can see; the terminal record is the workflow's claim, not this object's.
 */
export async function getAutonomousTerminal(
  storeRoot,
  reviewId,
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    const authorization = await openAuthorizationFiles(paths, reviewId);
    try {
      const ledger = authorization.ledger;
      const binding = await requireWorkflowBinding(storeRoot, ledger);
      return await withEffectiveResolutionContext(
        storeRoot,
        ledger,
        binding,
        (resolutionContext) =>
          projectAutonomousTerminalCore({
            storeRoot,
            paths,
            reviewId,
            authorization,
            currentMs,
            binding,
            resolutionContext,
          }),
      );
    } finally {
      await closeAuthorizationFiles(authorization);
    }
  });
}

// The lock-free core of the terminal projection. The caller must already
// hold the publication lock and the retained source-lock callback (see
// `withEffectiveResolutionContext`): the workflow terminal branch uses it to
// revalidate the publication and keep it stable across the workflow ledger
// write, and nothing else calls it. The binding and resolution context are
// supplied by the caller so the same validated evidence feeds the projection
// and the authority-consuming operation that follows it.
async function projectAutonomousTerminalCore({
  storeRoot,
  paths,
  reviewId,
  authorization,
  currentMs,
  binding,
  resolutionContext,
}) {
  const ledger = authorization.ledger;
  if (ledger.version !== 3) {
    fail(
      "PUBLICATION_NOT_AUTONOMOUS",
      "only a version 3 publication has an autonomous projection",
    );
  }
  const publicationAuthorization = authorizationForLedger(ledger);
  const derived = derivePublication(ledger, {
    historyConflict: workflowHeadConflict(binding, ledger),
  });
  const evidenceStale =
    ledger.terminal == null &&
    ledger.latest_observation != null &&
    currentMs > Date.parse(expiresAtFor(ledger));
  // The replay is the independent revalidation the RFC requires, so it
  // runs whenever the evidence is fresh. Its blockers are the reasons a
  // run must not go terminal even though the publication status says it
  // is clear -- and, when the derived gate already reported the generic
  // THREAD_RESOLUTION_INVALIDATED, they name the exact failure instead.
  const replay = evidenceStale
    ? []
    : terminalResolutionBlockers(ledger, binding, resolutionContext);
  const replayBlockers = replay.map(
    (blocker) =>
      `thread_resolution:${blocker.reason}:${blocker.thread_id}`,
  );
  let status;
  let blockingReason;
  let blockers;
  if (evidenceStale) {
    status = "EVIDENCE_STALE";
    blockingReason = "EVIDENCE_STALE";
    blockers = normalizedBlockers(ledger, derived);
  } else if (derived.status !== "MERGE_READY") {
    status = derived.status;
    blockingReason = derived.blockingReason;
    blockers = normalizedBlockers(ledger, derived);
    // The derived gate folds every resolution failure into one generic
    // reason; the replay's own verdict discriminates so the operator can
    // tell a broken supersession chain from a moved watermark. The status
    // and routing are unchanged either way.
    if (
      derived.blockingReason === "THREAD_RESOLUTION_INVALIDATED" &&
      replay.length > 0
    ) {
      blockingReason = replay[0].reason;
      blockers = replayBlockers;
    }
  } else if (replay.length > 0) {
    // Derived MERGE_READY but the replay sees what the gate cannot (a
    // thread a human participated in): the status stays distinct from
    // MERGE_READY so a consumer switching on it can never mint a terminal
    // record by forgetting the blockers. CHANGES_REQUIRED matches the
    // pre-ready gate's verdict for an invalidated resolution record; the
    // reason discriminates.
    status = "CHANGES_REQUIRED";
    blockingReason = replay[0].reason;
    blockers = replayBlockers;
  } else {
    status = "MERGE_READY";
    blockingReason = null;
    blockers = [];
  }
  return {
    review_id: ledger.review_id,
    revision: ledger.revision,
    workflow_id: ledger.workflow_id,
    workflow_revision: binding.revision,
    status,
    blocking_reason: status === "MERGE_READY" ? null : blockingReason,
    blockers,
    blocker_sha256: blockerDigest(status, blockers),
    head_sha: publicationAuthorization.head_sha,
    is_draft: ledger.latest_observation?.pull_request?.is_draft ?? null,
    latest_observed_at: ledger.latest_observation?.observed_at ?? null,
    latest_recorded_at: ledger.latest_observation?.recorded_at ?? null,
    oldest_collection_at:
      ledger.latest_observation == null
        ? null
        : oldestObservationAt(ledger.latest_observation),
    // The exact identity and digests the terminal record must bind, so
    // the workflow records what this projection revalidated rather than
    // anything it read elsewhere.
    pull_request: binding.pull_request,
    publication_authorization_sha256:
      publicationAuthorization.source_sha256,
    workflow_authorization_sha256: ledger.workflow_authorization_sha256,
    observation_revision:
      ledger.latest_observation == null ? null : ledger.revision,
    observation_sha256:
      ledger.latest_observation == null
        ? null
        : canonicalDigest(ledger.latest_observation),
    resolution_sha256: resolutionContext.effectiveDigest,
    // RFC 0003's draft-gate exception is deliberately unreachable in this
    // repository: checks and Codex reviews run on draft pull requests, so
    // no exception machinery exists and none is consumed.
    ready_exception_sha256: null,
    // Repository policy is not modelled in this codebase: a human formal
    // review that requests changes, or a human or unknown thread, blocks
    // MERGE_READY before this projection exists, and nothing else policy
    // imposes is recorded anywhere a projection could read it.
    human_review_requirements: [],
  };
}

// Hold the publication lock while the workflow records its terminal entry:
// the terminal record is the run's success claim, and a snapshot writer
// must not be able to commit a newer blocking observation between the
// projection revalidation and the workflow ledger write. The publication
// lock is per-review and the workflow write is per-workflow, and no
// publication-lock path acquires the workflow lock (binding reads are
// lock-free), so holding it here blocks only publication mutations and
// cannot invert the lock order. The operation callback additionally runs
// inside the retained source-lock callback, so a historical resolution
// proof's source publications stay locked until the workflow ledger write
// commits.
export async function withAutonomousTerminalLock(
  storeRoot,
  reviewId,
  operation,
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    const authorization = await openAuthorizationFiles(paths, reviewId);
    try {
      const ledger = authorization.ledger;
      const binding = await requireWorkflowBinding(storeRoot, ledger);
      return await withEffectiveResolutionContext(
        storeRoot,
        ledger,
        binding,
        async (resolutionContext) => {
          const current = await projectAutonomousTerminalCore({
            storeRoot,
            paths,
            reviewId,
            authorization,
            currentMs,
            binding,
            resolutionContext,
          });
          return await operation(current);
        },
      );
    } finally {
      await closeAuthorizationFiles(authorization);
    }
  });
}

export async function recordCodexReviewRequest(
  storeRoot,
  reviewId,
  {
    expectedRevision,
    commentId,
    url,
    createdAt,
    requestedHeadSha,
    requestId = null,
  },
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    assertRevision(expectedRevision);
    assertId(commentId, "comment_id");
    assertUrl(url, "url");
    const canonicalCreatedAt = canonicalRequestTimestamp(createdAt);
    const createdMs = timestampMs(canonicalCreatedAt, "created_at");
    assertSha(requestedHeadSha, "requested_head_sha");
    if (
      currentMs - createdMs > MAX_AGE_MS ||
      createdMs - currentMs > MAX_FUTURE_MS
    ) {
      fail("EVIDENCE_STALE", "request comment response is not fresh");
    }
    const ledger = await loadPublicationFile(paths, reviewId);
    requireRevision(ledger, expectedRevision);
    requireMutable(ledger);
    await requireWorkflowBinding(storeRoot, ledger, { mutating: true });
    const originalLedger = clone(ledger);
    const sourceAuthorization = await readBoundAuthorization(
      paths,
      reviewId,
      ledger,
      { verifyRepository: true },
    );
    if (requestedHeadSha !== sourceAuthorization.head_sha) {
      fail(
        sourceAuthorization.mode === "LOCAL_GATE"
          ? "LOCAL_GATE_INVALID"
          : "REMOTE_AUTHORIZATION_INVALID",
        "request head differs from the publication authorization",
      );
    }
    const adapterVersion =
      ledger.codex_review_baseline.collection.adapter_version;
    const expectedRequest =
      adapterVersion === 2 ? correlatedRequest(ledger) : null;
    if (
      adapterVersion === 2 &&
      requestId !== expectedRequest.request_id
    ) {
      fail(
        "INVALID_INPUT",
        "request_id does not match the current publication revision",
      );
    }
    if (adapterVersion === 1 && requestId !== null) {
      fail("INVALID_INPUT", "adapter version 1 cannot bind a request_id");
    }
    if (createdMs < Date.parse(ledger.created_at)) {
      fail("INVALID_INPUT", "request predates publication creation");
    }
    if (
      ledger.codex_request_history.some(
        (entry) =>
          entry.resource_kind === "ISSUE_COMMENT" &&
          entry.resource_id === commentId,
      )
    ) {
      fail("PUBLICATION_HISTORY_CONFLICT", "request comment ID already exists");
    }
    const recordedAt = new Date(currentMs).toISOString();
    const nextRevision = ledger.revision + 1;
    const clearedObservationSha256 =
      ledger.latest_observation == null
        ? null
        : canonicalDigest(ledger.latest_observation);
    ledger.codex_request_history.push({
      resource_id: commentId,
      resource_kind: "ISSUE_COMMENT",
      classification: "RECOGNIZED",
      binding_source: "RECORDED_AT_POST",
      url,
      event_at: canonicalCreatedAt,
      timestamp_field: "created_at",
      recorded_at: recordedAt,
      recorded_revision: nextRevision,
      body_sha256:
        expectedRequest?.body_sha256 ?? REQUEST_BODY_SHA256,
      ...(expectedRequest == null
        ? {}
        : { request_id: expectedRequest.request_id }),
      requested_head_sha: requestedHeadSha,
    });
    ledger.latest_observation = null;
    ledger.revision = nextRevision;
    ledger.updated_at = recordedAt;
    ledger.status = "PR_PENDING";
    ledger.history.push({
      at: recordedAt,
      event: "CODEX_REVIEW_REQUEST_RECORDED",
      revision: nextRevision,
      status: "PR_PENDING",
      head_sha: sourceAuthorization.head_sha,
      cleared_observation_sha256: clearedObservationSha256,
    });
    const storedLedger = capacityTerminal(originalLedger, ledger);
    assertLedgerSize(storedLedger);
    await revokeGate(paths);
    await saveLedger(paths, storedLedger);
    return storedLedger;
  });
}

function invalidatedResolutionPlan(ledger, binding) {
  const headSha = authorizationForLedger(ledger).head_sha;
  const observation = ledger.latest_observation;
  if (
    ledger.version !== 3 ||
    ledger.terminal != null ||
    observation?.review_threads?.collection?.status !== "COMPLETE"
  ) {
    return {
      review_id: ledger.review_id,
      revision: ledger.revision,
      workflow_id: ledger.workflow_id ?? null,
      head_sha: headSha,
      actionable: false,
      reason: "EVIDENCE_UNAVAILABLE",
    };
  }
  const frontier = resolutionFrontier(ledger);
  const completedUnresolves = completedUnresolveRecordIds(
    binding,
    ledger.review_id,
  );
  const blockingFrontier = frontier.blockers.filter(
    (blocker) =>
      blocker.reason !== "THREAD_RESOLUTION_INVALIDATED" ||
      !completedUnresolves.has(blocker.record?.action_id),
  );
  if (blockingFrontier.length > 0) {
    return {
      review_id: ledger.review_id,
      revision: ledger.revision,
      workflow_id: ledger.workflow_id,
      head_sha: headSha,
      actionable: false,
      reason: blockingFrontier[0].reason,
    };
  }
  const threads = new Map(
    observation.review_threads.threads.map((thread) => [thread.id, thread]),
  );
  for (const [threadId, record] of frontier.active) {
    const outcome = (binding.thread_resolutions ?? []).findLast(
      (entry) =>
        entry.outcome === "RESOLVED" &&
        entry.action_id === record.action_id &&
        entry.thread_id === threadId &&
        entry.publication_review_id === ledger.review_id,
    );
    if (outcome == null) {
      continue;
    }
    const thread = threads.get(threadId);
    if (thread == null || thread.provenance_complete !== true) {
      return {
        review_id: ledger.review_id,
        revision: ledger.revision,
        workflow_id: ledger.workflow_id,
        head_sha: headSha,
        actionable: false,
        thread_id: threadId,
        record_id: record.action_id,
        reason: "PROVENANCE_INCOMPLETE",
      };
    }
    const newWatermark = threadWatermark(thread);
    if (
      thread.is_resolved === true &&
      newWatermark === record.thread_watermark &&
      !threadHasForeignParticipation(ledger, binding, thread)
    ) {
      continue;
    }
    const replyIndex = thread.comments.findIndex(
      (comment) => comment.database_id === record.reply_comment_id,
    );
    const laterComments = thread.comments.slice(
      replyIndex < 0 ? 0 : replyIndex + 1,
    );
    const followUpComments = laterComments.map((comment) => ({
      comment_id: comment.database_id,
      actor: { id: comment.actor.id, type: comment.actor.type },
      created_at: comment.created_at,
    }));
    const codexActor = ledger.target.codex_actor;
    const pinnedOnly =
      replyIndex >= 0 &&
      laterComments.length > 0 &&
      laterComments.every(
        (comment) =>
          comment.actor?.id === codexActor.id &&
          comment.actor?.type === codexActor.type,
      );
    const rootReview = thread.comments[0]?.review;
    if (
      !Number.isSafeInteger(rootReview?.database_id) ||
      !SHA_RE.test(rootReview?.reviewed_head_sha ?? "")
    ) {
      return {
        review_id: ledger.review_id,
        revision: ledger.revision,
        workflow_id: ledger.workflow_id,
        head_sha: headSha,
        actionable: false,
        thread_id: threadId,
        record_id: record.action_id,
        reason: "PROVENANCE_INCOMPLETE",
      };
    }
    return {
      review_id: ledger.review_id,
      revision: ledger.revision,
      workflow_id: ledger.workflow_id,
      head_sha: headSha,
      actionable: true,
      thread_id: threadId,
      record_id: record.action_id,
      prior_watermark: record.thread_watermark,
      new_watermark: newWatermark,
      follow_up_comments: followUpComments,
      reason: pinnedOnly
        ? "PINNED_CODEX_FOLLOW_UP"
        : "THREAD_RESOLUTION_UNSAFE",
      findings_review: {
        result_id: rootReview.database_id,
        reviewed_head_sha: rootReview.reviewed_head_sha,
      },
    };
  }
  return {
    review_id: ledger.review_id,
    revision: ledger.revision,
    workflow_id: ledger.workflow_id,
    head_sha: headSha,
    actionable: false,
    reason: "NO_INVALIDATED_RESOLUTION",
  };
}

export async function getInvalidatedResolutionPlan(storeRoot, reviewId) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const authorization = await openAuthorizationFiles(paths, reviewId);
    try {
      const ledger = authorization.ledger;
      const binding = await requireWorkflowBinding(storeRoot, ledger);
      return invalidatedResolutionPlan(ledger, binding);
    } finally {
      await closeAuthorizationFiles(authorization);
    }
  });
}

export async function recordAutomaticUnresolve(
  storeRoot,
  reviewId,
  { expectedRevision, workflowId, actionId },
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    assertRevision(expectedRevision);
    assertString(actionId, "action_id", 1024);
    const ledger = await loadPublicationFile(paths, reviewId);
    requireRevision(ledger, expectedRevision);
    requireMutable(ledger);
    if (ledger.version !== 3 || ledger.workflow_id !== workflowId) {
      fail(
        "PUBLICATION_NOT_AUTONOMOUS",
        "the compensating unresolve must name its bound autonomous workflow",
      );
    }
    const existing = (ledger.resolution_lifecycle ?? []).find(
      (event) =>
        event.kind === "UNRESOLVED_FOR_REPAIR" &&
        event.action_id === actionId,
    );
    if (existing != null) {
      return clone(ledger);
    }
    const originalLedger = clone(ledger);
    const binding = await requireWorkflowBinding(storeRoot, ledger, {
      mutating: true,
    });
    const action = binding.active_unresolve;
    if (
      action == null ||
      action.action_id !== actionId ||
      action.review_id !== reviewId
    ) {
      fail(
        "WORKFLOW_UNRESOLVE_ACTION_MISSING",
        "the workflow has no observed compensating unresolve under that action",
      );
    }
    const at = new Date(clock()).toISOString();
    const events = ledger.resolution_lifecycle ?? [];
    const clearedObservationSha256 = canonicalDigest(ledger.latest_observation);
    ledger.resolution_lifecycle = [
      ...events,
      {
        number: events.length + 1,
        kind: "INVALIDATED",
        thread_id: action.thread_id,
        record_id: action.record_id,
        prior_watermark: action.prior_watermark,
        new_watermark: action.new_watermark,
        follow_up_comments: clone(action.follow_up_comments),
        reason: action.reason,
        at,
      },
      {
        number: events.length + 2,
        kind: "UNRESOLVED_FOR_REPAIR",
        thread_id: action.thread_id,
        record_id: action.record_id,
        action_id: action.action_id,
        at,
      },
    ];
    const nextRevision = ledger.revision + 1;
    ledger.latest_observation = null;
    ledger.revision = nextRevision;
    ledger.updated_at = at;
    ledger.history.push({
      at,
      event: "AUTOMATIC_RESOLUTION_UNRESOLVED",
      revision: nextRevision,
      status: ledger.status,
      head_sha: authorizationForLedger(ledger).head_sha,
      thread_id: action.thread_id,
      record_id: action.record_id,
      action_id: action.action_id,
      cleared_observation_sha256: clearedObservationSha256,
    });
    const storedLedger = capacityTerminal(originalLedger, ledger);
    assertLedgerSize(storedLedger);
    await revokeGate(paths);
    await saveLedger(paths, storedLedger);
    return storedLedger;
  });
}

/**
 * The server-owned proof that this workflow performed one thread's
 * unresolved-to-resolved transition. Every binding comes from the workflow's
 * own observed resolution action -- the intent the server revalidated the
 * head, eligibility, watermark, and reply against when it planned the
 * action; the unresolved pre-read it executed on; and the resolved post-read
 * with `resolvedBy` naming the action's authenticated actor. The caller
 * names only which action to record, so it can neither manufacture a
 * binding nor withhold one.
 *
 * That evidence is immutable once the action is observed, which is what
 * keeps the record creatable after a crash. Re-deriving it here from the
 * recorded observation instead would wedge the workflow: the mutation has
 * already happened, so any fresh snapshot shows the thread resolved and a
 * refusal at this point protects nothing -- it only destroys the record the
 * gate's invalidation check needs, with no way back short of cancelling the
 * publication. Eligibility is decided where refusing still prevents the
 * mutation: at plan time, and again by the pre-read.
 *
 * Recording clears the observation: the mutation just changed the pull
 * request, so whatever was observed before it no longer describes the
 * remote state, and every later conclusion must come from a fresh snapshot.
 * When the workflow previously completed a safe compensating unresolve, the
 * writer imports that thread's exact predecessor chain from its ancestor
 * publication and appends SUPERSEDES. The candidate is replayed before it is
 * stored, so the writer cannot manufacture a chain the terminal gate rejects.
 */
export async function recordAutomaticResolution(
  storeRoot,
  reviewId,
  { expectedRevision, workflowId, actionId },
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    assertRevision(expectedRevision);
    assertString(actionId, "action_id", 1024);
    const ledger = await loadPublicationFile(paths, reviewId);
    requireRevision(ledger, expectedRevision);
    requireMutable(ledger);
    if (ledger.version !== 3) {
      fail(
        "PUBLICATION_NOT_AUTONOMOUS",
        "only a workflow-bound publication records automatic resolutions",
      );
    }
    const originalLedger = clone(ledger);
    const sourceAuthorization = await readBoundAuthorization(
      paths,
      reviewId,
      ledger,
    );
    const binding = await requireWorkflowBinding(storeRoot, ledger, {
      mutating: true,
    });
    if (workflowId !== ledger.workflow_id) {
      fail(
        "INVALID_INPUT",
        "the resolution record must name the bound workflow",
      );
    }
    // Recovery re-running a crashed record creation is the one legitimate
    // repeat, and it is a no-op. This answers before the action is read at
    // all, so it keeps answering after the action completed and stopped
    // being an in-flight resolution.
    const existing = (ledger.automatic_resolutions ?? []).find(
      (record) => record.action_id === actionId,
    );
    if (existing != null) {
      return clone(ledger);
    }
    const resolution = binding.active_resolution;
    if (
      resolution == null ||
      resolution.action_id !== actionId ||
      resolution.review_id !== reviewId
    ) {
      fail(
        "WORKFLOW_RESOLUTION_ACTION_MISSING",
        "the workflow has no observed resolution of this publication under that action",
      );
    }
    if (
      (ledger.automatic_resolutions ?? []).some(
        (record) => record.thread_id === resolution.thread_id,
      )
    ) {
      fail(
        "PUBLICATION_HISTORY_CONFLICT",
        "the thread already carries an automatic-resolution record",
      );
    }
    // The binding read is lock-free and validates every fact it exposes; the
    // head is the one fact only this side can check, since it is the
    // publication's own authorization that has to agree with the intent.
    if (resolution.head_sha !== sourceAuthorization.head_sha) {
      fail(
        "PUBLICATION_SUPERSEDED",
        "the resolution action was planned against a different head",
      );
    }
    const reply = binding.thread_replies.findLast(
      (entry) =>
        entry.thread_id === resolution.thread_id &&
        entry.comment_id === resolution.reply_comment_id,
    );
    if (
      reply == null ||
      reply.comment_id !== resolution.reply_comment_id ||
      reply.actor.id !== resolution.actor.id ||
      reply.actor.type !== resolution.actor.type
    ) {
      fail(
        "INVALID_INPUT",
        "the resolution must follow the workflow's own recorded reply",
      );
    }
    const recordedAt = new Date(currentMs).toISOString();
    const nextRevision = ledger.revision + 1;
    const observation = ledger.latest_observation;
    const predecessorOutcome = (binding.thread_resolutions ?? []).findLast(
      (entry) =>
        entry.outcome === "RESOLVED" &&
        entry.thread_id === resolution.thread_id &&
        entry.action_id !== actionId,
    );
    const predecessorUnresolve =
      predecessorOutcome == null
        ? null
        : (binding.thread_unresolutions ?? []).findLast(
            (entry) =>
              entry.thread_id === resolution.thread_id &&
              entry.record_id === predecessorOutcome.action_id,
          );
    let predecessor = null;
    let invalidationEvent = null;
    let unresolveEvent = null;
    if (predecessorOutcome != null) {
      if (
        predecessorUnresolve == null ||
        predecessorUnresolve.reason !== "PINNED_CODEX_FOLLOW_UP" ||
        !(binding.addressed_findings ?? []).some(
          (record) =>
            record.findings_review.result_id ===
              predecessorUnresolve.findings_review.result_id &&
            record.findings_review.reviewed_head_sha ===
              predecessorUnresolve.findings_review.reviewed_head_sha &&
            record.addressed_by.length > 0,
        ) ||
        !validAttemptLineage(
          binding.attempt_head_history ?? [],
          predecessorOutcome.head_sha,
          resolution.head_sha,
        )
      ) {
        fail(
          "PUBLICATION_HISTORY_CONFLICT",
          "a prior thread resolution may be superseded only after its " +
            "pinned-Codex invalidation and compensating unresolve",
        );
      }
      const sourceReviewId = predecessorOutcome.publication_review_id;
      if (sourceReviewId === reviewId) {
        fail(
          "PUBLICATION_HISTORY_CONFLICT",
          "a successor resolution requires a descendant-head publication",
        );
      }
      const sourcePaths = pathsFor(storeRoot, sourceReviewId);
      await withAncestorPublicationLock(sourcePaths, sourceReviewId, async () => {
        const sourceLedger = await loadPublicationFile(
          sourcePaths,
          sourceReviewId,
        );
        const sourceBinding = await requireWorkflowBinding(
          storeRoot,
          sourceLedger,
        );
        const sourceAuthorization = await readBoundAuthorization(
          sourcePaths,
          sourceReviewId,
          sourceLedger,
        );
        if (
          sourceBinding.workflow_id !== workflowId ||
          sourceBinding.workflow_authorization_sha256 !==
            binding.workflow_authorization_sha256 ||
          sourceAuthorization.head_sha !== predecessorOutcome.head_sha ||
          sourceLedger.target.repository_id !== ledger.target.repository_id ||
          sourceLedger.target.pr_number !== ledger.target.pr_number
        ) {
          fail(
            "PUBLICATION_HISTORY_CONFLICT",
            "the predecessor resolution belongs to a different workflow or pull request",
          );
        }
        const sourceRecords = (sourceLedger.automatic_resolutions ?? []).filter(
          (record) => record.thread_id === resolution.thread_id,
        );
        const sourceEvents = (sourceLedger.resolution_lifecycle ?? []).filter(
          (event) => event.thread_id === resolution.thread_id,
        );
        predecessor = sourceRecords.find(
          (record) => record.action_id === predecessorOutcome.action_id,
        );
        const invalidated = sourceEvents.find(
          (event) =>
            event.kind === "INVALIDATED" &&
            event.record_id === predecessorOutcome.action_id &&
            event.reason === "PINNED_CODEX_FOLLOW_UP",
        );
        const unresolved = sourceEvents.find(
          (event) =>
            event.kind === "UNRESOLVED_FOR_REPAIR" &&
            event.record_id === predecessorOutcome.action_id &&
            event.action_id === predecessorUnresolve.action_id,
        );
        if (
          predecessor == null ||
          invalidated == null ||
          unresolved == null ||
          predecessor.thread_watermark !==
            predecessorUnresolve.prior_watermark ||
          invalidated.new_watermark !== predecessorUnresolve.new_watermark ||
          sourceEvents.indexOf(invalidated) >= sourceEvents.indexOf(unresolved)
        ) {
          fail(
            "PUBLICATION_HISTORY_CONFLICT",
            "the predecessor publication does not contain the bound invalidation and unresolve chain",
          );
        }
        const recordBase = (ledger.automatic_resolutions ?? []).length;
        const eventBase = (ledger.resolution_lifecycle ?? []).length;
        const eventNumbers = new Map(
          sourceEvents.map((event, index) => [
            event.number,
            eventBase + index + 1,
          ]),
        );
        ledger.automatic_resolutions = [
          ...(ledger.automatic_resolutions ?? []),
          ...sourceRecords.map((record, index) => ({
            ...clone(record),
            number: recordBase + index + 1,
          })),
        ];
        ledger.resolution_lifecycle = [
          ...(ledger.resolution_lifecycle ?? []),
          ...sourceEvents.map((event, index) => ({
            ...clone(event),
            number: eventBase + index + 1,
            ...(event.kind === "SUPERSEDES"
              ? {
                  invalidation_event: eventNumbers.get(event.invalidation_event),
                  unresolve_event: eventNumbers.get(event.unresolve_event),
                }
              : {}),
          })),
        ];
        invalidationEvent = eventNumbers.get(invalidated.number);
        unresolveEvent = eventNumbers.get(unresolved.number);
      });
    }
    const successorRecordedRevision = Math.max(
      nextRevision,
      (predecessor?.recorded_revision ?? 0) + 1,
    );
    ledger.automatic_resolutions = [
      ...(ledger.automatic_resolutions ?? []),
      {
        number: (ledger.automatic_resolutions ?? []).length + 1,
        action_id: actionId,
        thread_id: resolution.thread_id,
        thread_watermark: resolution.thread_watermark,
        eligibility_sha256: resolution.eligibility_sha256,
        head_sha: resolution.head_sha,
        actor: { id: resolution.actor.id, type: resolution.actor.type },
        reply_comment_id: resolution.reply_comment_id,
        pre_read: {
          observed_at: resolution.pre_read_observed_at,
          is_resolved: false,
        },
        post_read: {
          observed_at: resolution.post_read_observed_at,
          is_resolved: true,
          resolved_by: {
            id: resolution.actor.id,
            type: resolution.actor.type,
          },
        },
        recorded_at: recordedAt,
        recorded_revision: successorRecordedRevision,
      },
    ];
    if (predecessor != null) {
      if (
        predecessor.thread_watermark === resolution.thread_watermark ||
        predecessor.head_sha === resolution.head_sha
      ) {
        fail(
          "PUBLICATION_HISTORY_CONFLICT",
          "the successor resolution must bind a new head and watermark",
        );
      }
      const events = ledger.resolution_lifecycle ?? [];
      ledger.resolution_lifecycle = [
        ...events,
        {
          number: events.length + 1,
          kind: "SUPERSEDES",
          thread_id: resolution.thread_id,
          predecessor_id: predecessor.action_id,
          successor_id: actionId,
          invalidation_event: invalidationEvent,
          unresolve_event: unresolveEvent,
          at: recordedAt,
        },
      ];
    }
    if (predecessor != null) {
      const replayLedger =
        ledger.latest_observation == null
          ? {
              ...ledger,
              latest_observation: {
                pull_request: { head_sha: resolution.head_sha },
              },
            }
          : ledger;
      const replay = resolutionFrontier(replayLedger);
      const active = replay.active.get(resolution.thread_id);
      if (
        replay.blockers.length > 0 ||
        active?.action_id !== actionId ||
        active.thread_watermark !== resolution.thread_watermark
      ) {
        fail(
          "PUBLICATION_HISTORY_CONFLICT",
          "the automatic-resolution writer did not produce one replayable active frontier",
        );
      }
    }
    ledger.latest_observation = null;
    ledger.revision = nextRevision;
    ledger.updated_at = recordedAt;
    ledger.history.push({
      at: recordedAt,
      event: "AUTOMATIC_RESOLUTION_RECORDED",
      revision: nextRevision,
      status: ledger.status,
      head_sha: resolution.head_sha,
      thread_id: resolution.thread_id,
      cleared_observation_sha256:
        observation == null ? null : canonicalDigest(observation),
    });
    const storedLedger = capacityTerminal(originalLedger, ledger);
    assertLedgerSize(storedLedger);
    await revokeGate(paths);
    await saveLedger(paths, storedLedger);
    return storedLedger;
  });
}

export async function recordGithubSnapshot(
  storeRoot,
  reviewId,
  { expectedRevision, observation },
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    assertRevision(expectedRevision);
    const ledger = await loadPublicationFile(paths, reviewId);
    requireRevision(ledger, expectedRevision);
    requireMutable(ledger);
    const originalLedger = clone(ledger);
    const sourceAuthorization = await readBoundAuthorization(
      paths,
      reviewId,
      ledger,
    );
    await requireWorkflowBinding(storeRoot, ledger, { mutating: true });
    const validated = validateObservation(
      observation,
      ledger,
      currentMs,
    );
    const normalizedObservation = validated.observation;
    const nextRevision = ledger.revision + 1;
    const requestHistoryBefore = clone(ledger.codex_request_history);
    const resultHistoryBefore = clone(ledger.codex_result_history);
    const reconciliation = reconcileHistories(
      ledger,
      normalizedObservation,
      nextRevision,
      currentMs,
    );
    if (
      validated.baselineConflict ||
      reconciliation.conflict ||
      reconciliation.visibilityGrace
    ) {
      ledger.codex_request_history = requestHistoryBefore;
      ledger.codex_result_history = resultHistoryBefore;
    }
    ledger.latest_observation = normalizedObservation;
    const historyConflict =
      validated.baselineConflict ?? reconciliation.conflict;
    const derived = derivePublication(ledger, {
      historyConflict,
      visibilityGrace: reconciliation.visibilityGrace,
    });
    ledger.revision = nextRevision;
    ledger.updated_at = normalizedObservation.recorded_at;
    ledger.status = derived.status;
    if (TERMINAL_STATUSES.has(derived.status)) {
      ledger.terminal = {
        status: derived.status,
        at: normalizedObservation.recorded_at,
        revision: nextRevision,
        reason: derived.terminalReason,
      };
    }
    ledger.history.push({
      at: normalizedObservation.recorded_at,
      event: "GITHUB_SNAPSHOT_RECORDED",
      revision: nextRevision,
      status: derived.status,
      head_sha: sourceAuthorization.head_sha,
    });
    const storedLedger = capacityTerminal(originalLedger, ledger);
    assertLedgerSize(storedLedger);
    await revokeGate(paths);
    await saveLedger(paths, storedLedger);
    return storedLedger;
  });
}

function refsEqual(left, right, idField) {
  const normalize = (items) =>
    items
      .map((item) => `${item.resource_kind}:${item[idField]}`)
      .sort();
  return sameCanonical(normalize(left), normalize(right));
}

function ambiguityClosure(ledger) {
  const correlation = activeCorrelation(ledger);
  const hasAmbiguity =
    correlation.openBaseline.length > 0 ||
    correlation.openUnbound.length > 0 ||
    correlation.ambiguousResults.length > 0;
  if (!hasAmbiguity) {
    return { requests: [], results: [] };
  }
  const requests = [
    ...correlation.openBaseline,
    ...correlation.openUnbound,
    ...correlation.recognized.map((item) => ({
      resource_kind: item.resource_kind,
      resource_id: item.resource_id,
    })),
  ];
  uniqueBy(requests, (item) => resourceIdentity(item), "ambiguity closure requests");
  return { requests, results: correlation.ambiguousResults };
}

export async function acknowledgeCodexReviewAmbiguity(
  storeRoot,
  reviewId,
  {
    expectedRevision,
    headSha,
    requestRefs,
    ambiguousResults,
    acknowledgement,
    operatorLabel,
    rationale,
  },
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    assertRevision(expectedRevision);
    assertSha(headSha, "head_sha");
    assertArray(requestRefs, "request_refs", 1_000);
    assertArray(ambiguousResults, "ambiguous_results", 1_000);
    if (requestRefs.length + ambiguousResults.length > 1_000) {
      fail("PUBLICATION_LIMIT_EXCEEDED", "acknowledgement exceeds 1,000 references");
    }
    uniqueBy(requestRefs, (item) => resourceIdentity(item), "request_refs");
    uniqueBy(
      ambiguousResults,
      (item) => resourceIdentity(item, "result_id"),
      "ambiguous_results",
    );
    if (acknowledgement !== "NO_FURTHER_RESULTS_EXPECTED") {
      fail("INVALID_INPUT", "acknowledgement must be NO_FURTHER_RESULTS_EXPECTED");
    }
    assertString(operatorLabel, "operator_label", 500);
    assertString(rationale, "rationale", 20_000);
    const ledger = await loadPublicationFile(paths, reviewId);
    requireRevision(ledger, expectedRevision);
    requireMutable(ledger);
    await requireWorkflowBinding(storeRoot, ledger, { mutating: true });
    const originalLedger = clone(ledger);
    const sourceAuthorization = await readBoundAuthorization(
      paths,
      reviewId,
      ledger,
    );
    if (headSha !== sourceAuthorization.head_sha) {
      fail(
        "INVALID_INPUT",
        "acknowledgement head differs from the publication authorization",
      );
    }
    validateStoredObservationFresh(ledger, currentMs);
    if (ledger.latest_observation.pull_request.head_sha !== headSha) {
      fail("INVALID_INPUT", "acknowledgement head differs from the current pull request");
    }
    const closure = ambiguityClosure(ledger);
    if (
      closure.requests.length === 0 ||
      !refsEqual(requestRefs, closure.requests, "resource_id") ||
      !refsEqual(ambiguousResults, closure.results, "result_id")
    ) {
      fail(
        "ACKNOWLEDGEMENT_SET_MISMATCH",
        "supply the complete current request and ambiguous-result closure sets",
        { required_request_refs: closure.requests, required_ambiguous_results: closure.results },
      );
    }
    const timestamp = new Date(currentMs).toISOString();
    const nextRevision = ledger.revision + 1;
    ledger.codex_review_ambiguity_acknowledgements.push({
      acknowledgement_id: `ack-${crypto.randomBytes(16).toString("hex")}`,
      head_sha: headSha,
      closed_requests: clone(requestRefs),
      closed_results: clone(ambiguousResults),
      acknowledgement,
      operator_label: operatorLabel,
      rationale,
      backing_observed_at: ledger.latest_observation.observed_at,
      backing_observation_sha256: canonicalDigest(ledger.latest_observation),
      acknowledged_at: timestamp,
      publication_revision: nextRevision,
    });
    const derived = derivePublication(ledger);
    ledger.revision = nextRevision;
    ledger.updated_at = timestamp;
    ledger.status = derived.status;
    ledger.history.push({
      at: timestamp,
      event: "CODEX_REVIEW_AMBIGUITY_ACKNOWLEDGED",
      revision: nextRevision,
      status: derived.status,
      head_sha: sourceAuthorization.head_sha,
    });
    const storedLedger = capacityTerminal(originalLedger, ledger);
    assertLedgerSize(storedLedger);
    await revokeGate(paths);
    await saveLedger(paths, storedLedger);
    return storedLedger;
  });
}

export async function finalizePublicationGate(
  storeRoot,
  reviewId,
  { expectedRevision },
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    assertRevision(expectedRevision);
    const authorization = await openAuthorizationFiles(
      paths,
      reviewId,
      { verifyRepository: true },
    );
    let auditSession;
    try {
      auditSession = await openAuditSession(paths, reviewId);
      const ledger = authorization.ledger;
      const workflowBinding = await requireWorkflowBinding(storeRoot, ledger, {
        mutating: true,
      });
      // The gate mint -- the authority-consuming write -- runs inside the
      // retained source-lock callback so a historical proof can never be
      // computed from one source state and committed over another.
      return await withEffectiveResolutionContext(
        storeRoot,
        ledger,
        workflowBinding,
        async (resolutionContext) => {
          const publicationAuthorization = authorizationForLedger(ledger);
          requireRevision(ledger, expectedRevision);
          requireMutable(ledger);
          if (authorization.gateParseError) {
            fail(
              "PUBLICATION_GATE_INVALID",
              "existing publication gate is malformed",
            );
          }
          validateStoredObservationFresh(ledger, currentMs);
          const derived = derivePublication(ledger);
          if (
            derived.status !== "MERGE_READY" ||
            ledger.status !== "MERGE_READY"
          ) {
            fail(
              "PUBLICATION_NOT_READY",
              `publication status is ${derived.status}, not MERGE_READY`,
            );
          }
          // The terminal replay is the same evidence the autonomous terminal
          // projection refuses a success claim over: a recordless resolved
          // thread or human participation in an active record's thread. The
          // manual merge path must not mint a gate over evidence the
          // autonomous projection would reject, or the operator could merge
          // over a resolution the run itself never owned.
          if (
            ledger.version === 3 &&
            terminalResolutionBlockers(
              ledger,
              workflowBinding,
              resolutionContext,
            ).length > 0
          ) {
            fail(
              "PUBLICATION_NOT_READY",
              "the autonomous terminal replay rejects the final evidence",
            );
          }
          const passedAt = new Date(currentMs).toISOString();
          const expiresAt = expiresAtFor(ledger);
          if (currentMs > Date.parse(expiresAt)) {
            fail(
              "EVIDENCE_STALE",
              "publication evidence expired before finalization",
            );
          }
          const observationDigest = canonicalDigest(ledger.latest_observation);
          const oldestCollectionAt = oldestObservationAt(
            ledger.latest_observation,
          );
          const finalGate = {
            version: ledger.version,
            review_id: reviewId,
            issuance_committed: true,
            passed_at: passedAt,
            repository_id: ledger.target.repository_id,
            pr_number: ledger.target.pr_number,
            head_sha: publicationAuthorization.head_sha,
            reviewer_provider: publicationAuthorization.reviewer_provider,
            ...(ledger.version === 1
              ? {
                  local_gate_sha256: publicationAuthorization.source_sha256,
                }
              : {
                  authorization_mode: publicationAuthorization.mode,
                  authorization_sha256: publicationAuthorization.source_sha256,
                }),
            ...(ledger.version === 3
              ? {
                  workflow_id: workflowBinding.workflow_id,
                  workflow_authorization_sha256:
                    workflowBinding.workflow_authorization_sha256,
                  resolution_sha256: resolutionContext.effectiveDigest,
                }
              : {}),
            publication_revision: ledger.revision,
            github_observation_sha256: observationDigest,
            github_observed_at: ledger.latest_observation.observed_at,
            github_oldest_collection_at: oldestCollectionAt,
            github_recorded_at: ledger.latest_observation.recorded_at,
            expires_at: expiresAt,
            status: "MERGE_READY",
          };
          const candidateGate = {
            ...finalGate,
            issuance_committed: false,
          };
          const gateDigest = canonicalDigest(finalGate);
          await atomicWriteCanonicalJson(paths.gate, candidateGate);
          await appendAuditEvent(
            paths,
            reviewId,
            {
              event: "GATE_FINALIZATION_PASSED",
              outcome: "SUCCESS",
              normalized_reason: null,
              at: passedAt,
              publication_revision: ledger.revision,
              head_sha: publicationAuthorization.head_sha,
              github_observation_sha256: observationDigest,
              gate_sha256: gateDigest,
              expires_at: expiresAt,
            },
            auditSession,
          );
          await atomicWriteCanonicalJson(paths.gate, finalGate);
          return finalGate;
        },
      );
    } finally {
      if (auditSession != null) {
        await closeAuditSession(auditSession);
      }
      await closeAuthorizationFiles(authorization);
    }
  });
}

function verificationFailure(reason, verifiedAt) {
  return {
    valid: false,
    status: null,
    head_sha: null,
    reviewer_provider: null,
    publication_revision: null,
    expires_at: null,
    verified_at: verifiedAt,
    reason,
  };
}

export async function verifyPublicationGate(
  storeRoot,
  reviewId,
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    const verifiedAt = new Date(currentMs).toISOString();
    const authorization = await openAuthorizationFiles(paths, reviewId);
    try {
      const ledger = authorization.ledger;
      const publicationAuthorization = authorizationForLedger(ledger);
      const gate = authorization.publicationGate;
      const gateDigest = gate == null ? null : canonicalDigest(gate);
      const auditSession = await openAuditSession(paths, reviewId);
      try {
        // The audit record every verification writes, over the verdict the
        // assessment reached (which for a workflow-bound publication was
        // reached inside the retained source-lock callback below).
        const writeAudit = (result) =>
          appendAuditEvent(
            paths,
            reviewId,
            {
              event: "GATE_VERIFIED",
              outcome: result.valid ? "SUCCESS" : "FAILURE",
              normalized_reason: result.valid ? null : result.reason,
              at: verifiedAt,
              publication_revision: result.valid
                ? result.publication_revision
                : Number.isSafeInteger(gate?.publication_revision) &&
                    gate.publication_revision > 0
                  ? gate.publication_revision
                  : null,
              head_sha: result.valid
                ? result.head_sha
                : SHA_RE.test(gate?.head_sha ?? "")
                  ? gate.head_sha
                  : null,
              github_observation_sha256:
                DIGEST_RE.test(gate?.github_observation_sha256 ?? "")
                  ? gate.github_observation_sha256
                  : null,
              gate_sha256: gateDigest,
              expires_at:
                isCanonicalTimestamp(gate?.expires_at)
                  ? gate.expires_at
                  : null,
            },
            auditSession,
          );
        let response;
        if (gate == null || authorization.gateParseError) {
          response = verificationFailure(
            "GATE_MISSING_OR_MALFORMED",
            verifiedAt,
          );
          await writeAudit(response);
        } else {
          // A broken workflow binding is a gate mismatch, not a crash: the
          // GATE_VERIFIED audit event must still record the failed check.
          let workflowBinding = null;
          try {
            workflowBinding = await requireWorkflowBinding(storeRoot, ledger);
          } catch {
            workflowBinding = null;
          }
          // The effective resolution context is precomputed once for the
          // assessment, and the assessment and its audit record run inside
          // the retained source-lock callback: a gate minted over historical
          // proof must verify against the same effective digest, lock
          // contention on a historical source publication must propagate
          // retryable PUBLICATION_BUSY rather than read the source without
          // its lock, and the source evidence cannot change between the
          // digest comparison and the verdict the audit records.
          response = await withEffectiveResolutionContext(
            storeRoot,
            ledger,
            workflowBinding,
            async (resolutionContext) => {
              const gateAssessment = assessPublicationGate(
                ledger,
                publicationAuthorization,
                authorization.sourceAuthorization,
                gate,
                false,
                currentMs,
                workflowBinding,
                resolutionContext,
              );
              const result =
                gateAssessment.state === "INVALID"
                  ? verificationFailure("GATE_MISMATCH", verifiedAt)
                  : gateAssessment.state === "EXPIRED"
                    ? verificationFailure("EVIDENCE_STALE", verifiedAt)
                    : {
                        valid: true,
                        status: "MERGE_READY",
                        head_sha: gate.head_sha,
                        reviewer_provider: gateAssessment.reviewerProvider,
                        publication_revision: gate.publication_revision,
                        expires_at: gate.expires_at,
                        verified_at: verifiedAt,
                      };
              await writeAudit(result);
              return result;
            },
          );
        }
        return response;
      } finally {
        await closeAuditSession(auditSession);
      }
    } finally {
      await closeAuthorizationFiles(authorization);
    }
  });
}

export const publicationConstants = Object.freeze({
  request_body: BODY_REQUEST,
  request_body_sha256: REQUEST_BODY_SHA256,
  max_publication_bytes: MAX_PUBLICATION_BYTES,
  max_observation_bytes: MAX_OBSERVATION_BYTES,
  max_baseline_bytes: MAX_BASELINE_BYTES,
  terminal_reserve_bytes: TERMINAL_RESERVE_BYTES,
});
