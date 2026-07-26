import { createHash } from "node:crypto";

const EXACT_REQUEST = "@codex review";
const TRIGGER_SHAPE = /@codex\s+review\b/i;
const CLEAN_PREFIX = "Codex Review: Didn't find any major issues.";
const CLEAN_MARKER = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{10,40})`/g;
const FINDINGS_PREFIX = /###\s+💡\s+Codex Review/;
const RESOURCE_KINDS = {
  issue_comments: "ISSUE_COMMENT",
  pull_request_reviews: "PULL_REQUEST_REVIEW",
  pull_request_review_comments: "PULL_REQUEST_REVIEW_COMMENT",
};

function digest(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function canonicalTimestamp(value, name) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${name} is not a valid timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function positiveId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function actor(object) {
  return {
    id: positiveId(object.user?.id, "user.id"),
    type: String(object.user?.type ?? ""),
    login: String(object.user?.login ?? ""),
  };
}

function resourceId(object) {
  return positiveId(object.id, "object.id");
}

function timestampFor(kind, object) {
  return kind === "PULL_REQUEST_REVIEW"
    ? {
        event_at: canonicalTimestamp(object.submitted_at, "submitted_at"),
        timestamp_field: "submitted_at",
      }
    : {
        event_at: canonicalTimestamp(object.created_at, "created_at"),
        timestamp_field: "created_at",
      };
}

function hasCompleteEventMetadata(kind, object) {
  const timestamp =
    kind === "PULL_REQUEST_REVIEW"
      ? object.submitted_at
      : object.created_at;
  return Number.isFinite(Date.parse(timestamp));
}

function hasCompleteUntrustedMetadata(kind, object) {
  return (
    Number.isSafeInteger(object.user?.id) &&
    object.user.id > 0 &&
    hasCompleteEventMetadata(kind, object)
  );
}

function requestFacts(kind, object) {
  return {
    resource_id: resourceId(object),
    resource_kind: kind,
    url: String(object.html_url ?? ""),
    ...timestampFor(kind, object),
    body_sha256: digest(String(object.body ?? "")),
  };
}

function baseFacts(kind, object) {
  return {
    ...requestFacts(kind, object),
    actor: actor(object),
  };
}

function resultFacts(kind, object) {
  const facts = baseFacts(kind, object);
  return {
    result_id: facts.resource_id,
    resource_kind: kind,
    native_review_state:
      kind === "PULL_REQUEST_REVIEW" ? String(object.state ?? "") : null,
    url: facts.url,
    event_at: facts.event_at,
    timestamp_field: facts.timestamp_field,
    actor: facts.actor,
    body_sha256: facts.body_sha256,
  };
}

function identity(kind, id) {
  return `${kind}:${id}`;
}

function compareEvents(left, right) {
  const time = Date.parse(left.event_at) - Date.parse(right.event_at);
  if (time !== 0) {
    return time;
  }
  if (left.resource_kind !== right.resource_kind) {
    return null;
  }
  return (left.resource_id ?? left.result_id) - (right.resource_id ?? right.result_id);
}

function isStrictlyBefore(left, right) {
  const comparison = compareEvents(left, right);
  return comparison != null && comparison < 0;
}

function projectBaselineRequest(item) {
  const { classification: _classification, reason: _reason, ...facts } = item;
  facts.actor = { id: facts.actor.id, type: facts.actor.type };
  return facts;
}

function projectBaselineResult(item) {
  const { classification: _classification, reason: _reason, ...facts } = item;
  facts.actor = { id: facts.actor.id, type: facts.actor.type };
  return facts;
}

function closedSets(acknowledgements) {
  return {
    requests: new Set(
      acknowledgements.flatMap((acknowledgement) =>
        acknowledgement.closed_requests.map((item) =>
          identity(item.resource_kind, item.resource_id),
        ),
      ),
    ),
    results: new Set(
      acknowledgements.flatMap((acknowledgement) =>
        acknowledgement.closed_results.map((item) =>
          identity(item.resource_kind, item.result_id),
        ),
      ),
    ),
  };
}

function normalizedAttachments(review, comments, expectedActor) {
  return comments
    .filter(
      (comment) =>
        comment.pull_request_review_id === review.id &&
        comment.user?.id === expectedActor.id &&
        comment.user?.type === expectedActor.type,
    )
    .map((comment) => ({
      comment_id: resourceId(comment),
      actor: {
        id: positiveId(comment.user.id, "review comment user.id"),
        type: comment.user.type,
      },
      commit_id: String(comment.commit_id ?? ""),
      body_sha256: digest(String(comment.body ?? "")),
    }))
    .sort((left, right) => left.comment_id - right.comment_id);
}

function makeResult(kind, object, comments, expectedActor) {
  const body = String(object.body ?? "");
  const result = {
    ...resultFacts(kind, object),
    request_ref: null,
    association: "UNSOLICITED",
    reviewed_head_sha: null,
    commit_binding: null,
    attached_review_comments: [],
    format: "UNKNOWN",
    verdict: "UNKNOWN",
  };
  if (kind === "ISSUE_COMMENT") {
    const markers = [...body.matchAll(CLEAN_MARKER)];
    if (body.startsWith(CLEAN_PREFIX) && markers.length === 1) {
      result.commit_binding = {
        source: "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
        field: "body.reviewed_commit",
        prefix: markers[0][1],
      };
    }
  } else if (kind === "PULL_REQUEST_REVIEW") {
    if (/^[0-9a-f]{40}$/.test(String(object.commit_id ?? ""))) {
      result.reviewed_head_sha = object.commit_id;
      result.commit_binding = {
        source: "PULL_REQUEST_REVIEW_COMMIT_ID",
        field: "commit_id",
      };
    }
    result.attached_review_comments = normalizedAttachments(
      object,
      comments,
      expectedActor,
    );
    if (
      FINDINGS_PREFIX.test(body) &&
      result.attached_review_comments.length > 0 &&
      result.attached_review_comments.every(
        (comment) => comment.commit_id === object.commit_id,
      )
    ) {
      result.format = "CODEX_FINDINGS_REVIEW_V1";
      result.verdict = "FINDINGS";
    }
  }
  return result;
}

function resultLooksCodex(kind, object) {
  const body = String(object.body ?? "");
  return (
    (kind === "ISSUE_COMMENT" && body.startsWith("Codex Review:")) ||
    (kind === "PULL_REQUEST_REVIEW" && FINDINGS_PREFIX.test(body))
  );
}

function requestCompatible(result, request) {
  if (request.requested_head_sha == null) {
    return true;
  }
  if (result.resource_kind === "PULL_REQUEST_REVIEW") {
    return result.reviewed_head_sha === request.requested_head_sha;
  }
  const prefix = result.commit_binding?.prefix;
  return typeof prefix === "string" && request.requested_head_sha.startsWith(prefix);
}

function associateResults({
  results,
  recognized,
  unbound,
  baseline,
  closed,
  headSha,
}) {
  const matched = new Set();
  let activeWasOpened = false;
  for (const result of results.sort((left, right) => {
    const comparison = compareEvents(left, right);
    return comparison ?? 0;
  })) {
    if (closed.results.has(identity(result.resource_kind, result.result_id))) {
      continue;
    }
    const tiedAcrossKinds = [...recognized, ...unbound, ...baseline].some(
      (request) =>
        !closed.requests.has(identity(request.resource_kind, request.resource_id)) &&
        request.event_at === result.event_at &&
        request.resource_kind !== result.resource_kind &&
        requestCompatible(result, request),
    );
    if (tiedAcrossKinds) {
      result.association = "AMBIGUOUS";
      activeWasOpened = true;
      continue;
    }
    const openRecognized = recognized.filter(
      (request) =>
        !closed.requests.has(identity(request.resource_kind, request.resource_id)) &&
        !matched.has(identity(request.resource_kind, request.resource_id)) &&
        isStrictlyBefore(request, result) &&
        requestCompatible(result, request),
    );
    const openUnbound = unbound.filter(
      (request) =>
        !closed.requests.has(identity(request.resource_kind, request.resource_id)) &&
        isStrictlyBefore(request, result),
    );
    const openBaseline = baseline.filter(
      (request) =>
        !closed.requests.has(identity(request.resource_kind, request.resource_id)) &&
        isStrictlyBefore(request, result),
    );
    activeWasOpened ||= recognized.some(
      (request) =>
        !closed.requests.has(identity(request.resource_kind, request.resource_id)) &&
        isStrictlyBefore(request, result),
    );
    const candidates = [...openRecognized, ...openUnbound, ...openBaseline];
    if (candidates.length === 0) {
      result.association = activeWasOpened ? "AMBIGUOUS" : "UNSOLICITED";
      continue;
    }
    if (
      candidates.length === 1 &&
      openRecognized.length === 1 &&
      openUnbound.length === 0 &&
      openBaseline.length === 0
    ) {
      const request = openRecognized[0];
      result.association = "SINGLE_OPEN_REQUEST";
      result.request_ref = {
        resource_kind: request.resource_kind,
        resource_id: request.resource_id,
      };
      matched.add(identity(request.resource_kind, request.resource_id));
      if (
        result.resource_kind === "ISSUE_COMMENT" &&
        result.commit_binding?.source ===
          "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD" &&
        request.requested_head_sha === headSha &&
        headSha.startsWith(result.commit_binding.prefix)
      ) {
        result.reviewed_head_sha = request.requested_head_sha;
        result.format = "CODEX_CLEAN_COMMENT_V1";
        result.verdict = "CLEAN";
      }
      continue;
    }
    if (
      candidates.length === 1 &&
      openBaseline.length === 1 &&
      openRecognized.length === 0 &&
      openUnbound.length === 0
    ) {
      result.association = "BASELINE_LATE_RESULT";
      result.request_ref = {
        resource_kind: openBaseline[0].resource_kind,
        resource_id: openBaseline[0].resource_id,
      };
      continue;
    }
    result.association = "AMBIGUOUS";
  }
}

export function adaptCodexEvidence({
  mode = "SNAPSHOT",
  collection,
  expected_actor: expectedActor,
  authorization_head_sha: authorizationHeadSha,
  local_gate_head_sha: localGateHeadSha,
  baseline = { requests: [], candidate_results: [] },
  request_history: requestHistory = [],
  ambiguity_acknowledgements: acknowledgements = [],
  issue_comments: issueComments,
  pull_request_reviews: reviews,
  pull_request_review_comments: reviewComments,
}) {
  if (
    authorizationHeadSha != null &&
    localGateHeadSha != null &&
    authorizationHeadSha !== localGateHeadSha
  ) {
    throw new Error(
      "authorization_head_sha and local_gate_head_sha must match when both are supplied",
    );
  }
  const headSha = authorizationHeadSha ?? localGateHeadSha;
  if (
    !expectedActor ||
    !Number.isSafeInteger(expectedActor.id) ||
    expectedActor.type !== "Bot"
  ) {
    throw new Error("expected_actor must contain a positive ID and type Bot");
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("authorization_head_sha must be a full lowercase Git SHA");
  }
  for (const value of [issueComments, reviews, reviewComments]) {
    if (!Array.isArray(value)) {
      throw new Error("all three GitHub feeds must be arrays");
    }
  }
  const feeds = [
    [RESOURCE_KINDS.issue_comments, issueComments],
    [RESOURCE_KINDS.pull_request_reviews, reviews],
    [RESOURCE_KINDS.pull_request_review_comments, reviewComments],
  ];
  const rawByIdentity = new Map();
  for (const [kind, objects] of feeds) {
    for (const object of objects) {
      const key = identity(kind, resourceId(object));
      if (rawByIdentity.has(key)) {
        throw new Error(`duplicate GitHub object ${key}`);
      }
      rawByIdentity.set(key, { kind, object });
    }
  }
  const pendingExpectedReview = reviews.some(
    (review) =>
      review.user?.id === expectedActor.id &&
      review.user?.type === expectedActor.type &&
      review.state === "PENDING",
  );
  if (mode === "BASELINE") {
    const requests = [];
    const candidateResults = [];
    let incompleteRequest = false;
    for (const [kind, objects] of feeds) {
      for (const object of objects) {
        const body = String(object.body ?? "");
        const looksLikeResult = resultLooksCodex(kind, object);
        const looksLikeRequest =
          !looksLikeResult &&
          (body === EXACT_REQUEST || TRIGGER_SHAPE.test(body));
        const isExpectedActor =
          object.user?.id === expectedActor.id &&
          object.user?.type === expectedActor.type;
        if (
          kind === "PULL_REQUEST_REVIEW" &&
          isExpectedActor &&
          object.state === "PENDING"
        ) {
          continue;
        }
        if (
          looksLikeRequest &&
          !hasCompleteUntrustedMetadata(kind, object)
        ) {
          incompleteRequest = true;
          continue;
        }
        if (
          !isExpectedActor &&
          !hasCompleteUntrustedMetadata(kind, object)
        ) {
          continue;
        }
        const facts = baseFacts(kind, object);
        if (looksLikeResult) {
          if (
            object.user?.id === expectedActor.id &&
            object.user?.type === expectedActor.type
          ) {
            const adapted = makeResult(kind, object, reviewComments, expectedActor);
            const {
              association: _association,
              request_ref: _requestRef,
              format: _format,
              verdict: _verdict,
              ...immutable
            } = adapted;
            immutable.actor = {
              id: immutable.actor.id,
              type: immutable.actor.type,
            };
            candidateResults.push(immutable);
          }
          continue;
        }
        if (looksLikeRequest) {
          facts.actor = { id: facts.actor.id, type: facts.actor.type };
          requests.push(facts);
          continue;
        }
        const isAttachedExpectedComment =
          kind === "PULL_REQUEST_REVIEW_COMMENT" &&
          reviews.some(
            (review) =>
              review.id === object.pull_request_review_id &&
              review.user?.id === expectedActor.id &&
              review.user?.type === expectedActor.type,
          );
        if (
          object.user?.id === expectedActor.id &&
          object.user?.type === expectedActor.type &&
          !isAttachedExpectedComment
        ) {
          const adapted = makeResult(kind, object, reviewComments, expectedActor);
          const {
            association: _association,
            request_ref: _requestRef,
            format: _format,
            verdict: _verdict,
            ...immutable
          } = adapted;
          immutable.actor = {
            id: immutable.actor.id,
            type: immutable.actor.type,
          };
          candidateResults.push(immutable);
        }
      }
    }
    return {
      observed_at: collection.collected_at,
      collection: {
        ...collection,
        status:
          pendingExpectedReview || incompleteRequest
            ? "INCOMPLETE"
            : collection.status,
        adapter_version: 1,
      },
      requests,
      candidate_results: candidateResults,
    };
  }
  if (mode !== "SNAPSHOT") {
    throw new Error("mode must be BASELINE or SNAPSHOT");
  }
  const preexistingRequests = baseline.requests.map((stored) => {
    const current = rawByIdentity.get(
      identity(stored.resource_kind, stored.resource_id),
    );
    if (!current) {
      return null;
    }
    return projectBaselineRequest({
      ...baseFacts(current.kind, current.object),
      classification: stored.classification,
      reason: stored.reason,
    });
  }).filter(Boolean);
  const preexistingResults = baseline.candidate_results.map((stored) => {
    const current = rawByIdentity.get(
      identity(stored.resource_kind, stored.result_id),
    );
    if (!current) {
      return null;
    }
    const adapted = makeResult(
      current.kind,
      current.object,
      reviewComments,
      expectedActor,
    );
    const {
      association: _association,
      request_ref: _requestRef,
      format: _format,
      verdict: _verdict,
      ...facts
    } = adapted;
    return projectBaselineResult(facts);
  }).filter(Boolean);
  const baselineIdentities = new Set([
    ...baseline.requests.map((item) => identity(item.resource_kind, item.resource_id)),
    ...baseline.candidate_results.map((item) =>
      identity(item.resource_kind, item.result_id),
    ),
  ]);
  const history = new Map(
    requestHistory.map((item) => [
      identity(item.resource_kind, item.resource_id),
      item,
    ]),
  );
  const requests = [];
  const unboundRequests = [];
  const unsupportedRequests = [];
  const foreignActorObjects = [];
  const results = [];
  let incompleteRequest = false;
  const attachedExpectedCommentIds = new Set(
    reviewComments
      .filter((comment) =>
        reviews.some(
          (review) =>
            review.id === comment.pull_request_review_id &&
            review.user?.id === expectedActor.id &&
            review.user?.type === expectedActor.type,
        ),
      )
      .map((comment) => comment.id),
  );
  for (const [kind, objects] of feeds) {
    for (const object of objects) {
      const objectIdentity = identity(kind, object.id);
      if (baselineIdentities.has(objectIdentity)) {
        continue;
      }
      const body = String(object.body ?? "");
      const looksLikeResult = resultLooksCodex(kind, object);
      const looksLikeRequest =
        !looksLikeResult &&
        (body === EXACT_REQUEST || TRIGGER_SHAPE.test(body));
      const isExpectedActor =
        object.user?.id === expectedActor.id &&
        object.user?.type === expectedActor.type;
      if (
        kind === "PULL_REQUEST_REVIEW" &&
        isExpectedActor &&
        object.state === "PENDING"
      ) {
        continue;
      }
      if (looksLikeRequest) {
        if (!hasCompleteEventMetadata(kind, object)) {
          incompleteRequest = true;
          continue;
        }
        const facts = requestFacts(kind, object);
        const bound = history.get(objectIdentity);
        if (body === EXACT_REQUEST && kind === "ISSUE_COMMENT" && bound) {
          requests.push({
            comment_id: facts.resource_id,
            resource_kind: kind,
            url: facts.url,
            event_at: facts.event_at,
            timestamp_field: facts.timestamp_field,
            body,
            body_sha256: facts.body_sha256,
            requested_head_sha: bound.requested_head_sha,
          });
        } else if (body === EXACT_REQUEST && kind === "ISSUE_COMMENT") {
          unboundRequests.push({
            ...facts,
            reason: "MISSING_POST_BINDING",
          });
        } else {
          unsupportedRequests.push({
            ...facts,
            reason:
              body === EXACT_REQUEST
                ? "WRONG_RESOURCE_KIND"
                : "NON_EXACT_TRIGGER_SHAPE",
          });
        }
        continue;
      }
      if (
        !isExpectedActor &&
        !hasCompleteUntrustedMetadata(kind, object)
      ) {
        continue;
      }
      const facts = baseFacts(kind, object);
      if (looksLikeResult) {
        const objectActor = actor(object);
        if (
          objectActor.id !== expectedActor.id ||
          objectActor.type !== expectedActor.type
        ) {
          foreignActorObjects.push(facts);
        } else {
          results.push(makeResult(kind, object, reviewComments, expectedActor));
        }
        continue;
      }
      if (
        object.user?.id === expectedActor.id &&
        object.user?.type === expectedActor.type &&
        !(
          kind === "PULL_REQUEST_REVIEW_COMMENT" &&
          attachedExpectedCommentIds.has(object.id)
        )
      ) {
        results.push(makeResult(kind, object, reviewComments, expectedActor));
      }
    }
  }
  const closed = closedSets(acknowledgements);
  associateResults({
    results,
    recognized: requests.map((item) => ({
      ...item,
      resource_id: item.comment_id,
    })),
    unbound: unboundRequests,
    baseline: preexistingRequests,
    closed,
    headSha,
  });
  return {
    collection: {
      ...collection,
      status:
        pendingExpectedReview || incompleteRequest
          ? "INCOMPLETE"
          : collection.status,
      adapter_version: 1,
    },
    preexisting_requests: preexistingRequests,
    preexisting_candidate_results: preexistingResults,
    requests,
    unbound_requests: unboundRequests,
    unsupported_requests: unsupportedRequests,
    foreign_actor_objects: foreignActorObjects,
    results,
  };
}

export const githubAdapterVersion = 1;
