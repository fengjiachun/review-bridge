import assert from "node:assert/strict";
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
  const client = new Client({ name: "review-bridge-test", version: "0.4.3" });
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
    "acknowledge_codex_review_ambiguity",
    "authorize_remote_publication",
    "export_human_arbitration",
    "finalize_local_gate",
    "finalize_publication_gate",
    "get_publication",
    "get_publication_summary",
    "get_review",
    "get_review_summary",
    "list_reviews",
    "prepare_rereview",
    "prepare_review",
    "record_codex_review_request",
    "record_github_snapshot",
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
      ["CLAUDE_DESKTOP", "CODEX_TASK"],
    );
    assert.ok(prepare.inputSchema.required.includes("reviewer_provider"));

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

    const reviewerTools = await reviewer.listTools();
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
  try {
    const codexPending = await codex.callTool({
      name: "list_pending_reviews",
      arguments: {},
    });
    const claudePending = await claude.callTool({
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
  } finally {
    await Promise.all([codex.close(), claude.close()]);
  }
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
