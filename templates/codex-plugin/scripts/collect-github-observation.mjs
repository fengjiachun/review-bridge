#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defaultStoreRoot, requireRecordVersion } from "../server/core.mjs";
import {
  collectCodexBaseline,
  collectGithubObservation,
} from "../server/github-observation.mjs";
import { assertOutsideGitRepository } from "../server/local-reviewer.mjs";
import {
  readPublicationStartAuthorization,
  SUPPORTED_PUBLICATION_VERSIONS,
} from "../server/publication.mjs";
import { atomicWriteFile } from "../server/storage.mjs";

const USAGE = `Usage: collect-github-observation.mjs [publication.json]
       collect-github-observation.mjs --review-id <id> [--out <path>]
       collect-github-observation.mjs --baseline --review-id <id> --repo <owner/name>
                                      --pr <n> --codex-actor-id <n> [--out <path>]

  --review-id <id>  Read the publication ledger straight from the store instead
                    of a get_publication result pasted through the model. The
                    observation is written to the private store next to the
                    ledger, and only a receipt is printed; pass the printed
                    observation_path to record_github_snapshot. Never retype
                    the observation itself.
  --publication <p> Read the ledger from an explicit file.
  --baseline        Collect the preexisting Codex baseline start_publication
                    needs, before any ledger exists. The head is read from the
                    review's local gate or remote-only authorization in the
                    store and must equal the pull request's head. --repo,
                    --pr, and --codex-actor-id (the pinned Codex Bot's
                    numeric ID) are required. The baseline is written to the
                    private store next to the review, and only a receipt is
                    printed; pass the printed codex_review_baseline_path to
                    start_publication.
  --out <path>      Override the output file location. Refused inside any
                    Git worktree: an untracked file would dirty the reviewed
                    repository and fail publication-gate verification.

With neither --review-id nor a path, the ledger is read from stdin and the
observation is written to stdout.
`;

// The store is 0700 and never a Git worktree, so the default output location
// cannot dirty a reviewed repository. An explicit --out must uphold the same
// property, checked against the nearest existing ancestor directory.
async function assertOutsideGitWorktree(resolved) {
  let probe = path.dirname(resolved);
  for (;;) {
    try {
      await stat(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        break;
      }
      probe = parent;
    }
  }
  try {
    assertOutsideGitRepository(
      probe,
      "output file",
      "omit --out to use the private store, or choose a path outside any repository",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}

function option(argv, name) {
  const equals = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (equals) {
    return equals.slice(`--${name}=`.length);
  }
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function positiveInteger(argv, name) {
  const value = option(argv, name);
  const parsed = Number(value);
  if (value == null || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed)) {
    process.stderr.write(`--${name} must be a positive safe integer\n`);
    process.exit(2);
  }
  return parsed;
}

async function writeReceipt(out, value, receipt) {
  const serialized = `${JSON.stringify(value)}\n`;
  const resolved = path.resolve(out);
  // Atomic replace through a fresh 0600 temp file: writeFile's mode option
  // is ignored when the target already exists, so reusing an --out path
  // must not inherit that file's old permissions.
  await atomicWriteFile(resolved, serialized);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...receipt(resolved),
        bytes: Buffer.byteLength(serialized),
        sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
      },
      null,
      2,
    )}\n`,
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

const argv = process.argv.slice(2);

if (argv[0] === "--help") {
  process.stdout.write(USAGE);
} else {
  const reviewId = option(argv, "review-id");
  const explicitPublication = option(argv, "publication");
  const explicitOut = option(argv, "out");
  // A bare path stays supported, but only when no flag is in play, so a flag
  // value is never mistaken for one.
  const positional = argv.some((arg) => arg.startsWith("--")) ? null : argv[0];

  if (reviewId != null && !/^rb-[0-9TZ-]+-[a-f0-9]{8}$/.test(reviewId)) {
    process.stderr.write("invalid --review-id\n");
    process.exit(2);
  }

  const reviewDirectory =
    reviewId == null
      ? null
      : path.join(defaultStoreRoot(), "reviews", reviewId);
  const baselineMode = argv.includes("--baseline");
  if (baselineMode && reviewId == null) {
    process.stderr.write("--baseline requires --review-id\n");
    process.exit(2);
  }
  const out =
    explicitOut ??
    (reviewDirectory == null
      ? null
      : path.join(
          reviewDirectory,
          baselineMode ? "codex-review-baseline.json" : "observation.json",
        ));
  if (explicitOut != null) {
    // Fail fast, before any GitHub traffic is spent on a doomed run.
    await assertOutsideGitWorktree(path.resolve(explicitOut));
  }

  if (baselineMode) {
    const repository = option(argv, "repo");
    if (repository == null || !/^[^/]+\/[^/]+$/.test(repository)) {
      process.stderr.write("--repo must be <owner/name>\n");
      process.exit(2);
    }
    const [owner, repo] = repository.split("/");
    const prNumber = positiveInteger(argv, "pr");
    const codexActorId = positiveInteger(argv, "codex-actor-id");
    const { head_sha: headSha } = await readPublicationStartAuthorization(
      defaultStoreRoot(),
      reviewId,
    );
    let baseline;
    try {
      baseline = collectCodexBaseline({
        owner,
        repo,
        prNumber,
        headSha,
        codexActorId,
      });
    } catch (error) {
      process.stderr.write(`no baseline written: ${error.message}\n`);
      process.exit(1);
    }
    await writeReceipt(out, baseline, (resolved) => ({
      codex_review_baseline_path: resolved,
      observed_at: baseline.observed_at,
      head_sha: headSha,
      pr_number: prNumber,
    }));
  } else {
    const publicationPath =
      reviewDirectory != null
        ? path.join(reviewDirectory, "publication.json")
        : (explicitPublication ?? positional ?? null);

    const input =
      publicationPath == null
        ? await readStdin()
        : await readFile(publicationPath, "utf8");

    const publication = JSON.parse(input);
    requireRecordVersion(publication, "publication ledger", SUPPORTED_PUBLICATION_VERSIONS);
    const observation = collectGithubObservation(publication);

    if (out == null) {
      process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
    } else {
      await writeReceipt(out, observation, (resolved) => ({
        observation_path: resolved,
        observed_at: observation.observed_at ?? null,
        head_sha: observation.pull_request?.head_sha ?? null,
      }));
    }
  }
}
