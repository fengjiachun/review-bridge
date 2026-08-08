import path from "node:path";
import { canonicalJson, readSecureFile, sha256 } from "./storage.mjs";

export const WORKFLOW_ID_RE = /^rbwf-[0-9TZ-]+-[a-f0-9]{8}$/;
export const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function fail(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = { retryable: false, ...details };
  throw error;
}

export function assertWorkflowId(workflowId) {
  if (typeof workflowId !== "string" || !WORKFLOW_ID_RE.test(workflowId)) {
    throw new TypeError("invalid workflow_id");
  }
  return workflowId;
}

export function workflowDirectory(storeRoot, workflowId) {
  assertWorkflowId(workflowId);
  return path.join(storeRoot, "workflows", workflowId);
}

export function workflowPaths(storeRoot, workflowId) {
  const directory = workflowDirectory(storeRoot, workflowId);
  return {
    directory,
    workflow: path.join(directory, "workflow.json"),
    auditLog: path.join(directory, "action-audit.jsonl"),
    auditHead: path.join(directory, "action-audit-head.json"),
  };
}

export function authorizationPayload(authorization) {
  const {
    workflow_authorization_sha256: _workflowAuthorizationSha256,
    ...payload
  } = authorization;
  return payload;
}

export function authorizationDigest(authorization) {
  return sha256(canonicalJson(authorizationPayload(authorization)));
}

/**
 * Read the narrow workflow facts a publication ledger binds to, without taking
 * the workflow lock. The authorization block is written once at workflow start
 * and never mutated, so a lock-free read cannot observe a torn value and the
 * publication and workflow locks never need a shared ordering.
 *
 * This deliberately validates only the binding contract. The full workflow
 * ledger invariants stay in workflow.mjs and still run on every workflow-side
 * operation.
 *
 * That includes the committed action audit, which this reader does not check.
 * The mutable facts returned here -- status, current head, bound pull request
 * -- are therefore trusted only as far as the private store is: an actor who
 * can canonically rewrite workflow.json could restore a cancelled workflow or
 * roll its head back, and the same access rewrites the gate and the
 * publication ledger directly. Recorded as an accepted boundary under
 * "Edited workflow ledger" in RFC 0003 security considerations.
 */
export async function readWorkflowBinding(storeRoot, workflowId) {
  const paths = workflowPaths(storeRoot, workflowId);
  let opened;
  try {
    opened = await readSecureFile(paths.workflow, {
      requiredMode: 0o600,
      maxBytes: MAX_WORKFLOW_BYTES,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("WORKFLOW_NOT_FOUND", `autonomous workflow ${workflowId} not found`, {
        retryable: true,
      });
    }
    throw error;
  }
  try {
    const text = opened.bytes.toString("utf8");
    let workflow;
    try {
      workflow = JSON.parse(text);
    } catch {
      fail("WORKFLOW_STATE_INVALID", "workflow.json is malformed");
    }
    if (workflow === null || typeof workflow !== "object" || Array.isArray(workflow)) {
      fail("WORKFLOW_STATE_INVALID", "workflow.json is not a JSON object");
    }
    if (`${canonicalJson(workflow)}\n` !== text) {
      fail("WORKFLOW_STATE_INVALID", "workflow.json is not canonical JSON");
    }
    if (workflow.version !== 1) {
      fail(
        "WORKFLOW_SCHEMA_UNSUPPORTED",
        `unsupported workflow schema version ${workflow.version}`,
      );
    }
    if (
      workflow.workflow_id !== workflowId ||
      workflow.workflow_id !== path.basename(paths.directory)
    ) {
      fail("WORKFLOW_STATE_INVALID", "workflow ID does not match its store directory");
    }
    if (!Number.isSafeInteger(workflow.revision) || workflow.revision < 1) {
      fail("WORKFLOW_STATE_INVALID", "workflow.revision is invalid");
    }
    if (!["ACTIVE", "PAUSED", "CANCELLED", "MERGE_READY"].includes(workflow.status)) {
      fail("WORKFLOW_STATE_INVALID", "workflow status is invalid");
    }
    if (typeof workflow.phase !== "string" || workflow.phase === "") {
      fail("WORKFLOW_STATE_INVALID", "workflow phase is invalid");
    }
    const authorization = workflow.authorization;
    if (
      authorization === null ||
      typeof authorization !== "object" ||
      Array.isArray(authorization)
    ) {
      fail("WORKFLOW_AUTHORIZATION_INVALID", "workflow authorization is invalid");
    }
    const digest = authorization.workflow_authorization_sha256;
    if (
      !DIGEST_RE.test(digest ?? "") ||
      authorizationDigest(authorization) !== digest
    ) {
      fail(
        "WORKFLOW_AUTHORIZATION_INVALID",
        "workflow authorization digest mismatch",
      );
    }
    const publicationTarget = authorization.publication_target;
    if (
      publicationTarget === null ||
      typeof publicationTarget !== "object" ||
      Array.isArray(publicationTarget)
    ) {
      fail(
        "WORKFLOW_AUTHORIZATION_INVALID",
        "workflow publication target is invalid",
      );
    }
    if (
      workflow.current_head_sha !== null &&
      !SHA_RE.test(workflow.current_head_sha ?? "")
    ) {
      fail("WORKFLOW_STATE_INVALID", "workflow head is invalid");
    }
    // Every head this workflow has published, oldest first. A thread's finding
    // head must be one of them: that is what ties the finding to this workflow
    // and this pull request rather than to some other line of work that
    // happens to share a SHA prefix.
    const attempts = Array.isArray(workflow.remote_attempts)
      ? workflow.remote_attempts
      : [];
    for (const attempt of attempts) {
      if (!SHA_RE.test(attempt?.head_sha ?? "")) {
        fail("WORKFLOW_STATE_INVALID", "remote attempt head is invalid");
      }
    }
    // Every head this workflow recorded as an attempt, oldest first. The
    // ordered lineage joins a historical resolution outcome's head to the
    // current authorization head, so entries are validated to the same shape
    // the workflow ledger records and projected in their stored order.
    const attemptHistory = Array.isArray(workflow.attempts)
      ? workflow.attempts
      : [];
    for (const [index, attempt] of attemptHistory.entries()) {
      if (
        !Number.isSafeInteger(attempt?.number) ||
        attempt.number !== index + 1 ||
        !SHA_RE.test(attempt?.head_sha ?? "")
      ) {
        fail("WORKFLOW_STATE_INVALID", "workflow attempt history entry is invalid");
      }
    }
    // Every finding review this workflow has recorded as addressed, and the
    // commits that addressed it. The eligibility predicate joins a thread's
    // root review against these, so the identity fields are validated to the
    // same shape the observation records for that review.
    const addressedFindings = Array.isArray(workflow.addressed_findings)
      ? workflow.addressed_findings
      : [];
    for (const record of addressedFindings) {
      const findingsReview = record?.findings_review;
      if (
        !Number.isSafeInteger(findingsReview?.result_id) ||
        findingsReview.result_id < 1 ||
        !SHA_RE.test(findingsReview.reviewed_head_sha ?? "") ||
        !Array.isArray(record.addressed_by) ||
        record.addressed_by.length === 0 ||
        record.addressed_by.some((sha) => !SHA_RE.test(sha ?? ""))
      ) {
        fail("WORKFLOW_STATE_INVALID", "addressed-finding record is invalid");
      }
    }
    // Replies this workflow has posted into finding threads, each recorded by
    // a completed reply action. The eligibility predicate admits a non-Codex
    // comment only when it matches one of these exactly -- thread, comment
    // database ID, and authenticated actor -- so the validated shape here is
    // the whole exception surface.
    const threadReplies = Array.isArray(workflow.thread_replies)
      ? workflow.thread_replies
      : [];
    for (const reply of threadReplies) {
      if (
        typeof reply?.thread_id !== "string" ||
        reply.thread_id === "" ||
        !Number.isSafeInteger(reply?.comment_id) ||
        reply.comment_id < 1 ||
        !Number.isSafeInteger(reply?.actor?.id) ||
        reply.actor.id < 1 ||
        typeof reply?.actor?.type !== "string" ||
        reply.actor.type === ""
      ) {
        fail("WORKFLOW_STATE_INVALID", "thread-reply record is invalid");
      }
    }
    // Completed resolution outcomes are the workflow-side evidence that an
    // action found a thread already resolved and therefore performed no
    // transition for an automatic-resolution record to own.
    const threadResolutions = Array.isArray(workflow.thread_resolutions)
      ? workflow.thread_resolutions
      : [];
    const resolvedThreads = new Set();
    for (const [index, resolution] of threadResolutions.entries()) {
      if (
        resolution?.number !== index + 1 ||
        typeof resolution.thread_id !== "string" ||
        resolution.thread_id === "" ||
        resolvedThreads.has(resolution.thread_id) ||
        !["RESOLVED", "OBSERVED_PRE_RESOLVED"].includes(resolution.outcome) ||
        typeof resolution.action_id !== "string" ||
        resolution.action_id === "" ||
        !DIGEST_RE.test(resolution.thread_watermark ?? "") ||
        !SHA_RE.test(resolution.head_sha ?? "") ||
        typeof resolution.publication_review_id !== "string" ||
        resolution.publication_review_id === "" ||
        typeof resolution.recorded_at !== "string" ||
        resolution.recorded_at === ""
      ) {
        fail("WORKFLOW_STATE_INVALID", "thread-resolution record is invalid");
      }
      resolvedThreads.add(resolution.thread_id);
    }
    // The one in-flight action a publication is allowed to read: a thread
    // resolution this workflow has already observed as its own transition.
    // Everything the automatic-resolution record binds is pinned here by the
    // server -- the intent's eligibility digest and watermark, the reply it
    // followed, and the two read timestamps the action is literally made of.
    // The record is therefore made from evidence nothing can replace, which
    // is what keeps it creatable after a crash: a recovering driver may take
    // a fresh snapshot -- showing the thread it just resolved as resolved --
    // without making its own resolution unrecordable.
    const action = workflow.active_action;
    let activeResolution = null;
    if (
      action?.kind === "RESOLVE_REVIEW_THREAD" &&
      action.status === "OBSERVED" &&
      action.provider_response?.outcome === "RESOLVED"
    ) {
      const target = action.target;
      const response = action.provider_response;
      if (
        typeof action.action_id !== "string" ||
        action.action_id === "" ||
        typeof target?.review_id !== "string" ||
        target.review_id === "" ||
        typeof target.thread_id !== "string" ||
        target.thread_id === "" ||
        !DIGEST_RE.test(target.thread_watermark ?? "") ||
        !DIGEST_RE.test(target.eligibility_sha256 ?? "") ||
        !SHA_RE.test(target.head_sha ?? "") ||
        !Number.isSafeInteger(target.reply_comment_id) ||
        target.reply_comment_id < 1 ||
        !Number.isSafeInteger(target.expected_actor_id) ||
        target.expected_actor_id < 1 ||
        typeof target.expected_actor_type !== "string" ||
        target.expected_actor_type === "" ||
        // The transition this record claims: an unresolved pre-read, and a
        // post-read on the same watermark attributing the resolve to the
        // action's own actor.
        action.executing_proof?.thread_id !== target.thread_id ||
        action.executing_proof.is_resolved !== false ||
        action.executing_proof.thread_watermark !== target.thread_watermark ||
        response.thread_id !== target.thread_id ||
        response.is_resolved !== true ||
        response.thread_watermark !== target.thread_watermark ||
        response.resolved_by_id !== target.expected_actor_id ||
        response.resolved_by_type !== target.expected_actor_type ||
        typeof action.executing_at !== "string" ||
        action.executing_at === "" ||
        typeof response.observed_at !== "string" ||
        response.observed_at === ""
      ) {
        fail("WORKFLOW_STATE_INVALID", "resolution-action evidence is invalid");
      }
      activeResolution = {
        action_id: action.action_id,
        review_id: target.review_id,
        thread_id: target.thread_id,
        thread_watermark: target.thread_watermark,
        eligibility_sha256: target.eligibility_sha256,
        head_sha: target.head_sha,
        reply_comment_id: target.reply_comment_id,
        actor: {
          id: target.expected_actor_id,
          type: target.expected_actor_type,
        },
        pre_read_observed_at: action.executing_at,
        post_read_observed_at: response.observed_at,
      };
    }
    return {
      workflow_id: workflow.workflow_id,
      revision: workflow.revision,
      status: workflow.status,
      phase: workflow.phase,
      attempt_head_shas: attempts.map((attempt) => attempt.head_sha),
      attempt_head_history: attemptHistory.map((attempt) => attempt.head_sha),
      addressed_findings: addressedFindings.map((record) => ({
        findings_review: {
          result_id: record.findings_review.result_id,
          reviewed_head_sha: record.findings_review.reviewed_head_sha,
        },
        addressed_by: [...record.addressed_by],
      })),
      thread_replies: threadReplies.map((reply) => ({
        thread_id: reply.thread_id,
        comment_id: reply.comment_id,
        actor: { id: reply.actor.id, type: reply.actor.type },
      })),
      thread_resolutions: threadResolutions.map((resolution) => ({
        thread_id: resolution.thread_id,
        outcome: resolution.outcome,
        action_id: resolution.action_id,
        thread_watermark: resolution.thread_watermark,
        head_sha: resolution.head_sha,
        publication_review_id: resolution.publication_review_id,
      })),
      active_resolution: activeResolution,
      base_sha: workflow.base_sha,
      topic_branch: workflow.topic_branch,
      current_head_sha: workflow.current_head_sha,
      capabilities: [...(authorization.capabilities ?? [])],
      publication_target: structuredClone(publicationTarget),
      pull_request:
        workflow.pull_request == null
          ? null
          : structuredClone(workflow.pull_request),
      workflow_authorization_sha256: digest,
    };
  } finally {
    await opened.handle.close();
  }
}
