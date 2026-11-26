import { FIXTURE_CODEX, waitForExit } from "./helpers/codex-runtime.mjs";
import { git } from "./helpers/repository-fixture";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as current from "../src/core.mjs";
import { renderReviewBrief, renderReviewReport } from "../src/report.mjs";

process.env.REVIEW_BRIDGE_CODEX_COMMAND = FIXTURE_CODEX;
const SKILL = "templates/codex-plugin/skills/review-bridge-reviewer/SKILL.md";
const lensFile = (lens) => `templates/codex-plugin/skills/review-bridge-reviewer/lenses/${lens}.md`;
const RUNS = ["general", "tests", "design"];
const finding = (title) => ({ severity: "major", title, explanation: `${title} explained`, path: "file.txt", line: 1 });
const bound = (reviewId, run = "general") => ({ reviewId, lens: run === "general" ? null : run });

async function fixture(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "lens-review-")));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  await fsp.mkdir(repository);
  git(repository, "init", "-b", "main");
  await fsp.writeFile(path.join(repository, "file.txt"), "before\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  const base = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "file.txt"), "after\n");
  const core = await install(path.join(root, "install"));
  return { root, repository, store: path.join(root, "store"), base, core };
}

// The server modules with the packaged instruction files beside them, laid
// out as an installation lays them out.
async function install(directory) {
  await fsp.mkdir(directory, { recursive: true });
  for (const name of await fsp.readdir("src")) {
    if (name.endsWith(".mjs")) await fsp.copyFile(path.join("src", name), path.join(directory, name));
  }
  await fsp.copyFile(SKILL, path.join(directory, "reviewer-skill.md"));
  for (const lens of ["tests", "design"]) await fsp.copyFile(lensFile(lens), path.join(directory, `lens-${lens}.md`));
  return import(pathToFileURL(path.join(directory, "core.mjs")).href);
}

const prepare = (context, extra = {}) => context.core.prepareReview(context.store, {
  repositoryPath: context.repository, baseRef: context.base, requirement: "Change content",
  implementationScope: "file.txt", forceFullReview: true, lensReview: true, ...extra,
});
const submitRun = (context, id, run, findings, intent) =>
  context.core.submitInitialReview(context.store, id, findings, "CODEX_TASK", intent, bound(id, run));
async function closeRound(context, id, findingsByRun = {}) {
  for (const run of RUNS) await submitRun(context, id, run, findingsByRun[run] ?? []);
  return current.loadReview(context.store, id);
}
const resolveAll = (context, review, disposition) => current.submitResolutions(context.store, review.id,
  review.findings.map((entry) => ({ finding_id: entry.id, disposition, rationale: "Answered" })));

test("lens_review needs a full CODEX_TASK review from an installation outside any work tree", async (t) => {
  const context = await fixture(t);
  await assert.rejects(prepare(context, { forceFullReview: false }), /lens_review requires force_full_review/);
  await assert.rejects(prepare(context, { reviewerProvider: "HERMES" }), /lens_review requires reviewer_provider CODEX_TASK/);
  const checkout = path.join(context.root, "checkout");
  await fsp.mkdir(checkout);
  git(checkout, "init");
  const inTree = await install(path.join(checkout, "server"));
  await assert.rejects(prepare({ ...context, core: inTree }), /lens review installation must be outside a Git repository/);
  await assert.rejects(prepare({ ...context, core: current }), /lens review installation must be outside a Git repository/);
  const review = await prepare(context);
  assert.equal(review.status, "WAITING_FOR_LENS_REVIEW");
  await assert.rejects(inTree.launchLocalReviewer(context.store, review.id, review.state_version),
    /lens review installation must be outside a Git repository/);
});

test("a lens launch starts three bound runs with the installation's instructions", async (t) => {
  const context = await fixture(t);
  const review = await prepare(context);
  const launched = await context.core.launchLocalReviewer(context.store, review.id, review.state_version);
  assert.equal(launched.reviewer_dispatch, null);
  assert.deepEqual(launched.rounds[0].runs.map((entry) => entry.run), RUNS);
  for (const entry of launched.rounds[0].runs) assert.equal((await waitForExit(entry.reviewer_dispatch.attempt_root)).code, 0);
  const skill = await fsp.readFile(SKILL, "utf8");
  for (const run of RUNS) {
    const { args } = JSON.parse(await fsp.readFile(path.join(context.store, "codex-runtime", `executed-${run}.json`), "utf8"));
    const setting = (key) => JSON.parse(args.find((value) => value.startsWith(`${key}=`)).slice(key.length + 1));
    const serverArgs = setting("mcp_servers.review-bridge-reviewer.args");
    assert.equal(serverArgs[0], path.join(context.root, "install", "server.mjs"));
    assert.deepEqual(serverArgs.slice(5), ["--review-id", review.id, ...(run === "general" ? [] : ["--lens", run])]);
    const request = args.at(-1);
    if (run === "general") {
      assert.equal(setting("developer_instructions"), skill);
      assert.equal(request, `Independently review Review Bridge task ${review.id} using the packaged Review Bridge reviewer skill. Require reviewer_provider: CODEX_TASK, follow the review strategy, and submit every actionable finding.`);
    } else {
      assert.equal(setting("developer_instructions"), `${skill}\n\n${await fsp.readFile(lensFile(run), "utf8")}`);
      assert.match(request, new RegExp(`as its ${run} lens run`));
      assert.ok(!request.includes("submit every actionable finding"));
    }
  }
});

test("only a run that exited without submitting is relaunched", async (t) => {
  const context = await fixture(t);
  const hold = path.join(context.root, "hold");
  await fsp.writeFile(`${hold}-tests`, "");
  process.env.RB_TEST_HOLD = hold;
  t.after(() => { delete process.env.RB_TEST_HOLD; });
  const review = await prepare(context);
  const launched = await context.core.launchLocalReviewer(context.store, review.id, review.state_version);
  const [general, tests, design] = launched.rounds[0].runs.map((entry) => entry.reviewer_dispatch);
  await waitForExit(general.attempt_root);
  await waitForExit(design.attempt_root);
  await submitRun(context, review.id, "general", []);
  const waited = await current.waitForReviewState(context.store, review.id, launched.state_version, 50);
  assert.equal(waited.timed_out, true);
  const summary = await current.getReviewSummary(context.store, review.id);
  assert.deepEqual(summary.runs.map((entry) => [entry.run, entry.submitted, entry.reviewer_dispatch.exit?.code ?? null]),
    [["general", true, 0], ["tests", false, null], ["design", false, 0]]);
  const relaunched = await context.core.launchLocalReviewer(context.store, review.id, summary.state_version);
  const after = relaunched.rounds[0].runs.map((entry) => entry.reviewer_dispatch.task_id);
  assert.equal(after[0], general.task_id);
  assert.equal(after[1], tests.task_id);
  assert.notEqual(after[2], design.task_id);
  await fsp.rm(`${hold}-tests`);
  await waitForExit(tests.attempt_root);
});

test("run submissions stay out of the review until the third closes the round", async (t) => {
  const context = await fixture(t);
  const review = await prepare(context);
  const id = review.id;
  await submitRun(context, id, "tests", [finding("Tests one")], "Tests intent");
  await assert.rejects(submitRun(context, id, "tests", []), /the tests run has already submitted/);
  const generalOpen = JSON.stringify(await context.core.openReview(context.store, id, "CODEX_TASK", bound(id)));
  assert.ok(!generalOpen.includes("Tests one") && !generalOpen.includes("runs"));
  const generalResponse = JSON.stringify(await submitRun(context, id, "general",
    [finding("General one"), finding("General two")], "General intent"));
  assert.ok(!generalResponse.includes("Tests one"));
  const pending = await current.loadReview(context.store, id);
  assert.deepEqual([pending.status, pending.findings, pending.last_transition_state_version],
    ["WAITING_FOR_LENS_REVIEW", [], review.last_transition_state_version]);
  assert.equal(pending.rounds[0].runs[1].reconstructed_intent, undefined);
  assert.equal(pending.rounds[0].runs[0].reconstructed_intent, "General intent");
  const designOpen = JSON.stringify(await context.core.openReview(context.store, id, "CODEX_TASK", bound(id, "design")));
  assert.ok(!/Tests one|General one|General intent/.test(designOpen));
  const closing = await submitRun(context, id, "design", [finding("Design one")]);
  assert.ok(closing.findings.some((entry) => entry.title === "Tests one"));

  const closed = await current.loadReview(context.store, id);
  assert.equal(closed.status, "REVIEW_SUBMITTED");
  assert.ok(closed.last_transition_state_version > review.last_transition_state_version);
  assert.equal(closed.reconstructed_intent, "General intent");
  assert.deepEqual(closed.findings.map((entry) => [entry.id, entry.title, entry.lens]), [
    ["F-001", "General one", undefined], ["F-002", "General two", undefined],
    ["F-003", "Tests one", "tests"], ["F-004", "Design one", "design"],
  ]);
  for (const entry of closed.rounds[0].runs) assert.deepEqual(Object.keys(entry), ["run", "reviewer_dispatch", "submitted_at"]);

  const reordered = await prepare(context);
  await submitRun(context, reordered.id, "design", [finding("Design one")]);
  await submitRun(context, reordered.id, "general", [finding("General one"), finding("General two")], "General intent");
  await submitRun(context, reordered.id, "tests", [finding("Tests one")]);
  const other = await current.loadReview(context.store, reordered.id);
  assert.deepEqual(other.findings, closed.findings);
  assert.equal(other.reconstructed_intent, "General intent");
});

test("three overlapping empty submissions close the round CLEAN once and finalize", async (t) => {
  const context = await fixture(t);
  const review = await prepare(context);
  await Promise.all(RUNS.map(async (run) => {
    for (;;) {
      try { return await submitRun(context, review.id, run, []); }
      catch (error) { if (!/_BUSY$/.test(error.code ?? "")) throw error; }
    }
  }));
  const closed = await current.loadReview(context.store, review.id);
  assert.equal(closed.status, "CLEAN");
  assert.equal(closed.clean_snapshot_hash, closed.rounds[0].snapshot_hash);
  assert.equal(closed.history.filter((entry) => entry.event === "INITIAL_REVIEW_CLEAN").length, 1);
  assert.ok(closed.rounds[0].runs.every((entry) => entry.submitted_at != null));
  const { gate } = await current.finalizeLocalGate(context.store, review.id);
  assert.equal(gate.snapshot_hash, closed.rounds[0].snapshot_hash);
});

test("errata wait for the close, and a carried erratum reaches every run", async (t) => {
  const context = await fixture(t);
  const review = await prepare(context);
  await assert.rejects(current.appendReviewErratum(context.store, review.id, "Stale claim"), /refused during the lens round/);
  await resolveAll(context, await closeRound(context, review.id, { tests: [finding("Tests one")] }), "fixed");
  await current.appendReviewErratum(context.store, review.id, "Stale claim");
  await current.prepareRereview(context.store, review.id);
  const roundTwo = await current.openReview(context.store, review.id, "CODEX_TASK");
  assert.deepEqual(roundTwo.errata.map((entry) => entry.text), ["Stale claim"]);
  await current.submitRereview(context.store, review.id, [{ finding_id: "F-001", decision: "still_open", rationale: "Incomplete" }], [], "CODEX_TASK");

  git(context.repository, "commit", "-am", "change");
  const continuation = await prepare(context, { continuedFromReviewId: review.id });
  for (const run of RUNS) {
    const opened = await context.core.openReview(context.store, continuation.id, "CODEX_TASK", bound(continuation.id, run));
    assert.deepEqual(opened.errata.map((entry) => entry.text), ["Stale claim"]);
    await submitRun(context, continuation.id, run, []);
  }
  const closed = await current.loadReview(context.store, continuation.id);
  assert.equal(closed.history.find((entry) => entry.event === "INITIAL_REVIEW_CLEAN").errata_watermark, 1);
});

test("a bound reviewer server serves only its own lens round", async (t) => {
  const context = await fixture(t);
  const review = await prepare(context);
  const other = path.join(context.root, "other");
  await fsp.mkdir(other);
  git(other, "init", "-b", "main");
  await fsp.writeFile(path.join(other, "file.txt"), "base\n");
  git(other, "add", ".");
  git(other, "commit", "-m", "base");
  await fsp.writeFile(path.join(other, "file.txt"), "only-in-other\n");
  const otherReview = await prepare({ ...context, repository: other, base: git(other, "rev-parse", "HEAD") });
  const connect = async (...options) => {
    const client = new Client({ name: "lens-reviewer", version: "1" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [path.resolve("src/server.mjs"), "--role", "reviewer", "--reviewer-provider", "CODEX_TASK", ...options],
      env: { ...process.env, REVIEW_BRIDGE_HOME: context.store }, stderr: "pipe",
    }));
    t.after(() => client.close());
    return async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      const value = JSON.parse(response.content[0].text);
      if (response.isError) throw new Error(value.error);
      return value;
    };
  };
  const boundCall = await connect("--review-id", review.id);
  const unbound = await connect();
  assert.deepEqual((await boundCall("list_pending_reviews", {})).map((row) => row.id), [review.id]);
  assert.equal((await boundCall("read_snapshot_file", { review_id: review.id, round: 1, path: "file.txt" })).content, "after\n");
  const refused = /bound to review/;
  await assert.rejects(boundCall("open_review", { review_id: otherReview.id }), refused);
  await assert.rejects(boundCall("read_snapshot_file", { review_id: otherReview.id, round: 1, path: "file.txt" }), refused);
  await assert.rejects(boundCall("read_review_artifact", { review_id: otherReview.id, round: 1, artifact: "patch.diff" }), refused);
  await assert.rejects(boundCall("search_snapshot", { review_id: otherReview.id, round: 1, pattern: "only-in-other" }), refused);
  await assert.rejects(boundCall("submit_review", { review_id: otherReview.id, findings: [] }), refused);
  await assert.rejects(unbound("submit_review", { review_id: review.id, findings: [] }), /only from its bound runs/);

  await submitRun(context, review.id, "tests", [finding("Tests one")]);
  await submitRun(context, review.id, "design", []);
  await boundCall("submit_review", { review_id: review.id, findings: [] });
  await assert.rejects(boundCall("open_review", { review_id: review.id }), /only during the lens round/);
  await assert.rejects(context.core.openReview(context.store, review.id, "CODEX_TASK", bound(review.id, "tests")), /only during the lens round/);
  await resolveAll(context, await current.loadReview(context.store, review.id), "fixed");
  await current.prepareRereview(context.store, review.id);
  assert.deepEqual(await boundCall("list_pending_reviews", {}), []);
  const decisions = [{ finding_id: "F-001", decision: "resolved", rationale: "Fixed" }];
  await assert.rejects(boundCall("submit_rereview", { review_id: review.id, decisions, new_findings: [] }), /only during the lens round/);
  assert.equal((await unbound("submit_rereview", { review_id: review.id, decisions, new_findings: [] })).status, "CLEAN");
});

test("lens findings settle through the existing protocol, and only round one has lenses", async (t) => {
  const context = await fixture(t);
  const escalated = await prepare(context);
  await resolveAll(context, await closeRound(context, escalated.id, { tests: [finding("Tests one")] }), "human_required");
  const summary = await current.getReviewSummary(context.store, escalated.id);
  assert.equal(summary.status, "HUMAN_REQUIRED");
  const { arbitration, markdown } = await current.exportHumanArbitration(context.store, escalated.id, summary.state_version);
  assert.equal(arbitration.active_findings[0].finding.lens, "tests");
  assert.match(markdown, /"lens": "tests"/);

  const disputed = await prepare(context);
  await resolveAll(context, await closeRound(context, disputed.id, { design: [finding("Design one")] }), "rejected");
  await current.prepareRereview(context.store, disputed.id);
  const decision = [{ finding_id: "F-001", decision: "still_open", rationale: "Rebuttal fails" }];
  assert.equal((await current.submitRereview(context.store, disputed.id, decision, [], "CODEX_TASK")).status, "HUMAN_REQUIRED");

  const continued = await prepare(context);
  await resolveAll(context, await closeRound(context, continued.id, { tests: [finding("Tests one")] }), "fixed");
  const roundTwo = await current.prepareRereview(context.store, continued.id);
  const launched = await context.core.launchLocalReviewer(context.store, continued.id, roundTwo.state_version);
  await waitForExit(launched.reviewer_dispatch.attempt_root);
  const { args } = JSON.parse(await fsp.readFile(path.join(context.store, "codex-runtime", "executed-general.json"), "utf8"));
  assert.ok(!args.some((value) => value.includes("--review-id") || value.includes("--lens")));
  await current.submitRereview(context.store, continued.id, [{ finding_id: "F-001", decision: "still_open", rationale: "Incomplete" }], [], "CODEX_TASK");
  git(context.repository, "commit", "-am", "change");
  const plain = await prepare(context, { continuedFromReviewId: continued.id, lensReview: false });
  assert.equal(plain.status, "WAITING_FOR_REVIEW");
  assert.equal(plain.rounds[0].runs, undefined);
});

test("reports and the summary show lens runs and lens findings", async (t) => {
  const context = await fixture(t);
  const pending = await prepare(context);
  const pendingBrief = renderReviewBrief(await current.loadReview(context.store, pending.id));
  assert.match(pendingBrief, /round one's lens runs are still owed/);
  assert.match(pendingBrief, /Lens runs: `general` owed; `tests` owed; `design` owed\./);

  const closed = await closeRound(context, pending.id, { general: [finding("General one")], tests: [finding("Tests one")] });
  const line = "Lens runs: `general` submitted, 1 finding; `tests` submitted, 1 finding; `design` submitted, 0 findings.";
  for (const rendered of [renderReviewBrief(closed), renderReviewReport(closed)]) {
    assert.ok(rendered.includes(line));
    assert.match(rendered, /\| F-002 \| major \| Tests one \| open \(`OPEN`\) \| 1 \(`tests` lens\) \|/);
    assert.match(rendered, /\| F-001 \| major \| General one \| open \(`OPEN`\) \| 1 \|/);
  }
  const summary = await current.getReviewSummary(context.store, pending.id);
  assert.deepEqual(summary.active_findings.map((entry) => entry.lens), [undefined, "tests"]);
});

// The release before lens reviews, as an install sharing the store runs it.
async function released(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "released-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const archive = spawnSync("git", ["archive", "--format=tar", "v0.25.0", "src"], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(archive.status, 0, `v0.25.0 must be fetched: ${archive.stderr}`);
  assert.equal(spawnSync("tar", ["-x", "-C", directory], { input: archive.stdout }).status, 0);
  return import(pathToFileURL(path.join(directory, "src", "core.mjs")).href);
}

test("a released server refuses a lens round before its close and drives round two after it", async (t) => {
  const context = await fixture(t);
  const old = await released(t);
  const review = await prepare(context);
  const { store } = context;
  const id = review.id;
  const sv = review.state_version;
  await assert.rejects(old.submitInitialReview(store, id, [], "CODEX_TASK"), /not waiting for its initial review/);
  await assert.rejects(old.launchLocalReviewer(store, id, sv), /not pending/);
  await assert.rejects(old.submitResolutions(store, id, []), /not waiting for author resolutions/);
  await assert.rejects(old.prepareRereview(store, id), /not ready for rereview/);
  await assert.rejects(old.submitRereview(store, id, [], [], "CODEX_TASK"), /not waiting for rereview/);
  await assert.rejects(old.finalizeLocalGate(store, id), /only a CLEAN review/);
  await assert.rejects(old.exportHumanArbitration(store, id, sv), /does not require human arbitration/);
  await assert.rejects(old.prepareReview(store, {
    repositoryPath: context.repository, baseRef: context.base, requirement: "Change content",
    implementationScope: "file.txt", forceFullReview: true, continuedFromReviewId: id,
  }), /only CONTINUABLE_FINDINGS can be continued/);
  assert.ok(!(await old.listPendingReviews(store, "CODEX_TASK")).some((row) => row.id === id));

  await closeRound(context, id, { tests: [finding("Tests one")] });
  await old.submitResolutions(store, id, [{ finding_id: "F-001", disposition: "fixed", rationale: "Fixed" }]);
  await old.prepareRereview(store, id);
  await old.submitRereview(store, id, [{ finding_id: "F-001", decision: "resolved", rationale: "Fixed" }], [], "CODEX_TASK");
  assert.equal((await old.finalizeLocalGate(store, id)).gate.status, "LOCAL_GATE_PASSED");
});

test("a plain review keeps the released ledger, summary, and gate fields", async (t) => {
  const context = await fixture(t);
  const old = await released(t);
  const shape = (value) => Array.isArray(value) ? value.map(shape)
    : value != null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])])) : typeof value;
  const run = async (core, store) => {
    const review = await core.prepareReview(store, {
      repositoryPath: context.repository, baseRef: context.base, requirement: "Change content", implementationScope: "file.txt",
    });
    await core.submitInitialReview(store, review.id, [], "CODEX_TASK");
    const summary = await core.getReviewSummary(store, review.id);
    const { gate } = await core.finalizeLocalGate(store, review.id);
    return shape({ ledger: await core.loadReview(store, review.id), summary, gate });
  };
  assert.deepEqual(await run(current, path.join(context.root, "store-current")), await run(old, path.join(context.root, "store-released")));
});
