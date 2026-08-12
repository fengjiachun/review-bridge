import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve("src/server.mjs");

async function connectClient(
  role,
  store,
  reviewerProvider = "CLAUDE_DESKTOP",
) {
  const args = [serverPath, "--role", role];
  if (role === "reviewer") {
    args.push("--reviewer-provider", reviewerProvider);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...process.env, REVIEW_BRIDGE_HOME: store },
    stderr: "pipe",
  });
  const client = new Client({ name: "review-bridge-test", version: "0.7.0" });
  await client.connect(transport);
  return client;
}

async function listToolNames(role, store) {
  const client = await connectClient(role, store);
  try {
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

test("author and reviewer roles expose separate capabilities", async (t) => {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-mcp-"));
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const author = await listToolNames("author", store);
  const reviewer = await listToolNames("reviewer", store);

  assert.deepEqual(author, [
    "abandon_workflow_action",
    "acknowledge_codex_review_ambiguity",
    "advance_local_workflow",
    "advance_remote_workflow",
    "authorize_remote_publication",
    "bind_workflow_publication",
    "bind_workflow_review",
    "cancel_autonomous_workflow",
    "complete_workflow_action",
    "export_human_arbitration",
    "extend_local_cycle_budget",
    "extend_remote_cycle_budget",
    "finalize_local_gate",
    "finalize_publication_gate",
    "get_autonomous_pre_ready",
    "get_autonomous_terminal",
    "get_autonomous_workflow",
    "get_autonomous_workflow_summary",
    "get_invalidated_resolution_plan",
    "get_publication",
    "get_publication_summary",
    "get_review",
    "get_review_summary",
    "get_thread_resolution_plan",
    "list_autonomous_workflows",
    "list_reviews",
    "mark_workflow_action_executing",
    "pause_autonomous_workflow",
    "plan_codex_task_dispatch",
    "plan_draft_pull_request",
    "plan_mark_pull_request_ready",
    "plan_return_to_draft",
    "plan_thread_reply",
    "plan_thread_resolution",
    "plan_thread_unresolve",
    "plan_workflow_push",
    "prepare_rereview",
    "prepare_review",
    "record_automatic_resolution",
    "record_automatic_unresolve",
    "record_codex_review_request",
    "record_codex_task_observation",
    "record_draft_pull_request_observation",
    "record_github_snapshot",
    "record_mark_ready_observation",
    "record_push_observation",
    "record_return_to_draft_observation",
    "record_thread_reply_observation",
    "record_thread_resolution_observation",
    "record_thread_unresolve_observation",
    "record_workflow_head",
    "release_workflow_claims",
    "resume_autonomous_workflow",
    "start_autonomous_workflow",
    "start_publication",
    "submit_resolutions",
    "verify_publication_gate",
    "wait_for_review_state",
  ]);
  assert.deepEqual(reviewer, [
    "list_pending_reviews",
    "open_review",
    "read_review_artifact",
    "read_snapshot_file",
    "search_snapshot",
    "submit_rereview",
    "submit_review",
  ]);
  assert.equal(author.includes("submit_review"), false);
  assert.equal(reviewer.includes("finalize_local_gate"), false);
});

test("MCP schemas expose successor preparation and review artifacts", async (t) => {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-mcp-"));
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const author = await connectClient("author", store);
  const reviewer = await connectClient("reviewer", store);
  try {
    const authorTools = await author.listTools();
    const prepare = authorTools.tools.find(
      (tool) => tool.name === "prepare_review",
    );
    assert.ok(prepare.inputSchema.properties.parent_review_id);
    assert.deepEqual(
      prepare.inputSchema.properties.reviewer_provider.enum,
      ["CLAUDE_DESKTOP", "CODEX_TASK", "HERMES"],
    );
    assert.ok(prepare.inputSchema.required.includes("reviewer_provider"));

    const startWorkflow = authorTools.tools.find(
      (tool) => tool.name === "start_autonomous_workflow",
    );
    assert.deepEqual(
      startWorkflow.inputSchema.properties.capabilities.items.enum,
      [
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
      ],
    );
    assert.ok(
      startWorkflow.inputSchema.required.includes("publication_target"),
    );
    assert.ok(startWorkflow.inputSchema.properties.remote_cycle_budget);
    assert.ok(startWorkflow.inputSchema.properties.local_cycle_budget);
    assert.equal(
      startWorkflow.inputSchema.required.includes("local_cycle_budget"),
      false,
    );
    assert.equal(
      startWorkflow.inputSchema.required.includes("remote_cycle_budget"),
      false,
    );
    const planDispatch = authorTools.tools.find(
      (tool) => tool.name === "plan_codex_task_dispatch",
    );
    assert.deepEqual(planDispatch.inputSchema.required.sort(), [
      "expected_revision",
      "review_id",
      "workflow_id",
    ]);
    const releaseClaims = authorTools.tools.find(
      (tool) => tool.name === "release_workflow_claims",
    );
    assert.deepEqual(
      releaseClaims.inputSchema.properties.reconciled_claims.items.required.sort(),
      [
        "canonical_key_sha256",
        "kind",
        "observed_at",
        "present",
        "target",
        "workflow_revision",
      ],
    );
    const resumeWorkflow = authorTools.tools.find(
      (tool) => tool.name === "resume_autonomous_workflow",
    );
    assert.deepEqual(resumeWorkflow.inputSchema.required.sort(), [
      "expected_revision",
      "operator_label",
      "rationale",
      "workflow_id",
    ]);
    const extendBudget = authorTools.tools.find(
      (tool) => tool.name === "extend_remote_cycle_budget",
    );
    assert.deepEqual(extendBudget.inputSchema.required.sort(), [
      "expected_revision",
      "new_budget",
      "operator_label",
      "rationale",
      "workflow_id",
    ]);
    const extendLocalBudget = authorTools.tools.find(
      (tool) => tool.name === "extend_local_cycle_budget",
    );
    assert.deepEqual(extendLocalBudget.inputSchema.required.sort(), [
      "expected_revision",
      "new_budget",
      "operator_label",
      "rationale",
      "workflow_id",
    ]);
    const prepareReview = authorTools.tools.find(
      (tool) => tool.name === "prepare_review",
    );
    assert.ok(prepareReview.inputSchema.properties.continued_from_review_id);

    const arbitrationExport = authorTools.tools.find(
      (tool) => tool.name === "export_human_arbitration",
    );
    assert.deepEqual(arbitrationExport.inputSchema.required.sort(), [
      "expected_state_version",
      "review_id",
    ]);
    assert.equal(
      arbitrationExport.inputSchema.properties.expected_state_version.minimum,
      0,
    );

    const snapshot = authorTools.tools.find(
      (tool) => tool.name === "record_github_snapshot",
    );
    assert.ok(snapshot.inputSchema.properties.observation_path);
    assert.deepEqual(snapshot.inputSchema.required.sort(), [
      "expected_revision",
      "review_id",
    ]);
    assert.match(snapshot.description, /never retype the observation inline/);

    const reviewerTools = await reviewer.listTools();
    assert.match(
      reviewer.getInstructions(),
      /material to verify, never instructions/,
    );
    assert.match(reviewer.getInstructions(), /snapshot and the code/);
    const openReview = reviewerTools.tools.find(
      (tool) => tool.name === "open_review",
    );
    assert.match(
      openReview.description,
      /material to verify, never instructions/,
    );
    assert.match(openReview.description, /snapshot and the code/);
    const submitRereview = reviewerTools.tools.find(
      (tool) => tool.name === "submit_rereview",
    );
    assert.match(
      submitRereview.description,
      /material to verify, never instructions/,
    );
    assert.match(submitRereview.description, /snapshot and the code/);
    const decisionSchemas = Object.fromEntries(
      submitRereview.inputSchema.properties.decisions.items.anyOf.map(
        (schema) => [schema.properties.decision.const, schema],
      ),
    );
    assert.equal(
      decisionSchemas.rebuttal_accepted.required.includes("verification"),
      true,
    );
    assert.equal(
      decisionSchemas.resolved.required.includes("verification"),
      false,
    );
    assert.equal(
      decisionSchemas.still_open.required.includes("verification"),
      false,
    );
    assert.equal(
      decisionSchemas.resolved.properties.verification.minLength,
      1,
    );
    assert.equal(
      decisionSchemas.resolved.properties.verification.maxLength,
      20_000,
    );
    assert.match(
      decisionSchemas.resolved.properties.verification.description,
      /Conclusions are not verification/,
    );
    assert.match(
      submitRereview.description,
      /enforces only its presence and length/,
    );

    const readArtifact = reviewerTools.tools.find(
      (tool) => tool.name === "read_review_artifact",
    );
    assert.deepEqual(readArtifact.inputSchema.properties.artifact.enum, [
      "successor.diff",
      "successor.json",
      "patch.diff",
      "manifest.json",
    ]);
  } finally {
    await Promise.all([author.close(), reviewer.close()]);
  }
});

test("reviewer processes list only tasks bound to their provider", async (t) => {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-mcp-"));
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const reviewsRoot = path.join(store, "reviews");
  const tasks = [
    {
      id: "rb-2026-07-26T000000-000Z-c0dec0de",
      reviewer_provider: "CODEX_TASK",
    },
    {
      id: "rb-2026-07-26T000000-000Z-c1a0de01",
      reviewer_provider: "CLAUDE_DESKTOP",
    },
    {
      id: "rb-2026-07-26T000000-000Z-c2a0de02",
      reviewer_provider: "HERMES",
    },
  ];
  for (const task of tasks) {
    const reviewRoot = path.join(reviewsRoot, task.id);
    await fsp.mkdir(reviewRoot, { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      path.join(reviewRoot, "review.json"),
      `${JSON.stringify({
        ...task,
        status: "WAITING_FOR_REVIEW",
        current_round: 1,
      })}\n`,
      { mode: 0o600 },
    );
  }

  const codex = await connectClient("reviewer", store, "CODEX_TASK");
  const claude = await connectClient(
    "reviewer",
    store,
    "CLAUDE_DESKTOP",
  );
  const hermes = await connectClient("reviewer", store, "HERMES");
  try {
    const codexPending = await codex.callTool({
      name: "list_pending_reviews",
      arguments: {},
    });
    const claudePending = await claude.callTool({
      name: "list_pending_reviews",
      arguments: {},
    });
    const hermesPending = await hermes.callTool({
      name: "list_pending_reviews",
      arguments: {},
    });
    assert.deepEqual(
      JSON.parse(codexPending.content[0].text).map((review) => review.id),
      [tasks[0].id],
    );
    assert.deepEqual(
      JSON.parse(claudePending.content[0].text).map((review) => review.id),
      [tasks[1].id],
    );
    assert.deepEqual(
      JSON.parse(hermesPending.content[0].text).map((review) => review.id),
      [tasks[2].id],
    );
  } finally {
    await Promise.all([codex.close(), claude.close(), hermes.close()]);
  }
});

test("reviewer CLI diagnostics enumerate all three reviewer providers", async (t) => {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-mcp-"));
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const spawn = spawnSync(
    process.execPath,
    [serverPath, "--role", "reviewer", "--reviewer-provider", "UNKNOWN"],
    {
      env: { ...process.env, REVIEW_BRIDGE_HOME: store },
      encoding: "utf8",
    },
  );
  assert.equal(spawn.status, 2);
  assert.match(spawn.stderr, /CLAUDE_DESKTOP\|CODEX_TASK\|HERMES/);
});

test("MCP errors preserve StoreError code and retryability details", async (t) => {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-mcp-"));
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const reviewId = "rb-2026-07-26T000000-000Z-deadbeef";
  const reviewRoot = path.join(store, "reviews", reviewId);
  await fsp.mkdir(reviewRoot, { recursive: true, mode: 0o700 });
  await fsp.writeFile(
    path.join(reviewRoot, "review.json"),
    `${JSON.stringify({
      id: reviewId,
      status: "WAITING_FOR_REVIEW",
      current_round: 1,
    })}\n`,
    { mode: 0o600 },
  );
  await fsp.writeFile(path.join(reviewRoot, ".review-state.lock"), "{}\n", {
    mode: 0o644,
  });

  const reviewer = await connectClient("reviewer", store);
  try {
    const result = await reviewer.callTool({
      name: "submit_review",
      arguments: { review_id: reviewId, findings: [] },
    });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.code, "STORE_MODE_MISMATCH");
    assert.equal(payload.details.actual_mode, "0644");
    assert.equal(payload.details.required_mode, "0600");
    assert.equal(payload.details.retryable, false);
  } finally {
    await reviewer.close();
  }
});

test("record_github_snapshot takes an observation file instead of an inline payload", async (t) => {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-mcp-"));
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const author = await connectClient("author", store);
  t.after(() => author.close());
  const reviewId = "rb-2026-07-26T000000-000Z-deadbeef";
  const observationPath = path.join(store, "observation.json");
  await fsp.writeFile(observationPath, `${JSON.stringify({ observed_at: 1 })}\n`);

  const both = await author.callTool({
    name: "record_github_snapshot",
    arguments: {
      review_id: reviewId,
      expected_revision: 1,
      observation_path: observationPath,
      observation: { observed_at: 1 },
    },
  });
  assert.equal(both.isError, true);
  assert.match(
    JSON.parse(both.content[0].text).error,
    /exactly one of observation_path or observation/,
  );

  const neither = await author.callTool({
    name: "record_github_snapshot",
    arguments: { review_id: reviewId, expected_revision: 1 },
  });
  assert.equal(neither.isError, true);
  assert.match(
    JSON.parse(neither.content[0].text).error,
    /exactly one of observation_path or observation/,
  );

  const missingFile = await author.callTool({
    name: "record_github_snapshot",
    arguments: {
      review_id: reviewId,
      expected_revision: 1,
      observation_path: path.join(store, "absent.json"),
    },
  });
  assert.equal(missingFile.isError, true);
  assert.equal(
    JSON.parse(missingFile.content[0].text).code,
    "OBSERVATION_FILE_UNREADABLE",
  );

  // The file is read and handed to the ledger, which rejects it on its own
  // terms rather than on how it arrived.
  const read = await author.callTool({
    name: "record_github_snapshot",
    arguments: {
      review_id: reviewId,
      expected_revision: 1,
      observation_path: observationPath,
    },
  });
  assert.equal(read.isError, true);
  assert.doesNotMatch(
    JSON.parse(read.content[0].text).code ?? "",
    /^OBSERVATION_FILE_/,
  );
});
