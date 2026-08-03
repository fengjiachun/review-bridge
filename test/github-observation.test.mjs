import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectClassicProtection, exceedsSinglePage, linkHasNext, normalizeClassicProtectionResponse, normalizeGithubObservation, normalizeOauthAdminProofResponse, splitGhResponse } from "../src/github-observation.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const requestDigest =
  "7750379659fbba413136c8bf4f500a59f1e03f0c36c0ab16b0a2475eb13ecb1a";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function collected(value, at) {
  return { value, collected_at: at };
}

function pages(value, at, paginationComplete = true) {
  // The collector records the terminal Link state; a fixture that omits it is
  // refused, so the default here mirrors a walk that reached the last page.
  return { pages: value, collected_at: at, pagination_complete: paginationComplete };
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
                  totalCount: 1,
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

function protectedPolicyRaw({
  rulesetChecks = [],
  classicChecks = [],
  legacyContexts = [],
} = {}) {
  const raw = rawCollection();
  raw.policy_base_branch.value.protected = true;
  if (rulesetChecks.length > 0) {
    raw.applicable_rules.pages = [
      [
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: rulesetChecks,
          },
        },
      ],
    ];
  }
  raw.classic_protection = collected(
    {
      required_status_checks: {
        strict: false,
        checks: classicChecks,
        contexts: legacyContexts,
      },
    },
    "2026-07-27T00:00:07.500Z",
  );
  return raw;
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

test("GitHub observation keeps the publication adapter version and request ID", () => {
  const publicationValue = publication();
  const raw = rawCollection();
  const requestId = `rbreq-${"1".repeat(32)}`;
  const body = [
    "@codex review",
    "",
    "When you finish, append exactly this marker to the review summary:",
    `<!-- review-bridge-request-id: ${requestId} -->`,
  ].join("\n");
  publicationValue.codex_review_baseline.collection.adapter_version = 2;
  publicationValue.codex_request_history[0].request_id = requestId;
  publicationValue.codex_request_history[0].body_sha256 = digest(body);
  raw.issue_comments.pages[0][0].body = body;

  const observation = normalizeGithubObservation(publicationValue, raw);
  assert.equal(observation.codex_review.collection.adapter_version, 2);
  assert.equal(observation.codex_review.requests[0].request_id, requestId);
});

test("GitHub observation normalization requires boolean pull-request flags", () => {
  for (const field of ["draft", "merged"]) {
    for (const [label, value, present] of [
      ["omitted", undefined, false],
      ["null", null, true],
      ["non-boolean", "false", true],
    ]) {
      const raw = rawCollection();
      if (present) {
        raw.pull_request.value[field] = value;
      } else {
        delete raw.pull_request.value[field];
      }
      assert.throws(
        () => normalizeGithubObservation(publication(), raw),
        new RegExp(`pull_request\\.${field} must be boolean`),
        `${field} ${label}`,
      );
    }
  }
});

test("GitHub observation normalization requires an explicit check-run total", () => {
  for (const [label, value, present] of [
    ["omitted", undefined, false],
    ["null", null, true],
  ]) {
    const raw = rawCollection();
    const page = { check_runs: [] };
    if (present) {
      page.total_count = value;
    }
    raw.check_runs.pages = [page];
    assert.throws(
      () => normalizeGithubObservation(publication(), raw),
      /check_runs\.pages\[0\] is missing a reported total/,
      label,
    );
  }
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

test("GitHub observation normalization accepts an authenticated ruleset-only policy", () => {
  const raw = protectedPolicyRaw({
    rulesetChecks: [{ context: "ruleset-only", integration_id: 15368 }],
  });
  const permissionSource = normalizeOauthAdminProofResponse(
    {
      status: 0,
      stderr: "",
      stdout:
        'HTTP/2 200 OK\nX-OAuth-Scopes: gist, repo, workflow\n\n{"permissions":{"admin":true}}',
    },
    "/repos/owner/repo",
    "2026-07-27T00:00:07.500Z",
  );
  raw.classic_protection = normalizeClassicProtectionResponse(
    {
      status: 1,
      stderr: "gh: Branch not protected (HTTP 404)\n",
      stdout: "",
    },
    "/repos/owner/repo/branches/main/protection",
    permissionSource,
    "2026-07-27T00:00:07.250Z",
  );

  const observation = normalizeGithubObservation(publication(), raw);

  assert.equal(observation.required_checks.policy, "REQUIRED");
  assert.equal(
    observation.required_checks.requirements[0].context,
    "ruleset-only",
  );
  const classicSource =
    observation.required_checks.collection.policy_sources.find(
      (source) => source.kind === "CLASSIC_BRANCH_PROTECTION",
    );
  assert.equal(classicSource.result, "NOT_CONFIGURED");
  assert.equal(classicSource.http_status, 404);
  const oauthSource =
    observation.required_checks.collection.policy_sources.find(
      (source) => source.kind === "GITHUB_OAUTH_REPOSITORY_PERMISSIONS",
    );
  assert.equal(oauthSource.scope, "repo");
  assert.equal(oauthSource.endpoint, "GET /repos/owner/repo");

  const reversed = structuredClone(raw);
  reversed.classic_protection.permission_source.collected_at =
    "2026-07-27T00:00:07.000Z";
  assert.throws(
    () => normalizeGithubObservation(publication(), reversed),
    /administration proof must not precede the classic-protection 404/,
  );

  assert.throws(
    () =>
      normalizeOauthAdminProofResponse(
        {
          status: 0,
          stderr: "",
          stdout: "",
        },
        "/repos/owner/repo",
        "2026-07-27T00:00:07.500Z",
    ),
    /omitted response headers/,
  );
  for (const repositoryResponse of [
    'HTTP/2 200 OK\nX-OAuth-Scopes: gist, workflow\n\n{"permissions":{"admin":true}}',
    'HTTP/2 200 OK\nX-OAuth-Scopes: repo\n\n{"permissions":{"admin":false}}',
  ]) {
    assert.throws(
      () =>
        normalizeOauthAdminProofResponse(
          {
            status: 0,
            stderr: "",
            stdout: repositoryResponse,
          },
          "/repos/owner/repo",
          "2026-07-27T00:00:07.500Z",
        ),
      /repo-scoped admin gh credentials/,
    );
  }
});

test("classic protection collection preserves each response completion time", () => {
  const calls = [];
  const times = [
    "2026-07-27T00:00:07.250Z",
    "2026-07-27T00:00:07.500Z",
  ];
  const collected = collectClassicProtection(
    "/repos/owner/repo/branches/main/protection",
    "/repos/owner/repo",
    {
      execute(args) {
        calls.push(args);
        return calls.length === 1
          ? {
              status: 1,
              stderr: "gh: Branch not protected (HTTP 404)\n",
              stdout: "",
            }
          : {
              status: 0,
              stderr: "",
              stdout:
                'HTTP/2 200 OK\nX-OAuth-Scopes: repo\n\n{"permissions":{"admin":true}}',
            };
      },
      clock() {
        return times.shift();
      },
    },
  );

  assert.deepEqual(calls, [
    ["api", "/repos/owner/repo/branches/main/protection"],
    ["api", "--include", "/repos/owner/repo"],
  ]);
  assert.equal(collected.collected_at, "2026-07-27T00:00:07.250Z");
  assert.equal(
    collected.permission_source.collected_at,
    "2026-07-27T00:00:07.500Z",
  );
});

test("GitHub observation normalization rejects legacy classic contexts", () => {
  assert.throws(
    () =>
      normalizeGithubObservation(
        publication(),
        protectedPolicyRaw({ legacyContexts: ["legacy-ci"] }),
      ),
    /legacy classic required status contexts have unknown App bindings/,
  );
});

test("GitHub observation normalization distinguishes ruleset binding sentinels", () => {
  for (const [label, integrationId, present, rawRepresentation] of [
    ["absent", undefined, false, "ABSENT"],
    ["null", null, true, "NULL"],
  ]) {
    const check = { context: `ruleset-${label}` };
    if (present) {
      check.integration_id = integrationId;
    }

    const [requirement] = normalizeGithubObservation(
      publication(),
      protectedPolicyRaw({ rulesetChecks: [check] }),
    ).required_checks.requirements;
    assert.equal(requirement.app_binding, "EXPLICITLY_UNBOUND");
    assert.equal(requirement.required_app_id, null);
    assert.equal(
      requirement.binding_sources[0].raw_representation,
      rawRepresentation,
    );
  }

  assert.throws(
    () =>
      normalizeGithubObservation(
        publication(),
        protectedPolicyRaw({
          rulesetChecks: [
            { context: "ruleset-negative-one", integration_id: -1 },
          ],
        }),
      ),
    /ruleset integration_id must be positive, null, or absent/,
  );
});

test("GitHub observation normalization distinguishes classic binding sentinels", () => {
  const requirements = normalizeGithubObservation(
    publication(),
    protectedPolicyRaw({
      classicChecks: [
        { context: "classic-positive", app_id: 15368 },
        { context: "classic-null", app_id: null },
        { context: "classic-negative-one", app_id: -1 },
      ],
    }),
  ).required_checks.requirements;
  assert.deepEqual(
    requirements.map((requirement) => ({
      context: requirement.context,
      app_binding: requirement.app_binding,
      required_app_id: requirement.required_app_id,
      raw_representation:
        requirement.binding_sources[0].raw_representation,
    })),
    [
      {
        context: "classic-negative-one",
        app_binding: "EXPLICITLY_UNBOUND",
        required_app_id: null,
        raw_representation: "NEGATIVE_ONE",
      },
      {
        context: "classic-null",
        app_binding: "EXPLICITLY_UNBOUND",
        required_app_id: null,
        raw_representation: "NULL",
      },
      {
        context: "classic-positive",
        app_binding: "PINNED",
        required_app_id: 15368,
        raw_representation: "POSITIVE_INTEGER",
      },
    ],
  );

  assert.throws(
    () =>
      normalizeGithubObservation(
        publication(),
        protectedPolicyRaw({
          classicChecks: [{ context: "classic-missing" }],
        }),
      ),
    /classic app_id must be positive, -1, or null/,
  );
});

test("GitHub observation normalization requires explicit check arrays", () => {
  for (const [label, value, present] of [
    ["omitted", undefined, false],
    ["null", null, true],
    ["non-array", {}, true],
  ]) {
    const ruleset = protectedPolicyRaw();
    const parameters = {
      strict_required_status_checks_policy: false,
    };
    if (present) {
      parameters.required_status_checks = value;
    }
    ruleset.applicable_rules.pages = [
      [{ type: "required_status_checks", parameters }],
    ];
    assert.throws(
      () => normalizeGithubObservation(publication(), ruleset),
      /rule required_status_checks must be an array/,
      `ruleset ${label}`,
    );

    const classic = protectedPolicyRaw();
    const requiredStatusChecks =
      classic.classic_protection.value.required_status_checks;
    if (present) {
      requiredStatusChecks.checks = value;
    } else {
      delete requiredStatusChecks.checks;
    }
    assert.throws(
      () => normalizeGithubObservation(publication(), classic),
      /classic required status checks must be an array/,
      `classic ${label}`,
    );
  }

  const explicitEmpty = protectedPolicyRaw();
  explicitEmpty.applicable_rules.pages = [
    [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [],
        },
      },
    ],
  ];
  const observation = normalizeGithubObservation(
    publication(),
    explicitEmpty,
  );
  assert.equal(observation.required_checks.policy, "NONE_CONFIGURED");
  assert.deepEqual(observation.required_checks.requirements, []);
});

// The provenance shape below mirrors what GitHub actually returns; it was
// captured from the five real review threads on pull request 23 of this
// repository rather than invented.
function threadWithProvenance(overrides = {}) {
  return {
    id: "PRRT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/value.mjs",
    line: 12,
    comments: {
      totalCount: 1,
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: "PRRC_1",
          databaseId: 3694779367,
          createdAt: "2026-07-27T00:00:01Z",
          updatedAt: "2026-07-27T00:00:01Z",
          author: {
            __typename: "Bot",
            login: "chatgpt-codex-connector",
            databaseId: 199175422,
          },
          pullRequestReview: {
            id: "PRR_1",
            databaseId: 4833836859,
            state: "COMMENTED",
            commit: { oid: headSha },
            author: {
              __typename: "Bot",
              login: "chatgpt-codex-connector",
              databaseId: 199175422,
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function rawWithThread(thread) {
  const value = rawCollection();
  value.review_threads.pages[0].data.repository.pullRequest.reviewThreads.nodes =
    [thread];
  return value;
}

test("thread provenance carries actor identity and the attached review", () => {
  const observation = normalizeGithubObservation(
    publication(),
    rawWithThread(threadWithProvenance()),
  );
  const thread = observation.review_threads.threads[0];
  assert.equal(thread.comment_count, 1);
  assert.equal(thread.comments_pagination_complete, true);
  const root = thread.comments[0];
  assert.equal(root.database_id, 3694779367);
  assert.deepEqual(root.actor, {
    id: 199175422,
    type: "Bot",
    login: "chatgpt-codex-connector",
  });
  assert.equal(root.review.database_id, 4833836859);
  assert.equal(root.review.reviewed_head_sha, headSha);
  assert.deepEqual(root.review.actor, root.actor);
});

test("a thread collected without provenance stays usable", () => {
  // An older collector emits no comments. The normalizer must not invent the
  // fields, so a consumer sees provenance as absent rather than as established.
  const bare = threadWithProvenance();
  delete bare.comments;
  const observation = normalizeGithubObservation(
    publication(),
    rawWithThread(bare),
  );
  const thread = observation.review_threads.threads[0];
  assert.equal(thread.id, "PRRT_1");
  assert.equal("comments" in thread, false);
  assert.equal("comment_count" in thread, false);
});

test("a deleted thread author reports an unknown actor rather than none", () => {
  const ghosted = threadWithProvenance();
  ghosted.comments.nodes[0].author = null;
  const observation = normalizeGithubObservation(
    publication(),
    rawWithThread(ghosted),
  );
  assert.deepEqual(observation.review_threads.threads[0].comments[0].actor, {
    id: null,
    type: null,
    login: null,
  });
});

test("a deleted author yields a thread recorded as incomplete, not a refusal", () => {
  // The normalizer records an unknown actor and the ledger accepts it; these
  // two halves have to compose, or the normalizer emits something that can
  // never be stored.
  const ghosted = threadWithProvenance();
  ghosted.comments.nodes[0].author = null;
  const observation = normalizeGithubObservation(
    publication(),
    rawWithThread(ghosted),
  );
  const thread = observation.review_threads.threads[0];
  assert.equal(thread.comments[0].actor.id, null);
  assert.equal(thread.provenance_complete, false);

  const whole = normalizeGithubObservation(
    publication(),
    rawWithThread(threadWithProvenance()),
  );
  assert.equal(whole.review_threads.threads[0].provenance_complete, true);
});

test("a thread deeper than one comment page is recorded as incomplete", () => {
  const deep = threadWithProvenance();
  deep.comments.totalCount = 250;
  deep.comments.pageInfo.hasNextPage = true;
  const observation = normalizeGithubObservation(
    publication(),
    rawWithThread(deep),
  );
  const thread = observation.review_threads.threads[0];
  assert.equal(thread.comments_pagination_complete, false);
  assert.equal(thread.provenance_complete, false);
});

test("a thread page count that omits a thread is refused", () => {
  // Reaching the end of the cursor is only half the proof: a thread added or
  // removed mid-walk can be omitted while the last page still reports no next
  // page. Deriving the total from what was collected would always agree.
  const dropped = rawCollection();
  const connection =
    dropped.review_threads.pages[0].data.repository.pullRequest.reviewThreads;
  connection.totalCount = 2;
  assert.throws(
    () => normalizeGithubObservation(publication(), dropped),
    /do not account for the reported total/,
  );
});

test("a thread walked across pages is refused, state and all", () => {
  // The hazard the single-page rule exists for. Counts prove membership, not
  // state: a thread read as resolved on page one and unresolved before page
  // two leaves the reported total, the identities and pageInfo all untouched,
  // so no count rule can see it. Recorded, it reads as resolved and drives
  // unresolved_count to zero, which is MERGE_READY on a live unresolved
  // thread. Both pages here are internally consistent -- only the interleaving
  // is wrong.
  const interleaved = rawCollection();
  const first = interleaved.review_threads.pages[0];
  const connection = first.data.repository.pullRequest.reviewThreads;
  const resolved = structuredClone(connection.nodes[0]);
  resolved.id = "PRRT_second";
  resolved.isResolved = true;
  connection.totalCount = 2;
  connection.nodes = [connection.nodes[0], resolved];
  connection.pageInfo = { hasNextPage: true, endCursor: "cursor" };
  const second = structuredClone(first);
  const later = second.data.repository.pullRequest.reviewThreads;
  later.nodes = [];
  later.pageInfo = { hasNextPage: false, endCursor: null };
  interleaved.review_threads.pages = [first, second];
  assert.throws(
    () => normalizeGithubObservation(publication(), interleaved),
    /state cannot be established across multiple pages/,
  );
});

test("a thread page with no reported total is refused", () => {
  const untotalled = rawCollection();
  delete untotalled.review_threads.pages[0].data.repository.pullRequest
    .reviewThreads.totalCount;
  assert.throws(
    () => normalizeGithubObservation(publication(), untotalled),
    /missing a reported total/,
  );
});

test("a page that repeats a thread is refused", () => {
  // Distinct identities, not node count. A repeat would otherwise let the
  // collected length match a provider total that covers one thread more.
  const repeated = rawCollection();
  const connection =
    repeated.review_threads.pages[0].data.repository.pullRequest.reviewThreads;
  connection.totalCount = 2;
  connection.nodes = [connection.nodes[0], structuredClone(connection.nodes[0])];
  assert.throws(
    () => normalizeGithubObservation(publication(), repeated),
    /page repeats a thread/,
  );
});

test("a pull request with no threads at all is still collectable", () => {
  // The count rules must not turn an honestly empty connection into a refusal:
  // one page, a reported total of zero, no nodes.
  const empty = rawCollection();
  const connection =
    empty.review_threads.pages[0].data.repository.pullRequest.reviewThreads;
  connection.totalCount = 0;
  connection.nodes = [];
  const normalized = normalizeGithubObservation(publication(), empty);
  assert.equal(normalized.review_threads.total_count, 0);
  assert.equal(normalized.review_threads.unresolved_count, 0);
  assert.deepEqual(normalized.review_threads.threads, []);
  assert.equal(normalized.review_threads.collection.sources[0].page_count, 1);
});

test("a collection with no pages at all is refused", () => {
  // Distinct from the empty pull request above: no page means nothing ever
  // reported that the walk finished, so there is no proof to read.
  const pageless = rawCollection();
  pageless.review_threads.pages = [];
  assert.throws(
    () => normalizeGithubObservation(publication(), pageless),
    /review-thread collection has no pages/,
  );
});

test("check runs walked across pages are refused, state and all", () => {
  // The same hazard the review threads have, reached through a different
  // field. A run read as successful on page one keeps that conclusion even if
  // it re-runs and fails before page two, and decidingRunsFor takes the latest
  // run per context -- so a stale success can decide a context that is now
  // failing.
  //
  // Both pages are individually and jointly consistent: one distinct run each
  // against a reported total of two. That matters, because a fixture the old
  // rule already rejected would make this test pass on a message change rather
  // than on the behaviour. This input was accepted before and is refused now.
  const interleaved = rawCollection();
  const first = interleaved.check_runs.pages[0];
  const later = structuredClone(first);
  first.total_count = 2;
  later.total_count = 2;
  later.check_runs[0].id = 9002;
  later.check_runs[0].name = "lint";
  interleaved.check_runs.pages = [first, later];
  assert.throws(
    () => normalizeGithubObservation(publication(), interleaved),
    /check-run state cannot be established across multiple pages/,
  );
});

test("commit statuses walked across pages are refused too", () => {
  // decidingRunsFor makes no distinction between the two kinds, and a deciding
  // status drives CHECKS_FAILED and CHECKS_PENDING exactly as a run does, so
  // the atomic-read argument binds statuses without qualification.
  const walked = rawCollection();
  walked.commit_statuses.pages = [[], []];
  assert.throws(
    () => normalizeGithubObservation(publication(), walked),
    /commit-status state cannot be established across multiple pages/,
  );
});

test("a commit with more check runs than one page holds says so", () => {
  // The generic count mismatch gives the operator nothing to act on: this is a
  // standing property of the commit, not a bookkeeping slip or a race.
  const overflowing = rawCollection();
  const page = overflowing.check_runs.pages[0];
  const template = page.check_runs[0];
  page.check_runs = Array.from({ length: 100 }, (unused, index) => ({
    ...structuredClone(template),
    id: 9001 + index,
    name: `check-${index}`,
  }));
  page.total_count = 137;
  assert.throws(
    () => normalizeGithubObservation(publication(), overflowing),
    /commit has 137 check runs; a single atomic page holds at most 100/,
  );
});

test("a check-run page that repeats a run is refused", () => {
  const repeated = rawCollection();
  const page = repeated.check_runs.pages[0];
  page.total_count = 2;
  page.check_runs = [page.check_runs[0], structuredClone(page.check_runs[0])];
  assert.throws(
    () => normalizeGithubObservation(publication(), repeated),
    /check-run page repeats a run/,
  );
});

test("a check-run page that omits a run is refused", () => {
  const dropped = rawCollection();
  dropped.check_runs.pages[0].total_count =
    dropped.check_runs.pages[0].check_runs.length + 1;
  assert.throws(
    () => normalizeGithubObservation(publication(), dropped),
    /do not account for the reported total/,
  );
});

test("a list feed that never proved it reached the last page is refused", () => {
  // These endpoints report no total, so the terminal Link state the collector
  // recorded is the only evidence of exhaustion there is. Without it the walk
  // is unproven, whatever it happened to collect.
  const unproven = rawCollection();
  delete unproven.issue_comments.pagination_complete;
  assert.throws(
    () => normalizeGithubObservation(publication(), unproven),
    /issue_comments did not prove it reached the last page/,
  );
});

test("a list feed that stopped mid-walk is refused", () => {
  const truncated = rawCollection();
  truncated.applicable_rules.pagination_complete = false;
  assert.throws(
    () => normalizeGithubObservation(publication(), truncated),
    /applicable_rules did not prove it reached the last page/,
  );
});

test("the Link header decides whether a walk has reached the last page", () => {
  // Real header values from the GitHub REST API. A full page and a final page
  // are identical in the body, so this parse is the whole proof of exhaustion.
  const full =
    '<https://api.github.com/repositories/1/issues/24/comments?per_page=2&page=2>; rel="next", ' +
    '<https://api.github.com/repositories/1/issues/24/comments?per_page=2&page=3>; rel="last"';
  const last =
    '<https://api.github.com/repositories/1/issues/24/comments?per_page=2&page=1>; rel="prev", ' +
    '<https://api.github.com/repositories/1/issues/24/comments?per_page=2&page=1>; rel="first"';
  assert.equal(linkHasNext(full), true);
  assert.equal(linkHasNext(last), false);
  // No Link header at all means a single unpaginated response, not a next page.
  assert.equal(linkHasNext(""), false);
  // "next" must be the relation, not an accident of the URL it points at.
  assert.equal(
    linkHasNext('<https://api.github.com/next/page?rel=next>; rel="last"'),
    false,
  );
});

test("the response split finds the header boundary in real gh output", () => {
  // Captured from `gh api -i`: the status line ends with \n while the headers
  // that follow end with \r\n, and a blank \r\n precedes the body. Locating
  // that boundary is the part with real risk; linkHasNext only reads what this
  // hands it.
  const captured =
    "HTTP/2.0 200 OK\n" +
    "Content-Type: application/json; charset=utf-8\r\n" +
    'Link: <https://api.github.com/x?page=2>; rel="next"\r\n' +
    "\r\n" +
    '[{"id":1}]';
  const { headers, body } = splitGhResponse(captured, "probe");
  assert.equal(JSON.parse(body)[0].id, 1);
  assert.match(headers, /^HTTP\/2\.0 200 OK/);
  assert.equal(headers.includes('rel="next"'), true);
});

test("a response head that is not understood is an error, not an absent Link", () => {
  // The one direction that would record an unproven walk as complete: a head
  // the parser cannot read looks exactly like GitHub saying there is no next
  // page. Forced colour makes gh emit precisely this.
  assert.throws(
    () => splitGhResponse("\u001b[0;36mLink\u001b[0m: <x>; rel=\"next\"\r\n\r\n[]", "probe"),
    /unreadable response head/,
  );
  assert.throws(() => splitGhResponse("[]", "probe"), /omitted response headers/);
});

test("a full status page still advertising more is the ceiling, not a short read", () => {
  const full = Array.from({ length: 100 }, (unused, index) => ({ id: index }));
  const short = full.slice(0, 99);
  const more = '<https://api.github.com/x?page=2>; rel="next"';
  const done = '<https://api.github.com/x?page=1>; rel="prev"';
  // Full page plus a next page: more statuses exist than one instant can hold.
  assert.equal(exceedsSinglePage(full, more), true);
  // A short page cannot be hiding any, whatever the header says.
  assert.equal(exceedsSinglePage(short, more), false);
  // A full page that is genuinely the last one is fine.
  assert.equal(exceedsSinglePage(full, done), false);
});

test("the normalizer requires a compare for every referenced finding head", () => {
  // A thread whose review examined an earlier head cannot be normalized
  // without the compare that answers the descent question for that head.
  const earlier = "9".repeat(40);
  const thread = threadWithProvenance();
  thread.comments.nodes[0].pullRequestReview.commit = { oid: earlier };
  const raw = rawWithThread(thread);
  assert.throws(
    () => normalizeGithubObservation(publication(), raw),
    /thread_ancestry must be an array/,
  );
  raw.thread_ancestry = [];
  assert.throws(
    () => normalizeGithubObservation(publication(), raw),
    /missing finding head/,
  );
  raw.thread_ancestry = [
    {
      finding_head_sha: earlier,
      value: { status: "ahead" },
      collected_at: "2026-07-27T00:00:09Z",
    },
  ];
  const normalized = normalizeGithubObservation(publication(), raw);
  assert.deepEqual(
    normalized.review_threads.ancestry.map((entry) => ({
      head: entry.finding_head_sha,
      status: entry.status,
      descends: entry.descends,
    })),
    [{ head: earlier, status: "AHEAD", descends: true }],
  );
});

test("the normalizer derives descent from the provider status alone", () => {
  const earlier = "9".repeat(40);
  const thread = threadWithProvenance();
  thread.comments.nodes[0].pullRequestReview.commit = { oid: earlier };
  for (const [status, descends] of [
    ["identical", true],
    ["behind", false],
    ["diverged", false],
    ["unknown", false],
  ]) {
    const raw = rawWithThread(structuredClone(thread));
    raw.thread_ancestry = [
      {
        finding_head_sha: earlier,
        value: { status },
        collected_at: "2026-07-27T00:00:09Z",
      },
    ];
    const normalized = normalizeGithubObservation(publication(), raw);
    assert.equal(
      normalized.review_threads.ancestry[0].descends,
      descends,
      status,
    );
  }
});
