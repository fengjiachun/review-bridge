#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultStoreRoot } from "../server/core.mjs";
import { collectGithubObservation } from "../server/github-observation.mjs";
import { atomicWriteFile } from "../server/storage.mjs";

const USAGE = `Usage: collect-github-observation.mjs [publication.json]
       collect-github-observation.mjs --review-id <id> --out <path>

  --review-id <id>  Read the publication ledger straight from the store instead
                    of a get_publication result pasted through the model.
  --publication <p> Read the ledger from an explicit file.
  --out <path>      Write the observation to a file and print only a receipt.
                    Pass that path to record_github_snapshot as
                    observation_path; never retype the observation itself.

With neither --review-id nor a path, the ledger is read from stdin and the
observation is written to stdout.
`;

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
  const out = option(argv, "out");
  // A bare path stays supported, but only when no flag is in play, so a flag
  // value is never mistaken for one.
  const positional = argv.some((arg) => arg.startsWith("--")) ? null : argv[0];

  if (reviewId != null && !/^rb-[0-9TZ-]+-[a-f0-9]{8}$/.test(reviewId)) {
    process.stderr.write("invalid --review-id\n");
    process.exit(2);
  }

  const publicationPath =
    reviewId != null
      ? path.join(defaultStoreRoot(), "reviews", reviewId, "publication.json")
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
