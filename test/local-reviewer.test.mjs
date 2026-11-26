import { FIXTURE_CODEX, waitForExit } from "./helpers/codex-runtime.mjs";
import { git as runGit } from "./helpers/repository-fixture";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listReviewerModels, queryCodexModels, reviewerRuntime, startLocalReviewer } from "../src/local-reviewer.mjs";
import {
  appendReviewErratum, getReviewSummary, launchLocalReviewer, loadReview, prepareRereview, prepareReview,
  submitInitialReview, submitResolutions,
} from "../src/core.mjs";
import { renderReviewBrief, renderReviewReport } from "../src/report.mjs";
import { buildScorecard } from "../src/scorecard.mjs";

process.env.REVIEW_BRIDGE_CODEX_COMMAND = FIXTURE_CODEX;
const DEFAULT_REQUEST = { reasoning_effort: "high", model_source: "configuration", reasoning_effort_source: "default" };

const call = async (client, name, args) => {
  const response = await client.callTool({ name, arguments: args });
  const value = JSON.parse(response.content[0].text);
  if (response.isError) throw new Error(value.error);
  return value;
};

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "local-reviewer-"));
  const repository = path.join(root, "repo");
  const store = path.join(root, "store");
  await fsp.mkdir(repository);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const git = (...args) => runGit(repository, ...args);
  git("init", "-b", "main");
  await fsp.writeFile(path.join(repository, "file.txt"), "before\n");
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "file.txt"), "after\n");
  return { root, repository, store, base };
}

test("launch leaves the model to the Codex configuration and pins high effort", async (t) => {
  const { root, repository, store, base } = await fixture(t);
  // The server passes its environment to the reviewer it spawns, so the hold
  // file must be configured before the server starts.
  const holdFile = path.join(root, "hold");
  await fsp.writeFile(holdFile, "");
  const client = new Client({ name: "claude-author-fixture", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("src/server.mjs"), "--role", "author"], env: { ...process.env, REVIEW_BRIDGE_HOME: store, RB_TEST_HOLD: holdFile }, stderr: "pipe" }));
  t.after(() => client.close());
  const review = await call(client, "prepare_review", { repository_path: repository, base_ref: base, requirement: "Change content", implementation_scope: "file.txt", reviewer_provider: "CODEX_TASK" });
  assert.equal(review.reviewer_configuration, null);
  const launched = await call(client, "launch_local_reviewer", { review_id: review.id, expected_state_version: review.state_version });
  assert.deepEqual(launched.reviewer_configuration.requested, DEFAULT_REQUEST);
  assert.deepEqual(launched.reviewer_dispatch.requested, DEFAULT_REQUEST);
  await assert.rejects(call(client, "launch_local_reviewer", { review_id: review.id, expected_state_version: launched.state_version }), /concurrent replacement/);
  await fsp.rm(holdFile);
  assert.equal((await waitForExit(launched.reviewer_dispatch.attempt_root)).code, 0);
  assert.equal(launched.action_required, "REVIEWER_INITIAL_REVIEW");
  assert.equal(launched.requirement, undefined);
  const corrected = await call(client, "append_review_erratum", { review_id: review.id, text: "The scope claim is stale." });
  assert.equal(corrected.errata_watermark, 1);
  assert.equal(corrected.requirement, undefined);
  assert.equal(corrected.reviewer_dispatch.exit, undefined);
  const polled = await call(client, "get_review_summary", { review_id: review.id });
  assert.equal(polled.state_version, corrected.state_version);
  assert.equal(polled.reviewer_dispatch.exit.code, 0);
  const executed = JSON.parse(await fsp.readFile(path.join(store, "codex-runtime", "executed.json")));
  assert.ok(!executed.args.includes("--model"));
  assert.ok(!executed.args.some((value) => value.startsWith("model=")));
  assert.ok(executed.args.includes('model_reasoning_effort="high"'));
  assert.ok(executed.args.includes("memories.use_memories=false"));
  assert.ok(executed.args.includes("mcp_servers.review-bridge-reviewer.enabled=true"));
  assert.ok(executed.args.includes("mcp_servers.review-bridge-author.enabled=false"));
  assert.ok(executed.args.includes("sandbox_workspace_write.network_access=false"));
  const instructions = executed.args.find((value) => value.startsWith("developer_instructions="));
  assert.equal(JSON.parse(instructions.slice("developer_instructions=".length)),
    await fsp.readFile("templates/codex-plugin/skills/review-bridge-reviewer/SKILL.md", "utf8"));
  assert.equal(executed.stdin, "");
  assert.equal((await loadReview(store, review.id)).status, "WAITING_FOR_REVIEW");
});

test("a ledger carrying an author-selected model still reads, reports, scores and continues", async (t) => {
  const { repository, store, base } = await fixture(t);
  const review = await prepareReview(store, {
    repositoryPath: repository, baseRef: base, requirement: "Change content",
    implementationScope: "file.txt", reviewerProvider: "CODEX_TASK",
  });
  const legacy = {
    requested: { model: "gpt-6-astra", reasoning_effort: "high", environment_id: "e".repeat(64) },
    observed: { status: "unavailable" },
    validated_at: "2026-11-01T00:00:00.000Z", source: "codex app-server model/list",
    freshness: "runtime_catalog; upstream cache source and age unavailable; not a forced network refresh",
    runtime: { command: "/usr/local/bin/codex", cwd: "/tmp/codex-runtime", host: "fixture", client: "codex/1" },
  };
  const file = path.join(store, "reviews", review.id, "review.json");
  const stored = JSON.parse(await fsp.readFile(file, "utf8"));
  stored.rounds[0].reviewer_configuration = legacy;
  stored.history.push({ at: "2026-11-01T00:00:00.000Z", event: "REVIEWER_CONFIGURATION_SELECTED", round: 1, requested: legacy.requested });
  stored.state_version++;
  await fsp.writeFile(file, JSON.stringify(stored));

  assert.deepEqual((await getReviewSummary(store, review.id)).reviewer_configuration, legacy);
  const legacyRequest = `\`${JSON.stringify(legacy.requested)}\``;
  const legacyBrief = renderReviewBrief(await loadReview(store, review.id));
  assert.ok(legacyBrief.includes(legacyRequest));
  assert.ok(!legacyBrief.includes("model from the Codex configuration"));
  assert.equal((await buildScorecard(store)).corpus.reviews_counted, 1);
  await submitInitialReview(store, review.id, [{ severity: "major", path: "file.txt", line: 1, title: "Content", explanation: "Content needs correction", recommendation: "Fix content" }], "CODEX_TASK");
  const findings = (await loadReview(store, review.id)).findings;
  await submitResolutions(store, review.id, [{ finding_id: findings[0].id, disposition: "fixed", rationale: "Corrected", evidence: "file.txt" }]);
  const roundTwo = await prepareRereview(store, review.id);
  assert.equal(roundTwo.reviewer_configuration, null);
  const launched = await launchLocalReviewer(store, review.id, roundTwo.state_version);
  assert.equal(launched.reviewer_dispatch.marker, null);
  assert.equal((await waitForExit(launched.reviewer_dispatch.attempt_root)).code, 0);

  const continued = await loadReview(store, review.id);
  assert.deepEqual(continued.rounds[0].reviewer_configuration, legacy);
  assert.deepEqual(continued.rounds[1].reviewer_configuration.requested, DEFAULT_REQUEST);
  const full = renderReviewReport(continued);
  assert.ok(full.includes(`- Round 1 reviewer requested: ${legacyRequest};`));
  assert.ok(full.includes(`- Round 2 reviewer requested: \`${JSON.stringify(DEFAULT_REQUEST)}\`, model from the Codex configuration;`));
  assert.ok(renderReviewBrief(continued).includes("model from the Codex configuration"));
  assert.equal((await buildScorecard(store)).corpus.reviews_counted, 1);
});

test("a direct launch on a pending round that holds a selected model follows the Codex configuration", async (t) => {
  const { repository, store, base } = await fixture(t);
  const review = await prepareReview(store, {
    repositoryPath: repository, baseRef: base, requirement: "Change content",
    implementationScope: "file.txt", reviewerProvider: "CODEX_TASK",
  });
  const requested = { model: "gpt-6-astra", reasoning_effort: "medium", environment_id: "e".repeat(64) };
  const file = path.join(store, "reviews", review.id, "review.json");
  const stored = JSON.parse(await fsp.readFile(file, "utf8"));
  stored.rounds[0].reviewer_configuration = { requested, observed: { status: "unavailable" } };
  stored.history.push({ at: "2026-11-01T00:00:00.000Z", event: "REVIEWER_CONFIGURATION_SELECTED", round: 1, requested });
  stored.state_version++;
  await fsp.writeFile(file, JSON.stringify(stored));
  const launched = await launchLocalReviewer(store, review.id, stored.state_version);
  assert.equal((await waitForExit(launched.reviewer_dispatch.attempt_root)).code, 0);
  const executed = JSON.parse(await fsp.readFile(path.join(store, "codex-runtime", "executed.json")));
  assert.ok(!executed.args.includes("--model"));
  assert.ok(executed.args.includes('model_reasoning_effort="high"'));
  const relaunched = await loadReview(store, review.id);
  assert.deepEqual(relaunched.rounds[0].reviewer_configuration.requested, DEFAULT_REQUEST);
  assert.deepEqual(relaunched.history.find((event) => event.event === "REVIEWER_CONFIGURATION_SELECTED").requested, requested);
  // A retry after the confirmed exit keeps the first attempt in history.
  const retried = await launchLocalReviewer(store, review.id, relaunched.state_version);
  assert.equal((await waitForExit(retried.reviewer_dispatch.attempt_root)).code, 0);
  const attempts = (await loadReview(store, review.id)).history.filter((event) => event.event === "REVIEWER_DISPATCH_REQUESTED");
  assert.notEqual(launched.reviewer_dispatch.attempt_root, retried.reviewer_dispatch.attempt_root);
  assert.deepEqual(attempts.map(({ attempt_root, requested }) => ({ attempt_root, requested })), [
    { attempt_root: launched.reviewer_dispatch.attempt_root, requested: DEFAULT_REQUEST },
    { attempt_root: retried.reviewer_dispatch.attempt_root, requested: DEFAULT_REQUEST },
  ]);
  assert.equal((await loadReview(store, review.id)).rounds[0].reviewer_dispatch.attempt_root, retried.reviewer_dispatch.attempt_root);
});

test("the author lists the reviewer models and launches with a chosen model and effort", async (t) => {
  const { repository, store, base } = await fixture(t);
  const client = new Client({ name: "claude-author-fixture", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("src/server.mjs"), "--role", "author"], env: { ...process.env, REVIEW_BRIDGE_HOME: store }, stderr: "pipe" }));
  t.after(() => client.close());
  // The configured model, not the catalog's isDefault entry, and the launcher's
  // high, not the configuration's effort, are the defaults.
  assert.deepEqual(await call(client, "list_reviewer_models", {}), {
    reviewer_provider: "CODEX_TASK", available: true, configured_model: "fixture-luna",
    default_reasoning_effort: { value: "high", source: "launcher default" },
    models: [
      { model: "fixture-sol", display_name: "Fixture Sol", reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { model: "fixture-luna", display_name: "Fixture Luna", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
      { model: "fixture-mini", display_name: "Fixture Mini", reasoning_efforts: ["low", "medium"] },
    ],
  });
  assert.equal((await call(client, "list_reviewer_models", { reviewer_provider: "HERMES" })).available, false);
  const review = await call(client, "prepare_review", { repository_path: repository, base_ref: base, requirement: "Change content", implementation_scope: "file.txt", reviewer_provider: "CODEX_TASK" });
  const launched = await call(client, "launch_local_reviewer", { review_id: review.id, expected_state_version: review.state_version, model: "fixture-sol", reasoning_effort: "ultra" });
  assert.deepEqual(launched.reviewer_configuration.requested, { model: "fixture-sol", reasoning_effort: "ultra", model_source: "selected", reasoning_effort_source: "selected" });
  assert.equal((await waitForExit(launched.reviewer_dispatch.attempt_root)).code, 0);
  const executed = JSON.parse(await fsp.readFile(path.join(store, "codex-runtime", "executed.json")));
  assert.deepEqual(executed.args.slice(executed.args.indexOf("--model"), executed.args.indexOf("--model") + 2), ["--model", "fixture-sol"]);
  assert.ok(executed.args.includes('model_reasoning_effort="ultra"'));
  assert.ok(renderReviewReport(await loadReview(store, review.id)).includes(
    '- Round 1 reviewer requested: `{"model":"fixture-sol","reasoning_effort":"ultra","model_source":"selected","reasoning_effort_source":"selected"}`;'));
});

function setEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

const executedArgs = async (store) => JSON.parse(await fsp.readFile(path.join(store, "codex-runtime", "executed.json"))).args;

test("a chosen model or effort is refused unless listed and supported, and carries to later rounds", async (t) => {
  const { repository, store, base } = await fixture(t);
  const prepare = () => prepareReview(store, {
    repositoryPath: repository, baseRef: base, requirement: "Change content",
    implementationScope: "file.txt", reviewerProvider: "CODEX_TASK",
  });
  const review = await prepare();
  const refusals = [
    [{ model: "fixture-terra" }, /Model fixture-terra is not in Codex's model list/],
    [{ model: "fixture-luna", reasoningEffort: "ultra" }, /fixture-luna does not support reasoning effort ultra; it supports low, medium, high, xhigh, max/],
    [{ reasoningEffort: "ultra" }, /fixture-luna does not support reasoning effort ultra/],
    [{ model: "fixture-mini" }, /fixture-mini does not support reasoning effort high; it supports low, medium/],
  ];
  for (const [selection, message] of refusals) {
    await assert.rejects(launchLocalReviewer(store, review.id, review.state_version, selection), message);
  }
  assert.ok((await listReviewerModels(store, "CODEX_TASK")).models.some((entry) => entry.model === "fixture-sol"));
  setEnv(t, { RB_TEST_MODELS: "fixture-luna" });
  await assert.rejects(launchLocalReviewer(store, review.id, review.state_version, { model: "fixture-sol" }), /Model fixture-sol is not in Codex's model list/);
  delete process.env.RB_TEST_MODELS;
  setEnv(t, { RB_TEST_CONFIG_MODEL: "" });
  await assert.rejects(launchLocalReviewer(store, review.id, review.state_version, { reasoningEffort: "max" }), /configuration names no model/);
  process.env.RB_TEST_CONFIG_MODEL = "fixture-hidden";
  await assert.rejects(launchLocalReviewer(store, review.id, review.state_version, { reasoningEffort: "max" }), /configured model fixture-hidden is not in Codex's model list/);
  delete process.env.RB_TEST_CONFIG_MODEL;
  const untouched = await loadReview(store, review.id);
  assert.equal(untouched.state_version, review.state_version);
  assert.equal(untouched.rounds[0].reviewer_dispatch, undefined);

  // The configured model the effort was checked against is the one launched.
  const effortOnly = { model: "fixture-luna", reasoning_effort: "max", model_source: "configuration", reasoning_effort_source: "selected" };
  const first = await launchLocalReviewer(store, review.id, review.state_version, { reasoningEffort: "max" });
  assert.deepEqual(first.reviewer_configuration.requested, effortOnly);
  assert.equal((await waitForExit(first.reviewer_dispatch.attempt_root)).code, 0);
  const firstArgs = await executedArgs(store);
  assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "fixture-luna");
  await submitInitialReview(store, review.id, [{ severity: "major", path: "file.txt", line: 1, title: "Content", explanation: "Content needs correction", recommendation: "Fix content" }], "CODEX_TASK");
  const [finding] = (await loadReview(store, review.id)).findings;
  await submitResolutions(store, review.id, [{ finding_id: finding.id, disposition: "fixed", rationale: "Corrected", evidence: "file.txt" }]);
  const roundTwo = await prepareRereview(store, review.id);
  // The carried effort is checked again against the model configured now.
  process.env.RB_TEST_CONFIG_MODEL = "fixture-sol";
  const carried = await launchLocalReviewer(store, review.id, roundTwo.state_version);
  assert.deepEqual(carried.reviewer_configuration.requested, { ...effortOnly, model: "fixture-sol" });
  assert.equal((await waitForExit(carried.reviewer_dispatch.attempt_root)).code, 0);
  const carriedArgs = await executedArgs(store);
  assert.equal(carriedArgs[carriedArgs.indexOf("--model") + 1], "fixture-sol");
  delete process.env.RB_TEST_CONFIG_MODEL;
  // Choosing again replaces the whole choice for that launch and those after it.
  const modelOnly = { model: "fixture-sol", reasoning_effort: "high", model_source: "selected", reasoning_effort_source: "default" };
  const chosenAgain = await launchLocalReviewer(store, review.id, carried.state_version, { model: "fixture-sol" });
  assert.deepEqual(chosenAgain.reviewer_configuration.requested, modelOnly);
  assert.equal((await waitForExit(chosenAgain.reviewer_dispatch.attempt_root)).code, 0);
  const retried = await launchLocalReviewer(store, review.id, chosenAgain.state_version);
  assert.deepEqual(retried.reviewer_configuration.requested, modelOnly);
  assert.equal((await waitForExit(retried.reviewer_dispatch.attempt_root)).code, 0);
  const args = await executedArgs(store);
  assert.equal(args[args.indexOf("--model") + 1], "fixture-sol");
  assert.ok(args.includes('model_reasoning_effort="high"'));

  const fresh = await prepare();
  const defaulted = await launchLocalReviewer(store, fresh.id, fresh.state_version);
  assert.deepEqual(defaulted.reviewer_configuration.requested, DEFAULT_REQUEST);
  assert.equal((await waitForExit(defaulted.reviewer_dispatch.attempt_root)).code, 0);
  const mini = await prepare();
  const supported = await launchLocalReviewer(store, mini.id, mini.state_version, { model: "fixture-mini", reasoningEffort: "medium" });
  assert.deepEqual(supported.reviewer_configuration.requested, { model: "fixture-mini", reasoning_effort: "medium", model_source: "selected", reasoning_effort_source: "selected" });
  assert.equal((await waitForExit(supported.reviewer_dispatch.attempt_root)).code, 0);
});

test("a launch whose review changes while the model listing runs reserves no attempt", async (t) => {
  const { root, repository, store, base } = await fixture(t);
  const review = await prepareReview(store, {
    repositoryPath: repository, baseRef: base, requirement: "Change content",
    implementationScope: "file.txt", reviewerProvider: "CODEX_TASK",
  });
  const hold = path.join(root, "list-hold");
  await fsp.writeFile(hold, "");
  setEnv(t, { RB_TEST_LIST_HOLD: hold });
  const held = path.join((await reviewerRuntime(store)).cwd, "list-held");
  const launching = launchLocalReviewer(store, review.id, review.state_version, { model: "fixture-sol" });
  for (let i = 0; i < 250; i++) {
    try { await fsp.access(held); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  await fsp.access(held);
  const corrected = await appendReviewErratum(store, review.id, "The scope claim is stale.");
  assert.ok(corrected.state_version > review.state_version);
  await fsp.rm(hold);
  await assert.rejects(launching, /state_version mismatch/);
  const after = await loadReview(store, review.id);
  assert.equal(after.rounds[0].reviewer_dispatch, undefined);
  assert.ok(!after.history.some((event) => event.event === "REVIEWER_DISPATCH_REQUESTED"));
});

test("a failed model listing explains itself, refuses a choice, and leaves default launches alone", async (t) => {
  const { repository, store, base } = await fixture(t);
  const review = await prepareReview(store, {
    repositoryPath: repository, baseRef: base, requirement: "Change content",
    implementationScope: "file.txt", reviewerProvider: "CODEX_TASK",
  });
  const failures = [
    ["exit", /process exited \(code 3\): error: unknown configuration key/],
    ["repeat-cursor", /Invalid Codex model\/list pagination cursor/],
    ["invalid-page", /Invalid Codex model capabilities/],
    ["invalid-config", /Invalid Codex config\/read response/],
    ["array-config", /Invalid Codex config\/read response/],
  ];
  setEnv(t, { RB_TEST_APP_SERVER: "" });
  for (const [mode, message] of failures) {
    process.env.RB_TEST_APP_SERVER = mode;
    await assert.rejects(listReviewerModels(store, "CODEX_TASK"), message);
    await assert.rejects(launchLocalReviewer(store, review.id, review.state_version, { model: "fixture-sol" }), message);
  }
  assert.equal((await loadReview(store, review.id)).rounds[0].reviewer_dispatch, undefined);
  process.env.RB_TEST_APP_SERVER = "exit";
  const holdFile = path.join(store, "..", "exec-hold");
  await fsp.writeFile(holdFile, "");
  setEnv(t, { RB_TEST_HOLD: holdFile });
  const launched = await launchLocalReviewer(store, review.id, review.state_version);
  assert.deepEqual(launched.reviewer_configuration.requested, DEFAULT_REQUEST);
  // A running reviewer or a settled review is refused before Codex is asked for models.
  await assert.rejects(launchLocalReviewer(store, review.id, launched.state_version, { model: "fixture-sol" }), /concurrent replacement/);
  await fsp.rm(holdFile);
  assert.equal((await waitForExit(launched.reviewer_dispatch.attempt_root)).code, 0);
  assert.ok(!(await executedArgs(store)).includes("--model"));
  const settled = await submitInitialReview(store, review.id, [], "CODEX_TASK");
  await assert.rejects(launchLocalReviewer(store, review.id, settled.state_version, { model: "fixture-sol" }), /Review is not pending/);

  process.env.RB_TEST_APP_SERVER = "hang";
  const runtime = await reviewerRuntime(store);
  await assert.rejects(queryCodexModels(runtime, { timeoutMs: 300 }), /timed out/);

  process.env.RB_TEST_APP_SERVER = "stubborn";
  await assert.rejects(queryCodexModels(runtime), /stubborn listing refuses/);
  const pid = Number(await fsp.readFile(path.join(runtime.cwd, "stubborn.pid"), "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 20)); }
    catch (error) { if (error.code !== "ESRCH") throw error; alive = false; }
  }
  assert.equal(alive, false, "the listing process that ignores SIGTERM is still running");
});

test("a malformed model listing reply does not take down the author server", async (t) => {
  const { store } = await fixture(t);
  const client = new Client({ name: "claude-author-fixture", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("src/server.mjs"), "--role", "author"], env: { ...process.env, REVIEW_BRIDGE_HOME: store, RB_TEST_APP_SERVER: "malformed" }, stderr: "pipe" }));
  t.after(() => client.close());
  // Null and array lines precede every reply, and model/list answers with an
  // error whose message cannot be converted to text.
  for (let i = 0; i < 2; i++) {
    await assert.rejects(call(client, "list_reviewer_models", {}), /Codex model listing: invalid error reply/);
  }
});

test("a failed executable spawn cannot produce a started-process receipt", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "reviewer-spawn-failure-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  await assert.rejects(startLocalReviewer({ command: "/does-not-exist/codex", cwd: directory }, [], directory), /Reviewer failed to start/);
  await assert.rejects(fsp.access(path.join(directory, "started.json")));
  assert.match(JSON.parse(await fsp.readFile(path.join(directory, "exit.json"))).error, /ENOENT/);
});

test("runtime lookup skips non-directory PATH entries and a directory named codex, and needs git to start", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "reviewer-path-"));
  const saved = Object.fromEntries(["PATH", "REVIEW_BRIDGE_CODEX_COMMAND", "LC_ALL", "GIT_DIR", "GIT_CEILING_DIRECTORIES"].map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(root, "first", "codex"), { recursive: true });
  await fsp.mkdir(path.join(root, "second"));
  await fsp.writeFile(path.join(root, "second", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  await fsp.writeFile(path.join(root, "not-a-directory"), "");
  const gitDirectory = path.dirname(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim());
  delete process.env.REVIEW_BRIDGE_CODEX_COMMAND;
  const entries = [path.join(root, "not-a-directory"), path.join(root, "first"), path.join(root, "second")];
  process.env.PATH = entries.join(path.delimiter);
  await assert.rejects(reviewerRuntime(path.join(root, "store")), /git could not be started/);
  await fsp.mkdir(path.join(root, "untrusted-git"));
  await fsp.writeFile(path.join(root, "untrusted-git", "git"), `#!/bin/sh\necho "$LC_ALL|\${GIT_CEILING_DIRECTORIES+set}" > probe-env\necho \"fatal: detected dubious ownership in repository at '/srv/not a git repository/x'\" >&2\nexit 128\n`, { mode: 0o755 });
  process.env.PATH = [...entries, path.join(root, "untrusted-git")].join(path.delimiter);
  Object.assign(process.env, { LC_ALL: "de_DE.UTF-8", GIT_CEILING_DIRECTORIES: root });
  await assert.rejects(reviewerRuntime(path.join(root, "store")), /dubious ownership/);
  // The fake git writes into its working directory, the runtime directory.
  assert.equal(await fsp.readFile(path.join(root, "store", "codex-runtime", "probe-env"), "utf8"), "C|\n");
  for (const diagnostic of ["(or any of the parent directories): .git", "(or any parent up to mount point /Volumes)\nStopping at filesystem boundary"]) {
    await fsp.writeFile(path.join(root, "untrusted-git", "git"), `#!/bin/sh\nprintf 'fatal: not a git repository ${diagnostic}\\n' >&2\nexit 128\n`, { mode: 0o755 });
    assert.equal((await reviewerRuntime(path.join(root, "store"))).command, await fsp.realpath(path.join(root, "second", "codex")));
  }
  await fsp.writeFile(path.join(root, "untrusted-git", "git"), "#!/bin/sh\necho 'fatal: not a git repository (or any of the parent directories): .git' >&2\nkill -9 $$\n", { mode: 0o755 });
  await assert.rejects(reviewerRuntime(path.join(root, "store")), /Cannot verify the reviewer runtime/);
  await fsp.writeFile(path.join(root, "untrusted-git", "git"), "#!/bin/sh\necho 'fatal: not a git repository (or any ' >&2\nexit 128\n", { mode: 0o755 });
  await assert.rejects(reviewerRuntime(path.join(root, "store")), /Cannot verify the reviewer runtime/);
  process.env.PATH = [...entries, gitDirectory].join(path.delimiter);
  const runtime = await reviewerRuntime(path.join(root, "store"));
  assert.equal(runtime.command, await fsp.realpath(path.join(root, "second", "codex")));
  // An invalid inherited GIT_DIR must not stand in for the store's own repository.
  const enclosing = path.join(root, "enclosing");
  await fsp.mkdir(enclosing);
  runGit(enclosing, "init");
  process.env.GIT_DIR = path.join(root, "missing");
  await assert.rejects(reviewerRuntime(path.join(enclosing, "store")), /must be outside a Git repository/);
});
