import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  prepareRereview,
  prepareReview,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";
import { adaptCodexEvidence } from "../src/github-adapter.mjs";
import { normalizeGithubObservation } from "../src/github-observation.mjs";
import { isLocalObjectId } from "../src/object-id.mjs";
import {
  authorizeRemotePublication,
  getPublication,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
} from "../src/publication.mjs";
import { baseline, iso, observation } from "./helpers/github-observation.mjs";
import { commit, fixture, git, TOPIC_BRANCH } from "./helpers/repository-fixture";

const REPOSITORY_ID = 101;
const PR_NUMBER = 7;

const SHA1_WIDTH = 40;
const SHA256_WIDTH = 64;

function startInput(reviewId, startedAt) {
  return {
    reviewId,
    repositoryId: REPOSITORY_ID,
    owner: "example",
    repo: "review-bridge",
    prNumber: PR_NUMBER,
    baseBranch: "main",
    headBranch: TOPIC_BRANCH,
    codexActorId: 99,
    codexActorType: "Bot",
    codexActorLogin: "chatgpt-codex-connector[bot]",
    codexTriggerMode: "EXPLICIT_ONLY",
    baseline: baseline(startedAt - 100),
  };
}

function draftObservation(state, headSha, options) {
  return observation({
    baseSha: state.baseSha,
    headSha,
    repositoryId: REPOSITORY_ID,
    prNumber: PR_NUMBER,
    headBranch: TOPIC_BRANCH,
    owner: "example",
    repo: "review-bridge",
    isDraft: true,
    ...options,
  });
}

function sha256Fixture() {
  return fixture({ objectFormat: "sha256" });
}

const LOCAL_FINDING = {
  finding: {
    severity: "major",
    title: "Name the constant",
    explanation: "value is not a name.",
  },
  fixedContent: "export const namedValue = 2;\n",
  resolution: {
    finding_id: "F-001",
    disposition: "fixed",
    rationale: "Renamed the constant.",
  },
  rereview: {
    finding_id: "F-001",
    decision: "resolved",
    rationale: "The rename landed.",
  },
};

test("the local object-id judge accepts both Git object-id widths", () => {
  assert.equal(isLocalObjectId("a".repeat(SHA1_WIDTH)), true);
  assert.equal(isLocalObjectId("a".repeat(SHA256_WIDTH)), true);
  for (const width of [0, 7, 39, 41, 63, 65]) {
    assert.equal(isLocalObjectId("a".repeat(width)), false, `width ${width}`);
  }
  assert.equal(isLocalObjectId("A".repeat(SHA1_WIDTH)), false);
  assert.equal(isLocalObjectId("g".repeat(SHA256_WIDTH)), false);
  for (const value of [null, undefined, 40, {}]) {
    assert.equal(isLocalObjectId(value), false, String(value));
  }
});

test("a sha256 repository runs a full local review and local gate", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  assert.equal(
    git(state.repository, "rev-parse", "--show-object-format"),
    "sha256",
  );
  assert.equal(state.baseSha.length, SHA256_WIDTH);
  const headSha = await commit(state.repository, "export const value = 2;\n");
  assert.equal(headSha.length, SHA256_WIDTH);

  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: "Review a sha256 repository.",
    implementationScope: "Change app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  assert.equal(review.status, "WAITING_FOR_REVIEW");
  await submitInitialReview(state.store, review.id, [LOCAL_FINDING.finding]);
  await commit(state.repository, LOCAL_FINDING.fixedContent);
  await submitResolutions(state.store, review.id, [LOCAL_FINDING.resolution]);
  await prepareRereview(state.store, review.id);
  await submitRereview(state.store, review.id, [LOCAL_FINDING.rereview], []);

  const gated = await finalizeLocalGate(state.store, review.id);
  assert.equal(gated.review.status, "LOCAL_GATE_PASSED");
  assert.equal(gated.gate.head_sha.length, SHA256_WIDTH);
  assert.equal(gated.gate.base_sha, state.baseSha);
});

test("remote authorization on a sha256 repository is refused by name", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const headSha = await commit(state.repository, "export const value = 2;\n");

  await assert.rejects(
    authorizeRemotePublication(state.store, {
      repositoryPath: state.repository,
      baseSha: state.baseSha,
      headSha,
      acknowledgement: "LOCAL_REVIEW_SKIPPED",
      operatorLabel: "Test Operator",
      rationale: "Publishing without a local review.",
    }),
    (error) => {
      assert.equal(error.code, "REPOSITORY_OBJECT_FORMAT_UNPUBLISHABLE");
      assert.match(error.message, /GitHub does not host sha256 repositories/);
      assert.equal(error.details.object_format, "sha256");
      return true;
    },
  );
  // The refusal is the repository's, not the head's: both ids passed the
  // local guard on the way in.
  assert.equal(isLocalObjectId(state.baseSha), true);
  assert.equal(isLocalObjectId(headSha), true);
});

test("starting a publication over a sha256 local gate is refused by name", async (t) => {
  const state = await sha256Fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: "Review a sha256 repository.",
    implementationScope: "Change app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  await submitInitialReview(state.store, review.id, []);
  const gated = await finalizeLocalGate(state.store, review.id);
  assert.equal(gated.gate.head_sha, headSha);

  await assert.rejects(
    startPublication(
      state.store,
      startInput(review.id, Date.now()),
    ),
    (error) => {
      assert.equal(error.code, "REPOSITORY_OBJECT_FORMAT_UNPUBLISHABLE");
      assert.match(error.message, /GitHub does not host sha256 repositories/);
      return true;
    },
  );
});

// A git that does not implement `--show-object-format` treats it as input:
// `git rev-parse` echoes the switch back and exits 0. The shim reproduces that
// contract exactly -- the answer under test, exit 0 -- and delegates every
// other command to the real git, so the probe reads the unrecognized answer
// through the same code path a host with such a git would.
async function withObjectFormatAnswer(t, state, answer) {
  const binDir = path.join(state.root, "old-git");
  await fsp.mkdir(binDir);
  const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).stdout.trim();
  await fsp.writeFile(
    path.join(binDir, "git"),
    [
      "#!/bin/sh",
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-object-format" ]; then',
      `  printf '%s\\n' ${JSON.stringify(answer)}`,
      "  exit 0",
      "fi",
      `exec ${JSON.stringify(realGit)} "$@"`,
    ].join("\n"),
    { mode: 0o755 },
  );
  const restore = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${restore}`;
  t.after(() => {
    process.env.PATH = restore;
  });
}

for (const answer of ["--show-object-format", "", "usage: git rev-parse"]) {
  test(`a sha1 repository publishes when the probe answers ${JSON.stringify(answer)}`, async (t) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const headSha = await commit(state.repository, "export const value = 2;\n");
    await withObjectFormatAnswer(t, state, answer);

    const authorization = await authorizeRemotePublication(state.store, {
      repositoryPath: state.repository,
      baseSha: state.baseSha,
      headSha,
      acknowledgement: "LOCAL_REVIEW_SKIPPED",
      operatorLabel: "Test Operator",
      rationale: "Publishing without a local review.",
    });
    assert.equal(authorization.head_sha, headSha);
  });
}

test("the observation schema keeps GitHub's own object ids at 40", async (t) => {
  const wide = "a".repeat(SHA256_WIDTH);
  const cases = [
    {
      name: "pull_request.head_sha",
      mutate: (payload) => {
        payload.pull_request.head_sha = wide;
        return payload;
      },
    },
    {
      name: "base_head_comparison.head_sha",
      mutate: (payload) => {
        payload.pull_request.base_head_comparison.head_sha = wide;
        return payload;
      },
    },
    {
      name: "BASE_BRANCH_METADATA.branch_tip_sha",
      mutate: (payload) => {
        for (const source of payload.pull_request.collection.sources) {
          if (source.kind === "BASE_BRANCH_METADATA") {
            source.branch_tip_sha = wide;
          }
        }
        return payload;
      },
    },
    {
      name: "BRANCH_METADATA.branch_tip_sha",
      mutate: (payload) => {
        for (const source of payload.required_checks.collection
          .policy_sources) {
          if (source.kind === "BRANCH_METADATA") {
            source.branch_tip_sha = wide;
          }
        }
        return payload;
      },
    },
    {
      name: "result reviewed_head_sha",
      mutate: (payload) => {
        payload.codex_review.results[0].reviewed_head_sha = wide;
        return payload;
      },
    },
    {
      name: "ancestry finding_head_sha",
      // The ancestry's own guard reads the head before the entry is matched
      // to a thread, so it refuses the width under its own name.
      expected: /ancestry finding head/,
      mutate: (payload) => {
        payload.review_threads.ancestry = [
          {
            finding_head_sha: wide,
            status: "AHEAD",
            descends: true,
            endpoint: `GET /repos/example/review-bridge/compare/${wide}...x`,
            collected_at: payload.observed_at,
          },
        ];
        return payload;
      },
    },
  ];
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: "Publish one head.",
    implementationScope: "Change app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  await submitInitialReview(state.store, review.id, []);
  await finalizeLocalGate(state.store, review.id);
  const reviewId = review.id;
  const at = Date.now();
  await startPublication(state.store, startInput(reviewId, at), {
    clock: () => at,
  });
  await recordCodexReviewRequest(
    state.store,
    reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: `https://github.com/example/review-bridge/issues/${PR_NUMBER}#issuecomment-100`,
      createdAt: iso(at + 1_000),
      requestedHeadSha: headSha,
    },
    { clock: () => at + 1_010 },
  );
  // A refused snapshot persists nothing, so every scenario meets the same
  // writer over the same ledger.
  for (const scenario of cases) {
    await assert.rejects(
      recordGithubSnapshot(
        state.store,
        reviewId,
        {
          expectedRevision: 2,
          observation: scenario.mutate(
            draftObservation(state, headSha, {
              at: at + 2_000,
              requestId: 100,
              requestAt: at + 1_000,
            }),
          ),
        },
        { clock: () => at + 2_010 },
      ),
      scenario.expected ?? /must be a 40-character lowercase Git SHA/,
      scenario.name,
    );
  }
  assert.equal((await getPublication(state.store, reviewId)).revision, 2);
});

test("the adapter keeps a review's commit_id and its authorization head at 40", () => {
  const collection = {
    status: "COMPLETE",
    collected_at: "2026-07-27T00:00:00.000Z",
    adapter_version: 1,
  };
  const expectedActor = { id: 99, type: "Bot" };
  const emptyFeeds = {
    issue_comments: [],
    pull_request_reviews: [],
    pull_request_review_comments: [],
  };

  // The authorization head comes from a publication, which a sha256
  // repository never reaches, so a 64-character head is malformed.
  const adapted = adaptCodexEvidence({
    collection,
    expected_actor: expectedActor,
    authorization_head_sha: "a".repeat(SHA1_WIDTH),
    ...emptyFeeds,
  });
  assert.deepEqual(adapted.results, []);

  for (const width of [39, 41, 63, SHA256_WIDTH, 65]) {
    assert.throws(
      () =>
        adaptCodexEvidence({
          collection,
          expected_actor: expectedActor,
          authorization_head_sha: "a".repeat(width),
          ...emptyFeeds,
        }),
      /authorization_head_sha must be a full lowercase Git SHA/,
      `width ${width}`,
    );
  }

  // The commit_id beside it is GitHub's. A review whose commit_id is not a
  // 40-character SHA binds no reviewed head, which is how the adapter has
  // always read a malformed one.
  const review = {
    id: 5,
    body: "Codex Review: findings",
    commit_id: "a".repeat(SHA256_WIDTH),
    user: { id: 99, type: "Bot" },
    html_url: "https://github.com/owner/repo/pull/7#pullrequestreview-5",
    submitted_at: "2026-07-27T00:00:02.000Z",
    state: "COMMENTED",
  };
  const withReview = adaptCodexEvidence({
    collection,
    expected_actor: expectedActor,
    authorization_head_sha: "a".repeat(SHA1_WIDTH),
    ...emptyFeeds,
    pull_request_reviews: [review],
  });
  assert.equal(withReview.results.length, 1);
  assert.equal(withReview.results[0].reviewed_head_sha, null);
  assert.equal(withReview.results[0].commit_binding, null);
});

test("the observation normalizer keeps its authorization head at 40", () => {
  const publication = (headSha) => ({
    version: 2,
    review_id: "rb-2026-07-27T000000-000Z-00000000",
    revision: 4,
    authorization: {
      mode: "REMOTE_ONLY",
      base_sha: "a".repeat(headSha.length),
      head_sha: headSha,
    },
    target: {
      repository_id: 42,
      owner: "owner",
      repo: "repo",
      pr_number: 7,
      base_branch: "main",
      head_branch: "agent/change",
      codex_actor: { id: 99, type: "Bot", login_at_start: "codex[bot]" },
    },
  });
  const authorizationRefusal =
    /publication authorization must contain full base and head SHAs/;

  // The raw collection is deliberately empty: a 40-character head gets past
  // the authorization guard and stops at the first feed instead. A publication
  // exists only past the sha256 refusal, so a 64-character head is refused.
  assert.throws(
    () => normalizeGithubObservation(publication("b".repeat(SHA1_WIDTH)), {}),
    /pull_request must be an object/,
  );
  for (const width of [39, 41, 63, SHA256_WIDTH, 65]) {
    assert.throws(
      () => normalizeGithubObservation(publication("b".repeat(width)), {}),
      authorizationRefusal,
      `width ${width}`,
    );
  }
});
