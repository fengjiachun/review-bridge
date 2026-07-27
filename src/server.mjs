#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  defaultStoreRoot,
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
  getPublication,
  getPublicationSummary,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
  verifyPublicationGate,
} from "./publication.mjs";

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
    "usage: node server.mjs --role author|reviewer [--reviewer-provider CLAUDE_DESKTOP|CODEX_TASK]",
  );
  process.exit(2);
}
const reviewerProvider =
  role === "reviewer" ? parseOption(argv, "reviewer-provider") : null;
if (role === "reviewer" && !REVIEWER_PROVIDERS.includes(reviewerProvider)) {
  console.error(
    "reviewer role requires --reviewer-provider CLAUDE_DESKTOP|CODEX_TASK",
  );
  process.exit(2);
}

const storeRoot = defaultStoreRoot();
const server = new McpServer(
  {
    name: `review-bridge-${role}`,
    version: "0.4.1",
  },
  {
    instructions:
      role === "author"
        ? "Create immutable local review tasks for an explicitly selected reviewer provider and finalize only CLEAN snapshots, or create an explicit remote-only publication authorization after direct operator approval."
        : `Review immutable Codex snapshots bound to ${reviewerProvider}. For SUCCESSOR tasks, completely read the successor proof and exact delta, inspect relevant source, callers, contracts, and tests, and expand to the full patch whenever risk or uncertainty warrants it. For FULL tasks, completely read the full patch. Submit structured findings only after sufficient context is inspected.`,
  },
);

function response(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
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

if (role === "author") {
  register(
    "prepare_review",
    {
      title: "Prepare local review",
      description:
        "Capture an immutable Git snapshot, requirement, implementation scope, patch, test context, and explicit reviewer provider.",
      inputSchema: {
        repository_path: z.string(),
        base_ref: z.string(),
        requirement: z.string(),
        implementation_scope: z.string(),
        reviewer_provider: z.enum(REVIEWER_PROVIDERS),
        parent_review_id: z.string().optional(),
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
      }),
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
        "Immediately bind the exact summary-provided Codex review request ID and posted issue-comment response to the freshly verified pull-request head, then clear any pre-post snapshot.",
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
        "Validate and persist one normalized GitHub observation covering pull-request identity, policy and checks, Codex evidence, and review threads.",
      inputSchema: {
        review_id: z.string(),
        expected_revision: z.number().int().positive(),
        observation: z.record(z.unknown()),
      },
    },
    (input) =>
      recordGithubSnapshot(storeRoot, input.review_id, {
        expectedRevision: input.expected_revision,
        observation: input.observation,
      }),
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
