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
  searchSnapshot,
  submitInitialReview,
  submitRereview,
  submitResolutions,
  waitForReviewState,
} from "./core.mjs";

function parseRole(argv) {
  const equals = argv.find((arg) => arg.startsWith("--role="));
  if (equals) {
    return equals.slice("--role=".length);
  }
  const index = argv.indexOf("--role");
  return index >= 0 ? argv[index + 1] : null;
}

const role = parseRole(process.argv.slice(2));
if (!["author", "reviewer"].includes(role)) {
  console.error("usage: node server.mjs --role author|reviewer");
  process.exit(2);
}

const storeRoot = defaultStoreRoot();
const server = new McpServer(
  {
    name: `review-bridge-${role}`,
    version: "0.1.1",
  },
  {
    instructions:
      role === "author"
        ? "Create immutable local review tasks for Claude, answer every finding, and finalize only CLEAN snapshots."
        : "Review immutable Codex snapshots. Read the requirement, scope, patch, and relevant source before submitting structured findings.",
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
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
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
      title: "Prepare Claude review",
      description:
        "Capture an immutable Git snapshot, requirement, implementation scope, patch, and test context for manual Claude Desktop review.",
      inputSchema: {
        repository_path: z.string(),
        base_ref: z.string(),
        requirement: z.string(),
        implementation_scope: z.string(),
      },
    },
    (input) =>
      prepareReview(storeRoot, {
        repositoryPath: input.repository_path,
        baseRef: input.base_ref,
        requirement: input.requirement,
        implementationScope: input.implementation_scope,
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
        "Wait up to 60 seconds for review.json to advance beyond a known updated_at value, then return a compact summary.",
      inputSchema: {
        review_id: z.string(),
        known_updated_at: z.string(),
        timeout_ms: z.number().int().min(1).max(60_000).optional(),
      },
    },
    (input) =>
      waitForReviewState(
        storeRoot,
        input.review_id,
        input.known_updated_at,
        input.timeout_ms ?? 30_000,
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
      title: "Prepare Claude rereview",
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
      ]),
  );

  register(
    "open_review",
    {
      title: "Open Codex review task",
      description:
        "Read the requirement, implementation scope, changed files, prior findings, and author responses.",
      inputSchema: { review_id: z.string() },
    },
    (input) => openReview(storeRoot, input.review_id),
  );

  register(
    "read_review_artifact",
    {
      title: "Read review artifact",
      description: "Read a chunk of the patch or snapshot manifest.",
      inputSchema: {
        review_id: z.string(),
        round: z.number().int().min(1).max(2),
        artifact: z.enum(["patch.diff", "manifest.json"]),
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
      submitInitialReview(storeRoot, input.review_id, input.findings),
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
      ),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
