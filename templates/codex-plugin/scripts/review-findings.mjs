#!/usr/bin/env node

import path from "node:path";
import { defaultStoreRoot } from "../server/core.mjs";
import { renderFindingSearch, searchFindings, validateFindingFilters } from "../server/finding-search.mjs";

const USAGE = `Usage: review-findings.mjs [filters] [--limit <n>] [--json] [--store <path>]

  Search historical findings from review.json ledgers. All filters combine
  with AND; each option accepts one value and may appear only once.

  --repository <path>    Exact match of the persisted repository_path string;
                         no path resolution, basename matching, or Git lookup.
                         Deleted historical worktrees remain searchable.
  --file <text>          Case-sensitive literal substring of the finding path.
  --keyword <text>       Case-insensitive literal substring of finding content,
                         author rationale/evidence, or rereview rationale/verification.
  --severity <value>     blocker, major, minor, nit
  --disposition <value>  fixed, rejected, human_required, missing
  --decision <value>     resolved, rebuttal_accepted, still_open, missing
  --limit <n>            Return at most n findings (default 20, range 1..1000).
  --json                Full records and diagnostics as JSON instead of brief text.
  --store <path>         Override REVIEW_BRIDGE_HOME / the server's default store.
  --help                Show this help.

  Sorted by review ID, introduced round, then finding ID ascending. The total
  match count is before truncation. Missing responses are explicit; original
  and rereview snapshots are separate. Carried findings are source references,
  not additional findings. Historical evidence needs rechecking;
  rebuttal_accepted does not establish a false positive.

  Read-only: no ledger, gate, snapshot, index, or report is written.
  Directories without review.json (including remote-only) are counted apart
  from errors. Unreadable or invalid ledgers are listed even outside filters.
  Exit 0: complete scan; 1: skipped ledgers or read failure; 2: invalid arguments.
`;

const options = {};
let store = null;
let json = false;
const seen = new Set();
try {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (seen.has(arg)) throw new Error(`duplicate argument ${arg}`);
    seen.add(arg);
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!["--repository", "--file", "--keyword", "--severity", "--disposition", "--decision", "--limit", "--store"].includes(arg)) {
      throw new Error(`unknown argument ${arg}`);
    }
    const value = argv[++index];
    if (value == null || value.startsWith("--") || value.trim() === "") throw new Error(`${arg} needs a value`);
    if (arg === "--store") store = value;
    else if (arg === "--limit") {
      if (!/^[0-9]+$/.test(value)) throw new Error("--limit must be an integer between 1 and 1000");
      options.limit = Number(value);
    } else options[arg.slice(2)] = value;
  }
  validateFindingFilters(options);
} catch (error) {
  process.stderr.write(`${error.message}\n${USAGE}`);
  process.exit(2);
}

try {
  const result = await searchFindings(store == null ? defaultStoreRoot() : path.resolve(store), options);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderFindingSearch(result));
  if (result.skipped.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.code ?? "ERROR"}: ${error.message}\n`);
  process.exitCode = 1;
}
