#!/usr/bin/env node

import { inspectPublicationAudit } from "../server/publication.mjs";
import { defaultStoreRoot } from "../server/core.mjs";

const reviewId = process.argv[2];
if (!reviewId) {
  console.error("usage: node scripts/inspect-publication-audit.mjs <review_id>");
  process.exit(2);
}

const result = await inspectPublicationAudit(defaultStoreRoot(), reviewId);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
