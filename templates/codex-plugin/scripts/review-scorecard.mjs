#!/usr/bin/env node

import { defaultStoreRoot } from "../server/core.mjs";
import { buildScorecard, renderScorecardMarkdown } from "../server/scorecard.mjs";

const USAGE = `Usage: review-scorecard.mjs [--json] [--since <time>] [--until <time>]
                            [--repository <path>] [--review-type gate|advisory]
                            [--strategy FULL|SUCCESSOR]

  Aggregate the review and workflow ledgers in the configured store into one
  report: findings by severity, author dispositions crossed with reviewer
  decisions, rebuttal outcomes before and after the verification obligation,
  rounds to CLEAN, continuations, workflow budget events, and human
  arbitration escalations. Every counting rule is stated in the report.

  --json               Emit schema-versioned JSON instead of markdown.
  --since <time>       Include review.created_at >= this UTC instant.
  --until <time>       Include review.created_at < this UTC instant.
                       Use YYYY-MM-DD (UTC midnight), or an ISO timestamp
                       with seconds, optional milliseconds and Z/offset,
                       e.g. 2026-09-01T08:00:00+08:00.
                       When both are set, since must be earlier than until.
  --repository <path>  Match the persisted repository_path string exactly;
                       no path resolution or existing worktree is required.
  --review-type <type> Select gate or advisory; missing advisory means gate.
  --strategy <mode>    Select FULL or SUCCESSOR; missing strategy means FULL.

  Filters combine with AND and apply only to reviews. With any filter,
  workflow/audit statistics are omitted, with an explanation in the output.
  Without filters, existing review and workflow counting scopes are retained.

  Read-only: nothing is written, and a ledger that does not parse is listed
  under Skipped rather than repaired. The store is the one the servers use;
  set REVIEW_BRIDGE_HOME to point at another.
`;

const argv = process.argv.slice(2);
const valueOptions = new Map([
  ["--since", "since"],
  ["--until", "until"],
  ["--repository", "repository"],
  ["--review-type", "reviewType"],
  ["--strategy", "strategy"],
]);
try {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--help", "--json"].includes(arg)) continue;
    const key = valueOptions.get(arg);
    if (key == null) throw new Error(`unknown argument ${arg}`);
    if (key in options) throw new Error(`${arg} may only be specified once`);
    const value = argv[++index];
    if (value == null || value.startsWith("--")) {
      throw new Error(`${arg} needs a value`);
    }
    options[key] = value;
  }
  if (argv.includes("--help")) {
    process.stdout.write(USAGE);
  } else {
    const scorecard = await buildScorecard(defaultStoreRoot(), options);
    process.stdout.write(
      argv.includes("--json")
        ? `${JSON.stringify(scorecard, null, 2)}\n`
        : renderScorecardMarkdown(scorecard),
    );
  }
} catch (error) {
  process.stderr.write(`${error.message}\n${USAGE}`);
  process.exitCode = 2;
}
