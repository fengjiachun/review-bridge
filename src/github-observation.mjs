import { spawnSync } from "node:child_process";
import { adaptCodexEvidence } from "./github-adapter.mjs";

function object(value, name) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function array(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function canonicalTime(value, name) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${name} must be an RFC 3339 timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function latestTime(values) {
  return values.slice().sort().at(-1);
}

function authorization(publication) {
  const value = publication.authorization ?? publication.local_gate;
  object(value, "publication authorization");
  if (
    !/^[0-9a-f]{40}$/.test(value.base_sha ?? "") ||
    !/^[0-9a-f]{40}$/.test(value.head_sha ?? "")
  ) {
    throw new Error("publication authorization must contain full base and head SHAs");
  }
  return {
    mode: value.mode ?? "LOCAL_GATE",
    base_sha: value.base_sha,
    head_sha: value.head_sha,
  };
}

function itemPages(entry, name) {
  const pages = array(entry?.pages, `${name}.pages`);
  return {
    pages,
    items: pages.flatMap((page, index) =>
      array(page, `${name}.pages[${index}]`),
    ),
    collectedAt: canonicalTime(entry.collected_at, `${name}.collected_at`),
  };
}

function completeSource(kind, endpoint, collectedAt, extra = {}) {
  return {
    kind,
    endpoint,
    collected_at: collectedAt,
    ...extra,
  };
}

function compareStatus(value) {
  const status = String(value ?? "unknown").toUpperCase();
  return ["AHEAD", "IDENTICAL", "BEHIND", "DIVERGED"].includes(status)
    ? status
    : "UNKNOWN";
}

function binding(
  value,
  present,
  source,
  { allowAbsent, allowNegativeOne, label },
) {
  if (!present) {
    if (!allowAbsent) {
      throw new Error(`${label} must be positive, -1, or null`);
    }
    return {
      appBinding: "EXPLICITLY_UNBOUND",
      requiredAppId: null,
      source: { ...source, raw_representation: "ABSENT" },
    };
  }
  if (value === null) {
    return {
      appBinding: "EXPLICITLY_UNBOUND",
      requiredAppId: null,
      source: { ...source, raw_representation: "NULL" },
    };
  }
  if (value === -1) {
    if (!allowNegativeOne) {
      throw new Error(`${label} must be positive, null, or absent`);
    }
    return {
      appBinding: "EXPLICITLY_UNBOUND",
      requiredAppId: null,
      source: { ...source, raw_representation: "NEGATIVE_ONE" },
    };
  }
  if (Number.isSafeInteger(value) && value > 0) {
    return {
      appBinding: "PINNED",
      requiredAppId: value,
      source: { ...source, raw_representation: "POSITIVE_INTEGER" },
    };
  }
  throw new Error(
    allowNegativeOne
      ? `${label} must be positive, -1, or null`
      : `${label} must be positive, null, or absent`,
  );
}

function normalizePolicy(publication, raw) {
  const target = object(publication.target, "publication.target");
  const rulesPage = itemPages(raw.applicable_rules, "applicable_rules");
  const branchEntry = object(raw.policy_base_branch, "policy_base_branch");
  const branch = object(branchEntry.value, "policy_base_branch.value");
  const branchAt = canonicalTime(
    branchEntry.collected_at,
    "policy_base_branch.collected_at",
  );
  const rulesEndpoint =
    raw.applicable_rules.endpoint ??
    `GET /repos/${target.owner}/${target.repo}/rules/branches/${target.base_branch}?per_page=100`;
  const policySources = [
    completeSource(
      "APPLICABLE_RULES",
      rulesEndpoint,
      rulesPage.collectedAt,
      {
        result: "SUCCESS",
        binding_field:
          "rules[].parameters.required_status_checks[].integration_id",
        pagination_complete: true,
        page_count: rulesPage.pages.length,
      },
    ),
    completeSource(
      "BRANCH_METADATA",
      raw.policy_base_branch.endpoint ??
        `GET /repos/${target.owner}/${target.repo}/branches/${target.base_branch}`,
      branchAt,
      {
        result: "SUCCESS",
        protected: branch.protected,
        branch_tip_sha: branch.commit?.sha,
      },
    ),
  ];
  if (typeof branch.protected !== "boolean") {
    throw new Error("branch metadata must contain protected");
  }

  const needsClassicProtection =
    branch.protected ||
    rulesPage.items.some((rule) => rule?.type === "required_status_checks");
  if (needsClassicProtection && raw.classic_protection == null) {
    throw new Error(
      "classic branch protection evidence is required for a protected branch or applicable rules",
    );
  }
  let classic = null;
  if (raw.classic_protection != null) {
    const classicEntry = object(raw.classic_protection, "classic_protection");
    const classicResult = classicEntry.result ?? "SUCCESS";
    const classicCollectedAt = canonicalTime(
      classicEntry.collected_at,
      "classic_protection.collected_at",
    );
    let permissionSource = null;
    if (classicResult === "NOT_CONFIGURED") {
      const permission = object(
        classicEntry.permission_source,
        "classic_protection.permission_source",
      );
      if (
        classicEntry.value !== null ||
        classicEntry.http_status !== 404 ||
        permission.kind !== "GITHUB_OAUTH_REPOSITORY_PERMISSIONS" ||
        permission.endpoint !==
          `GET /repos/${target.owner}/${target.repo}` ||
        permission.result !== "SUCCESS" ||
        permission.credential_type !== "OAUTH_SCOPE_TOKEN" ||
        permission.field !== "x-oauth-scopes+permissions.admin" ||
        permission.level !== "ADMIN" ||
        permission.scope !== "repo"
      ) {
        throw new Error(
          "classic branch protection absence requires repo-scoped OAuth administration proof",
        );
      }
      const permissionCollectedAt = canonicalTime(
        permission.collected_at,
        "classic_protection.permission_source.collected_at",
      );
      if (
        Date.parse(permissionCollectedAt) < Date.parse(classicCollectedAt)
      ) {
        throw new Error(
          "administration proof must not precede the classic-protection 404",
        );
      }
      permissionSource = completeSource(
        permission.kind,
        permission.endpoint,
        permissionCollectedAt,
        {
          result: permission.result,
          credential_type: permission.credential_type,
          field: permission.field,
          level: permission.level,
          scope: permission.scope,
        },
      );
    } else if (classicResult === "SUCCESS") {
      classic = object(classicEntry.value, "classic_protection.value");
    } else {
      throw new Error("classic branch protection result is unsupported");
    }
    policySources.push(
      completeSource(
        "CLASSIC_BRANCH_PROTECTION",
        classicEntry.endpoint ??
          `GET /repos/${target.owner}/${target.repo}/branches/${target.base_branch}/protection`,
        classicCollectedAt,
        {
          result: classicResult,
          binding_field: "required_status_checks.checks[].app_id",
          ...(classicResult === "NOT_CONFIGURED"
            ? { http_status: classicEntry.http_status }
            : {}),
        },
      ),
    );
    if (permissionSource != null) {
      policySources.push(permissionSource);
    }
  }

  const requirements = new Map();
  const strictSources = [];
  const addRequirement = (
    context,
    appValue,
    present,
    source,
    bindingPolicy,
  ) => {
    if (typeof context !== "string" || context.length === 0) {
      throw new Error("required-check context must be a non-empty string");
    }
    const normalized = binding(
      appValue,
      present,
      source,
      bindingPolicy,
    );
    const key = `${context}:${normalized.appBinding}:${normalized.requiredAppId}`;
    const existing = requirements.get(key);
    if (existing) {
      existing.binding_sources.push(normalized.source);
      return;
    }
    requirements.set(key, {
      context,
      app_binding: normalized.appBinding,
      required_app_id: normalized.requiredAppId,
      binding_sources: [normalized.source],
    });
  };

  for (const rule of rulesPage.items) {
    if (rule?.type !== "required_status_checks") {
      continue;
    }
    const parameters = object(
      rule.parameters,
      "required_status_checks rule parameters",
    );
    if (typeof parameters.strict_required_status_checks_policy !== "boolean") {
      throw new Error("required-status-checks rules must expose a boolean strict policy");
    }
    strictSources.push({
      kind: "APPLICABLE_RULES",
      field: "rules[].parameters.strict_required_status_checks_policy",
      value: parameters.strict_required_status_checks_policy,
    });
    for (const check of array(
      parameters.required_status_checks,
      "rule required_status_checks",
    )) {
      addRequirement(
        check.context,
        check.integration_id,
        Object.hasOwn(check, "integration_id"),
        {
          kind: "APPLICABLE_RULES",
          field:
            "rules[].parameters.required_status_checks[].integration_id",
        },
        {
          allowAbsent: true,
          allowNegativeOne: false,
          label: "ruleset integration_id",
        },
      );
    }
  }

  const classicChecks = classic?.required_status_checks;
  if (classicChecks != null) {
    object(classicChecks, "classic required_status_checks");
    if (typeof classicChecks.strict !== "boolean") {
      throw new Error("classic required status checks must expose strict");
    }
    strictSources.push({
      kind: "CLASSIC_BRANCH_PROTECTION",
      field: "required_status_checks.strict",
      value: classicChecks.strict,
    });
    const checks = array(
      classicChecks.checks,
      "classic required status checks",
    );
    if (checks.length > 0) {
      for (const check of checks) {
        addRequirement(
          check.context,
          check.app_id,
          Object.hasOwn(check, "app_id"),
          {
            kind: "CLASSIC_BRANCH_PROTECTION",
            field: "required_status_checks.checks[].app_id",
          },
          {
            allowAbsent: false,
            allowNegativeOne: true,
            label: "classic app_id",
          },
        );
      }
    } else {
      const contexts = array(
        classicChecks.contexts ?? [],
        "classic required status contexts",
      );
      if (contexts.length > 0) {
        throw new Error(
          "legacy classic required status contexts have unknown App bindings",
        );
      }
    }
  }

  const normalizedRequirements = [...requirements.values()].sort(
    (left, right) =>
      left.context.localeCompare(right.context) ||
      left.app_binding.localeCompare(right.app_binding) ||
      (left.required_app_id ?? -1) - (right.required_app_id ?? -1),
  );
  const strictRequired = strictSources.some((source) => source.value);
  return {
    policySources,
    strictPolicy: {
      required: strictRequired,
      sources: strictSources,
    },
    requirements: normalizedRequirements,
    policy:
      normalizedRequirements.length > 0
        ? "REQUIRED"
        : strictRequired
          ? "STRICT_ONLY"
          : "NONE_CONFIGURED",
  };
}

function normalizeRuns(publication, raw) {
  const authorizationValue = authorization(publication);
  const target = object(publication.target, "publication.target");
  const checkPages = array(raw.check_runs?.pages, "check_runs.pages");
  const checkRuns = checkPages.flatMap((page, index) =>
    array(page?.check_runs, `check_runs.pages[${index}].check_runs`),
  );
  const reportedTotal = checkPages[0]?.total_count;
  if (
    !Number.isSafeInteger(reportedTotal) ||
    reportedTotal < 0 ||
    reportedTotal !== checkRuns.length
  ) {
    throw new Error("check-run pagination is incomplete or inconsistent");
  }
  const statusPage = itemPages(raw.commit_statuses, "commit_statuses");
  const runs = checkRuns.map((run) => {
    const status = String(run.status).toUpperCase();
    const completed = status === "COMPLETED";
    return {
      run_id: run.id,
      run_kind: "CHECK_RUN",
      context: run.name,
      head_sha: run.head_sha,
      started_at: canonicalTime(run.started_at, `check run ${run.id} started_at`),
      status,
      completed_at: completed
        ? canonicalTime(run.completed_at, `check run ${run.id} completed_at`)
        : null,
      conclusion:
        completed && run.conclusion != null
          ? String(run.conclusion).toUpperCase()
          : null,
      app_id: run.app?.id,
      app_id_source: "CHECK_RUN_APP_ID",
    };
  });
  for (const status of statusPage.items) {
    const state = String(status.state).toUpperCase();
    const pending = state === "PENDING";
    let conclusion = null;
    if (!pending) {
      if (state === "SUCCESS") {
        conclusion = "SUCCESS";
      } else if (state === "FAILURE" || state === "ERROR") {
        conclusion = "FAILURE";
      } else {
        throw new Error(`unsupported commit status state ${status.state}`);
      }
    }
    runs.push({
      run_id: status.id,
      run_kind: "COMMIT_STATUS",
      context: status.context,
      head_sha: authorizationValue.head_sha,
      started_at: canonicalTime(
        status.created_at,
        `commit status ${status.id} created_at`,
      ),
      status: pending ? "PENDING" : "COMPLETED",
      completed_at: pending
        ? null
        : canonicalTime(
            status.updated_at,
            `commit status ${status.id} updated_at`,
          ),
      conclusion,
      app_id: null,
      app_id_source: "COMMIT_STATUS_UNAVAILABLE",
    });
  }
  const checkAt = canonicalTime(raw.check_runs.collected_at, "check_runs.collected_at");
  const statusAt = statusPage.collectedAt;
  return {
    runs,
    sources: [
      completeSource(
        "CHECK_RUN",
        raw.check_runs.endpoint ??
          `GET /repos/${target.owner}/${target.repo}/commits/${authorizationValue.head_sha}/check-runs?filter=all&per_page=100`,
        checkAt,
        {
          status: "COMPLETE",
          pagination_complete: true,
          page_count: checkPages.length,
          item_count: checkRuns.length,
          reported_total_count: reportedTotal,
        },
      ),
      completeSource(
        "COMMIT_STATUS",
        raw.commit_statuses.endpoint ??
          `GET /repos/${target.owner}/${target.repo}/commits/${authorizationValue.head_sha}/statuses?per_page=100`,
        statusAt,
        {
          status: "COMPLETE",
          pagination_complete: true,
          page_count: statusPage.pages.length,
          item_count: statusPage.items.length,
          reported_total_count: null,
        },
      ),
    ],
  };
}

function normalizeCodex(publication, raw) {
  const target = object(publication.target, "publication.target");
  const authorizationValue = authorization(publication);
  const feeds = [
    ["ISSUE_COMMENTS", "issue_comments", `/repos/${target.owner}/${target.repo}/issues/${target.pr_number}/comments?per_page=100`],
    ["PULL_REQUEST_REVIEWS", "pull_request_reviews", `/repos/${target.owner}/${target.repo}/pulls/${target.pr_number}/reviews?per_page=100`],
    ["PULL_REQUEST_REVIEW_COMMENTS", "pull_request_review_comments", `/repos/${target.owner}/${target.repo}/pulls/${target.pr_number}/comments?per_page=100`],
  ].map(([kind, key, endpoint]) => {
    const normalized = itemPages(raw[key], key);
    return {
      key,
      items: normalized.items,
      source: completeSource(
        kind,
        raw[key].endpoint ?? `GET ${endpoint}`,
        normalized.collectedAt,
        {
          status: "COMPLETE",
          pagination_complete: true,
          page_count: normalized.pages.length,
        },
      ),
    };
  });
  const collectionAt = latestTime(
    feeds.map((feed) => feed.source.collected_at),
  );
  return adaptCodexEvidence({
    mode: "SNAPSHOT",
    collection: {
      status: "COMPLETE",
      collected_at: collectionAt,
      sources: feeds.map((feed) => feed.source),
      adapter_version:
        publication.codex_review_baseline.collection.adapter_version,
    },
    expected_actor: {
      id: target.codex_actor.id,
      type: target.codex_actor.type,
    },
    authorization_head_sha: authorizationValue.head_sha,
    baseline: publication.codex_review_baseline,
    request_history: publication.codex_request_history,
    ambiguity_acknowledgements:
      publication.codex_review_ambiguity_acknowledgements,
    issue_comments: feeds[0].items,
    pull_request_reviews: feeds[1].items,
    pull_request_review_comments: feeds[2].items,
  });
}

/**
 * A deleted account resolves to a null author in GraphQL. Report that as an
 * explicit unknown actor rather than dropping the field, so the reviewer sees
 * that provenance is missing instead of absent.
 */
function normalizedThreadActor(author) {
  if (author == null) {
    return { id: null, type: null, login: null };
  }
  return {
    id: author.databaseId ?? null,
    type: author.__typename ?? null,
    login: author.login ?? null,
  };
}

/**
 * Whether a thread's evidence is complete enough to decide anything from.
 *
 * Incompleteness is recorded, not rejected: a thread deeper than one comment
 * page, or one whose author GitHub can no longer resolve to a numeric ID, is
 * a real thread that simply cannot be acted on. Refusing the whole observation
 * for it would stall the publication behind a fact no fix can change, so this
 * is the flag a consumer checks before treating a thread as eligible.
 *
 * Derived from the evidence, never supplied: the ledger re-derives it and
 * refuses a stored value that disagrees.
 */
export function threadProvenanceComplete(thread) {
  const comments = thread.comments;
  if (!Array.isArray(comments) || comments.length === 0) {
    return false;
  }
  const root = comments[0];
  return (
    thread.comments_pagination_complete === true &&
    thread.comment_count === comments.length &&
    Number.isSafeInteger(root?.actor?.id) &&
    root?.review != null
  );
}

function normalizeThreads(publication, raw) {
  const target = object(publication.target, "publication.target");
  const pages = array(raw.review_threads?.pages, "review_threads.pages");
  const threads = pages.flatMap((page, index) =>
    array(
      page?.data?.repository?.pullRequest?.reviewThreads?.nodes,
      `review_threads.pages[${index}].nodes`,
    ),
  );
  const lastPageInfo =
    pages.at(-1)?.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
  if (lastPageInfo?.hasNextPage !== false) {
    throw new Error("review-thread pagination is incomplete");
  }
  const collectedAt = canonicalTime(
    raw.review_threads.collected_at,
    "review_threads.collected_at",
  );
  const normalized = threads.map((thread) => {
    const base = {
      id: thread.id,
      is_resolved: thread.isResolved,
      is_outdated: thread.isOutdated,
      path: thread.path,
      line: thread.line ?? null,
    };
    // Provenance is emitted only when the collection carried it. The ledger
    // validates it the same way -- present and complete, or absent -- so an
    // older collector stays usable until a consumer actually requires it.
    if (thread.comments == null) {
      return base;
    }
    const comments = array(
      thread.comments.nodes,
      `review thread ${thread.id} comments`,
    );
    const normalizedComments = comments.map((comment) => ({
        id: comment.id,
        database_id: comment.databaseId,
        created_at: canonicalTime(
          comment.createdAt,
          `review comment ${comment.databaseId} createdAt`,
        ),
        updated_at: canonicalTime(
          comment.updatedAt,
          `review comment ${comment.databaseId} updatedAt`,
        ),
        actor: normalizedThreadActor(comment.author),
        review:
          comment.pullRequestReview == null
            ? null
            : {
                id: comment.pullRequestReview.id,
                database_id: comment.pullRequestReview.databaseId,
                state: comment.pullRequestReview.state,
                reviewed_head_sha:
                  comment.pullRequestReview.commit?.oid ?? null,
                actor: normalizedThreadActor(
                  comment.pullRequestReview.author,
                ),
              },
    }));
    return {
      ...base,
      comment_count: thread.comments.totalCount ?? null,
      comments_pagination_complete:
        thread.comments.pageInfo?.hasNextPage === false,
      comments: normalizedComments,
      provenance_complete: threadProvenanceComplete({
        comment_count: thread.comments.totalCount ?? null,
        comments_pagination_complete:
          thread.comments.pageInfo?.hasNextPage === false,
        comments: normalizedComments,
      }),
    };
  });
  return {
    collection: {
      status: "COMPLETE",
      collected_at: collectedAt,
      sources: [
        completeSource(
          "PULL_REQUEST_REVIEW_THREADS",
          raw.review_threads.endpoint ??
            `POST graphql:reviewThreads(${target.owner}/${target.repo}#${target.pr_number})`,
          collectedAt,
          {
            status: "COMPLETE",
            pagination_complete: true,
            page_count: pages.length,
          },
        ),
      ],
    },
    total_count: normalized.length,
    unresolved_count: normalized.filter((thread) => !thread.is_resolved).length,
    threads: normalized,
  };
}

export function normalizeGithubObservation(publicationInput, rawInput) {
  const publication = object(publicationInput, "publication");
  const raw = object(rawInput, "raw GitHub collection");
  const target = object(publication.target, "publication.target");
  const authorizationValue = authorization(publication);
  const prEntry = object(raw.pull_request, "pull_request");
  const pr = object(prEntry.value, "pull_request.value");
  for (const field of ["draft", "merged"]) {
    if (typeof pr[field] !== "boolean") {
      throw new Error(`pull_request.${field} must be boolean`);
    }
  }
  const pullBranchEntry = object(raw.pull_base_branch, "pull_base_branch");
  const pullBranch = object(pullBranchEntry.value, "pull_base_branch.value");
  const baseHeadEntry = object(raw.base_head_comparison, "base_head_comparison");
  const reviewedEntry = object(
    raw.reviewed_base_comparison,
    "reviewed_base_comparison",
  );
  const pullTimes = [
    canonicalTime(prEntry.collected_at, "pull_request.collected_at"),
    canonicalTime(
      pullBranchEntry.collected_at,
      "pull_base_branch.collected_at",
    ),
    canonicalTime(
      baseHeadEntry.collected_at,
      "base_head_comparison.collected_at",
    ),
    canonicalTime(
      reviewedEntry.collected_at,
      "reviewed_base_comparison.collected_at",
    ),
  ];
  const liveBaseSha = pullBranch.commit?.sha;
  const pullSources = [
    completeSource(
      "PULL_REQUEST",
      prEntry.endpoint ??
        `GET /repos/${target.owner}/${target.repo}/pulls/${target.pr_number}`,
      pullTimes[0],
      { status: "COMPLETE" },
    ),
    completeSource(
      "BASE_BRANCH_METADATA",
      pullBranchEntry.endpoint ??
        `GET /repos/${target.owner}/${target.repo}/branches/${target.base_branch}`,
      pullTimes[1],
      {
        result: "SUCCESS",
        branch_tip_sha: liveBaseSha,
      },
    ),
    completeSource(
      "BASE_HEAD_COMPARISON",
      baseHeadEntry.endpoint ??
        `GET /repos/${target.owner}/${target.repo}/compare/${liveBaseSha}...${authorizationValue.head_sha}`,
      pullTimes[2],
      { result: "SUCCESS" },
    ),
    completeSource(
      "REVIEWED_BASE_CURRENT_BASE_COMPARISON",
      reviewedEntry.endpoint ??
        `GET /repos/${target.owner}/${target.repo}/compare/${authorizationValue.base_sha}...${liveBaseSha}`,
      pullTimes[3],
      { result: "SUCCESS" },
    ),
  ];
  const policy = normalizePolicy(publication, raw);
  const runEvidence = normalizeRuns(publication, raw);
  return {
    observed_at: canonicalTime(raw.observed_at, "observed_at"),
    pull_request: {
      collection: {
        status: "COMPLETE",
        collected_at: latestTime(pullTimes),
        sources: pullSources,
      },
      repository_id: pr.base?.repo?.id,
      number: pr.number,
      url: pr.html_url,
      state: String(pr.state).toUpperCase(),
      is_merged: pr.merged === true,
      merged_at:
        pr.merged === true
          ? canonicalTime(pr.merged_at, "pull_request.merged_at")
          : null,
      merge_commit_sha: pr.merged === true ? pr.merge_commit_sha : null,
      is_draft: pr.draft === true,
      head_sha: pr.head?.sha,
      head_branch: pr.head?.ref,
      base_branch: pr.base?.ref,
      pr_reported_base_sha: pr.base?.sha,
      base_sha: liveBaseSha,
      mergeable:
        pr.mergeable === true
          ? "MERGEABLE"
          : pr.mergeable === false
            ? "CONFLICTING"
            : "UNKNOWN",
      base_head_comparison: {
        status: compareStatus(baseHeadEntry.value?.status),
        source: "REST_COMPARE_BASE_TO_HEAD",
        base_sha: liveBaseSha,
        head_sha: authorizationValue.head_sha,
      },
      reviewed_base_current_base_comparison: {
        status: compareStatus(reviewedEntry.value?.status),
        source: "REST_COMPARE_REVIEWED_BASE_TO_CURRENT_BASE",
        base_sha: authorizationValue.base_sha,
        head_sha: liveBaseSha,
      },
    },
    required_checks: {
      collection: {
        status: "COMPLETE",
        collected_at: latestTime([
          ...policy.policySources.map((source) => source.collected_at),
          ...runEvidence.sources.map((source) => source.collected_at),
        ]),
        policy_sources: policy.policySources,
        run_sources: runEvidence.sources,
      },
      policy: policy.policy,
      strict_policy: policy.strictPolicy,
      requirements: policy.requirements,
      runs: runEvidence.runs,
    },
    codex_review: normalizeCodex(publication, raw),
    review_threads: normalizeThreads(publication, raw),
  };
}

function runGh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

function get(endpoint) {
  return {
    value: runGh(["api", endpoint]),
    endpoint: `GET ${endpoint}`,
    collected_at: new Date().toISOString(),
  };
}

function getPages(endpoint) {
  return {
    pages: runGh(["api", "--paginate", "--slurp", endpoint]),
    endpoint: `GET ${endpoint}`,
    collected_at: new Date().toISOString(),
  };
}

export function normalizeClassicProtectionResponse(
  result,
  endpoint,
  permissionSource,
  collectedAt = new Date().toISOString(),
) {
  if (result.status === 0) {
    return {
      value: JSON.parse(result.stdout),
      endpoint: `GET ${endpoint}`,
      collected_at: collectedAt,
      result: "SUCCESS",
    };
  }
  const message = result.stderr.trim() || result.stdout.trim();
  if (/\(HTTP 404\)\s*$/.test(message) && permissionSource != null) {
    return {
      value: null,
      endpoint: `GET ${endpoint}`,
      collected_at: collectedAt,
      result: "NOT_CONFIGURED",
      http_status: 404,
      permission_source: permissionSource,
    };
  }
  throw new Error(`gh api ${endpoint} failed: ${message}`);
}

export function normalizeOauthAdminProofResponse(
  result,
  endpoint,
  collectedAt = new Date().toISOString(),
) {
  if (result.status !== 0) {
    throw new Error(
      `gh api --include ${endpoint} failed: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  const separator = result.stdout.match(/\r?\n\r?\n/);
  if (separator?.index == null) {
    throw new Error("GitHub OAuth administration proof omitted response headers");
  }
  const headers = result.stdout.slice(0, separator.index);
  const body = result.stdout.slice(separator.index + separator[0].length);
  const scopeHeader = headers
    .split(/\r?\n/)
    .find((line) => /^x-oauth-scopes:/i.test(line));
  const scopes = String(scopeHeader ?? "")
    .split(":")
    .slice(1)
    .join(":")
    .split(",")
    .map((scope) => scope.trim().toLowerCase());
  const repository = JSON.parse(body);
  if (
    !/^HTTP\/\S+\s+200\b/m.test(headers) ||
    !scopes.includes("repo") ||
    repository.permissions?.admin !== true
  ) {
    throw new Error(
      "classic branch protection 404 requires repo-scoped admin gh credentials",
    );
  }
  return completeSource(
    "GITHUB_OAUTH_REPOSITORY_PERMISSIONS",
    `GET ${endpoint}`,
    collectedAt,
    {
      result: "SUCCESS",
      credential_type: "OAUTH_SCOPE_TOKEN",
      field: "x-oauth-scopes+permissions.admin",
      level: "ADMIN",
      scope: "repo",
    },
  );
}

function spawnGh(args) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function getOauthAdminProof(
  endpoint,
  execute = spawnGh,
  clock = () => new Date().toISOString(),
) {
  const result = execute(["api", "--include", endpoint]);
  const collectedAt = clock();
  return normalizeOauthAdminProofResponse(
    result,
    endpoint,
    collectedAt,
  );
}

export function collectClassicProtection(
  endpoint,
  repositoryEndpoint,
  {
    execute = spawnGh,
    clock = () => new Date().toISOString(),
  } = {},
) {
  const result = execute(["api", endpoint]);
  const collectedAt = clock();
  const message = result.stderr.trim() || result.stdout.trim();
  const permissionSource = /\(HTTP 404\)\s*$/.test(message)
    ? getOauthAdminProof(repositoryEndpoint, execute, clock)
    : null;
  return normalizeClassicProtectionResponse(
    result,
    endpoint,
    permissionSource,
    collectedAt,
  );
}

// One query carries the whole provenance proof: thread identity and state,
// every comment with stable node and database IDs and numeric actor identity,
// and the formal review each comment structurally belongs to together with the
// head that review examined. REST exposes neither the thread node ID nor the
// thread-to-review link, and would need a call per thread.
//
// Comments are fetched in one page and the proof records whether that was
// complete; a thread deeper than the page fails closed rather than being
// reported on partial evidence.
const REVIEW_THREAD_COMMENT_PAGE = 100;
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: ${REVIEW_THREAD_COMMENT_PAGE}) {
            totalCount
            pageInfo { hasNextPage }
            nodes {
              id
              databaseId
              createdAt
              updatedAt
              author { __typename login ... on Bot { databaseId } ... on User { databaseId } }
              pullRequestReview {
                id
                databaseId
                state
                commit { oid }
                author { __typename login ... on Bot { databaseId } ... on User { databaseId } }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export function collectGithubObservation(publicationInput) {
  const publication = object(publicationInput, "publication");
  const target = object(publication.target, "publication.target");
  const authorizationValue = authorization(publication);
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  const branch = encodeURIComponent(target.base_branch);
  const root = `/repos/${owner}/${repo}`;
  const pullRequest = get(`${root}/pulls/${target.pr_number}`);
  const pullBaseBranch = get(`${root}/branches/${branch}`);
  const liveBaseSha = pullBaseBranch.value.commit?.sha;
  const baseHeadComparison = get(
    `${root}/compare/${liveBaseSha}...${authorizationValue.head_sha}`,
  );
  const reviewedBaseComparison = get(
    `${root}/compare/${authorizationValue.base_sha}...${liveBaseSha}`,
  );
  const applicableRules = getPages(
    `${root}/rules/branches/${branch}?per_page=100`,
  );
  const policyBaseBranch = get(`${root}/branches/${branch}`);
  const rules = applicableRules.pages.flatMap((page) => page);
  const needsClassicProtection =
    policyBaseBranch.value.protected ||
    rules.some((rule) => rule?.type === "required_status_checks");
  const classicProtection = needsClassicProtection
    ? collectClassicProtection(
        `${root}/branches/${branch}/protection`,
        root,
      )
    : null;
  const checkRuns = getPages(
    `${root}/commits/${authorizationValue.head_sha}/check-runs?filter=all&per_page=100`,
  );
  const commitStatuses = getPages(
    `${root}/commits/${authorizationValue.head_sha}/statuses?per_page=100`,
  );
  const issueComments = getPages(
    `${root}/issues/${target.pr_number}/comments?per_page=100`,
  );
  const pullRequestReviews = getPages(
    `${root}/pulls/${target.pr_number}/reviews?per_page=100`,
  );
  const pullRequestReviewComments = getPages(
    `${root}/pulls/${target.pr_number}/comments?per_page=100`,
  );
  const reviewThreads = {
    pages: runGh([
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `owner=${target.owner}`,
      "-f",
      `repo=${target.repo}`,
      "-F",
      `number=${target.pr_number}`,
    ]),
    endpoint: `POST graphql:reviewThreads(${target.owner}/${target.repo}#${target.pr_number})`,
    collected_at: new Date().toISOString(),
  };
  return normalizeGithubObservation(publication, {
    pull_request: pullRequest,
    pull_base_branch: pullBaseBranch,
    base_head_comparison: baseHeadComparison,
    reviewed_base_comparison: reviewedBaseComparison,
    applicable_rules: applicableRules,
    policy_base_branch: policyBaseBranch,
    classic_protection: classicProtection,
    check_runs: checkRuns,
    commit_statuses: commitStatuses,
    issue_comments: issueComments,
    pull_request_reviews: pullRequestReviews,
    pull_request_review_comments: pullRequestReviewComments,
    review_threads: reviewThreads,
    observed_at: new Date().toISOString(),
  });
}
