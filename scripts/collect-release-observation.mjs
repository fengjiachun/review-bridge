#!/usr/bin/env node

// Read-only collector for the release facts RFC 0004 verifies against: the
// merged pull requests of the release range, the tag object, and the published
// release's assets. It performs no release action and writes nothing but the
// observation, whose filename is its own content digest.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultStoreRoot } from "../src/core.mjs";
import { canonicalJsonBytes, sha256 } from "../src/storage.mjs";
import { writeContentAddressed } from "./release-store.mjs";
import {
  CHECKSUM_MANIFEST_NAME,
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

// The range's commit set, proven complete. A walk that cannot account for
// every commit the comparison counted is refused rather than silently
// truncated: an unseen commit is an unseen merged pull request.
export function assertRangeComplete(commits, total, label) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`${label} reported no commit total`);
  }
  if (commits.length !== total) {
    throw new Error(
      `${label} holds ${total} commits but the walk collected ${commits.length}`,
    );
  }
  return commits;
}

/**
 * GitHub's merged-pull-request facts are the authoritative discovery: a pull
 * request belongs to the range exactly when the commit its merge produced is
 * in the range, which holds for the squash and rebase merges that leave no
 * merge commit behind for local history to find.
 *
 * Pure over the fetched pages so the membership rule, the deduplication, and
 * the merge-parent lookup that the record's merge-integrity check reads are
 * decidable from fixtures.
 */
export function mergedPullRequestsIn(commits, pullsByCommitSha) {
  const parentsBySha = new Map(
    commits.map((commit) => [
      commit.sha,
      commit.parents.map((parent) => parent.sha),
    ]),
  );
  const byNumber = new Map();
  for (const commit of commits) {
    for (const pullRequest of pullsByCommitSha.get(commit.sha) ?? []) {
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

// The previous extant tag by version order, never by the order GitHub lists
// them. No earlier tag means the range starts at the repository root.
export function selectPreviousTag(tags, version) {
  const previous = tags
    .map((tag) => ({ name: tag.name, sha: tag.commit?.sha }))
    .filter((tag) => {
      const tagged = versionFromTagName(tag.name);
      return tagged != null && compareVersions(tagged, version) < 0;
    })
    .sort((left, right) =>
      compareVersions(
        versionFromTagName(left.name),
        versionFromTagName(right.name),
      ),
    )
    .at(-1);
  return previous == null
    ? { kind: "ROOT" }
    : { kind: "TAG", tag: previous.name, target_sha: previous.sha };
}

// Compare reads from the tag's viewpoint, so IDENTICAL or AHEAD means every
// commit the tag carries is reachable from the default branch.
export function tagIsReachable(comparisonStatus) {
  return ["ahead", "identical"].includes(String(comparisonStatus ?? ""));
}

// A comparison is page-bounded, so the range is walked to its reported total
// rather than read from one response. A release whose range outgrows a single
// page is exactly the case the RFC anticipates when an intermediate tag is
// missing.
const MAX_COMPARE_PAGES = 30;

function comparedCommits(nameWithOwner, cwd, base, head, label) {
  const commits = [];
  let total = null;
  for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
    const comparison = gh(
      `/repos/${nameWithOwner}/compare/${base}...${head}?per_page=100&page=${page}`,
      cwd,
    );
    total = comparison.total_commits;
    commits.push(...comparison.commits);
    if (comparison.commits.length === 0 || commits.length >= total) {
      break;
    }
  }
  return assertRangeComplete(commits, total, label);
}

function rangeCommits(nameWithOwner, cwd, range, targetSha) {
  return range.kind === "ROOT"
    ? ghPaged(
        `/repos/${nameWithOwner}/commits?sha=${targetSha}&per_page=100`,
        cwd,
      )
    : comparedCommits(
        nameWithOwner,
        cwd,
        range.target_sha,
        targetSha,
        `the range ${range.tag}...${targetSha}`,
      );
}

function pullsByCommit(nameWithOwner, cwd, commits) {
  return new Map(
    commits.map((commit) => [
      commit.sha,
      gh(`/repos/${nameWithOwner}/commits/${commit.sha}/pulls`, cwd),
    ]),
  );
}

async function main() {
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
    const range = selectPreviousTag(
      ghPaged(`/repos/${nameWithOwner}/tags?per_page=100`, repositoryPath),
      version,
    );
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
      tag_reachable_from_default_branch: tagIsReachable(reachability.status),
      range,
      merged_pull_requests: mergedPullRequestsIn(
        commits,
        pullsByCommit(nameWithOwner, repositoryPath, commits),
      ),
      release:
        release == null
          ? { exists: false }
          : (() => {
              // Each asset is hashed as it arrives, so only one download is
              // ever held at a time; the manifest alone keeps its bytes,
              // because its text is a published fact the verifier judges
              // payload assets against and it travels in the observation
              // rather than being re-fetched at verification time.
              let manifestText = null;
              const assets = release.assets
                .map((asset) => {
                  const bytes = ghBytes(
                    `/repos/${nameWithOwner}/releases/assets/${asset.id}`,
                    repositoryPath,
                  );
                  if (asset.name === CHECKSUM_MANIFEST_NAME) {
                    manifestText = bytes.toString("utf8");
                  }
                  return {
                    name: asset.name,
                    size: asset.size,
                    sha256: sha256(bytes),
                  };
                })
                .sort((left, right) => left.name.localeCompare(right.name));
              return {
                exists: true,
                id: release.id,
                published_at: release.published_at,
                ...(manifestText == null
                  ? {}
                  : { checksum_manifest_text: manifestText }),
                assets,
              };
            })(),
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
}

// Only when run as the command. Imported, this module is the pure discovery
// logic above and nothing else runs, so a test can exercise the rules the
// record pins without reaching GitHub.
if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
