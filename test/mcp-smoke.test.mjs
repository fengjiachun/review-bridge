import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve("src/server.mjs");

async function connectClient(role, store) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--role", role],
    env: { ...process.env, REVIEW_BRIDGE_HOME: store },
    stderr: "pipe",
  });
  const client = new Client({ name: "review-bridge-test", version: "0.2.0" });
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
    "finalize_local_gate",
    "finalize_publication_gate",
    "get_publication",
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
