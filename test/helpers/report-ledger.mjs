// A hand-built review ledger rich enough that one render of it reaches every
// section the full report has: two rounds, findings settled both ways, findings
// still open, a carried finding, and an erratum. It mirrors a real
// CONTINUABLE_FINDINGS shape -- round 1 raised three findings, the author
// answered all three, the rereview settled all three and raised two more --
// so a brief rendered from it can be read against the state machine that
// would have written it.
//
// It is shared by the baseline comparison (test/fixtures/report-full-baseline.md)
// and the brief's tests, so the document the baseline pins and the document the
// brief is asserted over are rendered from the same ledger.

const BASE = "a".repeat(40);
const HEAD_ONE = "b".repeat(40);
const HEAD_TWO = "c".repeat(40);

export const BASELINE_REVIEW_ID = "rb-2026-09-01T000000-000Z-0badf00d";
export const BASELINE_RENDERED_AT = "2026-09-10T12:00:00.000Z";

function round(number, headSha, capturedAt, extra = {}) {
  return {
    round: number,
    version: 1,
    captured_at: capturedAt,
    repository_path: "/tmp/repo",
    base_ref: BASE,
    base_sha: BASE,
    head_sha: headSha,
    snapshot_hash: `${number}`.repeat(64),
    changed_files: ["docs/rfcs/0007-object-store-wal.md"],
    deleted_files: [],
    overlays: [],
    worktree_clean: true,
    patch_bytes: 4096,
    change_size: { added_lines: 224, deleted_lines: 6, total_lines: 230 },
    successor: null,
    ...extra,
  };
}

function finding(id, severity, status, introducedRound, extra = {}) {
  return {
    id,
    introduced_round: introducedRound,
    severity,
    title: `Title of ${id}`,
    explanation: `Explanation of ${id}.`,
    recommendation: `Recommendation for ${id}.`,
    status,
    path: "docs/rfcs/0007-object-store-wal.md",
    line: 90,
    ...extra,
  };
}

function resolution(findingId, disposition, extra = {}) {
  return {
    finding_id: findingId,
    disposition,
    rationale: `Author rationale for ${findingId}.`,
    evidence: "",
    submitted_at: "2026-09-01T00:15:00.000Z",
    ...extra,
  };
}

function decision(findingId, value, extra = {}) {
  return {
    finding_id: findingId,
    decision: value,
    rationale: `Rereview rationale for ${findingId}.`,
    verification: "",
    submitted_at: "2026-09-01T00:25:00.000Z",
    ...extra,
  };
}

export function continuableInTwoRounds(overrides = {}) {
  return {
    version: 1,
    id: BASELINE_REVIEW_ID,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:26:00.000Z",
    state_version: 9,
    repository_path: "/tmp/repo",
    base_ref: BASE,
    requirement: "Describe the write-ahead log as it is implemented.",
    implementation_scope: "docs/rfcs/0007-object-store-wal.md only",
    reviewer_provider: "CODEX_TASK",
    advisory: false,
    review_strategy: {
      mode: "FULL",
      parent_review_id: null,
      fallback_reason: null,
      parent_selection: "NONE",
    },
    status: "CONTINUABLE_FINDINGS",
    current_round: 2,
    max_rounds: 2,
    rounds: [
      round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z"),
      round(2, HEAD_TWO, "2026-09-01T00:20:00.000Z", {
        change_size: { added_lines: 244, deleted_lines: 31, total_lines: 275 },
      }),
    ],
    findings: [
      finding("F-001", "major", "RESOLVED", 1),
      finding("F-002", "minor", "REBUTTAL_ACCEPTED", 1, { line: 98 }),
      finding("F-003", "nit", "RESOLVED", 1, { line: 183 }),
      finding("F-004", "minor", "OPEN", 2, { line: 114 }),
      finding("F-005", "nit", "OPEN", 2, { line: 222 }),
    ],
    resolutions: [
      resolution("F-001", "fixed", { evidence: "commit cccccccccccc" }),
      resolution("F-002", "rejected"),
      resolution("F-003", "fixed"),
    ],
    rereview_decisions: [
      decision("F-001", "resolved", { verification: "read the admit path and its test" }),
      decision("F-002", "rebuttal_accepted", { verification: "reran the probe against the snapshot" }),
      decision("F-003", "resolved"),
    ],
    errata: [
      {
        sequence: 1,
        round: 1,
        at: "2026-09-01T00:10:00.000Z",
        text: "The requirement named the wrong section number.",
      },
    ],
    carried_findings: [
      {
        finding_id: "F-009",
        continued_from_review_id: "rb-2026-08-30T000000-000Z-1234abcd",
        severity: "major",
        title: "Title of the carried finding",
        explanation: "Explanation of the carried finding.",
        recommendation: "Recommendation for the carried finding.",
        path: "docs/rfcs/0007-object-store-wal.md",
        line: 12,
      },
    ],
    continued_by_review_id: "rb-2026-09-02T000000-000Z-c35398d3",
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "FULL" },
      { at: "2026-09-01T00:05:28.000Z", event: "FINDINGS_SUBMITTED", round: 1, count: 3 },
      { at: "2026-09-01T00:15:00.000Z", event: "AUTHOR_RESPONDED", round: 1 },
      { at: "2026-09-01T00:20:00.000Z", event: "REREVIEW_PREPARED", round: 2, mode: "FULL" },
      { at: "2026-09-01T00:24:38.000Z", event: "REREVIEW_CONTINUABLE_FINDINGS", round: 2 },
    ],
    ...overrides,
  };
}

// The same ledger with one more open finding, of a severity the ledger did not
// already carry at that count. Every derived number in the brief -- the total,
// the severity breakdown, and the open count -- differs from the ledger above,
// so a count read from the wrong field or written as a literal cannot satisfy
// both.
export function continuableWithOneMoreOpenFinding() {
  const review = continuableInTwoRounds();
  review.findings.push(finding("F-006", "blocker", "OPEN", 2, { line: 301 }));
  return review;
}
