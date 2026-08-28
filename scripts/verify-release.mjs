#!/usr/bin/env node

// The RFC 0004 release verifier. `--pre` runs the requirements the repository
// alone can answer, before the tag exists; `--final` reruns all of them against
// the peeled tag target and adds the published-release requirements, then
// appends one evidence record per version to the store.
//
// It reads. The operator tags, publishes, and merges.

import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { defaultStoreRoot } from "../src/core.mjs";
import { canonicalJsonBytes, readSecureJson } from "../src/storage.mjs";
import { digestOf, writeNoOverwrite } from "./release-store.mjs";
import { MAX_WORKFLOW_BYTES, WORKFLOW_ID_RE } from "../src/workflow-binding.mjs";
import {
  CHECKSUM_MANIFEST_NAME,
  compareReleaseRecords,
  compareVersions,
  cutoffVersion,
  normalizeReleaseObservation,
  parseVersion,
  verifyRelease,
  versionFromTagName,
} from "./release-evidence.mjs";

const USAGE = `Usage: verify-release.mjs --pre [--repo <path>]
       verify-release.mjs --final --observation <path> --build-dir <path> [options]

Verifies a release's claims against the repository and, in the final phase,
against collected GitHub facts and the store's workflow terminal records. A
passing final run appends releases/<repository-id>/<version>.json to the store.

  --pre                 Pre-flight phase: repository-only, safe to run in CI.
  --final               Final phase: requires the collected observation.
  --observation <path>  Observation from collect-release-observation.mjs.
  --build-dir <path>    Local "npm run build" output for the same tag. Required
                        unless the observation reports the tag as absent.
  --repo <path>         Git repository to read (default: cwd).
  --store <path>        Review Bridge store (default: REVIEW_BRIDGE_HOME).
`;

const MAX_RECORD_BYTES = 1024 * 1024;
const VERSION_CARRIERS = [
  "package.json",
  "CHANGELOG.md",
  "README.md",
  "SECURITY.md",
  "templates/codex-plugin/.codex-plugin/plugin.json",
  "templates/claude-extension/manifest.json",
];

function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    phase: null,
    repo: process.cwd(),
    store: null,
    observation: null,
    "build-dir": null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (flag === "--pre" || flag === "--final") {
      options.phase = flag === "--pre" ? "PRE" : "FINAL";
      continue;
    }
    const value = argv[index + 1];
    if (!["--repo", "--store", "--observation", "--build-dir"].includes(flag)) {
      usageError(`unknown argument ${flag}`);
    }
    if (value == null) {
      usageError(`${flag} requires a value`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (options.phase == null) {
    usageError("one of --pre or --final is required");
  }
  // --build-dir is demanded where it is actually used: a version whose tag does
  // not exist has no target to rebuild, and requiring one would make the
  // missing-tag report impossible to produce.
  if (options.phase === "FINAL" && options.observation == null) {
    usageError("--final requires --observation");
  }
  return options;
}

function git(repositoryPath, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

function readAt(repositoryPath, ref, files) {
  return Object.fromEntries(
    files.map((file) => [
      file,
      git(repositoryPath, ["show", `${ref}:${file}`], { allowFailure: true }),
    ]),
  );
}

// The marker is a repository-level fact, so it is always read from the default
// branch at verification time -- never from the historical text a tag carries,
// which a tag created before the marker existed cannot hold.
//
// The branch is resolved, never guessed. A clone that has no `origin/HEAD` --
// a CI checkout usually has none -- is asked of the remote instead, because
// substituting a likely name reports the marker missing whenever the guess is
// wrong, which names the wrong problem.
function defaultBranchChangelog(repositoryPath) {
  const symbolic = git(
    repositoryPath,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { allowFailure: true },
  )?.trim();
  const branch =
    symbolic?.replace(/^origin\//, "") ??
    /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(
      git(repositoryPath, ["ls-remote", "--symref", "origin", "HEAD"], {
        allowFailure: true,
      }) ?? "",
    )?.[1];
  if (branch == null) {
    usageError(
      `${repositoryPath} has no origin/HEAD and its remote names no default branch, so the pull-request reference cutoff cannot be read`,
    );
  }
  for (const ref of [`origin/${branch}`, branch]) {
    const text = git(repositoryPath, ["show", `${ref}:CHANGELOG.md`], {
      allowFailure: true,
    });
    if (text != null) {
      return text;
    }
  }
  usageError(
    `neither origin/${branch} nor ${branch} carries a CHANGELOG.md, so the pull-request reference cutoff cannot be read`,
  );
}

// Pre-flight discovery reads merge commits, so it assumes the merge-commit
// history the merge-integrity check already requires; a squash- or
// rebase-merged pull request is invisible to it, which is why an unfound claim
// is deferred rather than failed in this phase.
function localMergedPullRequests(repositoryPath, range) {
  const revisions =
    range.kind === "ROOT" ? ["HEAD"] : [`${range.tag}..HEAD`];
  const log = git(repositoryPath, [
    "log",
    "--first-parent",
    "--merges",
    "--format=%H %P%x09%s",
    ...revisions,
  ]);
  const pullRequests = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [shas, subject] = line.split("\t");
    const number = /^Merge pull request #(\d+) /.exec(subject ?? "")?.[1];
    if (number == null) {
      continue;
    }
    const [mergeSha, ...parents] = shas.split(" ");
    pullRequests.push({
      number: Number(number),
      merge_sha: mergeSha,
      merge_parents: parents,
    });
  }
  return pullRequests.sort((left, right) => left.number - right.number);
}

function localPreviousTag(repositoryPath, version) {
  const tags = git(repositoryPath, ["tag", "--list", "v*"])
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => {
      const tagged = versionFromTagName(name);
      return tagged != null && compareVersions(tagged, version) < 0;
    })
    .sort((left, right) =>
      compareVersions(versionFromTagName(left), versionFromTagName(right)),
    );
  const previous = tags.at(-1);
  return previous == null
    ? { kind: "ROOT" }
    : {
        kind: "TAG",
        tag: previous,
        target_sha: git(repositoryPath, ["rev-list", "-n", "1", previous]).trim(),
      };
}

/**
 * Terminal `MERGE_READY` records in the store, keyed by the pull request they
 * attest. Pure audit: frozen attestations read for comparison against observed
 * history, never evidence for a new write.
 */
async function collectAttestations(storeRoot, repositoryId) {
  const workflowsRoot = path.join(storeRoot, "workflows");
  let entries;
  try {
    entries = await fsp.readdir(workflowsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const attestations = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKFLOW_ID_RE.test(entry.name)) {
      continue;
    }
    const workflow = await readSecureJson(
      path.join(workflowsRoot, entry.name, "workflow.json"),
      { allowMissing: true, requiredMode: 0o600, maxBytes: MAX_WORKFLOW_BYTES },
    );
    const terminal = workflow?.terminal;
    if (
      terminal?.status !== "MERGE_READY" ||
      terminal.pull_request?.repository_id !== repositoryId
    ) {
      continue;
    }
    const number = terminal.pull_request.pr_number;
    const existing = attestations[number];
    if (existing == null) {
      attestations[number] = {
        workflow_id: entry.name,
        head_sha: terminal.head_sha,
      };
    } else if (
      existing.ambiguous === true ||
      existing.head_sha !== terminal.head_sha
    ) {
      // Two terminal records attesting different heads leave nothing to
      // compare against; picking one would decide by file order.
      attestations[number] = { ambiguous: true };
    }
  }
  return attestations;
}

/**
 * One record per version, appended once.
 *
 * The exclusive create is the decision, not a read beforehand: a read-then-write
 * leaves a window in which a second run creates the record between the two, and
 * the write is then the only thing that can answer. An existing record --
 * whenever it appeared -- is compared and reported, never overwritten.
 */
async function appendRecord(recordPath, record) {
  try {
    await writeNoOverwrite(recordPath, canonicalJsonBytes(record));
    return { status: "RECORDED", path: recordPath };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const existing = await readSecureJson(recordPath, {
    allowMissing: true,
    requiredMode: 0o600,
    maxBytes: MAX_RECORD_BYTES,
  });
  if (existing == null) {
    throw new Error(
      `${recordPath} existed and then vanished; nothing was written, so re-run`,
    );
  }
  return { ...compareReleaseRecords(existing, record), path: recordPath };
}

const options = parseArguments(process.argv.slice(2));
const repositoryPath = path.resolve(options.repo);
const storeRoot = options.store ? path.resolve(options.store) : defaultStoreRoot();
const verifierVersion = JSON.parse(
  await fsp.readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

let result;
let recordOutcome = null;
if (options.phase === "PRE") {
  const files = readAt(repositoryPath, "HEAD", VERSION_CARRIERS);
  const version = JSON.parse(files["package.json"] ?? "{}").version;
  if (parseVersion(version) == null) {
    usageError("HEAD carries no MAJOR.MINOR.PATCH package.json version");
  }
  const range = localPreviousTag(repositoryPath, version);
  result = verifyRelease({
    phase: "PRE",
    version,
    files,
    cutoff: cutoffVersion(defaultBranchChangelog(repositoryPath)),
    previousVersion:
      range.kind === "ROOT" ? null : versionFromTagName(range.tag),
    mergedPullRequests: localMergedPullRequests(repositoryPath, range),
  });
} else {
  let observation;
  try {
    observation = normalizeReleaseObservation(
      JSON.parse(await fsp.readFile(path.resolve(options.observation), "utf8")),
    );
  } catch (error) {
    process.stderr.write(`OBSERVATION_MALFORMED: ${error.message}\n`);
    process.exit(1);
  }
  const observationBytes = await fsp.readFile(path.resolve(options.observation));
  const target = observation.tag.exists ? observation.tag.target_sha : "HEAD";
  const files = readAt(repositoryPath, target, VERSION_CARRIERS);
  if (observation.tag.exists && files["package.json"] == null) {
    usageError(
      `${repositoryPath} does not contain ${target}; fetch the release tag first`,
    );
  }
  const manifestPath =
    options["build-dir"] == null
      ? null
      : path.join(path.resolve(options["build-dir"]), CHECKSUM_MANIFEST_NAME);
  const localManifest =
    manifestPath == null
      ? null
      : await fsp.readFile(manifestPath, "utf8").catch(() => null);
  if (observation.tag.exists && localManifest == null) {
    usageError(
      `--build-dir must name a directory holding ${CHECKSUM_MANIFEST_NAME}; run npm run build at ${observation.tag.name} first`,
    );
  }
  result = verifyRelease({
    phase: "FINAL",
    version: observation.version,
    files,
    cutoff: cutoffVersion(defaultBranchChangelog(repositoryPath)),
    previousVersion:
      observation.range?.kind === "TAG"
        ? versionFromTagName(observation.range.tag)
        : null,
    mergedPullRequests: observation.merged_pull_requests ?? [],
    observation,
    localManifest,
    attestations: await collectAttestations(storeRoot, observation.repository.id),
    observationRef: {
      path: path.resolve(options.observation),
      sha256: digestOf(observationBytes),
    },
    verifierVersion,
  });
  if (result.record != null) {
    const recordPath = path.join(
      storeRoot,
      "releases",
      String(observation.repository.id),
      `${observation.version}.json`,
    );
    recordOutcome = await appendRecord(recordPath, result.record);
    if (recordOutcome.status === "DIVERGED") {
      result.status = "FAILED";
      result.failures.push({
        code: "RELEASE_RECORD_DIVERGED",
        message: recordOutcome.message,
      });
    }
  }
}

const passed = result.status === "PASSED";
process.stdout.write(
  `${JSON.stringify(
    {
      phase: result.phase,
      status: result.status,
      reconciliation: result.reconciliation ?? null,
      failures: result.failures,
      deferred: result.deferred,
      notes: result.notes,
      record: recordOutcome,
    },
    null,
    2,
  )}\n`,
);
process.exit(passed ? 0 : 1);
