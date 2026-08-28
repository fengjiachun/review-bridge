#!/usr/bin/env node

// Read-only collector for the release facts RFC 0004 verifies against: the
// merged pull requests of the release range, the tag object, and the published
// release's assets. It performs no release action and writes nothing but the
// observation, whose filename is its own content digest.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { defaultStoreRoot } from "../src/core.mjs";
import { canonicalJsonBytes, sha256 } from "../src/storage.mjs";
import { writeContentAddressed } from "./release-store.mjs";
import {
  compareVersions,
  normalizeReleaseObservation,
  parseVersion,
  RELEASE_OBSERVATION_SCHEMA,
  versionFromTagName,
} from "./release-evidence.mjs";

const USAGE = `Usage: collect-release-observation.mjs --version <x.y.z> [options]

Collects the GitHub facts of one release through the authenticated GitHub CLI
and writes them, content-addressed, into the Review Bridge store. Read-only:
it never tags, publishes, or merges.

  --version <x.y.z>   Release version to collect (required).
  --repo <path>       Git repository to resolve the remote from (default: cwd).
  --store <path>      Review Bridge store (default: REVIEW_BRIDGE_HOME).
`;

const MAX_ASSET_BYTES = 64 * 1024 * 1024;

function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { repo: process.cwd(), store: null, version: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!["--version", "--repo", "--store"].includes(flag)) {
      usageError(`unknown argument ${flag}`);
    }
    if (value == null) {
      usageError(`${flag} requires a value`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (parseVersion(options.version) == null) {
    usageError("--version must be MAJOR.MINOR.PATCH");
  }
  return options;
}

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_ASSET_BYTES,
  });
  if (result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

function gh(endpoint, cwd, options) {
  const stdout = run("gh", ["api", endpoint], cwd, options);
  return stdout == null ? null : JSON.parse(stdout);
}

// --paginate exhausts the Link chain and emits one JSON array per page.
function ghPaged(endpoint, cwd) {
  const stdout = run("gh", ["api", "--paginate", "--slurp", endpoint], cwd);
  return JSON.parse(stdout).flat();
}

function ghBytes(endpoint, cwd) {
  const result = spawnSync(
    "gh",
    ["api", "-H", "Accept: application/octet-stream", endpoint],
    { cwd, maxBuffer: MAX_ASSET_BYTES },
  );
  if (result.status !== 0) {
    throw new Error(
      `gh api ${endpoint} failed: ${String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

// The range's commit set, proven complete. A compare that cannot return every
// commit it counted is refused rather than silently truncated: an unseen
// commit is an unseen merged pull request.
function rangeCommits(nameWithOwner, cwd, range, targetSha) {
  if (range.kind === "ROOT") {
    return ghPaged(
      `/repos/${nameWithOwner}/commits?sha=${targetSha}&per_page=100`,
      cwd,
    );
  }
  const comparison = gh(
    `/repos/${nameWithOwner}/compare/${range.target_sha}...${targetSha}`,
    cwd,
  );
  if (comparison.total_commits !== comparison.commits.length) {
    throw new Error(
      `the range ${range.tag}...${targetSha} holds ${comparison.total_commits} commits; one comparison returns at most ${comparison.commits.length}`,
    );
  }
  return comparison.commits;
}

/**
 * GitHub's merged-pull-request facts are the authoritative discovery: a pull
 * request belongs to the range exactly when the commit its merge produced is
 * in the range, which holds for squash and rebase merges that leave no merge
 * commit behind for local history to find.
 */
function mergedPullRequests(nameWithOwner, cwd, commits) {
  const parentsBySha = new Map(
    commits.map((commit) => [
      commit.sha,
      commit.parents.map((parent) => parent.sha),
    ]),
  );
  const byNumber = new Map();
  for (const commit of commits) {
    for (const pullRequest of gh(
      `/repos/${nameWithOwner}/commits/${commit.sha}/pulls`,
      cwd,
    )) {
      if (
        pullRequest.merged_at == null ||
        !parentsBySha.has(pullRequest.merge_commit_sha) ||
        byNumber.has(pullRequest.number)
      ) {
        continue;
      }
      byNumber.set(pullRequest.number, {
        number: pullRequest.number,
        title: pullRequest.title,
        merged_at: pullRequest.merged_at,
        merge_sha: pullRequest.merge_commit_sha,
        merge_parents: parentsBySha.get(pullRequest.merge_commit_sha),
      });
    }
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

function previousExtantTag(nameWithOwner, cwd, version) {
  const candidates = ghPaged(`/repos/${nameWithOwner}/tags?per_page=100`, cwd)
    .map((tag) => ({ name: tag.name, sha: tag.commit.sha }))
    .filter((tag) => {
      const tagged = versionFromTagName(tag.name);
      return tagged != null && compareVersions(tagged, version) < 0;
    })
    .sort((left, right) =>
      compareVersions(
        versionFromTagName(left.name),
        versionFromTagName(right.name),
      ),
    );
  const previous = candidates.at(-1);
  return previous == null
    ? { kind: "ROOT" }
    : { kind: "TAG", tag: previous.name, target_sha: previous.sha };
}

const options = parseArguments(process.argv.slice(2));
const repositoryPath = path.resolve(options.repo);
const storeRoot = options.store ? path.resolve(options.store) : defaultStoreRoot();
const version = options.version;
const tagName = `v${version}`;
const nameWithOwner = run(
  "gh",
  ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
  repositoryPath,
).trim();
const repository = gh(`/repos/${nameWithOwner}`, repositoryPath);
const collectedAt = new Date().toISOString();
const tagRef = gh(
  `/repos/${nameWithOwner}/git/ref/tags/${tagName}`,
  repositoryPath,
  { allowFailure: true },
);

let observation;
if (tagRef == null) {
  observation = {
    schema: RELEASE_OBSERVATION_SCHEMA,
    collected_at: collectedAt,
    repository: { id: repository.id, full_name: repository.full_name },
    version,
    tag: { name: tagName, exists: false },
  };
} else {
  const targetSha =
    tagRef.object.type === "tag"
      ? gh(`/repos/${nameWithOwner}/git/tags/${tagRef.object.sha}`, repositoryPath)
          .object.sha
      : tagRef.object.sha;
  const reachability = gh(
    `/repos/${nameWithOwner}/compare/${targetSha}...${repository.default_branch}`,
    repositoryPath,
  );
  const range = previousExtantTag(nameWithOwner, repositoryPath, version);
  const commits = rangeCommits(nameWithOwner, repositoryPath, range, targetSha);
  const release = gh(
    `/repos/${nameWithOwner}/releases/tags/${tagName}`,
    repositoryPath,
    { allowFailure: true },
  );
  observation = {
    schema: RELEASE_OBSERVATION_SCHEMA,
    collected_at: collectedAt,
    repository: { id: repository.id, full_name: repository.full_name },
    version,
    default_branch: repository.default_branch,
    tag: {
      name: tagName,
      exists: true,
      object_sha: tagRef.object.sha,
      target_sha: targetSha,
    },
    tag_reachable_from_default_branch: ["ahead", "identical"].includes(
      reachability.status,
    ),
    range,
    merged_pull_requests: mergedPullRequests(
      nameWithOwner,
      repositoryPath,
      commits,
    ),
    release:
      release == null
        ? { exists: false }
        : {
            exists: true,
            id: release.id,
            published_at: release.published_at,
            assets: release.assets
              .map((asset) => ({
                name: asset.name,
                size: asset.size,
                sha256: sha256(
                  ghBytes(
                    `/repos/${nameWithOwner}/releases/assets/${asset.id}`,
                    repositoryPath,
                  ),
                ),
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          },
  };
}

const bytes = canonicalJsonBytes(normalizeReleaseObservation(observation));
const stored = await writeContentAddressed(
  path.join(storeRoot, "releases", String(repository.id), "observations"),
  bytes,
);

process.stdout.write(
  `${JSON.stringify(
    {
      observation_path: stored.path,
      store_relative_path: path.relative(storeRoot, stored.path),
      sha256: stored.sha256,
      reused: stored.reused,
      version,
      tag_exists: observation.tag.exists,
    },
    null,
    2,
  )}\n`,
);
