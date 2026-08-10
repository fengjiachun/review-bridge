import { createHash } from "node:crypto";
import { publicationConstants } from "../../src/publication.mjs";

export function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function retimeObservation(observation, at) {
  delete observation.recorded_at;
  observation.observed_at = iso(at);
  for (const [collection, collectedAt] of [
    [observation.pull_request.collection, at - 700],
    [observation.required_checks.collection, at - 600],
    [observation.codex_review.collection, at - 500],
    [observation.review_threads.collection, at - 400],
  ]) {
    collection.collected_at = iso(collectedAt);
    for (const source of [
      ...(collection.sources ?? []),
      ...(collection.policy_sources ?? []),
      ...(collection.run_sources ?? []),
    ]) {
      source.collected_at = iso(
        source.kind === "BASE_BRANCH_METADATA"
          ? at - 900
          : source.kind === "BRANCH_METADATA"
            ? at - 800
            : collectedAt,
      );
    }
  }
  for (const ancestry of observation.review_threads.ancestry ?? []) {
    ancestry.collected_at = iso(at - 400);
  }
  return observation;
}
export function completeSource(kind, collectedAt, extra = {}) {
  return {
    kind,
    endpoint: `GET /fixture/${kind}`,
    collected_at: collectedAt,
    status: "COMPLETE",
    ...extra,
  };
}

export function baseline(at, requests = []) {
  const sourceAt = iso(at - 100);
  return {
    observed_at: iso(at),
    collection: {
      status: "COMPLETE",
      collected_at: sourceAt,
      adapter_version: 1,
      sources: [
        completeSource("ISSUE_COMMENTS", sourceAt, {
          pagination_complete: true,
          page_count: 1,
        }),
        completeSource("PULL_REQUEST_REVIEWS", sourceAt, {
          pagination_complete: true,
          page_count: 1,
        }),
        completeSource("PULL_REQUEST_REVIEW_COMMENTS", sourceAt, {
          pagination_complete: true,
          page_count: 1,
        }),
      ],
    },
    requests,
    candidate_results: [],
  };
}

export function baselineV2(at, requests = []) {
  const value = baseline(at, requests);
  value.collection.adapter_version = 2;
  return value;
}

export function correlatedRequestBody(requestId) {
  return [
    "@codex review",
    "",
    "When you finish, append exactly this marker to the review summary:",
    `<!-- review-bridge-request-id: ${requestId} -->`,
  ].join("\n");
}

export function observation({
  at,
  baseSha,
  headSha,
  requestId,
  requestAt,
  withResult = true,
  headOverride = headSha,
  baselineRequests = [],
  repositoryId = 42,
  prNumber = 7,
  headBranch = "agent/change",
  owner = "owner",
  repo = "repo",
  isDraft = false,
}) {
  const pullBaseAt = iso(at - 900);
  const checksBaseAt = iso(at - 800);
  const pullAt = iso(at - 700);
  const runAt = iso(at - 600);
  const codexAt = iso(at - 500);
  const threadsAt = iso(at - 400);
  const request = {
    comment_id: requestId,
    resource_kind: "ISSUE_COMMENT",
    url: `https://github.com/${owner}/${repo}/issues/${prNumber}#issuecomment-${requestId}`,
    event_at: iso(requestAt),
    timestamp_field: "created_at",
    body: "@codex review",
    body_sha256: publicationConstants.request_body_sha256,
    requested_head_sha: headSha,
  };
  const result = {
    result_id: requestId + 1,
    resource_kind: "ISSUE_COMMENT",
    native_review_state: null,
    url: `https://github.com/${owner}/${repo}/issues/${prNumber}#issuecomment-${requestId + 1}`,
    event_at: iso(requestAt + 100),
    timestamp_field: "created_at",
    actor: {
      id: 99,
      type: "Bot",
      login: "chatgpt-codex-connector[bot]",
    },
    request_ref: {
      resource_kind: "ISSUE_COMMENT",
      resource_id: requestId,
    },
    association: "SINGLE_OPEN_REQUEST",
    reviewed_head_sha: headSha,
    commit_binding: {
      source: "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
      field: "body.reviewed_commit",
      prefix: headSha.slice(0, 10),
    },
    attached_review_comments: [],
    format: "CODEX_CLEAN_COMMENT_V1",
    verdict: "CLEAN",
    body_sha256: digest("codex clean result"),
  };
  return {
    observed_at: iso(at),
    pull_request: {
      collection: {
        status: "COMPLETE",
        collected_at: pullAt,
        sources: [
          completeSource("PULL_REQUEST", pullAt),
          completeSource("BASE_BRANCH_METADATA", pullBaseAt, {
            branch_tip_sha: baseSha,
          }),
          completeSource("BASE_HEAD_COMPARISON", pullAt),
          completeSource("REVIEWED_BASE_CURRENT_BASE_COMPARISON", pullAt),
        ],
      },
      repository_id: repositoryId,
      number: prNumber,
      url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      state: "OPEN",
      is_merged: false,
      merged_at: null,
      merge_commit_sha: null,
      is_draft: isDraft,
      head_sha: headOverride,
      head_branch: headBranch,
      base_branch: "main",
      pr_reported_base_sha: baseSha,
      base_sha: baseSha,
      mergeable: "MERGEABLE",
      base_head_comparison: {
        status: "AHEAD",
        source: "REST_COMPARE_BASE_TO_HEAD",
        base_sha: baseSha,
        head_sha: headOverride,
      },
      reviewed_base_current_base_comparison: {
        status: "IDENTICAL",
        source: "REST_COMPARE_REVIEWED_BASE_TO_CURRENT_BASE",
        base_sha: baseSha,
        head_sha: baseSha,
      },
    },
    required_checks: {
      collection: {
        status: "COMPLETE",
        collected_at: runAt,
        policy_sources: [
          {
            kind: "APPLICABLE_RULES",
            endpoint: "GET /fixture/rules",
            collected_at: checksBaseAt,
            result: "SUCCESS",
            pagination_complete: true,
            page_count: 1,
          },
          {
            kind: "BRANCH_METADATA",
            endpoint: "GET /fixture/branch",
            collected_at: checksBaseAt,
            result: "SUCCESS",
            protected: false,
            branch_tip_sha: baseSha,
          },
        ],
        run_sources: [
          {
            ...completeSource("CHECK_RUN", runAt, {
            pagination_complete: true,
            page_count: 1,
            item_count: 0,
            reported_total_count: 0,
            }),
            endpoint: "GET /repos/owner/repo/commits/head/check-runs?filter=all",
          },
          completeSource("COMMIT_STATUS", runAt, {
            pagination_complete: true,
            page_count: 1,
            item_count: 0,
            reported_total_count: null,
          }),
        ],
      },
      policy: "NONE_CONFIGURED",
      strict_policy: { required: false, sources: [] },
      requirements: [],
      runs: [],
    },
    codex_review: {
      collection: {
        status: "COMPLETE",
        collected_at: codexAt,
        adapter_version: 1,
        sources: [
          completeSource("ISSUE_COMMENTS", codexAt, {
            pagination_complete: true,
            page_count: 1,
          }),
          completeSource("PULL_REQUEST_REVIEWS", codexAt, {
            pagination_complete: true,
            page_count: 1,
          }),
          completeSource("PULL_REQUEST_REVIEW_COMMENTS", codexAt, {
            pagination_complete: true,
            page_count: 1,
          }),
        ],
      },
      preexisting_requests: baselineRequests,
      preexisting_candidate_results: [],
      requests: requestId == null ? [] : [request],
      unbound_requests: [],
      unsupported_requests: [],
      foreign_actor_objects: [],
      results: withResult && requestId != null ? [result] : [],
    },
    review_threads: {
      collection: {
        status: "COMPLETE",
        collected_at: threadsAt,
        sources: [
          completeSource("PULL_REQUEST_REVIEW_THREADS", threadsAt, {
            pagination_complete: true,
            page_count: 1,
          }),
        ],
      },
      total_count: 0,
      unresolved_count: 0,
      threads: [],
    },
  };
}

export function observationV2(options, requestId) {
  const value = observation(options);
  value.codex_review.collection.adapter_version = 2;
  const request = value.codex_review.requests[0];
  if (request) {
    request.request_id = requestId;
    request.body = correlatedRequestBody(requestId);
    request.body_sha256 = digest(request.body);
  }
  const result = value.codex_review.results[0];
  if (result) {
    result.request_id = requestId;
    result.association = "CORRELATED_REQUEST_ID";
    result.format = "CODEX_CLEAN_COMMENT_V2";
  }
  return value;
}
