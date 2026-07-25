import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve("src/server.mjs");

async function listToolNames(role, store) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--role", role],
    env: { ...process.env, REVIEW_BRIDGE_HOME: store },
    stderr: "pipe",
  });
  const client = new Client({ name: "review-bridge-test", version: "0.1.1" });
  await client.connect(transport);
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
    "finalize_local_gate",
    "get_review",
    "list_reviews",
    "prepare_rereview",
    "prepare_review",
    "submit_resolutions",
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
