import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGithubObservation } from "../src/github-observation.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const requestDigest =
  "7750379659fbba413136c8bf4f500a59f1e03f0c36c0ab16b0a2475eb13ecb1a";

function collected(value, at) {
  return { value, collected_at: at };
}

function pages(value, at) {
  return { pages: value, collected_at: at };
}

function publication() {
  return {
    version: 2,
    review_id: "rb-2026-07-27T000000-000Z-00000000",
    revision: 4,
    authorization: {
      mode: "REMOTE_ONLY",
      base_sha: baseSha,
      head_sha: headSha,
    },
    target: {
      repository_id: 42,
      owner: "owner",
      repo: "repo",
      pr_number: 7,
      base_branch: "main",
      head_branch: "agent/change",
      codex_actor: {
        id: 99,
        type: "Bot",
        login_at_start: "chatgpt-codex-connector[bot]",
      },
    },
    codex_review_baseline: {
      observed_at: "2026-07-27T00:00:00.000Z",
      collection: {
        status: "COMPLETE",
        collected_at: "2026-07-27T00:00:00.000Z",
        adapter_version: 1,
        sources: [],
      },
      requests: [],
      candidate_results: [],
    },
    codex_request_history: [
      {
        resource_id: 100,
        resource_kind: "ISSUE_COMMENT",
        classification: "RECOGNIZED",
        binding_source: "RECORDED_AT_POST",
        url: "https://github.com/owner/repo/pull/7#issuecomment-100",
        event_at: "2026-07-27T00:00:01.000Z",
        timestamp_field: "created_at",
        recorded_at: "2026-07-27T00:00:01.100Z",
        recorded_revision: 4,
        body_sha256: requestDigest,
        requested_head_sha: headSha,
      },
    ],
    codex_review_ambiguity_acknowledgements: [],
  };
}

function rawCollection() {
  return {
    pull_request: collected(
      {
        id: 700,
        number: 7,
        html_url: "https://github.com/owner/repo/pull/7",
        state: "open",
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        draft: false,
        mergeable: true,
        head: { sha: headSha, ref: "agent/change" },
        base: {
          sha: baseSha,
          ref: "main",
          repo: { id: 42 },
        },
      },
      "2026-07-27T00:00:02Z",
    ),
    pull_base_branch: collected(
      { protected: false, commit: { sha: baseSha } },
      "2026-07-27T00:00:03Z",
    ),
    base_head_comparison: collected(
      { status: "ahead" },
      "2026-07-27T00:00:04Z",
    ),
    reviewed_base_comparison: collected(
      { status: "identical" },
      "2026-07-27T00:00:05Z",
    ),
    applicable_rules: pages([[]], "2026-07-27T00:00:06Z"),
    policy_base_branch: collected(
      { protected: false, commit: { sha: baseSha } },
      "2026-07-27T00:00:07Z",
    ),
    classic_protection: null,
    check_runs: pages(
      [
        {
          total_count: 1,
          check_runs: [
            {
              id: 9001,
              name: "test",
              head_sha: headSha,
              started_at: "2026-07-27T00:00:01Z",
              status: "completed",
              completed_at: "2026-07-27T00:00:02Z",
              conclusion: "success",
              app: { id: 15368 },
            },
          ],
        },
      ],
      "2026-07-27T00:00:08Z",
    ),
    commit_statuses: pages([[]], "2026-07-27T00:00:09Z"),
    issue_comments: pages(
      [
        [
          {
            id: 100,
            html_url:
              "https://github.com/owner/repo/pull/7#issuecomment-100",
            created_at: "2026-07-27T00:00:01Z",
            body: "@codex review",
            user: { id: 123, type: "User", login: "maintainer" },
          },
        ],
      ],
      "2026-07-27T00:00:10Z",
    ),
    pull_request_reviews: pages([[]], "2026-07-27T00:00:11Z"),
    pull_request_review_comments: pages([[]], "2026-07-27T00:00:12Z"),
    review_threads: pages(
      [
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_1",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/value.mjs",
                      line: 12,
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      ],
      "2026-07-27T00:00:13Z",
    ),
    observed_at: "2026-07-27T00:00:14Z",
  };
}

test("GitHub observation normalization canonicalizes times and pagination", () => {
  const observation = normalizeGithubObservation(
    publication(),
    rawCollection(),
  );

  assert.equal(observation.observed_at, "2026-07-27T00:00:14.000Z");
  assert.equal(observation.pull_request.head_sha, headSha);
  assert.equal(observation.pull_request.base_sha, baseSha);
  assert.equal(observation.pull_request.is_merged, false);
  assert.equal(observation.pull_request.merged_at, null);
  assert.equal(observation.required_checks.policy, "NONE_CONFIGURED");
  assert.deepEqual(observation.required_checks.requirements, []);
  assert.equal(
    observation.required_checks.runs[0].started_at,
    "2026-07-27T00:00:01.000Z",
  );
  assert.equal(
    observation.required_checks.collection.run_sources[0].reported_total_count,
    1,
  );
  assert.equal(observation.codex_review.requests[0].comment_id, 100);
  assert.equal(observation.codex_review.results.length, 0);
  assert.equal(observation.review_threads.total_count, 1);
  assert.equal(observation.review_threads.unresolved_count, 1);
  assert.equal(
    observation.review_threads.collection.sources[0].page_count,
    1,
  );
});

test("GitHub observation normalization fails closed without protected-branch evidence", () => {
  const raw = rawCollection();
  raw.policy_base_branch.value.protected = true;
  assert.throws(
    () => normalizeGithubObservation(publication(), raw),
    /classic branch protection evidence is required/,
  );
});

test("GitHub observation normalization retains ruleset and classic check bindings", () => {
  const raw = rawCollection();
  raw.policy_base_branch.value.protected = true;
  raw.applicable_rules.pages = [
    [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            { context: "test", integration_id: 15368 },
          ],
        },
      },
    ],
  ];
  raw.classic_protection = collected(
    {
      required_status_checks: {
        strict: true,
        checks: [{ context: "security", app_id: -1 }],
      },
    },
    "2026-07-27T00:00:07.500Z",
  );

  const observation = normalizeGithubObservation(publication(), raw);
  assert.equal(observation.required_checks.policy, "REQUIRED");
  assert.equal(observation.required_checks.strict_policy.required, true);
  assert.deepEqual(
    observation.required_checks.requirements.map((requirement) => ({
      context: requirement.context,
      app_binding: requirement.app_binding,
      required_app_id: requirement.required_app_id,
    })),
    [
      {
        context: "security",
        app_binding: "EXPLICITLY_UNBOUND",
        required_app_id: null,
      },
      {
        context: "test",
        app_binding: "PINNED",
        required_app_id: 15368,
      },
    ],
  );
});

test("GitHub observation normalization retains legacy classic contexts", () => {
  const raw = rawCollection();
  raw.policy_base_branch.value.protected = true;
  raw.classic_protection = collected(
    {
      required_status_checks: {
        strict: false,
        checks: [],
        contexts: ["legacy-ci"],
      },
    },
    "2026-07-27T00:00:07.500Z",
  );

  const observation = normalizeGithubObservation(publication(), raw);
  assert.deepEqual(observation.required_checks.requirements, [
    {
      context: "legacy-ci",
      app_binding: "EXPLICITLY_UNBOUND",
      required_app_id: null,
      binding_sources: [
        {
          kind: "CLASSIC_BRANCH_PROTECTION",
          field: "required_status_checks.contexts[]",
          raw_representation: "ABSENT",
        },
      ],
    },
  ]);
});
