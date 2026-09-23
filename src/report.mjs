import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadReview } from "./core.mjs";
import {
  canonicalDigest,
  checkRequiredRuns,
  codexStatus,
  getPublication,
  getPublicationSummary,
  invalidatedAutomaticResolution,
  localGateReviewMismatch,
  readBoundPublicationAuthorization,
  readLocalGateAuthorization,
  resolutionFrontier,
} from "./publication.mjs";
import { sha256 } from "./storage.mjs";

// The footer sentence, stated in the terms README uses for operator narration.
// A report is read by a person; nothing a person reads here advances a ledger.
// The footer names only what the report itself read: the ledger files listed
// there and the publication summary the server computed over its own inputs.
export const PROJECTION_NOTICE =
  "This report is a projection of the ledger, not evidence. It was rendered from the review ledger and, when present, the publication ledger and its gate listed above, and from the publication summary the server computed: nothing in this report advances or proves review state, and citing it as evidence is a misuse. It can be regenerated from them at any time.";
export const PROJECTION_NOTICE_REMOTE_ONLY =
  "This report is a projection of the ledger, not evidence. It was rendered from the publication ledger and its bound authorization listed above, and from the publication summary the server computed: nothing in this report advances or proves publication state, and citing it as evidence is a misuse. It can be regenerated from them at any time.";

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
// The statuses a review stops at; any other is a review still in progress,
// which the report may render at any moment but must not call terminal.
const TERMINAL_STATUSES = [
  "CLEAN",
  "LOCAL_GATE_PASSED",
  "HUMAN_REQUIRED",
  "CONTINUABLE_FINDINGS",
];
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

const WRAP_COLUMNS = 80;

// Fenced text never wraps in a Markdown renderer, so one long line renders as
// one horizontally scrolling line. A line that already fits is emitted
// unchanged; a longer one is broken at whitespace, and a token longer than the
// column is emitted whole on its own line rather than split. Each whitespace
// run is visited once, so a field at the store's size limit costs one pass
// rather than one per emitted line.
function wrapLine(line) {
  const pieces = [];
  let start = 0;
  // The last run that would still leave a line within the column, if any.
  let candidate = null;
  const emit = (run) => {
    pieces.push(line.slice(start, run.index));
    start = run.index + run[0].length;
    candidate = null;
  };
  for (const run of line.matchAll(/\s+/g)) {
    if (run.index <= start) continue;
    if (run.index - start > WRAP_COLUMNS) {
      if (candidate !== null) emit(candidate);
      // Still past the column with nothing to break on: one token is wider
      // than the column, so it goes out whole.
      if (run.index - start > WRAP_COLUMNS) {
        emit(run);
        continue;
      }
    }
    candidate = run;
  }
  if (line.length - start > WRAP_COLUMNS && candidate !== null) emit(candidate);
  if (start < line.length || pieces.length === 0) pieces.push(line.slice(start));
  return pieces.join("\n");
}

// A multi-line field is a fenced block whose fence is longer than any backtick
// run inside it, so the text cannot close the fence early. Breaking a long
// line at whitespace neither merges nor splits a backtick run, so the fence is
// still longer than every run the block holds.
function block(value) {
  const text = value == null || value === "" ? "(empty)" : String(value);
  const wrapped = text.split("\n").map(wrapLine).join("\n");
  const longest = Math.max(2, ...[...wrapped.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${wrapped}\n${fence}`;
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

// `path:line` as the ledger recorded it, before any escaping; each caller
// wraps it for the place it goes.
function findingLocation(finding) {
  return `${finding.path}${finding.line == null ? "" : `:${finding.line}`}`;
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => inline(cell)).join(" | ")} |`),
  ].join("\n");
}

function durationSeconds(from, to) {
  const start = Date.parse(from ?? "");
  const end = Date.parse(to ?? "");
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatDuration(seconds) {
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function wallTime(from, to) {
  const seconds = durationSeconds(from, to);
  return seconds == null ? "n/a" : formatDuration(seconds);
}

function eventFor(history, events, round) {
  return history.find(
    (entry) => events.includes(entry?.event) && entry.round === round,
  );
}

function list(values) {
  return values.length === 0 ? "none" : values.map(code).join(", ");
}

// A ledger older than the strategy field has none to print; the validator
// requires the field on every ledger whose prepared events record a mode, so
// "not recorded" is only ever an old ledger, never a stripped one.
function strategyLine(review) {
  const strategy = review.review_strategy;
  if (strategy == null) return "not recorded (ledger predates the strategy field)";
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
      ...rounds.map((round) => `- Round ${round.round} reviewer requested: ${round.reviewer_configuration ? code(JSON.stringify(round.reviewer_configuration.requested)) : "unavailable"}; observed: unavailable (remote model identity is not authenticated by launch logs).`),
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

// The mode a round was prepared under, as its own prepared event recorded it;
// a round from before the event carried one is read from its own proof.
function roundMode(history, round) {
  const prepared = eventFor(history, PREPARED_EVENTS, round.round);
  return prepared?.mode ?? (round.successor == null ? "FULL" : "SUCCESSOR");
}

// Each round is reviewed under its own strategy: a rereview recomputes the
// successor proof for the new head, and may fall back to FULL. So the
// strategy and proof are rendered per round, from that round's prepared event
// and its own successor record, never from another round's.
//
// A successor round's snapshot commitment covers its proof since the
// commitment existed; a round from before it carries the proof as recorded
// only, and every item of that proof is marked so the report relays the
// record without vouching for it.
//
// Each item is the proof as the round recorded it. A field an older proof
// does not record at all reads as not recorded, never as a value.
function roundStrategySections(review) {
  const history = review.history ?? [];
  return (review.rounds ?? []).flatMap((round) => {
    const mode = roundMode(history, round);
    const successor = round.successor;
    const match = successor?.requirement_match;
    return [
      `#### Round ${round.round} strategy: ${code(mode)}`,
      successor == null
        ? `Reviewed as a full diff of ${code(round.base_sha)} → ${code(round.head_sha)}.`
        : [
            `- Parent review: ${code(successor.parent_review_id)} (${code(successor.parent_reviewer_provider)})`,
            `- Requirement matches the parent: ${match == null ? "not recorded" : match ? "yes" : "no"}`,
            `- Parent head → current head: ${code(successor.parent_head_sha)} → ${code(successor.current_head_sha)}`,
            `- Delta: ${successor.delta_bytes ?? "n/a"} bytes, sha256 ${code(successor.delta_sha256)}`,
            `- Files in the delta: ${list(successor.changed_files ?? [])}`,
            `- Files deleted in the delta: ${list(successor.deleted_files ?? [])}`,
          ].join("\n"),
    ];
  });
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
    ...roundStrategySections(review),
  ];
}

// The finding's one-line facts, then each long field as a labelled fenced
// block. A decision's verification is the obligation: a sustained rebuttal
// must say what the rereviewer checked; other decisions carry one only when
// it was given.
function findingSections(finding, resolution, decision) {
  const location =
    finding.path == null ? "no location" : inline(findingLocation(finding));
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

// A continuation freezes the findings it inherits, each with the review that
// raised it. They are the material this review carries, so they are rendered
// as recorded rather than named in passing; the validator has already
// compared the whole carried set with the source ledger, so this is a
// faithful relay and carries no mark.
function carriedSection(review) {
  const carried = review.carried_findings ?? [];
  if (carried.length === 0) return [];
  return [
    "### Carried findings",
    ...carried.flatMap((entry) => {
      const location =
        entry.path == null ? "no location" : inline(findingLocation(entry));
      const sections = [
        `#### ${inline(entry.finding_id)} carried from ${inline(entry.continued_from_review_id)} · ${inline(entry.severity)} · ${location}`,
        `- Title: ${inline(entry.title)}`,
        "Explanation:",
        block(entry.explanation),
      ];
      if (entry.recommendation) {
        sections.push("Recommendation:", block(entry.recommendation));
      }
      return sections;
    }),
  ];
}

function findingsSection(review) {
  const findings = review.findings ?? [];
  const carried = review.carried_findings ?? [];
  if (findings.length === 0) {
    const sources = [...new Set(carried.map((entry) => entry.continued_from_review_id))];
    return [
      "### Findings",
      carried.length === 0
        ? "No findings were recorded."
        : `No findings were raised in this review; ${carried.length} carried from ${sources.map((id) => code(id)).join(", ")}.`,
    ];
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

// Each round is an immutable snapshot of base → head with its own cumulative
// file table; the ledger keeps no delta between rounds, so none is presented.
// Between rounds only the head relation is stated -- a rereview after a
// rebuttal reviews the same head again. A fix the author reports without a
// following round has no round binding its commit or files, and is said to
// be unavailable rather than inferred.
function changesSection(review) {
  const rounds = review.rounds ?? [];
  const lines = [];
  rounds.forEach((round, index) => {
    if (index > 0) {
      const previous = rounds[index - 1];
      lines.push(
        previous.head_sha === round.head_sha
          ? `- Round ${previous.round} → ${round.round}: head unchanged since round ${previous.round}`
          : `- Round ${previous.round} → ${round.round}: head ${code(previous.head_sha)} → ${code(round.head_sha)}`,
      );
    }
    lines.push(
      `- Round ${round.round} snapshot: ${code(round.base_sha)} → ${code(round.head_sha)}; files: ${list(round.changed_files ?? [])}${(round.deleted_files ?? []).length > 0 ? `; deleted: ${list(round.deleted_files)}` : ""}`,
    );
  });
  const lastRound = rounds.at(-1)?.round;
  const respondedLast = (review.history ?? []).some(
    (entry) => RESPONSE_EVENTS.includes(entry?.event) && entry.round === lastRound,
  );
  // Only a fix to a finding the last round itself raised can lack a later
  // round to bind it; an earlier round's fix was bound by the round after it.
  const lastRoundFindings = new Set(
    (review.findings ?? [])
      .filter((finding) => finding.introduced_round === lastRound)
      .map((finding) => finding.id),
  );
  const fixedLast = (review.resolutions ?? []).some(
    (entry) => entry.disposition === "fixed" && lastRoundFindings.has(entry.finding_id),
  );
  if (respondedLast && fixedLast) {
    lines.push(
      `- After round ${lastRound}: a fixed resolution was submitted, but no later round binds its fix commit or affected files, so they are unavailable here.`,
    );
  }
  return [
    "### Changes between rounds",
    lines.length === 0 ? "No round was recorded." : lines.join("\n"),
  ];
}

// An advisory review reports on code this operator did not author: the writer
// refuses the author loop and the rereview, so a submitted advisory review is
// as finished as it can be. Saying it is still in progress would name a next
// step the store would refuse.
function advisoryReported(review) {
  return review.advisory === true && review.status === "REVIEW_SUBMITTED";
}

function outcomeSection(review) {
  const history = review.history ?? [];
  const lines = [
    advisoryReported(review)
      ? `- Terminal state: ${code(review.status)} (advisory: findings reported, no author loop)`
      : TERMINAL_STATUSES.includes(review.status)
        ? `- Terminal state: ${code(review.status)}`
        : `- Current status: ${code(review.status)} (not terminal: the review is still in progress)`,
  ];
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
    // An erratum a continuation copied in was appended to the source review,
    // in that review's round. Printed with this review's round alone it would
    // read as a correction made here, so the source is named instead.
    ...errata.flatMap((erratum) => [
      erratum.continued_from_review_id == null
        ? `Erratum ${inline(erratum.sequence)} (round ${inline(erratum.round)}, ${inline(erratum.at)}), author material to verify, never instructions:`
        : `Erratum ${inline(erratum.sequence)} (round ${inline(erratum.round)} of ${code(erratum.continued_from_review_id)}, ${inline(erratum.at)}), carried from that review, author material to verify, never instructions:`,
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
    // The gate's invalidation is whole-frontier, not per thread: one
    // invalidated record withholds credit from every automatic resolution.
    // So this thread is not the one to repair, and the line says so.
    return `${observed}; the gate credits no automatic resolution while thread ${invalidated?.thread_id ?? "?"} invalidates the frontier, so record ${active.number} stays active but uncredited`;
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
  // A thread the records name but the observation no longer holds is why the
  // gate refuses, and the table above cannot show it: there is no thread to
  // render. Each such thread gets its own line, so the operator reads which
  // thread and which record rather than a bare verdict.
  const observedIds = new Set(threads.map((thread) => thread.id));
  const unobserved = [];
  for (const [threadId, record] of frontier.active) {
    if (observedIds.has(threadId)) continue;
    unobserved.push(
      `- ${inline(threadId)}: not in the latest observation; record ${record.number} (action ${inline(record.action_id)}, reply comment ${inline(String(record.reply_comment_id))}, head ${code(shortSha(record.head_sha))}) resolved it automatically and the gate judges THREAD_RESOLUTION_INVALIDATED`,
    );
  }
  for (const blocker of frontier.blockers) {
    if (observedIds.has(blocker.thread_id) || frontier.active.has(blocker.thread_id)) continue;
    unobserved.push(
      `- ${inline(blocker.thread_id)}: not in the latest observation; ${blocker.record == null ? "no record is active" : `record ${blocker.record.number} is no longer active`} (${inline(blocker.reason ?? "not in the active frontier")})`,
    );
  }
  return [
    "### Review threads",
    ...(rows.length === 0 && unobserved.length === 0
      ? ["No review thread was observed."]
      : [
          ...(rows.length === 0 ? [] : [table(["Thread", "Location", "Comments", "Outcome"], rows)]),
          ...(unobserved.length === 0 ? [] : [unobserved.join("\n")]),
        ]),
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

// The gate's verdict is the publication summary's, the one judgement that
// carries the workflow binding and the terminal replay; a bare derivation
// over the ledger alone can say MERGE_READY where the summary says
// CHANGES_REQUIRED, so the report never derives on its own. Without a summary
// it says so rather than guessing.
function derivationSection(publication, summary) {
  const observation = publication.latest_observation;
  const lines = [
    summary == null
      ? `- Stored status ${code(publication.status)} at revision ${publication.revision}; not derived here: no publication summary was supplied.`
      : `- Stored status ${code(publication.status)} at revision ${publication.revision}; the publication summary derives ${code(summary.status)}${summary.blocking_reason == null ? "" : ` (${code(summary.blocking_reason)})`}, next action ${code(summary.next_action)}, gate ${code(summary.gate_state)}.`,
  ];
  if (publication.terminal != null) {
    lines.push(
      `- Terminal: ${code(publication.terminal.status)} at revision ${publication.terminal.revision}, ${inline(publication.terminal.at)}: ${inline(publication.terminal.reason ?? "no reason recorded")}`,
    );
  }
  if (observation == null) {
    lines.push(`- ${NO_OBSERVATION}`);
  } else if (summary?.status === "MERGE_READY") {
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

function remoteSection(publication, authorization, summary) {
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
    ...derivationSection(publication, summary),
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

// The summary fields the report prints, digested. The summary changes without
// the ledger's revision moving -- a gate file appears, evidence expires by the
// clock -- so a report's identity has to carry what it printed of it, or a
// stale report would be reused as the current one. Only the printed fields:
// a field the report never shows must not change the report.
export function summaryDigest(summary) {
  return canonicalDigest({
    status: summary.status,
    blocking_reason: summary.blocking_reason ?? null,
    next_action: summary.next_action,
    gate_state: summary.gate_state,
  }).slice(0, 12);
}

// The Markdown this module writes, versioned. A report's identity is made of
// the ledger revisions it rendered, which say nothing about how the renderer
// laid them out: after an upgrade that changes the Markdown, the same
// unchanged ledger resolves to the same path, and the new render collides
// with the old file there as REPORT_FILE_MISMATCH. Carrying the format in the
// identity makes that an upgrade writing a new file beside the old one.
//
// Raise it by one in any change that alters the Markdown this module renders
// -- wording, ordering, a new line, a heading -- so the reports the previous
// version wrote stay readable at their own names.
export const REPORT_FORMAT = 4;

// `r<state_version>[-p<revision>-s<summary digest>]-f<format>` with a review,
// `p<revision>-s<summary digest>-f<format>` without one.
export function reportRevision(review, publication, summary = null) {
  const summaryPart = summary == null ? "" : `-s${summaryDigest(summary)}`;
  const formatPart = `-f${REPORT_FORMAT}`;
  if (review == null) return `p${publication.revision}${summaryPart}${formatPart}`;
  const stateVersion = review.state_version ?? 0;
  return publication == null
    ? `${stateVersion}${formatPart}`
    : `${stateVersion}-p${publication.revision}${summaryPart}${formatPart}`;
}

// ---------------------------------------------------------------------------
// The brief: the same ledgers through the same reader, at the depth a person
// reads. The verdict and where the review goes next come first, what is still
// open comes before what is settled, and a settled finding is one table row.
//
// Nothing here is inferred. Every number is counted over the ledger's own
// fields and every grouping is one the ledger decides -- a finding's severity,
// the round it was introduced in, whether two findings name the same title at
// the same location. A sentence that reads across findings to say what they
// have in common needs a reader who understands them; this renderer has none,
// and states the counting rule instead of the conclusion.

const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"];
// Settled where core says settled: submitRereview writes exactly these two
// statuses as an end. Everything else -- raised, answered, escalated, or
// contested -- is open, and is what the brief leads with.
const SETTLED_STATUSES = new Set(["RESOLVED", "REBUTTAL_ACCEPTED"]);
// What an open finding is still waiting on, from its own status alone.
const OPEN_FINDING_STATE = {
  OPEN: "no author response yet",
  AUTHOR_FIXED: "the author reports it fixed, and no rereview has decided it",
  AUTHOR_REJECTED: "the author rejected it, and no rereview has decided it",
  HUMAN_REQUIRED: "the author escalated it to a human",
  STILL_OPEN: "the rereviewer decided the author's answer did not settle it",
};

function count(number, singular, plural = `${singular}s`) {
  return `${number} ${number === 1 ? singular : plural}`;
}

// An advisory review that has submitted its findings is finished: there is no
// author loop, so its findings are reported, not open. They keep the OPEN
// status in the ledger because nothing will ever move them, and the brief
// must not read that as "awaiting an author".
function partitionFindings(review) {
  const findings = review.findings ?? [];
  const unsettled = findings.filter((finding) => !SETTLED_STATUSES.has(finding.status));
  const reported = advisoryReported(review);
  return {
    all: findings,
    open: reported ? [] : unsettled,
    reported: reported ? unsettled : [],
    resolved: findings.filter((finding) => finding.status === "RESOLVED"),
    rebutted: findings.filter((finding) => finding.status === "REBUTTAL_ACCEPTED"),
  };
}

// A code span inside a table cell. GFM splits a row on a raw `|` even inside a
// span, and a span does not process the backslash that repairs it, so the
// escape goes on the value before it is wrapped; a value carrying a backtick
// falls back to inline(), which escapes the separator already.
function cellCode(value) {
  if (value == null || value === "") return "n/a";
  const text = String(value).replace(/\s+/g, " ");
  return text.includes("`") ? inline(text) : `\`${text.replace(/\|/g, "\\|")}\``;
}

// A two-column table of a label and the fact it names, with no header text.
function factTable(rows) {
  return [
    "| | |",
    "| --- | --- |",
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
  ].join("\n");
}

// Unlike table(), this one does not escape: every cell was built by its caller
// out of inline() and cellCode(), because these cells carry code spans.
function builtTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index < 0 ? SEVERITY_ORDER.length : index;
}

// Counted over the findings themselves rather than over the ranked severities,
// so the breakdown sums to the total printed beside it even for a severity
// this renderer does not rank.
function severityBreakdown(findings) {
  const counts = new Map();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  return [...counts.keys()]
    // Ranked severities first, in the ledger's own order of seriousness, and
    // anything else after them by code unit -- never by locale, which would
    // make the same ledger render differently on two machines.
    .sort(
      (left, right) =>
        severityRank(left) - severityRank(right) ||
        (String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0),
    )
    .map((severity) => `${counts.get(severity)} ${inline(severity)}`)
    .join(", ");
}

function roundTimings(review) {
  const history = review.history ?? [];
  return (review.rounds ?? []).map((round) => {
    const prepared = eventFor(history, PREPARED_EVENTS, round.round);
    const verdict = eventFor(history, VERDICT_EVENTS, round.round);
    return {
      round: round.round,
      head: round.head_sha,
      preparedAt: prepared?.at,
      verdict: verdict?.event,
      verdictAt: verdict?.at,
      seconds: durationSeconds(prepared?.at, verdict?.at),
    };
  });
}

// Time spent under review, and the span it was spread over. A round without
// both a prepared event and a verdict is left out of the sum rather than
// counted as zero, and the sum says so by naming only the rounds it added.
function wallTimeRow(timings) {
  const measured = timings.filter((entry) => entry.seconds != null);
  if (measured.length === 0) {
    return "not recorded: no round carries both a prepared event and a verdict";
  }
  const total = measured.reduce((sum, entry) => sum + entry.seconds, 0);
  const parts =
    measured.length === 1
      ? ""
      : ` (${measured.map((entry) => formatDuration(entry.seconds)).join(" + ")})`;
  const span = durationSeconds(timings[0]?.preparedAt, timings.at(-1)?.verdictAt);
  const across =
    span == null
      ? ""
      : `, across ${formatDuration(span)} from the first head to the last verdict`;
  return `${formatDuration(total)} under review${parts}${across}`;
}

function reviewedRow(review) {
  const rounds = review.rounds ?? [];
  const files = [...new Set(rounds.flatMap((round) => round.changed_files ?? []))];
  const named =
    files.length === 0
      ? "no changed file"
      : `${files.slice(0, 3).map(cellCode).join(", ")}${files.length > 3 ? `, and ${files.length - 3} more` : ""}`;
  const sizes = rounds
    .map((round) =>
      round.change_size == null
        ? `size not recorded in round ${round.round}`
        : `+${round.change_size.added_lines} −${round.change_size.deleted_lines} in round ${round.round}`,
    )
    .join(", ");
  return sizes === "" ? named : `${named} (${sizes})`;
}

function reviewerRow(review) {
  const history = review.history ?? [];
  const rounds = review.rounds ?? [];
  const modes = [...new Set(rounds.map((round) => roundMode(history, round)))];
  return [
    `${cellCode(review.reviewer_provider ?? "CLAUDE_DESKTOP")}${review.advisory === true ? " (advisory: attests nothing)" : ""}`,
    modes.length === 0
      ? "no round prepared"
      : `${modes.map(cellCode).join(" then ")} strategy`,
    count(rounds.length, "round"),
    `requested ${rounds.at(-1)?.reviewer_configuration ? cellCode(JSON.stringify(rounds.at(-1).reviewer_configuration.requested)) : "unavailable"}; observed unavailable`,
  ].join(", ");
}

function publicationStanding(publication, summary) {
  return summary == null
    ? `stored ${cellCode(publication.status)} at revision ${publication.revision}, with no publication summary supplied`
    : `${cellCode(summary.status)}, next action ${cellCode(summary.next_action)}, gate ${cellCode(summary.gate_state)}`;
}

function pullRequestName(publication) {
  const target = publication.target ?? {};
  return `${inline(target.owner)}/${inline(target.repo)}#${inline(target.pr_number)}`;
}

// The count and its breakdown, with the findings this review carried in named
// beside them rather than folded into either: a carried finding was raised
// somewhere else, and adding it to the total would make the total disagree
// with the sections below.
function findingsFact(review, partition) {
  const carried = (review.carried_findings ?? []).length;
  const raised =
    partition.all.length === 0
      ? "none raised"
      : `${partition.all.length} — ${severityBreakdown(partition.all)}`;
  return carried === 0
    ? raised
    : `${raised}; ${count(carried, "finding")} carried in from an earlier review`;
}

function localFacts(review, publication, summary, partition, timings) {
  const rows = [
    ["Reviewed", reviewedRow(review)],
    ["Reviewer", reviewerRow(review)],
    ["Findings", findingsFact(review, partition)],
    [
      "Outcome",
      partition.reported.length > 0
        ? `${partition.reported.length} reported (advisory: no author loop)`
        : `${partition.resolved.length} fixed and verified · ${partition.open.length} open · ${partition.rebutted.length} rebutted`,
    ],
    ["Wall time", wallTimeRow(timings)],
  ];
  if (publication != null) {
    rows.push([
      "Publication",
      `${pullRequestName(publication)} — ${publicationStanding(publication, summary)}`,
    ]);
  }
  return rows;
}

function remoteOnlyFacts(publication, authorization, summary) {
  const record = authorization ?? publication.authorization ?? {};
  const target = publication.target ?? {};
  return [
    [
      "Reviewed",
      `no local review: authorized ${cellCode(record.mode)} over head ${cellCode(record.head_sha)} on base ${cellCode(record.base_sha)}`,
    ],
    [
      "Authorized",
      `${record.operator_label ? `operator ${inline(record.operator_label)}` : "operator not recorded"}${record.acknowledgement ? `, ${cellCode(record.acknowledgement)}` : ""}${record.authorized_at ? `, at ${inline(record.authorized_at)}` : ""}`,
    ],
    [
      "Pull request",
      `${pullRequestName(publication)}, ${cellCode(target.head_branch)} into ${cellCode(target.base_branch)}`,
    ],
    ["Findings", "none: a REMOTE_ONLY publication has no review ledger to raise them in"],
    ["Outcome", publicationStanding(publication, summary)],
  ];
}

// Where the review goes from here, in the terms the ledger itself carries: the
// publication summary's verdict when a summary was supplied, the stored status
// when one was not, and an explicit "nothing is merged or gated" when there is
// no publication at all.
// Where a review with no publication goes next, from its own status. The
// vocabulary is core's actionRequired, in the reader's terms rather than the
// driver's; anything the table does not name is left to the reader to
// inspect, and says so.
const LOCAL_NEXT_STEP = {
  WAITING_FOR_REVIEW: "the reviewer's first review is still owed",
  REVIEW_SUBMITTED: "the author's resolutions are owed next",
  AUTHOR_RESPONDED: "a rereview is the next step",
  WAITING_FOR_REREVIEW: "the rereview is still owed",
  CLEAN: "the local gate can be finalized next",
  HUMAN_REQUIRED: "a human arbitration is owed before anything else moves",
  CONTINUABLE_FINDINGS: "the open findings are addressed in a fresh full review",
};

function destinationSentence(review, publication, summary) {
  if (publication != null) {
    return `Publication ${pullRequestName(publication)}: ${publicationStanding(publication, summary)}.`;
  }
  if (review?.status === "LOCAL_GATE_PASSED") {
    return `The local gate passed over snapshot ${code(review.clean_snapshot_hash)}; no publication ledger was rendered, so nothing here is merged.`;
  }
  const next = advisoryReported(review)
    ? "the findings are reported and nothing further is owed on this review"
    : review?.advisory === true && review?.status === "CLEAN"
      ? "the advisory review found nothing and nothing further is owed on it"
      : Object.hasOwn(LOCAL_NEXT_STEP, review?.status)
        ? LOCAL_NEXT_STEP[review.status]
        : `its status ${code(review?.status)} names no next step here; inspect the ledger`;
  return `Next: ${next}. No publication ledger was rendered, so nothing here is merged or gated.`;
}

// The first two lines: the terminal state, what is still owed, and where the
// review goes next. Everything below them is detail on these two.
function verdictLines(review, publication, summary, partition) {
  if (review == null) {
    return [
      "**REMOTE_ONLY** — this publication was authorized with local review skipped, so there is no review ledger, no round, and no finding to report.",
      destinationSentence(null, publication, summary),
    ];
  }
  const total = partition.all.length;
  const open = partition.open.length;
  const standing =
    total === 0
      ? "no finding was raised"
      : partition.reported.length > 0
        ? `${count(partition.reported.length, "finding")} reported`
        : open === 0
          ? `${count(total, "finding")} raised, none still open`
          : `${open} of ${count(total, "finding")} still open`;
  const carried =
    review.continued_by_review_id == null
      ? ""
      : `, carried into ${code(review.continued_by_review_id)}`;
  const qualifier = advisoryReported(review)
    ? " (advisory: the findings are reported and there is no author loop to close them)"
    : TERMINAL_STATUSES.includes(review.status)
      ? ""
      : " (not a terminal state: the review is still in progress)";
  return [
    `**${inline(review.status)}** — ${standing}${carried}${qualifier}.`,
    destinationSentence(review, publication, summary),
  ];
}

function findingHeadline(finding) {
  const where =
    finding.path == null ? "no location" : code(findingLocation(finding));
  return `**${inline(finding.id)} · ${inline(finding.severity)} · ${where} — ${inline(finding.title)}**`;
}

// Unresolved first, and a review with none says so on one line instead of
// opening a heading over nothing.
function openFindingsSection(review, partition) {
  const carried = review.carried_findings ?? [];
  if (partition.all.length === 0) {
    return [
      carried.length === 0
        ? "No finding was raised in this review, so nothing is open."
        : `No finding was raised in this review; ${count(carried.length, "finding")} carried in from an earlier review and the full report renders each.`,
    ];
  }
  if (partition.reported.length > 0) {
    return [
      "## Reported — advisory, so no author loop will close these",
      ...partition.reported.map((finding) =>
        [
          findingHeadline(finding),
          `Round ${inline(finding.introduced_round ?? "n/a")} reported it. ${inline(finding.explanation)}`,
        ].join("\n"),
      ),
    ];
  }
  if (partition.open.length === 0) {
    return ["Nothing is still open: every finding this review raised was settled, below."];
  }
  return [
    "## Still open — what the next reader inherits",
    ...partition.open.map((finding) => {
      const state = Object.hasOwn(OPEN_FINDING_STATE, finding.status)
        ? OPEN_FINDING_STATE[finding.status]
        : `its status is ${code(finding.status)}`;
      return [
        findingHeadline(finding),
        `Round ${inline(finding.introduced_round ?? "n/a")} introduced it; ${state}. ${inline(finding.explanation)}`,
      ].join("\n");
    }),
  ];
}

function settledSection(heading, findings, decisionByFinding) {
  if (findings.length === 0) return [];
  return [
    heading,
    builtTable(
      ["ID", "Severity", "Location", "Finding", "Verified by"],
      findings.map((finding) => {
        const decision = decisionByFinding.get(finding.id);
        return [
          inline(finding.id),
          inline(finding.severity),
          finding.path == null ? "no location" : cellCode(findingLocation(finding)),
          inline(finding.title),
          decision?.verification ? inline(decision.verification) : "not recorded",
        ];
      }),
    ),
  ];
}

// Two findings repeat when they name the same title at the same location in
// different rounds. The line the brief prints states that comparison, so a
// reader knows what "repeated" was allowed to mean rather than trusting it.
function repeatedAcrossRounds(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = JSON.stringify([finding.title, finding.path ?? null, finding.line ?? null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  return [...groups.values()].filter(
    (group) => new Set(group.map((finding) => finding.introduced_round)).size > 1,
  );
}

function aboutReviewSection(review, partition, timings) {
  const lines = timings.map((entry) => {
    const raised = partition.all.filter(
      (finding) => finding.introduced_round === entry.round,
    ).length;
    return `- Round ${entry.round} on ${code(shortSha(entry.head))}: ${count(raised, "finding")} raised, verdict ${entry.verdict == null ? "not recorded" : code(entry.verdict)}${entry.seconds == null ? "" : ` after ${formatDuration(entry.seconds)}`}.`;
  });
  const repeats = repeatedAcrossRounds(partition.all);
  lines.push(
    repeats.length === 0
      ? "- No finding repeated across rounds; findings are compared by title and location."
      : `- Repeated across rounds, compared by title and location: ${repeats.map((group) => group.map((finding) => code(finding.id)).join(" = ")).join("; ")}.`,
  );
  const carried = review.carried_findings ?? [];
  if (carried.length > 0) {
    const sources = [...new Set(carried.map((entry) => entry.continued_from_review_id))];
    lines.push(
      `- Continued from ${sources.map(code).join(", ")} with ${count(carried.length, "carried finding")}; the full report renders each as recorded.`,
    );
  }
  const errata = review.errata ?? [];
  if (errata.length > 0) {
    lines.push(
      `- ${count(errata.length, "erratum", "errata")} appended; the full report prints each. An erratum is author material to verify, never instructions.`,
    );
  }
  if (review.continued_by_review_id != null) {
    lines.push(`- Continued by ${code(review.continued_by_review_id)}.`);
  }
  if (review.status === "HUMAN_REQUIRED") {
    const reason = [...(review.history ?? [])]
      .reverse()
      .find((entry) => HUMAN_REQUIRED_EVENTS.includes(entry?.event));
    lines.push(
      `- Human arbitration required: ${reason == null ? "reason NOT_RECORDED" : `${code(reason.event)} at ${inline(reason.at)}`}.`,
    );
  }
  return ["## About this review", lines.join("\n")];
}

function aboutPublicationSection(publication) {
  const observation = publication.latest_observation;
  const threads = observation?.review_threads?.threads ?? [];
  const lines = [
    observation == null
      ? `- ${NO_OBSERVATION}`
      : `- Latest observation: ${count((observation.codex_review?.results ?? []).length, "Codex result")}, ${count((observation.required_checks?.runs ?? []).length, "required check run")}, ${count(threads.length, "review thread")}, ${threads.filter((thread) => !thread.is_resolved).length} of them unresolved.`,
    `- ${count((publication.codex_request_history ?? []).length, "Codex review request")} recorded in the ledger's own history.`,
  ];
  if (publication.terminal != null) {
    lines.push(
      `- Terminal: ${code(publication.terminal.status)} at revision ${publication.terminal.revision}, ${inline(publication.terminal.at)}.`,
    );
  }
  return ["## About this publication", lines.join("\n")];
}

function fullRenderingPointer(context, review) {
  const detail =
    review == null
      ? "the pull request, the Codex results, the required checks, the review threads, and the derivation the gate makes"
      : "round-by-round detail, the author's response to each finding, and the rereviewer's verification";
  return [
    [
      `<details><summary>The full rendering carries ${detail}</summary>`,
      "",
      `Render it with \`review-report.mjs --full\` over ${code(context.reviewId)}, or read the ledger directly at ${context.ledgers.join(", ")}.`,
      "",
      "</details>",
    ].join("\n"),
  ];
}

// The default tier. Same arguments, same admission, same footer as
// renderReviewReport; only the depth differs.
export function renderReviewBrief(
  review,
  {
    publication = null,
    authorization = null,
    publicationSummary = null,
    renderedAt = new Date().toISOString(),
    ledgerDirectory = null,
  } = {},
) {
  const context = reportContext(review, publication, authorization, ledgerDirectory);
  const partition = review == null ? null : partitionFindings(review);
  const timings = review == null ? [] : roundTimings(review);
  const decisionByFinding = new Map(
    (review?.rereview_decisions ?? []).map((entry) => [entry.finding_id, entry]),
  );
  const sections = [
    `# Review report ${inline(context.reviewId)}`,
    verdictLines(review, publication, publicationSummary, partition).join("\n"),
    review == null
      ? factTable(remoteOnlyFacts(publication, authorization, publicationSummary))
      : factTable(localFacts(review, publication, publicationSummary, partition, timings)),
    ...(review == null
      ? [
          "No finding is reported here: a `REMOTE_ONLY` publication has no review ledger, so none was raised locally. What gated it is the remote side alone -- the Codex review, the required checks, and the review threads the publication recorded.",
        ]
      : [
          ...openFindingsSection(review, partition),
          ...settledSection("## Fixed and verified", partition.resolved, decisionByFinding),
          ...settledSection(
            "## Rebutted, and the rebuttal accepted",
            partition.rebutted,
            decisionByFinding,
          ),
        ]),
    ...fullRenderingPointer(context, review),
    ...(review == null
      ? aboutPublicationSection(publication)
      : aboutReviewSection(review, partition, timings)),
    ...footerSections(context, { review, publication, publicationSummary, renderedAt }),
  ];
  return `${sections.join("\n\n")}\n`;
}

// What both tiers are rendered against: the same admission rules, the same
// review id, and the same list of files the footer names. A tier that reached
// this with a ledger the other tier would refuse would be a second code path.
function reportContext(review, publication, authorization, ledgerDirectory) {
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
  // Every file that was read and rendered, so the footer names exactly what
  // the projection was made from: the bound authorization is gate.json for a
  // local gate and the remote sidecar otherwise.
  const ledgers = [
    ...(review == null ? [] : ["review.json"]),
    ...(publication == null ? [] : ["publication.json"]),
    ...(authorization == null
      ? []
      : [authorization.mode === "LOCAL_GATE" ? "gate.json" : "remote-authorization.json"]),
  ].map((name) => code(path.join(directory, name)));
  return { reviewId, directory, ledgers };
}

// The identity and the projection notice, the same in both tiers: a brief and
// a full report of one ledger are one document at two depths, so they must
// answer "which ledgers, at which revision, rendered by which format" alike.
function footerSections(
  { reviewId, ledgers },
  { review, publication, publicationSummary, renderedAt },
) {
  return [
    "## Footer",
    [
      `- Review: ${code(reviewId)}`,
      `- Review ledger state_version: ${review == null ? "n/a (remote-only: no local review ledger)" : (review.state_version ?? 0)}`,
      `- Publication ledger revision: ${publication == null ? "none" : publication.revision}`,
      `- Report revision: ${code(reportRevision(review, publication, publicationSummary))}`,
      `- Rendered at: ${inline(renderedAt)}`,
      `- Ledger: ${ledgers.join(", ")}`,
      ...(publication == null
        ? []
        : [
            publicationSummary == null
              ? "- Publication summary: not supplied to this render."
              : `- Publication summary: computed by the server over its own inputs (gate file, workflow binding, resolution sources); digest s${summaryDigest(publicationSummary)}.`,
          ]),
    ].join("\n"),
    review == null ? PROJECTION_NOTICE_REMOTE_ONLY : PROJECTION_NOTICE,
  ];
}

// `review` is null for a REMOTE_ONLY publication, which has no review ledger;
// the publication is then required. `authorization` is the bound gate or
// sidecar the store reader admitted, and `publicationSummary` the summary the
// server computed over the same ledger, when the caller read them.
export function renderReviewReport(
  review,
  {
    publication = null,
    authorization = null,
    publicationSummary = null,
    renderedAt = new Date().toISOString(),
    ledgerDirectory = null,
  } = {},
) {
  const context = reportContext(review, publication, authorization, ledgerDirectory);
  const sections = [
    `# Review report ${inline(context.reviewId)}`,
    ...(review == null
      ? remoteOnlySection()
      : [
          ...identitySection(review),
          ...roundsSection(review),
          ...carriedSection(review),
          ...findingsSection(review),
          ...changesSection(review),
          ...outcomeSection(review),
        ]),
    ...remoteSection(publication, authorization, publicationSummary),
    ...footerSections(context, { review, publication, publicationSummary, renderedAt }),
  ];
  return `${sections.join("\n\n")}\n`;
}

// The ledgers a report is rendered from, each admitted by the reader the
// server itself uses -- never as raw bytes, because the report combines two or
// three files and files a document under the review's name. Each is optional
// on its own: a review that never published has no publication, a REMOTE_ONLY
// publication has no review. One of the two must exist, and a publication
// must be bound to the authorization file beside it.
export async function loadReportLedgers(
  storeRoot,
  reviewId,
  // The publication reader is injectable so a test can move the ledger
  // between the two reads below; callers never pass it.
  { readPublication = getPublication } = {},
) {
  if (typeof reviewId !== "string" || !REVIEW_ID_PATTERN.test(reviewId)) {
    throw reportError("INVALID_REVIEW_ID", "invalid review_id", { review_id: reviewId });
  }
  const directory = path.join(storeRoot, "reviews", reviewId);
  const reviewPath = path.join(directory, "review.json");
  // The validated loader: the store's own serialization, the state machine's
  // shape, and every round's snapshot commitment reproduced from its manifest
  // and patch. A ledger edited or rolled back in place fails here.
  const review = fs.existsSync(reviewPath) ? await loadReview(storeRoot, reviewId) : null;
  // The report is filed under the review id, so the ledger found there must
  // be that review's; a ledger naming another is not this review's projection.
  if (review != null && review.id !== reviewId) {
    throw reportError("REVIEW_LEDGER_INVALID", `review ledger ${reviewId} names ${review.id}`, {
      review_id: reviewId,
      path: reviewPath,
      names: review.id ?? null,
    });
  }
  let publication = null;
  try {
    // Canonical bytes, the stored-ledger schema, and the review_id inside are
    // all checked by the publication reader.
    publication = await readPublication(storeRoot, reviewId);
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
  // The review as loaded, in the store's own serialization, so it can be
  // compared with the file after every other read.
  const reviewDigestLoaded =
    review == null ? null : sha256(`${JSON.stringify(review, null, 2)}\n`);
  // The gate file or remote sidecar, admitted by the publication reader's own
  // binding check; a file it rejects, or one that is missing, fails the
  // render rather than lending the report fields the ledger never bound.
  // A LOCAL_GATE_PASSED review with no publication yet still minted a gate --
  // core enters that status only by writing it -- so the gate is required,
  // read by the same reader, and held to the review's clean snapshot.
  let authorization = null;
  if (publication != null) {
    authorization = await readBoundPublicationAuthorization(storeRoot, reviewId, publication);
  } else if (review.status === "LOCAL_GATE_PASSED") {
    const gatePath = path.join(directory, "gate.json");
    if (!fs.existsSync(gatePath)) {
      throw reportError(
        "LOCAL_GATE_MISSING",
        `review ${reviewId} is LOCAL_GATE_PASSED but its gate.json is missing`,
        { review_id: reviewId, path: gatePath },
      );
    }
    authorization = await readLocalGateAuthorization(storeRoot, reviewId);
  }
  // Whichever path read a local gate -- bound to a publication or standing
  // alone -- it attests this review, so every attested field the review also
  // holds is compared here, once, after the two paths meet. A remote sidecar
  // has no review to compare with.
  if (authorization?.mode === "LOCAL_GATE" && review != null) {
    const mismatch = localGateReviewMismatch(authorization, review);
    if (mismatch != null) {
      throw reportError(
        "LOCAL_GATE_INVALID",
        `gate.json of ${reviewId} attests ${mismatch.field} ${JSON.stringify(mismatch.gate)}, but the review holds ${JSON.stringify(mismatch.review)}`,
        { review_id: reviewId, path: path.join(directory, "gate.json"), ...mismatch },
      );
    }
  }
  // The server's own judgement over the same ledger, workflow binding and
  // terminal replay included; the report prints it and derives nothing.
  const publicationSummary =
    publication == null ? null : await getPublicationSummary(storeRoot, reviewId);
  // The ledger and the summary are read under separate locks, so a snapshot
  // recorded between them leaves a summary of revision N+1 beside a ledger of
  // revision N. An immutable report filed under N must not carry N+1's
  // verdict: the render fails closed and the caller renders again.
  if (publicationSummary != null && publicationSummary.revision !== publication.revision) {
    throw reportError(
      "PUBLICATION_MOVED_DURING_RENDER",
      `publication ${reviewId} moved from revision ${publication.revision} to ${publicationSummary.revision} while the report was being read`,
      {
        review_id: reviewId,
        publication_revision: publication.revision,
        summary_revision: publicationSummary.revision,
      },
    );
  }
  // The review side of the same race: it was read first, and a gate finalized
  // or a publication started after that read leaves a review of one state
  // beside a publication of the next. The file is read again after every
  // other read and must still be the bytes that were loaded; the publication
  // ledger binds no review state_version, so there is no second pair.
  if (review != null) {
    let now;
    try {
      now = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
    } catch (error) {
      throw reportError("LEDGER_UNREADABLE", `cannot re-read ${reviewPath}: ${error.message}`, {
        review_id: reviewId,
        path: reviewPath,
      });
    }
    if (sha256(`${JSON.stringify(now, null, 2)}\n`) !== reviewDigestLoaded) {
      throw reportError(
        "REVIEW_MOVED_DURING_RENDER",
        `review ${reviewId} moved from state_version ${review.state_version ?? "n/a"} (${review.status}) to ${now?.state_version ?? "n/a"} (${now?.status}) while the report was being read`,
        {
          review_id: reviewId,
          state_version_loaded: review.state_version ?? null,
          state_version_now: now?.state_version ?? null,
        },
      );
    }
  }
  return { directory, review, publication, authorization, publicationSummary };
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

// The render time is the one line two renders of the same ledgers legitimately
// differ in; everything else must agree byte for byte. Only the footer's line
// is normalized: the body quotes reviewer and author text, which may contain
// the same words, inside fences.
function withoutRenderTime(markdown) {
  const footer = markdown.lastIndexOf("\n## Footer\n");
  if (footer < 0) return markdown;
  return (
    markdown.slice(0, footer) +
    markdown.slice(footer).replace(/^- Rendered at: .*$/m, "- Rendered at: <render time>")
  );
}

// Writes `report-r<revision>.md` beside the ledger and returns a receipt. The
// ledger at a revision is immutable, so the report at that revision is too:
// the report is always rendered, and a file already at the path is reused
// only if it is that render, render time aside; any other bytes there are
// named as a mismatch rather than reused or overwritten. The Markdown itself
// stays in the file: a report can run to megabytes, and the driver that
// calls this after a gate needs the path, not the bytes.
export async function writeReviewReport(storeRoot, reviewId, { renderedAt } = {}) {
  const { directory, review, publication, authorization, publicationSummary } =
    await loadReportLedgers(storeRoot, reviewId);
  const revision = reportRevision(review, publication, publicationSummary);
  // A file exists per (state_version, publication revision, summary digest,
  // renderer format): the same four again reuse it, any of them moving writes
  // a new one.
  const filePath = path.join(
    directory,
    review == null ? `report-${revision}.md` : `report-r${revision}.md`,
  );
  const markdown = renderReviewReport(review, {
    publication,
    authorization,
    publicationSummary,
    renderedAt,
    ledgerDirectory: directory,
  });
  let reused = true;
  if (!fs.existsSync(filePath)) {
    reused = !(await createExclusive(filePath, markdown));
  }
  const bytes = await fsp.readFile(filePath);
  if (reused && withoutRenderTime(bytes.toString("utf8")) !== withoutRenderTime(markdown)) {
    throw reportError(
      "REPORT_FILE_MISMATCH",
      `${filePath} exists but is not the report rendered from these ledgers`,
      {
        review_id: reviewId,
        path: filePath,
        existing_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        rendered_sha256: crypto.createHash("sha256").update(markdown).digest("hex"),
      },
    );
  }
  return {
    review_id: reviewId,
    review_state_version: review == null ? null : (review.state_version ?? 0),
    publication_revision: publication?.revision ?? null,
    summary_digest: publicationSummary == null ? null : summaryDigest(publicationSummary),
    revision,
    path: filePath,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    reused,
  };
}
