import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadValidatedReview } from "./core.mjs";
import {
  canonicalDigest,
  checkRequiredRuns,
  codexStatus,
  derivePublicationStatus,
  getPublication,
  invalidatedAutomaticResolution,
  readBoundPublicationAuthorization,
  resolutionFrontier,
} from "./publication.mjs";

// The footer sentence, stated in the terms README uses for operator narration.
// A report is read by a person; nothing a person reads here advances a ledger.
// Which ledger is the source of truth depends on what was rendered: the review
// ledger (and the publication beside it) when a local review exists, the
// publication and its bound authorization when the review was skipped.
export const PROJECTION_NOTICE =
  "This report is a projection of the ledger, not evidence. The review ledger, and the publication ledger when present, remain the sole source of truth: nothing in this report advances or proves review state, and citing it as evidence is a misuse. It can be regenerated from the ledger at any time.";
export const PROJECTION_NOTICE_REMOTE_ONLY =
  "This report is a projection of the ledger, not evidence. The publication ledger and its bound authorization remain the sole source of truth: nothing in this report advances or proves publication state, and citing it as evidence is a misuse. It can be regenerated from the ledger at any time.";

const REVIEW_ID_PATTERN = /^rb-[0-9TZ-]+-[a-f0-9]{8}$/;
const PREPARED_EVENTS = ["REVIEW_PREPARED", "REREVIEW_PREPARED"];
const VERDICT_EVENTS = [
  "INITIAL_REVIEW_CLEAN",
  "FINDINGS_SUBMITTED",
  "REREVIEW_CLEAN",
  "REREVIEW_UNRESOLVED",
  "REREVIEW_CONTINUABLE_FINDINGS",
];
const RESPONSE_EVENTS = ["AUTHOR_RESPONDED", "AUTHOR_ESCALATED"];
const HUMAN_REQUIRED_EVENTS = [
  "AUTHOR_ESCALATED",
  "ROUND_LIMIT_REACHED",
  "REREVIEW_UNRESOLVED",
];
const CLEAN_STATUSES = ["CLEAN", "LOCAL_GATE_PASSED"];
// Every remote section that reads the observation says this instead when
// there is none. Nothing observation-based is judged: the gates' "nothing
// wrong" answer is null, and null must not be read as passing over an
// observation that was never recorded.
const NO_OBSERVATION =
  "No observation has been recorded yet, so there is nothing here to judge.";

// Every string the ledger carries from a reviewer, an author, or GitHub passes
// through one of these two before it reaches the document, so no such text can
// open a heading, a list, a table row, or a fence of its own.
//
// A one-line field is collapsed to one line, and the punctuation that opens
// inline markup, a link, raw HTML, or a table cell is escaped. Inline text is
// never placed at a line start, so line-start constructs cannot arise from it.
function inline(value) {
  const text = value == null || value === "" ? "n/a" : String(value);
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*[\]<>|]/g, "\\$&");
}

// A multi-line field is a fenced block whose fence is longer than any backtick
// run inside it, so the text cannot close the fence early.
function block(value) {
  const text = value == null || value === "" ? "(empty)" : String(value);
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

// Identifiers, digests, and paths the ledger itself minted are shown as code;
// one that carries a backtick is shown escaped instead so it cannot break out.
function code(value) {
  if (value == null || value === "") return "n/a";
  const text = String(value).replace(/\s+/g, " ");
  return text.includes("`") ? inline(text) : `\`${text}\``;
}

function shortSha(sha) {
  return typeof sha === "string" ? sha.slice(0, 12) : "n/a";
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => inline(cell)).join(" | ")} |`),
  ].join("\n");
}

function wallTime(from, to) {
  const start = Date.parse(from ?? "");
  const end = Date.parse(to ?? "");
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "n/a";
  const seconds = Math.round((end - start) / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function eventFor(history, events, round) {
  return history.find(
    (entry) => events.includes(entry?.event) && entry.round === round,
  );
}

function list(values) {
  return values.length === 0 ? "none" : values.map(code).join(", ");
}

function strategyLine(review) {
  const strategy = review.review_strategy ?? { mode: "FULL" };
  const parts = [code(strategy.mode)];
  if (strategy.parent_review_id != null) {
    parts.push(`parent ${code(strategy.parent_review_id)}`);
  }
  if (strategy.parent_selection != null) {
    parts.push(`parent selection ${code(strategy.parent_selection)}`);
  }
  if (strategy.fallback_reason != null) {
    parts.push(`fallback reason: ${inline(strategy.fallback_reason)}`);
  }
  return parts.join(", ");
}

function identitySection(review) {
  const rounds = review.rounds ?? [];
  const first = rounds[0];
  const latest = rounds.at(-1);
  return [
    "## Local review",
    [
      `- Review: ${code(review.id)}`,
      `- Status: ${code(review.status)}, round ${review.current_round ?? "n/a"} of ${review.max_rounds ?? "n/a"}`,
      `- Repository: ${code(review.repository_path)}`,
      `- Base ref: ${code(review.base_ref)}`,
      `- Base → head: ${code(first?.base_sha)} → ${code(latest?.head_sha)}`,
      `- Reviewer provider: ${code(review.reviewer_provider ?? "CLAUDE_DESKTOP")}${review.advisory === true ? " (advisory: attests nothing)" : ""}`,
      `- Review strategy: ${strategyLine(review)}`,
    ].join("\n"),
    "### Requirement",
    block(review.requirement),
    "### Implementation scope",
    block(review.implementation_scope),
  ];
}

// A REMOTE_ONLY publication has no local review: the operator authorized it
// with LOCAL_REVIEW_SKIPPED, and the bound authorization under Remote
// publication is the only local record of what was authorized and why.
function remoteOnlySection() {
  return [
    "## Local review",
    "None: this publication was authorized `REMOTE_ONLY` with local review skipped, so there is no review ledger, no rounds, and no findings to render. The authorization is under Remote publication.",
  ];
}

function successorSection(review) {
  const successor = (review.rounds ?? [])[0]?.successor;
  if (successor == null) return [];
  return [
    "### Successor delta",
    [
      `- Parent review: ${code(successor.parent_review_id)} (${code(successor.parent_reviewer_provider)})`,
      `- Requirement matches the parent: ${successor.requirement_match === true ? "yes" : "no"}`,
      `- Parent head → current head: ${code(successor.parent_head_sha)} → ${code(successor.current_head_sha)}`,
      `- Delta: ${successor.delta_bytes ?? "n/a"} bytes, sha256 ${code(successor.delta_sha256)}`,
      `- Files in the delta: ${list(successor.changed_files ?? [])}`,
      `- Files deleted in the delta: ${list(successor.deleted_files ?? [])}`,
    ].join("\n"),
  ];
}

function roundsSection(review) {
  const history = review.history ?? [];
  const rows = (review.rounds ?? []).map((round) => {
    const prepared = eventFor(history, PREPARED_EVENTS, round.round);
    const verdict = eventFor(history, VERDICT_EVENTS, round.round);
    const size = round.change_size;
    return [
      round.round,
      shortSha(round.head_sha),
      prepared?.at,
      verdict?.event,
      verdict?.at,
      wallTime(prepared?.at, verdict?.at),
      (round.changed_files ?? []).length,
      size == null ? "n/a" : `+${size.added_lines} −${size.deleted_lines}`,
    ];
  });
  return [
    "### Rounds",
    table(
      [
        "Round",
        "Head",
        "Prepared at",
        "Verdict",
        "Verdict at",
        "Wall time",
        "Changed files",
        "Change size",
      ],
      rows,
    ),
  ];
}

// The finding's one-line facts, then each long field as a labelled fenced
// block. A decision's verification is the obligation: a sustained rebuttal
// must say what the rereviewer checked; other decisions carry one only when
// it was given.
function findingSections(finding, resolution, decision) {
  const location =
    finding.path == null
      ? "no location"
      : inline(`${finding.path}${finding.line == null ? "" : `:${finding.line}`}`);
  const facts = [
    `- Title: ${inline(finding.title)}`,
    `- Introduced in round ${finding.introduced_round ?? "n/a"}; status ${code(finding.status)}`,
    resolution == null
      ? "- Author disposition: none recorded"
      : `- Author disposition: ${code(resolution.disposition)}${resolution.submitted_at ? ` at ${inline(resolution.submitted_at)}` : ""}`,
    decision == null
      ? "- Rereview decision: none recorded"
      : `- Rereview decision: ${code(decision.decision)}${decision.submitted_at ? ` at ${inline(decision.submitted_at)}` : ""}`,
  ];
  const sections = [
    `#### ${inline(finding.id)} · ${inline(finding.severity)} · ${location}`,
    facts.join("\n"),
    "Explanation:",
    block(finding.explanation),
  ];
  if (finding.recommendation) {
    sections.push("Recommendation:", block(finding.recommendation));
  }
  if (resolution != null) {
    sections.push("Author rationale:", block(resolution.rationale));
    if (resolution.evidence) {
      sections.push("Author evidence:", block(resolution.evidence));
    }
  }
  if (decision != null) {
    sections.push("Rereview rationale:", block(decision.rationale));
    if (decision.verification) {
      sections.push("Rereviewer verification:", block(decision.verification));
    } else if (decision.decision === "rebuttal_accepted") {
      sections.push(
        "Rereviewer verification: not recorded (the decision predates the verification obligation).",
      );
    }
  }
  return sections;
}

function findingsSection(review) {
  const findings = review.findings ?? [];
  if (findings.length === 0) {
    return ["### Findings", "No findings were recorded."];
  }
  const resolutionByFinding = new Map(
    (review.resolutions ?? []).map((entry) => [entry.finding_id, entry]),
  );
  const decisionByFinding = new Map(
    (review.rereview_decisions ?? []).map((entry) => [entry.finding_id, entry]),
  );
  return [
    "### Findings",
    ...findings.flatMap((finding) =>
      findingSections(
        finding,
        resolutionByFinding.get(finding.id),
        decisionByFinding.get(finding.id),
      ),
    ),
  ];
}

// What changed between rounds is read from the immutable rounds, the way the
// operator narration derives it. A fix the author reports without a following
// round has no round binding its commit or files, and is said to be
// unavailable rather than inferred.
function changesSection(review) {
  const rounds = review.rounds ?? [];
  const lines = [];
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    const current = rounds[index];
    lines.push(
      `- Round ${previous.round} → ${current.round}: fix head ${code(previous.head_sha)} → ${code(current.head_sha)}; files in the reviewed diff: ${list(current.changed_files ?? [])}${(current.deleted_files ?? []).length > 0 ? `; deleted: ${list(current.deleted_files)}` : ""}`,
    );
  }
  const lastRound = rounds.at(-1)?.round;
  const respondedLast = (review.history ?? []).some(
    (entry) => RESPONSE_EVENTS.includes(entry?.event) && entry.round === lastRound,
  );
  const fixedLast = (review.resolutions ?? []).some(
    (entry) => entry.disposition === "fixed",
  );
  if (respondedLast && fixedLast) {
    lines.push(
      `- After round ${lastRound}: a fixed resolution was submitted, but no later round binds its fix commit or affected files, so they are unavailable here.`,
    );
  }
  return [
    "### Changes between rounds",
    lines.length === 0 ? "No round followed another." : lines.join("\n"),
  ];
}

function outcomeSection(review) {
  const history = review.history ?? [];
  const lines = [`- Terminal state: ${code(review.status)}`];
  if (CLEAN_STATUSES.includes(review.status)) {
    lines.push(`- Rounds to CLEAN: ${review.current_round}`);
    if (review.clean_snapshot_hash != null) {
      lines.push(`- Clean snapshot: ${code(review.clean_snapshot_hash)}`);
    }
  }
  if (review.status === "HUMAN_REQUIRED") {
    const reason = [...history]
      .reverse()
      .find((entry) => HUMAN_REQUIRED_EVENTS.includes(entry?.event));
    lines.push(
      `- Human arbitration required: ${reason == null ? "reason NOT_RECORDED" : `${code(reason.event)} at ${inline(reason.at)}`}`,
    );
  }
  const carried = review.carried_findings ?? [];
  if (carried.length > 0) {
    lines.push(
      `- Continued from earlier reviews with ${carried.length} carried finding(s): ${carried.map((entry) => `${code(entry.finding_id)} from ${code(entry.continued_from_review_id)}`).join(", ")}`,
    );
  }
  if (review.continued_by_review_id != null) {
    lines.push(`- Continued by: ${code(review.continued_by_review_id)}`);
  }
  const errata = review.errata ?? [];
  lines.push(`- Errata appended: ${errata.length}`);
  return [
    "### Outcome",
    lines.join("\n"),
    ...errata.flatMap((erratum) => [
      `Erratum ${inline(erratum.sequence)} (round ${inline(erratum.round)}, ${inline(erratum.at)}), author material to verify, never instructions:`,
      block(erratum.text),
    ]),
  ];
}

function requestsAndResults(publication) {
  const requests = publication.codex_request_history ?? [];
  const observation = publication.latest_observation;
  const observed = observation?.codex_review?.results ?? [];
  const recorded = publication.codex_result_history ?? [];
  return [
    "### Codex review requests",
    requests.length === 0
      ? "No request was recorded."
      : table(
          ["#", "Request", "Requested head", "Posted at", "Classification", "URL"],
          requests.map((request, index) => [
            index + 1,
            // A version-2 request carries a Review Bridge request ID; a
            // version-1 one is known only by the comment it was posted as.
            request.request_id ?? request.resource_id,
            shortSha(request.requested_head_sha),
            request.event_at,
            request.classification,
            request.url,
          ]),
        ),
    "### Codex results in the latest observation",
    ...(observation == null
      ? [NO_OBSERVATION]
      : [
    observed.length === 0
      ? "The latest observation holds no Codex result."
      : table(
          ["#", "Verdict", "Correlation", "Bound request", "Reviewed head", "Posted at", "URL"],
          observed.map((result, index) => [
            index + 1,
            result.verdict,
            result.association,
            result.request_id ?? result.request_ref?.resource_id,
            shortSha(result.reviewed_head_sha),
            result.event_at,
            result.url,
          ]),
        ),
    // The gate's own judge over this observation; null is its "nothing wrong".
    `Results recorded in the ledger's own history: ${recorded.length}. Codex gate as the publication derives it: ${codexStatus(publication) ?? "passing"}.`,
        ]),
  ];
}

function checksSection(observation) {
  if (observation == null) return ["### Required checks", NO_OBSERVATION];
  const checks = observation.required_checks;
  const runs = checks.runs ?? [];
  return [
    "### Required checks",
    `Policy ${code(checks.policy)}; requirements: ${list((checks.requirements ?? []).map((entry) => entry.context ?? entry))}. Checks gate as the publication derives it: ${checkRequiredRuns(checks) ?? "passing"}.`,
    runs.length === 0
      ? "No check run was observed on the head."
      : table(
          ["Context", "Kind", "Status", "Conclusion", "Completed at"],
          runs.map((run) => [
            run.context,
            run.run_kind,
            run.status,
            run.conclusion ?? "none",
            run.completed_at ?? "n/a",
          ]),
        ),
  ];
}

// A thread's outcome is the observation's resolved flag read against the
// publication's own judges: the frontier replay says which record is active,
// and the gate's invalidation check says whether the active frontier still
// matches the observed threads (provenance, resolved flag, watermark). A
// record is credited only when both agree; anything else is reported as the
// observed state beside what the ledger recorded.
function threadOutcome(thread, records, frontier, invalidated) {
  const own = records.filter((entry) => entry.thread_id === thread.id);
  const active = frontier.active.get(thread.id);
  const observed = thread.is_resolved
    ? "resolved on GitHub"
    : "unresolved; left for a human";
  if (active != null && thread.is_resolved && invalidated == null) {
    return `resolved by record ${active.number} (action ${active.action_id}, reply comment ${active.reply_comment_id}, head ${shortSha(active.head_sha)})`;
  }
  if (active != null && invalidated?.thread_id === thread.id) {
    return `${observed}; record ${active.number} no longer explains it: the gate judges THREAD_RESOLUTION_INVALIDATED (${invalidated.reason ?? "the thread's provenance, resolved flag, or watermark changed since the record"})`;
  }
  if (active != null) {
    return `${observed}; record ${active.number} is active but the gate does not credit it while thread ${invalidated?.thread_id ?? "?"} invalidates the frontier`;
  }
  if (own.length > 0) {
    const blocker = frontier.blockers.find((entry) => entry.thread_id === thread.id);
    return `${observed}; record${own.length === 1 ? "" : "s"} ${own.map((entry) => entry.number).join(", ")} resolved it automatically and ${own.length === 1 ? "is" : "are"} no longer active (${blocker?.reason ?? "not in the active frontier"})`;
  }
  return thread.is_resolved
    ? "resolved on GitHub; no automatic-resolution record"
    : observed;
}

function threadsSection(publication) {
  if (publication.latest_observation == null) {
    return ["### Review threads", NO_OBSERVATION];
  }
  const threads = publication.latest_observation.review_threads.threads;
  const records = publication.automatic_resolutions ?? [];
  const frontier = resolutionFrontier(publication);
  const invalidated = invalidatedAutomaticResolution(publication);
  const rows = threads.map((thread) => {
    const commenters = [
      ...new Set((thread.comments ?? []).map((comment) => comment.actor?.login ?? comment.actor?.id)),
    ];
    return [
      thread.id,
      thread.path == null ? "n/a" : `${thread.path}${thread.line == null ? "" : `:${thread.line}`}`,
      `${thread.comment_count ?? (thread.comments ?? []).length} by ${commenters.join(", ") || "n/a"}`,
      threadOutcome(thread, records, frontier, invalidated),
    ];
  });
  return [
    "### Review threads",
    rows.length === 0
      ? "No review thread was observed."
      : table(["Thread", "Location", "Comments", "Outcome"], rows),
  ];
}

function acknowledgementsSection(publication) {
  const items = publication.codex_review_ambiguity_acknowledgements ?? [];
  return [
    "### Supersessions and acknowledgements",
    items.length === 0
      ? "None recorded."
      : table(
          ["Acknowledgement", "Head", "Closed requests", "Closed results", "Operator", "At"],
          items.map((item) => [
            item.acknowledgement,
            shortSha(item.head_sha),
            (item.closed_requests ?? []).length,
            (item.closed_results ?? []).length,
            item.operator_label ?? "server-derived",
            item.acknowledged_at,
          ]),
        ),
  ];
}

// The status is derived here the way every read surface derives it, not
// copied from the stored field, so the report cannot say MERGE_READY over an
// observation the gate would refuse.
function derivationSection(publication) {
  const observation = publication.latest_observation;
  const derived = derivePublicationStatus(publication);
  const lines = [
    `- Stored status ${code(publication.status)} at revision ${publication.revision}; derived now: ${code(derived.status)}${derived.blockingReason == null ? "" : ` (${code(derived.blockingReason)})`}`,
  ];
  if (publication.terminal != null) {
    lines.push(
      `- Terminal: ${code(publication.terminal.status)} at revision ${publication.terminal.revision}, ${inline(publication.terminal.at)}: ${inline(publication.terminal.reason ?? "no reason recorded")}`,
    );
  }
  if (observation == null) {
    lines.push(`- ${NO_OBSERVATION}`);
  } else if (derived.status === "MERGE_READY") {
    const event = (publication.history ?? []).findLast(
      (entry) => entry?.status === "MERGE_READY",
    );
    lines.push(
      `- MERGE_READY rests on the observation recorded at revision ${event?.revision ?? publication.revision}, observed ${inline(observation.observed_at)}, recorded ${inline(observation.recorded_at)}, canonical sha256 ${code(canonicalDigest(observation))}.`,
    );
  } else {
    lines.push("- No MERGE_READY derivation is rendered for this status.");
  }
  return ["### Derivation", lines.join("\n")];
}

function remoteSection(publication, authorization) {
  if (publication == null) {
    return ["## Remote publication", "No publication ledger was rendered."];
  }
  const target = publication.target ?? {};
  // The bound authorization -- the gate file or remote sidecar the store
  // reader admitted -- carries the repository and time the ledger's own copy
  // does not; without one the ledger's copy is shown.
  const record = authorization ?? publication.authorization ?? {};
  const observation = publication.latest_observation;
  return [
    "## Remote publication",
    [
      `- Pull request: ${inline(target.owner)}/${inline(target.repo)}#${inline(target.pr_number)}, ${code(target.head_branch)} into ${code(target.base_branch)}`,
      `- Authorized head: ${code(record.head_sha)} over base ${code(record.base_sha)}`,
      `- Authorization: ${code(record.mode)}${record.acknowledgement ? `, acknowledgement ${code(record.acknowledgement)}` : ""}${record.operator_label ? `, operator ${inline(record.operator_label)}` : ""}${record.authorized_at ? `, at ${inline(record.authorized_at)}` : ""}${record.reviewer_provider ? `, gated by ${code(record.reviewer_provider)}` : ""}`,
      ...(record.repository_path ? [`- Authorized repository: ${code(record.repository_path)}`] : []),
      `- Codex trigger policy: ${code(target.codex_trigger_policy?.mode)}`,
    ].join("\n"),
    ...(record.rationale ? ["Authorization rationale:", block(record.rationale)] : []),
    ...requestsAndResults(publication),
    ...checksSection(observation),
    ...threadsSection(publication),
    ...acknowledgementsSection(publication),
    ...derivationSection(publication),
  ];
}

// Only a REMOTE_ONLY authorization explains a missing review ledger. A
// version-1 publication has no authorization record and was always local-gate.
function isRemoteOnly(publication) {
  return publication?.authorization?.mode === "REMOTE_ONLY";
}

function reportError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

export function reportRevision(review, publication) {
  if (review == null) return `p${publication.revision}`;
  const stateVersion = review.state_version ?? 0;
  return publication == null
    ? String(stateVersion)
    : `${stateVersion}-p${publication.revision}`;
}

// `review` is null for a REMOTE_ONLY publication, which has no review ledger;
// the publication is then required. `authorization` is the bound gate or
// sidecar the store reader admitted, when the caller read one.
export function renderReviewReport(
  review,
  {
    publication = null,
    authorization = null,
    renderedAt = new Date().toISOString(),
    ledgerDirectory = null,
  } = {},
) {
  if (review == null && publication == null) {
    throw new Error("a report needs a review ledger or a publication ledger");
  }
  if (review == null && !isRemoteOnly(publication)) {
    throw reportError(
      "REVIEW_LEDGER_MISSING",
      "review ledger missing for a LOCAL_GATE publication",
      { review_id: publication.review_id ?? null },
    );
  }
  const reviewId = review?.id ?? publication.review_id;
  const directory = ledgerDirectory ?? path.join("reviews", String(reviewId));
  const ledgers = [
    ...(review == null ? [] : ["review.json"]),
    ...(publication == null ? [] : ["publication.json"]),
    ...(review == null && authorization != null ? ["remote-authorization.json"] : []),
  ].map((name) => code(path.join(directory, name)));
  const sections = [
    `# Review report ${inline(reviewId)}`,
    ...(review == null
      ? remoteOnlySection()
      : [
          ...identitySection(review),
          ...successorSection(review),
          ...roundsSection(review),
          ...findingsSection(review),
          ...changesSection(review),
          ...outcomeSection(review),
        ]),
    ...remoteSection(publication, authorization),
    "## Footer",
    [
      `- Review: ${code(reviewId)}`,
      `- Review ledger state_version: ${review == null ? "n/a (remote-only: no local review ledger)" : (review.state_version ?? 0)}`,
      `- Publication ledger revision: ${publication == null ? "none" : publication.revision}`,
      `- Report revision: ${code(reportRevision(review, publication))}`,
      `- Rendered at: ${inline(renderedAt)}`,
      `- Ledger: ${ledgers.join(", ")}`,
    ].join("\n"),
    review == null ? PROJECTION_NOTICE_REMOTE_ONLY : PROJECTION_NOTICE,
  ];
  return `${sections.join("\n\n")}\n`;
}

// The ledgers a report is rendered from, each admitted by the reader the
// server itself uses -- never as raw bytes, because the report combines two or
// three files and files a document under the review's name. Each is optional
// on its own: a review that never published has no publication, a REMOTE_ONLY
// publication has no review. One of the two must exist, and a publication
// must be bound to the authorization file beside it.
export async function loadReportLedgers(storeRoot, reviewId) {
  if (typeof reviewId !== "string" || !REVIEW_ID_PATTERN.test(reviewId)) {
    throw reportError("INVALID_REVIEW_ID", "invalid review_id", { review_id: reviewId });
  }
  const directory = path.join(storeRoot, "reviews", reviewId);
  const reviewPath = path.join(directory, "review.json");
  // The validated loader: the store's own serialization, the state machine's
  // shape, and every round's snapshot commitment reproduced from its manifest
  // and patch. A ledger edited or rolled back in place fails here.
  const review = fs.existsSync(reviewPath)
    ? await loadValidatedReview(storeRoot, reviewId)
    : null;
  let publication = null;
  try {
    // Canonical bytes, the stored-ledger schema, and the review_id inside are
    // all checked by the publication reader.
    publication = await getPublication(storeRoot, reviewId);
  } catch (error) {
    if (error?.code !== "PUBLICATION_NOT_FOUND") throw error;
  }
  if (review == null && publication == null) {
    throw reportError(
      "REVIEW_NOT_FOUND",
      `review ${reviewId} not found: neither review.json nor publication.json exists`,
      { review_id: reviewId, path: directory },
    );
  }
  // A local-gate publication always has a review ledger beside it; one that is
  // missing is an incomplete store, not a review that was skipped.
  if (review == null && !isRemoteOnly(publication)) {
    throw reportError(
      "REVIEW_LEDGER_MISSING",
      `review ledger missing for a LOCAL_GATE publication: ${reviewPath}`,
      { review_id: reviewId, path: reviewPath },
    );
  }
  // The gate file or remote sidecar, admitted by the publication reader's own
  // binding check; a file it rejects, or one that is missing, fails the
  // render rather than lending the report fields the ledger never bound.
  const authorization =
    publication == null
      ? null
      : await readBoundPublicationAuthorization(storeRoot, reviewId, publication);
  return { directory, review, publication, authorization };
}

// Publishes fully written bytes at `filePath` only if nothing is there yet: the
// temporary file is complete before the link, and link refuses an existing
// target, so two renderers racing on one revision leave exactly one file and
// neither ever sees the other's partial write. Whatever fails, the temporary
// file is removed.
async function createExclusive(filePath, data) {
  const temporary = `${filePath}.${crypto.randomBytes(16).toString("hex")}.tmp`;
  let handle = null;
  let linking = false;
  try {
    handle = await fsp.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    linking = true;
    await fsp.link(temporary, filePath);
    return true;
  } catch (error) {
    if (linking && error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}

// Writes `report-r<revision>.md` beside the ledger and returns a receipt. The
// ledger at a revision is immutable, so the report at that revision is too: an
// existing file is kept as it is rather than rewritten with a fresh render
// time, and the receipt always describes the bytes actually at the path. The
// Markdown itself stays in the file: a report can run to megabytes, and the
// driver that calls this after a gate needs the path, not the bytes.
export async function writeReviewReport(storeRoot, reviewId, { renderedAt } = {}) {
  const { directory, review, publication, authorization } =
    await loadReportLedgers(storeRoot, reviewId);
  const revision = reportRevision(review, publication);
  // `r<state_version>[-p<revision>]` with a review, `p<revision>` without one.
  const filePath = path.join(
    directory,
    review == null ? `report-${revision}.md` : `report-r${revision}.md`,
  );
  let reused = true;
  if (!fs.existsSync(filePath)) {
    const markdown = renderReviewReport(review, {
      publication,
      authorization,
      renderedAt,
      ledgerDirectory: directory,
    });
    reused = !(await createExclusive(filePath, markdown));
  }
  const bytes = await fsp.readFile(filePath);
  return {
    review_id: reviewId,
    review_state_version: review == null ? null : (review.state_version ?? 0),
    publication_revision: publication?.revision ?? null,
    revision,
    path: filePath,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    reused,
  };
}
