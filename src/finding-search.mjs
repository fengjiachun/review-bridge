import fsp from "node:fs/promises";
import path from "node:path";
import { loadReview, MAX_ROUNDS } from "./core.mjs";
import { isLocalObjectId } from "./object-id.mjs";

const SEVERITIES = ["blocker", "major", "minor", "nit"];
const DISPOSITIONS = ["fixed", "rejected", "human_required"];
const DECISIONS = ["resolved", "rebuttal_accepted", "still_open"];
const REVIEW_ID = /^rb-[0-9TZ-]+-[a-f0-9]{8}$/;
const AUTHOR_EVENTS = ["AUTHOR_RESPONDED", "AUTHOR_ESCALATED"];
const REREVIEW_EVENTS = ["REREVIEW_CLEAN", "REREVIEW_UNRESOLVED", "REREVIEW_CONTINUABLE_FINDINGS"];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function nonempty(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function validateFindingFilters(options = {}) {
  const filters = {};
  for (const [key, value] of Object.entries(options)) {
    requireValue(
      ["repository", "file", "keyword", "severity", "disposition", "decision", "limit"].includes(key),
      `unknown filter ${key}`,
    );
    if (key === "limit") continue;
    requireValue(nonempty(value), `${key} must be a non-empty string`);
    filters[key] = value;
  }
  for (const [key, allowed] of [
    ["severity", SEVERITIES],
    ["disposition", [...DISPOSITIONS, "missing"]],
    ["decision", [...DECISIONS, "missing"]],
  ]) {
    requireValue(filters[key] == null || allowed.includes(filters[key]), `${key} must be one of ${allowed.join(", ")}`);
  }
  const limit = options.limit ?? 20;
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 1000, "limit must be an integer between 1 and 1000");
  return { filters, limit };
}

function indexRecords(records, key, label) {
  requireValue(Array.isArray(records), `${label} is not an array`);
  const result = new Map();
  for (const record of records) {
    requireValue(record != null && nonempty(record[key]), `${label} entry has no ${key}`);
    requireValue(!result.has(record[key]), `${label} has duplicate ${key} ${record[key]}`);
    result.set(record[key], record);
  }
  return result;
}

// Validate the fields this projection joins or searches; loadReview supplies
// the store reader, but does not validate the parsed ledger's shape.
function queryIndexes(review, id) {
  requireValue(review?.id === id, "review ID does not match its store directory");
  requireValue(nonempty(review.repository_path), "repository_path is missing");
  requireValue(Array.isArray(review.rounds), "rounds is not an array");
  const snapshots = new Map();
  for (const snapshot of review.rounds) {
    const round = snapshot?.round;
    requireValue(Number.isInteger(round) && round >= 1 && round <= MAX_ROUNDS && !snapshots.has(round), "invalid or duplicate snapshot round");
    requireValue(isLocalObjectId(snapshot.head_sha), `round ${round} has an invalid head_sha`);
    requireValue(typeof snapshot.snapshot_hash === "string" && /^[a-f0-9]{64}$/.test(snapshot.snapshot_hash), `round ${round} has an invalid snapshot_hash`);
    snapshots.set(round, { round, head_sha: snapshot.head_sha, snapshot_hash: snapshot.snapshot_hash });
  }
  const findings = indexRecords(review.findings, "id", "findings");
  const resolutions = indexRecords(review.resolutions, "finding_id", "resolutions");
  const decisions = indexRecords(review.rereview_decisions, "finding_id", "rereview_decisions");
  for (const finding of findings.values()) {
    requireValue(snapshots.has(finding.introduced_round), `${finding.id} has no introduced-round snapshot`);
    requireValue(SEVERITIES.includes(finding.severity), `${finding.id} has an invalid severity`);
    for (const key of ["title", "explanation"]) requireValue(nonempty(finding[key]), `${finding.id} has no ${key}`);
    for (const key of ["recommendation", "path"]) requireValue(finding[key] == null || typeof finding[key] === "string", `${finding.id} has an invalid ${key}`);
    requireValue(finding.line == null || (Number.isInteger(finding.line) && finding.line > 0), `${finding.id} has an invalid line`);
  }
  for (const [records, key, allowed, parents, optionalText] of [
    [resolutions, "disposition", DISPOSITIONS, findings, "evidence"],
    [decisions, "decision", DECISIONS, resolutions, "verification"],
  ]) {
    for (const record of records.values()) {
      requireValue(parents.has(record.finding_id), `${key} names no ${key === "decision" ? "resolution" : "finding"}: ${record.finding_id}`);
      requireValue(allowed.includes(record[key]), `${record.finding_id} has an invalid ${key}`);
      requireValue(nonempty(record.rationale), `${record.finding_id} has no ${key} rationale`);
      requireValue(record[optionalText] == null || typeof record[optionalText] === "string", `${record.finding_id} has invalid ${optionalText}`);
    }
  }
  requireValue(Array.isArray(review.history), "history is not an array");
  for (const event of review.history) requireValue(nonempty(event?.event), "history entry has no event");
  requireValue(review.carried_findings == null || Array.isArray(review.carried_findings), "carried_findings is not an array");
  for (const carried of review.carried_findings ?? []) {
    requireValue(typeof carried?.continued_from_review_id === "string" && REVIEW_ID.test(carried.continued_from_review_id) && nonempty(carried.finding_id), "invalid carried finding source");
  }
  return { snapshots, resolutions, decisions };
}

function eventRound(review, events, snapshots) {
  const rounds = new Set(review.history.filter((entry) => events.includes(entry.event)).map((entry) => entry.round));
  if (rounds.size === 0) return null;
  requireValue(rounds.size === 1 && snapshots.has([...rounds][0]), `invalid or ambiguous round for ${events.join("/")}`);
  return [...rounds][0];
}

function projectFindings(review, id, ledgerPath, storeRoot) {
  const { snapshots, resolutions, decisions } = queryIndexes(review, id);
  const responseRound = eventRound(review, AUTHOR_EVENTS, snapshots);
  const decisionRound = eventRound(review, REREVIEW_EVENTS, snapshots);
  const sources = (review.carried_findings ?? []).map((source) => ({
    review_id: source.continued_from_review_id,
    finding_id: source.finding_id,
    ledger_path: path.join(storeRoot, "reviews", source.continued_from_review_id, "review.json"),
  }));
  return review.findings.map((finding, index) => {
    const resolution = resolutions.get(finding.id);
    const decision = decisions.get(finding.id);
    return {
      review_id: id,
      finding_id: finding.id,
      repository_path: review.repository_path,
      created_at: review.created_at ?? null,
      introduced_round: finding.introduced_round,
      finding,
      snapshot: snapshots.get(finding.introduced_round),
      // A response precedes the next capture; its fix has no recorded head.
      author_resolution: resolution == null ? null : { ...resolution, response_round: responseRound, head_sha: null },
      rereview_decision: decision == null ? null : { ...decision, round: decisionRound, snapshot: snapshots.get(decisionRound) ?? null },
      evidence: { ledger_path: ledgerPath, finding_pointer: `/findings/${index}` },
      continuation_sources: sources,
      continued_by_review_id: review.continued_by_review_id ?? null,
    };
  });
}

function matches(row, filters) {
  const { finding, author_resolution: resolution, rereview_decision: decision } = row;
  if (filters.repository != null && filters.repository !== row.repository_path) return false;
  if (filters.file != null && !(finding.path ?? "").includes(filters.file)) return false;
  if (filters.severity != null && filters.severity !== finding.severity) return false;
  if (filters.disposition != null && filters.disposition !== (resolution?.disposition ?? "missing")) return false;
  if (filters.decision != null && filters.decision !== (decision?.decision ?? "missing")) return false;
  if (filters.keyword != null) {
    const texts = [finding.title, finding.explanation, finding.recommendation, resolution?.rationale, resolution?.evidence, decision?.rationale, decision?.verification];
    if (!texts.some((value) => value?.toLowerCase().includes(filters.keyword.toLowerCase()))) return false;
  }
  return true;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function searchFindings(storeRoot, options = {}) {
  const { filters, limit } = validateFindingFilters(options);
  storeRoot = path.resolve(storeRoot);
  const reviewsRoot = path.join(storeRoot, "reviews");
  let entries;
  try {
    entries = await fsp.readdir(reviewsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    entries = [];
  }
  const rows = [];
  const skipped = [];
  const corpus = { reviews_scanned: 0, directories_without_review: 0 };
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const ledgerPath = path.join(reviewsRoot, entry.name, "review.json");
    try {
      // Absence is valid for remote authorization/publication directories.
      try {
        await fsp.lstat(ledgerPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        corpus.directories_without_review += 1;
        continue;
      }
      const review = await loadReview(storeRoot, entry.name);
      const findings = projectFindings(review, entry.name, ledgerPath, storeRoot);
      corpus.reviews_scanned += 1;
      rows.push(...findings.filter((row) => matches(row, filters)));
    } catch (error) {
      skipped.push({ review_id: entry.name, ledger_path: ledgerPath, reason: error.message });
    }
  }
  rows.sort((a, b) => compare(a.review_id, b.review_id) || a.introduced_round - b.introduced_round || compare(a.finding_id, b.finding_id));
  return {
    schema_version: 1,
    store_root: storeRoot,
    filters,
    limit,
    total_matches: rows.length,
    truncated: rows.length > limit,
    results: rows.slice(0, limit),
    skipped,
    corpus,
  };
}

function brief(value, max = 240) {
  const text = String(value).replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function renderFindingSearch(result) {
  const lines = [
    `Showing ${result.results.length} of ${result.total_matches} matching findings${result.truncated ? " (truncated)" : ""}.`,
    `Scanned ${result.corpus.reviews_scanned} review ledgers; ${result.corpus.directories_without_review} directories without review.json; ${result.skipped.length} skipped.`,
    "Historical evidence needs rechecking; rebuttal_accepted does not establish a false positive.",
  ];
  for (const row of result.results) {
    const { finding, author_resolution: resolution, rereview_decision: decision } = row;
    lines.push("", `${row.review_id} / ${brief(row.finding_id)} [${finding.severity}] ${brief(finding.title)}`);
    lines.push(`  Repository: ${brief(row.repository_path, 4096)}`);
    lines.push(`  File: ${brief(finding.path ?? "not recorded", 4096)}${finding.line == null ? "" : `:${finding.line}`}`);
    lines.push(`  Finding: round ${row.introduced_round}, head ${row.snapshot.head_sha}, snapshot ${row.snapshot.snapshot_hash}`);
    lines.push(`  ${brief(finding.explanation)}`);
    if (finding.recommendation) lines.push(`  Recommendation: ${brief(finding.recommendation)}`);
    lines.push(resolution == null
      ? "  Author: missing"
      : `  Author: ${resolution.disposition}; response round ${resolution.response_round ?? "not recorded"}; head not recorded — ${brief(resolution.rationale)}`);
    lines.push(decision == null
      ? "  Rereview: missing"
      : `  Rereview: ${decision.decision}; round ${decision.round ?? "not recorded"}; head ${decision.snapshot?.head_sha ?? "not recorded"} — ${brief(decision.rationale)}`);
    for (const source of row.continuation_sources) lines.push(`  Review carries source reference: ${source.review_id} / ${brief(source.finding_id)} (${brief(source.ledger_path, 8192)})`);
    lines.push(`  Ledger: ${brief(row.evidence.ledger_path, 8192)}#${row.evidence.finding_pointer}`);
  }
  if (result.skipped.length > 0) {
    lines.push("", "Skipped ledgers (results are incomplete):");
    for (const skipped of result.skipped) lines.push(`  ${brief(skipped.ledger_path, 8192)}: ${brief(skipped.reason)}`);
  }
  lines.push("", "Text excerpts are abbreviated; use --json for full finding and response content.");
  return `${lines.join("\n")}\n`;
}
