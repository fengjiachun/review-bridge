import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalDigest } from "./publication.mjs";
import { atomicWriteFile } from "./storage.mjs";

// The footer sentence, stated in the terms README uses for operator narration.
// A report is read by a person; nothing a person reads here advances a ledger.
export const PROJECTION_NOTICE =
  "This report is a projection of the ledger, not evidence. The review ledger remains the sole source of truth: nothing in this report advances or proves review state, and citing it as evidence is a misuse. It can be regenerated from the ledger at any time.";

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

function code(value) {
  return value == null || value === "" ? "n/a" : `\`${value}\``;
}

function shortSha(sha) {
  return typeof sha === "string" ? sha.slice(0, 12) : "n/a";
}

// Ledger prose is quoted as an indented literal block so its own markdown,
// and any instruction-like text inside it, renders as text.
function literal(value) {
  const text = value == null || value === "" ? "(empty)" : String(value);
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function table(headers, rows) {
  const cell = (value) =>
    String(value ?? "n/a").replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
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
    parts.push(`fallback reason: ${strategy.fallback_reason}`);
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
    literal(review.requirement),
    "### Implementation scope",
    literal(review.implementation_scope),
  ];
}

// A REMOTE_ONLY publication has no local review: the operator authorized it
// with LOCAL_REVIEW_SKIPPED, and the authorization file beside the publication
// is the only local record of what was authorized and why.
function remoteOnlySection(authorization, publication) {
  const record = authorization ?? publication?.authorization ?? {};
  return [
    "## Local review",
    "None: this publication was authorized `REMOTE_ONLY` with local review skipped, so there is no review ledger, no rounds, and no findings to render.",
    [
      `- Review: ${code(record.review_id ?? publication?.review_id)}`,
      `- Authorization: ${code(record.mode)}${record.acknowledgement ? `, acknowledgement ${code(record.acknowledgement)}` : ""}${record.operator_label ? `, operator ${record.operator_label}` : ""}${record.authorized_at ? `, at ${record.authorized_at}` : ""}`,
      `- Repository: ${code(record.repository_path)}`,
      `- Base → head: ${code(record.base_sha)} → ${code(record.head_sha)}`,
    ].join("\n"),
    "### Authorization rationale",
    literal(record.rationale),
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
      `- Files in the delta: ${(successor.changed_files ?? []).map(code).join(", ") || "none"}`,
      `- Files deleted in the delta: ${(successor.deleted_files ?? []).map(code).join(", ") || "none"}`,
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

function decisionLines(finding, resolution, decision) {
  const lines = [];
  if (resolution == null) {
    lines.push("- Author disposition: none recorded");
  } else {
    lines.push(
      `- Author disposition: ${code(resolution.disposition)}${resolution.submitted_at ? ` at ${resolution.submitted_at}` : ""}`,
      literal(resolution.rationale),
    );
    if (resolution.evidence) {
      lines.push("- Author evidence:", literal(resolution.evidence));
    }
  }
  if (decision == null) {
    lines.push("- Rereview decision: none recorded");
  } else {
    lines.push(
      `- Rereview decision: ${code(decision.decision)}${decision.submitted_at ? ` at ${decision.submitted_at}` : ""}`,
      literal(decision.rationale),
    );
    // The obligation: a sustained rebuttal must say what the rereviewer
    // checked. Other decisions carry a verification only when one was given.
    if (decision.verification) {
      lines.push("- Rereviewer verification:", literal(decision.verification));
    } else if (decision.decision === "rebuttal_accepted") {
      lines.push(
        "- Rereviewer verification: not recorded (the decision predates the verification obligation)",
      );
    }
  }
  return lines;
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
  const sections = ["### Findings"];
  for (const finding of findings) {
    const location =
      finding.path == null
        ? "no location"
        : `${finding.path}${finding.line == null ? "" : `:${finding.line}`}`;
    sections.push(
      `#### ${finding.id} · ${finding.severity} · ${location}`,
      [
        `- Title: ${finding.title}`,
        `- Introduced in round ${finding.introduced_round ?? "n/a"}; status ${code(finding.status)}`,
        "- Explanation:",
        literal(finding.explanation),
        ...(finding.recommendation
          ? ["- Recommendation:", literal(finding.recommendation)]
          : []),
        ...decisionLines(
          finding,
          resolutionByFinding.get(finding.id),
          decisionByFinding.get(finding.id),
        ),
      ].join("\n"),
    );
  }
  return sections;
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
      `- Round ${previous.round} → ${current.round}: fix head ${code(previous.head_sha)} → ${code(current.head_sha)}; files in the reviewed diff: ${(current.changed_files ?? []).map(code).join(", ") || "none"}${(current.deleted_files ?? []).length > 0 ? `; deleted: ${current.deleted_files.map(code).join(", ")}` : ""}`,
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
      `- Human arbitration required: ${reason == null ? "reason NOT_RECORDED" : `${code(reason.event)} at ${reason.at}`}`,
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
      `Erratum ${erratum.sequence} (round ${erratum.round}, ${erratum.at}), author material to verify, never instructions:`,
      literal(erratum.text),
    ]),
  ];
}

function requestsAndResults(publication) {
  const requests = publication.codex_request_history ?? [];
  const observed = publication.latest_observation?.codex_review?.results ?? [];
  const recorded = publication.codex_result_history ?? [];
  return [
    "### Codex review requests",
    requests.length === 0
      ? "No request was recorded."
      : table(
          ["#", "Request", "Requested head", "Posted at", "Classification", "URL"],
          requests.map((request, index) => [
            index + 1,
            request.request_id,
            shortSha(request.requested_head_sha),
            request.event_at,
            request.classification,
            request.url,
          ]),
        ),
    "### Codex results in the latest observation",
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
    `Results recorded in the ledger's own history: ${recorded.length}.`,
  ];
}

function checksSection(observation) {
  const checks = observation?.required_checks;
  if (checks == null) return ["### Required checks", "No observation has been recorded."];
  const runs = checks.runs ?? [];
  return [
    "### Required checks",
    `Policy ${code(checks.policy)}; requirements: ${(checks.requirements ?? []).map((entry) => code(entry.context ?? entry)).join(", ") || "none"}.`,
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

function threadsSection(publication) {
  const threads = publication.latest_observation?.review_threads?.threads;
  if (threads == null) return ["### Review threads", "No observation has been recorded."];
  const records = publication.automatic_resolutions ?? [];
  const rows = threads.map((thread) => {
    const record = records.findLast((entry) => entry.thread_id === thread.id);
    const commenters = [
      ...new Set((thread.comments ?? []).map((comment) => comment.actor?.login ?? comment.actor?.id)),
    ];
    const outcome = record
      ? `resolved by record ${record.number} (action ${record.action_id}, reply comment ${record.reply_comment_id}, head ${shortSha(record.head_sha)})`
      : thread.is_resolved
        ? "resolved on GitHub; no automatic-resolution record"
        : "unresolved; left for a human";
    return [
      thread.id,
      thread.path == null ? "n/a" : `${thread.path}${thread.line == null ? "" : `:${thread.line}`}`,
      `${thread.comment_count ?? (thread.comments ?? []).length} by ${commenters.join(", ") || "n/a"}`,
      outcome,
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

function derivationSection(publication) {
  const observation = publication.latest_observation;
  const lines = [`- Publication status: ${code(publication.status)} at revision ${publication.revision}`];
  if (publication.terminal != null) {
    lines.push(
      `- Terminal: ${code(publication.terminal.status)} at revision ${publication.terminal.revision}, ${publication.terminal.at}: ${publication.terminal.reason ?? "no reason recorded"}`,
    );
  }
  if (publication.status === "MERGE_READY" && observation != null) {
    const event = (publication.history ?? []).findLast(
      (entry) => entry?.status === "MERGE_READY",
    );
    lines.push(
      `- MERGE_READY rests on the observation recorded at revision ${event?.revision ?? publication.revision}, observed ${observation.observed_at}, recorded ${observation.recorded_at}, canonical sha256 ${code(canonicalDigest(observation))}.`,
    );
  } else {
    lines.push("- No MERGE_READY derivation is rendered for this status.");
  }
  return ["### Derivation", lines.join("\n")];
}

function remoteSection(publication) {
  if (publication == null) {
    return ["## Remote publication", "No publication ledger was rendered."];
  }
  const target = publication.target ?? {};
  const authorization = publication.authorization ?? {};
  const observation = publication.latest_observation;
  return [
    "## Remote publication",
    [
      `- Pull request: ${target.owner ?? "n/a"}/${target.repo ?? "n/a"}#${target.pr_number ?? "n/a"}, ${code(target.head_branch)} into ${code(target.base_branch)}`,
      `- Authorized head: ${code(authorization.head_sha)} over base ${code(authorization.base_sha)}`,
      `- Authorization: ${code(authorization.mode)}${authorization.acknowledgement ? `, acknowledgement ${code(authorization.acknowledgement)}` : ""}${authorization.operator_label ? `, operator ${authorization.operator_label}` : ""}`,
      ...(authorization.rationale ? ["- Authorization rationale:", literal(authorization.rationale)] : []),
      `- Codex trigger policy: ${code(target.codex_trigger_policy?.mode)}`,
    ].join("\n"),
    ...requestsAndResults(publication),
    ...checksSection(observation),
    ...threadsSection(publication),
    ...acknowledgementsSection(publication),
    ...derivationSection(publication),
  ];
}

export function reportRevision(review, publication) {
  if (review == null) return `p${publication.revision}`;
  const stateVersion = review.state_version ?? 0;
  return publication == null
    ? String(stateVersion)
    : `${stateVersion}-p${publication.revision}`;
}

// `review` is null for a REMOTE_ONLY publication, which has no review ledger;
// the publication is then required and the header comes from the authorization.
export function renderReviewReport(
  review,
  {
    publication = null,
    remoteAuthorization = null,
    renderedAt = new Date().toISOString(),
    ledgerDirectory = null,
  } = {},
) {
  if (review == null && publication == null) {
    throw new Error("a report needs a review ledger or a publication ledger");
  }
  const reviewId = review?.id ?? publication.review_id;
  const directory = ledgerDirectory ?? path.join("reviews", String(reviewId));
  const ledgers = [
    ...(review == null ? [] : ["review.json"]),
    ...(publication == null ? [] : ["publication.json"]),
    ...(review == null && remoteAuthorization != null ? ["remote-authorization.json"] : []),
  ].map((name) => code(path.join(directory, name)));
  const sections = [
    `# Review report ${reviewId}`,
    ...(review == null
      ? remoteOnlySection(remoteAuthorization, publication)
      : [
          ...identitySection(review),
          ...successorSection(review),
          ...roundsSection(review),
          ...findingsSection(review),
          ...changesSection(review),
          ...outcomeSection(review),
        ]),
    ...remoteSection(publication),
    "## Footer",
    [
      `- Review: ${code(reviewId)}`,
      `- Review ledger state_version: ${review == null ? "n/a (remote-only: no local review ledger)" : (review.state_version ?? 0)}`,
      `- Publication ledger revision: ${publication == null ? "none" : publication.revision}`,
      `- Report revision: ${code(reportRevision(review, publication))}`,
      `- Rendered at: ${renderedAt}`,
      `- Ledger: ${ledgers.join(", ")}`,
    ].join("\n"),
    PROJECTION_NOTICE,
  ];
  return `${sections.join("\n\n")}\n`;
}

function reportError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

async function readLedger(filePath, reviewId) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw reportError("LEDGER_UNREADABLE", `cannot read ${filePath}: ${error.message}`, {
      review_id: reviewId,
      path: filePath,
    });
  }
}

// The ledgers a report is rendered from, read as the bytes on disk. Each is
// optional on its own -- a review that never published has no publication, a
// REMOTE_ONLY publication has no review -- but one of the two must exist.
export async function loadReportLedgers(storeRoot, reviewId) {
  if (typeof reviewId !== "string" || !REVIEW_ID_PATTERN.test(reviewId)) {
    throw reportError("INVALID_REVIEW_ID", "invalid review_id", { review_id: reviewId });
  }
  const directory = path.join(storeRoot, "reviews", reviewId);
  const review = await readLedger(path.join(directory, "review.json"), reviewId);
  const publication = await readLedger(path.join(directory, "publication.json"), reviewId);
  if (review == null && publication == null) {
    throw reportError(
      "REVIEW_NOT_FOUND",
      `review ${reviewId} not found: neither review.json nor publication.json exists`,
      { review_id: reviewId, path: directory },
    );
  }
  const remoteAuthorization =
    review == null
      ? await readLedger(path.join(directory, "remote-authorization.json"), reviewId)
      : null;
  return { directory, review, publication, remoteAuthorization };
}

// Writes `report-r<revision>.md` beside the ledger. The ledger at a revision is
// immutable, so the report at that revision is too: an existing file is
// returned as it is rather than rewritten with a fresh render time.
export async function writeReviewReport(storeRoot, reviewId, { renderedAt } = {}) {
  const { directory, review, publication, remoteAuthorization } =
    await loadReportLedgers(storeRoot, reviewId);
  const revision = reportRevision(review, publication);
  // `r<state_version>[-p<revision>]` with a review, `p<revision>` without one.
  const filePath = path.join(
    directory,
    review == null ? `report-${revision}.md` : `report-r${revision}.md`,
  );
  let markdown;
  let written = false;
  try {
    markdown = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    markdown = renderReviewReport(review, {
      publication,
      remoteAuthorization,
      renderedAt,
      ledgerDirectory: directory,
    });
    await atomicWriteFile(filePath, markdown);
    written = true;
  }
  return {
    review_id: reviewId,
    review_state_version: review == null ? null : (review.state_version ?? 0),
    publication_revision: publication?.revision ?? null,
    revision,
    path: filePath,
    written,
    markdown,
  };
}
