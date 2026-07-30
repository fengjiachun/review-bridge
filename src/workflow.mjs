import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getReviewSummary, loadReview } from "./core.mjs";
import {
  atomicWriteCanonicalJson,
  atomicWriteFile,
  canonicalJson,
  readSecureFile,
  readSecureJson,
  sha256,
  withStateLock,
} from "./storage.mjs";

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

const WORKFLOW_ID_RE = /^rbwf-[0-9TZ-]+-[a-f0-9]{8}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MAX_CLAIMS_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_EVENT_BYTES = 256 * 1024;
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

function assertWorkflowId(workflowId) {
  if (typeof workflowId !== "string" || !WORKFLOW_ID_RE.test(workflowId)) {
    throw new TypeError("invalid workflow_id");
  }
  return workflowId;
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

function codexTaskActionId(workflow, plannedRevision, reviewId) {
  return `rbwfa-${sha256(
    canonicalJson({
      workflow_id: workflow.workflow_id,
      workflow_revision: plannedRevision,
      kind: "CREATE_CODEX_REVIEWER_TASK",
      review_id: reviewId,
    }),
  ).slice(0, 32)}`;
}

function codexTaskCorrelationMarker(workflow, actionId) {
  return `rbwf-dispatch-${sha256(
    canonicalJson({
      workflow_id: workflow.workflow_id,
      action_id: actionId,
      authorization_sha256:
        workflow.authorization.workflow_authorization_sha256,
    }),
  ).slice(0, 32)}`;
}

function expectedDispatchFor(action) {
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
  if (
    action.kind !== "CREATE_CODEX_REVIEWER_TASK" ||
    !["PLANNED", "EXECUTING", "OBSERVED"].includes(action.status) ||
    action.required_capability !== "CREATE_CODEX_REVIEWER_TASKS" ||
    action.authorization_sha256 !==
      workflow.authorization.workflow_authorization_sha256
  ) {
    fail("WORKFLOW_ACTION_INVALID", "active action contract is invalid");
  }
  assertObject(action.target, "workflow.active_action.target");
  if (
    action.target.review_id !== workflow.current_review?.review_id ||
    action.target.reviewer_provider !== "CODEX_TASK"
  ) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "active action target does not match the current review",
    );
  }
  const expectedActionId = codexTaskActionId(
    workflow,
    action.planned_revision,
    action.target.review_id,
  );
  const expectedMarker = codexTaskCorrelationMarker(
    workflow,
    expectedActionId,
  );
  if (
    action.action_id !== expectedActionId ||
    action.correlation_marker !== expectedMarker
  ) {
    fail("WORKFLOW_ACTION_INVALID", "active action identity is invalid");
  }
  const localClaim = workflow.claims.find(
    (entry) => entry.kind === "LOCAL_BRANCH",
  );
  if (
    localClaim == null ||
    canonicalJson(action.ownership_claim) !==
      canonicalJson({
        kind: localClaim.kind,
        canonical_key_sha256: localClaim.canonical_key_sha256,
      })
  ) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "active action ownership claim is invalid",
    );
  }
  const expectedDispatch = expectedDispatchFor(action);
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
  if (action.executing_at !== null) {
    assertTimestamp(
      action.executing_at,
      "workflow.active_action.executing_at",
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
    (workflow.status === "ACTIVE" &&
      workflow.phase !== "DISPATCH_CODEX_REVIEWER") ||
    workflow.reviewer_task != null
  ) {
    fail(
      "WORKFLOW_ACTION_INVALID",
      "active action is inconsistent with workflow state",
    );
  }
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
  const canonicalPath = await fsp.realpath(path.resolve(repositoryPath));
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

function workflowDirectory(storeRoot, workflowId) {
  assertWorkflowId(workflowId);
  return path.join(storeRoot, "workflows", workflowId);
}

function workflowPaths(storeRoot, workflowId) {
  const directory = workflowDirectory(storeRoot, workflowId);
  return {
    directory,
    workflow: path.join(directory, "workflow.json"),
    auditLog: path.join(directory, "action-audit.jsonl"),
    auditHead: path.join(directory, "action-audit-head.json"),
  };
}

function claimsPath(storeRoot) {
  return path.join(storeRoot, "workflow-claims.json");
}

function createWorkflowId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  return `rbwf-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function authorizationPayload(authorization) {
  const {
    workflow_authorization_sha256: _workflowAuthorizationSha256,
    ...payload
  } = authorization;
  return payload;
}

function authorizationDigest(authorization) {
  return sha256(canonicalJson(authorizationPayload(authorization)));
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
  if (!Array.isArray(workflow.attempts) || !Array.isArray(workflow.claims)) {
    fail("WORKFLOW_STATE_INVALID", "workflow arrays are malformed");
  }
  const claimKeys = new Set();
  for (const entry of workflow.claims) {
    validateClaimEntry(entry, "workflow claim", { requireTarget: true });
    const key = `${entry.kind}:${entry.canonical_key_sha256}`;
    if (claimKeys.has(key)) {
      fail("WORKFLOW_CLAIMS_INVALID", "workflow contains duplicate claims");
    }
    claimKeys.add(key);
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

async function readWorkflowRaw(paths) {
  try {
    const workflow = validateWorkflow(
      await readCanonicalSecureJson(
        paths.workflow,
        MAX_WORKFLOW_BYTES,
        "WORKFLOW_STATE_INVALID",
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

async function writeWorkflow(paths, workflow) {
  validateWorkflow(workflow);
  await atomicWriteCanonicalJson(paths.workflow, workflow);
}

async function loadClaims(storeRoot) {
  try {
    const registry = await readCanonicalSecureJson(
      claimsPath(storeRoot),
      MAX_CLAIMS_BYTES,
      "WORKFLOW_CLAIMS_INVALID",
    );
    if (
      registry?.version !== 1 ||
      !Array.isArray(registry.claims)
    ) {
      fail("WORKFLOW_CLAIMS_INVALID", "workflow claim registry is malformed");
    }
    for (const entry of registry.claims) {
      validateClaimEntry(entry, "workflow claim registry entry");
    }
    const activeClaimKeys = new Set();
    for (const entry of registry.claims.filter(
      (candidate) => candidate.disposition === "ACTIVE",
    )) {
      const key = `${entry.kind}:${entry.canonical_key_sha256}`;
      if (activeClaimKeys.has(key)) {
        fail(
          "WORKFLOW_CLAIMS_INVALID",
          "workflow claim registry has duplicate active ownership",
        );
      }
      activeClaimKeys.add(key);
    }
    const transactions = registry.transactions ?? [];
    if (!Array.isArray(transactions)) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "workflow claim transactions are malformed",
      );
    }
    const transactionIds = new Set();
    for (const transaction of transactions) {
      validateClaimTransaction(transaction);
      if (transactionIds.has(transaction.transaction_id)) {
        fail(
          "WORKFLOW_CLAIMS_INVALID",
          "workflow claim registry has duplicate transactions",
        );
      }
      transactionIds.add(transaction.transaction_id);
    }
    return { ...registry, transactions };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: 1, claims: [], transactions: [] };
    }
    throw error;
  }
}

function validateClaimTransaction(transaction) {
  assertObject(transaction, "workflow claim transaction");
  if (
    typeof transaction.transaction_id !== "string" ||
    !/^rbwfct-[0-9a-f]{32}$/.test(transaction.transaction_id) ||
    !["START", "RELEASE"].includes(transaction.operation) ||
    !["PREPARED", "COMMITTED", "ABORTED"].includes(transaction.state)
  ) {
    fail(
      "WORKFLOW_CLAIMS_INVALID",
      "workflow claim transaction identity is invalid",
    );
  }
  assertWorkflowId(transaction.workflow_id);
  assertPositiveInteger(
    transaction.workflow_revision,
    "workflow claim transaction workflow_revision",
  );
  assertTimestamp(transaction.created_at, "workflow claim transaction created_at");
  if (transaction.completed_at !== null) {
    assertTimestamp(
      transaction.completed_at,
      "workflow claim transaction completed_at",
    );
  }
  if (
    (transaction.state === "PREPARED") !==
    (transaction.completed_at === null)
  ) {
    fail(
      "WORKFLOW_CLAIMS_INVALID",
      "workflow claim transaction completion state is invalid",
    );
  }
  if (!Array.isArray(transaction.claims) || transaction.claims.length === 0) {
    fail(
      "WORKFLOW_CLAIMS_INVALID",
      "workflow claim transaction claims are invalid",
    );
  }
  for (const entry of transaction.claims) {
    assertObject(entry, "workflow claim transaction claim");
    if (
      !["LOCAL_BRANCH", "GITHUB_HEAD_REF", "PULL_REQUEST"].includes(
        entry.kind,
      ) ||
      !DIGEST_RE.test(entry.canonical_key_sha256 ?? "")
    ) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "workflow claim transaction claim is invalid",
      );
    }
  }
}

function claimReferences(claims) {
  return claims.map((entry) => ({
    kind: entry.kind,
    canonical_key_sha256: entry.canonical_key_sha256,
  }));
}

function sameClaimReferences(left, right) {
  return (
    left.length === right.length &&
    left.every((entry) =>
      right.some(
        (candidate) =>
          candidate.kind === entry.kind &&
          candidate.canonical_key_sha256 === entry.canonical_key_sha256,
      ),
    )
  );
}

async function readTransactionWorkflow(storeRoot, transaction) {
  const paths = workflowPaths(storeRoot, transaction.workflow_id);
  try {
    await fsp.stat(paths.workflow);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return readWorkflowRaw(paths);
}

async function recoverClaimTransactions(storeRoot, registry) {
  const next = structuredClone(registry);
  let changed = false;
  for (const transaction of next.transactions) {
    if (transaction.state !== "PREPARED") {
      continue;
    }
    const workflow = await readTransactionWorkflow(storeRoot, transaction);
    if (transaction.operation === "START") {
      if (workflow == null) {
        const unexpected = next.claims.some(
          (entry) => entry.workflow_id === transaction.workflow_id,
        );
        if (unexpected) {
          fail(
            "WORKFLOW_CLAIMS_INVALID",
            "orphaned start transaction already owns registry claims",
          );
        }
        transaction.state = "ABORTED";
        transaction.completed_at = now();
        changed = true;
        continue;
      }
      const workflowClaims = claimReferences(workflow.claims);
      if (
        workflow.revision !== transaction.workflow_revision ||
        workflow.status !== "ACTIVE" ||
        workflow.phase !== "IMPLEMENTING" ||
        !sameClaimReferences(workflowClaims, transaction.claims)
      ) {
        fail(
          "WORKFLOW_CLAIMS_INVALID",
          "prepared start transaction does not match its workflow",
        );
      }
      for (const workflowClaim of workflow.claims) {
        const matching = next.claims.filter(
          (entry) =>
            entry.disposition === "ACTIVE" &&
            entry.kind === workflowClaim.kind &&
            entry.canonical_key_sha256 ===
              workflowClaim.canonical_key_sha256,
        );
        if (
          matching.length > 1 ||
          (matching.length === 1 &&
            (matching[0].workflow_id !== workflow.workflow_id ||
              matching[0].disposition !== "ACTIVE"))
        ) {
          fail(
            "WORKFLOW_OWNERSHIP_CONFLICT",
            `prepared start cannot recover claim ${workflowClaim.kind}`,
          );
        }
        if (matching.length === 0) {
          next.claims.push(registryClaim(workflowClaim));
        }
      }
      transaction.state = "COMMITTED";
      transaction.completed_at = now();
      changed = true;
      continue;
    }

    if (workflow == null) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "prepared release transaction has no workflow",
      );
    }
    if (workflow.status !== "CANCELLED") {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "prepared release transaction workflow is not cancelled",
      );
    }
    const workflowClaims = transaction.claims.map((reference) =>
      workflow.claims.find(
        (entry) =>
          entry.kind === reference.kind &&
          entry.canonical_key_sha256 === reference.canonical_key_sha256,
      ),
    );
    if (workflowClaims.some((entry) => entry == null)) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "prepared release transaction does not match its workflow",
      );
    }
    const dispositions = new Set(
      workflowClaims.map((entry) => entry.disposition),
    );
    if (dispositions.size !== 1) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "prepared release transaction is only partially applied",
      );
    }
    const workflowDisposition = workflowClaims[0].disposition;
    if (!["ACTIVE", "RELEASED"].includes(workflowDisposition)) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "prepared release transaction has an invalid disposition",
      );
    }
    const expectedWorkflowRevision =
      workflowDisposition === "RELEASED"
        ? transaction.workflow_revision + 1
        : transaction.workflow_revision;
    if (workflow.revision !== expectedWorkflowRevision) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "prepared release transaction revision is invalid",
      );
    }
    if (
      workflowDisposition === "RELEASED" &&
      (workflow.claim_release == null ||
        workflow.claim_release.released_at !==
          workflowClaims[0].released_at)
    ) {
      fail(
        "WORKFLOW_CLAIMS_INVALID",
        "prepared release transaction lacks its workflow evidence",
      );
    }
    for (const reference of transaction.claims) {
      const stored = next.claims.find(
        (entry) =>
          entry.workflow_id === transaction.workflow_id &&
          entry.kind === reference.kind &&
          entry.canonical_key_sha256 === reference.canonical_key_sha256,
      );
      if (stored == null) {
        fail(
          "WORKFLOW_CLAIMS_INVALID",
          "prepared release claim is missing from the registry",
        );
      }
      stored.disposition = workflowDisposition;
      stored.released_at =
        workflowDisposition === "RELEASED"
          ? workflowClaims.find(
              (entry) =>
                entry.kind === reference.kind &&
                entry.canonical_key_sha256 ===
                  reference.canonical_key_sha256,
            ).released_at
          : null;
    }
    transaction.state =
      workflowDisposition === "RELEASED" ? "COMMITTED" : "ABORTED";
    transaction.completed_at = now();
    changed = true;
  }
  if (changed) {
    await atomicWriteCanonicalJson(claimsPath(storeRoot), next);
  }
  return next;
}

async function withClaimsLock(storeRoot, operation) {
  return withStateLock(
    {
      directory: storeRoot,
      reviewId: "workflow-claims",
      domain: "claims",
    },
    async () =>
      operation(
        await recoverClaimTransactions(
          storeRoot,
          await loadClaims(storeRoot),
        ),
      ),
  );
}

function validateClaimEntry(entry, name, { requireTarget = false } = {}) {
  assertObject(entry, name);
  assertWorkflowId(entry.workflow_id);
  if (!["LOCAL_BRANCH", "GITHUB_HEAD_REF", "PULL_REQUEST"].includes(entry.kind)) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} kind is invalid`);
  }
  if (!DIGEST_RE.test(entry.canonical_key_sha256 ?? "")) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} digest is invalid`);
  }
  if (requireTarget) {
    assertObject(entry.target, `${name}.target`);
    if (sha256(canonicalJson(entry.target)) !== entry.canonical_key_sha256) {
      fail("WORKFLOW_CLAIMS_INVALID", `${name} target digest is invalid`);
    }
  }
  assertPositiveInteger(entry.created_revision, `${name}.created_revision`);
  if (!["ACTIVE", "RELEASED", "TRANSFERRED"].includes(entry.disposition)) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} disposition is invalid`);
  }
  assertTimestamp(entry.created_at, `${name}.created_at`);
  if (entry.disposition === "ACTIVE" && entry.released_at !== null) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} active claim is released`);
  }
  if (entry.disposition !== "ACTIVE" && entry.released_at === null) {
    fail("WORKFLOW_CLAIMS_INVALID", `${name} released_at is missing`);
  }
  if (entry.released_at !== null) {
    assertTimestamp(entry.released_at, `${name}.released_at`);
  }
}

function requireWorkflowClaimsInRegistry(workflow, registry) {
  for (const expected of workflow.claims) {
    validateClaimEntry(expected, "workflow claim", { requireTarget: true });
    const matching = registry.claims.filter(
      (entry) =>
        entry.workflow_id === workflow.workflow_id &&
        entry.kind === expected.kind &&
        entry.canonical_key_sha256 === expected.canonical_key_sha256,
    );
    if (
      matching.length !== 1 ||
      matching[0].disposition !== expected.disposition ||
      (["ACTIVE", "PAUSED"].includes(workflow.status) &&
        expected.disposition !== "ACTIVE")
    ) {
      fail(
        "WORKFLOW_OWNERSHIP_LOST",
        `workflow does not own claim ${expected.kind} in the recorded disposition`,
        {
          claim_kind: expected.kind,
          canonical_key_sha256: expected.canonical_key_sha256,
        },
      );
    }
  }
}

async function requireWorkflowClaims(storeRoot, workflow) {
  await withClaimsLock(storeRoot, async (registry) => {
    requireWorkflowClaimsInRegistry(workflow, registry);
  });
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

async function appendAuditEvent(
  paths,
  workflow,
  event,
  workflowState,
  metadata = null,
) {
  const session = await readAudit(paths, workflow.workflow_id);
  const unsigned = {
    version: 1,
    workflow_id: workflow.workflow_id,
    sequence: session.head.next_sequence,
    previous_event_sha256: session.head.last_event_sha256,
    event_id: crypto.randomBytes(16).toString("hex"),
    at: now(),
    event,
    ...(metadata == null ? {} : { metadata }),
    workflow_revision: workflowState.revision,
    action_id:
      workflowState.active_action?.action_id ??
      workflow.active_action?.action_id ??
      null,
    workflow_state: {
      revision: workflowState.revision,
      updated_at: workflowState.updated_at,
      status: workflowState.status,
      phase: workflowState.phase,
      active_action: workflowState.active_action,
      reviewer_task: workflowState.reviewer_task,
      current_review: workflowState.current_review,
      progress_fingerprint: workflowState.progress_fingerprint,
      pause: workflowState.pause,
      cancellation: workflowState.cancellation,
    },
  };
  const auditEvent = {
    ...unsigned,
    event_sha256: sha256(canonicalJson(unsigned)),
  };
  const eventBytes = Buffer.from(`${canonicalJson(auditEvent)}\n`);
  if (eventBytes.length > MAX_AUDIT_EVENT_BYTES + 1) {
    fail("WORKFLOW_AUDIT_EVENT_TOO_LARGE", "audit event is too large");
  }
  if (session.head.committed_bytes + eventBytes.length > MAX_AUDIT_BYTES) {
    fail(
      "WORKFLOW_AUDIT_LOG_FULL",
      "audit event would exceed the readable audit log limit",
    );
  }
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
  const head = {
    version: 1,
    workflow_id: workflow.workflow_id,
    committed_bytes: session.head.committed_bytes + eventBytes.length,
    next_sequence: session.head.next_sequence + 1,
    last_event_sha256: auditEvent.event_sha256,
  };
  await atomicWriteCanonicalJson(paths.auditHead, head);
  return { event: auditEvent, head };
}

function requireWorkflowAuditBinding(workflow, audit) {
  const lastState = audit.events.at(-1)?.workflow_state ?? {
    status: null,
    phase: null,
    active_action: null,
    reviewer_task: null,
    pause: null,
    cancellation: null,
  };
  const stopStateMustMatch =
    ["PAUSED", "CANCELLED"].includes(workflow.status) ||
    ["PAUSED", "CANCELLED"].includes(lastState.status);
  if (
    canonicalJson(workflow.active_action) !==
      canonicalJson(lastState.active_action) ||
    canonicalJson(workflow.reviewer_task) !==
      canonicalJson(lastState.reviewer_task) ||
    (stopStateMustMatch &&
      (workflow.status !== lastState.status ||
        workflow.phase !== lastState.phase ||
        canonicalJson(workflow.current_review) !==
          canonicalJson(lastState.current_review) ||
        workflow.progress_fingerprint !== lastState.progress_fingerprint ||
        canonicalJson(workflow.pause) !== canonicalJson(lastState.pause) ||
        canonicalJson(workflow.cancellation) !==
          canonicalJson(lastState.cancellation)))
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
    "active_action",
    "reviewer_task",
    "current_review",
    "progress_fingerprint",
    "pause",
    "cancellation",
  ]) {
    recovered[field] = structuredClone(lastEvent.workflow_state[field]);
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

async function withWorkflowStateLock(storeRoot, workflowId, operation) {
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

async function withWorkflowLock(storeRoot, workflowId, operation) {
  return withWorkflowStateLock(
    storeRoot,
    workflowId,
    async (workflow, paths) => {
      await requireWorkflowClaims(storeRoot, workflow);
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
  const next = structuredClone(workflow);
  await mutate(next);
  next.revision += 1;
  next.updated_at = now();
  await writeWorkflow(paths, next);
  return next;
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
  const appended = await appendAuditEvent(
    paths,
    workflow,
    event,
    next,
    metadata,
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

function claim(kind, key, workflowId) {
  return {
    workflow_id: workflowId,
    kind,
    canonical_key_sha256: sha256(canonicalJson(key)),
    target: structuredClone(key),
    created_revision: 1,
    disposition: "ACTIVE",
    created_at: now(),
    released_at: null,
  };
}

function registryClaim(entry) {
  const { target: _target, ...stored } = entry;
  return stored;
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
  const actions = {
    IMPLEMENTING: "COMMIT_HEAD",
    PREPARE_LOCAL_REVIEW: "PREPARE_LOCAL_REVIEW",
    DISPATCH_CODEX_REVIEWER:
      workflow.active_action == null
        ? "PLAN_CODEX_TASK_DISPATCH"
        : {
            PLANNED: "CREATE_CODEX_REVIEWER_TASK",
            EXECUTING: "RECONCILE_CODEX_REVIEWER_TASK",
            OBSERVED: "COMPLETE_CODEX_TASK_DISPATCH",
          }[workflow.active_action.status] ?? "INSPECT_WORKFLOW",
    WAIT_LOCAL_REVIEW: "WAIT_LOCAL_REVIEW",
    ADDRESS_LOCAL_FINDINGS: "ADDRESS_LOCAL_FINDINGS",
    PREPARE_REREVIEW: "PREPARE_REREVIEW",
    WAIT_LOCAL_REREVIEW: "WAIT_LOCAL_REREVIEW",
    FINALIZE_LOCAL_GATE: "FINALIZE_LOCAL_GATE",
    LOCAL_GATE_PASSED: "PUBLISH_GATED_HEAD",
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
    reviewer_task: null,
    pull_request: null,
    attempts: [],
    claims: workflowClaims,
    active_action: null,
    progress_fingerprint: null,
    pause: null,
    cancellation: null,
    action_audit: {
      next_sequence: 1,
      last_event_sha256: null,
    },
  };

  await fsp.mkdir(storeRoot, { recursive: true, mode: 0o700 });
  return withClaimsLock(
    storeRoot,
    async (registry) => {
      const conflicting = registry.claims.find(
        (existing) =>
          existing.disposition === "ACTIVE" &&
          workflowClaims.some(
            (candidate) =>
              candidate.kind === existing.kind &&
              candidate.canonical_key_sha256 ===
                existing.canonical_key_sha256,
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
      const transaction = {
        transaction_id: `rbwfct-${crypto.randomBytes(16).toString("hex")}`,
        operation: "START",
        state: "PREPARED",
        workflow_id: workflowId,
        workflow_revision: workflow.revision,
        claims: claimReferences(workflowClaims),
        created_at: now(),
        completed_at: null,
      };
      const preparedRegistry = structuredClone(registry);
      preparedRegistry.transactions.push(transaction);
      await atomicWriteCanonicalJson(
        claimsPath(storeRoot),
        preparedRegistry,
      );
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
      const committedRegistry = structuredClone(preparedRegistry);
      committedRegistry.claims.push(
        ...workflowClaims.map((entry) => registryClaim(entry)),
      );
      const committedTransaction = committedRegistry.transactions.find(
        (entry) => entry.transaction_id === transaction.transaction_id,
      );
      committedTransaction.state = "COMMITTED";
      committedTransaction.completed_at = now();
      await atomicWriteCanonicalJson(
        claimsPath(storeRoot),
        committedRegistry,
      );
      return publicWorkflow(workflow);
    },
  );
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
    if (!["IMPLEMENTING", "ADDRESS_LOCAL_FINDINGS"].includes(workflow.phase)) {
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
    return publicWorkflow(
      await saveMutation(paths, workflow, async (next) => {
        const reviewId =
          next.phase === "ADDRESS_LOCAL_FINDINGS"
            ? next.current_review?.review_id ?? null
            : null;
        next.current_head_sha = headSha;
        next.attempts.push({
          number: next.attempts.length + 1,
          head_sha: headSha,
          review_id: reviewId,
          recorded_at: now(),
        });
        if (next.phase === "IMPLEMENTING") {
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
    const [review, summary] = await Promise.all([
      loadReview(storeRoot, reviewId),
      getReviewSummary(storeRoot, reviewId),
    ]);
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
        next.phase = "DISPATCH_CODEX_REVIEWER";
      }),
    );
  });
}

function dispatchFor(workflow, action) {
  validateActiveAction({ ...workflow, active_action: action });
  return structuredClone(action.dispatch);
}

export async function planCodexTaskDispatch(
  storeRoot,
  workflowId,
  expectedRevision,
  reviewId,
) {
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    requireCapability(workflow, "CREATE_CODEX_REVIEWER_TASKS");
    if (
      workflow.phase !== "DISPATCH_CODEX_REVIEWER" ||
      workflow.active_action != null ||
      workflow.current_review?.review_id !== reviewId
    ) {
      fail(
        "WORKFLOW_PHASE_INVALID",
        "Codex task dispatch is not currently plannable",
      );
    }
    const ownershipClaim = workflow.claims.find(
      (entry) =>
        entry.kind === "LOCAL_BRANCH" && entry.disposition === "ACTIVE",
    );
    if (ownershipClaim == null) {
      fail(
        "WORKFLOW_OWNERSHIP_LOST",
        "Codex task dispatch requires the active local branch claim",
      );
    }
    const actionId = codexTaskActionId(
      workflow,
      workflow.revision,
      reviewId,
    );
    const correlationMarker = codexTaskCorrelationMarker(workflow, actionId);
    const action = {
      action_id: actionId,
      kind: "CREATE_CODEX_REVIEWER_TASK",
      status: "PLANNED",
      planned_revision: workflow.revision,
      planned_at: now(),
      executing_at: null,
      observed_at: null,
      completed_at: null,
      required_capability: "CREATE_CODEX_REVIEWER_TASKS",
      authorization_sha256:
        workflow.authorization.workflow_authorization_sha256,
      target: {
        review_id: reviewId,
        reviewer_provider: "CODEX_TASK",
      },
      ownership_claim: {
        kind: ownershipClaim.kind,
        canonical_key_sha256: ownershipClaim.canonical_key_sha256,
      },
      correlation_marker: correlationMarker,
      dispatch: null,
      provider_response: null,
    };
    action.dispatch = expectedDispatchFor(action);
    const next = await saveActionMutation(
      paths,
      workflow,
      "ACTION_PLANNED",
      async (draft) => {
        draft.active_action = action;
      },
    );
    return {
      workflow: publicWorkflow(next),
      action: structuredClone(next.active_action),
      dispatch: dispatchFor(next, next.active_action),
    };
  });
}

export async function markWorkflowActionExecuting(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
) {
  assertString(actionId, "action_id", { max: 1024 });
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    if (
      workflow.active_action?.action_id !== actionId ||
      workflow.active_action.status !== "PLANNED"
    ) {
      fail("WORKFLOW_ACTION_STATE_INVALID", "action must be PLANNED");
    }
    return publicWorkflow(
      await saveActionMutation(
        paths,
        workflow,
        "ACTION_EXECUTING",
        async (next) => {
          next.active_action.status = "EXECUTING";
          next.active_action.executing_at = now();
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
  assertString(actionId, "action_id", { max: 1024 });
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
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    const action = workflow.active_action;
    if (action?.action_id !== actionId || action.status !== "EXECUTING") {
      fail("WORKFLOW_ACTION_STATE_INVALID", "action must be EXECUTING");
    }
    const dispatch = dispatchFor(workflow, action);
    if (title !== dispatch.title || prompt !== dispatch.prompt) {
      fail(
        "WORKFLOW_TASK_MARKER_MISMATCH",
        "task title and prompt must equal the server-issued dispatch payload",
      );
    }
    return publicWorkflow(
      await saveActionMutation(
        paths,
        workflow,
        "ACTION_OBSERVED",
        async (next) => {
          next.active_action.status = "OBSERVED";
          next.active_action.observed_at = now();
          next.active_action.provider_response = {
            task_id: taskId,
            matching_task_ids: [taskId],
            title_sha256: sha256(title),
            prompt_sha256: sha256(prompt),
            observed_at: now(),
          };
        },
      ),
    );
  });
}

export async function completeWorkflowAction(
  storeRoot,
  workflowId,
  expectedRevision,
  actionId,
) {
  assertString(actionId, "action_id", { max: 1024 });
  return withWorkflowLock(storeRoot, workflowId, async (workflow, paths) => {
    requireRevision(workflow, expectedRevision);
    requireActive(workflow);
    const action = workflow.active_action;
    if (action?.action_id !== actionId || action.status !== "OBSERVED") {
      fail("WORKFLOW_ACTION_STATE_INVALID", "action must be OBSERVED");
    }
    if (action.kind !== "CREATE_CODEX_REVIEWER_TASK") {
      fail("WORKFLOW_ACTION_KIND_INVALID", "unsupported workflow action");
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
  });
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
    const [review, summary] = await Promise.all([
      loadReview(storeRoot, reviewId),
      getReviewSummary(storeRoot, reviewId),
    ]);
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
  if (!Array.isArray(reconciledClaims)) {
    throw new TypeError("reconciled_claims must be an array");
  }
  return withWorkflowStateLock(storeRoot, workflowId, async (workflow, paths) => {
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
      evidenceByDigest.size !== activeClaims.length ||
      activeClaims.some((entry) => {
        const evidence = evidenceByDigest.get(
          `${entry.kind}:${entry.canonical_key_sha256}`,
        );
        if (
          evidence == null ||
          evidence.present !== false ||
          evidence.workflow_revision !== expectedRevision ||
          canonicalJson(evidence.target) !== canonicalJson(entry.target)
        ) {
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
    return withClaimsLock(
      storeRoot,
      async (registry) => {
        requireWorkflowClaimsInRegistry(workflow, registry);
        const releaseAt = now();
        const transaction = {
          transaction_id: `rbwfct-${crypto.randomBytes(16).toString("hex")}`,
          operation: "RELEASE",
          state: "PREPARED",
          workflow_id: workflowId,
          workflow_revision: workflow.revision,
          claims: claimReferences(activeClaims),
          created_at: releaseAt,
          completed_at: null,
        };
        const preparedRegistry = structuredClone(registry);
        preparedRegistry.transactions.push(transaction);
        for (const claimEntry of activeClaims) {
          const stored = preparedRegistry.claims.find(
            (entry) =>
              entry.workflow_id === workflowId &&
              entry.kind === claimEntry.kind &&
              entry.canonical_key_sha256 ===
                claimEntry.canonical_key_sha256 &&
              entry.disposition === "ACTIVE",
          );
          if (stored == null) {
            fail(
              "WORKFLOW_CLAIMS_INVALID",
              "active workflow claim is missing from the registry",
            );
          }
          stored.disposition = "RELEASED";
          stored.released_at = releaseAt;
        }
        await atomicWriteCanonicalJson(
          claimsPath(storeRoot),
          preparedRegistry,
        );
        const next = await saveMutation(paths, workflow, async (draft) => {
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
            reconciliation: structuredClone(reconciledClaims),
          };
        });
        const committedRegistry = structuredClone(preparedRegistry);
        const committedTransaction = committedRegistry.transactions.find(
          (entry) => entry.transaction_id === transaction.transaction_id,
        );
        committedTransaction.state = "COMMITTED";
        committedTransaction.completed_at = now();
        await atomicWriteCanonicalJson(
          claimsPath(storeRoot),
          committedRegistry,
        );
        return publicWorkflow(next);
      },
    );
  });
}
