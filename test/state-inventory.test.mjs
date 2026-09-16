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
  if (!FEED_CONCLUSIONS.has(input.conclusion)) {
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
