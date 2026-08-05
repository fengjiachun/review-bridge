#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  defaultStoreRoot,
  exportHumanArbitration,
  finalizeLocalGate,
  getReview,
  getReviewSummary,
  listReviews,
  openReview,
  prepareRereview,
  prepareReview,
  readReviewArtifact,
  readSnapshotFile,
  REVIEWER_PROVIDERS,
  searchSnapshot,
  submitInitialReview,
  submitRereview,
  submitResolutions,
  waitForReviewState,
} from "./core.mjs";
import {
  acknowledgeCodexReviewAmbiguity,
  authorizeRemotePublication,
  finalizePublicationGate,
  getAutonomousPreReady,
  getPublication,
  getPublicationSummary,
  getThreadResolutionPlan,
  readObservationFile,
  recordAutomaticResolution,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
  verifyPublicationGate,
} from "./publication.mjs";
import {
  advanceLocalWorkflow,
  advanceRemoteWorkflow,
  AUTONOMOUS_CAPABILITIES,
  bindWorkflowPublication,
  bindWorkflowReview,
  cancelAutonomousWorkflow,
  completeWorkflowAction,
  getAutonomousWorkflow,
  getAutonomousWorkflowSummary,
  listAutonomousWorkflows,
  markWorkflowActionExecuting,
  pauseAutonomousWorkflow,
  planCodexTaskDispatch,
  planDraftPullRequest,
  planMarkPullRequestReady,
  planThreadReply,
  planThreadResolution,
  planWorkflowPush,
  recordCodexTaskObservation,
  recordDraftPullRequestObservation,
  recordMarkReadyObservation,
  recordPushObservation,
  recordThreadReplyObservation,
  recordThreadResolutionObservation,
  recordWorkflowHead,
  releaseWorkflowClaims,
  resumeAutonomousWorkflow,
  startAutonomousWorkflow,
} from "./workflow.mjs";

function parseOption(argv, name) {
  const equals = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (equals) {
    return equals.slice(`--${name}=`.length);
  }
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
}

const argv = process.argv.slice(2);
const role = parseOption(argv, "role");
if (!["author", "reviewer"].includes(role)) {
  console.error(
    "usage: node server.mjs --role author|reviewer [--reviewer-provider CLAUDE_DESKTOP|CODEX_TASK|HERMES]",
  );
  process.exit(2);
}
const reviewerProvider =
  role === "reviewer" ? parseOption(argv, "reviewer-provider") : null;
if (role === "reviewer" && !REVIEWER_PROVIDERS.includes(reviewerProvider)) {
  console.error(
    "reviewer role requires --reviewer-provider CLAUDE_DESKTOP|CODEX_TASK|HERMES",
  );
  process.exit(2);
}

const storeRoot = defaultStoreRoot();
const server = new McpServer(
  {
    name: `review-bridge-${role}`,
    version: "0.5.0",
  },
  {
    instructions:
      role === "author"
        ? "Create immutable local review tasks for an explicitly selected reviewer provider and finalize only CLEAN snapshots, or create an explicit remote-only publication authorization after direct operator approval."
        : `Review immutable Codex snapshots bound to ${reviewerProvider}. For SUCCESSOR tasks the reviewed unit is the delta: completely read the successor proof and exact delta, then inspect callers, contracts, and tests with read_snapshot_file and search_snapshot. Read patch.diff only when the delta changes a cross-file contract, touches security or compatibility surfaces, or the proof itself fails to verify; a large delta is not by itself a reason. For FULL tasks read patch.diff through current_snapshot.patch_index, reading each file's byte range and skipping sections whose behavior the review does not depend on. Submit structured findings only after sufficient context is inspected.`,
  },
);

// Compact JSON on purpose: every byte here is a reviewer or author context
// token, and pretty-printing buys nothing a model needs.
function response(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function register(name, config, handler) {
  server.registerTool(name, config, async (input) => {
    try {
      return response(await handler(input));
    } catch (error) {
      const payload = {
        error: error instanceof Error ? error.message : String(error),
      };
      if (typeof error?.code === "string") {
        payload.code = error.code;
      }
      if (
        error?.details != null &&
        typeof error.details === "object" &&
        !Array.isArray(error.details)
      ) {
        payload.details = error.details;
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(payload),
          },
        ],
      };
    }
  });
}

const findingSchema = z.object({
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  title: z.string(),
  explanation: z.string(),
  recommendation: z.string().optional(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
});

const workflowPublicationTargetSchema = z.object({
  base_repository_id: z.number().int().positive(),
  base_owner: z.string(),
  base_repo: z.string(),
  base_branch: z.string(),
  head_repository_id: z.number().int().positive(),
  head_owner: z.string(),
  head_repo: z.string(),
  head_branch: z.string(),
  push_remote: z.string(),
});

if (role === "author") {
  register(
    "start_autonomous_workflow",
    {
      title: "Start autonomous local workflow",
      description:
        "Create an opt-in workflow ledger at an immutable clean base, bind the exact capability set, and atomically claim the local branch and GitHub head ref.",
      inputSchema: {
        repository_path: z.string(),
        base_ref: z.string(),
        base_sha: z.string(),
        requirement: z.string(),
        implementation_scope: z.string(),
        topic_branch: z.string(),
        operator_label: z.string(),
        capabilities: z.array(z.enum(AUTONOMOUS_CAPABILITIES)),
        publication_target: workflowPublicationTargetSchema,
      },
    },
    (input) =>
      startAutonomousWorkflow(storeRoot, {
        repositoryPath: input.repository_path,
        baseRef: input.base_ref,
        baseSha: input.base_sha,
        requirement: input.requirement,
        implementationScope: input.implementation_scope,
        topicBranch: input.topic_branch,
        operatorLabel: input.operator_label,
        capabilities: input.capabilities,
        publicationTarget: input.publication_target,
      }),
  );

  register(
    "list_autonomous_workflows",
    {
      title: "List autonomous workflows",
      description:
        "List compact autonomous workflow states without advancing them.",
      inputSchema: {
        statuses: z
          .array(z.enum(["ACTIVE", "PAUSED", "CANCELLED"]))
          .optional(),
      },
    },
    (input) =>
      listAutonomousWorkflows(storeRoot, input.statuses ?? null),
  );

  register(
    "get_autonomous_workflow",
    {
      title: "Get autonomous workflow",
      description:
        "Read the complete workflow ledger and reconcile one committed action-audit event when recovery requires it.",
      inputSchema: { workflow_id: z.string() },
    },
    (input) => getAutonomousWorkflow(storeRoot, input.workflow_id),
  );

  register(
    "get_autonomous_workflow_summary",
    {
      title: "Get compact autonomous workflow status",
      description:
        "Read the exact revision, phase, next action, bound head and review, recoverable active-action dispatch, and pause reason.",
      inputSchema: { workflow_id: z.string() },
    },
    (input) => getAutonomousWorkflowSummary(storeRoot, input.workflow_id),
  );

  register(
    "record_workflow_head",
    {
      title: "Record committed workflow head",
      description:
        "Verify the authorized topic branch is clean at an exact descendant commit and append the head attempt.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        head_sha: z.string(),
      },
    },
    (input) =>
      recordWorkflowHead(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.head_sha,
      ),
  );

  register(
    "bind_workflow_review",
    {
      title: "Bind autonomous local review",
      description:
        "Bind one new CODEX_TASK review only when its repository, requirement, scope, base, and head equal the workflow.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        review_id: z.string(),
      },
    },
    (input) =>
      bindWorkflowReview(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.review_id,
      ),
  );

  register(
    "pause_autonomous_workflow",
    {
      title: "Pause autonomous workflow",
      description:
        "Fail closed when task orchestration, action reconciliation, authorization, permission, or progress evidence is unavailable.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        reason_code: z.enum([
          "TASK_ORCHESTRATION_UNAVAILABLE",
          "EXTERNAL_ACTION_INDETERMINATE",
          "AUTHORIZATION_REQUIRED",
          "PERMISSION_REQUIRED",
          "NO_PROGRESS",
        ]),
        blocked_action: z.string(),
        evidence: z.string(),
      },
    },
    (input) =>
      pauseAutonomousWorkflow(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        {
          reasonCode: input.reason_code,
          blockedAction: input.blocked_action,
          evidence: input.evidence,
        },
      ),
  );

  register(
    "resume_autonomous_workflow",
    {
      title: "Resume autonomous workflow",
      description:
        "Resume a transiently paused workflow at its audited prior phase after the blocking condition is cleared.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        operator_label: z.string(),
        rationale: z.string(),
      },
    },
    (input) =>
      resumeAutonomousWorkflow(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        {
          operatorLabel: input.operator_label,
          rationale: input.rationale,
        },
      ),
  );

  register(
    "plan_codex_task_dispatch",
    {
      title: "Plan Codex reviewer task dispatch",
      description:
        "Persist a single CREATE_CODEX_REVIEWER_TASK intent and return its exact opaque marker, task title, and prompt.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        review_id: z.string(),
      },
    },
    (input) =>
      planCodexTaskDispatch(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.review_id,
      ),
  );

  register(
    "plan_workflow_push",
    {
      title: "Plan gated head push",
      description:
        "Persist a single PUSH_TOPIC_BRANCH intent after verifying the clean checked-out HEAD still equals the gated workflow head.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
      },
    },
    (input) =>
      planWorkflowPush(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
      ),
  );

  register(
    "record_push_observation",
    {
      title: "Record push observation",
      description:
        "Reconcile the push from a fresh provider read: the observed remote URL, resolved numeric repository ID, and ref head must prove the authorized repository and the exact pushed workflow head.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        action_id: z.string(),
        remote_ref_sha: z.string(),
        remote_repository_id: z.number().int().positive(),
        remote_url: z.string(),
      },
    },
    (input) =>
      recordPushObservation(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.action_id,
        {
          remoteRefSha: input.remote_ref_sha,
          remoteRepositoryId: input.remote_repository_id,
          remoteUrl: input.remote_url,
        },
      ),
  );

  register(
    "plan_draft_pull_request",
    {
      title: "Plan draft pull request",
      description:
        "Persist a single CREATE_DRAFT_PULL_REQUEST intent pinned to the authenticated creator and return the exact body marker that binds the created pull request.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        creator_actor_id: z.number().int().positive(),
        creator_actor_type: z.enum(["User", "Bot"]),
      },
    },
    (input) =>
      planDraftPullRequest(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        {
          creatorActorId: input.creator_actor_id,
          creatorActorType: input.creator_actor_type,
        },
      ),
  );

  register(
    "record_draft_pull_request_observation",
    {
      title: "Record draft pull request observation",
      description:
        "Reconcile exactly one marker-bound draft pull request whose repository, branches, head, and creator match the authorized target.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        action_id: z.string(),
        matching_pr_numbers: z.array(z.number().int().positive()),
        pr_number: z.number().int().positive(),
        repository_id: z.number().int().positive(),
        head_repository_id: z.number().int().positive(),
        base_branch: z.string(),
        head_branch: z.string(),
        head_sha: z.string(),
        draft: z.boolean(),
        body_marker: z.string(),
        creator_actor_id: z.number().int().positive(),
        creator_actor_type: z.enum(["User", "Bot"]),
        url: z.string(),
      },
    },
    (input) =>
      recordDraftPullRequestObservation(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.action_id,
        {
          matchingPrNumbers: input.matching_pr_numbers,
          prNumber: input.pr_number,
          repositoryId: input.repository_id,
          headRepositoryId: input.head_repository_id,
          baseBranch: input.base_branch,
          headBranch: input.head_branch,
          headSha: input.head_sha,
          draft: input.draft,
          bodyMarker: input.body_marker,
          creatorActorId: input.creator_actor_id,
          creatorActorType: input.creator_actor_type,
          url: input.url,
        },
      ),
  );

  register(
    "mark_workflow_action_executing",
    {
      title: "Mark workflow action executing",
      description:
        "Durably record EXECUTING immediately before the planned external write; a push additionally requires the pinned URL resolved to the authorized repository ID, a thread resolution requires the immediately preceding thread pre-read (thread ID, resolved flag, and -- while unresolved -- the exact comment watermark), and a mark-ready requires the immediately preceding pull-request pre-read (repository, number, both branches, head SHA, and draft flag).",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        action_id: z.string(),
        resolved_repository_id: z.number().int().positive().optional(),
        resolved_url: z.string().optional(),
        thread_id: z.string().optional(),
        is_resolved: z.boolean().optional(),
        thread_watermark: z.string().optional(),
        pr_repository_id: z.number().int().positive().optional(),
        pr_number: z.number().int().positive().optional(),
        base_branch: z.string().optional(),
        head_branch: z.string().optional(),
        head_sha: z.string().optional(),
        is_draft: z.boolean().optional(),
      },
    },
    (input) =>
      markWorkflowActionExecuting(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.action_id,
        input.thread_id != null
          ? {
              thread_id: input.thread_id,
              is_resolved: input.is_resolved,
              ...(input.thread_watermark == null
                ? {}
                : { thread_watermark: input.thread_watermark }),
            }
          : input.pr_number != null
            ? {
                repository_id: input.pr_repository_id,
                pr_number: input.pr_number,
                base_branch: input.base_branch,
                head_branch: input.head_branch,
                head_sha: input.head_sha,
                is_draft: input.is_draft,
              }
            : input.resolved_repository_id == null && input.resolved_url == null
              ? null
              : {
                  resolved_repository_id: input.resolved_repository_id,
                  resolved_url: input.resolved_url,
                },
      ),
  );

  register(
    "plan_mark_pull_request_ready",
    {
      title: "Plan mark pull request ready",
      description:
        "Persist the MARK_PR_READY intent for the workflow-owned pull request. Refuses unless the bound publication's autonomous projection is READY_TO_MARK on this exact head; that refusal changes nothing, so advance the workflow and let it route the new blocker. The clearance is read once more immediately before the call, and a publication that regressed by then refuses there and drops the planned intent -- unless the pre-read found the pull request already out of draft, which holds the intent instead so no repair phase can push onto a pull request that is already visible. There is no second check after that: a controller re-issuing the call after a crash re-reads the projection itself.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
      },
    },
    (input) =>
      planMarkPullRequestReady(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
      ),
  );

  register(
    "record_mark_ready_observation",
    {
      title: "Record mark-ready observation",
      description:
        "Reconcile the pull request after the mark-ready call: the same repository, number, branches, and head, now out of draft. The outcome follows the recorded pre-read, both ways: one that found the pull request draft reconciles MARKED_READY, and one that found it already ready reconciles OBSERVED_ALREADY_READY and claims no mutation.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        action_id: z.string(),
        outcome: z.enum(["MARKED_READY", "OBSERVED_ALREADY_READY"]),
        repository_id: z.number().int().positive(),
        pr_number: z.number().int().positive(),
        base_branch: z.string(),
        head_branch: z.string(),
        head_sha: z.string(),
        is_draft: z.boolean(),
      },
    },
    (input) =>
      recordMarkReadyObservation(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.action_id,
        {
          outcome: input.outcome,
          repositoryId: input.repository_id,
          prNumber: input.pr_number,
          baseBranch: input.base_branch,
          headBranch: input.head_branch,
          headSha: input.head_sha,
          isDraft: input.is_draft,
        },
      ),
  );

  register(
    "get_thread_resolution_plan",
    {
      title: "Get thread resolution plan",
      description:
        "Per-thread eligibility verdicts for the publication's recorded observation: refusal reasons for ineligible threads; addressed-by commits, comment IDs, exact comment watermark, and eligibility digest for eligible ones. Advisory -- every action revalidates.",
      inputSchema: {
        review_id: z.string(),
      },
    },
    (input) => getThreadResolutionPlan(storeRoot, input.review_id),
  );

  register(
    "plan_thread_reply",
    {
      title: "Plan thread reply",
      description:
        "Persist a single REPLY_TO_CODEX_THREAD intent for an eligible finding thread and return the server-composed reply body naming the addressed-by commits with its correlation marker. The posted comment must equal it exactly.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        thread_id: z.string(),
        actor_id: z.number().int().positive(),
        actor_type: z.enum(["User", "Bot"]),
      },
    },
    (input) =>
      planThreadReply(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        {
          threadId: input.thread_id,
          actorId: input.actor_id,
          actorType: input.actor_type,
        },
      ),
  );

  register(
    "record_thread_reply_observation",
    {
      title: "Record thread reply observation",
      description:
        "Reconcile exactly one marker comment in the exact thread by the pinned actor whose body equals the server-issued reply payload.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        action_id: z.string(),
        matching_comment_ids: z.array(z.number().int().positive()),
        comment_id: z.number().int().positive(),
        thread_id: z.string(),
        actor_id: z.number().int().positive(),
        actor_type: z.string(),
        body: z.string(),
      },
    },
    (input) =>
      recordThreadReplyObservation(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.action_id,
        {
          matchingCommentIds: input.matching_comment_ids,
          commentId: input.comment_id,
          threadId: input.thread_id,
          actorId: input.actor_id,
          actorType: input.actor_type,
          body: input.body,
        },
      ),
  );

  register(
    "plan_thread_resolution",
    {
      title: "Plan thread resolution",
      description:
        "Persist a single RESOLVE_REVIEW_THREAD intent for a replied, still-eligible thread, binding the reply-inclusive comment watermark and eligibility digest the resolution must hold.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        thread_id: z.string(),
      },
    },
    (input) =>
      planThreadResolution(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        { threadId: input.thread_id },
      ),
  );

  register(
    "record_thread_resolution_observation",
    {
      title: "Record thread resolution observation",
      description:
        "Record the post-read after the resolve mutation: RESOLVED requires the unchanged watermark and resolvedBy equal to the action's own actor; OBSERVED_PRE_RESOLVED records a thread found already resolved, with no ownership.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        action_id: z.string(),
        outcome: z.enum(["RESOLVED", "OBSERVED_PRE_RESOLVED"]),
        thread_id: z.string(),
        is_resolved: z.boolean(),
        thread_watermark: z.string().optional(),
        resolved_by_id: z.number().int().positive().optional(),
        resolved_by_type: z.string().optional(),
      },
    },
    (input) =>
      recordThreadResolutionObservation(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.action_id,
        {
          outcome: input.outcome,
          threadId: input.thread_id,
          isResolved: input.is_resolved,
          threadWatermark: input.thread_watermark,
          resolvedById: input.resolved_by_id,
          resolvedByType: input.resolved_by_type,
        },
      ),
  );

  register(
    "record_automatic_resolution",
    {
      title: "Record automatic resolution",
      description:
        "Store the server-owned proof that this workflow performed the thread's unresolved-to-resolved transition. Every binding is taken from the named action's own observed evidence, so this stays recordable after a crash; the observation is cleared because the mutation outdated it. Idempotent for the same action.",
      inputSchema: {
        review_id: z.string(),
        expected_revision: z.number().int().positive(),
        workflow_id: z.string(),
        action_id: z.string(),
      },
    },
    (input) =>
      recordAutomaticResolution(
        storeRoot,
        input.review_id,
        {
          expectedRevision: input.expected_revision,
          workflowId: input.workflow_id,
          actionId: input.action_id,
        },
      ),
  );

  register(
    "record_codex_task_observation",
    {
      title: "Record Codex reviewer task observation",
      description:
        "Reconcile exactly one task whose title and prompt equal the server-issued dispatch payload.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        action_id: z.string(),
        matching_task_ids: z.array(z.string()),
        task_id: z.string(),
        title: z.string(),
        prompt: z.string(),
      },
    },
    (input) =>
      recordCodexTaskObservation(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.action_id,
        {
          matchingTaskIds: input.matching_task_ids,
          taskId: input.task_id,
          title: input.title,
          prompt: input.prompt,
        },
      ),
  );

  register(
    "complete_workflow_action",
    {
      title: "Complete observed workflow action",
      description:
        "Complete a uniquely observed action and advance the workflow without performing another provider write.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        action_id: z.string(),
      },
    },
    (input) =>
      completeWorkflowAction(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.action_id,
      ),
  );

  register(
    "advance_local_workflow",
    {
      title: "Advance autonomous local review",
      description:
        "Re-read the bound local-review ledger and advance only the matching two-round CODEX_TASK state or pause for human arbitration.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
      },
    },
    (input) =>
      advanceLocalWorkflow(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
      ),
  );

  register(
    "bind_workflow_publication",
    {
      title: "Bind autonomous publication and wait",
      description:
        "Bind the version-3 publication started for the current gated head and enter the remote wait, recording only which publication revision the workflow awaits.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        review_id: z.string(),
      },
    },
    (input) =>
      bindWorkflowPublication(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        input.review_id,
      ),
  );

  register(
    "advance_remote_workflow",
    {
      title: "Advance autonomous remote wait",
      description:
        "Re-read the bound publication's autonomous projection and take the single transition it implies: a repair phase for a new head, a fail-closed pause, the pre-ready stop, or continued waiting.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
      },
    },
    (input) =>
      advanceRemoteWorkflow(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
      ),
  );

  register(
    "cancel_autonomous_workflow",
    {
      title: "Cancel autonomous workflow",
      description:
        "Explicitly stop future workflow writes while retaining branches, reviews, audit evidence, and ownership claims.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        operator_label: z.string(),
        rationale: z.string(),
      },
    },
    (input) =>
      cancelAutonomousWorkflow(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        {
          operatorLabel: input.operator_label,
          rationale: input.rationale,
        },
      ),
  );

  register(
    "release_workflow_claims",
    {
      title: "Release cancelled workflow claims",
      description:
        "Release every active claim only after exact caller-supplied reconciliation proves each branch and head ref absent and each bound pull request closed.",
      inputSchema: {
        workflow_id: z.string(),
        expected_revision: z.number().int().positive(),
        operator_label: z.string(),
        rationale: z.string(),
        reconciled_claims: z.array(
          z.object({
            kind: z.enum(["LOCAL_BRANCH", "GITHUB_HEAD_REF", "PULL_REQUEST"]),
            canonical_key_sha256: z.string(),
            target: z.record(z.unknown()),
            workflow_revision: z.number().int().positive(),
            present: z.boolean(),
            open: z.boolean().optional(),
            observed_at: z.string(),
          }),
        ),
      },
    },
    (input) =>
      releaseWorkflowClaims(
        storeRoot,
        input.workflow_id,
        input.expected_revision,
        {
          operatorLabel: input.operator_label,
          rationale: input.rationale,
          reconciledClaims: input.reconciled_claims,
        },
      ),
  );

  register(
    "prepare_review",
    {
      title: "Prepare local review",
      description:
        "Capture an immutable Git snapshot, requirement, implementation scope, patch, test context, and explicit reviewer provider. Without parent_review_id the server selects a verifiable successor parent itself and records how it was selected; pass force_full_review to demand a full-patch review.",
      inputSchema: {
        repository_path: z.string(),
        base_ref: z.string(),
        requirement: z.string(),
        implementation_scope: z.string(),
        reviewer_provider: z.enum(REVIEWER_PROVIDERS),
        parent_review_id: z.string().optional(),
        force_full_review: z.boolean().optional(),
      },
    },
    (input) =>
      prepareReview(storeRoot, {
        repositoryPath: input.repository_path,
        baseRef: input.base_ref,
        requirement: input.requirement,
        implementationScope: input.implementation_scope,
        reviewerProvider: input.reviewer_provider,
        parentReviewId: input.parent_review_id ?? null,
        forceFullReview: input.force_full_review === true,
      }),
  );

  register(
    "list_reviews",
    {
      title: "List local reviews",
      description: "List Review Bridge tasks and their current states.",
      inputSchema: {
        statuses: z.array(z.string()).optional(),
      },
    },
    (input) => listReviews(storeRoot, input.statuses ?? null),
  );

  register(
    "get_review",
    {
      title: "Get local review",
      description: "Read findings, author resolutions, decisions, and state.",
      inputSchema: { review_id: z.string() },
    },
    (input) => getReview(storeRoot, input.review_id),
  );

  register(
    "get_review_summary",
    {
      title: "Get compact local review status",
      description:
        "Read current state, next action, snapshot identity, and compact finding counts without returning the full review ledger.",
      inputSchema: { review_id: z.string() },
    },
    (input) => getReviewSummary(storeRoot, input.review_id),
  );

  register(
    "export_human_arbitration",
    {
      title: "Export human arbitration packet",
      description:
        "Read a HUMAN_REQUIRED review at an exact state version and return structured canonical ledger data plus deterministic copyable Markdown without changing review state.",
      inputSchema: {
        review_id: z.string(),
        expected_state_version: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER),
      },
    },
    (input) =>
      exportHumanArbitration(
        storeRoot,
        input.review_id,
        input.expected_state_version,
      ),
  );

  register(
    "wait_for_review_state",
    {
      title: "Wait for local review state change",
      description:
        "Wait 25 seconds by default, configurable up to 30 seconds, for review.json to advance beyond a known state_version. A timeout is expected while a human-paced review is in progress and returns the unchanged compact summary; call this tool again with the same known_state_version until changed is true, or resume when the user confirms the review is complete.",
      inputSchema: {
        review_id: z.string(),
        known_state_version: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER),
        timeout_ms: z.number().int().min(1).max(30_000).optional(),
      },
    },
    (input) =>
      waitForReviewState(
        storeRoot,
        input.review_id,
        input.known_state_version,
        input.timeout_ms ?? 25_000,
      ),
  );

  register(
    "submit_resolutions",
    {
      title: "Submit author resolutions",
      description:
        "Answer every open finding as fixed, rejected with evidence, or human_required.",
      inputSchema: {
        review_id: z.string(),
        resolutions: z.array(
          z.object({
            finding_id: z.string(),
            disposition: z.enum(["fixed", "rejected", "human_required"]),
            rationale: z.string(),
            evidence: z.string().optional(),
          }),
        ),
      },
    },
    (input) =>
      submitResolutions(storeRoot, input.review_id, input.resolutions),
  );

  register(
    "prepare_rereview",
    {
      title: "Prepare local rereview",
      description:
        "Capture the updated code as round two after all findings have author responses.",
      inputSchema: { review_id: z.string() },
    },
    (input) => prepareRereview(storeRoot, input.review_id),
  );

  register(
    "finalize_local_gate",
    {
      title: "Finalize local review gate",
      description:
        "Verify the working tree still matches the CLEAN snapshot and write a local gate attestation.",
      inputSchema: { review_id: z.string() },
    },
    (input) => finalizeLocalGate(storeRoot, input.review_id),
  );

  register(
    "authorize_remote_publication",
    {
      title: "Authorize remote-only publication",
      description:
        "Create an immutable review ID that explicitly skips local review and binds a clean local repository, base, head, operator, and rationale before GitHub-only publication review.",
      inputSchema: {
        repository_path: z.string(),
        base_sha: z.string(),
        head_sha: z.string(),
        acknowledgement: z.literal("LOCAL_REVIEW_SKIPPED"),
        operator_label: z.string(),
        rationale: z.string(),
      },
    },
    (input) =>
      authorizeRemotePublication(storeRoot, {
        repositoryPath: input.repository_path,
        baseSha: input.base_sha,
        headSha: input.head_sha,
        acknowledgement: input.acknowledgement,
        operatorLabel: input.operator_label,
        rationale: input.rationale,
      }),
  );

  register(
    "start_publication",
    {
      title: "Start GitHub publication ledger",
      description:
        "Bind a local review gate or explicit remote-only authorization to one pull request, pinned Codex Bot actor, trigger policy, and fresh complete preexisting Codex baseline.",
      inputSchema: {
        review_id: z.string(),
        repository_id: z.number().int().positive(),
        owner: z.string(),
        repo: z.string(),
        pr_number: z.number().int().positive(),
        base_branch: z.string(),
        head_branch: z.string(),
        codex_actor_id: z.number().int().positive(),
        codex_actor_type: z.literal("Bot"),
        codex_actor_login: z.string(),
        codex_trigger_mode: z.enum([
          "EXPLICIT_ONLY",
          "AUTOMATIC_QUIESCENCE_ACKNOWLEDGED",
        ]),
        operator_label: z.string().optional(),
        rationale: z.string().optional(),
        codex_review_baseline: z.record(z.unknown()),
        workflow_id: z.string().optional(),
        expected_workflow_revision: z.number().int().positive().optional(),
      },
    },
    (input) =>
      startPublication(storeRoot, {
        reviewId: input.review_id,
        repositoryId: input.repository_id,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.pr_number,
        baseBranch: input.base_branch,
        headBranch: input.head_branch,
        codexActorId: input.codex_actor_id,
        codexActorType: input.codex_actor_type,
        codexActorLogin: input.codex_actor_login,
        codexTriggerMode: input.codex_trigger_mode,
        operatorLabel: input.operator_label ?? null,
        rationale: input.rationale ?? null,
        baseline: input.codex_review_baseline,
        workflowId: input.workflow_id ?? null,
        expectedWorkflowRevision: input.expected_workflow_revision ?? null,
      }),
  );

  register(
    "get_autonomous_pre_ready",
    {
      title: "Get autonomous pre-ready projection",
      description:
        "Evaluate every publication invariant in its normal fail-closed order with the draft flag alone ignored, and return the exact normalized blocker set behind the result.",
      inputSchema: { review_id: z.string() },
    },
    (input) => getAutonomousPreReady(storeRoot, input.review_id),
  );

  register(
    "get_publication",
    {
      title: "Get GitHub publication ledger",
      description:
        "Read the current publication revision, derived state, immutable target, and recorded evidence without accessing GitHub.",
      inputSchema: { review_id: z.string() },
    },
    (input) => getPublication(storeRoot, input.review_id),
  );

  register(
    "get_publication_summary",
    {
      title: "Get compact GitHub publication status",
      description:
        "Read the current revision, blocking reason, next action, gate state, and exact ambiguity acknowledgement sets without returning the full publication ledger or accessing GitHub.",
      inputSchema: { review_id: z.string() },
    },
    (input) => getPublicationSummary(storeRoot, input.review_id),
  );

  register(
    "record_codex_review_request",
    {
      title: "Bind posted Codex review request",
      description:
        "Immediately bind the exact summary-provided Codex review body, its request ID when present, and the posted issue-comment response to the freshly verified pull-request head, then clear any pre-post snapshot.",
      inputSchema: {
        review_id: z.string(),
        expected_revision: z.number().int().positive(),
        comment_id: z.number().int().positive(),
        url: z.string(),
        created_at: z.string(),
        requested_head_sha: z.string(),
        request_id: z.string().optional(),
      },
    },
    (input) =>
      recordCodexReviewRequest(storeRoot, input.review_id, {
        expectedRevision: input.expected_revision,
        commentId: input.comment_id,
        url: input.url,
        createdAt: input.created_at,
        requestedHeadSha: input.requested_head_sha,
        requestId: input.request_id ?? null,
      }),
  );

  register(
    "record_github_snapshot",
    {
      title: "Record atomic GitHub publication snapshot",
      description:
        "Validate and persist one normalized GitHub observation covering pull-request identity, policy and checks, Codex evidence, and review threads. Pass observation_path with the collector's --out file; never retype the observation inline.",
      inputSchema: {
        review_id: z.string(),
        expected_revision: z.number().int().positive(),
        observation_path: z.string().optional(),
        observation: z.record(z.unknown()).optional(),
      },
    },
    async (input) => {
      if ((input.observation_path == null) === (input.observation == null)) {
        throw new Error(
          "provide exactly one of observation_path or observation",
        );
      }
      const observation =
        input.observation_path == null
          ? input.observation
          : await readObservationFile(input.observation_path);
      return recordGithubSnapshot(storeRoot, input.review_id, {
        expectedRevision: input.expected_revision,
        observation,
      });
    },
  );

  register(
    "acknowledge_codex_review_ambiguity",
    {
      title: "Acknowledge complete Codex ambiguity set",
      description:
        "Record a direct human NO_FURTHER_RESULTS_EXPECTED decision for the exact complete request and ambiguous-result closure sets.",
      inputSchema: {
        review_id: z.string(),
        expected_revision: z.number().int().positive(),
        head_sha: z.string(),
        request_refs: z.array(
          z.object({
            resource_kind: z.enum([
              "ISSUE_COMMENT",
              "PULL_REQUEST_REVIEW",
              "PULL_REQUEST_REVIEW_COMMENT",
            ]),
            resource_id: z.number().int().positive(),
          }),
        ),
        ambiguous_results: z.array(
          z.object({
            resource_kind: z.enum([
              "ISSUE_COMMENT",
              "PULL_REQUEST_REVIEW",
              "PULL_REQUEST_REVIEW_COMMENT",
            ]),
            result_id: z.number().int().positive(),
          }),
        ),
        acknowledgement: z.literal("NO_FURTHER_RESULTS_EXPECTED"),
        operator_label: z.string(),
        rationale: z.string(),
      },
    },
    (input) =>
      acknowledgeCodexReviewAmbiguity(storeRoot, input.review_id, {
        expectedRevision: input.expected_revision,
        headSha: input.head_sha,
        requestRefs: input.request_refs,
        ambiguousResults: input.ambiguous_results,
        acknowledgement: input.acknowledgement,
        operatorLabel: input.operator_label,
        rationale: input.rationale,
      }),
  );

  register(
    "finalize_publication_gate",
    {
      title: "Finalize GitHub publication gate",
      description:
        "Recompute a fresh MERGE_READY ledger and issue an audited, expiring publication gate without changing the ledger revision.",
      inputSchema: {
        review_id: z.string(),
        expected_revision: z.number().int().positive(),
      },
    },
    (input) =>
      finalizePublicationGate(storeRoot, input.review_id, {
        expectedRevision: input.expected_revision,
      }),
  );

  register(
    "verify_publication_gate",
    {
      title: "Verify GitHub publication gate",
      description:
        "Immediately before merge, cross-check the committed gate, current ledger revision and freshness, then durably audit the verdict.",
      inputSchema: { review_id: z.string() },
    },
    (input) => verifyPublicationGate(storeRoot, input.review_id),
  );
} else {
  register(
    "list_pending_reviews",
    {
      title: "List pending Codex reviews",
      description:
        "List review tasks currently waiting for initial review or rereview.",
      inputSchema: {},
    },
    () =>
      listReviews(storeRoot, [
        "WAITING_FOR_REVIEW",
        "WAITING_FOR_REREVIEW",
      ], reviewerProvider),
  );

  register(
    "open_review",
    {
      title: "Open Codex review task",
      description:
        "Read the requirement, implementation scope, changed files, prior findings, and author responses.",
      inputSchema: { review_id: z.string() },
    },
    (input) => openReview(storeRoot, input.review_id, reviewerProvider),
  );

  register(
    "read_review_artifact",
    {
      title: "Read review artifact",
      description:
        "Read a chunk of a successor delta/proof or the full patch/snapshot manifest.",
      inputSchema: {
        review_id: z.string(),
        round: z.number().int().min(1).max(2),
        artifact: z.enum([
          "successor.diff",
          "successor.json",
          "patch.diff",
          "manifest.json",
        ]),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(200000).optional(),
      },
    },
    (input) =>
      readReviewArtifact(
        storeRoot,
        input.review_id,
        input.round,
        input.artifact,
        input.offset ?? 0,
        input.limit ?? 65536,
        reviewerProvider,
      ),
  );

  register(
    "read_snapshot_file",
    {
      title: "Read immutable snapshot file",
      description:
        "Read a repository file exactly as it existed in the selected review round.",
      inputSchema: {
        review_id: z.string(),
        round: z.number().int().min(1).max(2),
        path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(200000).optional(),
      },
    },
    (input) =>
      readSnapshotFile(
        storeRoot,
        input.review_id,
        input.round,
        input.path,
        input.offset ?? 0,
        input.limit ?? 65536,
        reviewerProvider,
      ),
  );

  register(
    "search_snapshot",
    {
      title: "Search immutable snapshot",
      description:
        "Search text across the reviewed Git tree and captured working-tree overlays.",
      inputSchema: {
        review_id: z.string(),
        round: z.number().int().min(1).max(2),
        pattern: z.string(),
        path_prefix: z.string().optional(),
        max_results: z.number().int().min(1).max(500).optional(),
      },
    },
    (input) =>
      searchSnapshot(
        storeRoot,
        input.review_id,
        input.round,
        input.pattern,
        input.path_prefix ?? null,
        input.max_results ?? 100,
        reviewerProvider,
      ),
  );

  register(
    "submit_review",
    {
      title: "Submit initial review",
      description:
        "Submit structured initial findings. An empty array marks the current snapshot CLEAN.",
      inputSchema: {
        review_id: z.string(),
        findings: z.array(findingSchema),
      },
    },
    (input) =>
      submitInitialReview(
        storeRoot,
        input.review_id,
        input.findings,
        reviewerProvider,
      ),
  );

  register(
    "submit_rereview",
    {
      title: "Submit round-two review",
      description:
        "Decide every prior finding and report any new findings. Any unresolved or new finding after round two escalates to a human.",
      inputSchema: {
        review_id: z.string(),
        decisions: z.array(
          z.object({
            finding_id: z.string(),
            decision: z.enum([
              "resolved",
              "rebuttal_accepted",
              "still_open",
            ]),
            rationale: z.string(),
          }),
        ),
        new_findings: z.array(findingSchema),
      },
    },
    (input) =>
      submitRereview(
        storeRoot,
        input.review_id,
        input.decisions,
        input.new_findings,
        reviewerProvider,
      ),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
