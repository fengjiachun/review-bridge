import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MANIFEST,
  PREVIOUS_TAG_SHA,
  changelog,
  files,
  observation,
} from "./helpers/release-fixture.mjs";
import { git } from "./helpers/repository-fixture";

const verifier = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  "scripts",
  "verify-release.mjs",
);

async function releaseRepository() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-release-"));
  const repository = path.join(root, "repo");
  await fsp.mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Review Bridge Test");
  git(repository, "config", "user.email", "review-bridge@example.invalid");
  const write = async (version, text) => {
    for (const [name, content] of Object.entries(files({ version, text }))) {
      const target = path.join(repository, name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, `${content}\n`);
    }
  };
  await write(
    "1.0.0",
    "# Changelog\n\nPull-request references required from: 1.0.0\n\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- The first thing (#1)\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "release 1.0.0");
  git(repository, "tag", "v1.0.0");
  git(repository, "switch", "-c", "feature");
  await fsp.writeFile(path.join(repository, "feature.txt"), "work\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "a shipped thing");
  const attestedHead = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "main");
  git(
    repository,
    "merge",
    "--no-ff",
    "-m",
    "Merge pull request #7 from owner/feature",
    "feature",
  );
  await write("1.1.0", changelog());
  git(repository, "add", ".");
  git(repository, "commit", "-m", "release 1.1.0");
  git(repository, "tag", "v1.1.0");
  return {
    root,
    repository,
    attestedHead,
    mergeSha: git(repository, "rev-parse", "main^"),
    targetSha: git(repository, "rev-parse", "HEAD"),
  };
}

function runVerifier(args, cwd) {
  const result = spawnSync(process.execPath, [verifier, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return { ...result, report: JSON.parse(result.stdout || "{}") };
}

test("pre-flight verifies a release pull request from the repository alone", async (t) => {
  const fixture = await releaseRepository();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const passing = runVerifier(["--pre"], fixture.repository);
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  assert.equal(passing.report.status, "PASSED");
  assert.equal(passing.report.reconciliation, "RECONCILED");

  await fsp.writeFile(
    path.join(fixture.repository, "CHANGELOG.md"),
    `${changelog({ entry: "- A shipped thing (#7)\n- An unmerged claim (#99)" })}\n`,
  );
  git(fixture.repository, "commit", "-am", "claim a pull request");
  const deferring = runVerifier(["--pre"], fixture.repository);
  assert.equal(deferring.status, 0);
  assert.deepEqual(
    deferring.report.deferred.map((entry) => entry.pull_request),
    [99],
  );
});

test("the final phase records once, agrees on re-run, and refuses to overwrite", async (t) => {
  const fixture = await releaseRepository();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const store = path.join(fixture.root, "store");
  const buildDirectory = path.join(fixture.root, "dist");
  await fsp.mkdir(buildDirectory, { recursive: true });
  await fsp.writeFile(path.join(buildDirectory, "SHA256SUMS.txt"), MANIFEST);
  const workflowDirectory = path.join(
    store,
    "workflows",
    "rbwf-2026-01-01T000000-000Z-abcdabcd",
  );
  await fsp.mkdir(workflowDirectory, { recursive: true, mode: 0o700 });
  await fsp.writeFile(
    path.join(workflowDirectory, "workflow.json"),
    JSON.stringify({
      terminal: {
        status: "MERGE_READY",
        head_sha: fixture.attestedHead,
        pull_request: { repository_id: 42, pr_number: 7 },
      },
    }),
    { mode: 0o600 },
  );

  const collected = observation({
    tag: {
      name: "v1.1.0",
      exists: true,
      object_sha: fixture.targetSha,
      target_sha: fixture.targetSha,
    },
    merged_pull_requests: [
      {
        number: 7,
        merge_sha: fixture.mergeSha,
        merge_parents: git(
          fixture.repository,
          "rev-list",
          "-n",
          "1",
          "--parents",
          fixture.mergeSha,
        )
          .split(" ")
          .slice(1),
      },
    ],
  });
  const observationPath = path.join(fixture.root, "observation.json");
  await fsp.writeFile(observationPath, JSON.stringify(collected));
  const args = [
    "--final",
    "--observation",
    observationPath,
    "--build-dir",
    buildDirectory,
    "--store",
    store,
  ];
  const withObservation = (replacement) =>
    args.map((value) => (value === observationPath ? replacement : value));

  const first = runVerifier(args, fixture.repository);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(first.report.record.status, "RECORDED");
  const recordPath = path.join(store, "releases", "42", "1.1.0.json");
  const record = JSON.parse(await fsp.readFile(recordPath, "utf8"));
  assert.equal(record.pull_requests[0].attestation.status, "MATCHED");
  assert.equal(
    record.pull_requests[0].attestation.attested_head_sha,
    fixture.attestedHead,
  );
  assert.equal((await fsp.stat(recordPath)).mode & 0o777, 0o600);

  // A fresh collection renews the provenance and nothing else, which is not
  // history divergence.
  const laterPath = path.join(fixture.root, "observation-2.json");
  await fsp.writeFile(
    laterPath,
    JSON.stringify({ ...collected, collected_at: "2026-03-01T00:00:00.000Z" }),
  );
  const rerun = runVerifier(withObservation(laterPath), fixture.repository);
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(rerun.report.record.status, "EQUAL");

  const supersedingPath = path.join(fixture.root, "observation-3.json");
  await fsp.writeFile(
    supersedingPath,
    JSON.stringify({
      ...collected,
      range: { kind: "TAG", tag: "v1.0.5", target_sha: PREVIOUS_TAG_SHA },
    }),
  );
  const superseded = runVerifier(
    withObservation(supersedingPath),
    fixture.repository,
  );
  assert.equal(superseded.report.record.status, "SUPERSEDED");

  const stored = JSON.parse(await fsp.readFile(recordPath, "utf8"));
  stored.tag.target_sha = "0".repeat(40);
  await fsp.writeFile(recordPath, JSON.stringify(stored), { mode: 0o600 });
  const diverged = runVerifier(args, fixture.repository);
  assert.equal(diverged.status, 1);
  assert.equal(diverged.report.record.status, "DIVERGED");
  assert.ok(
    diverged.report.failures.some(
      (entry) => entry.code === "RELEASE_RECORD_DIVERGED",
    ),
  );
});

test("a version whose tag does not exist reports that and needs no local build", async (t) => {
  const fixture = await releaseRepository();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const observationPath = path.join(fixture.root, "untagged.json");
  await fsp.writeFile(
    observationPath,
    JSON.stringify(observation({ tag: { name: "v1.1.0", exists: false } })),
  );
  const result = runVerifier(
    [
      "--final",
      "--observation",
      observationPath,
      "--store",
      path.join(fixture.root, "store"),
    ],
    fixture.repository,
  );
  assert.equal(result.status, 1);
  assert.deepEqual(
    result.report.failures.map((entry) => entry.code),
    ["TAG_MISSING"],
  );
  assert.equal(result.report.record, null);
});

test("a malformed observation file fails without a stack trace", async (t) => {
  const fixture = await releaseRepository();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const observationPath = path.join(fixture.root, "broken.json");
  await fsp.writeFile(observationPath, JSON.stringify({ schema: "wrong" }));
  const result = runVerifier(
    [
      "--final",
      "--observation",
      observationPath,
      "--store",
      path.join(fixture.root, "store"),
    ],
    fixture.repository,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^OBSERVATION_MALFORMED: /);
});
