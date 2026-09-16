// The state inventory against a constructed source sample (#145).
//
// The sample carries one constant of each group the report has to separate: a
// value a tool surface produces, a value only an orphaned function produces, a
// value nothing in the sample writes at all, and -- once a ledger is planted --
// a value a store holds. The assertions are on the grouping, because the
// grouping is what phase 2 rules on.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const inventory = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  "scripts",
  "state-inventory.mjs",
);

const SERVER = `import { reachedTool } from "./publication.mjs";

register("start_publication", {}, async (input) => reachedTool(input));
`;

const PUBLICATION = `const FEED_CONCLUSIONS = new Set(["FEED_ONLY_VALUE"]);

export function reachedTool(input) {
  if (!FEED_CONCLUSIONS.has(input.conclusion) || input.status === "ORPHAN_STATUS" || input.kind === "COMPARED_ONLY") {
    fail("REACHED_REFUSAL");
  }
  return { status: "REACHED_STATUS" };
}

export function orphanTransition(ledger) {
  return { ...ledger, status: "ORPHAN_STATUS" };
}
`;

async function sample() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-inventory-"));
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.mkdir(path.join(root, "test"), { recursive: true });
  await fsp.mkdir(path.join(root, "store"), { recursive: true });
  await fsp.writeFile(path.join(root, "src", "server.mjs"), SERVER);
  await fsp.writeFile(path.join(root, "src", "publication.mjs"), PUBLICATION);
  await fsp.writeFile(
    path.join(root, "test", "sample.test.mjs"),
    'assert.equal(result.status, "REACHED_STATUS");\n',
  );
  return root;
}

function run(root, store) {
  const result = spawnSync(
    process.execPath,
    [inventory, "--project", root, "--store", store, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  return new Map(report.constants.map((entry) => [entry.name, entry]));
}

test("an empty store groups the sample by what produces each value", async () => {
  const root = await sample();
  const constants = run(root, path.join(root, "store"));

  // Produced by the tool the server registers, and named by a test.
  assert.equal(constants.get("REACHED_STATUS").group, "reachable_unobserved");
  assert.equal(constants.get("REACHED_STATUS").tests, 1);
  assert.equal(constants.get("REACHED_STATUS").store, 0);
  assert.equal(constants.get("REACHED_REFUSAL").group, "reachable_unobserved");

  // Produced only by a function no tool surface names.
  const orphan = constants.get("ORPHAN_STATUS");
  assert.equal(orphan.group, "unreachable");
  assert.match(orphan.reason, /publication\.mjs:orphanTransition/);
  assert.deepEqual(orphan.producers, [
    "publication.mjs:11 (orphanTransition, unreachable)",
  ]);

  // Never written in the sample: it can only arrive from outside.
  const feed = constants.get("FEED_ONLY_VALUE");
  assert.equal(feed.group, "external_input_guard");
  assert.deepEqual(feed.producers, []);

  // No value is observed, so the observed group is empty and no reachable
  // value was called unreachable.
  const groups = [...constants.values()].map((entry) => entry.group);
  assert.equal(groups.filter((group) => group === "reachable_observed").length, 0);
});

test("a planted ledger moves its value into the observed group", async () => {
  const root = await sample();
  const reviews = path.join(root, "store", "reviews", "rb-sample");
  await fsp.mkdir(reviews, { recursive: true });
  await fsp.writeFile(
    path.join(reviews, "publication.json"),
    `${JSON.stringify({
      status: "REACHED_STATUS",
      history: [
        { status: "REACHED_STATUS" },
        { status: "ORPHAN_STATUS" },
      ],
    })}\n`,
  );
  const constants = run(root, path.join(root, "store"));

  assert.equal(constants.get("REACHED_STATUS").group, "reachable_observed");
  assert.equal(constants.get("REACHED_STATUS").store, 2);

  // A value the store holds is never called unreachable: the ledger outranks
  // the walk, and the contradiction is reported as a defect of the instrument.
  const orphan = constants.get("ORPHAN_STATUS");
  assert.equal(orphan.group, "reachable_observed");
  assert.match(orphan.reason, /this instrument is wrong here/);
});

// V8 writes one coverage report per process. A report whose function ranges
// cover a line with count 0 must not erase a hit another process recorded,
// and a producer any process executed is reachable whatever the name-matched
// call graph concludes about its unit.
function coverageReport(root, line, count) {
  const url = `file://${path.join(root, "src", "publication.mjs")}`;
  const offset = PUBLICATION.split("\n").slice(0, line - 1).join("\n").length + 1;
  const end = offset + PUBLICATION.split("\n")[line - 1].length;
  return JSON.stringify({
    result: [{ url, functions: [{ functionName: "orphanTransition", ranges: [{ startOffset: offset, endOffset: end, count }] }] }],
  });
}

test("an executed producer is reachable, and a hit survives a later report's miss", async () => {
  const root = await sample();
  const coverage = path.join(root, "coverage");
  await fsp.mkdir(coverage, { recursive: true });
  // The orphan's producer line is 11; report "a" ran it once, report "b",
  // sorted after it, ran the same range zero times.
  await fsp.writeFile(path.join(coverage, "coverage-a.json"), coverageReport(root, 11, 1));
  await fsp.writeFile(path.join(coverage, "coverage-b.json"), coverageReport(root, 11, 0));

  const result = spawnSync(
    process.execPath,
    [inventory, "--project", root, "--store", path.join(root, "store"), "--coverage", coverage, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const constants = new Map(JSON.parse(result.stdout).constants.map((entry) => [entry.name, entry]));

  const orphan = constants.get("ORPHAN_STATUS");
  assert.equal(orphan.producers_executed, 1, "the hit in report a must survive the miss in report b");
  assert.equal(orphan.group, "reachable_unobserved", "an executed producer is reachable");
  // The classification is not from the call graph: the unit is still outside it.
  assert.deepEqual(orphan.producers, ["publication.mjs:11 (orphanTransition, unreachable)"]);
});

// The suite copies src/ into temp directories and imports the copies, so a
// coverage report can hold the same basename under another path. Hits there
// belong to the copy, never to the project source.
test("coverage of a copied source tree does not count for the original", async () => {
  const root = await sample();
  const coverage = path.join(root, "coverage");
  await fsp.mkdir(coverage, { recursive: true });
  const copy = path.join(root, "elsewhere", "src", "publication.mjs");
  const offset = PUBLICATION.split("\n").slice(0, 10).join("\n").length + 1;
  await fsp.writeFile(
    path.join(coverage, "coverage-copy.json"),
    JSON.stringify({
      result: [{ url: `file://${copy}`, functions: [{ functionName: "orphanTransition", ranges: [{ startOffset: offset, endOffset: offset + 40, count: 1 }] }] }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [inventory, "--project", root, "--store", path.join(root, "store"), "--coverage", coverage, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const orphan = new Map(JSON.parse(result.stdout).constants.map((entry) => [entry.name, entry])).get("ORPHAN_STATUS");
  assert.equal(orphan.producers_executed, 0, "a hit in the copy is not a hit in the original");
  assert.equal(orphan.group, "unreachable");
});

// The definition field traces a value to a site that writes it, not to
// whichever comparison happens to come first in the file.
test("definition names a producing site, or says no site defines the value", async () => {
  const root = await sample();
  const constants = run(root, path.join(root, "store"));
  // ORPHAN_STATUS is compared on line 4 and produced on line 11.
  assert.equal(constants.get("ORPHAN_STATUS").definition, "publication.mjs:11");
  // A Set literal is a table: it defines the value, so line 1 stands unlabelled.
  assert.equal(constants.get("FEED_ONLY_VALUE").definition, "publication.mjs:1");
  // A value every site only compares has no definition to point at.
  assert.equal(
    constants.get("COMPARED_ONLY").definition,
    "publication.mjs:4 (first occurrence; no site in src defines it)",
  );
});

// Audit logs are not ledgers. Their committed extent is decided by their own
// reader's head cursor and event chain, and this instrument does not carry a
// second copy of that reader: a value that appears only in an audit log is
// not an observation, whatever the log's head says.
test("audit logs are not evidence", async () => {
  const root = await sample();
  const workflow = path.join(root, "store", "workflows", "rbwf-sample");
  await fsp.mkdir(workflow, { recursive: true });
  const line = `${JSON.stringify({ workflow_state: { phase: "ORPHAN_STATUS" } })}\n`;
  await fsp.writeFile(path.join(workflow, "action-audit.jsonl"), line);
  await fsp.writeFile(
    path.join(workflow, "action-audit-head.json"),
    JSON.stringify({ version: 1, workflow_id: "rbwf-sample", committed_bytes: Buffer.byteLength(line), next_sequence: 2, last_event_sha256: null }),
  );
  const constants = run(root, path.join(root, "store"));
  assert.equal(constants.get("ORPHAN_STATUS").store, 0);
  assert.equal(constants.get("ORPHAN_STATUS").group, "unreachable");
});

// A reviewed repository can carry a file named like a ledger, and a snapshot
// keeps it below reviews/<id>/rounds/<n>/files/. Only the store's own
// locations are ledgers.
test("a snapshot's copy of a ledger-named project file is not a ledger", async () => {
  const root = await sample();
  const overlay = path.join(root, "store", "reviews", "rb-sample", "rounds", "1", "files");
  await fsp.mkdir(overlay, { recursive: true });
  await fsp.writeFile(path.join(overlay, "review.json"), `${JSON.stringify({ status: "ORPHAN_STATUS" })}\n`);
  await fsp.writeFile(path.join(overlay, "workflow.json"), `${JSON.stringify({ phase: "ORPHAN_STATUS" })}\n`);
  // A ledger at the canonical location still counts.
  await fsp.writeFile(
    path.join(root, "store", "reviews", "rb-sample", "review.json"),
    `${JSON.stringify({ status: "REACHED_STATUS" })}\n`,
  );
  const constants = run(root, path.join(root, "store"));
  assert.equal(constants.get("ORPHAN_STATUS").store, 0, "an overlay file is not a ledger");
  assert.equal(constants.get("ORPHAN_STATUS").group, "unreachable");
  assert.equal(constants.get("REACHED_STATUS").store, 1);
});

// Node records a module's real path in coverage URLs. A project reached
// through a symlink must still recognise its own scripts, so a hit recorded
// under the real path counts for the source the symlinked project names.
test("coverage recorded under a real path matches a symlinked project", async () => {
  const real = await sample();
  const link = path.join(path.dirname(real), `${path.basename(real)}-link`);
  await fsp.symlink(real, link, "dir");
  const coverage = path.join(real, "coverage");
  await fsp.mkdir(coverage, { recursive: true });
  const target = await fsp.realpath(path.join(real, "src", "publication.mjs"));
  const offset = PUBLICATION.split("\n").slice(0, 10).join("\n").length + 1;
  await fsp.writeFile(
    path.join(coverage, "coverage-real.json"),
    JSON.stringify({
      result: [{ url: `file://${target}`, functions: [{ functionName: "orphanTransition", ranges: [{ startOffset: offset, endOffset: offset + 40, count: 1 }] }] }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [inventory, "--project", link, "--store", path.join(link, "store"), "--coverage", coverage, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const orphan = new Map(JSON.parse(result.stdout).constants.map((entry) => [entry.name, entry])).get("ORPHAN_STATUS");
  assert.equal(orphan.producers_executed, 1, "the real-path hit belongs to the symlinked project's source");
  assert.equal(orphan.group, "reachable_unobserved");
});
