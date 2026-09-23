import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startLocalReviewer } from "../src/local-reviewer.mjs";
import { discoverReviewerOptions, queryCodexModels } from "../src/reviewer-options.mjs";
import { loadReview, prepareRereview, submitInitialReview, submitResolutions } from "../src/core.mjs";

process.env.REVIEW_BRIDGE_CODEX_COMMAND = path.resolve("test/fixtures/codex-runtime.mjs");
const call = async (client, name, args) => {
  const response = await client.callTool({ name, arguments: args });
  const value = JSON.parse(response.content[0].text);
  if (response.isError) throw new Error(value.error);
  return value;
};
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "reviewer-choice-"));
  const repository = path.join(root, "repo");
  const store = path.join(root, "store");
  const catalogFile = path.join(root, "catalog.json");
  await fsp.mkdir(repository);
  await fsp.writeFile(catalogFile, "{}");
  process.env.RB_TEST_CATALOG = catalogFile;
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await fsp.writeFile(path.join(repository, "file.txt"), "before\n");
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "file.txt"), "after\n");
  const connect = async () => {
    const client = new Client({ name: "claude-author-fixture", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("src/server.mjs"), "--role", "author"], env: { ...process.env, REVIEW_BRIDGE_HOME: store }, stderr: "pipe" }));
    t.after(() => client.close()); return client;
  };
  t.after(async () => { delete process.env.RB_TEST_CATALOG; await fsp.rm(root, { recursive: true, force: true }); });
  const client = await connect();
  const review = await call(client, "prepare_review", { repository_path: repository, base_ref: base, requirement: "Change content", implementation_scope: "file.txt", reviewer_provider: "CODEX_TASK" });
  return { root, repository, store, catalogFile, client, review, connect };
}

test("author MCP discovers pages, separates selection from launch, persists explicit parameters and reports limitations", async (t) => {
  const { client, review, repository, store, catalogFile, connect } = await fixture(t);
  const options = await call(client, "discover_reviewer_options", { repository_path: repository, reviewer_provider: "CODEX_TASK" });
  assert.deepEqual(options.models.map(m => m.model), ["review-model", "second-model"]);
  assert.match(options.freshness, /not a forced network refresh/);
  assert.equal(options.selection_required, true);
  await assert.rejects(fsp.access(path.join(store, "codex-runtime", "executed.json")));
  await assert.rejects(call(client, "launch_local_reviewer", { review_id: review.id, expected_state_version: review.state_version }), /selection required/);
  await assert.rejects(call(client, "select_reviewer_configuration", { review_id: review.id, expected_state_version: review.state_version, ...options.suggested, reasoning_effort: "invented" }), /unavailable/);
  const selected = await call(client, "select_reviewer_configuration", { review_id: review.id, expected_state_version: review.state_version, ...options.suggested, model: "second-model", reasoning_effort: "medium" });
  assert.equal(selected.reviewer_configuration.observed.status, "unavailable");
  const resumedClient = await connect();
  const suggested = await call(resumedClient, "discover_reviewer_options", { repository_path: repository, reviewer_provider: "CODEX_TASK" });
  assert.equal(suggested.suggested.model, "second-model");
  await fsp.writeFile(catalogFile, JSON.stringify({ failure: true }));
  await assert.rejects(call(client, "launch_local_reviewer", { review_id: review.id, expected_state_version: selected.state_version }), /catalog unavailable/);
  await fsp.writeFile(catalogFile, JSON.stringify({ efforts: ["high"] }));
  await assert.rejects(call(client, "launch_local_reviewer", { review_id: review.id, expected_state_version: selected.state_version }), /selection unavailable/);
  await fsp.writeFile(catalogFile, JSON.stringify({ account: "changed" }));
  await assert.rejects(call(client, "launch_local_reviewer", { review_id: review.id, expected_state_version: selected.state_version }), /environment changed/);
  await fsp.writeFile(catalogFile, JSON.stringify({ delay: 400 }));
  const launched = await call(resumedClient, "launch_local_reviewer", { review_id: review.id, expected_state_version: selected.state_version });
  await assert.rejects(call(client, "launch_local_reviewer", { review_id: review.id, expected_state_version: launched.state_version }), /concurrent replacement/);
  const exitFile = path.join(launched.reviewer_dispatch.attempt_root, "exit.json");
  for (let i = 0; i < 100; i++) { try { await fsp.access(exitFile); break; } catch { await new Promise(r => setTimeout(r, 30)); } }
  assert.equal(JSON.parse(await fsp.readFile(exitFile)).code, 0);
  const executed = JSON.parse(await fsp.readFile(path.join(store, "codex-runtime", "executed.json")));
  assert.equal(executed.args[executed.args.indexOf("--model") + 1], "second-model");
  assert.ok(executed.args.includes('model_reasoning_effort="medium"'));
  assert.ok(executed.args.includes('memories.use_memories=false'));
  assert.ok(executed.args.includes('mcp_servers.review-bridge-reviewer.enabled=true'));
  assert.ok(executed.args.includes('mcp_servers.review-bridge-author.enabled=false'));
  assert.ok(executed.args.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(executed.stdin, "");
  assert.equal((await loadReview(store, review.id)).status, "WAITING_FOR_REVIEW");
  const other = await call(client, "discover_reviewer_options", { repository_path: repository, reviewer_provider: "CLAUDE_DESKTOP" });
  assert.equal(other.available, false); assert.deepEqual(other.models, []);
});

test("rereview retains selection and allows a new choice without rewriting the first round", async (t) => {
  const { client, review, repository, store } = await fixture(t);
  const options = await discoverReviewerOptions(store, repository, "CODEX_TASK");
  await call(client, "select_reviewer_configuration", { review_id: review.id, expected_state_version: review.state_version, ...options.suggested });
  await submitInitialReview(store, review.id, [{ severity: "major", file: "file.txt", line: 1, title: "Content", explanation: "Content needs correction", recommendation: "Fix content" }], "CODEX_TASK");
  const findings = (await loadReview(store, review.id)).findings;
  await submitResolutions(store, review.id, [{ finding_id: findings[0].id, disposition: "fixed", rationale: "Corrected", evidence: "file.txt" }]);
  const roundTwo = await prepareRereview(store, review.id);
  assert.deepEqual(roundTwo.reviewer_configuration.requested, options.suggested);
  const changed = await call(client, "select_reviewer_configuration", { review_id: review.id, expected_state_version: roundTwo.state_version, ...options.suggested, model: "second-model" });
  assert.equal(changed.rounds[0].reviewer_configuration.requested.model, "review-model");
  assert.equal(changed.rounds[1].reviewer_configuration.requested.model, "second-model");
});

test("discovery process failure is explicit and bounded", async () => {
  await assert.rejects(queryCodexModels({ command: "/does-not-exist/codex", cwd: os.tmpdir() }), /ENOENT/);
});


test("a failed executable spawn cannot produce a started-process receipt", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "reviewer-spawn-failure-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  await assert.rejects(startLocalReviewer({ command: "/does-not-exist/codex", cwd: directory }, [], directory), /Reviewer failed to start/);
  await assert.rejects(fsp.access(path.join(directory, "started.json")));
  assert.match(JSON.parse(await fsp.readFile(path.join(directory, "exit.json"))).error, /ENOENT/);
});
