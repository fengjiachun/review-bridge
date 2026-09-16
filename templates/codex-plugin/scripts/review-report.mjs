#!/usr/bin/env node

import path from "node:path";
import { defaultStoreRoot } from "../server/core.mjs";
import {
  loadReportLedgers,
  renderReviewBrief,
  renderReviewReport,
  reportRevision,
} from "../server/report.mjs";

const USAGE = `Usage: review-report.mjs <review_id> [--full] [--json] [--store <path>]

  Render one review's human-readable Markdown report from its ledger
  (review.json) and, when present, its publication ledger (publication.json);
  a REMOTE_ONLY publication, which has no review ledger, renders from its
  publication and authorization alone.

  By default it prints a brief: the terminal state and where the review goes
  next in the first two lines, a fact table, the findings still open before
  the ones already settled, the round-level facts, and a pointer to the full
  rendering. Every number in it is counted over the ledger; nothing is
  inferred across findings.

  --full          Print the full rendering instead: requirement and scope,
                  each round's findings with the author's disposition and the
                  rereviewer's decision, what changed between rounds, the
                  terminal state, and the pull request, Codex results,
                  checks, and threads a publication recorded. This is the
                  tier the author tool render_review_report writes, and the
                  one to read for an archive or a machine.
  --json          Emit {review_id, tier, revision, markdown} as JSON instead
                  of the Markdown itself.
  --store <path>  Read this store instead of the configured one.

  Every ledger is admitted by the reader the server itself uses: a
  publication must be canonical, name this review, and be bound to the gate
  or authorization file beside it, or the render fails with that reader's
  error and prints nothing.

  Both tiers read the same ledgers through that one reader and carry the same
  report revision in their footer; they differ only in depth.

  Read-only: nothing is written, not even the report file the author tool
  render_review_report writes beside the ledger. The store is the one the
  servers use; set REVIEW_BRIDGE_HOME or pass --store to point at another.
  The report is a projection of the ledger, not evidence.
`;

const argv = process.argv.slice(2);
let reviewId = null;
let json = false;
let full = false;
let store = null;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--help") {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg === "--json") {
    json = true;
  } else if (arg === "--full") {
    full = true;
  } else if (arg === "--store") {
    store = argv[index + 1];
    index += 1;
    if (store == null) {
      process.stderr.write(`--store needs a path\n${USAGE}`);
      process.exit(2);
    }
  } else if (arg.startsWith("--") || reviewId != null) {
    process.stderr.write(`unknown argument ${arg}\n${USAGE}`);
    process.exit(2);
  } else {
    reviewId = arg;
  }
}
if (reviewId == null) {
  process.stderr.write(`missing review_id\n${USAGE}`);
  process.exit(2);
}

const storeRoot = store == null ? defaultStoreRoot() : path.resolve(store);
let ledgers;
try {
  ledgers = await loadReportLedgers(storeRoot, reviewId);
} catch (error) {
  process.stderr.write(`${error.code ?? "ERROR"}: ${error.message}\n`);
  process.exit(1);
}
const { directory, review, publication, authorization, publicationSummary } = ledgers;
const render = full ? renderReviewReport : renderReviewBrief;
const markdown = render(review, {
  publication,
  authorization,
  publicationSummary,
  ledgerDirectory: directory,
});
process.stdout.write(
  json
    ? `${JSON.stringify(
        {
          review_id: reviewId,
          // Which depth these bytes are: the report revision names the ledgers
          // and the renderer format, and is the same in both tiers, so it
          // cannot tell the two documents apart on its own.
          tier: full ? "full" : "brief",
          revision: reportRevision(review, publication, publicationSummary),
          markdown,
        },
        null,
        2,
      )}\n`
    : markdown,
);
