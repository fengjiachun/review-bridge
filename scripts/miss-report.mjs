#!/usr/bin/env node
// Pairs a pull request's remote review threads with the local review ledgers
// for the heads those threads were written against (#203). Read-only. The
// output is a projection for analysis, not evidence, and no gate reads it.

import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultStoreRoot, repositoryIdentity } from "../src/core.mjs";

const USAGE = `Usage: miss-report.mjs <owner/name> <pull-request> --repository <path>
                       [--store <path>] [--json]

  List the review threads on a pull request that its author did not open,
  each beside the local reviews whose round captured the thread's head.

  --repository <path>  Local checkout of <owner/name>. A review matches when
                       its repository_path is a worktree of that repository;
                       one whose path is gone is kept and marked unverified.
  --store <path>       Store root. Defaults to the store the servers use.
  --json               Emit the corpus (full threads, matching review ids
                       and snapshot hashes) instead of the table.
`;

function ghApi(endpoint, { paginate = false } = {}) {
  const args = paginate
    ? ["api", "--paginate", "--slurp", endpoint]
    : ["api", endpoint];
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 2 ** 28 });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

async function readReviews(storeRoot) {
  const root = path.join(storeRoot, "reviews");
  const reviews = [];
  const skipped = [];
  for (const id of (await fsp.readdir(root)).sort()) {
    try {
      const review = JSON.parse(
        await fsp.readFile(path.join(root, id, "review.json"), "utf8"),
      );
      if (!Array.isArray(review.rounds)) throw new Error("no rounds");
      reviews.push({ id, review });
    } catch (error) {
      // An entry without a review ledger is a remote-only publication or a
      // stray file, not a damaged review.
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) skipped.push(id);
    }
  }
  return { reviews, skipped };
}

export async function buildMissReport({
  repository,
  pullRequest,
  repositoryPath,
  storeRoot = defaultStoreRoot(),
  api = ghApi,
}) {
  const pull = api(`repos/${repository}/pulls/${pullRequest}`);
  // --paginate --slurp yields one array per page.
  const comments = api(
    `repos/${repository}/pulls/${pullRequest}/comments?per_page=100`,
    { paginate: true },
  ).flat();
  if (comments.length !== pull.review_comments) {
    throw new Error(
      `fetched ${comments.length} review comments but the pull request reports ${pull.review_comments}`,
    );
  }
  const identity = await repositoryIdentity(repositoryPath);
  const { reviews, skipped } = await readReviews(storeRoot);

  const threads = [];
  for (const root of comments) {
    if (root.in_reply_to_id != null || root.user?.login === pull.user.login) {
      continue;
    }
    const head = root.original_commit_id;
    const matches = [];
    for (const { id, review } of reviews) {
      const round = review.rounds.find((entry) => entry.head_sha === head);
      if (round == null) continue;
      // null: the ledger's checkout is gone, so its identity cannot be read.
      const same = await repositoryIdentity(review.repository_path).then(
        (found) => found === identity,
        () => null,
      );
      if (same === false) continue;
      matches.push({
        review_id: id,
        status: review.status,
        findings: Array.isArray(review.findings) ? review.findings.length : 0,
        snapshot_hash: round.snapshot_hash,
        repository_verified: same === true,
      });
    }
    threads.push({
      id: root.id,
      url: root.html_url,
      author: root.user?.login ?? null,
      path: root.path,
      line: root.line ?? root.original_line ?? null,
      head,
      body: root.body,
      replies: comments
        .filter((reply) => reply.in_reply_to_id === root.id)
        .map((reply) => ({
          id: reply.id,
          author: reply.user?.login ?? null,
          body: reply.body,
        })),
      matches,
    });
  }
  return {
    repository,
    pull_request: {
      number: pull.number,
      url: pull.html_url,
      author: pull.user.login,
      head: pull.head.sha,
    },
    threads,
    skipped_reviews: skipped,
  };
}

export function renderMissReportMarkdown(report) {
  const lines = [
    `# Miss report: ${report.repository}#${report.pull_request.number}`,
    "",
    `${report.threads.length} review threads not opened by the pull request author (${report.pull_request.author}).`,
    "A projection of GitHub and the local store for analysis; it is not evidence and nothing gates on it.",
    "",
    "| Thread | Author | Location | Head | Local reviews (status, findings) |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const thread of report.threads) {
    const matches =
      thread.matches.length === 0
        ? "no local ledger for this head"
        : thread.matches
            .map(
              (match) =>
                `\`${match.review_id}\` (${match.status}, ${match.findings}${
                  match.repository_verified ? "" : ", repository unverified"
                })`,
            )
            .join("<br>");
    lines.push(
      `| [${thread.id}](${thread.url}) | ${thread.author} | ${`${thread.path}:${
        thread.line ?? "?"
      }`.replaceAll("|", "\\|")} | \`${thread.head.slice(0, 10)}\` | ${matches} |`,
    );
  }
  if (report.skipped_reviews.length > 0) {
    lines.push(
      "",
      `Skipped ${report.skipped_reviews.length} unreadable review ledgers: ${report.skipped_reviews.join(", ")}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let input;
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        repository: { type: "string" },
        store: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const [repository, pullRequest] = positionals;
    if (
      positionals.length !== 2 ||
      !/^[^/\s]+\/[^/\s]+$/.test(repository) ||
      !/^[1-9]\d*$/.test(pullRequest) ||
      values.repository == null
    ) {
      throw new Error(
        "expected <owner/name>, a pull request number, and --repository",
      );
    }
    input = {
      repository,
      pullRequest: Number(pullRequest),
      repositoryPath: values.repository,
      storeRoot: values.store ?? defaultStoreRoot(),
      json: values.json === true,
    };
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const report = await buildMissReport(input);
  process.stdout.write(
    input.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMissReportMarkdown(report),
  );
}
