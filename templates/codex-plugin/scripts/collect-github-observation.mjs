#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defaultStoreRoot } from "../server/core.mjs";
import { collectGithubObservation } from "../server/github-observation.mjs";
import { atomicWriteFile } from "../server/storage.mjs";

const USAGE = `Usage: collect-github-observation.mjs [publication.json]
       collect-github-observation.mjs --review-id <id> [--out <path>]

  --review-id <id>  Read the publication ledger straight from the store instead
                    of a get_publication result pasted through the model. The
                    observation is written to the private store next to the
                    ledger, and only a receipt is printed; pass the printed
                    observation_path to record_github_snapshot. Never retype
                    the observation itself.
  --publication <p> Read the ledger from an explicit file.
  --out <path>      Override the observation file location. Refused inside any
                    Git worktree: an untracked observation would dirty the
                    reviewed repository and fail publication-gate verification.

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
  const result = spawnSync("git", ["-C", probe, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status === 0) {
    process.stderr.write(
      `refusing to write the observation inside the Git worktree at ${result.stdout.trim()}; omit --out to use the private store, or choose a path outside any repository\n`,
    );
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
  const out =
    explicitOut ??
    (reviewDirectory == null
      ? null
      : path.join(reviewDirectory, "observation.json"));
  if (explicitOut != null) {
    // Fail fast, before any GitHub traffic is spent on a doomed run.
    await assertOutsideGitWorktree(path.resolve(explicitOut));
  }

  const publicationPath =
    reviewDirectory != null
      ? path.join(reviewDirectory, "publication.json")
      : (explicitPublication ?? positional ?? null);

  const input =
    publicationPath == null
      ? await readStdin()
      : await readFile(publicationPath, "utf8");

  const observation = collectGithubObservation(JSON.parse(input));

  if (out == null) {
    process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
  } else {
    const serialized = `${JSON.stringify(observation)}\n`;
    const resolved = path.resolve(out);
    // Atomic replace through a fresh 0600 temp file: writeFile's mode option
    // is ignored when the target already exists, so reusing an --out path
    // must not inherit that file's old permissions.
    await atomicWriteFile(resolved, serialized);
    process.stdout.write(
      `${JSON.stringify(
        {
          observation_path: resolved,
          bytes: Buffer.byteLength(serialized),
          sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
          observed_at: observation.observed_at ?? null,
          head_sha: observation.pull_request?.head_sha ?? null,
        },
        null,
        2,
      )}\n`,
    );
  }
}
