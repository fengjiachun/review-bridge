import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/publication.mjs";
import {
  PROJECTION_NOTICE,
  renderReviewReport,
  reportRevision,
  writeReviewReport,
} from "../src/report.mjs";

const REVIEW_ID = "rb-2026-09-01T000000-000Z-0badf00d";
const BASE = "a".repeat(40);
const HEAD_ONE = "b".repeat(40);
const HEAD_TWO = "c".repeat(40);
const RENDERED_AT = "2026-09-10T12:00:00.000Z";

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
    changed_files: ["src/a.mjs", "test/a.test.mjs"],
    deleted_files: [],
    overlays: [],
    worktree_clean: true,
    patch_bytes: 100,
    change_size: { added_lines: 10, deleted_lines: 2, total_lines: 12 },
    successor: null,
    ...extra,
  };
}

function finding(id, severity, status, extra = {}) {
  return {
    id,
    introduced_round: 1,
    severity,
    title: `title of ${id}`,
    explanation: `explanation of ${id}`,
    recommendation: `recommendation for ${id}`,
    status,
    path: "src/a.mjs",
    line: 7,
    ...extra,
  };
}

// Mirrors the record core.mjs writes: two rounds, a fixed finding the
// rereviewer resolved and a rejected one whose rebuttal was sustained with the
// verification the obligation requires.
function cleanInTwoRounds(overrides = {}) {
  return {
    version: 1,
    id: REVIEW_ID,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:30:00.000Z",
    state_version: 6,
    repository_path: "/tmp/repo",
    base_ref: BASE,
    requirement: "Implement the thing.\nSecond requirement line.",
    implementation_scope: "src/a.mjs only",
    reviewer_provider: "CODEX_TASK",
    advisory: false,
    review_strategy: {
      mode: "FULL",
      parent_review_id: null,
      fallback_reason: null,
      parent_selection: "NONE",
    },
    status: "CLEAN",
    current_round: 2,
    max_rounds: 2,
    rounds: [
      round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z"),
      round(2, HEAD_TWO, "2026-09-01T00:20:00.000Z", {
        changed_files: ["src/a.mjs", "src/b.mjs", "test/a.test.mjs"],
      }),
    ],
    findings: [
      finding("F-001", "major", "RESOLVED"),
      finding("F-002", "minor", "REBUTTAL_ACCEPTED", { path: "src/b.mjs", line: 3 }),
    ],
    resolutions: [
      {
        finding_id: "F-001",
        disposition: "fixed",
        rationale: "fixed rationale",
        evidence: "commit cccccccc",
        submitted_at: "2026-09-01T00:15:00.000Z",
      },
      {
        finding_id: "F-002",
        disposition: "rejected",
        rationale: "rejected rationale",
        evidence: "",
        submitted_at: "2026-09-01T00:15:00.000Z",
      },
    ],
    rereview_decisions: [
      {
        finding_id: "F-001",
        decision: "resolved",
        rationale: "resolved rationale",
        verification: "",
        submitted_at: "2026-09-01T00:25:00.000Z",
      },
      {
        finding_id: "F-002",
        decision: "rebuttal_accepted",
        rationale: "sustained rationale",
        verification: "reran the probe against the snapshot",
        submitted_at: "2026-09-01T00:25:00.000Z",
      },
    ],
    errata: [],
    carried_findings: [],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "FULL" },
      { at: "2026-09-01T00:06:00.000Z", event: "FINDINGS_SUBMITTED", round: 1, count: 2 },
      { at: "2026-09-01T00:15:00.000Z", event: "AUTHOR_RESPONDED", round: 1 },
      { at: "2026-09-01T00:20:00.000Z", event: "REREVIEW_PREPARED", round: 2, mode: "FULL" },
      { at: "2026-09-01T00:24:30.000Z", event: "REREVIEW_CLEAN", round: 2 },
    ],
    clean_snapshot_hash: "2".repeat(64),
    ...overrides,
  };
}

const OBSERVATION = {
  observed_at: "2026-09-01T01:00:00.000Z",
  recorded_at: "2026-09-01T01:00:01.000Z",
  pull_request: { number: 7, head_sha: HEAD_TWO, base_sha: BASE, state: "OPEN" },
  required_checks: {
    policy: "BRANCH_PROTECTION",
    requirements: [{ context: "ci" }],
    runs: [
      {
        context: "ci",
        run_kind: "CHECK_RUN",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        completed_at: "2026-09-01T00:50:00.000Z",
      },
    ],
  },
  review_threads: {
    total_count: 2,
    unresolved_count: 0,
    threads: [
      {
        id: "PRRT_1",
        path: "src/a.mjs",
        line: 9,
        is_resolved: true,
        comment_count: 2,
        comments: [
          { actor: { login: "codex[bot]" } },
          { actor: { login: "author" } },
        ],
      },
      {
        id: "PRRT_2",
        path: "src/b.mjs",
        line: 1,
        is_resolved: true,
        comment_count: 1,
        comments: [{ actor: { login: "reviewer" } }],
      },
    ],
  },
  codex_review: {
    requests: [],
    results: [
      {
        verdict: "CLEAN",
        association: "SINGLE_OPEN_REQUEST",
        request_id: "rbreq-1",
        reviewed_head_sha: HEAD_TWO,
        event_at: "2026-09-01T00:45:00.000Z",
        url: "https://example.test/pr/7#issuecomment-2",
      },
    ],
  },
};

function mergeReadyPublication() {
  return {
    version: 3,
    review_id: REVIEW_ID,
    revision: 5,
    status: "MERGE_READY",
    created_at: "2026-09-01T00:40:00.000Z",
    updated_at: "2026-09-01T01:00:01.000Z",
    authorization: {
      mode: "LOCAL_GATE",
      base_sha: BASE,
      head_sha: HEAD_TWO,
      reviewer_provider: "CODEX_TASK",
    },
    target: {
      owner: "owner",
      repo: "repo",
      pr_number: 7,
      base_branch: "main",
      head_branch: "feat/thing",
      codex_trigger_policy: { mode: "EXPLICIT_ONLY" },
    },
    codex_request_history: [
      {
        request_id: "rbreq-1",
        requested_head_sha: HEAD_TWO,
        event_at: "2026-09-01T00:41:00.000Z",
        classification: "RECOGNIZED",
        url: "https://example.test/pr/7#issuecomment-1",
      },
    ],
    codex_result_history: [{ result_id: 2 }],
    codex_review_ambiguity_acknowledgements: [
      {
        acknowledgement_id: "ack-1",
        acknowledgement: "SUPERSEDED_BY_LATER_OWN_REQUEST",
        head_sha: HEAD_TWO,
        closed_requests: [{ request_id: "rbreq-0" }],
        closed_results: [],
        backing_observation_sha256: null,
        acknowledged_at: "2026-09-01T00:41:00.000Z",
      },
    ],
    automatic_resolutions: [
      {
        number: 1,
        action_id: "act-1",
        thread_id: "PRRT_1",
        reply_comment_id: 55,
        head_sha: HEAD_TWO,
      },
    ],
    latest_observation: OBSERVATION,
    history: [
      { at: "2026-09-01T00:40:00.000Z", event: "PUBLICATION_STARTED", revision: 1, status: "PR_PENDING" },
      { at: "2026-09-01T01:00:01.000Z", event: "GITHUB_SNAPSHOT_RECORDED", revision: 5, status: "MERGE_READY" },
    ],
    terminal: null,
  };
}

function render(review, options = {}) {
  return renderReviewReport(review, { renderedAt: RENDERED_AT, ...options });
}

test("a FULL review that reached CLEAN in round two renders every section and finding field", () => {
  const markdown = render(cleanInTwoRounds());
  assert.ok(markdown.startsWith("# Review report rb-2026-09-01T000000-000Z-0badf00d\n"));
  for (const heading of [
    "## Local review",
    "### Requirement",
    "### Implementation scope",
    "### Rounds",
    "### Findings",
    "### Changes between rounds",
    "### Outcome",
    "## Remote publication",
    "## Footer",
  ]) {
    assert.ok(markdown.includes(`\n${heading}\n`), `missing ${heading}`);
  }
  assert.match(markdown, /- Review strategy: `FULL`, parent selection `NONE`/);
  assert.match(markdown, /- Reviewer provider: `CODEX_TASK`\n/);
  assert.match(markdown, /    Implement the thing\.\n    Second requirement line\./);
  // Wall time per round from the prepared and verdict events.
  assert.match(markdown, /\| 1 \| bbbbbbbbbbbb \| 2026-09-01T00:00:00\.000Z \| FINDINGS_SUBMITTED \| 2026-09-01T00:06:00\.000Z \| 6m 0s \| 2 \| \+10 −2 \|/);
  assert.match(markdown, /\| 2 \| cccccccccccc \| [^|]+\| REREVIEW_CLEAN \| [^|]+\| 4m 30s \| 3 \|/);
  // Each finding: severity, location, title, status, disposition with
  // rationale and evidence, decision with rationale.
  assert.match(markdown, /#### F-001 · major · src\/a\.mjs:7\n\n- Title: title of F-001\n- Introduced in round 1; status `RESOLVED`/);
  assert.match(markdown, /- Author disposition: `fixed` at 2026-09-01T00:15:00\.000Z\n    fixed rationale\n- Author evidence:\n    commit cccccccc/);
  assert.match(markdown, /- Rereview decision: `resolved` at 2026-09-01T00:25:00\.000Z\n    resolved rationale\n/);
  // A sustained rebuttal prints the verification the rereviewer performed.
  assert.match(markdown, /#### F-002 · minor · src\/b\.mjs:3/);
  assert.match(markdown, /- Rereview decision: `rebuttal_accepted` at [^\n]+\n    sustained rationale\n- Rereviewer verification:\n    reran the probe against the snapshot/);
  // What changed between rounds comes from the two immutable rounds.
  assert.match(markdown, /- Round 1 → 2: fix head `b{40}` → `c{40}`; files in the reviewed diff: `src\/a\.mjs`, `src\/b\.mjs`, `test\/a\.test\.mjs`/);
  assert.match(markdown, /- Terminal state: `CLEAN`\n- Rounds to CLEAN: 2\n- Clean snapshot: `2{64}`/);
  assert.match(markdown, /## Remote publication\n\nNo publication ledger was rendered\./);
});

test("the footer names the review, both revisions, the render time, the ledger path, and the projection sentence", () => {
  const markdown = render(cleanInTwoRounds(), { ledgerDirectory: "/store/reviews/x" });
  assert.match(markdown, /## Footer\n\n- Review: `rb-2026-09-01T000000-000Z-0badf00d`\n- Review ledger state_version: 6\n- Publication ledger revision: none\n- Report revision: `6`\n- Rendered at: 2026-09-10T12:00:00\.000Z\n- Ledger: `\/store\/reviews\/x\/review\.json`\n/);
  assert.ok(markdown.endsWith(`\n${PROJECTION_NOTICE}\n`));
  assert.match(PROJECTION_NOTICE, /projection of the ledger, not evidence/);
  assert.match(PROJECTION_NOTICE, /sole source of truth/);
  // Without a directory the path is store-relative rather than invented.
  assert.match(render(cleanInTwoRounds()), /- Ledger: `reviews\/rb-2026-09-01T000000-000Z-0badf00d\/review\.json`/);
});

test("a SUCCESSOR review renders its strategy and the delta it was reviewed as", () => {
  const review = cleanInTwoRounds({
    status: "CLEAN",
    current_round: 1,
    state_version: 2,
    review_strategy: {
      mode: "SUCCESSOR",
      parent_review_id: "rb-2026-08-31T000000-000Z-00parent",
      fallback_reason: null,
    },
    rounds: [
      round(1, HEAD_TWO, "2026-09-01T00:00:00.000Z", {
        successor: {
          version: 1,
          parent_review_id: "rb-2026-08-31T000000-000Z-00parent",
          parent_reviewer_provider: "CODEX_TASK",
          requirement_match: true,
          parent_head_sha: HEAD_ONE,
          current_head_sha: HEAD_TWO,
          changed_files: ["src/b.mjs"],
          deleted_files: ["src/old.mjs"],
          delta_bytes: 321,
          delta_sha256: "d".repeat(64),
        },
      }),
    ],
    findings: [],
    resolutions: [],
    rereview_decisions: [],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "SUCCESSOR" },
      { at: "2026-09-01T00:03:00.000Z", event: "INITIAL_REVIEW_CLEAN", round: 1 },
    ],
  });
  const markdown = render(review);
  assert.match(markdown, /- Review strategy: `SUCCESSOR`, parent `rb-2026-08-31T000000-000Z-00parent`/);
  assert.match(markdown, /### Successor delta\n\n- Parent review: `rb-2026-08-31T000000-000Z-00parent` \(`CODEX_TASK`\)\n- Requirement matches the parent: yes\n- Parent head → current head: `b{40}` → `c{40}`\n- Delta: 321 bytes, sha256 `d{64}`\n- Files in the delta: `src\/b\.mjs`\n- Files deleted in the delta: `src\/old\.mjs`/);
  assert.match(markdown, /### Findings\n\nNo findings were recorded\./);
  assert.match(markdown, /\| 1 \| cccccccccccc \| [^|]+\| INITIAL_REVIEW_CLEAN \| [^|]+\| 3m 0s \|/);
  assert.match(markdown, /### Changes between rounds\n\nNo round followed another\./);
  assert.match(markdown, /- Rounds to CLEAN: 1/);
});

test("a HUMAN_REQUIRED stop names its reason and does not infer a fix commit no round binds", () => {
  const review = cleanInTwoRounds({
    status: "HUMAN_REQUIRED",
    current_round: 1,
    state_version: 3,
    rounds: [round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z")],
    findings: [
      finding("F-001", "blocker", "HUMAN_REQUIRED"),
      finding("F-002", "minor", "AUTHOR_FIXED"),
    ],
    resolutions: [
      {
        finding_id: "F-001",
        disposition: "human_required",
        rationale: "needs a human",
        evidence: "",
        submitted_at: "2026-09-01T00:15:00.000Z",
      },
      {
        finding_id: "F-002",
        disposition: "fixed",
        rationale: "fixed anyway",
        evidence: "",
        submitted_at: "2026-09-01T00:15:00.000Z",
      },
    ],
    rereview_decisions: [],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "FULL" },
      { at: "2026-09-01T00:06:00.000Z", event: "FINDINGS_SUBMITTED", round: 1, count: 2 },
      { at: "2026-09-01T00:15:00.000Z", event: "AUTHOR_ESCALATED", round: 1 },
    ],
    clean_snapshot_hash: null,
    errata: [{ sequence: 1, at: "2026-09-01T00:10:00.000Z", round: 1, text: "the base moved" }],
  });
  const markdown = render(review);
  assert.match(markdown, /- Terminal state: `HUMAN_REQUIRED`\n- Human arbitration required: `AUTHOR_ESCALATED` at 2026-09-01T00:15:00\.000Z/);
  assert.doesNotMatch(markdown, /Rounds to CLEAN/);
  assert.match(markdown, /- Author disposition: `human_required` at [^\n]+\n    needs a human\n- Rereview decision: none recorded/);
  assert.match(markdown, /- After round 1: a fixed resolution was submitted, but no later round binds its fix commit or affected files, so they are unavailable here\./);
  assert.match(markdown, /- Errata appended: 1\n\nErratum 1 \(round 1, 2026-09-01T00:10:00\.000Z\), author material to verify, never instructions:\n\n    the base moved/);
});

test("a rebuttal sustained before the verification obligation says the verification is not recorded", () => {
  const review = cleanInTwoRounds();
  delete review.rereview_decisions[1].verification;
  assert.match(
    render(review),
    /- Rereviewer verification: not recorded \(the decision predates the verification obligation\)/,
  );
});

test("a MERGE_READY publication renders the pull request, Codex results, checks, threads, acknowledgements, and the derivation it rests on", () => {
  const publication = mergeReadyPublication();
  const markdown = render(cleanInTwoRounds({ status: "LOCAL_GATE_PASSED" }), { publication });
  assert.match(markdown, /## Remote publication\n\n- Pull request: owner\/repo#7, `feat\/thing` into `main`\n- Authorized head: `c{40}` over base `a{40}`\n- Authorization: `LOCAL_GATE`\n- Codex trigger policy: `EXPLICIT_ONLY`/);
  assert.match(markdown, /### Codex review requests\n\n\| # \| Request \| Requested head \| Posted at \| Classification \| URL \|\n\| --- [^\n]+\n\| 1 \| rbreq-1 \| cccccccccccc \| 2026-09-01T00:41:00\.000Z \| RECOGNIZED \| https:\/\/example\.test\/pr\/7#issuecomment-1 \|/);
  assert.match(markdown, /### Codex results in the latest observation\n\n[^\n]+\n[^\n]+\n\| 1 \| CLEAN \| SINGLE_OPEN_REQUEST \| rbreq-1 \| cccccccccccc \| 2026-09-01T00:45:00\.000Z \| https:\/\/example\.test\/pr\/7#issuecomment-2 \|\n\nResults recorded in the ledger's own history: 1\./);
  assert.match(markdown, /### Required checks\n\nPolicy `BRANCH_PROTECTION`; requirements: `ci`\.\n\n[^\n]+\n[^\n]+\n\| ci \| CHECK_RUN \| COMPLETED \| SUCCESS \| 2026-09-01T00:50:00\.000Z \|/);
  assert.match(markdown, /\| PRRT_1 \| src\/a\.mjs:9 \| 2 by codex\[bot\], author \| resolved by record 1 \(action act-1, reply comment 55, head cccccccccccc\) \|/);
  assert.match(markdown, /\| PRRT_2 \| src\/b\.mjs:1 \| 1 by reviewer \| resolved on GitHub; no automatic-resolution record \|/);
  assert.match(markdown, /\| SUPERSEDED_BY_LATER_OWN_REQUEST \| cccccccccccc \| 1 \| 0 \| server-derived \| 2026-09-01T00:41:00\.000Z \|/);
  assert.match(
    markdown,
    new RegExp(
      `- Publication status: \`MERGE_READY\` at revision 5\\n- MERGE_READY rests on the observation recorded at revision 5, observed 2026-09-01T01:00:00\\.000Z, recorded 2026-09-01T01:00:01\\.000Z, canonical sha256 \`${canonicalDigest(OBSERVATION)}\`\\.`,
    ),
  );
  assert.match(markdown, /- Publication ledger revision: 5\n- Report revision: `6-p5`/);
  assert.match(markdown, /- Ledger: `reviews\/[^`]+\/review\.json`, `reviews\/[^`]+\/publication\.json`/);
  assert.equal(reportRevision(cleanInTwoRounds(), publication), "6-p5");
});

test("an unresolved thread and a publication without an observation are stated, not guessed", () => {
  const publication = mergeReadyPublication();
  publication.status = "CHANGES_REQUIRED";
  publication.latest_observation.review_threads.threads[1].is_resolved = false;
  publication.automatic_resolutions = [];
  let markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| resolved on GitHub; no automatic-resolution record \|/);
  assert.match(markdown, /\| PRRT_2 \| [^|]+\| [^|]+\| unresolved; left for a human \|/);
  assert.match(markdown, /- Publication status: `CHANGES_REQUIRED` at revision 5\n- No MERGE_READY derivation is rendered for this status\./);

  publication.latest_observation = null;
  publication.status = "PR_PENDING";
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /### Codex results in the latest observation\n\nThe latest observation holds no Codex result\./);
  assert.match(markdown, /### Required checks\n\nNo observation has been recorded\./);
  assert.match(markdown, /### Review threads\n\nNo observation has been recorded\./);
});

test("rendering is a pure function of its inputs", () => {
  const review = cleanInTwoRounds();
  const publication = mergeReadyPublication();
  const before = JSON.stringify([review, publication]);
  const first = render(review, { publication });
  const second = render(review, { publication });
  assert.equal(first, second);
  assert.equal(JSON.stringify([review, publication]), before);
});

async function store(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-report-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeLedger(root, name, value) {
  const directory = path.join(root, "reviews", REVIEW_ID);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, name), `${JSON.stringify(value)}\n`);
  return directory;
}

test("the store writer names the file by the ledger revision and is idempotent at that revision", async (t) => {
  const root = await store(t);
  const directory = await writeLedger(root, "review.json", cleanInTwoRounds());

  const first = await writeReviewReport(root, REVIEW_ID, { renderedAt: RENDERED_AT });
  assert.equal(first.path, path.join(directory, "report-r6.md"));
  assert.equal(first.written, true);
  assert.equal(first.revision, "6");
  assert.equal(first.review_state_version, 6);
  assert.equal(first.publication_revision, null);
  assert.equal(await fsp.readFile(first.path, "utf8"), first.markdown);
  assert.equal((await fsp.stat(first.path)).mode & 0o777, 0o600);

  // A second render at the same revision returns the same bytes, render time
  // included, and rewrites nothing.
  const second = await writeReviewReport(root, REVIEW_ID, {
    renderedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(second.written, false);
  assert.equal(second.markdown, first.markdown);
  assert.deepEqual(
    (await fsp.readdir(directory)).sort(),
    ["report-r6.md", "review.json"],
  );

  // A publication arriving later is a new revision and a new file beside it.
  await writeLedger(root, "publication.json", mergeReadyPublication());
  const withPublication = await writeReviewReport(root, REVIEW_ID, {
    renderedAt: RENDERED_AT,
  });
  assert.equal(withPublication.path, path.join(directory, "report-r6-p5.md"));
  assert.equal(withPublication.written, true);
  assert.equal(withPublication.publication_revision, 5);
  assert.match(withPublication.markdown, /- Pull request: owner\/repo#7/);
  assert.match(withPublication.markdown, new RegExp(`- Ledger: \`${directory}/review\\.json\`, \`${directory}/publication\\.json\``));
  // The ledgers themselves are untouched.
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(directory, "review.json"), "utf8")), cleanInTwoRounds());
});

test("a missing or malformed ledger is a structured error, and an invalid ID never reaches the store", async (t) => {
  const root = await store(t);
  await assert.rejects(writeReviewReport(root, REVIEW_ID), (error) => {
    assert.equal(error.code, "REVIEW_NOT_FOUND");
    assert.equal(error.details.review_id, REVIEW_ID);
    assert.equal(error.details.path, path.join(root, "reviews", REVIEW_ID, "review.json"));
    return true;
  });
  await assert.rejects(writeReviewReport(root, "../etc/passwd"), (error) => {
    assert.equal(error.code, "INVALID_REVIEW_ID");
    return true;
  });
  const directory = await writeLedger(root, "review.json", cleanInTwoRounds());
  await fsp.writeFile(path.join(directory, "publication.json"), "{not json");
  await assert.rejects(writeReviewReport(root, REVIEW_ID), (error) => {
    assert.equal(error.code, "LEDGER_UNREADABLE");
    return true;
  });
  assert.deepEqual(
    (await fsp.readdir(directory)).sort(),
    ["publication.json", "review.json"],
  );
});
