#!/usr/bin/env node

import path from "node:path";
import { defaultStoreRoot } from "../server/core.mjs";
import {
  loadReportLedgers,
  renderReviewReport,
  reportRevision,
} from "../server/report.mjs";

const USAGE = `Usage: review-report.mjs <review_id> [--json] [--store <path>]

  Render one review's human-readable Markdown report from its ledger
  (review.json) and, when present, its publication ledger (publication.json);
  a REMOTE_ONLY publication, which has no review ledger, renders from its
  publication and authorization alone. The report covers
  requirement and scope, each round's findings with the author's disposition
  and the rereviewer's decision, what changed between rounds, the terminal
  state, and the pull request, Codex results, checks, and threads a
  publication recorded. The footer names the ledger revisions rendered.

  --json          Emit {review_id, revision, markdown} as JSON instead of the
                  Markdown itself.
  --store <path>  Read this store instead of the configured one.

  Every ledger is admitted by the reader the server itself uses: a
  publication must be canonical, name this review, and be bound to the gate
  or authorization file beside it, or the render fails with that reader's
  error and prints nothing.

  Read-only: nothing is written, not even the report file the author tool
  render_review_report writes beside the ledger. The store is the one the
  servers use; set REVIEW_BRIDGE_HOME or pass --store to point at another.
  The report is a projection of the ledger, not evidence.
`;

const argv = process.argv.slice(2);
let reviewId = null;
let json = false;
let store = null;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--help") {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg === "--json") {
    json = true;
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
const { directory, review, publication, authorization } = ledgers;
const markdown = renderReviewReport(review, {
  publication,
  authorization,
  ledgerDirectory: directory,
});
process.stdout.write(
  json
    ? `${JSON.stringify(
        {
          review_id: reviewId,
          revision: reportRevision(review, publication),
          markdown,
        },
        null,
        2,
      )}\n`
    : markdown,
);
