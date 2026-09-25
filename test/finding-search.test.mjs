import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderFindingSearch, searchFindings } from "../src/finding-search.mjs";
import { continuableInTwoRounds } from "./helpers/report-ledger.mjs";

const REVIEW_A = "rb-2026-09-01T000000-000Z-0badf00d";
const REVIEW_B = "rb-2026-09-02T000000-000Z-c35398d3";
const REMOTE_ID = "rb-2026-09-03T000000-000Z-aabbccdd";
const HEAD_ONE = "b".repeat(40);
const HEAD_TWO = "c".repeat(40);

async function temporaryDirectory(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-findings-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeReview(store, review) {
  const directory = path.join(store, "reviews", review.id);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
}

function resultIds(search) {
  return search.results.map(({ review_id, finding_id }) => `${review_id}/${finding_id}`);
}

async function treeBytes(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(root, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await treeBytes(target)
      : (await fsp.readFile(target)).toString("hex");
  }
  return result;
}

test("combined filters select persisted repository paths even after worktrees disappear", async (t) => {
  const store = await temporaryDirectory(t);
  const repository = path.join(store, "removed-worktree", "repo");
  const review = continuableInTwoRounds({ repository_path: repository });
  review.findings[1].path = "src/Buffer[1].mjs";
  review.findings[1].explanation = "The Literal[Needle] is retained.";
  await writeReview(store, review);
  await writeReview(store, continuableInTwoRounds({
    id: REVIEW_B,
    repository_path: path.join(store, "another-worktree", "repo"),
  }));
  const filters = {
    repository,
    file: "Buffer[1]",
    keyword: "literal[needle]",
    severity: "minor",
    disposition: "rejected",
    decision: "rebuttal_accepted",
  };
  const search = await searchFindings(store, filters);
  assert.deepEqual(resultIds(search), [`${REVIEW_A}/F-002`]);
  assert.equal(search.results[0].repository_path, repository);
  assert.equal(search.total_matches, 1);
  assert.equal(search.truncated, false);
  assert.deepEqual(search.skipped, []);
  assert.equal((await searchFindings(store, { repository: "repo" })).total_matches, 0);
  assert.equal((await searchFindings(store, { repository: `${repository}/` })).total_matches, 0);
  assert.equal((await searchFindings(store, { ...filters, file: "buffer[1]" })).total_matches, 0);
  assert.equal((await searchFindings(store, { ...filters, severity: "major" })).total_matches, 0);
  await assert.rejects(fsp.stat(repository), { code: "ENOENT" });
});

test("keyword search includes finding, author, and rereviewer text as literal substrings", async (t) => {
  const store = await temporaryDirectory(t);
  const review = continuableInTwoRounds();
  review.findings[0].title = "Title unique[one]";
  review.findings[0].explanation = "Explanation unique[two]";
  review.findings[0].recommendation = "Recommendation unique[three]";
  review.resolutions[0].rationale = "Rationale unique[four]";
  review.resolutions[0].evidence = "Evidence unique[five]";
  review.rereview_decisions[0].rationale = "Rationale unique[six]";
  review.rereview_decisions[0].verification = "Verification unique[seven]";
  await writeReview(store, review);
  for (const word of ["one", "two", "three", "four", "five", "six", "seven"]) {
    const search = await searchFindings(store, { keyword: `UNIQUE[${word}]` });
    assert.deepEqual(resultIds(search), [`${REVIEW_A}/F-001`], word);
  }
  assert.equal((await searchFindings(store, { keyword: "unique.*" })).total_matches, 0);
});

test("sorting uses review ID, introduced round, and finding ID before applying the limit", async (t) => {
  const store = await temporaryDirectory(t);
  const first = continuableInTwoRounds();
  first.findings = [
    { ...first.findings[4], id: "F-000" },
    first.findings[2], first.findings[3], first.findings[1], first.findings[0],
  ];
  await writeReview(store, continuableInTwoRounds({ id: REVIEW_B }));
  await writeReview(store, first);
  const expected = ["F-001", "F-002", "F-003", "F-000", "F-004"].map((id) => `${REVIEW_A}/${id}`);
  const limited = await searchFindings(store, { limit: 4 });
  assert.deepEqual(resultIds(limited), expected.slice(0, 4));
  assert.equal(limited.total_matches, 10);
  assert.equal(limited.limit, 4);
  assert.equal(limited.truncated, true);
  assert.deepEqual(await searchFindings(store, { limit: 4 }), limited);
  const all = await searchFindings(store);
  assert.equal(all.schema_version, 1);
  assert.equal(all.store_root, store);
  assert.equal(all.limit, 20);
  assert.equal(all.truncated, false);
  assert.deepEqual(resultIds(all).slice(0, 5), expected);
  assert.ok(all.results.slice(5).every(({ review_id }) => review_id === REVIEW_B));
});

test("original and rereview heads stay separate and evidence locates the original array entry", async (t) => {
  const store = await temporaryDirectory(t);
  const review = continuableInTwoRounds();
  review.findings.reverse();
  await writeReview(store, review);
  const search = await searchFindings(store);
  const first = search.results.find(({ finding_id }) => finding_id === "F-001");
  assert.equal(first.introduced_round, 1);
  assert.equal(first.created_at, review.created_at);
  assert.deepEqual(first.finding, review.findings[4]);
  assert.deepEqual(first.snapshot, { round: 1, head_sha: HEAD_ONE, snapshot_hash: "1".repeat(64) });
  assert.deepEqual(first.author_resolution, {
    ...review.resolutions[0], response_round: 1, head_sha: null,
  });
  assert.deepEqual(first.rereview_decision, {
    ...review.rereview_decisions[0],
    round: 2,
    snapshot: { round: 2, head_sha: HEAD_TWO, snapshot_hash: "2".repeat(64) },
  });
  assert.deepEqual(first.evidence, {
    ledger_path: path.join(store, "reviews", REVIEW_A, "review.json"),
    finding_pointer: "/findings/4",
  });
  const secondRound = search.results.find(({ finding_id }) => finding_id === "F-004");
  assert.deepEqual(secondRound.snapshot, { round: 2, head_sha: HEAD_TWO, snapshot_hash: "2".repeat(64) });
  assert.equal(secondRound.author_resolution, null);
  assert.equal(secondRound.rereview_decision, null);
});

test("local SHA-256 heads are preserved in both original and rereview snapshots", async (t) => {
  const store = await temporaryDirectory(t);
  const review = continuableInTwoRounds();
  review.rounds[0].head_sha = "d".repeat(64);
  review.rounds[1].head_sha = "e".repeat(64);
  await writeReview(store, review);
  const search = await searchFindings(store, { severity: "major" });
  assert.deepEqual(search.skipped, []);
  assert.deepEqual(resultIds(search), [`${REVIEW_A}/F-001`]);
  assert.equal(search.results[0].snapshot.head_sha, review.rounds[0].head_sha);
  assert.equal(search.results[0].rereview_decision.snapshot.head_sha, review.rounds[1].head_sha);
});

test("missing responses and missing history stay explicit instead of borrowing the latest round", async (t) => {
  const store = await temporaryDirectory(t);
  await writeReview(store, continuableInTwoRounds({ history: [] }));
  const missing = await searchFindings(store, { disposition: "missing", decision: "missing" });
  assert.deepEqual(resultIds(missing), [`${REVIEW_A}/F-004`, `${REVIEW_A}/F-005`]);
  for (const entry of missing.results) {
    assert.equal(entry.author_resolution, null);
    assert.equal(entry.rereview_decision, null);
  }
  const answered = await searchFindings(store, { disposition: "fixed", decision: "resolved" });
  assert.equal(answered.results.length, 2);
  for (const entry of answered.results) {
    assert.equal(entry.author_resolution.response_round, null);
    assert.equal(entry.author_resolution.head_sha, null);
    assert.equal(entry.rereview_decision.round, null);
    assert.equal(entry.rereview_decision.snapshot, null);
  }
  const rendered = renderFindingSearch(missing);
  assert.match(rendered, /missing/i);
  assert.match(rendered, /F-004/);
  assert.ok(rendered.includes(path.join(store, "reviews", REVIEW_A, "review.json")));
});

test("escalated authors and unresolved rereviews retain their recorded outcomes", async (t) => {
  const store = await temporaryDirectory(t);
  const escalated = continuableInTwoRounds({ status: "HUMAN_REQUIRED", current_round: 1 });
  escalated.rounds = escalated.rounds.slice(0, 1);
  escalated.findings = [{ ...escalated.findings[0], severity: "blocker", status: "HUMAN_REQUIRED" }];
  escalated.resolutions = [{ ...escalated.resolutions[0], disposition: "human_required" }];
  escalated.rereview_decisions = [];
  escalated.history = [{ event: "AUTHOR_ESCALATED", round: 1 }];
  await writeReview(store, escalated);
  const unresolved = continuableInTwoRounds({ id: REVIEW_B, status: "HUMAN_REQUIRED" });
  unresolved.findings[0].status = "STILL_OPEN";
  unresolved.resolutions[0].disposition = "rejected";
  unresolved.rereview_decisions[0].decision = "still_open";
  unresolved.history.at(-1).event = "REREVIEW_UNRESOLVED";
  await writeReview(store, unresolved);
  const human = await searchFindings(store, { severity: "blocker", disposition: "human_required", decision: "missing" });
  assert.deepEqual(resultIds(human), [`${REVIEW_A}/F-001`]);
  assert.equal(human.results[0].author_resolution.response_round, 1);
  const contested = await searchFindings(store, { disposition: "rejected", decision: "still_open" });
  assert.deepEqual(resultIds(contested), [`${REVIEW_B}/F-001`]);
  assert.equal(contested.results[0].rereview_decision.round, 2);
  assert.equal(contested.results[0].rereview_decision.snapshot.head_sha, HEAD_TWO);
  assert.deepEqual(resultIds(await searchFindings(store, { severity: "nit" })), [
    `${REVIEW_B}/F-003`, `${REVIEW_B}/F-005`,
  ]);
});

test("continuations expose source references without manufacturing new findings", async (t) => {
  const store = await temporaryDirectory(t);
  const review = continuableInTwoRounds();
  await writeReview(store, review);
  const search = await searchFindings(store);
  assert.equal(search.total_matches, review.findings.length);
  assert.ok(search.results.every(({ finding_id }) => finding_id !== "F-009"));
  const source = review.carried_findings[0];
  assert.deepEqual(search.results[0].continuation_sources, [{
    review_id: source.continued_from_review_id,
    finding_id: source.finding_id,
    ledger_path: path.join(store, "reviews", source.continued_from_review_id, "review.json"),
  }]);
  assert.equal(search.results[0].continued_by_review_id, REVIEW_B);
  assert.equal((await searchFindings(store, { keyword: source.title })).total_matches, 0);

  source.finding_id = "F-005";
  await writeReview(store, review);
  const colliding = await searchFindings(store, { severity: "nit", disposition: "missing" });
  assert.deepEqual(resultIds(colliding), [`${REVIEW_A}/F-005`]);
  assert.deepEqual(colliding.results[0].finding, review.findings[4]);
  assert.equal(colliding.results[0].author_resolution, null);
  assert.equal(colliding.results[0].rereview_decision, null);
  assert.equal(colliding.results[0].continuation_sources[0].finding_id, "F-005");
  assert.equal(colliding.results[0].continuation_sources[0].review_id, source.continued_from_review_id);

  await writeReview(store, {
    ...review, findings: [], resolutions: [], rereview_decisions: [],
  });
  const noOwnFindings = await searchFindings(store);
  assert.equal(noOwnFindings.total_matches, 0);
  assert.deepEqual(noOwnFindings.results, []);
  assert.deepEqual(noOwnFindings.skipped, []);
});

test("broken finding links and ambiguous round attribution skip the whole ledger visibly", async (t) => {
  const store = await temporaryDirectory(t);
  await writeReview(store, continuableInTwoRounds());
  const cases = [
    ["duplicate finding ID", (review) => { review.findings[4].id = "F-001"; }, /duplicate.*F-001/],
    ["dangling resolution", (review) => { review.resolutions[0].finding_id = "F-999"; }, /no finding.*F-999/],
    ["decision without a resolution", (review) => { review.rereview_decisions[0].finding_id = "F-004"; }, /no resolution.*F-004/],
    ["missing introduced snapshot", (review) => { review.rounds.shift(); }, /introduced-round snapshot/],
    ["ambiguous author round", (review) => { review.history.push({ event: "AUTHOR_RESPONDED", round: 2 }); }, /ambiguous round.*AUTHOR/],
    ["ambiguous rereview round", (review) => { review.history.push({ event: "REREVIEW_UNRESOLVED", round: 1 }); }, /ambiguous round.*REREVIEW/],
  ];
  for (const [label, corrupt, reason] of cases) {
    const review = continuableInTwoRounds({ id: REVIEW_B });
    corrupt(review);
    await writeReview(store, review);
    const search = await searchFindings(store);
    assert.equal(search.total_matches, 5, label);
    assert.ok(search.results.every(({ review_id }) => review_id === REVIEW_A), label);
    assert.equal(search.skipped.length, 1, label);
    assert.equal(search.skipped[0].review_id, REVIEW_B, label);
    assert.equal(search.skipped[0].ledger_path, path.join(store, "reviews", REVIEW_B, "review.json"), label);
    assert.match(search.skipped[0].reason, reason, label);
    assert.ok(renderFindingSearch(search).includes(search.skipped[0].ledger_path), label);
  }
});

test("remote-only and empty directories are allowed, while corrupt ledgers remain visible outside filters", async (t) => {
  const store = await temporaryDirectory(t);
  await writeReview(store, continuableInTwoRounds());
  const remote = path.join(store, "reviews", REMOTE_ID);
  await fsp.mkdir(remote, { recursive: true });
  await fsp.writeFile(path.join(remote, "remote-authorization.json"), "{}\n");
  await fsp.mkdir(path.join(store, "reviews", "rb-2026-09-04T000000-000Z-aabbccdd"));
  const broken = continuableInTwoRounds({ id: REVIEW_B, repository_path: "/outside-filter" });
  broken.findings[0].title = 17;
  await writeReview(store, broken);
  const invalidJsonId = "rb-2026-09-05T000000-000Z-aabbccdd";
  const invalidJsonDirectory = path.join(store, "reviews", invalidJsonId);
  await fsp.mkdir(invalidJsonDirectory);
  await fsp.writeFile(path.join(invalidJsonDirectory, "review.json"), "{broken\n");
  const search = await searchFindings(store, { repository: "/tmp/repo", severity: "major" });
  assert.deepEqual(resultIds(search), [`${REVIEW_A}/F-001`]);
  assert.equal(search.corpus.directories_without_review, 2);
  assert.deepEqual(search.skipped.map(({ review_id }) => review_id), [REVIEW_B, invalidJsonId]);
  for (const skipped of search.skipped) {
    assert.equal(skipped.ledger_path, path.join(store, "reviews", skipped.review_id, "review.json"));
    assert.equal(typeof skipped.reason, "string");
    assert.ok(skipped.reason.length > 0);
  }
  const rendered = renderFindingSearch(search);
  assert.ok(rendered.includes(REVIEW_B));
  assert.ok(rendered.includes(invalidJsonId));
  assert.match(rendered, /skip|invalid|error/i);
});

test("queries leave every stored byte unchanged and do not create a missing store", async (t) => {
  const store = await temporaryDirectory(t);
  await writeReview(store, continuableInTwoRounds());
  await fsp.writeFile(path.join(store, "gate-sentinel"), "unchanged\n");
  const before = await treeBytes(store);
  await searchFindings(store, { keyword: "rationale", limit: 1 });
  assert.deepEqual(await treeBytes(store), before);
  const absent = path.join(store, "absent");
  const empty = await searchFindings(absent);
  assert.equal(empty.total_matches, 0);
  assert.deepEqual(empty.results, []);
  assert.deepEqual(empty.skipped, []);
  await assert.rejects(fsp.stat(absent), { code: "ENOENT" });
});

test("query parameters reject empty strings, unknown enums, and invalid limits", async (t) => {
  const store = await temporaryDirectory(t);
  for (const options of [
    { repository: " " }, { file: "" }, { keyword: "\n" },
    { severity: "critical" }, { disposition: "resolved" }, { decision: "fixed" },
    { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { limit: "2" },
  ]) {
    await assert.rejects(searchFindings(store, options), undefined, JSON.stringify(options));
  }
});

async function packagedScript(t, store) {
  const root = await temporaryDirectory(t);
  const plugin = path.join(root, "plugin");
  await fsp.mkdir(path.join(plugin, "scripts"), { recursive: true });
  const script = path.join(plugin, "scripts", "review-findings.mjs");
  await fsp.copyFile(
    fileURLToPath(new URL("../templates/codex-plugin/scripts/review-findings.mjs", import.meta.url)),
    script,
  );
  await fsp.symlink(fileURLToPath(new URL("../src", import.meta.url)), path.join(plugin, "server"));
  return (...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, REVIEW_BRIDGE_HOME: store },
  });
}

test("the packaged CLI prints bounded readable results or JSON and honors store selection", async (t) => {
  const store = await temporaryDirectory(t);
  await writeReview(store, continuableInTwoRounds());
  const before = await treeBytes(store);
  const run = await packagedScript(t, store);
  const readable = run("--limit", "1");
  assert.equal(readable.status, 0, readable.stderr);
  assert.match(readable.stdout, /F-001/);
  assert.match(readable.stdout, /5/);
  assert.doesNotMatch(readable.stdout, /F-002/);
  const json = run("--json", "--repository", "/tmp/repo", "--severity", "minor", "--decision", "missing");
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(resultIds(JSON.parse(json.stdout)), [`${REVIEW_A}/F-004`]);
  const emptyStore = await temporaryDirectory(t);
  const explicit = run("--json", "--store", emptyStore);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).total_matches, 0);
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--repository/);
  assert.match(help.stdout, /exact/i);
  assert.match(help.stdout, /repository_path/);
  assert.deepEqual(await treeBytes(store), before);
});

test("the packaged CLI accepts leading hyphens and equals signs in literal values", async (t) => {
  const store = await temporaryDirectory(t);
  const review = continuableInTwoRounds();
  review.findings[0].explanation = "The --store=cache option selects the wrong ledger.";
  review.findings[0].path = "src/--name.mjs";
  await writeReview(store, review);
  const run = await packagedScript(t, store);
  for (const keyword of ["--store", "--store=cache"]) {
    const result = run("--json", `--keyword=${keyword}`, "--file=--name", "--severity=major");
    assert.equal(result.status, 0, result.stderr);
    const search = JSON.parse(result.stdout);
    assert.deepEqual(resultIds(search), [`${REVIEW_A}/F-001`]);
    assert.equal(search.filters.keyword, keyword);
    assert.equal(search.filters.file, "--name");
  }
});

test("the packaged CLI reports invalid flags and damaged ledgers with distinct exit codes", async (t) => {
  const store = await temporaryDirectory(t);
  const run = await packagedScript(t, store);
  for (const args of [
    ["--bogus"], ["--repository"], ["--keyword", " "], ["--severity", "critical"],
    ["--disposition", "resolved"], ["--decision", "fixed"], ["--limit", "0"], ["--limit", "1.5"],
    ["--severity", "major", "--severity", "minor"],
    ["--keyword"], ["--keyword", "--json"], ["--keyword="],
    ["--keyword", "one", "--keyword=two"], ["--keyword=one", "--keyword", "two"],
    ["--bogus=value"], ["--json=true"], ["--help=true"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.ok(result.stderr.length > 0);
  }
  await writeReview(store, continuableInTwoRounds());
  const directory = path.join(store, "reviews", REVIEW_B);
  await fsp.mkdir(directory);
  await fsp.writeFile(path.join(directory, "review.json"), "{broken\n");
  const result = run("--json");
  assert.equal(result.status, 1, result.stderr);
  const search = JSON.parse(result.stdout);
  assert.equal(search.total_matches, 5);
  assert.equal(search.skipped[0].review_id, REVIEW_B);
});
