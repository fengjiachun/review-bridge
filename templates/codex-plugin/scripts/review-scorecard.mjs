#!/usr/bin/env node

import { defaultStoreRoot } from "../server/core.mjs";
import { buildScorecard, renderScorecardMarkdown } from "../server/scorecard.mjs";

const USAGE = `Usage: review-scorecard.mjs [--json]

  Aggregate the review and workflow ledgers in the configured store into one
  report: findings by severity, author dispositions crossed with reviewer
  decisions, rebuttal outcomes before and after the verification obligation,
  rounds to CLEAN, continuations, workflow budget events, and human
  arbitration escalations. Every counting rule is stated in the report.

  --json  Emit the aggregate as JSON instead of markdown.

  Read-only: nothing is written, and a ledger that does not parse is listed
  under Skipped rather than repaired. The store is the one the servers use;
  set REVIEW_BRIDGE_HOME to point at another.
`;

const argv = process.argv.slice(2);
const unknown = argv.filter((arg) => !["--help", "--json"].includes(arg));
if (unknown.length > 0) {
  process.stderr.write(`unknown argument ${unknown[0]}\n${USAGE}`);
  process.exit(2);
}

if (argv.includes("--help")) {
  process.stdout.write(USAGE);
} else {
  const scorecard = await buildScorecard(defaultStoreRoot());
  process.stdout.write(
    argv.includes("--json")
      ? `${JSON.stringify(scorecard, null, 2)}\n`
      : renderScorecardMarkdown(scorecard),
  );
}
