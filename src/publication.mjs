import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadReview } from "./core.mjs";
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

const MAX_PUBLICATION_BYTES = 10 * 1024 * 1024;
const TERMINAL_RESERVE_BYTES = 64 * 1024;
const MAX_OBSERVATION_BYTES = 6 * 1024 * 1024;
const MAX_BASELINE_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_EVENT_BYTES = 16 * 1024;
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_MS = 30 * 1000;
const MAX_ATOMIC_WINDOW_MS = 2 * 60 * 1000;
const POST_VISIBILITY_GRACE_MS = 30 * 1000;
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

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function publicationDirectory(storeRoot, reviewId) {
  if (typeof reviewId !== "string" || !/^rb-[0-9TZ-]+-[a-f0-9]{8}$/.test(reviewId)) {
    fail("INVALID_INPUT", "invalid review_id");
  }
  return path.join(storeRoot, "reviews", reviewId);
}

function pathsFor(storeRoot, reviewId) {
  const directory = publicationDirectory(storeRoot, reviewId);
  return {
    directory,
    review: path.join(directory, "review.json"),
    localGate: path.join(directory, "gate.json"),
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

function assertExactKeys(value, allowedKeys, name) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail("INVALID_INPUT", `${name} contains unexpected field ${unexpected[0]}`);
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
  if (collection.status !== "COMPLETE" || collection.adapter_version !== 1) {
    fail("INVALID_INPUT", "publication baseline must be complete and use adapter version 1");
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
  validateRequestFacts(requests, "baseline.requests", { baseline: true });
  validateResultFacts(results, "baseline.candidate_results", {
    baseline: true,
    expectedActor,
  });
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
        "AMBIGUOUS",
      ], `${name}[${index}].association`);
      assertEnum(item.verdict, ["CLEAN", "FINDINGS", "UNKNOWN"], `${name}[${index}].verdict`);
      if (item.association === "SINGLE_OPEN_REQUEST") {
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
  requireSourceKinds(
    reviewThreads.collection,
    ["PULL_REQUEST_REVIEW_THREADS"],
    "review_threads.collection",
  );
  if (
    codexReview.collection.status === "COMPLETE" &&
    codexReview.collection.adapter_version !== 1
  ) {
    fail("INVALID_INPUT", "Codex collection must use adapter version 1");
  }
  const allTimes = [observedMs];
  for (const [name, collection] of collections) {
    allTimes.push(...sourceTimes(collection, name));
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
  validateChecks(requiredChecks, pullRequest);
  validateThreads(reviewThreads);
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

function validateChecks(requiredChecks, pullRequest) {
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
  if (classicSource?.result === "NOT_CONFIGURED" && branchSource.protected) {
    const permission = policySources.find(
      (source) => source.kind === "GITHUB_APP_INSTALLATION_PERMISSIONS",
    );
    if (
      permission?.result !== "SUCCESS" ||
      permission.credential_type !== "GITHUB_APP" ||
      permission.field !== "permissions.administration" ||
      !["READ", "WRITE"].includes(permission.level)
    ) {
      fail(
        "INVALID_INPUT",
        "classic-protection NOT_CONFIGURED requires GitHub App administration proof",
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

function validateThreads(reviewThreads) {
  const threads = assertArray(reviewThreads.threads ?? [], "review_threads.threads");
  uniqueBy(threads, (thread) => assertString(thread.id, "thread.id", 255), "threads");
  for (const thread of threads) {
    if (
      typeof thread.is_resolved !== "boolean" ||
      typeof thread.is_outdated !== "boolean"
    ) {
      fail("INVALID_INPUT", "thread resolution and outdated fields must be boolean");
    }
  }
  if (
    reviewThreads.total_count !== threads.length ||
    reviewThreads.unresolved_count !==
      threads.filter((thread) => thread.is_resolved === false).length
  ) {
    fail("INVALID_INPUT", "review thread counts are inconsistent");
  }
}

function validateCodexPartitions(codexReview, ledger) {
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
  for (const [index, item] of baselineRequests.entries()) {
    assertExactKeys(
      item,
      [
        "resource_id",
        "resource_kind",
        "url",
        "event_at",
        "timestamp_field",
        "body_sha256",
        "actor",
      ],
      `codex_review.preexisting_requests[${index}]`,
    );
    assertExactKeys(
      item.actor,
      ["id", "type"],
      `codex_review.preexisting_requests[${index}].actor`,
    );
  }
  for (const [index, item] of baselineResults.entries()) {
    assertExactKeys(
      item,
      [
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
      ],
      `codex_review.preexisting_candidate_results[${index}]`,
    );
    assertExactKeys(
      item.actor,
      ["id", "type"],
      `codex_review.preexisting_candidate_results[${index}].actor`,
    );
  }
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
  validateRequestFacts(unbound, "codex_review.unbound_requests");
  validateRequestFacts(unsupported, "codex_review.unsupported_requests");
  for (const item of unbound) {
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
    ...(codexReview.foreign_actor_objects ?? []),
  ]) {
    allIdentities.push(resourceIdentity(item));
  }
  if (new Set(allIdentities).size !== allIdentities.length) {
    fail("INVALID_INPUT", "Codex object appears in multiple adapter partitions");
  }
  for (const request of requests) {
    assertId(request.comment_id, "request.comment_id");
    if (
      request.resource_kind !== "ISSUE_COMMENT" ||
      request.body !== BODY_REQUEST ||
      request.body_sha256 !== REQUEST_BODY_SHA256 ||
      request.timestamp_field !== "created_at"
    ) {
      fail("INVALID_INPUT", "recognized request is not the exact workflow issue comment");
    }
    assertSha(request.requested_head_sha, "request.requested_head_sha");
  }
  for (const foreign of codexReview.foreign_actor_objects ?? []) {
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

function normalizeBaseline(baseline, recordedAt) {
  return {
    ...baseline,
    recorded_at: recordedAt,
    requests: baseline.requests.map((request) => ({
      ...request,
      classification:
        request.resource_kind === "ISSUE_COMMENT" &&
        request.body_sha256 === REQUEST_BODY_SHA256
          ? "BASELINE_EXACT"
          : "BASELINE_UNSUPPORTED",
      reason:
        request.body_sha256 !== REQUEST_BODY_SHA256
          ? "NON_EXACT_TRIGGER_SHAPE"
          : request.resource_kind !== "ISSUE_COMMENT"
            ? "WRONG_RESOURCE_KIND"
            : null,
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

function validateStoredLedger(ledger) {
  assertObject(ledger, "publication");
  if (ledger.version !== 1) {
    fail(
      "UNSUPPORTED_PUBLICATION_VERSION",
      "only publication schema version 1 is supported",
    );
  }
  assertRevision(ledger.revision);
  publicationDirectory("/store", ledger.review_id);
  timestampMs(ledger.created_at, "publication.created_at");
  timestampMs(ledger.updated_at, "publication.updated_at");
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
  if (baseline.collection?.adapter_version !== 1) {
    fail("PUBLICATION_STORE_INVALID", "stored baseline adapter version changed");
  }
  assertArray(baseline.requests, "publication baseline requests", 5_000);
  assertArray(
    baseline.candidate_results,
    "publication baseline results",
    5_000,
  );
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
      ],
      "publication history event",
    );
    if (event.revision !== index + 1) {
      fail("PUBLICATION_STORE_INVALID", "publication history revisions are not contiguous");
    }
    timestampMs(event.at, "publication history at");
    assertEnum(event.status, PUBLICATION_STATUSES, "publication history status");
    if (event.head_sha !== ledger.local_gate.head_sha) {
      fail("PUBLICATION_STORE_INVALID", "publication history head changed");
    }
    if (event.event === "CODEX_REVIEW_REQUEST_RECORDED") {
      if (event.cleared_observation_sha256 !== null) {
        assertDigest(
          event.cleared_observation_sha256,
          "request history cleared_observation_sha256",
        );
      }
    } else if ("cleared_observation_sha256" in event) {
      fail(
        "PUBLICATION_STORE_INVALID",
        "only request-recorded history may carry cleared_observation_sha256",
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
    gate,
    gate_sha256: sha256(opened.bytes),
    review,
  };
}

async function openAuthorizationFiles(
  paths,
  reviewId,
  { verifyRepository = false } = {},
) {
  const opened = [];
  try {
    const localGateFile = await readSecureFile(paths.localGate, {
      maxBytes: 1024 * 1024,
      requiredMode: 0o600,
    });
    opened.push(localGateFile);
    const publicationFile = await readSecureFile(paths.publication, {
      maxBytes: MAX_PUBLICATION_BYTES,
      requiredMode: 0o600,
    });
    opened.push(publicationFile);
    const publicationGateFile = await readSecureFile(paths.gate, {
      maxBytes: MAX_PUBLICATION_BYTES,
      requiredMode: 0o600,
      allowMissing: true,
    });
    if (publicationGateFile != null) {
      opened.push(publicationGateFile);
    }
    const localGate = await validateOpenedLocalGate(
      paths,
      reviewId,
      localGateFile,
      { verifyRepository },
    );
    const ledger = parseJsonObject(
      publicationFile.bytes,
      "PUBLICATION_STORE_INVALID",
      "publication.json is not a JSON object",
    );
    if (ledger.version !== 1) {
      fail(
        "UNSUPPORTED_PUBLICATION_VERSION",
        "only publication schema version 1 is supported",
      );
    }
    if (!publicationFile.bytes.equals(canonicalJsonBytes(ledger))) {
      fail("PUBLICATION_STORE_INVALID", "publication.json is not canonical JSON");
    }
    validateStoredLedger(ledger);
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
      localGate,
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

async function loadPublicationFile(paths, { allowMissing = false } = {}) {
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
    if (ledger.version !== 1) {
      fail(
        "UNSUPPORTED_PUBLICATION_VERSION",
        "only publication schema version 1 is supported",
      );
    }
    if (!opened.bytes.equals(canonicalJsonBytes(ledger))) {
      fail("PUBLICATION_STORE_INVALID", "publication.json is not canonical JSON");
    }
    validateStoredLedger(ledger);
    return ledger;
  } finally {
    await opened.handle.close();
  }
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
  if (request.requested_head_sha == null) {
    return true;
  }
  if (result.resource_kind === "PULL_REQUEST_REVIEW") {
    return result.reviewed_head_sha === request.requested_head_sha;
  }
  const prefix = result.commit_binding?.prefix;
  return (
    typeof prefix === "string" &&
    request.requested_head_sha.startsWith(prefix)
  );
}

function replayResultAssociations(ledger) {
  const closedRequests = closedRequestIdentities(ledger);
  const closedResults = closedResultIdentities(ledger);
  const recognized = ledger.codex_request_history.filter(
    (item) => item.classification === "RECOGNIZED",
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
    const byKind = new Map();
    for (const kind of ["CHECK_RUN", "COMMIT_STATUS"]) {
      let matches = requiredChecks.runs.filter(
        (run) => run.run_kind === kind && run.context === requirement.context,
      );
      if (kind === "CHECK_RUN" && requirement.app_binding === "PINNED") {
        matches = matches.filter((run) => run.app_id === requirement.required_app_id);
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
    if (requirement.app_binding === "PINNED" && !byKind.has("CHECK_RUN")) {
      pending = true;
      continue;
    }
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
      (item) => !closedRequests.has(`${item.resource_kind}:${item.resource_id}`),
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
          !["CODEX_CLEAN_COMMENT_V1", "CODEX_FINDINGS_REVIEW_V1"].includes(
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

function codexStatus(ledger) {
  const observation = ledger.latest_observation;
  const correlation = activeCorrelation(ledger);
  if (
    correlation.openBaseline.length > 0 ||
    correlation.openUnbound.length > 0 ||
    correlation.ambiguousResults.length > 0
  ) {
    return "GITHUB_REVIEW_UNKNOWN";
  }
  if (correlation.recognized.length === 0) {
    return "GITHUB_REVIEW_NOT_REQUESTED";
  }
  const latest = [...correlation.recognized].sort(
    (left, right) =>
      Date.parse(left.event_at) - Date.parse(right.event_at) ||
      left.resource_id - right.resource_id,
  ).at(-1);
  const results = observation.codex_review.results.filter(
    (result) => {
      const replay = correlation.replayed.get(
        `${result.resource_kind}:${result.result_id}`,
      );
      return (
        replay?.association === "SINGLE_OPEN_REQUEST" &&
        replay.request_ref?.resource_kind === latest.resource_kind &&
        replay.request_ref?.resource_id === latest.resource_id
      );
    },
  );
  if (results.length === 0) {
    return "GITHUB_REVIEW_PENDING";
  }
  if (results.length !== 1) {
    return "GITHUB_REVIEW_UNKNOWN";
  }
  const earlierUnanswered = correlation.recognized
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
    return "GITHUB_REVIEW_UNKNOWN";
  }
  const result = results[0];
  if (result.actor.id !== ledger.target.codex_actor.id || result.actor.type !== "Bot") {
    return "GITHUB_REVIEW_UNKNOWN";
  }
  if (
    result.resource_kind === "PULL_REQUEST_REVIEW" &&
    result.native_review_state === "CHANGES_REQUESTED" &&
    result.reviewed_head_sha === ledger.local_gate.head_sha
  ) {
    return "CHANGES_REQUIRED";
  }
  if (result.native_review_state === "DISMISSED") {
    return "GITHUB_REVIEW_UNKNOWN";
  }
  if (result.format === "CODEX_CLEAN_COMMENT_V1") {
    if (
      result.resource_kind !== "ISSUE_COMMENT" ||
      result.native_review_state !== null ||
      result.verdict !== "CLEAN" ||
      result.reviewed_head_sha !== ledger.local_gate.head_sha ||
      result.commit_binding?.source !==
        "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD" ||
      result.commit_binding?.field !== "body.reviewed_commit" ||
      !/^[0-9a-f]{10,40}$/.test(result.commit_binding?.prefix ?? "") ||
      !ledger.local_gate.head_sha.startsWith(result.commit_binding.prefix)
    ) {
      return "GITHUB_REVIEW_UNKNOWN";
    }
    return null;
  }
  if (result.format === "CODEX_FINDINGS_REVIEW_V1") {
    if (
      result.resource_kind !== "PULL_REQUEST_REVIEW" ||
      !["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(
        result.native_review_state,
      ) ||
      result.verdict !== "FINDINGS" ||
      result.reviewed_head_sha !== ledger.local_gate.head_sha ||
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
      return "GITHUB_REVIEW_UNKNOWN";
    }
    return "CHANGES_REQUIRED";
  }
  return "GITHUB_REVIEW_UNKNOWN";
}

function derivePublication(ledger, { historyConflict = null, visibilityGrace = false } = {}) {
  if (ledger.terminal != null) {
    return { status: ledger.terminal.status };
  }
  const observation = ledger.latest_observation;
  if (observation == null) {
    return { status: "PR_PENDING" };
  }
  if (observation.pull_request.collection.status !== "COMPLETE") {
    return { status: "EVIDENCE_INCOMPLETE" };
  }
  const pullRequest = observation.pull_request;
  const target = ledger.target;
  if (
    pullRequest.repository_id !== target.repository_id ||
    pullRequest.number !== target.pr_number ||
    pullRequest.base_branch !== target.base_branch ||
    pullRequest.head_branch !== target.head_branch ||
    pullRequest.head_sha !== ledger.local_gate.head_sha
  ) {
    return { status: "INVALIDATED", terminalReason: "pull request identity or head differs from local gate" };
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
    return { status: "EVIDENCE_INCOMPLETE" };
  }
  const ancestry = pullRequest.reviewed_base_current_base_comparison;
  if (
    ancestry.base_sha !== ledger.local_gate.base_sha ||
    ancestry.head_sha !== pullRequest.base_sha ||
    ancestry.status === "UNKNOWN"
  ) {
    return { status: "EVIDENCE_INCOMPLETE" };
  }
  if (["BEHIND", "DIVERGED"].includes(ancestry.status)) {
    return { status: "INVALIDATED", terminalReason: "target base no longer preserves the reviewed base" };
  }
  if (pullRequest.is_merged) {
    return { status: "MERGED", terminalReason: "pull request merged" };
  }
  if (pullRequest.state === "CLOSED") {
    return { status: "CLOSED", terminalReason: "pull request closed without merge" };
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
    return { status: "EVIDENCE_INCOMPLETE" };
  }
  if (historyConflict) {
    return { status: "INVALIDATED", terminalReason: historyConflict };
  }
  if (pullRequest.is_draft) {
    return { status: "PR_DRAFT" };
  }
  if (pullRequest.mergeable === "UNKNOWN") {
    return { status: "PR_STATE_PENDING" };
  }
  if (pullRequest.mergeable === "CONFLICTING") {
    return { status: "PR_CONFLICTING" };
  }
  if (observation.required_checks.strict_policy?.required) {
    const comparison = pullRequest.base_head_comparison;
    if (
      comparison.base_sha !== pullRequest.base_sha ||
      comparison.head_sha !== pullRequest.head_sha ||
      comparison.status === "UNKNOWN"
    ) {
      return { status: "EVIDENCE_INCOMPLETE" };
    }
    if (["BEHIND", "DIVERGED"].includes(comparison.status)) {
      return { status: "PR_UPDATE_REQUIRED" };
    }
  }
  const checks = checkRequiredRuns(observation.required_checks);
  if (checks) {
    return { status: checks };
  }
  const codex = codexStatus(ledger);
  if (codex) {
    return { status: codex };
  }
  if (observation.review_threads.unresolved_count > 0) {
    return { status: "CHANGES_REQUIRED" };
  }
  return { status: "MERGE_READY" };
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
  if (!sameCanonical(head, emptyAuditHead(reviewId))) {
    fail("AUDIT_STATE_INVALID", "pre-start audit head is not the empty version 1 cursor");
  }
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
  if (
    !isJsonObject(event) ||
    event.version !== 1 ||
    event.review_id !== reviewId ||
    event.sequence !== head.next_sequence ||
    event.previous_event_sha256 !== head.last_event_sha256 ||
    !/^[0-9a-f]{32}$/.test(event.event_id)
  ) {
    fail("AUDIT_CORRUPT", "audit event does not match the committed cursor");
  }
  assertEnum(event.event, ["GATE_FINALIZATION_PASSED", "GATE_VERIFIED"], "audit event");
  assertEnum(event.outcome, ["SUCCESS", "FAILURE"], "audit outcome");
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
  if (
    canonicalJson(event) !== eventBytes.toString("utf8") ||
    event.review_id !== reviewId ||
    event.sequence !== head.next_sequence - 1
  ) {
    fail("AUDIT_CORRUPT", "last committed audit record is not canonical");
  }
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
  if (canonicalJson(event) !== eventBytes.toString("utf8")) {
    fail("AUDIT_CORRUPT", "complete audit crash tail is not canonical");
  }
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
      if (!openedHead.bytes.equals(canonicalJsonBytes(head))) {
        fail("AUDIT_CORRUPT", "audit head is not canonical JSON");
      }
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
      if (canonicalJson(event) !== line) {
        fail("AUDIT_CORRUPT", `audit event ${eventCount} is not canonical`);
      }
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
      if (!openedHead.bytes.equals(canonicalJsonBytes(head))) {
        fail("AUDIT_CORRUPT", "audit head is not canonical JSON");
      }
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
  return times;
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
    const { gate, gate_sha256: gateSha256 } = await readLocalGate(
      paths,
      reviewId,
      { verifyRepository: true },
    );
    const existing = await loadPublicationFile(paths, { allowMissing: true });
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
    const normalizedBaseline = normalizeBaseline(validatedBaseline, timestamp);
    const ledger = {
      version: 1,
      revision: 1,
      review_id: reviewId,
      created_at: timestamp,
      updated_at: timestamp,
      local_gate: {
        head_sha: gate.head_sha,
        base_sha: gate.base_sha,
        snapshot_hash: gate.snapshot_hash,
        gate_sha256: gateSha256,
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
          head_sha: gate.head_sha,
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
  const ledger = await loadPublicationFile(paths, { allowMissing: true });
  if (ledger == null) {
    fail("PUBLICATION_NOT_FOUND", `publication for ${reviewId} not found`);
  }
  return ledger;
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
  },
  { clock = Date.now } = {},
) {
  const paths = pathsFor(storeRoot, reviewId);
  return publicationLock(paths, reviewId, async () => {
    const currentMs = clock();
    assertRevision(expectedRevision);
    assertId(commentId, "comment_id");
    assertUrl(url, "url");
    const createdMs = timestampMs(createdAt, "created_at");
    assertSha(requestedHeadSha, "requested_head_sha");
    if (
      currentMs - createdMs > MAX_AGE_MS ||
      createdMs - currentMs > MAX_FUTURE_MS
    ) {
      fail("EVIDENCE_STALE", "request comment response is not fresh");
    }
    const ledger = await loadPublicationFile(paths);
    requireRevision(ledger, expectedRevision);
    requireMutable(ledger);
    const originalLedger = clone(ledger);
    const { gate, gate_sha256: gateSha256 } = await readLocalGate(
      paths,
      reviewId,
      { verifyRepository: true },
    );
    if (
      gateSha256 !== ledger.local_gate.gate_sha256 ||
      requestedHeadSha !== ledger.local_gate.head_sha
    ) {
      fail("LOCAL_GATE_INVALID", "request head or local gate changed");
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
      event_at: createdAt,
      timestamp_field: "created_at",
      recorded_at: recordedAt,
      recorded_revision: nextRevision,
      body_sha256: REQUEST_BODY_SHA256,
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
      head_sha: ledger.local_gate.head_sha,
      cleared_observation_sha256: clearedObservationSha256,
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
    const ledger = await loadPublicationFile(paths);
    requireRevision(ledger, expectedRevision);
    requireMutable(ledger);
    const originalLedger = clone(ledger);
    const { gate_sha256: gateSha256 } = await readLocalGate(paths, reviewId);
    if (gateSha256 !== ledger.local_gate.gate_sha256) {
      fail("LOCAL_GATE_INVALID", "local gate bytes changed");
    }
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
      head_sha: ledger.local_gate.head_sha,
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
    const ledger = await loadPublicationFile(paths);
    requireRevision(ledger, expectedRevision);
    requireMutable(ledger);
    const originalLedger = clone(ledger);
    const { gate_sha256: localGateSha256 } = await readLocalGate(paths, reviewId);
    if (localGateSha256 !== ledger.local_gate.gate_sha256) {
      fail("LOCAL_GATE_INVALID", "local gate bytes changed");
    }
    if (headSha !== ledger.local_gate.head_sha) {
      fail("INVALID_INPUT", "acknowledgement head differs from local gate");
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
      head_sha: ledger.local_gate.head_sha,
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
      requireRevision(ledger, expectedRevision);
      requireMutable(ledger);
      if (authorization.gateParseError) {
        fail("PUBLICATION_GATE_INVALID", "existing publication gate is malformed");
      }
      if (
        authorization.localGate.gate_sha256 !== ledger.local_gate.gate_sha256
      ) {
        fail("LOCAL_GATE_INVALID", "local gate bytes changed");
      }
      validateStoredObservationFresh(ledger, currentMs);
      const derived = derivePublication(ledger);
      if (derived.status !== "MERGE_READY" || ledger.status !== "MERGE_READY") {
        fail(
          "PUBLICATION_NOT_READY",
          `publication status is ${derived.status}, not MERGE_READY`,
        );
      }
      const passedAt = new Date(currentMs).toISOString();
      const expiresAt = expiresAtFor(ledger);
      if (currentMs > Date.parse(expiresAt)) {
        fail("EVIDENCE_STALE", "publication evidence expired before finalization");
      }
      const observationDigest = canonicalDigest(ledger.latest_observation);
      const oldestCollectionAt = new Date(
        Math.min(...observationTimes(ledger.latest_observation)),
      ).toISOString();
      const finalGate = {
        version: 1,
        review_id: reviewId,
        issuance_committed: true,
        passed_at: passedAt,
        repository_id: ledger.target.repository_id,
        pr_number: ledger.target.pr_number,
        head_sha: ledger.local_gate.head_sha,
        local_gate_sha256: ledger.local_gate.gate_sha256,
        publication_revision: ledger.revision,
        github_observation_sha256: observationDigest,
        github_observed_at: ledger.latest_observation.observed_at,
        github_oldest_collection_at: oldestCollectionAt,
        github_recorded_at: ledger.latest_observation.recorded_at,
        expires_at: expiresAt,
        status: "MERGE_READY",
      };
      const candidateGate = { ...finalGate, issuance_committed: false };
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
          head_sha: ledger.local_gate.head_sha,
          github_observation_sha256: observationDigest,
          gate_sha256: gateDigest,
          expires_at: expiresAt,
        },
        auditSession,
      );
      await atomicWriteCanonicalJson(paths.gate, finalGate);
      return finalGate;
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
      const gate = authorization.publicationGate;
      const gateDigest = gate == null ? null : canonicalDigest(gate);
      const auditSession = await openAuditSession(paths, reviewId);
      try {
        let response;
        if (gate == null || authorization.gateParseError) {
          response = verificationFailure(
            "GATE_MISSING_OR_MALFORMED",
            verifiedAt,
          );
        } else {
          const derived = derivePublication(ledger);
          const expectedExpiresAt =
            ledger.latest_observation == null ? null : expiresAtFor(ledger);
          if (
            gate.version !== 1 ||
            gate.review_id !== reviewId ||
            gate.issuance_committed !== true ||
            gate.status !== "MERGE_READY" ||
            gate.publication_revision !== ledger.revision ||
            gate.head_sha !== ledger.local_gate.head_sha ||
            gate.local_gate_sha256 !== ledger.local_gate.gate_sha256 ||
            authorization.localGate.gate_sha256 !==
              ledger.local_gate.gate_sha256 ||
            gate.github_observation_sha256 !==
              canonicalDigest(ledger.latest_observation) ||
            gate.expires_at !== expectedExpiresAt ||
            derived.status !== "MERGE_READY"
          ) {
            response = verificationFailure("GATE_MISMATCH", verifiedAt);
          } else if (currentMs > Date.parse(expectedExpiresAt)) {
            response = verificationFailure("EVIDENCE_STALE", verifiedAt);
          } else {
            response = {
              valid: true,
              status: "MERGE_READY",
              head_sha: gate.head_sha,
              publication_revision: gate.publication_revision,
              expires_at: gate.expires_at,
              verified_at: verifiedAt,
            };
          }
        }
        await appendAuditEvent(
          paths,
          reviewId,
          {
            event: "GATE_VERIFIED",
            outcome: response.valid ? "SUCCESS" : "FAILURE",
            normalized_reason: response.valid ? null : response.reason,
            at: verifiedAt,
            publication_revision: response.valid
              ? response.publication_revision
              : Number.isSafeInteger(gate?.publication_revision)
                ? gate.publication_revision
                : null,
            head_sha: response.valid
              ? response.head_sha
              : SHA_RE.test(gate?.head_sha ?? "")
                ? gate.head_sha
                : null,
            github_observation_sha256:
              DIGEST_RE.test(gate?.github_observation_sha256 ?? "")
                ? gate.github_observation_sha256
                : null,
            gate_sha256: gateDigest,
            expires_at:
              typeof gate?.expires_at === "string" ? gate.expires_at : null,
          },
          auditSession,
        );
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
