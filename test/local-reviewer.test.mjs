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
import { reviewerRuntime, startLocalReviewer } from "../src/local-reviewer.mjs";
import {
  getReviewSummary, launchLocalReviewer, loadReview, prepareRereview, prepareReview,
  submitInitialReview, submitResolutions,
} from "../src/core.mjs";
import { renderReviewBrief, renderReviewReport } from "../src/report.mjs";
import { buildScorecard } from "../src/scorecard.mjs";

process.env.REVIEW_BRIDGE_CODEX_COMMAND = FIXTURE_CODEX;

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
  assert.deepEqual(launched.reviewer_configuration.requested, { reasoning_effort: "high" });
  assert.deepEqual(launched.reviewer_dispatch.requested, { reasoning_effort: "high" });
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
  assert.equal((await waitForExit(launched.reviewer_dispatch.attempt_root)).code, 0);

  const continued = await loadReview(store, review.id);
  assert.deepEqual(continued.rounds[0].reviewer_configuration, legacy);
  assert.deepEqual(continued.rounds[1].reviewer_configuration.requested, { reasoning_effort: "high" });
  const full = renderReviewReport(continued);
  assert.ok(full.includes(`- Round 1 reviewer requested: ${legacyRequest};`));
  assert.ok(full.includes('- Round 2 reviewer requested: `{"reasoning_effort":"high"}`, model from the Codex configuration;'));
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
  assert.deepEqual(relaunched.rounds[0].reviewer_configuration.requested, { reasoning_effort: "high" });
  assert.deepEqual(relaunched.history.find((event) => event.event === "REVIEWER_CONFIGURATION_SELECTED").requested, requested);
  // A retry after the confirmed exit keeps the first attempt in history.
  const retried = await launchLocalReviewer(store, review.id, relaunched.state_version);
  assert.equal((await waitForExit(retried.reviewer_dispatch.attempt_root)).code, 0);
  const attempts = (await loadReview(store, review.id)).history.filter((event) => event.event === "REVIEWER_DISPATCH_REQUESTED");
  assert.notEqual(launched.reviewer_dispatch.attempt_root, retried.reviewer_dispatch.attempt_root);
  assert.deepEqual(attempts.map(({ attempt_root, requested }) => ({ attempt_root, requested })), [
    { attempt_root: launched.reviewer_dispatch.attempt_root, requested: { reasoning_effort: "high" } },
    { attempt_root: retried.reviewer_dispatch.attempt_root, requested: { reasoning_effort: "high" } },
  ]);
  assert.equal((await loadReview(store, review.id)).rounds[0].reviewer_dispatch.attempt_root, retried.reviewer_dispatch.attempt_root);
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
  await fsp.writeFile(path.join(root, "untrusted-git", "git"), `#!/bin/sh\n/usr/bin/env > probe-env\necho \"fatal: detected dubious ownership in repository at '/srv/not a git repository/x'\" >&2\nexit 128\n`, { mode: 0o755 });
  process.env.PATH = [...entries, path.join(root, "untrusted-git")].join(path.delimiter);
  Object.assign(process.env, { LC_ALL: "de_DE.UTF-8", GIT_CEILING_DIRECTORIES: root });
  await assert.rejects(reviewerRuntime(path.join(root, "store")), /dubious ownership/);
  // The fake git writes into its working directory, the runtime directory.
  const seen = (await fsp.readFile(path.join(root, "store", "codex-runtime", "probe-env"), "utf8")).split("\n");
  assert.ok(seen.includes("LC_ALL=C"));
  assert.deepEqual(seen.filter((line) => line.startsWith("GIT_")), []);
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
