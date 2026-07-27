export const codexRequestIdPattern = /^rbreq-[0-9a-f]{32}$/;

const markerPattern =
  /<!-- review-bridge-request-id: (rbreq-[0-9a-f]{32}) -->/g;

export function codexRequestBody(requestId) {
  if (!codexRequestIdPattern.test(requestId)) {
    throw new Error("request_id is invalid");
  }
  return [
    "@codex review",
    "",
    "When you finish, append exactly this marker to the review summary:",
    `<!-- review-bridge-request-id: ${requestId} -->`,
  ].join("\n");
}

export function codexResultRequestIdFromBodies(bodies) {
  const matches = bodies.flatMap((body) => [
    ...String(body).matchAll(markerPattern),
  ]);
  return matches.length === 1 ? matches[0][1] : null;
}

export function codexResultRequestId(body) {
  return codexResultRequestIdFromBodies([body]);
}

export function codexRequestIdFromBody(body) {
  const requestId = codexResultRequestId(body);
  return requestId != null && body === codexRequestBody(requestId)
    ? requestId
    : null;
}
