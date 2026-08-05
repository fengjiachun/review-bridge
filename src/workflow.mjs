import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getReviewSnapshot } from "./core.mjs";
import {
  getAutonomousPreReady,
  getPublication,
  getPublicationFindingsReview,
  getThreadResolutionPlan,
} from "./publication.mjs";
import {
  atomicWriteCanonicalJson,
  atomicWriteFile,
  canonicalJson,
  readSecureFile,
  readSecureJson,
  sha256,
  withStateLock,
} from "./storage.mjs";
import {
  assertWorkflowId,
  authorizationDigest,
  MAX_WORKFLOW_BYTES,
  workflowPaths,
  WORKFLOW_ID_RE,
} from "./workflow-binding.mjs";

export const AUTONOMOUS_CAPABILITIES = Object.freeze([
  "EDIT_AND_TEST",
  "CREATE_COMMITS",
  "CREATE_CODEX_REVIEWER_TASKS",
  "PUSH_TOPIC_BRANCH",
  "CREATE_OR_UPDATE_DRAFT_PR",
  "POST_CODEX_REVIEW_REQUESTS",
  "MARK_PR_READY",
  "RETURN_PR_TO_DRAFT_FOR_REPAIR",
  "RESOLVE_ELIGIBLE_CODEX_THREADS",
  "UNRESOLVE_INVALIDATED_CODEX_THREADS",
]);

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
// Phases whose exit is a new commit. The three remote repair phases rejoin the
// existing local loop rather than getting a parallel one.
const REMOTE_REPAIR_PHASES = Object.freeze([
  "ADDRESS_REMOTE_FINDINGS",
  "ADDRESS_CHECK_FAILURE",
  "UPDATE_FROM_BASE",
]);
const HEAD_RECORDING_PHASES = Object.freeze([
  "IMPLEMENTING",
  "ADDRESS_LOCAL_FINDINGS",
  ...REMOTE_REPAIR_PHASES,
]);
const MAX_LISTED_BLOCKERS = 50;
const MAX_AUDIT_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_EVENT_BYTES = 256 * 1024;
const MAX_TERMINAL_AUDIT_EVENTS = 2;
const MAX_ORDINARY_AUDIT_BYTES =
  MAX_AUDIT_BYTES -
  MAX_TERMINAL_AUDIT_EVENTS * (MAX_AUDIT_EVENT_BYTES + 1);
const MAX_CANCELLATION_RATIONALE_BYTES = 32 * 1024;
const MAX_RECONCILIATION_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30 * 1000;

function fail(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = { retryable: false, ...details };
  throw error;
}

function now() {
  return new Date().toISOString();
}

function assertString(value, name, { max = 200_000 } = {}) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > max
  ) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function assertCanonicalStringCapacity(value, name, maxBytes) {
  if (Buffer.byteLength(canonicalJson(value)) > maxBytes) {
    throw new TypeError(`${name} exceeds its canonical byte limit`);
  }
  return value;
}

function assertObject(value, name) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertSha(value, name) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new TypeError(`${name} must be a full lowercase Git SHA`);
  }
  return value;
}

function assertTimestamp(value, name) {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${name} must be a UTC timestamp`);
  }
  return value;
}

function assertCapabilities(capabilities) {
  if (
    !Array.isArray(capabilities) ||
    capabilities.length !== AUTONOMOUS_CAPABILITIES.length ||
    new Set(capabilities).size !== capabilities.length ||
    AUTONOMOUS_CAPABILITIES.some(
      (capability) => !capabilities.includes(capability),
    )
  ) {
    throw new TypeError(
      "capabilities must equal the autonomous capability set",
    );
  }
  return [...AUTONOMOUS_CAPABILITIES];
}

function workflowActionId(workflow, plannedRevision, kind, identityFacts) {
  return `rbwfa-${sha256(
    canonicalJson({
      workflow_id: workflow.workflow_id,
      workflow_revision: plannedRevision,
      kind,
      ...identityFacts,
    }),
  ).slice(0, 32)}`;
}

function workflowCorrelationMarker(markerPrefix, workflow, actionId) {
  return `${markerPrefix}${sha256(
    canonicalJson({
      workflow_id: workflow.workflow_id,
      action_id: actionId,
      authorization_sha256:
        workflow.authorization.workflow_authorization_sha256,
    }),
  ).slice(0, 32)}`;
}

// One spec per external-action kind. Every kind shares the same four-status
// protocol, audit events, deterministic identity derivation, and revision
// arithmetic; a spec only contributes the pieces that differ: the required
// capability, the phase the action lives in, the ownership claim it rides
// on, its target and provider-response contracts, and its completion effect
// (implemented in completeWorkflowAction).
const ACTION_KIND_SPECS = {
  CREATE_CODEX_REVIEWER_TASK: {
    capability: "CREATE_CODEX_REVIEWER_TASKS",
    phase: "DISPATCH_CODEX_REVIEWER",
    claimKind: "LOCAL_BRANCH",
    markerPrefix: "rbwf-dispatch-",
    // The reviewer task must not already exist while its dispatch is active.
    forbidReviewerTask: true,
    identityFacts(target) {
      return { review_id: target.review_id };
    },
    validateTarget(workflow, target) {
      if (
        target.review_id !== workflow.current_review?.review_id ||
        target.reviewer_provider !== "CODEX_TASK"
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "active action target does not match the current review",
        );
      }
    },
    dispatch(action) {
      const marker = action.correlation_marker;
      return {
        marker,
        title: `Review Bridge ${marker}`,
        prompt: [
          marker,
          `Review ${action.target.review_id} using the packaged review-bridge-reviewer skill.`,
          "Do not use author context and do not fork the author task.",
        ].join("\n"),
      };
    },
    validateResponse(action, response) {
      assertString(response.task_id, "workflow.active_action.task_id", {
        max: 4096,
      });
      if (
        !Array.isArray(response.matching_task_ids) ||
        response.matching_task_ids.length !== 1 ||
        response.matching_task_ids[0] !== response.task_id ||
        response.title_sha256 !== sha256(action.dispatch.title) ||
        response.prompt_sha256 !== sha256(action.dispatch.prompt)
      ) {
        fail("WORKFLOW_ACTION_INVALID", "active action response is invalid");
      }
    },
  },
  PUSH_TOPIC_BRANCH: {
    capability: "PUSH_TOPIC_BRANCH",
    phase: "PUSH_GATED_HEAD",
    claimKind: "GITHUB_HEAD_REF",
    markerPrefix: null,
    identityFacts(target) {
      return { head_sha: target.head_sha };
    },
    validateTarget(workflow, target) {
      const authorized = workflow.authorization.publication_target;
      requireCredentialFreePushUrl(
        target.remote_url,
        "push target remote_url",
      );
      if (
        target.push_remote !== authorized.push_remote ||
        target.head_repository_id !== authorized.head_repository_id ||
        target.head_branch !== authorized.head_branch ||
        target.head_sha !== workflow.current_head_sha
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "push target does not match the authorized publication target and head",
        );
      }
    },
    dispatch: null,
    validateExecutingProof(action, proof) {
      if (
        proof == null ||
        proof.resolved_repository_id !==
          action.target.head_repository_id ||
        proof.resolved_url !== action.target.remote_url
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "the pinned push URL must be resolved to the authorized repository before executing",
        );
      }
    },
    validateResponse(action, response) {
      if (
        response.remote_ref_sha !== action.target.head_sha ||
        response.remote_repository_id !==
          action.target.head_repository_id ||
        response.remote_url !== action.target.remote_url
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "observed remote does not prove the authorized repository and pushed head",
        );
      }
    },
  },
  REPLY_TO_CODEX_THREAD: {
    // The first half of a resolution: answer the finding thread with one
    // marker comment naming the addressed-by commits. Rides the resolve
    // capability -- a reply exists only on the way to resolving.
    capability: "RESOLVE_ELIGIBLE_CODEX_THREADS",
    phase: "RESOLVE_CODEX_THREADS",
    claimKind: "PULL_REQUEST",
    markerPrefix: "rbwf-reply-",
    identityFacts(target) {
      return {
        thread_id: target.thread_id,
        thread_watermark: target.thread_watermark,
      };
    },
    validateTarget(workflow, target) {
      if (
        workflow.current_publication == null ||
        target.review_id !== workflow.current_publication.review_id ||
        target.head_sha !== workflow.current_head_sha ||
        typeof target.thread_id !== "string" ||
        target.thread_id === "" ||
        !DIGEST_RE.test(target.thread_watermark ?? "") ||
        !DIGEST_RE.test(target.eligibility_sha256 ?? "") ||
        !Number.isSafeInteger(target.expected_actor_id) ||
        target.expected_actor_id < 1 ||
        !["User", "Bot"].includes(target.expected_actor_type) ||
        !Array.isArray(target.addressed_by) ||
        target.addressed_by.length === 0 ||
        target.addressed_by.some((sha) => !SHA_RE.test(sha ?? ""))
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "thread-reply target does not match the bound publication, head, and eligibility evidence",
        );
      }
    },
    dispatch(action) {
      const marker = action.correlation_marker;
      // The body is server-composed and immutable: the observation must match
      // it exactly, so a reply can never say more than the record it answers.
      return {
        marker,
        body_marker: `<!-- ${marker} -->`,
        body: [
          `Fixed in ${action.target.addressed_by
            .map((sha) => sha.slice(0, 10))
            .join(", ")}.`,
          "",
          `<!-- ${marker} -->`,
        ].join("\n"),
      };
    },
    validateResponse(action, response) {
      assertPositiveInteger(
        response.comment_id,
        "workflow.active_action.provider_response.comment_id",
      );
      if (
        !Array.isArray(response.matching_comment_ids) ||
        response.matching_comment_ids.length !== 1 ||
        response.matching_comment_ids[0] !== response.comment_id ||
        response.thread_id !== action.target.thread_id ||
        response.actor_id !== action.target.expected_actor_id ||
        response.actor_type !== action.target.expected_actor_type ||
        response.body_sha256 !== sha256(action.dispatch.body)
      ) {
        fail("WORKFLOW_ACTION_INVALID", "active action response is invalid");
      }
    },
  },
  RESOLVE_REVIEW_THREAD: {
    // The second half: resolve the exact thread the recorded reply answered.
    // The intent binds the reply-inclusive watermark; the executing proof is
    // the immediately preceding unresolved read; the response is the
    // post-read attesting the transition -- resolvedBy must be this action's
    // own actor, because GitHub's mutation succeeds identically on an
    // already-resolved thread and cannot attest it alone.
    capability: "RESOLVE_ELIGIBLE_CODEX_THREADS",
    phase: "RESOLVE_CODEX_THREADS",
    claimKind: "PULL_REQUEST",
    markerPrefix: null,
    identityFacts(target) {
      return {
        thread_id: target.thread_id,
        thread_watermark: target.thread_watermark,
      };
    },
    validateTarget(workflow, target) {
      const reply = (workflow.thread_replies ?? []).find(
        (entry) => entry.thread_id === target.thread_id,
      );
      if (
        workflow.current_publication == null ||
        target.review_id !== workflow.current_publication.review_id ||
        target.head_sha !== workflow.current_head_sha ||
        typeof target.thread_id !== "string" ||
        target.thread_id === "" ||
        !DIGEST_RE.test(target.thread_watermark ?? "") ||
        !DIGEST_RE.test(target.eligibility_sha256 ?? "") ||
        reply == null ||
        target.reply_comment_id !== reply.comment_id ||
        target.expected_actor_id !== reply.actor.id ||
        target.expected_actor_type !== reply.actor.type
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "thread-resolution target does not match the bound publication, head, and recorded reply",
        );
      }
    },
    dispatch: null,
    validateExecutingProof(action, proof) {
      // The pre-read, immediately before the provider call. An already
      // resolved thread is a legal proof -- it forbids the mutation and
      // forces the OBSERVED_PRE_RESOLVED outcome downstream.
      if (
        proof == null ||
        proof.thread_id !== action.target.thread_id ||
        typeof proof.is_resolved !== "boolean" ||
        (proof.is_resolved === false &&
          proof.thread_watermark !== action.target.thread_watermark)
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "the resolution pre-read must bind the exact thread and watermark",
        );
      }
    },
    validateResponse(action, response) {
      if (response.outcome === "OBSERVED_PRE_RESOLVED") {
        // No mutation was issued; the only claim is that the thread was
        // found resolved. Ownership is exactly what this outcome refuses.
        if (
          response.thread_id !== action.target.thread_id ||
          response.is_resolved !== true ||
          action.executing_proof?.is_resolved !== true
        ) {
          fail(
            "WORKFLOW_ACTION_INVALID",
            "a pre-resolved outcome requires the pre-read that found it resolved",
          );
        }
        return;
      }
      if (
        response.outcome !== "RESOLVED" ||
        action.executing_proof?.is_resolved !== false ||
        response.thread_id !== action.target.thread_id ||
        response.is_resolved !== true ||
        response.thread_watermark !== action.target.thread_watermark ||
        response.resolved_by_id !== action.target.expected_actor_id ||
        response.resolved_by_type !== action.target.expected_actor_type
      ) {
        fail("WORKFLOW_ACTION_INVALID", "active action response is invalid");
      }
    },
  },
  CREATE_DRAFT_PULL_REQUEST: {
    capability: "CREATE_OR_UPDATE_DRAFT_PR",
    phase: "ENSURE_DRAFT_PR",
    claimKind: "GITHUB_HEAD_REF",
    markerPrefix: "rbwf-pr-",
    identityFacts(target) {
      return { head_sha: target.head_sha };
    },
    validateTarget(workflow, target) {
      const authorized = workflow.authorization.publication_target;
      assertPositiveInteger(
        target.expected_creator_actor_id,
        "pull-request target expected_creator_actor_id",
      );
      if (
        target.base_repository_id !== authorized.base_repository_id ||
        target.base_branch !== authorized.base_branch ||
        target.head_repository_id !== authorized.head_repository_id ||
        target.head_branch !== authorized.head_branch ||
        target.head_sha !== workflow.current_head_sha ||
        !["User", "Bot"].includes(target.expected_creator_actor_type)
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "pull-request target does not match the authorized publication target and head",
        );
      }
    },
    dispatch(action) {
      const marker = action.correlation_marker;
      return {
        marker,
        body_marker: `<!-- ${marker} -->`,
      };
    },
    validateResponse(action, response) {
      assertPositiveInteger(
        response.pr_number,
        "workflow.active_action.provider_response.pr_number",
      );
      assertPositiveInteger(
        response.creator_actor_id,
        "workflow.active_action.provider_response.creator_actor_id",
      );
      if (
        !Array.isArray(response.matching_pr_numbers) ||
        response.matching_pr_numbers.length !== 1 ||
        response.matching_pr_numbers[0] !== response.pr_number ||
        response.repository_id !== action.target.base_repository_id ||
        response.head_repository_id !== action.target.head_repository_id ||
        response.base_branch !== action.target.base_branch ||
        response.head_branch !== action.target.head_branch ||
        response.head_sha !== action.target.head_sha ||
        response.draft !== true ||
        response.body_marker !== action.dispatch.body_marker ||
        response.creator_actor_id !==
          action.target.expected_creator_actor_id ||
        response.creator_actor_type !==
          action.target.expected_creator_actor_type
      ) {
        fail("WORKFLOW_ACTION_INVALID", "active action response is invalid");
      }
      assertString(response.url, "workflow.active_action.provider_response.url", {
        max: 4096,
      });
    },
  },
  MARK_PR_READY: {
    // The last external write of the autonomous run: take the workflow's own
    // draft pull request out of draft on the exact head the publication
    // cleared. The intent records which observation cleared it, and
    // `revalidate` asks the publication again immediately before the call --
    // once. A driver that crashes after that checkpoint reconciles what it
    // did by observing the pull request; it does not get a second
    // checkpoint, because nothing can tell it whether its call landed
    // (GitHub attests no actor for a draft transition), and this stage has
    // no way to return a ready pull request to draft. That recovery lands
    // with the action that can.
    //
    // The checkpoint asks only whether this head is still cleared: a later
    // observation that clears it again is exactly the state this action
    // wants, so the revision the plan recorded is provenance rather than an
    // equality the publication has to keep satisfying. The completed record
    // names the revision the checkpoint accepted.
    capability: "MARK_PR_READY",
    phase: "PRE_READY",
    // Where a refused pre-write checkpoint leaves the workflow: back in the
    // wait, which re-derives the publication's own next step -- a repair
    // phase for whatever regressed, or this same stop once it clears again.
    abandonPhase: "WAIT_PUBLICATION",
    // Only this refusal drops an intent. Lock contention and every other
    // failure of the read itself mean "ask again", not "this intent is
    // wrong", and destroying a durable intent over a busy lock would be a
    // far worse bug than the stop it was meant to prevent.
    abandonOnCode: "WORKFLOW_PUBLICATION_NOT_READY",
    claimKind: "PULL_REQUEST",
    markerPrefix: null,
    identityFacts(target) {
      return { pr_number: target.pr_number, head_sha: target.head_sha };
    },
    validateTarget(workflow, target) {
      const authorized = workflow.authorization.publication_target;
      const pullRequest = workflow.pull_request;
      if (
        workflow.current_publication == null ||
        target.review_id !== workflow.current_publication.review_id ||
        target.head_sha !== workflow.current_head_sha ||
        pullRequest == null ||
        target.repository_id !== pullRequest.repository_id ||
        target.pr_number !== pullRequest.pr_number ||
        target.base_branch !== authorized.base_branch ||
        target.head_branch !== authorized.head_branch ||
        target.repository_id !== authorized.base_repository_id ||
        !Number.isSafeInteger(target.publication_revision) ||
        target.publication_revision < 1
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "mark-ready target does not match the workflow-owned pull request, head, and clearance",
        );
      }
    },
    dispatch: null,
    async revalidate(storeRoot, action) {
      // Only the clearance is re-read. The identity behind it cannot move
      // while this action is active: recording a head drops the publication
      // binding, and no head can be recorded from PRE_READY with an action
      // in flight -- so the plan-time identity check is still the current
      // one, and repeating it here would be a check no state can fail.
      const preReady = await getAutonomousPreReady(
        storeRoot,
        action.target.review_id,
      );
      if (preReady.status !== "READY_TO_MARK") {
        fail(
          "WORKFLOW_PUBLICATION_NOT_READY",
          "the publication no longer clears this pull request for review",
          {
            status: preReady.status,
            blocking_reason: preReady.blocking_reason,
          },
        );
      }
      // The clearance that actually authorizes the write, which after a
      // regress-and-clear is not the one the plan read.
      return preReady.revision;
    },
    validateExecutingProof(action, proof) {
      // The identity read immediately before the call. A pull request already
      // out of draft is a legal proof -- on this exact head it is the
      // reconciled completion, and it forbids claiming the mutation.
      if (
        proof == null ||
        proof.repository_id !== action.target.repository_id ||
        proof.pr_number !== action.target.pr_number ||
        proof.base_branch !== action.target.base_branch ||
        proof.head_branch !== action.target.head_branch ||
        proof.head_sha !== action.target.head_sha ||
        typeof proof.is_draft !== "boolean"
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "the mark-ready pre-read must bind the exact pull request and head",
        );
      }
    },
    validateResponse(action, response) {
      if (
        !["MARKED_READY", "OBSERVED_ALREADY_READY"].includes(
          response.outcome,
        ) ||
        response.repository_id !== action.target.repository_id ||
        response.pr_number !== action.target.pr_number ||
        response.base_branch !== action.target.base_branch ||
        response.head_branch !== action.target.head_branch ||
        response.head_sha !== action.target.head_sha ||
        response.is_draft !== false ||
        // Which outcome is true is decided by the pre-read, not by the
        // caller: a driver that found the pull request already ready never
        // issued the mutation, and one that found it draft did issue the
        // call this action is reconciling.
        (response.outcome === "MARKED_READY") !==
          (action.executing_proof?.is_draft === true)
      ) {
        fail("WORKFLOW_ACTION_INVALID", "active action response is invalid");
      }
    },
  },
};

function validateCurrentPublication(workflow) {
  if (workflow.current_publication == null) {
    return;
  }
  const publication = assertObject(
    workflow.current_publication,
    "workflow.current_publication",
  );
  assertString(publication.review_id, "workflow.current_publication.review_id", {
    max: 1024,
  });
  assertSha(publication.head_sha, "workflow.current_publication.head_sha");
  assertPositiveInteger(
    publication.bound_revision,
    "workflow.current_publication.bound_revision",
  );
  assertPositiveInteger(
    publication.awaiting_revision,
    "workflow.current_publication.awaiting_revision",
  );
  assertTimestamp(
    publication.bound_at,
    "workflow.current_publication.bound_at",
  );
  if (publication.head_sha !== workflow.current_head_sha) {
    fail(
      "WORKFLOW_STATE_INVALID",
      "the bound publication head is not the current workflow head",
    );
  }
}

function validateCurrentReview(workflow) {
  if (workflow.current_review == null) {
    if (workflow.active_action != null || workflow.reviewer_task != null) {
      fail(
        "WORKFLOW_STATE_INVALID",
        "workflow action and reviewer task require a current review",
      );
    }
    return;
  }
  const review = assertObject(
    workflow.current_review,
    "workflow.current_review",
  );
  assertString(review.review_id, "workflow.current_review.review_id", {
    max: 1024,
  });
  assertPositiveInteger(
    review.state_version,
    "workflow.current_review.state_version",
  );
  assertString(review.status, "workflow.current_review.status", { max: 1024 });
  assertObject(review.strategy, "workflow.current_review.strategy");
  if (
    review.snapshot_hash !== null &&
    !DIGEST_RE.test(review.snapshot_hash ?? "")
  ) {
    fail("WORKFLOW_STATE_INVALID", "current review snapshot hash is invalid");
  }
  if (review.head_sha !== null) {
    assertSha(review.head_sha, "workflow.current_review.head_sha");
  }

  if (workflow.reviewer_task != null) {
    const task = assertObject(
      workflow.reviewer_task,
      "workflow.reviewer_task",
    );
    assertString(task.task_id, "workflow.reviewer_task.task_id", {
      max: 4096,
    });
    if (
      task.review_id !== review.review_id ||
      task.reviewer_provider !== "CODEX_TASK" ||
      typeof task.dispatch_marker !== "string" ||
      !/^rbwf-dispatch-[0-9a-f]{32}$/.test(task.dispatch_marker)
    ) {
      fail(
        "WORKFLOW_STATE_INVALID",
        "reviewer task does not match the current Codex review",
      );
    }
    assertTimestamp(task.observed_at, "workflow.reviewer_task.observed_at");
  }
}

function validateActiveAction(workflow) {
  const action = workflow.active_action;
  if (action == null) {
    return;
  }
  assertObject(action, "workflow.active_action");
  assertPositiveInteger(
    action.planned_revision,
    "workflow.active_action.planned_revision",
  );
  const spec = ACTION_KIND_SPECS[action.kind];
  if (
    spec == null ||
    !["PLANNED", "EXECUTING", "OBSERVED"].includes(action.status) ||
    action.required_capability !== spec.capability ||
    action.authorization_sha256 !==
      workflow.authorization.workflow_authorization_sha256
  ) {
    fail("WORKFLOW_ACTION_INVALID", "active action contract is invalid");
  }
  assertObject(action.target, "workflow.active_action.target");
  spec.validateTarget(workflow, action.target);
  const expectedActionId = workflowActionId(
    workflow,
    action.planned_revision,
    action.kind,
    spec.identityFacts(action.target),
  );
  const expectedMarker =
    spec.markerPrefix == null
      ? null
      : workflowCorrelationMarker(
          spec.markerPrefix,
          workflow,
          expectedActionId,
        );
  if (
    action.action_id !== expectedActionId ||
    action.correlation_marker !== expectedMarker
  ) {
    fail("WORKFLOW_ACTION_INVALID", "active action identity is invalid");
  }
  const ownershipClaim = workflow.claims.find(
    (entry) => entry.kind === spec.claimKind,
  );
  if (
    ownershipClaim == null ||
    canonicalJson(action.ownership_claim) !==
      canonicalJson({
        kind: ownershipClaim.kind,
        canonical_key_sha256: ownershipClaim.canonical_key_sha256,
      })
  ) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "active action ownership claim is invalid",
    );
  }
  const expectedDispatch =
    spec.dispatch == null ? null : spec.dispatch(action);
  if (canonicalJson(action.dispatch) !== canonicalJson(expectedDispatch)) {
    fail("WORKFLOW_ACTION_INVALID", "active action dispatch is invalid");
  }
  assertTimestamp(action.planned_at, "workflow.active_action.planned_at");
  if (action.completed_at !== null) {
    fail("WORKFLOW_ACTION_INVALID", "active action is already completed");
  }
  const statusOffset = {
    PLANNED: 1,
    EXECUTING: 2,
    OBSERVED: 3,
  }[action.status];
  const revisionOffset = action.revision_offset ?? 0;
  if (
    !Number.isSafeInteger(revisionOffset) ||
    revisionOffset < 0 ||
    workflow.revision <
      action.planned_revision + statusOffset + revisionOffset ||
    (workflow.status === "ACTIVE" &&
      workflow.revision !==
        action.planned_revision + statusOffset + revisionOffset)
  ) {
    fail("WORKFLOW_ACTION_INVALID", "active action revision is invalid");
  }
  if (
    (action.status === "PLANNED" && action.executing_at !== null) ||
    (action.status !== "PLANNED" && action.executing_at === null)
  ) {
    fail("WORKFLOW_ACTION_INVALID", "active action execution time is invalid");
  }
  // Ledgers persisted by v0.5.0 predate the executing-proof field; an
  // absent field validates exactly like the explicit null those versions
  // could never set, so upgraded stores keep loading.
  const executingProof = action.executing_proof ?? null;
  if (action.status === "PLANNED") {
    if (executingProof !== null) {
      fail(
        "WORKFLOW_ACTION_INVALID",
        "a planned action cannot carry an executing proof",
      );
    }
  } else if (spec.validateExecutingProof) {
    spec.validateExecutingProof(action, executingProof);
  } else if (executingProof !== null) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "this action kind does not take an executing proof",
    );
  }
  if (action.executing_at !== null) {
    assertTimestamp(
      action.executing_at,
      "workflow.active_action.executing_at",
    );
  }
  // The clearance the pre-write checkpoint accepted. A kind that has that
  // checkpoint carries it from EXECUTING onward -- the completed record
  // names it -- and no other action may carry one at all.
  if (spec.revalidate != null && action.status !== "PLANNED") {
    if (
      !Number.isSafeInteger(action.cleared_publication_revision) ||
      action.cleared_publication_revision < 1
    ) {
      fail(
        "WORKFLOW_ACTION_INVALID",
        "an executed action of this kind must record the clearance it was checked against",
      );
    }
  } else if (action.cleared_publication_revision != null) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "this action kind does not record a cleared publication revision",
    );
  }
  if (
    (action.status === "OBSERVED" && action.observed_at === null) ||
    (action.status !== "OBSERVED" && action.observed_at !== null)
  ) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "active action observation time is invalid",
    );
  }
  if (action.observed_at !== null) {
    assertTimestamp(action.observed_at, "workflow.active_action.observed_at");
  }
  if (action.status === "OBSERVED") {
    const response = assertObject(
      action.provider_response,
      "workflow.active_action.provider_response",
    );
    spec.validateResponse(action, response);
    assertTimestamp(
      response.observed_at,
      "workflow.active_action.provider_response.observed_at",
    );
  } else if (action.provider_response !== null) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "unobserved action has a provider response",
    );
  }
  if (
    (workflow.status === "ACTIVE" && workflow.phase !== spec.phase) ||
    (spec.forbidReviewerTask && workflow.reviewer_task != null)
  ) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "active action is inconsistent with workflow state",
    );
  }
}

function requireCredentialFreePushUrl(url, name) {
  assertString(url, name, { max: 4096 });
  // Legitimate git push URLs never carry a query or fragment; both are
  // common secret carriers (?access_token=...) and would be persisted.
  if (/[?#]/.test(url)) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      `${name} must not carry a query or fragment`,
    );
  }
  // scp-like ssh syntax (user@host:path) has no password field; the user is
  // an ssh login name, not a credential.
  if (/^[A-Za-z0-9._-]+@[^:@/]+:/.test(url)) {
    return url;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(
      "WORKFLOW_ACTION_INVALID",
      `${name} is not a parseable push URL`,
    );
  }
  const sshProtocol = ["ssh:", "git+ssh:"].includes(parsed.protocol);
  if (
    parsed.password !== "" ||
    (parsed.username !== "" && !sshProtocol)
  ) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      `${name} embeds credentials and cannot be persisted`,
    );
  }
  return url;
}

function runGit(repositoryPath, args, { allowExitCodes = [0] } = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  if (result.error) {
    throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (!allowExitCodes.includes(result.status)) {
    throw new Error(
      `git ${args[0]} failed (${result.status}): ${result.stderr.trim()}`,
    );
  }
  return { status: result.status, stdout: result.stdout.trim() };
}

async function repositoryIdentity(repositoryPath) {
  assertString(repositoryPath, "repository_path", { max: 4096 });
  const inputPath = await fsp.realpath(path.resolve(repositoryPath));
  const worktreeRoot = runGit(inputPath, [
    "rev-parse",
    "--show-toplevel",
  ]).stdout;
  const canonicalPath = await fsp.realpath(
    path.resolve(inputPath, worktreeRoot),
  );
  const commonDir = runGit(canonicalPath, [
    "rev-parse",
    "--git-common-dir",
  ]).stdout;
  const commonDirPath = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(canonicalPath, commonDir);
  return {
    path: canonicalPath,
    git_common_dir: await fsp.realpath(commonDirPath),
  };
}

function currentBranch(repositoryPath) {
  return runGit(repositoryPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]).stdout;
}

function currentHead(repositoryPath) {
  return runGit(repositoryPath, ["rev-parse", "HEAD"]).stdout;
}

function requireCleanRepository(repositoryPath) {
  const status = runGit(repositoryPath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]).stdout;
  if (status !== "") {
    fail(
      "WORKTREE_DIRTY",
      "working tree must be clean before this workflow transition",
    );
  }
}

function requireAncestor(repositoryPath, ancestor, descendant) {
  const result = runGit(
    repositoryPath,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { allowExitCodes: [0, 1] },
  );
  if (result.status !== 0) {
    fail(
      "WORKFLOW_HEAD_NOT_DESCENDANT",
      `${descendant} is not a descendant of ${ancestor}`,
    );
  }
}

function createWorkflowId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  return `rbwf-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function publicWorkflow(workflow) {
  return structuredClone(workflow);
}

async function readCanonicalSecureJson(filePath, maxBytes, code) {
  const opened = await readSecureFile(filePath, {
    requiredMode: 0o600,
    maxBytes,
  });
  try {
    let value;
    const text = opened.bytes.toString("utf8");
    try {
      value = JSON.parse(text);
    } catch {
      fail(code, `${path.basename(filePath)} is malformed`);
    }
    if (`${canonicalJson(value)}\n` !== text) {
      fail(code, `${path.basename(filePath)} is not canonical JSON`);
    }
    return value;
  } finally {
    await opened.handle.close();
  }
}

function validateWorkflow(workflow) {
  assertObject(workflow, "workflow");
  if (workflow.version !== 1) {
    fail(
      "WORKFLOW_SCHEMA_UNSUPPORTED",
      `unsupported workflow schema version ${workflow.version}`,
    );
  }
  assertWorkflowId(workflow.workflow_id);
  assertPositiveInteger(workflow.revision, "workflow.revision");
  assertObject(workflow.repository, "workflow.repository");
  assertString(workflow.repository.path, "workflow.repository.path", {
    max: 4096,
  });
  assertString(
    workflow.repository.git_common_dir,
    "workflow.repository.git_common_dir",
    { max: 4096 },
  );
  assertSha(workflow.base_sha, "workflow.base_sha");
  assertString(workflow.base_ref, "workflow.base_ref", { max: 1024 });
  assertString(workflow.requirement, "workflow.requirement");
  assertString(workflow.implementation_scope, "workflow.implementation_scope");
  assertString(workflow.topic_branch, "workflow.topic_branch", { max: 1024 });
  assertObject(workflow.authorization, "workflow.authorization");
  assertCapabilities(workflow.authorization.capabilities);
  if (
    workflow.authorization.mode !== "AUTONOMOUS_LOCAL_GATE" ||
    typeof workflow.authorization.operator_label !== "string" ||
    workflow.authorization.operator_label.trim() === ""
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_INVALID",
      "workflow authorization metadata is invalid",
    );
  }
  assertTimestamp(
    workflow.authorization.authorized_at,
    "workflow.authorization.authorized_at",
  );
  const expectedScope = {
    repository: workflow.repository,
    base_ref: workflow.base_ref,
    base_sha: workflow.base_sha,
    requirement: workflow.requirement,
    implementation_scope: workflow.implementation_scope,
    topic_branch: workflow.topic_branch,
  };
  if (
    canonicalJson(workflow.authorization.scope) !==
    canonicalJson(expectedScope)
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_INVALID",
      "workflow authorization scope does not match the workflow ledger",
    );
  }
  const normalizedTarget = validatePublicationTarget(
    workflow.authorization.publication_target,
    workflow.topic_branch,
  );
  if (
    canonicalJson(normalizedTarget) !==
    canonicalJson(workflow.authorization.publication_target)
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_INVALID",
      "workflow publication target is not canonical",
    );
  }
  if (
    !DIGEST_RE.test(
      workflow.authorization.workflow_authorization_sha256 ?? "",
    ) ||
    authorizationDigest(workflow.authorization) !==
      workflow.authorization.workflow_authorization_sha256
  ) {
    fail(
      "WORKFLOW_AUTHORIZATION_INVALID",
      "workflow authorization digest mismatch",
    );
  }
  if (!["ACTIVE", "PAUSED", "CANCELLED"].includes(workflow.status)) {
    fail("WORKFLOW_STATE_INVALID", "workflow status is invalid");
  }
  if (
    !Array.isArray(workflow.attempts) ||
    !Array.isArray(workflow.claims) ||
    !Array.isArray(workflow.remote_attempts) ||
    !Array.isArray(workflow.addressed_findings) ||
    !Array.isArray(workflow.thread_replies) ||
    !Array.isArray(workflow.thread_resolutions) ||
    !Array.isArray(workflow.ready_marks)
  ) {
    fail("WORKFLOW_STATE_INVALID", "workflow arrays are malformed");
  }
  for (const attempt of workflow.remote_attempts) {
    assertObject(attempt, "workflow.remote_attempts entry");
    assertPositiveInteger(attempt.number, "remote attempt number");
    assertSha(attempt.head_sha, "remote attempt head_sha");
    assertSha(attempt.tree_sha, "remote attempt tree_sha");
    if (!DIGEST_RE.test(attempt.blocker_sha256 ?? "")) {
      fail("WORKFLOW_STATE_INVALID", "remote attempt blocker digest is invalid");
    }
    assertString(attempt.status, "remote attempt status", { max: 1024 });
    assertTimestamp(attempt.at, "remote attempt at");
  }
  for (const [index, record] of workflow.addressed_findings.entries()) {
    assertObject(record, "workflow.addressed_findings entry");
    if (record.number !== index + 1) {
      fail("WORKFLOW_STATE_INVALID", "addressed-finding numbers must be sequential");
    }
    assertString(record.publication_review_id, "addressed-finding review_id", {
      max: 1024,
    });
    assertPositiveInteger(
      record.publication_revision,
      "addressed-finding publication_revision",
    );
    const findingsReview = assertObject(
      record.findings_review,
      "addressed-finding findings_review",
    );
    assertPositiveInteger(
      findingsReview.result_id,
      "addressed-finding result_id",
    );
    assertSha(
      findingsReview.reviewed_head_sha,
      "addressed-finding reviewed_head_sha",
    );
    if (
      !Array.isArray(record.addressed_by) ||
      record.addressed_by.length === 0
    ) {
      fail(
        "WORKFLOW_STATE_INVALID",
        "an addressed finding must name at least one commit",
      );
    }
    for (const sha of record.addressed_by) {
      assertSha(sha, "addressed-finding commit");
    }
    assertTimestamp(record.recorded_at, "addressed-finding recorded_at");
  }
  const repliedThreads = new Set();
  for (const [index, reply] of workflow.thread_replies.entries()) {
    assertObject(reply, "workflow.thread_replies entry");
    if (reply.number !== index + 1) {
      fail("WORKFLOW_STATE_INVALID", "thread-reply numbers must be sequential");
    }
    assertString(reply.thread_id, "thread-reply thread_id", { max: 1024 });
    // One reply per thread: the eligibility exception admits "the recorded
    // reply", singular, and a second would mean an action was double-run.
    if (repliedThreads.has(reply.thread_id)) {
      fail("WORKFLOW_STATE_INVALID", "a thread can carry only one recorded reply");
    }
    repliedThreads.add(reply.thread_id);
    assertPositiveInteger(reply.comment_id, "thread-reply comment_id");
    assertObject(reply.actor, "thread-reply actor");
    assertPositiveInteger(reply.actor.id, "thread-reply actor id");
    if (!["User", "Bot"].includes(reply.actor.type)) {
      fail("WORKFLOW_STATE_INVALID", "thread-reply actor type is invalid");
    }
    assertString(reply.marker, "thread-reply marker", { max: 1024 });
    assertSha(reply.head_sha, "thread-reply head_sha");
    assertString(reply.publication_review_id, "thread-reply review_id", {
      max: 1024,
    });
    if (!DIGEST_RE.test(reply.thread_watermark ?? "")) {
      fail("WORKFLOW_STATE_INVALID", "thread-reply watermark is invalid");
    }
    assertTimestamp(reply.recorded_at, "thread-reply recorded_at");
  }
  const resolvedThreads = new Set();
  for (const [index, resolution] of workflow.thread_resolutions.entries()) {
    assertObject(resolution, "workflow.thread_resolutions entry");
    if (resolution.number !== index + 1) {
      fail(
        "WORKFLOW_STATE_INVALID",
        "thread-resolution numbers must be sequential",
      );
    }
    assertString(resolution.thread_id, "thread-resolution thread_id", {
      max: 1024,
    });
    if (resolvedThreads.has(resolution.thread_id)) {
      fail(
        "WORKFLOW_STATE_INVALID",
        "a thread can carry only one recorded resolution outcome",
      );
    }
    resolvedThreads.add(resolution.thread_id);
    if (!["RESOLVED", "OBSERVED_PRE_RESOLVED"].includes(resolution.outcome)) {
      fail("WORKFLOW_STATE_INVALID", "thread-resolution outcome is invalid");
    }
    assertString(resolution.action_id, "thread-resolution action_id", {
      max: 1024,
    });
    if (!DIGEST_RE.test(resolution.thread_watermark ?? "")) {
      fail("WORKFLOW_STATE_INVALID", "thread-resolution watermark is invalid");
    }
    assertSha(resolution.head_sha, "thread-resolution head_sha");
    assertString(
      resolution.publication_review_id,
      "thread-resolution review_id",
      { max: 1024 },
    );
    assertTimestamp(resolution.recorded_at, "thread-resolution recorded_at");
  }
  for (const [index, mark] of workflow.ready_marks.entries()) {
    assertObject(mark, "workflow.ready_marks entry");
    if (mark.number !== index + 1) {
      fail("WORKFLOW_STATE_INVALID", "ready-mark numbers must be sequential");
    }
    if (!["MARKED_READY", "OBSERVED_ALREADY_READY"].includes(mark.outcome)) {
      fail("WORKFLOW_STATE_INVALID", "ready-mark outcome is invalid");
    }
    assertString(mark.action_id, "ready-mark action_id", { max: 1024 });
    assertPositiveInteger(mark.repository_id, "ready-mark repository_id");
    assertPositiveInteger(mark.pr_number, "ready-mark pr_number");
    assertSha(mark.head_sha, "ready-mark head_sha");
    assertString(mark.publication_review_id, "ready-mark review_id", {
      max: 1024,
    });
    assertPositiveInteger(
      mark.publication_revision,
      "ready-mark publication_revision",
    );
    assertTimestamp(mark.recorded_at, "ready-mark recorded_at");
  }
  validateCurrentPublication(workflow);
  const claimKeys = new Set();
  for (const entry of workflow.claims) {
    validateClaimEntry(entry, "workflow claim");
    if (entry.workflow_id !== workflow.workflow_id) {
      fail("WORKFLOW_CLAIMS_INVALID", "workflow claim owner is invalid");
    }
    const key = `${entry.kind}:${entry.canonical_key_sha256}`;
    if (claimKeys.has(key)) {
      fail("WORKFLOW_CLAIMS_INVALID", "workflow contains duplicate claims");
    }
    claimKeys.add(key);
  }
  const pullRequestClaims = workflow.claims.filter(
    (entry) => entry.kind === "PULL_REQUEST",
  );
  if (
    workflow.claims.length !== 2 + pullRequestClaims.length ||
    pullRequestClaims.length > 1
  ) {
    fail(
      "WORKFLOW_CLAIMS_INVALID",
      "workflow must own exactly its two authorized claims plus at most one pull request",
    );
  }
  if ((workflow.pull_request != null) !== (pullRequestClaims.length === 1)) {
    fail(
      "WORKFLOW_CLAIMS_INVALID",
      "pull-request binding does not match its ownership claim",
    );
  }
  if (workflow.pull_request != null) {
    const pullRequest = assertObject(
      workflow.pull_request,
      "workflow.pull_request",
    );
    assertPositiveInteger(
      pullRequest.repository_id,
      "workflow.pull_request.repository_id",
    );
    assertPositiveInteger(
      pullRequest.pr_number,
      "workflow.pull_request.pr_number",
    );
    assertString(pullRequest.url, "workflow.pull_request.url", { max: 4096 });
    const normalizedPublicationTarget =
      workflow.authorization.publication_target;
    if (
      pullRequest.repository_id !==
        normalizedPublicationTarget.base_repository_id ||
      pullRequest.base_branch !== normalizedPublicationTarget.base_branch ||
      pullRequest.head_branch !== normalizedPublicationTarget.head_branch ||
      canonicalJson(pullRequestClaims[0].target) !==
        canonicalJson({
          repository_id: pullRequest.repository_id,
          pr_number: pullRequest.pr_number,
        })
    ) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "pull-request binding does not match the authorized target and claim",
      );
    }
  }
  const dispositions = new Set(
    workflow.claims.map((entry) => entry.disposition),
  );
  if (dispositions.size !== 1) {
    fail(
      "WORKFLOW_CLAIMS_INVALID",
      "workflow claims must share one disposition",
    );
  }
  const released = dispositions.has("RELEASED");
  if (released && workflow.status !== "CANCELLED") {
    fail(
      "WORKFLOW_CLAIMS_INVALID",
      "released claims require a cancelled workflow",
    );
  }
  if (released !== (workflow.claim_release != null)) {
    fail(
      "WORKFLOW_CLAIMS_INVALID",
      "claim release evidence does not match claim dispositions",
    );
  }
  if (released) {
    assertObject(workflow.claim_release, "workflow.claim_release");
    assertTimestamp(
      workflow.claim_release.released_at,
      "workflow.claim_release.released_at",
    );
    if (
      workflow.claims.some(
        (entry) =>
          entry.released_at !== workflow.claim_release.released_at,
      )
    ) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "claim release timestamps disagree with their evidence",
      );
    }
  }
  const requiredClaimTargets = {
    LOCAL_BRANCH: {
      git_common_dir: workflow.repository.git_common_dir,
      topic_branch: workflow.topic_branch,
    },
    GITHUB_HEAD_REF: {
      head_repository_id: normalizedTarget.head_repository_id,
      head_branch: normalizedTarget.head_branch,
    },
  };
  for (const [kind, target] of Object.entries(requiredClaimTargets)) {
    const matching = workflow.claims.filter((entry) => entry.kind === kind);
    if (
      matching.length !== 1 ||
      canonicalJson(matching[0].target) !== canonicalJson(target)
    ) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        `workflow claim ${kind} does not match its authorized scope`,
      );
    }
  }
  validateCurrentReview(workflow);
  validateActiveAction(workflow);
  assertObject(workflow.action_audit, "workflow.action_audit");
  assertPositiveInteger(
    workflow.action_audit.next_sequence,
    "workflow.action_audit.next_sequence",
  );
  if (
    workflow.action_audit.last_event_sha256 !== null &&
    !DIGEST_RE.test(workflow.action_audit.last_event_sha256)
  ) {
    fail("WORKFLOW_STATE_INVALID", "workflow audit cursor is malformed");
  }
  return workflow;
}

/**
 * Fields added to an existing schema-version-1 ledger after its first
 * release. A workflow written before them lacks the keys, so they are filled
 * in on read and persist on the next mutation. Without this a released workflow could not even be
 * cancelled, and because the store-wide claim scan validates every ledger, one
 * such workflow would block starts on unrelated branches.
 */
const REMOTE_FIELD_DEFAULTS = Object.freeze({
  remote_attempts: [],
  current_publication: null,
  addressed_findings: [],
  thread_replies: [],
  thread_resolutions: [],
  ready_marks: [],
});

function withRemoteFieldDefaults(workflow) {
  if (workflow == null || typeof workflow !== "object") {
    return workflow;
  }
  for (const [field, value] of Object.entries(REMOTE_FIELD_DEFAULTS)) {
    if (workflow[field] === undefined) {
      workflow[field] = structuredClone(value);
    }
  }
  return workflow;
}

async function readWorkflowRaw(paths) {
  try {
    const workflow = validateWorkflow(
      withRemoteFieldDefaults(
        await readCanonicalSecureJson(
          paths.workflow,
          MAX_WORKFLOW_BYTES,
          "WORKFLOW_STATE_INVALID",
        ),
      ),
    );
    if (workflow.workflow_id !== path.basename(paths.directory)) {
      fail(
        "WORKFLOW_STATE_INVALID",
        "workflow ID does not match its store directory",
      );
    }
    return workflow;
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(
        "WORKFLOW_NOT_FOUND",
        `autonomous workflow ${path.basename(paths.directory)} not found`,
        { retryable: true },
      );
    }
    throw error;
  }
}

function requireWorkflowCapacity(workflow) {
  validateWorkflow(workflow);
  const bytes = Buffer.from(`${canonicalJson(workflow)}\n`);
  if (bytes.length > MAX_WORKFLOW_BYTES) {
    fail(
      "WORKFLOW_STATE_TOO_LARGE",
      "workflow mutation would exceed its readable limit",
      {
        candidate_bytes: bytes.length,
        max_bytes: MAX_WORKFLOW_BYTES,
      },
    );
  }
  return bytes;
}

async function writeWorkflow(paths, workflow) {
  await atomicWriteFile(
    paths.workflow,
    requireWorkflowCapacity(workflow),
    { mode: 0o600 },
  );
}

async function withClaimsLock(storeRoot, operation) {
  return withStateLock(
    {
      directory: storeRoot,
      reviewId: "workflow-claims",
      domain: "claims",
    },
    operation,
  );
}

async function collectActiveClaims(storeRoot) {
  const workflowsRoot = path.join(storeRoot, "workflows");
  let entries;
  try {
    entries = await fsp.readdir(workflowsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const active = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKFLOW_ID_RE.test(entry.name)) {
      continue;
    }
    let workflow;
    try {
      workflow = await readWorkflowRaw(workflowPaths(storeRoot, entry.name));
    } catch (error) {
      if (error?.code === "WORKFLOW_NOT_FOUND") {
        continue;
      }
      throw error;
    }
    let auditHead;
    try {
      auditHead = await readCanonicalSecureJson(
        workflowPaths(storeRoot, entry.name).auditHead,
        16 * 1024,
        "WORKFLOW_AUDIT_CORRUPT",
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        fail(
          "WORKFLOW_AUDIT_CORRUPT",
          "workflow action audit artifact is missing",
        );
      }
      throw error;
    }
    const recoveryPending =
      auditHead?.next_sequence !== workflow.action_audit.next_sequence ||
      auditHead?.last_event_sha256 !==
        workflow.action_audit.last_event_sha256;
    if (
      recoveryPending ||
      workflow.claims.some(
        (claimEntry) => claimEntry.disposition !== "ACTIVE",
      )
    ) {
      // Released ownership frees a claim key, and a ledger behind its audit
      // cursor may be missing a claim committed to the audit log by a
      // crashed mutation. Both are trusted only after the full locked load
      // replays the audit chain; a ledger that cannot be proven fails the
      // scan closed.
      workflow = await withWorkflowLock(
        storeRoot,
        entry.name,
        async (verified) => verified,
      );
    }
    active.push(
      ...workflow.claims.filter(
        (claimEntry) => claimEntry.disposition === "ACTIVE",
      ),
    );
  }
  return active;
}

function validateClaimEntry(entry, name) {
  assertObject(entry, name);
  assertWorkflowId(entry.workflow_id);
  if (
    !["LOCAL_BRANCH", "GITHUB_HEAD_REF", "PULL_REQUEST"].includes(entry.kind)
  ) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} kind is invalid`);
  }
  if (!DIGEST_RE.test(entry.canonical_key_sha256 ?? "")) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} digest is invalid`);
  }
  assertObject(entry.target, `${name}.target`);
  if (sha256(canonicalJson(entry.target)) !== entry.canonical_key_sha256) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} target digest is invalid`);
  }
  assertPositiveInteger(entry.created_revision, `${name}.created_revision`);
  if (!["ACTIVE", "RELEASED"].includes(entry.disposition)) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} disposition is invalid`);
  }
  assertTimestamp(entry.created_at, `${name}.created_at`);
  if ((entry.disposition === "ACTIVE") !== (entry.released_at === null)) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} release state is invalid`);
  }
  if (entry.released_at !== null) {
    assertTimestamp(entry.released_at, `${name}.released_at`);
  }
}

function validateAuditEvent(event, workflowId, expectedSequence, previousDigest) {
  assertObject(event, "audit event");
  if (
    event.version !== 1 ||
    event.workflow_id !== workflowId ||
    event.sequence !== expectedSequence ||
    event.previous_event_sha256 !== previousDigest ||
    typeof event.event_id !== "string" ||
    !/^[0-9a-f]{32}$/.test(event.event_id) ||
    !DIGEST_RE.test(event.event_sha256 ?? "")
  ) {
    fail("WORKFLOW_AUDIT_CORRUPT", "audit event identity is invalid");
  }
  assertTimestamp(event.at, "audit event at");
  assertPositiveInteger(
    event.workflow_revision,
    "audit event workflow_revision",
  );
  const { event_sha256: storedDigest, ...unsigned } = event;
  if (sha256(canonicalJson(unsigned)) !== storedDigest) {
    fail("WORKFLOW_AUDIT_CORRUPT", "audit event digest is invalid");
  }
  assertObject(event.workflow_state, "audit event workflow_state");
}

function parseAuditLines(bytes, workflowId) {
  if (bytes.length === 0) {
    return [];
  }
  if (bytes.at(-1) !== 0x0a) {
    fail(
      "WORKFLOW_AUDIT_CORRUPT",
      "committed audit prefix is not newline terminated",
    );
  }
  const lines = bytes.toString("utf8").slice(0, -1).split("\n");
  const events = [];
  let previous = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (Buffer.byteLength(lines[index]) > MAX_AUDIT_EVENT_BYTES) {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit event exceeds its size limit");
    }
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit event is malformed");
    }
    if (canonicalJson(event) !== lines[index]) {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit event is not canonical JSON");
    }
    validateAuditEvent(event, workflowId, index + 1, previous);
    previous = event.event_sha256;
    events.push(event);
  }
  return events;
}

async function truncateAuditLog(filePath, length) {
  const handle = await fsp.open(
    filePath,
    fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readAudit(paths, workflowId) {
  let head;
  let openedLog;
  try {
    head = await readCanonicalSecureJson(
      paths.auditHead,
      16 * 1024,
      "WORKFLOW_AUDIT_CORRUPT",
    );
    openedLog = await readSecureFile(paths.auditLog, {
      requiredMode: 0o600,
      maxBytes: MAX_AUDIT_BYTES,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(
        "WORKFLOW_AUDIT_CORRUPT",
        "workflow action audit artifact is missing",
      );
    }
    throw error;
  }
  try {
    if (
      head?.version !== 1 ||
      head.workflow_id !== workflowId ||
      !Number.isSafeInteger(head.committed_bytes) ||
      head.committed_bytes < 0 ||
      !Number.isSafeInteger(head.next_sequence) ||
      head.next_sequence < 1 ||
      (head.last_event_sha256 !== null &&
        !DIGEST_RE.test(head.last_event_sha256))
    ) {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit head is malformed");
    }
    if (openedLog.bytes.length < head.committed_bytes) {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit log is shorter than its cursor");
    }
    const committed = openedLog.bytes.subarray(0, head.committed_bytes);
    let events = parseAuditLines(committed, workflowId);
    const committedLast = events.at(-1)?.event_sha256 ?? null;
    if (
      head.next_sequence !== events.length + 1 ||
      head.last_event_sha256 !== committedLast
    ) {
      fail(
        "WORKFLOW_AUDIT_CORRUPT",
        "audit cursor disagrees with committed events",
      );
    }
    const tail = openedLog.bytes.subarray(head.committed_bytes);
    if (tail.length === 0) {
      return { head, events };
    }
    const newlines = [...tail].filter((byte) => byte === 0x0a).length;
    if (newlines === 0) {
      await truncateAuditLog(paths.auditLog, head.committed_bytes);
      return { head, events };
    }
    if (
      newlines !== 1 ||
      tail.at(-1) !== 0x0a ||
      tail.length > MAX_AUDIT_EVENT_BYTES + 1
    ) {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit crash tail is ambiguous");
    }
    let adopted;
    const adoptedLine = tail.toString("utf8").slice(0, -1);
    try {
      adopted = JSON.parse(adoptedLine);
    } catch {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit crash tail is malformed");
    }
    if (canonicalJson(adopted) !== adoptedLine) {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit crash tail is not canonical JSON");
    }
    validateAuditEvent(
      adopted,
      workflowId,
      head.next_sequence,
      head.last_event_sha256,
    );
    const adoptedHead = {
      version: 1,
      workflow_id: workflowId,
      committed_bytes: openedLog.bytes.length,
      next_sequence: head.next_sequence + 1,
      last_event_sha256: adopted.event_sha256,
    };
    await atomicWriteCanonicalJson(paths.auditHead, adoptedHead);
    events = [...events, adopted];
    return { head: adoptedHead, events };
  } finally {
    await openedLog.handle.close();
  }
}

function auditedWorkflowState(workflow) {
  return {
    revision: workflow.revision,
    updated_at: workflow.updated_at,
    status: workflow.status,
    phase: workflow.phase,
    current_head_sha: workflow.current_head_sha,
    pull_request: workflow.pull_request,
    attempts: workflow.attempts,
    remote_attempts: workflow.remote_attempts ?? [],
    addressed_findings: workflow.addressed_findings ?? [],
    thread_replies: workflow.thread_replies ?? [],
    thread_resolutions: workflow.thread_resolutions ?? [],
    ready_marks: workflow.ready_marks ?? [],
    active_action: workflow.active_action,
    reviewer_task: workflow.reviewer_task,
    current_review: workflow.current_review,
    current_publication: workflow.current_publication ?? null,
    progress_fingerprint: workflow.progress_fingerprint,
    pause: workflow.pause,
    cancellation: workflow.cancellation,
    claims: workflow.claims,
    claim_release: workflow.claim_release ?? null,
  };
}

function prepareAuditEvent(
  workflow,
  event,
  workflowState,
  metadata,
  {
    sequence,
    previousEventSha256,
    eventId = crypto.randomBytes(16).toString("hex"),
    at = now(),
  },
) {
  const unsigned = {
    version: 1,
    workflow_id: workflow.workflow_id,
    sequence,
    previous_event_sha256: previousEventSha256,
    event_id: eventId,
    at,
    event,
    ...(metadata == null ? {} : { metadata }),
    workflow_revision: workflowState.revision,
    action_id:
      workflowState.active_action?.action_id ??
      workflow.active_action?.action_id ??
      null,
    workflow_state: auditedWorkflowState(workflowState),
  };
  const auditEvent = {
    ...unsigned,
    event_sha256: sha256(canonicalJson(unsigned)),
  };
  return {
    event: auditEvent,
    bytes: Buffer.from(`${canonicalJson(auditEvent)}\n`),
  };
}

function requireCancellationReserve(workflow) {
  // Model the largest state this workflow can still be forced through: an
  // operator cancellation followed by a reconciled claim release, both with
  // maximal bounded inputs. Admission requires that terminal path to fit the
  // per-event and ledger limits, so a stop can always be persisted.
  const released = structuredClone(workflow);
  released.revision = Number.MAX_SAFE_INTEGER;
  released.updated_at = "9999-12-31T23:59:59.999Z";
  released.status = "CANCELLED";
  released.phase = "CANCELLED";
  released.pause = null;
  released.cancellation = {
    operator_label: "\0".repeat(1024),
    rationale: "x".repeat(MAX_CANCELLATION_RATIONALE_BYTES - 2),
    cancelled_at: "9999-12-31T23:59:59.999Z",
  };
  released.claims = released.claims.map((entry) => ({
    ...entry,
    disposition: "RELEASED",
    released_at: "9999-12-31T23:59:59.999Z",
  }));
  released.claim_release = {
    operator_label: "\0".repeat(1024),
    rationale: "x".repeat(MAX_CANCELLATION_RATIONALE_BYTES - 2),
    released_at: "9999-12-31T23:59:59.999Z",
    reconciliation: released.claims.map((entry) => ({
      kind: entry.kind,
      canonical_key_sha256: entry.canonical_key_sha256,
      target: structuredClone(entry.target),
      workflow_revision: Number.MAX_SAFE_INTEGER,
      present: entry.kind === "PULL_REQUEST",
      ...(entry.kind === "PULL_REQUEST" ? { open: false } : {}),
      observed_at: "9999-12-31T23:59:59.999Z",
    })),
  };
  const prepared = prepareAuditEvent(
    released,
    "WORKFLOW_CLAIMS_RELEASED",
    released,
    null,
    {
      sequence: Number.MAX_SAFE_INTEGER,
      previousEventSha256: "f".repeat(64),
      eventId: "f".repeat(32),
      at: "9999-12-31T23:59:59.999Z",
    },
  );
  if (prepared.bytes.length > MAX_AUDIT_EVENT_BYTES + 1) {
    fail(
      "WORKFLOW_CANCELLATION_RESERVE_EXHAUSTED",
      "workflow mutation would leave no room for its cancellation events",
      {
        candidate_bytes: prepared.bytes.length,
        max_bytes: MAX_AUDIT_EVENT_BYTES + 1,
      },
    );
  }
  released.action_audit = {
    next_sequence: Number.MAX_SAFE_INTEGER,
    last_event_sha256: "f".repeat(64),
  };
  const ledgerBytes = Buffer.from(`${canonicalJson(released)}\n`);
  if (ledgerBytes.length > MAX_WORKFLOW_BYTES) {
    fail(
      "WORKFLOW_CANCELLATION_RESERVE_EXHAUSTED",
      "workflow mutation would leave no room to persist its cancellation",
      {
        candidate_bytes: ledgerBytes.length,
        max_bytes: MAX_WORKFLOW_BYTES,
      },
    );
  }
}

async function appendAuditEvent(
  paths,
  workflow,
  event,
  workflowState,
  metadata = null,
  beforeCommit = null,
) {
  const session = await readAudit(paths, workflow.workflow_id);
  const prepared = prepareAuditEvent(
    workflow,
    event,
    workflowState,
    metadata,
    {
      sequence: session.head.next_sequence,
      previousEventSha256: session.head.last_event_sha256,
    },
  );
  const auditEvent = prepared.event;
  const eventBytes = prepared.bytes;
  if (eventBytes.length > MAX_AUDIT_EVENT_BYTES + 1) {
    fail("WORKFLOW_AUDIT_EVENT_TOO_LARGE", "audit event is too large");
  }
  const nextCommittedBytes =
    session.head.committed_bytes + eventBytes.length;
  const committedLimit =
    event === "WORKFLOW_CLAIMS_RELEASED"
      ? MAX_AUDIT_BYTES
      : event === "WORKFLOW_CANCELLED"
        ? MAX_AUDIT_BYTES - MAX_AUDIT_EVENT_BYTES - 1
        : MAX_ORDINARY_AUDIT_BYTES;
  if (nextCommittedBytes > committedLimit) {
    fail(
      "WORKFLOW_AUDIT_LOG_FULL",
      "audit event would exceed the readable audit log limit",
    );
  }
  const head = {
    version: 1,
    workflow_id: workflow.workflow_id,
    committed_bytes: nextCommittedBytes,
    next_sequence: session.head.next_sequence + 1,
    last_event_sha256: auditEvent.event_sha256,
  };
  beforeCommit?.({ event: auditEvent, head });
  const handle = await fsp.open(
    paths.auditLog,
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      fail("WORKFLOW_AUDIT_CORRUPT", "audit log metadata is unsafe");
    }
    await handle.write(eventBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await atomicWriteCanonicalJson(paths.auditHead, head);
  return { event: auditEvent, head };
}

function requireWorkflowAuditBinding(workflow, audit) {
  const lastEvent = audit.events.at(-1) ?? null;
  const lastState = lastEvent?.workflow_state ?? {
    revision: 1,
    updated_at: workflow.created_at,
    status: "ACTIVE",
    phase: "IMPLEMENTING",
    current_head_sha: null,
    pull_request: null,
    attempts: [],
    remote_attempts: [],
    addressed_findings: [],
    thread_replies: [],
    thread_resolutions: [],
    ready_marks: [],
    active_action: null,
    reviewer_task: null,
    current_review: null,
    current_publication: null,
    progress_fingerprint: null,
    pause: null,
    cancellation: null,
    claims: workflow.claims,
    claim_release: null,
  };
  if (
    workflow.revision !== (lastEvent?.workflow_revision ?? 1) ||
    workflow.revision !== lastState.revision ||
    workflow.updated_at !== lastState.updated_at ||
    workflow.status !== lastState.status ||
    workflow.phase !== lastState.phase ||
    workflow.current_head_sha !== lastState.current_head_sha ||
    canonicalJson(workflow.pull_request) !==
      canonicalJson(lastState.pull_request) ||
    canonicalJson(workflow.attempts) !== canonicalJson(lastState.attempts) ||
    canonicalJson(workflow.remote_attempts ?? []) !==
      canonicalJson(lastState.remote_attempts ?? []) ||
    canonicalJson(workflow.addressed_findings ?? []) !==
      canonicalJson(lastState.addressed_findings ?? []) ||
    canonicalJson(workflow.thread_replies ?? []) !==
      canonicalJson(lastState.thread_replies ?? []) ||
    canonicalJson(workflow.thread_resolutions ?? []) !==
      canonicalJson(lastState.thread_resolutions ?? []) ||
    canonicalJson(workflow.ready_marks ?? []) !==
      canonicalJson(lastState.ready_marks ?? []) ||
    canonicalJson(workflow.active_action) !==
      canonicalJson(lastState.active_action) ||
    canonicalJson(workflow.reviewer_task) !==
      canonicalJson(lastState.reviewer_task) ||
    canonicalJson(workflow.current_review) !==
      canonicalJson(lastState.current_review) ||
    canonicalJson(workflow.current_publication ?? null) !==
      canonicalJson(lastState.current_publication ?? null) ||
    workflow.progress_fingerprint !== lastState.progress_fingerprint ||
    canonicalJson(workflow.pause) !== canonicalJson(lastState.pause) ||
    canonicalJson(workflow.cancellation) !==
      canonicalJson(lastState.cancellation) ||
    canonicalJson(workflow.claims) !== canonicalJson(lastState.claims) ||
    canonicalJson(workflow.claim_release ?? null) !==
      canonicalJson(lastState.claim_release ?? null)
  ) {
    fail(
      "WORKFLOW_AUDIT_CORRUPT",
      "workflow action state does not match the committed audit chain",
    );
  }
}

async function reconcileWorkflowAudit(paths, workflow) {
  const audit = await readAudit(paths, workflow.workflow_id);
  if (
    workflow.action_audit.next_sequence === audit.head.next_sequence &&
    workflow.action_audit.last_event_sha256 === audit.head.last_event_sha256
  ) {
    requireWorkflowAuditBinding(workflow, audit);
    return workflow;
  }
  const lastEvent = audit.events.at(-1);
  if (
    audit.head.next_sequence !== workflow.action_audit.next_sequence + 1 ||
    lastEvent?.previous_event_sha256 !==
      workflow.action_audit.last_event_sha256 ||
    lastEvent.workflow_revision !== workflow.revision + 1
  ) {
    fail(
      "WORKFLOW_AUDIT_CORRUPT",
      "workflow ledger and action audit cannot be reconciled",
    );
  }
  const recovered = structuredClone(workflow);
  for (const field of [
    "revision",
    "updated_at",
    "status",
    "phase",
    "current_head_sha",
    "pull_request",
    "attempts",
    "remote_attempts",
    "addressed_findings",
    "thread_replies",
    "thread_resolutions",
    "ready_marks",
    "active_action",
    "reviewer_task",
    "current_review",
    "current_publication",
    "progress_fingerprint",
    "pause",
    "cancellation",
    "claims",
    "claim_release",
  ]) {
    // An audit event committed before the remote fields existed carries none
    // of them, so recovery restores their defaults instead of undefined.
    recovered[field] = structuredClone(
      lastEvent.workflow_state[field] ??
        (field in REMOTE_FIELD_DEFAULTS
          ? REMOTE_FIELD_DEFAULTS[field]
          : lastEvent.workflow_state[field]),
    );
  }
  recovered.action_audit = {
    next_sequence: audit.head.next_sequence,
    last_event_sha256: audit.head.last_event_sha256,
  };
  requireWorkflowAuditBinding(recovered, audit);
  await writeWorkflow(paths, recovered);
  return recovered;
}

async function loadWorkflowWhileLocked(paths) {
  return reconcileWorkflowAudit(paths, await readWorkflowRaw(paths));
}

async function withWorkflowLock(storeRoot, workflowId, operation) {
  const paths = workflowPaths(storeRoot, workflowId);
  await fsp.stat(paths.directory);
  return withStateLock(
    {
      directory: paths.directory,
      reviewId: workflowId,
      domain: "workflow",
    },
    async () => {
      const workflow = await loadWorkflowWhileLocked(paths);
      return operation(workflow, paths);
    },
  );
}

function requireRevision(workflow, expectedRevision) {
  assertPositiveInteger(expectedRevision, "expected_revision");
  if (workflow.revision !== expectedRevision) {
    fail(
      "WORKFLOW_REVISION_CONFLICT",
      `workflow revision mismatch (expected=${expectedRevision}, actual=${workflow.revision})`,
      {
        expected_revision: expectedRevision,
        actual_revision: workflow.revision,
      },
    );
  }
}

function requireActive(workflow) {
  if (workflow.status !== "ACTIVE") {
    fail(
      "WORKFLOW_NOT_ACTIVE",
      `workflow is not active (status=${workflow.status})`,
    );
  }
}

function requireCapability(workflow, capability) {
  if (!workflow.authorization.capabilities.includes(capability)) {
    fail(
      "WORKFLOW_CAPABILITY_REQUIRED",
      `workflow capability ${capability} is required`,
    );
  }
}

async function saveMutation(paths, workflow, mutate) {
  return saveActionMutation(
    paths,
    workflow,
    "WORKFLOW_STATE_UPDATED",
    mutate,
  );
}

async function saveActionMutation(
  paths,
  workflow,
  event,
  mutate,
  metadata = null,
) {
  const next = structuredClone(workflow);
  await mutate(next);
  next.revision += 1;
  next.updated_at = now();
  if (next.status !== "CANCELLED") {
    requireCancellationReserve(next);
  } else if (event === "WORKFLOW_STATE_UPDATED") {
    fail(
      "WORKFLOW_STATE_INVALID",
      "a cancelled workflow only accepts its audited claim release",
    );
  }
  const appended = await appendAuditEvent(
    paths,
    workflow,
    event,
    next,
    metadata,
    ({ head }) => {
      const candidate = structuredClone(next);
      candidate.action_audit = {
        next_sequence: head.next_sequence,
        last_event_sha256: head.last_event_sha256,
      };
      requireWorkflowCapacity(candidate);
    },
  );
  next.action_audit = {
    next_sequence: appended.head.next_sequence,
    last_event_sha256: appended.head.last_event_sha256,
  };
  await writeWorkflow(paths, next);
  return next;
}

function validatePublicationTarget(target, topicBranch) {
  assertObject(target, "publication_target");
  for (const name of ["base_repository_id", "head_repository_id"]) {
    assertPositiveInteger(target[name], `publication_target.${name}`);
  }
  for (const name of [
    "base_owner",
    "base_repo",
    "base_branch",
    "head_owner",
    "head_repo",
    "head_branch",
    "push_remote",
  ]) {
    assertString(target[name], `publication_target.${name}`, { max: 1024 });
  }
  if (target.head_branch !== topicBranch) {
    throw new TypeError(
      "publication_target.head_branch must equal topic_branch",
    );
  }
  return {
    base_repository_id: target.base_repository_id,
    base_owner: target.base_owner,
    base_repo: target.base_repo,
    base_branch: target.base_branch,
    head_repository_id: target.head_repository_id,
    head_owner: target.head_owner,
    head_repo: target.head_repo,
    head_branch: target.head_branch,
    push_remote: target.push_remote,
  };
}

function claim(kind, key, workflowId, createdRevision = 1) {
  return {
    workflow_id: workflowId,
    kind,
    canonical_key_sha256: sha256(canonicalJson(key)),
    target: structuredClone(key),
    created_revision: createdRevision,
    disposition: "ACTIVE",
    created_at: now(),
    released_at: null,
  };
}

function reviewBindingPath(storeRoot, reviewId) {
  return path.join(storeRoot, "reviews", reviewId, "workflow-binding.json");
}

async function readReviewBinding(storeRoot, reviewId) {
  let binding;
  try {
    binding = await readCanonicalSecureJson(
      reviewBindingPath(storeRoot, reviewId),
      16 * 1024,
      "WORKFLOW_REVIEW_BINDING_INVALID",
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (binding?.version !== 1 || binding.review_id !== reviewId) {
    fail(
      "WORKFLOW_REVIEW_BINDING_INVALID",
      "review workflow binding is malformed",
    );
  }
  assertWorkflowId(binding.workflow_id);
  assertTimestamp(binding.bound_at, "binding.bound_at");
  return binding;
}

async function requireReviewBinding(storeRoot, workflow, reviewId) {
  const binding = await readReviewBinding(storeRoot, reviewId);
  if (binding == null || binding.workflow_id !== workflow.workflow_id) {
    fail(
      "WORKFLOW_REVIEW_MISMATCH",
      "local review is not bound to this workflow",
    );
  }
}

function requireCleanReviewRound(review) {
  const round = review.rounds?.find(
    (entry) => entry.round === review.current_round,
  );
  if (
    round == null ||
    round.worktree_clean !== true ||
    !Array.isArray(round.overlays) ||
    round.overlays.length !== 0
  ) {
    fail(
      "WORKFLOW_REVIEW_DIRTY",
      "autonomous local review requires a clean committed snapshot",
    );
  }
  return round;
}

function nextAction(workflow) {
  if (workflow.status === "CANCELLED") {
    return "NONE";
  }
  if (workflow.status === "PAUSED") {
    return workflow.pause?.reason_code === "LOCAL_REVIEW_HUMAN_REQUIRED"
      ? "HUMAN_ARBITRATION"
      : "AWAIT_OPERATOR";
  }
  const actionPhase = (planAction, statusActions) =>
    workflow.active_action == null
      ? planAction
      : statusActions[workflow.active_action.status] ?? "INSPECT_WORKFLOW";
  const actions = {
    IMPLEMENTING: "COMMIT_HEAD",
    PREPARE_LOCAL_REVIEW: "PREPARE_LOCAL_REVIEW",
    DISPATCH_CODEX_REVIEWER: actionPhase("PLAN_CODEX_TASK_DISPATCH", {
      PLANNED: "CREATE_CODEX_REVIEWER_TASK",
      EXECUTING: "RECONCILE_CODEX_REVIEWER_TASK",
      OBSERVED: "COMPLETE_CODEX_TASK_DISPATCH",
    }),
    WAIT_LOCAL_REVIEW: "WAIT_LOCAL_REVIEW",
    ADDRESS_LOCAL_FINDINGS: "ADDRESS_LOCAL_FINDINGS",
    PREPARE_REREVIEW: "PREPARE_REREVIEW",
    WAIT_LOCAL_REREVIEW: "WAIT_LOCAL_REREVIEW",
    FINALIZE_LOCAL_GATE: "FINALIZE_LOCAL_GATE",
    LOCAL_GATE_PASSED: "PLAN_PUSH",
    PUSH_GATED_HEAD: actionPhase("INSPECT_WORKFLOW", {
      PLANNED: "PUSH_TOPIC_BRANCH",
      EXECUTING: "RECONCILE_PUSH",
      OBSERVED: "COMPLETE_PUSH",
    }),
    ENSURE_DRAFT_PR: actionPhase("PLAN_DRAFT_PULL_REQUEST", {
      PLANNED: "CREATE_DRAFT_PULL_REQUEST",
      EXECUTING: "RECONCILE_DRAFT_PULL_REQUEST",
      OBSERVED: "COMPLETE_DRAFT_PULL_REQUEST",
    }),
    START_PUBLICATION: "START_PUBLICATION",
    WAIT_PUBLICATION: "WAIT_PUBLICATION",
    RESOLVE_CODEX_THREADS:
      workflow.active_action == null
        ? "PLAN_THREAD_ACTION"
        : ({
            REPLY_TO_CODEX_THREAD: {
              PLANNED: "REPLY_TO_CODEX_THREAD",
              EXECUTING: "RECONCILE_THREAD_REPLY",
              OBSERVED: "COMPLETE_THREAD_REPLY",
            },
            RESOLVE_REVIEW_THREAD: {
              PLANNED: "RESOLVE_REVIEW_THREAD",
              EXECUTING: "RECONCILE_THREAD_RESOLUTION",
              OBSERVED: "COMPLETE_THREAD_RESOLUTION",
            },
          }[workflow.active_action.kind]?.[workflow.active_action.status] ??
          "INSPECT_WORKFLOW"),
    ADDRESS_REMOTE_FINDINGS: "ADDRESS_REMOTE_FINDINGS",
    ADDRESS_CHECK_FAILURE: "ADDRESS_CHECK_FAILURE",
    UPDATE_FROM_BASE: "UPDATE_FROM_BASE",
    PRE_READY: actionPhase("PLAN_MARK_PR_READY", {
      PLANNED: "MARK_PR_READY",
      EXECUTING: "RECONCILE_MARK_PR_READY",
      OBSERVED: "COMPLETE_MARK_PR_READY",
    }),
    POST_READY: "AWAIT_OPERATOR",
  };
  return actions[workflow.phase] ?? "INSPECT_WORKFLOW";
}

function workflowSummary(workflow) {
  return {
    workflow_id: workflow.workflow_id,
    revision: workflow.revision,
    created_at: workflow.created_at,
    updated_at: workflow.updated_at,
    status: workflow.status,
    phase: workflow.phase,
    next_action: nextAction(workflow),
    base_sha: workflow.base_sha,
    topic_branch: workflow.topic_branch,
    current_head_sha: workflow.current_head_sha,
    current_review: workflow.current_review,
    current_publication: workflow.current_publication,
    remote_attempts: workflow.remote_attempts,
    addressed_findings: workflow.addressed_findings,
    thread_replies: workflow.thread_replies,
    thread_resolutions: workflow.thread_resolutions,
    ready_marks: workflow.ready_marks,
    active_action:
      workflow.active_action == null
        ? null
        : {
            action_id: workflow.active_action.action_id,
            kind: workflow.active_action.kind,
            status: workflow.active_action.status,
            dispatch: structuredClone(workflow.active_action.dispatch),
          },
    pause: workflow.pause,
    progress_fingerprint: workflow.progress_fingerprint,
  };
}

export async function startAutonomousWorkflow(
  storeRoot,
  {
    repositoryPath,
    baseRef,
    baseSha,
    requirement,
    implementationScope,
    topicBranch,
    operatorLabel,
    capabilities,
    publicationTarget,
  },
) {
  assertString(baseRef, "base_ref", { max: 1024 });
  assertSha(baseSha, "base_sha");
  assertString(requirement, "requirement");
  assertString(implementationScope, "implementation_scope");
  assertString(topicBranch, "topic_branch", { max: 1024 });
  assertString(operatorLabel, "operator_label", { max: 1024 });
  const normalizedCapabilities = assertCapabilities(capabilities);
  const normalizedTarget = validatePublicationTarget(
    publicationTarget,
    topicBranch,
  );
  const repository = await repositoryIdentity(repositoryPath);
  requireCleanRepository(repository.path);
  if (currentBranch(repository.path) !== topicBranch) {
    fail(
      "WORKFLOW_BRANCH_MISMATCH",
      "the authorized topic branch must be checked out",
    );
  }
  if (currentHead(repository.path) !== baseSha) {
    fail(
      "WORKFLOW_BASE_MISMATCH",
      "the topic branch must point to the immutable base SHA at workflow start",
    );
  }
  if (runGit(repository.path, ["rev-parse", baseRef]).stdout !== baseSha) {
    fail(
      "WORKFLOW_BASE_MISMATCH",
      "base_ref does not resolve to base_sha",
    );
  }
  runGit(repository.path, [
    "remote",
    "get-url",
    normalizedTarget.push_remote,
  ]);

  const workflowId = createWorkflowId();
  const authorizedAt = now();
  const authorization = {
    mode: "AUTONOMOUS_LOCAL_GATE",
    operator_label: operatorLabel,
    authorized_at: authorizedAt,
    capabilities: normalizedCapabilities,
    scope: {
      repository,
      base_ref: baseRef,
      base_sha: baseSha,
      requirement,
      implementation_scope: implementationScope,
      topic_branch: topicBranch,
    },
    publication_target: normalizedTarget,
  };
  authorization.workflow_authorization_sha256 =
    authorizationDigest(authorization);
  const workflowClaims = [
    claim(
      "LOCAL_BRANCH",
      {
        git_common_dir: repository.git_common_dir,
        topic_branch: topicBranch,
      },
      workflowId,
    ),
    claim(
      "GITHUB_HEAD_REF",
      {
        head_repository_id: normalizedTarget.head_repository_id,
        head_branch: normalizedTarget.head_branch,
      },
      workflowId,
    ),
  ];
  const timestamp = now();
  const workflow = {
    version: 1,
    workflow_id: workflowId,
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
    repository,
    requirement,
    implementation_scope: implementationScope,
    base_ref: baseRef,
    base_sha: baseSha,
    topic_branch: topicBranch,
    authorization,
    status: "ACTIVE",
    phase: "IMPLEMENTING",
    current_head_sha: null,
    current_review: null,
    current_publication: null,
    reviewer_task: null,
    pull_request: null,
    attempts: [],
    remote_attempts: [],
    addressed_findings: [],
    thread_replies: [],
    thread_resolutions: [],
    ready_marks: [],
    claims: workflowClaims,
    active_action: null,
    progress_fingerprint: null,
    pause: null,
    cancellation: null,
    claim_release: null,
    action_audit: {
      next_sequence: 1,
      last_event_sha256: null,
    },
  };
  requireCancellationReserve(workflow);
  requireWorkflowCapacity(workflow);

  await fsp.mkdir(storeRoot, { recursive: true, mode: 0o700 });
  return withClaimsLock(storeRoot, async () => {
    const activeClaims = await collectActiveClaims(storeRoot);
    const conflicting = activeClaims.find((existing) =>
      workflowClaims.some(
        (candidate) =>
          candidate.kind === existing.kind &&
          candidate.canonical_key_sha256 === existing.canonical_key_sha256,
      ),
    );
    if (conflicting) {
      fail(
        "WORKFLOW_OWNERSHIP_CONFLICT",
        `claim ${conflicting.kind} is owned by ${conflicting.workflow_id}`,
        {
          owner_workflow_id: conflicting.workflow_id,
          claim_kind: conflicting.kind,
          canonical_key_sha256: conflicting.canonical_key_sha256,
        },
      );
    }
    const paths = workflowPaths(storeRoot, workflowId);
    await fsp.mkdir(path.dirname(paths.directory), {
      recursive: true,
      mode: 0o700,
    });
    await fsp.mkdir(paths.directory, { recursive: false, mode: 0o700 });
    await atomicWriteFile(paths.auditLog, Buffer.alloc(0), { mode: 0o600 });
    await atomicWriteCanonicalJson(paths.auditHead, {
      version: 1,
      workflow_id: workflowId,
      committed_bytes: 0,
      next_sequence: 1,
      last_event_sha256: null,
    });
    await writeWorkflow(paths, workflow);
    return publicWorkflow(workflow);
  });
}

export async function getAutonomousWorkflow(storeRoot, workflowId) {
  return withWorkflowLock(storeRoot, workflowId, async (workflow) =>
    publicWorkflow(workflow),
  );
}

export async function getAutonomousWorkflowSummary(storeRoot, workflowId) {
  return withWorkflowLock(storeRoot, workflowId, async (workflow) =>
    workflowSummary(workflow),
  );
}

export async function listAutonomousWorkflows(storeRoot, statuses = null) {
  const workflowsRoot = path.join(storeRoot, "workflows");
  let entries;
  try {
    entries = await fsp.readdir(workflowsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const statusSet =
    Array.isArray(statuses) && statuses.length > 0
      ? new Set(statuses)
      : null;
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKFLOW_ID_RE.test(entry.name)) {
      continue;
    }
    try {
      const workflow = await getAutonomousWorkflow(storeRoot, entry.name);
      if (statusSet == null || statusSet.has(workflow.status)) {
        result.push(workflowSummary(workflow));
      }
    } catch (error) {
      if (
        error?.code === "ENOENT" ||
        error?.code === "WORKFLOW_NOT_FOUND"
      ) {
        continue;
      }
      throw error;
    }
  }
  return result.sort((left, right) =>
    right.updated_at?.localeCompare(left.updated_at ?? ""),
  );
}

export async function recordWorkflowHead(
  storeRoot,
  workflowId,
  expectedRevision,
  headSha,
) {
  assertSha(headSha, "head_sha");
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    requireCapability(workflow, "CREATE_COMMITS");
    if (!HEAD_RECORDING_PHASES.includes(workflow.phase)) {
      fail(
        "WORKFLOW_PHASE_INVALID",
        `cannot record a head in phase ${workflow.phase}`,
      );
    }
    const repository = await repositoryIdentity(workflow.repository.path);
    if (
      repository.path !== workflow.repository.path ||
      repository.git_common_dir !== workflow.repository.git_common_dir
    ) {
      fail("WORKFLOW_REPOSITORY_DRIFT", "repository identity changed");
    }
    requireCleanRepository(repository.path);
    if (currentBranch(repository.path) !== workflow.topic_branch) {
      fail("WORKFLOW_BRANCH_MISMATCH", "topic branch is not checked out");
    }
    if (currentHead(repository.path) !== headSha) {
      fail("WORKFLOW_HEAD_MISMATCH", "HEAD does not equal head_sha");
    }
    const previousHead =
      workflow.current_head_sha ?? workflow.base_sha;
    if (headSha === previousHead) {
      fail("WORKFLOW_NO_PROGRESS", "new committed head must change");
    }
    requireAncestor(repository.path, previousHead, headSha);
    // A head recorded to answer remote findings must say which finding review
    // it answers -- RFC 0003 eligibility condition 3, and the only link that
    // survives into the next publication, whose baseline absorbs this review
    // as pre-existing. The identity is read from the bound publication rather
    // than taken from the caller, so the record can only name the review
    // whose correlated result actually blocked.
    let addressedFinding = null;
    if (workflow.phase === "ADDRESS_REMOTE_FINDINGS") {
      if (workflow.current_publication == null) {
        fail(
          "WORKFLOW_STATE_INVALID",
          "the remote repair has no bound publication",
        );
      }
      const findings = await getPublicationFindingsReview(
        storeRoot,
        workflow.current_publication.review_id,
      );
      // The identity must come from the same publication revision whose
      // projection sent this workflow into the repair phase -- the revision
      // advanceRemoteWorkflow recorded as awaiting_revision in the mutation
      // that set the phase. The publication lock is released before this
      // workflow mutation persists, so revision equality is what proves no
      // snapshot slid between the blocking evidence and the record: an
      // identity read across such a snapshot could name a review the
      // publication no longer supports.
      if (
        findings.workflow_id !== workflow.workflow_id ||
        findings.head_sha !== workflow.current_head_sha ||
        findings.revision !== workflow.current_publication.awaiting_revision ||
        findings.findings_review == null
      ) {
        fail(
          "WORKFLOW_FINDINGS_UNIDENTIFIED",
          "the bound publication does not name a correlated findings review at the revision that entered the repair phase",
          { review_id: workflow.current_publication.review_id },
        );
      }
      addressedFinding = {
        publication_review_id: workflow.current_publication.review_id,
        publication_revision: findings.revision,
        findings_review: findings.findings_review,
        // Every commit this repair introduced, oldest first. The head alone
        // would also be true, but the record's words are "addressed by one or
        // more commits", and the range previousHead..headSha is exactly the
        // set this workflow created to answer the finding.
        addressed_by: runGit(repository.path, [
          "rev-list",
          "--reverse",
          `${previousHead}..${headSha}`,
        ])
          .stdout.split("\n")
          .filter((line) => line !== ""),
      };
    }
    return publicWorkflow(
      await saveMutation(paths, workflow, async (next) => {
        const reviewId =
          next.phase === "ADDRESS_LOCAL_FINDINGS"
            ? next.current_review?.review_id ?? null
            : null;
        if (addressedFinding != null) {
          next.addressed_findings.push({
            number: next.addressed_findings.length + 1,
            ...addressedFinding,
            recorded_at: now(),
          });
        }
        next.current_head_sha = headSha;
        next.attempts.push({
          number: next.attempts.length + 1,
          head_sha: headSha,
          review_id: reviewId,
          recorded_at: now(),
        });
        // A new head invalidates every piece of evidence bound to the old one.
        // The publication ledger stays on disk as history but can no longer
        // authorize this workflow; the repaired head starts a fresh cycle.
        next.current_publication = null;
        if (next.phase !== "ADDRESS_LOCAL_FINDINGS") {
          next.phase = "PREPARE_LOCAL_REVIEW";
        }
      }),
    );
  });
}

export async function bindWorkflowReview(
  storeRoot,
  workflowId,
  expectedRevision,
  reviewId,
) {
  assertString(reviewId, "review_id", { max: 1024 });
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    if (workflow.phase !== "PREPARE_LOCAL_REVIEW") {
      fail(
        "WORKFLOW_PHASE_INVALID",
        `cannot bind a review in phase ${workflow.phase}`,
      );
    }
    // Validate and bind under the review mutation lock so a review verdict
    // submitted after this snapshot cannot be hidden behind a stale
    // WAITING_FOR_REVIEW binding that then dispatches a reviewer task.
    return getReviewSnapshot(storeRoot, reviewId, async ({ review, summary }) => {
      requireCleanReviewRound(review);
      const reviewRepository = await fsp.realpath(review.repository_path);
      if (
        reviewRepository !== workflow.repository.path ||
        review.base_ref !== workflow.base_sha ||
        review.requirement !== workflow.requirement ||
        review.implementation_scope !== workflow.implementation_scope ||
        review.reviewer_provider !== "CODEX_TASK" ||
        summary.status !== "WAITING_FOR_REVIEW" ||
        summary.current_snapshot?.head_sha !== workflow.current_head_sha
      ) {
        fail(
          "WORKFLOW_REVIEW_MISMATCH",
          "local review does not match the workflow repository, requirement, provider, base, head, and state",
        );
      }
      // One review may serve one workflow. The exclusive binding marker is
      // written under the review mutation lock, so a second workflow whose
      // scope also matches this review fails closed instead of adopting a
      // verdict produced for another workflow's reviewer task.
      const binding = await readReviewBinding(storeRoot, reviewId);
      if (binding != null && binding.workflow_id !== workflow.workflow_id) {
        fail(
          "WORKFLOW_REVIEW_OWNERSHIP_CONFLICT",
          `review ${reviewId} is already bound to ${binding.workflow_id}`,
          { owner_workflow_id: binding.workflow_id, review_id: reviewId },
        );
      }
      if (binding == null) {
        await atomicWriteCanonicalJson(
          reviewBindingPath(storeRoot, reviewId),
          {
            version: 1,
            review_id: reviewId,
            workflow_id: workflow.workflow_id,
            bound_at: now(),
          },
        );
      }
      return publicWorkflow(
        await saveMutation(paths, workflow, async (next) => {
          next.attempts.at(-1).review_id = reviewId;
          next.current_review = {
            review_id: reviewId,
            state_version: summary.state_version,
            status: summary.status,
            strategy: summary.review_strategy,
            snapshot_hash: summary.current_snapshot.snapshot_hash,
            head_sha: summary.current_snapshot.head_sha,
          };
          // A repaired head binds a different review, and every review ID gets
          // its own fresh reviewer task. Releasing the previous binding is what
          // lets the next dispatch be planned at all.
          next.reviewer_task = null;
          next.phase = "DISPATCH_CODEX_REVIEWER";
        }),
      );
    });
  });
}

function dispatchFor(workflow, action) {
  validateActiveAction({ ...workflow, active_action: action });
  return structuredClone(action.dispatch);
}

async function planWorkflowAction(
  storeRoot,
  workflowId,
  expectedRevision,
  kind,
  { planPhases, invalidMessage, target },
) {
  const spec = ACTION_KIND_SPECS[kind];
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    requireCapability(workflow, spec.capability);
    if (
      !planPhases.includes(workflow.phase) ||
      workflow.active_action != null
    ) {
      fail("WORKFLOW_PHASE_INVALID", invalidMessage);
    }
    const actionTarget = await target(workflow);
    const ownershipClaim = workflow.claims.find(
      (entry) => entry.kind === spec.claimKind,
    );
    const actionId = workflowActionId(
      workflow,
      workflow.revision,
      kind,
      spec.identityFacts(actionTarget),
    );
    const action = {
      action_id: actionId,
      kind,
      status: "PLANNED",
      planned_revision: workflow.revision,
      planned_at: now(),
      executing_at: null,
      observed_at: null,
      completed_at: null,
      required_capability: spec.capability,
      authorization_sha256:
        workflow.authorization.workflow_authorization_sha256,
      target: actionTarget,
      ownership_claim: {
        kind: ownershipClaim.kind,
        canonical_key_sha256: ownershipClaim.canonical_key_sha256,
      },
      correlation_marker:
        spec.markerPrefix == null
          ? null
          : workflowCorrelationMarker(spec.markerPrefix, workflow, actionId),
      dispatch: null,
      executing_proof: null,
      provider_response: null,
    };
    action.dispatch = spec.dispatch == null ? null : spec.dispatch(action);
    const next = await saveActionMutation(
      paths,
      workflow,
      "ACTION_PLANNED",
      async (draft) => {
        draft.active_action = action;
        draft.phase = spec.phase;
      },
    );
    return {
      workflow: publicWorkflow(next),
      action: structuredClone(next.active_action),
      dispatch: dispatchFor(next, next.active_action),
    };
  });
}

export async function planCodexTaskDispatch(
  storeRoot,
  workflowId,
  expectedRevision,
  reviewId,
) {
  return planWorkflowAction(
    storeRoot,
    workflowId,
    expectedRevision,
    "CREATE_CODEX_REVIEWER_TASK",
    {
      planPhases: ["DISPATCH_CODEX_REVIEWER"],
      invalidMessage: "Codex task dispatch is not currently plannable",
      target: (workflow) => {
        if (workflow.current_review?.review_id !== reviewId) {
          fail(
            "WORKFLOW_PHASE_INVALID",
            "Codex task dispatch is not currently plannable",
          );
        }
        return { review_id: reviewId, reviewer_provider: "CODEX_TASK" };
      },
    },
  );
}

export async function planWorkflowPush(
  storeRoot,
  workflowId,
  expectedRevision,
) {
  return planWorkflowAction(
    storeRoot,
    workflowId,
    expectedRevision,
    "PUSH_TOPIC_BRANCH",
    {
      planPhases: ["LOCAL_GATE_PASSED"],
      invalidMessage: "the gated head push is not currently plannable",
      target: async (workflow) => {
        // The clean checked-out HEAD must still equal the gated workflow
        // head immediately before the push intent is persisted.
        const repository = await repositoryIdentity(workflow.repository.path);
        if (
          repository.path !== workflow.repository.path ||
          repository.git_common_dir !== workflow.repository.git_common_dir
        ) {
          fail("WORKFLOW_REPOSITORY_DRIFT", "repository identity changed");
        }
        requireCleanRepository(repository.path);
        if (currentBranch(repository.path) !== workflow.topic_branch) {
          fail("WORKFLOW_BRANCH_MISMATCH", "topic branch is not checked out");
        }
        if (currentHead(repository.path) !== workflow.current_head_sha) {
          fail(
            "WORKFLOW_HEAD_MISMATCH",
            "HEAD does not equal the gated workflow head",
          );
        }
        const authorized = workflow.authorization.publication_target;
        // git push uses the push URL, which can differ from the fetch URL;
        // multiple push URLs cannot be bound to one observation proof.
        const pushUrls = runGit(repository.path, [
          "remote",
          "get-url",
          "--push",
          "--all",
          authorized.push_remote,
        ])
          .stdout.split("\n")
          .filter((line) => line !== "");
        if (pushUrls.length !== 1) {
          fail(
            "WORKFLOW_ACTION_INVALID",
            "the authorized remote must have exactly one push URL",
          );
        }
        const remoteUrl = requireCredentialFreePushUrl(
          pushUrls[0],
          "push target remote_url",
        );
        return {
          push_remote: authorized.push_remote,
          remote_url: remoteUrl,
          head_repository_id: authorized.head_repository_id,
          head_branch: authorized.head_branch,
          head_sha: workflow.current_head_sha,
        };
      },
    },
  );
}

export async function planDraftPullRequest(
  storeRoot,
  workflowId,
  expectedRevision,
  { creatorActorId, creatorActorType },
) {
  assertPositiveInteger(creatorActorId, "creator_actor_id");
  if (!["User", "Bot"].includes(creatorActorType)) {
    throw new TypeError("creator_actor_type must be User or Bot");
  }
  return planWorkflowAction(
    storeRoot,
    workflowId,
    expectedRevision,
    "CREATE_DRAFT_PULL_REQUEST",
    {
      planPhases: ["ENSURE_DRAFT_PR"],
      invalidMessage: "the draft pull request is not currently plannable",
      target: (workflow) => {
        const authorized = workflow.authorization.publication_target;
        return {
          base_repository_id: authorized.base_repository_id,
          base_branch: authorized.base_branch,
          head_repository_id: authorized.head_repository_id,
          head_branch: authorized.head_branch,
          head_sha: workflow.current_head_sha,
          expected_creator_actor_id: creatorActorId,
          expected_creator_actor_type: creatorActorType,
        };
      },
    },
  );
}

/**
 * Plan the mark-ready that ends the autonomous run. Planning refuses unless
 * the publication clears this exact head, and records which observation
 * cleared it. That record is provenance, not authority: the clearance is
 * read again at the pre-write checkpoint, and it is that later reading the
 * completed record names.
 */
export async function planMarkPullRequestReady(
  storeRoot,
  workflowId,
  expectedRevision,
) {
  return planWorkflowAction(
    storeRoot,
    workflowId,
    expectedRevision,
    "MARK_PR_READY",
    {
      planPhases: ["PRE_READY"],
      invalidMessage: "the mark-ready is not currently plannable",
      target: async (workflow) => {
        if (workflow.current_publication == null || workflow.pull_request == null) {
          fail(
            "WORKFLOW_STATE_INVALID",
            "mark-ready has no bound publication and pull request",
          );
        }
        const reviewId = workflow.current_publication.review_id;
        const preReady = await getAutonomousPreReady(storeRoot, reviewId);
        if (
          preReady.workflow_id !== workflow.workflow_id ||
          preReady.head_sha !== workflow.current_head_sha
        ) {
          fail(
            "WORKFLOW_PUBLICATION_MISMATCH",
            "publication is not bound to this workflow and head",
          );
        }
        if (preReady.status !== "READY_TO_MARK") {
          fail(
            "WORKFLOW_PUBLICATION_NOT_READY",
            "the publication has not cleared the pull request for review",
            {
              status: preReady.status,
              blocking_reason: preReady.blocking_reason,
            },
          );
        }
        return {
          review_id: reviewId,
          repository_id: workflow.pull_request.repository_id,
          pr_number: workflow.pull_request.pr_number,
          base_branch: workflow.pull_request.base_branch,
          head_branch: workflow.pull_request.head_branch,
          head_sha: workflow.current_head_sha,
          publication_revision: preReady.revision,
        };
      },
    },
  );
}

export async function planThreadReply(
  storeRoot,
  workflowId,
  expectedRevision,
  { threadId, actorId, actorType },
) {
  assertString(threadId, "thread_id", { max: 1024 });
  assertPositiveInteger(actorId, "actor_id");
  if (!["User", "Bot"].includes(actorType)) {
    throw new TypeError("actor_type must be User or Bot");
  }
  return planWorkflowAction(
    storeRoot,
    workflowId,
    expectedRevision,
    "REPLY_TO_CODEX_THREAD",
    {
      planPhases: ["RESOLVE_CODEX_THREADS"],
      invalidMessage: "a thread reply is not currently plannable",
      target: async (workflow) => {
        if (workflow.current_publication == null) {
          fail(
            "WORKFLOW_STATE_INVALID",
            "thread resolution has no bound publication",
          );
        }
        if (
          workflow.thread_replies.some(
            (reply) => reply.thread_id === threadId,
          )
        ) {
          fail(
            "WORKFLOW_THREAD_ALREADY_ANSWERED",
            "this thread already carries the workflow's recorded reply",
            { thread_id: threadId },
          );
        }
        // The eligibility evidence is read fresh under the publication lock
        // and bound into the intent: thread watermark, digest, and the
        // addressed-by commits the reply body will name.
        const plan = await getThreadResolutionPlan(
          storeRoot,
          workflow.current_publication.review_id,
        );
        if (
          plan.workflow_id !== workflow.workflow_id ||
          plan.head_sha !== workflow.current_head_sha
        ) {
          fail(
            "WORKFLOW_PUBLICATION_MISMATCH",
            "publication is not bound to this workflow and head",
          );
        }
        const entry = plan.threads.find(
          (thread) => thread.thread_id === threadId,
        );
        if (entry == null || entry.eligible !== true) {
          fail(
            "WORKFLOW_THREAD_NOT_ELIGIBLE",
            "the thread is not eligible for automatic resolution",
            { thread_id: threadId, reason: entry?.reason ?? "THREAD_UNKNOWN" },
          );
        }
        return {
          review_id: workflow.current_publication.review_id,
          thread_id: threadId,
          thread_watermark: entry.thread_watermark,
          eligibility_sha256: entry.eligibility_sha256,
          head_sha: workflow.current_head_sha,
          expected_actor_id: actorId,
          expected_actor_type: actorType,
          addressed_by: entry.addressed_by,
        };
      },
    },
  );
}

export async function planThreadResolution(
  storeRoot,
  workflowId,
  expectedRevision,
  { threadId },
) {
  assertString(threadId, "thread_id", { max: 1024 });
  return planWorkflowAction(
    storeRoot,
    workflowId,
    expectedRevision,
    "RESOLVE_REVIEW_THREAD",
    {
      planPhases: ["RESOLVE_CODEX_THREADS"],
      invalidMessage: "a thread resolution is not currently plannable",
      target: async (workflow) => {
        if (workflow.current_publication == null) {
          fail(
            "WORKFLOW_STATE_INVALID",
            "thread resolution has no bound publication",
          );
        }
        const reply = workflow.thread_replies.find(
          (entry) => entry.thread_id === threadId,
        );
        if (reply == null) {
          fail(
            "WORKFLOW_THREAD_NOT_ANSWERED",
            "a resolution must follow the workflow's recorded reply",
            { thread_id: threadId },
          );
        }
        if (
          workflow.thread_resolutions.some(
            (entry) => entry.thread_id === threadId,
          )
        ) {
          fail(
            "WORKFLOW_THREAD_ALREADY_RESOLVED",
            "this thread already carries a recorded resolution outcome",
            { thread_id: threadId },
          );
        }
        const plan = await getThreadResolutionPlan(
          storeRoot,
          workflow.current_publication.review_id,
        );
        if (
          plan.workflow_id !== workflow.workflow_id ||
          plan.head_sha !== workflow.current_head_sha
        ) {
          fail(
            "WORKFLOW_PUBLICATION_MISMATCH",
            "publication is not bound to this workflow and head",
          );
        }
        const entry = plan.threads.find(
          (thread) => thread.thread_id === threadId,
        );
        if (entry == null || entry.eligible !== true) {
          fail(
            "WORKFLOW_THREAD_NOT_ELIGIBLE",
            "the thread is not eligible for automatic resolution",
            { thread_id: threadId, reason: entry?.reason ?? "THREAD_UNKNOWN" },
          );
        }
        // The intent must bind the reply-inclusive watermark. An observation
        // recorded before the reply still derives an eligible thread, but a
        // record bound to it would be invalidated by the very snapshot that
        // shows the workflow's own reply -- a permanent stop on a correct
        // resolution. Refuse until a fresh observation contains the reply.
        if (!entry.comment_database_ids.includes(reply.comment_id)) {
          fail(
            "WORKFLOW_THREAD_REPLY_NOT_OBSERVED",
            "the recorded observation does not contain the workflow's reply yet",
            { thread_id: threadId, reply_comment_id: reply.comment_id },
          );
        }
        return {
          review_id: workflow.current_publication.review_id,
          thread_id: threadId,
          thread_watermark: entry.thread_watermark,
          eligibility_sha256: entry.eligibility_sha256,
          head_sha: workflow.current_head_sha,
          expected_actor_id: reply.actor.id,
          expected_actor_type: reply.actor.type,
          reply_comment_id: reply.comment_id,
        };
      },
    },
  );
}

export async function markWorkflowActionExecuting(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
  executingProof = null,
) {
  assertString(actionId, "action_id", { max: 1024 });
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    const action = workflow.active_action;
    if (action?.action_id !== actionId || action.status !== "PLANNED") {
      fail("WORKFLOW_ACTION_STATE_INVALID", "action must be PLANNED");
    }
    const spec = ACTION_KIND_SPECS[action.kind];
    if (spec.validateExecutingProof) {
      spec.validateExecutingProof(action, executingProof);
    } else if (executingProof != null) {
      fail(
        "WORKFLOW_ACTION_INVALID",
        "this action kind does not take an executing proof",
      );
    }
    // Some intents are only as good as evidence that lives outside the
    // workflow ledger and can move under them between planning and the call.
    // This is the last durable point before the external write, so it is
    // where that evidence has to be read again.
    let clearedRevision = null;
    if (spec.revalidate) {
      try {
        clearedRevision = await spec.revalidate(storeRoot, action);
      } catch (error) {
        // Only the checkpoint's own refusal drops an intent, and only
        // before the external write: PLANNED is what makes "nothing has
        // happened yet" structural rather than something a caller asserts.
        if (error?.code !== spec.abandonOnCode) {
          throw error;
        }
        // Leaving a refused intent in place is what would turn this into a
        // stop with no exit: its phase can neither advance, record a head,
        // nor plan again while an action is active, so cancelling the whole
        // workflow would be the only way out of a guard that is working
        // exactly as intended.
        const discarded = await saveActionMutation(
          paths,
          workflow,
          "ACTION_ABANDONED",
          async (next) => {
            next.active_action = null;
            next.phase = spec.abandonPhase;
          },
          {
            abandoned_action_id: action.action_id,
            abandoned_kind: action.kind,
            reason_code: error?.code ?? null,
          },
        );
        error.details = {
          ...(error?.details ?? {}),
          action_abandoned: action.action_id,
          workflow_revision: discarded.revision,
          phase: discarded.phase,
        };
        throw error;
      }
    }
    return publicWorkflow(
      await saveActionMutation(
        paths,
        workflow,
        "ACTION_EXECUTING",
        async (next) => {
          next.active_action.status = "EXECUTING";
          next.active_action.executing_at = now();
          next.active_action.executing_proof =
            executingProof == null ? null : structuredClone(executingProof);
          if (clearedRevision != null) {
            next.active_action.cleared_publication_revision = clearedRevision;
          }
        },
      ),
    );
  });
}

async function recordActionObservation(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
  kind,
  buildResponse,
) {
  assertString(actionId, "action_id", { max: 1024 });
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    const action = workflow.active_action;
    if (action?.action_id !== actionId || action.status !== "EXECUTING") {
      fail("WORKFLOW_ACTION_STATE_INVALID", "action must be EXECUTING");
    }
    if (action.kind !== kind) {
      fail("WORKFLOW_ACTION_KIND_INVALID", "unsupported workflow action");
    }
    const response = buildResponse(workflow, action);
    return publicWorkflow(
      await saveActionMutation(
        paths,
        workflow,
        "ACTION_OBSERVED",
        async (next) => {
          next.active_action.status = "OBSERVED";
          next.active_action.observed_at = now();
          next.active_action.provider_response = {
            ...response,
            observed_at: now(),
          };
        },
      ),
    );
  });
}

export async function recordCodexTaskObservation(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
  { matchingTaskIds, taskId, title, prompt },
) {
  assertString(taskId, "task_id", { max: 4096 });
  assertString(title, "title", { max: 4096 });
  assertString(prompt, "prompt");
  if (
    !Array.isArray(matchingTaskIds) ||
    matchingTaskIds.length !== 1 ||
    matchingTaskIds[0] !== taskId
  ) {
    fail(
      "WORKFLOW_TASK_AMBIGUOUS",
      "task reconciliation requires exactly one matching task",
    );
  }
  return recordActionObservation(
    storeRoot,
    workflowId,
    expectedRevision,
    actionId,
    "CREATE_CODEX_REVIEWER_TASK",
    (workflow, action) => {
      const dispatch = dispatchFor(workflow, action);
      if (title !== dispatch.title || prompt !== dispatch.prompt) {
        fail(
          "WORKFLOW_TASK_MARKER_MISMATCH",
          "task title and prompt must equal the server-issued dispatch payload",
        );
      }
      return {
        task_id: taskId,
        matching_task_ids: [taskId],
        title_sha256: sha256(title),
        prompt_sha256: sha256(prompt),
      };
    },
  );
}

export async function recordThreadReplyObservation(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
  { matchingCommentIds, commentId, threadId, actorId, actorType, body },
) {
  assertPositiveInteger(commentId, "comment_id");
  assertString(threadId, "thread_id", { max: 1024 });
  assertPositiveInteger(actorId, "actor_id");
  assertString(actorType, "actor_type", { max: 100 });
  assertString(body, "body", { max: 65_536 });
  if (
    !Array.isArray(matchingCommentIds) ||
    matchingCommentIds.length !== 1 ||
    matchingCommentIds[0] !== commentId
  ) {
    fail(
      "WORKFLOW_THREAD_REPLY_AMBIGUOUS",
      "reply reconciliation requires exactly one marker comment in the thread",
    );
  }
  return recordActionObservation(
    storeRoot,
    workflowId,
    expectedRevision,
    actionId,
    "REPLY_TO_CODEX_THREAD",
    (workflow, action) => {
      const dispatch = dispatchFor(workflow, action);
      if (body !== dispatch.body) {
        fail(
          "WORKFLOW_THREAD_REPLY_MISMATCH",
          "the observed comment body must equal the server-issued reply body",
        );
      }
      return {
        comment_id: commentId,
        matching_comment_ids: [commentId],
        thread_id: threadId,
        actor_id: actorId,
        actor_type: actorType,
        body_sha256: sha256(body),
      };
    },
  );
}

export async function recordThreadResolutionObservation(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
  { outcome, threadId, isResolved, threadWatermark, resolvedById, resolvedByType },
) {
  assertString(threadId, "thread_id", { max: 1024 });
  if (!["RESOLVED", "OBSERVED_PRE_RESOLVED"].includes(outcome)) {
    throw new TypeError("outcome must be RESOLVED or OBSERVED_PRE_RESOLVED");
  }
  return recordActionObservation(
    storeRoot,
    workflowId,
    expectedRevision,
    actionId,
    "RESOLVE_REVIEW_THREAD",
    () => ({
      outcome,
      thread_id: threadId,
      is_resolved: isResolved,
      ...(outcome === "RESOLVED"
        ? {
            thread_watermark: threadWatermark,
            resolved_by_id: resolvedById,
            resolved_by_type: resolvedByType,
          }
        : {}),
    }),
  );
}

export async function recordMarkReadyObservation(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
  {
    outcome,
    repositoryId,
    prNumber,
    baseBranch,
    headBranch,
    headSha,
    isDraft,
  },
) {
  if (!["MARKED_READY", "OBSERVED_ALREADY_READY"].includes(outcome)) {
    throw new TypeError("outcome must be MARKED_READY or OBSERVED_ALREADY_READY");
  }
  assertPositiveInteger(repositoryId, "repository_id");
  assertPositiveInteger(prNumber, "pr_number");
  assertSha(headSha, "head_sha");
  return recordActionObservation(
    storeRoot,
    workflowId,
    expectedRevision,
    actionId,
    "MARK_PR_READY",
    () => ({
      outcome,
      repository_id: repositoryId,
      pr_number: prNumber,
      base_branch: baseBranch,
      head_branch: headBranch,
      head_sha: headSha,
      is_draft: isDraft,
    }),
  );
}

export async function recordPushObservation(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
  { remoteRefSha, remoteRepositoryId, remoteUrl },
) {
  assertSha(remoteRefSha, "remote_ref_sha");
  assertPositiveInteger(remoteRepositoryId, "remote_repository_id");
  requireCredentialFreePushUrl(remoteUrl, "remote_url");
  return recordActionObservation(
    storeRoot,
    workflowId,
    expectedRevision,
    actionId,
    "PUSH_TOPIC_BRANCH",
    (workflow, action) => {
      if (
        remoteRefSha !== action.target.head_sha ||
        remoteRepositoryId !== action.target.head_repository_id ||
        remoteUrl !== action.target.remote_url
      ) {
        fail(
          "WORKFLOW_ACTION_INVALID",
          "observed remote does not prove the authorized repository and pushed head",
        );
      }
      return {
        remote_ref_sha: remoteRefSha,
        remote_repository_id: remoteRepositoryId,
        remote_url: remoteUrl,
      };
    },
  );
}

export async function recordDraftPullRequestObservation(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
  {
    matchingPrNumbers,
    prNumber,
    repositoryId,
    headRepositoryId,
    baseBranch,
    headBranch,
    headSha,
    draft,
    bodyMarker,
    creatorActorId,
    creatorActorType,
    url,
  },
) {
  assertString(bodyMarker, "body_marker", { max: 4096 });
  assertPositiveInteger(prNumber, "pr_number");
  assertPositiveInteger(repositoryId, "repository_id");
  assertPositiveInteger(headRepositoryId, "head_repository_id");
  assertPositiveInteger(creatorActorId, "creator_actor_id");
  assertString(baseBranch, "base_branch", { max: 1024 });
  assertString(headBranch, "head_branch", { max: 1024 });
  assertSha(headSha, "head_sha");
  assertString(url, "url", { max: 4096 });
  if (
    !Array.isArray(matchingPrNumbers) ||
    matchingPrNumbers.length !== 1 ||
    matchingPrNumbers[0] !== prNumber
  ) {
    fail(
      "WORKFLOW_PULL_REQUEST_AMBIGUOUS",
      "pull-request reconciliation requires exactly one matching pull request",
    );
  }
  return recordActionObservation(
    storeRoot,
    workflowId,
    expectedRevision,
    actionId,
    "CREATE_DRAFT_PULL_REQUEST",
    () => ({
      pr_number: prNumber,
      matching_pr_numbers: [prNumber],
      repository_id: repositoryId,
      head_repository_id: headRepositoryId,
      base_branch: baseBranch,
      head_branch: headBranch,
      head_sha: headSha,
      draft,
      body_marker: bodyMarker,
      creator_actor_id: creatorActorId,
      creator_actor_type: creatorActorType,
      url,
    }),
  );
}

async function completeCodexTaskDispatch(storeRoot, workflow, paths, action) {
  // The bound review must still be exactly the state that was bound before
  // dispatch, and it must stay that way until ACTION_COMPLETED is
  // persisted: the check and the completion commit share the review
  // mutation lock, so a verdict can never slip in between them and predate
  // the completed reviewer task.
  return getReviewSnapshot(
    storeRoot,
    action.target.review_id,
    async ({ summary }) => {
      await requireReviewBinding(
        storeRoot,
        workflow,
        action.target.review_id,
      );
      if (
        summary.status !== "WAITING_FOR_REVIEW" ||
        summary.state_version !== workflow.current_review.state_version
      ) {
        fail(
          "WORKFLOW_REVIEW_TRANSITION_INVALID",
          "local review changed before the reviewer task dispatch completed",
          {
            review_id: action.target.review_id,
            bound_state_version: workflow.current_review.state_version,
            observed_state_version: summary.state_version,
            observed_status: summary.status,
          },
        );
      }
      return publicWorkflow(
        await saveActionMutation(
          paths,
          workflow,
          "ACTION_COMPLETED",
          async (next) => {
            next.reviewer_task = {
              task_id: next.active_action.provider_response.task_id,
              review_id: next.active_action.target.review_id,
              reviewer_provider: "CODEX_TASK",
              dispatch_marker: next.active_action.correlation_marker,
              observed_at: next.active_action.provider_response.observed_at,
            };
            next.active_action.completed_at = now();
            next.active_action = null;
            next.phase = "WAIT_LOCAL_REVIEW";
          },
        ),
      );
    },
  );
}

async function completeDraftPullRequest(storeRoot, workflow, paths, action) {
  const response = action.provider_response;
  const prClaim = claim(
    "PULL_REQUEST",
    {
      repository_id: response.repository_id,
      pr_number: response.pr_number,
    },
    workflow.workflow_id,
    workflow.revision + 1,
  );
  const conflicting = (await collectActiveClaims(storeRoot)).find(
    (existing) =>
      existing.kind === prClaim.kind &&
      existing.canonical_key_sha256 === prClaim.canonical_key_sha256 &&
      existing.workflow_id !== workflow.workflow_id,
  );
  if (conflicting) {
    fail(
      "WORKFLOW_OWNERSHIP_CONFLICT",
      `claim ${conflicting.kind} is owned by ${conflicting.workflow_id}`,
      {
        owner_workflow_id: conflicting.workflow_id,
        claim_kind: conflicting.kind,
        canonical_key_sha256: conflicting.canonical_key_sha256,
      },
    );
  }
  return publicWorkflow(
    await saveActionMutation(
      paths,
      workflow,
      "ACTION_COMPLETED",
      async (next) => {
        next.pull_request = {
          repository_id: response.repository_id,
          pr_number: response.pr_number,
          base_branch: response.base_branch,
          head_branch: response.head_branch,
          url: response.url,
        };
        if (!next.claims.some((entry) => entry.kind === "PULL_REQUEST")) {
          next.claims.push(structuredClone(prClaim));
        }
        next.active_action.completed_at = now();
        next.active_action = null;
        next.phase = "START_PUBLICATION";
      },
    ),
  );
}

export async function completeWorkflowAction(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
) {
  assertString(actionId, "action_id", { max: 1024 });
  // Peek at the action kind first: completing a pull-request creation adds a
  // store-wide claim, and the claims lock must be acquired before the
  // workflow lock to preserve the claims -> workflow -> review lock order
  // that workflow start relies on.
  const peeked = await readWorkflowRaw(workflowPaths(storeRoot, workflowId));
  const peekedClaimsLock =
    peeked.active_action?.kind === "CREATE_DRAFT_PULL_REQUEST";
  const complete = async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    const action = workflow.active_action;
    if (action?.action_id !== actionId || action.status !== "OBSERVED") {
      fail("WORKFLOW_ACTION_STATE_INVALID", "action must be OBSERVED");
    }
    // The peek chose the lock nesting; the locked state must agree, or the
    // claims lock this kind requires may not actually be held. A racing
    // driver that guessed a future revision retries against fresh state.
    if (
      (action.kind === "CREATE_DRAFT_PULL_REQUEST") !== peekedClaimsLock
    ) {
      fail(
        "WORKFLOW_ACTION_STATE_INVALID",
        "the workflow changed while its completion locks were being acquired",
        { retryable: true },
      );
    }
    if (action.kind === "CREATE_CODEX_REVIEWER_TASK") {
      return completeCodexTaskDispatch(storeRoot, workflow, paths, action);
    }
    if (action.kind === "PUSH_TOPIC_BRANCH") {
      return publicWorkflow(
        await saveActionMutation(
          paths,
          workflow,
          "ACTION_COMPLETED",
          async (next) => {
            next.active_action.completed_at = now();
            next.active_action = null;
            next.phase = "ENSURE_DRAFT_PR";
          },
        ),
      );
    }
    if (action.kind === "CREATE_DRAFT_PULL_REQUEST") {
      return completeDraftPullRequest(storeRoot, workflow, paths, action);
    }
    if (action.kind === "RESOLVE_REVIEW_THREAD") {
      if (action.provider_response.outcome === "RESOLVED") {
        // The server-owned record must exist before the action may close.
        // Completing without it would let the next snapshot -- which shows
        // the thread resolved -- make the record permanently uncreatable,
        // and the gate's invalidation re-check would have nothing to hold a
        // later objection against. The record creation is idempotent for
        // this action, so a crashed driver repeats it and then completes.
        const ledger = await getPublication(
          storeRoot,
          action.target.review_id,
        );
        const record = (ledger.automatic_resolutions ?? []).find(
          (entry) =>
            entry.thread_id === action.target.thread_id &&
            entry.action_id === action.action_id,
        );
        // A terminal publication can no longer be written to, so the record
        // is not merely late -- it is uncreatable. Holding the action open
        // for it would strand the workflow on a publication that is already
        // closed, merged, or invalidated, and the record would have nothing
        // left to protect: no gate of a terminal publication can pass.
        if (record == null && ledger.terminal == null) {
          fail(
            "WORKFLOW_RESOLUTION_RECORD_MISSING",
            "a resolved outcome completes only after its automatic-resolution record is stored",
            { review_id: action.target.review_id, retryable: true },
          );
        }
      }
      return publicWorkflow(
        await saveActionMutation(
          paths,
          workflow,
          "ACTION_COMPLETED",
          async (next) => {
            next.active_action.completed_at = now();
            next.thread_resolutions.push({
              number: next.thread_resolutions.length + 1,
              thread_id: action.target.thread_id,
              outcome: action.provider_response.outcome,
              action_id: action.action_id,
              thread_watermark: action.target.thread_watermark,
              head_sha: action.target.head_sha,
              publication_review_id: action.target.review_id,
              recorded_at: now(),
            });
            next.active_action = null;
          },
        ),
      );
    }
    if (action.kind === "MARK_PR_READY") {
      return publicWorkflow(
        await saveActionMutation(
          paths,
          workflow,
          "ACTION_COMPLETED",
          async (next) => {
            next.active_action.completed_at = now();
            next.ready_marks.push({
              number: next.ready_marks.length + 1,
              outcome: action.provider_response.outcome,
              action_id: action.action_id,
              repository_id: action.target.repository_id,
              pr_number: action.target.pr_number,
              head_sha: action.target.head_sha,
              publication_review_id: action.target.review_id,
              publication_revision: action.cleared_publication_revision,
              recorded_at: now(),
            });
            next.active_action = null;
            // The pull request is out of draft, so no repair phase may run
            // until it is returned to draft -- which this rollout stage
            // cannot do. The workflow stops advancing here and the terminal
            // projection is the operator's.
            next.phase = "POST_READY";
          },
        ),
      );
    }
    if (action.kind === "REPLY_TO_CODEX_THREAD") {
      return publicWorkflow(
        await saveActionMutation(
          paths,
          workflow,
          "ACTION_COMPLETED",
          async (next) => {
            next.active_action.completed_at = now();
            // The record the eligibility exception admits: exactly this
            // comment, in exactly this thread, by exactly this actor. The
            // phase stays put -- the second half of the resolution still
            // has to happen here.
            next.thread_replies.push({
              number: next.thread_replies.length + 1,
              thread_id: action.target.thread_id,
              comment_id: action.provider_response.comment_id,
              actor: {
                id: action.target.expected_actor_id,
                type: action.target.expected_actor_type,
              },
              marker: action.correlation_marker,
              head_sha: action.target.head_sha,
              publication_review_id: action.target.review_id,
              thread_watermark: action.target.thread_watermark,
              recorded_at: now(),
            });
            next.active_action = null;
          },
        ),
      );
    }
    fail("WORKFLOW_ACTION_KIND_INVALID", "unsupported workflow action");
  };
  if (peeked.active_action?.kind === "CREATE_DRAFT_PULL_REQUEST") {
    return withClaimsLock(storeRoot, async () =>
      withWorkflowLock(storeRoot, workflowId, complete),
    );
  }
  return withWorkflowLock(storeRoot, workflowId, complete);
}

function findingFingerprint(summary) {
  if (summary.active_findings.length === 0) {
    return null;
  }
  return sha256(
    canonicalJson(
      summary.active_findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        path: finding.path ?? null,
        line: finding.line ?? null,
      })),
    ),
  );
}

export async function advanceLocalWorkflow(
  storeRoot,
  workflowId,
  expectedRevision,
) {
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    if (workflow.active_action != null || workflow.current_review == null) {
      fail(
        "WORKFLOW_PHASE_INVALID",
        "local workflow cannot advance with an active action or missing review",
      );
    }
    if (
      workflow.reviewer_task?.review_id !==
        workflow.current_review.review_id ||
      workflow.reviewer_task?.reviewer_provider !== "CODEX_TASK"
    ) {
      fail(
        "WORKFLOW_REVIEWER_TASK_REQUIRED",
        "local review cannot advance before the bound Codex reviewer task is completed",
      );
    }
    const reviewId = workflow.current_review.review_id;
    await requireReviewBinding(storeRoot, workflow, reviewId);
    const { review, summary } = await getReviewSnapshot(storeRoot, reviewId);
    requireCleanReviewRound(review);
    if (
      review.repository_path !== workflow.repository.path ||
      review.base_ref !== workflow.base_sha ||
      review.requirement !== workflow.requirement ||
      review.implementation_scope !== workflow.implementation_scope ||
      review.reviewer_provider !== "CODEX_TASK"
    ) {
      fail(
        "WORKFLOW_REVIEW_MISMATCH",
        "bound review identity changed",
      );
    }
    const legalStatuses = {
      WAIT_LOCAL_REVIEW: new Set([
        "REVIEW_SUBMITTED",
        "CLEAN",
        "HUMAN_REQUIRED",
      ]),
      ADDRESS_LOCAL_FINDINGS: new Set([
        "AUTHOR_RESPONDED",
        "HUMAN_REQUIRED",
      ]),
      PREPARE_REREVIEW: new Set(["WAITING_FOR_REREVIEW"]),
      WAIT_LOCAL_REREVIEW: new Set(["CLEAN", "HUMAN_REQUIRED"]),
      FINALIZE_LOCAL_GATE: new Set(["LOCAL_GATE_PASSED"]),
    }[workflow.phase];
    if (legalStatuses == null || !legalStatuses.has(summary.status)) {
      fail(
        "WORKFLOW_REVIEW_TRANSITION_INVALID",
        `review status ${summary.status} cannot advance workflow phase ${workflow.phase}`,
      );
    }
    const snapshotHead = summary.current_snapshot?.head_sha ?? null;
    if (
      ["WAITING_FOR_REVIEW", "WAITING_FOR_REREVIEW", "CLEAN"].includes(
        summary.status,
      ) &&
      snapshotHead !== workflow.current_head_sha
    ) {
      fail(
        "WORKFLOW_REVIEW_HEAD_MISMATCH",
        "bound review snapshot does not equal the workflow head",
      );
    }
    if (summary.status === "AUTHOR_RESPONDED") {
      const repository = await repositoryIdentity(workflow.repository.path);
      if (
        repository.path !== workflow.repository.path ||
        repository.git_common_dir !== workflow.repository.git_common_dir
      ) {
        fail("WORKFLOW_REPOSITORY_DRIFT", "repository identity changed");
      }
      requireCleanRepository(repository.path);
      if (currentBranch(repository.path) !== workflow.topic_branch) {
        fail("WORKFLOW_BRANCH_MISMATCH", "topic branch is not checked out");
      }
      if (currentHead(repository.path) !== workflow.current_head_sha) {
        fail(
          "WORKFLOW_HEAD_MISMATCH",
          "HEAD does not equal the recorded workflow head",
        );
      }
    }
    const save =
      summary.status === "HUMAN_REQUIRED"
        ? (mutate) =>
            saveActionMutation(paths, workflow, "WORKFLOW_PAUSED", mutate)
        : (mutate) => saveMutation(paths, workflow, mutate);
    return publicWorkflow(
      await save(async (next) => {
        next.current_review = {
          ...next.current_review,
          state_version: summary.state_version,
          status: summary.status,
          strategy: summary.review_strategy,
          snapshot_hash: summary.current_snapshot?.snapshot_hash ?? null,
          head_sha: snapshotHead,
        };
        next.progress_fingerprint = findingFingerprint(summary);
        const phases = {
          WAITING_FOR_REVIEW: "WAIT_LOCAL_REVIEW",
          REVIEW_SUBMITTED: "ADDRESS_LOCAL_FINDINGS",
          AUTHOR_RESPONDED: "PREPARE_REREVIEW",
          WAITING_FOR_REREVIEW: "WAIT_LOCAL_REREVIEW",
          CLEAN: "FINALIZE_LOCAL_GATE",
          LOCAL_GATE_PASSED: "LOCAL_GATE_PASSED",
        };
        if (summary.status === "HUMAN_REQUIRED") {
          next.status = "PAUSED";
          next.phase = "PAUSED_HUMAN";
          next.pause = {
            reason_code: "LOCAL_REVIEW_HUMAN_REQUIRED",
            blocked_action: "LOCAL_REVIEW",
            review_id: reviewId,
            review_state_version: summary.state_version,
            paused_at: now(),
          };
          return;
        }
        const phase = phases[summary.status];
        if (phase == null) {
          fail(
            "WORKFLOW_REVIEW_STATE_INVALID",
            `unsupported local review status ${summary.status}`,
          );
        }
        if (summary.status === "LOCAL_GATE_PASSED") {
          const gate = await readSecureJson(
            path.join(storeRoot, "reviews", reviewId, "gate.json"),
            { requiredMode: 0o600, maxBytes: 64 * 1024 },
          );
          if (
            gate.status !== "LOCAL_GATE_PASSED" ||
            gate.review_id !== reviewId ||
            gate.reviewer_provider !== "CODEX_TASK" ||
            gate.base_sha !== workflow.base_sha ||
            gate.head_sha !== workflow.current_head_sha
          ) {
            fail(
              "WORKFLOW_LOCAL_GATE_MISMATCH",
              "local gate does not match the workflow head and review",
            );
          }
        }
        next.phase = phase;
      }),
    );
  });
}

function treeSha(repositoryPath, headSha) {
  return runGit(repositoryPath, ["rev-parse", `${headSha}^{tree}`]).stdout;
}

/**
 * Bind the version-3 publication started for the current gated head and enter
 * the remote wait. The workflow records only which publication and revision it
 * is waiting on: the request generation, immediate binding, and unbound-request
 * detection all stay in the publication ledger.
 */
export async function bindWorkflowPublication(
  storeRoot,
  workflowId,
  expectedRevision,
  reviewId,
) {
  assertString(reviewId, "review_id", { max: 1024 });
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    requireCapability(workflow, "POST_CODEX_REVIEW_REQUESTS");
    if (workflow.phase !== "START_PUBLICATION") {
      fail(
        "WORKFLOW_PHASE_INVALID",
        `cannot bind a publication in phase ${workflow.phase}`,
      );
    }
    const projection = await getAutonomousPreReady(storeRoot, reviewId);
    if (
      projection.workflow_id !== workflow.workflow_id ||
      projection.head_sha !== workflow.current_head_sha
    ) {
      fail(
        "WORKFLOW_PUBLICATION_MISMATCH",
        "publication is not bound to this workflow and head",
      );
    }
    return publicWorkflow(
      await saveMutation(paths, workflow, async (next) => {
        next.current_publication = {
          review_id: reviewId,
          head_sha: next.current_head_sha,
          bound_revision: projection.revision,
          awaiting_revision: projection.revision,
          bound_at: now(),
        };
        next.phase = "WAIT_PUBLICATION";
      }),
    );
  });
}

/**
 * Read the bound publication's autonomous projection and take the one workflow
 * transition it implies. Statuses that are simply not settled yet leave the
 * workflow in WAIT_PUBLICATION; only a state that needs a new head, an operator
 * decision, or the pre-ready stop changes the phase.
 */
export async function advanceRemoteWorkflow(
  storeRoot,
  workflowId,
  expectedRevision,
  { clock = Date.now } = {},
) {
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    if (
      !["WAIT_PUBLICATION", "RESOLVE_CODEX_THREADS"].includes(workflow.phase)
    ) {
      fail(
        "WORKFLOW_PHASE_INVALID",
        `cannot advance a remote wait in phase ${workflow.phase}`,
      );
    }
    if (workflow.active_action != null) {
      fail(
        "WORKFLOW_PHASE_INVALID",
        "cannot advance a remote wait while a thread action is active",
      );
    }
    if (workflow.current_publication == null) {
      fail("WORKFLOW_STATE_INVALID", "the remote wait has no bound publication");
    }
    const reviewId = workflow.current_publication.review_id;
    const projection = await getAutonomousPreReady(storeRoot, reviewId, {
      clock,
    });
    if (
      projection.workflow_id !== workflow.workflow_id ||
      projection.review_id !== reviewId ||
      projection.head_sha !== workflow.current_head_sha
    ) {
      fail(
        "WORKFLOW_PUBLICATION_MISMATCH",
        "publication is not bound to this workflow and head",
      );
    }
    const repairPhase = remoteRepairPhase(projection);
    const pauseReason = remotePauseReason(projection);
    if (repairPhase == null && pauseReason == null) {
      // Still settling, or blocked on something no autonomous action of this
      // stage may touch (unresolved threads). Keep waiting and only refresh the
      // revision the workflow has observed.
      //
      // A repair phase is left only by recording a new head. A required check
      // that fails and then passes on a rerun with no code change therefore
      // leaves the workflow in its repair phase; the operator commits a fix or
      // cancels. Letting a repair phase re-evaluate instead was tried and
      // withdrawn: every status this projection can report before it reaches
      // the check and Codex gates masks a blocker that is still standing, so
      // the release kept firing on unevaluated evidence.
      const reachedPreReady = projection.status === "READY_TO_MARK";
      // Unresolved threads are no longer only an operator's problem: when at
      // least one is eligible, the workflow moves to the thread-resolution
      // phase and acts. With none eligible it keeps waiting exactly as
      // before -- and a workflow already in the resolution phase whose
      // blocker moved on returns to the wait rather than keeping a phase
      // whose work no longer exists.
      let desiredPhase = "WAIT_PUBLICATION";
      if (reachedPreReady) {
        desiredPhase = "PRE_READY";
      } else if (
        projection.status === "CHANGES_REQUIRED" &&
        projection.blocking_reason === "UNRESOLVED_REVIEW_THREADS"
      ) {
        const plan = await getThreadResolutionPlan(storeRoot, reviewId);
        if (plan.threads.some((thread) => thread.eligible)) {
          desiredPhase = "RESOLVE_CODEX_THREADS";
        }
      }
      if (
        desiredPhase === workflow.phase &&
        workflow.current_publication.awaiting_revision === projection.revision
      ) {
        // Nothing moved. Polling is the normal shape of this phase, so an idle
        // check must not spend a revision and an audit event: a long wait would
        // otherwise fill the audit log on its own.
        return publicWorkflow(workflow);
      }
      return publicWorkflow(
        await saveMutation(paths, workflow, async (next) => {
          next.current_publication.awaiting_revision = projection.revision;
          next.phase = desiredPhase;
        }),
      );
    }
    const repository = await repositoryIdentity(workflow.repository.path);
    if (repository.git_common_dir !== workflow.repository.git_common_dir) {
      fail("WORKFLOW_REPOSITORY_DRIFT", "repository identity changed");
    }
    const tree = treeSha(repository.path, workflow.current_head_sha);
    // Compare against every recorded attempt, not just the last one. A repeat
    // does not have to be adjacent: a tree that oscillates between two states,
    // or a blocker that alternates with another, would otherwise return to a
    // position already proven not to clear it and never stall. The conjunct
    // with head or tree is what keeps this from firing on real progress.
    const repeated =
      workflow.remote_attempts.find(
        (attempt) =>
          attempt.blocker_sha256 === projection.blocker_sha256 &&
          (attempt.head_sha === workflow.current_head_sha ||
            attempt.tree_sha === tree),
      ) ?? null;
    const stalled = repeated != null;
    if (stalled || pauseReason != null) {
      // Resume where the operator's remedy is actually possible. Returning to
      // WAIT_PUBLICATION would strand every pause whose fix is a new commit:
      // record_workflow_head rejects that phase, so resume and advance would
      // re-derive the same stop forever.
      const resumePhase =
        repairPhase ?? REMOTE_PAUSE_RESUME_PHASES[pauseReason] ?? "WAIT_PUBLICATION";
      return publicWorkflow(
        await saveActionMutation(
          paths,
          workflow,
          "WORKFLOW_PAUSED",
          async (next) => {
            next.current_publication.awaiting_revision = projection.revision;
            if (stalled) {
              // Keep the attempt chain complete for the operator, and make the
              // next comparison run against this stop rather than the attempt
              // before it.
              next.remote_attempts.push({
                number: next.remote_attempts.length + 1,
                head_sha: next.current_head_sha,
                tree_sha: tree,
                blocker_sha256: projection.blocker_sha256,
                status: projection.status,
                at: now(),
              });
            }
            next.status = "PAUSED";
            next.phase = "PAUSED_HUMAN";
            next.pause = {
              reason_code: pauseReason ?? "NO_PROGRESS",
              blocked_action: "WAIT_PUBLICATION",
              evidence: JSON.stringify({
                review_id: reviewId,
                publication_revision: projection.revision,
                status: projection.status,
                blocking_reason: projection.blocking_reason,
                // The digest is the comparison key; the listed blockers are
                // for the operator and are capped so a pathological blocker
                // set cannot make the pause itself too large to persist.
                blocker_sha256: projection.blocker_sha256,
                blocker_count: projection.blockers.length,
                blockers: projection.blockers.slice(0, MAX_LISTED_BLOCKERS),
                head_sha: workflow.current_head_sha,
                tree_sha: tree,
                ...(stalled
                  ? { previous_remote_attempt: repeated }
                  : {}),
              }),
              resume_phase: resumePhase,
              review_id: workflow.current_review?.review_id ?? null,
              action_id: null,
              paused_at: now(),
            };
          },
        ),
      );
    }
    return publicWorkflow(
      await saveMutation(paths, workflow, async (next) => {
        next.current_publication.awaiting_revision = projection.revision;
        next.remote_attempts.push({
          number: next.remote_attempts.length + 1,
          head_sha: next.current_head_sha,
          tree_sha: tree,
          blocker_sha256: projection.blocker_sha256,
          status: projection.status,
          at: now(),
        });
        next.phase = repairPhase;
      }),
    );
  });
}

function remoteRepairPhase(projection) {
  if (
    projection.status === "CHANGES_REQUIRED" &&
    projection.blocking_reason === "CHANGES_REQUIRED"
  ) {
    return "ADDRESS_REMOTE_FINDINGS";
  }
  if (projection.status === "CHECKS_FAILED") {
    return "ADDRESS_CHECK_FAILURE";
  }
  if (projection.status === "PR_UPDATE_REQUIRED") {
    return "UPDATE_FROM_BASE";
  }
  return null;
}

/**
 * Where each pause resumes, when the implied repair phase does not already
 * decide it. A pause must never return to WAIT_PUBLICATION when its remedy is
 * a new commit: that phase cannot record a head, so resume and advance would
 * re-derive the identical stop forever.
 *
 * `SEMANTIC_CONFLICT` is cleared by merging the fresh base cleanly and
 * committing. An invalidated publication is terminal, so the only remedy
 * inside the workflow is a new head and a new publication; if the pull request
 * itself is gone, the operator cancels instead. `GITHUB_REVIEW_AMBIGUOUS` is
 * the one case whose remedy really is external — an acknowledgement and a
 * fresh observation — so it returns to the wait.
 */
const REMOTE_PAUSE_RESUME_PHASES = Object.freeze({
  SEMANTIC_CONFLICT: "UPDATE_FROM_BASE",
  PUBLICATION_INVALIDATED: "IMPLEMENTING",
  GITHUB_REVIEW_AMBIGUOUS: "WAIT_PUBLICATION",
});

function remotePauseReason(projection) {
  if (projection.status === "GITHUB_REVIEW_UNKNOWN") {
    return "GITHUB_REVIEW_AMBIGUOUS";
  }
  if (projection.status === "PR_CONFLICTING") {
    return "SEMANTIC_CONFLICT";
  }
  if (["INVALIDATED", "CLOSED", "MERGED"].includes(projection.status)) {
    return "PUBLICATION_INVALIDATED";
  }
  return null;
}

export async function pauseAutonomousWorkflow(
  storeRoot,
  workflowId,
  expectedRevision,
  { reasonCode, blockedAction, evidence },
) {
  const allowedReasons = new Set([
    "TASK_ORCHESTRATION_UNAVAILABLE",
    "EXTERNAL_ACTION_INDETERMINATE",
    "AUTHORIZATION_REQUIRED",
    "PERMISSION_REQUIRED",
    "NO_PROGRESS",
    // Remote-loop judgements the server cannot derive: whether a failing check
    // is actionable at all, and whether merging the fresh base produced a
    // semantic conflict or would need a history rewrite.
    "REQUIRED_CHECK_UNACTIONABLE",
    "SEMANTIC_CONFLICT",
    "HISTORY_REWRITE_REQUIRED",
  ]);
  if (!allowedReasons.has(reasonCode)) {
    throw new TypeError("unsupported autonomous workflow pause reason");
  }
  assertString(blockedAction, "blocked_action", { max: 4096 });
  assertString(evidence, "evidence");
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    return publicWorkflow(
      await saveActionMutation(
        paths,
        workflow,
        "WORKFLOW_PAUSED",
        async (next) => {
          const resumePhase = next.phase;
          next.status = "PAUSED";
          next.phase = "PAUSED_HUMAN";
          next.pause = {
            reason_code: reasonCode,
            blocked_action: blockedAction,
            evidence,
            resume_phase: resumePhase,
            review_id: next.current_review?.review_id ?? null,
            action_id: next.active_action?.action_id ?? null,
            paused_at: now(),
          };
        },
      ),
    );
  });
}

export async function resumeAutonomousWorkflow(
  storeRoot,
  workflowId,
  expectedRevision,
  { operatorLabel, rationale },
) {
  assertString(operatorLabel, "operator_label", { max: 1024 });
  assertString(rationale, "rationale");
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    if (workflow.status !== "PAUSED") {
      fail(
        "WORKFLOW_STATE_INVALID",
        `cannot resume a ${workflow.status} workflow`,
      );
    }
    if (workflow.pause?.reason_code === "LOCAL_REVIEW_HUMAN_REQUIRED") {
      fail(
        "WORKFLOW_RESUME_INVALID",
        "human-required local review must use human arbitration",
      );
    }
    // A history rewrite is the one remedy this workflow structurally cannot
    // accept: every recorded head must be a descendant of the last, so a
    // rewritten head is rejected however the workflow resumes. Say so instead
    // of resuming into a phase that will re-derive the same stop.
    if (workflow.pause?.reason_code === "HISTORY_REWRITE_REQUIRED") {
      fail(
        "WORKFLOW_RESUME_INVALID",
        "a required history rewrite cannot be resumed: every workflow head must descend from the last, so this workflow must be cancelled and the work restarted",
      );
    }
    const resumedPhase = workflow.pause?.resume_phase;
    if (
      typeof resumedPhase !== "string" ||
      resumedPhase.length === 0 ||
      ["PAUSED_HUMAN", "CANCELLED"].includes(resumedPhase)
    ) {
      fail(
        "WORKFLOW_RESUME_INVALID",
        "paused workflow does not contain a valid resume phase",
      );
    }
    const pauseReasonCode = workflow.pause.reason_code;
    return publicWorkflow(
      await saveActionMutation(
        paths,
        workflow,
        "WORKFLOW_RESUMED",
        async (next) => {
          next.status = "ACTIVE";
          next.phase = resumedPhase;
          next.pause = null;
          if (next.active_action != null) {
            const statusOffset = {
              PLANNED: 1,
              EXECUTING: 2,
              OBSERVED: 3,
            }[next.active_action.status];
            next.active_action.revision_offset =
              next.revision +
              1 -
              next.active_action.planned_revision -
              statusOffset;
          }
        },
        {
          operator_label: operatorLabel,
          pause_reason_code: pauseReasonCode,
          rationale,
          resumed_phase: resumedPhase,
        },
      ),
    );
  });
}

export async function cancelAutonomousWorkflow(
  storeRoot,
  workflowId,
  expectedRevision,
  { operatorLabel, rationale },
) {
  assertString(operatorLabel, "operator_label", { max: 1024 });
  assertString(rationale, "rationale");
  assertCanonicalStringCapacity(
    rationale,
    "rationale",
    MAX_CANCELLATION_RATIONALE_BYTES,
  );
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    if (!["ACTIVE", "PAUSED"].includes(workflow.status)) {
      fail(
        "WORKFLOW_STATE_INVALID",
        `cannot cancel a ${workflow.status} workflow`,
      );
    }
    return publicWorkflow(
      await saveActionMutation(
        paths,
        workflow,
        "WORKFLOW_CANCELLED",
        async (next) => {
          next.status = "CANCELLED";
          next.phase = "CANCELLED";
          next.pause = null;
          next.cancellation = {
            operator_label: operatorLabel,
            rationale,
            cancelled_at: now(),
          };
        },
      ),
    );
  });
}

export async function releaseWorkflowClaims(
  storeRoot,
  workflowId,
  expectedRevision,
  { operatorLabel, rationale, reconciledClaims },
) {
  assertString(operatorLabel, "operator_label", { max: 1024 });
  assertString(rationale, "rationale");
  assertCanonicalStringCapacity(
    rationale,
    "rationale",
    MAX_CANCELLATION_RATIONALE_BYTES,
  );
  if (!Array.isArray(reconciledClaims)) {
    throw new TypeError("reconciled_claims must be an array");
  }
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    if (workflow.status !== "CANCELLED") {
      fail(
        "WORKFLOW_STATE_INVALID",
        "claims may be released only after explicit cancellation",
      );
    }
    const activeClaims = workflow.claims.filter(
      (entry) => entry.disposition === "ACTIVE",
    );
    if (activeClaims.length === 0) {
      fail(
        "WORKFLOW_CLAIMS_ALREADY_RELEASED",
        "workflow has no active claims to release",
      );
    }
    const evidenceByDigest = new Map(
      reconciledClaims.map((entry) => [
        `${entry.kind}:${entry.canonical_key_sha256}`,
        entry,
      ]),
    );
    if (
      reconciledClaims.length !== activeClaims.length ||
      evidenceByDigest.size !== activeClaims.length ||
      activeClaims.some((entry) => {
        const evidence = evidenceByDigest.get(
          `${entry.kind}:${entry.canonical_key_sha256}`,
        );
        if (
          evidence == null ||
          evidence.workflow_revision !== expectedRevision ||
          canonicalJson(evidence.target) !== canonicalJson(entry.target)
        ) {
          return true;
        }
        // A branch or head ref must be proven absent. A GitHub pull request
        // can never be deleted, so its claim is released by proving the
        // exact pull request is no longer open.
        if (entry.kind === "PULL_REQUEST") {
          if (evidence.present !== true || evidence.open !== false) {
            return true;
          }
        } else if (evidence.present !== false || "open" in evidence) {
          return true;
        }
        try {
          assertTimestamp(evidence.observed_at, "observed_at");
        } catch {
          return true;
        }
        const observedAt = Date.parse(evidence.observed_at);
        const cancelledAt = Date.parse(workflow.cancellation.cancelled_at);
        const currentTime = Date.now();
        return (
          observedAt < cancelledAt ||
          currentTime - observedAt > MAX_RECONCILIATION_AGE_MS ||
          observedAt - currentTime > MAX_FUTURE_CLOCK_SKEW_MS ||
          sha256(canonicalJson(evidence.target)) !==
            entry.canonical_key_sha256
        );
      })
    ) {
      fail(
        "WORKFLOW_RELEASE_EVIDENCE_INVALID",
        "reconciliation must cover every active claim and prove it absent",
      );
    }
    const releaseAt = now();
    // The release is an audited transition: claims and release evidence are
    // part of the audited state, so a ledger claiming released ownership
    // without this committed event fails the audit binding.
    const next = await saveActionMutation(
      paths,
      workflow,
      "WORKFLOW_CLAIMS_RELEASED",
      async (draft) => {
        for (const entry of draft.claims) {
          if (entry.disposition === "ACTIVE") {
            entry.disposition = "RELEASED";
            entry.released_at = releaseAt;
          }
        }
        draft.claim_release = {
          operator_label: operatorLabel,
          rationale,
          released_at: releaseAt,
          reconciliation: activeClaims.map((entry) => {
            const evidence = evidenceByDigest.get(
              `${entry.kind}:${entry.canonical_key_sha256}`,
            );
            return {
              kind: entry.kind,
              canonical_key_sha256: entry.canonical_key_sha256,
              target: structuredClone(entry.target),
              workflow_revision: evidence.workflow_revision,
              present: evidence.present,
              ...(entry.kind === "PULL_REQUEST" ? { open: false } : {}),
              observed_at: evidence.observed_at,
            };
          }),
        };
      },
    );
    return publicWorkflow(next);
  });
}
