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
import {
  digestOf,
  writeContentAddressed,
  writeNoOverwrite,
} from "../scripts/release-store.mjs";
import {
  assertRangeComplete,
  mergedPullRequestsIn,
  selectPreviousTag,
  tagIsReachable,
} from "../scripts/collect-release-observation.mjs";

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
  // The cutoff marker is read from the default branch, which the verifier
  // resolves rather than guesses, so the fixture carries the remote refs a
  // clone has.
  git(repository, "remote", "add", "origin", repository);
  git(repository, "update-ref", "refs/remotes/origin/main", "main");
  git(
    repository,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
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

test("an unresolvable default branch is named, never guessed", async (t) => {
  const fixture = await releaseRepository();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  // A repository whose default branch cannot be resolved must say so. Guessing
  // a likely name reports the cutoff marker missing whenever the guess is
  // wrong, which names a problem the operator does not have.
  git(fixture.repository, "remote", "remove", "origin");
  git(fixture.repository, "update-ref", "-d", "refs/remotes/origin/HEAD");
  const result = runVerifier(["--pre"], fixture.repository);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /remote names no default branch/);
});

test("the content-addressed write never replaces the bytes it stored", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-store-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "observations");
  const bytes = Buffer.from('{"observation":1}\n', "utf8");

  const first = await writeContentAddressed(directory, bytes);
  assert.equal(first.reused, false);
  assert.equal(path.basename(first.path), `${digestOf(bytes)}.json`);
  assert.deepEqual(await fsp.readFile(first.path), bytes);
  assert.equal((await fsp.stat(first.path)).mode & 0o777, 0o600);

  // Identical content is idempotent, because the name is the content.
  const again = await writeContentAddressed(directory, bytes);
  assert.deepEqual(
    { path: again.path, sha256: again.sha256, reused: again.reused },
    { path: first.path, sha256: first.sha256, reused: true },
  );

  // A different collection lands under its own name rather than over this one.
  const other = Buffer.from('{"observation":2}\n', "utf8");
  const second = await writeContentAddressed(directory, other);
  assert.notEqual(second.path, first.path);
  assert.deepEqual(await fsp.readFile(first.path), bytes);

  // A file that no longer hashes to its name is not the evidence the name
  // claims, so it is refused rather than reported as an idempotent re-run.
  await fsp.writeFile(first.path, "damaged", { mode: 0o600 });
  await assert.rejects(
    writeContentAddressed(directory, bytes),
    /does not hash to the name it is stored under/,
  );
});

test("writeNoOverwrite refuses an existing path", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-store-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "nested", "record.json");
  await writeNoOverwrite(target, Buffer.from("first", "utf8"));
  await assert.rejects(
    writeNoOverwrite(target, Buffer.from("second", "utf8")),
    (error) => error.code === "EEXIST",
  );
  assert.equal(await fsp.readFile(target, "utf8"), "first");
});

test("a merged pull request belongs to the range by the commit its merge produced", () => {
  const commit = (sha, ...parents) => ({
    sha,
    parents: parents.map((parent) => ({ sha: parent })),
  });
  const commits = [
    commit("m1", "base", "head1"),
    commit("s2", "m1"),
    commit("side", "m1"),
  ];
  const pulls = new Map([
    // A merge commit: the second parent is the head its workflow attested.
    ["m1", [{ number: 1, title: "merged", merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "m1" }]],
    // A squash merge leaves one commit, which is still the merge GitHub
    // reports, so local merge-commit discovery would miss it and this must not.
    ["s2", [{ number: 2, title: "squashed", merged_at: "2026-01-02T00:00:00Z", merge_commit_sha: "s2" }]],
    // Reachable from the range but merged somewhere else: not in the range.
    ["side", [{ number: 3, title: "elsewhere", merged_at: "2026-01-03T00:00:00Z", merge_commit_sha: "outside" }]],
  ]);
  assert.deepEqual(
    mergedPullRequestsIn(commits, pulls).map((entry) => [
      entry.number,
      entry.merge_sha,
      entry.merge_parents,
    ]),
    [
      [1, "m1", ["base", "head1"]],
      [2, "s2", ["m1"]],
    ],
  );
  // An unmerged pull request, and one seen twice, each resolve to nothing new.
  assert.deepEqual(
    mergedPullRequestsIn(
      [commit("m1", "base", "head1")],
      new Map([
        [
          "m1",
          [
            { number: 4, merged_at: null, merge_commit_sha: "m1" },
            { number: 1, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "m1" },
            { number: 1, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "m1" },
          ],
        ],
      ]),
    ).map((entry) => entry.number),
    [1],
  );
});

test("the range boundary is the previous tag by version, not by listing order", () => {
  const tags = [
    { name: "v0.10.0", commit: { sha: "a" } },
    { name: "v0.9.0", commit: { sha: "b" } },
    { name: "not-a-version", commit: { sha: "c" } },
    { name: "v0.2.0", commit: { sha: "d" } },
  ];
  assert.deepEqual(selectPreviousTag(tags, "1.0.0"), {
    kind: "TAG",
    tag: "v0.10.0",
    target_sha: "a",
  });
  // 0.9.0 sorts after 0.10.0 lexically and before it by version.
  assert.deepEqual(selectPreviousTag(tags, "0.10.0"), {
    kind: "TAG",
    tag: "v0.9.0",
    target_sha: "b",
  });
  assert.deepEqual(selectPreviousTag(tags, "0.1.0"), { kind: "ROOT" });
  assert.deepEqual(selectPreviousTag([], "1.0.0"), { kind: "ROOT" });
});

test("a range walk that cannot account for its own total is refused", () => {
  const commits = [{ sha: "a" }, { sha: "b" }];
  assert.deepEqual(assertRangeComplete(commits, 2, "range"), commits);
  assert.throws(
    () => assertRangeComplete(commits, 3, "the range v1...v2"),
    /the range v1\.\.\.v2 holds 3 commits but the walk collected 2/,
  );
  assert.throws(
    () => assertRangeComplete(commits, undefined, "range"),
    /reported no commit total/,
  );
});

test("reachability accepts only the two statuses that prove descent", () => {
  assert.equal(tagIsReachable("ahead"), true);
  assert.equal(tagIsReachable("identical"), true);
  assert.equal(tagIsReachable("behind"), false);
  assert.equal(tagIsReachable("diverged"), false);
  assert.equal(tagIsReachable(undefined), false);
});

test("the collector refuses malformed arguments before reaching GitHub", () => {
  const collector = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    "scripts",
    "collect-release-observation.mjs",
  );
  const run = (args) =>
    spawnSync(process.execPath, [collector, ...args], { encoding: "utf8" });
  assert.equal(run(["--version", "nope"]).status, 2);
  assert.match(run(["--version", "nope"]).stderr, /MAJOR\.MINOR\.PATCH/);
  assert.equal(run([]).status, 2);
  assert.equal(run(["--bogus", "x"]).status, 2);
  assert.match(run(["--bogus", "x"]).stderr, /unknown argument --bogus/);
  assert.equal(run(["--version"]).status, 2);
  assert.match(run(["--version"]).stderr, /--version requires a value/);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: collect-release-observation\.mjs/);
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
