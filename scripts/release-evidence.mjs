// Pure release-evidence logic (RFC 0004): CHANGELOG reconciliation, the one
// requirement list both verification phases run, the release observation
// normalizer, and the evidence record's construction and comparison.
//
// Nothing here performs I/O or talks to GitHub. Every fact arrives as data, so
// each named failure has a test that turns it red without a network or a store.

import { canonicalJson, sha256 } from "../src/storage.mjs";

export const RELEASE_OBSERVATION_SCHEMA = "review-bridge/release-observation/1";
export const RELEASE_RECORD_SCHEMA = "review-bridge/release-record/1";
export const CHECKSUM_MANIFEST_NAME = "SHA256SUMS.txt";

// Human-readable, machine-exact, and ordinary CHANGELOG text: moving it is a
// visible edit in the same diff that changes what it governs.
const CUTOFF_MARKER_RE =
  /^Pull-request references required from:[ \t]*(\S+)[ \t]*$/m;
const ENTRY_HEADING_RE = /^## (\S+)(?: - (\S+))?[ \t]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function failure(code, message, fields = {}) {
  return { code, message, ...fields };
}

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ""));
  return match == null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a == null || b == null) {
    throw new TypeError("release versions must be MAJOR.MINOR.PATCH");
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

export function versionFromTagName(tagName) {
  return /^v(\d+\.\d+\.\d+)$/.exec(String(tagName ?? ""))?.[1] ?? null;
}

/**
 * The cutoff marker, always read from the default branch's CHANGELOG. Adoption
 * is a repository-level fact, and a tag created before the marker existed
 * cannot carry it, so the historical text a tag holds is never consulted.
 */
export function cutoffVersion(defaultBranchChangelog) {
  if (typeof defaultBranchChangelog !== "string") {
    return null;
  }
  const header = defaultBranchChangelog.split(/^## /m)[0];
  const marker = CUTOFF_MARKER_RE.exec(header)?.[1] ?? "";
  return parseVersion(marker) == null ? null : marker;
}

/**
 * Split a CHANGELOG into entries, newest first. Each entry keeps its exact
 * text so the record can pin the claim set the verification actually used, and
 * its bullets so the per-bullet reference requirement is decidable rather than
 * a reading of the prose.
 */
export function parseChangelogEntries(text) {
  const lines = String(text ?? "").split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    const heading = ENTRY_HEADING_RE.exec(line);
    if (heading != null) {
      current = {
        version: parseVersion(heading[1]) == null ? null : heading[1],
        heading: heading[1],
        lines: [line],
      };
      entries.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return entries.map((entry) => {
    const body = `${entry.lines.join("\n").replace(/\s+$/, "")}\n`;
    return {
      version: entry.version,
      heading: entry.heading,
      text: body,
      sha256: sha256(body),
      bullets: bulletsOf(entry.lines),
    };
  });
}

// A bullet is a top-level "- " item plus its continuation lines. Nested items
// belong to their parent bullet: a sub-item elaborates a change the parent
// already names, and requiring its own reference would force the same number
// to be repeated down the indentation.
function bulletsOf(lines) {
  const bullets = [];
  for (const line of lines) {
    if (/^- /.test(line)) {
      bullets.push([line]);
    } else if (bullets.length > 0 && /^\s+\S/.test(line)) {
      bullets.at(-1).push(line);
    }
  }
  return bullets.map((bulletLines) => {
    const body = bulletLines.join("\n");
    return {
      text: body,
      references: [
        ...new Set(
          [...body.matchAll(/\(#(\d+)\)/g)].map((match) => Number(match[1])),
        ),
      ].sort((left, right) => left - right),
    };
  });
}

/**
 * Reconcile the CHANGELOG claims of a release range against the pull requests
 * discovered in it.
 *
 * The two comparison directions carry different weight before the tag exists:
 * a merge the local history shows is ground truth for presence, so an
 * unclaimed one fails in both phases, while a claimed pull request local
 * discovery cannot find is deferred in pre-flight -- local merge-commit
 * history cannot prove absence, and only the final phase's GitHub facts can
 * settle it.
 */
export function reconcileClaims({
  entries,
  cutoff,
  version,
  previousVersion,
  mergedPullRequests,
  phase,
}) {
  const failures = [];
  const deferred = [];
  const inRange = entries.filter(
    (entry) =>
      entry.version != null &&
      compareVersions(entry.version, version) <= 0 &&
      (previousVersion == null ||
        compareVersions(entry.version, previousVersion) > 0),
  );
  const governed = [];
  const preConvention = [];
  for (const entry of inRange) {
    if (cutoff != null && compareVersions(entry.version, cutoff) >= 0) {
      governed.push(entry);
    } else {
      preConvention.push(entry);
    }
  }
  for (const entry of governed) {
    for (const [index, bullet] of entry.bullets.entries()) {
      if (bullet.references.length === 0) {
        failures.push(
          failure(
            "ENTRY_REFERENCES_MISSING",
            `CHANGELOG ${entry.heading} bullet ${index + 1} names no pull request`,
            { version: entry.version, bullet: index + 1 },
          ),
        );
      }
    }
  }
  // An incomplete claim set cannot be compared in either direction, so a range
  // containing any pre-convention entry is reported rather than judged. Entries
  // at or after the cutoff still fail on omitted references above, so a new
  // entry cannot borrow the legacy exemption by leaving its references out.
  const status = preConvention.length > 0 ? "PRE_CONVENTION" : "RECONCILED";
  const claimed = new Set(
    governed.flatMap((entry) =>
      entry.bullets.flatMap((bullet) => bullet.references),
    ),
  );
  const merged = new Set(mergedPullRequests.map((entry) => entry.number));
  if (status === "RECONCILED") {
    for (const number of [...merged].sort((left, right) => left - right)) {
      if (!claimed.has(number)) {
        failures.push(
          failure(
            "UNCLAIMED_MERGE",
            `pull request #${number} merged in the range is in no reconciled CHANGELOG entry`,
            { pull_request: number },
          ),
        );
      }
    }
    for (const number of [...claimed].sort((left, right) => left - right)) {
      if (merged.has(number)) {
        continue;
      }
      const unfound = failure(
        "UNFOUND_CLAIM",
        `CHANGELOG claims pull request #${number}, which the range's merged pull requests do not contain`,
        { pull_request: number },
      );
      if (phase === "PRE") {
        deferred.push(unfound);
      } else {
        failures.push(unfound);
      }
    }
  }
  return {
    status,
    failures,
    deferred,
    entries: inRange.map((entry) => ({
      version: entry.version,
      sha256: entry.sha256,
      convention:
        cutoff != null && compareVersions(entry.version, cutoff) >= 0
          ? "GOVERNED"
          : "PRE_CONVENTION",
    })),
    claimed: [...claimed].sort((left, right) => left - right),
  };
}

/**
 * Every version-carrying file the release target holds must name the same
 * version. A carrier absent at the target -- a historical tag predating a
 * template -- is reported rather than silently skipped.
 */
export function versionAlignment(version, files) {
  const failures = [];
  const notes = [];
  const carrier = (name, check) => {
    const text = files[name];
    if (text == null) {
      notes.push(`carrier_absent:${name}`);
      return;
    }
    let mismatch;
    try {
      mismatch = check(text);
    } catch (error) {
      mismatch = `unreadable (${error.message})`;
    }
    if (mismatch != null) {
      failures.push(
        failure("VERSION_ALIGNMENT", `${name} ${mismatch}`, { carrier: name }),
      );
    }
  };
  const jsonVersion = (text) => {
    const actual = JSON.parse(text).version;
    return actual === version ? null : `declares version ${actual}`;
  };
  carrier("package.json", jsonVersion);
  carrier("templates/codex-plugin/.codex-plugin/plugin.json", jsonVersion);
  carrier("templates/claude-extension/manifest.json", jsonVersion);
  carrier("CHANGELOG.md", (text) => {
    const top = parseChangelogEntries(text)[0];
    if (top == null) {
      return "has no entry";
    }
    return top.heading === version
      ? null
      : `names ${top.heading} as its top entry`;
  });
  carrier("README.md", (text) => {
    const versions = [...new Set(text.match(/\bv\d+\.\d+\.\d+\b/g) ?? [])];
    if (versions.length === 0) {
      return "states no release version";
    }
    const wrong = versions.filter((value) => value !== `v${version}`);
    return wrong.length === 0 ? null : `states ${wrong.join(", ")}`;
  });
  carrier("SECURITY.md", (text) => {
    const series = version.split(".").slice(0, 2).join(".");
    return text.includes(`Only the latest \`${series}.x\` release`)
      ? null
      : `does not support the \`${series}.x\` series`;
  });
  return { failures, notes };
}

export function parseChecksumManifest(text) {
  const entries = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (match == null) {
      throw new Error(`malformed checksum manifest line: ${line}`);
    }
    entries.push({ name: match[2], sha256: match[1] });
  }
  return entries;
}

/**
 * The published assets against a local `verify:build` output for the same tag.
 * The manifest is validated by content first and then excluded from the
 * payload set, because a manifest cannot list a stable checksum of itself.
 */
export function verifyAssets(published, localManifestText) {
  const failures = [];
  const manifest = published.find(
    (asset) => asset.name === CHECKSUM_MANIFEST_NAME,
  );
  if (manifest == null) {
    return {
      failures: [
        failure(
          "ASSET_MANIFEST_ABSENT",
          `the release publishes no ${CHECKSUM_MANIFEST_NAME}`,
        ),
      ],
      assets: assetDigests(published),
    };
  }
  if (manifest.sha256 !== sha256(localManifestText)) {
    failures.push(
      failure(
        "ASSET_MANIFEST_MISMATCH",
        `published ${CHECKSUM_MANIFEST_NAME} differs from the local build's`,
      ),
    );
  }
  let expected;
  try {
    expected = parseChecksumManifest(localManifestText);
  } catch (error) {
    // A manifest whose format cannot be read leaves the payload comparison
    // with nothing to compare against, and the report is the only place the
    // operator learns why. Naming it keeps it in the structured failure list
    // instead of leaving the caller a stack trace.
    failures.push(
      failure(
        "ASSET_MANIFEST_MALFORMED",
        `the local build's ${CHECKSUM_MANIFEST_NAME} is unreadable: ${error.message}`,
      ),
    );
    return { failures, assets: assetDigests(published) };
  }
  const payload = published.filter(
    (asset) => asset.name !== CHECKSUM_MANIFEST_NAME,
  );
  for (const entry of expected) {
    const asset = payload.find((candidate) => candidate.name === entry.name);
    if (asset == null) {
      failures.push(
        failure("ASSET_MISSING", `the manifest lists unpublished ${entry.name}`, {
          asset: entry.name,
        }),
      );
    } else if (asset.sha256 !== entry.sha256) {
      failures.push(
        failure(
          "ASSET_DIGEST_MISMATCH",
          `published ${entry.name} does not match its manifest checksum`,
          { asset: entry.name },
        ),
      );
    }
  }
  for (const asset of payload) {
    if (!expected.some((entry) => entry.name === asset.name)) {
      failures.push(
        failure(
          "ASSET_UNEXPECTED",
          `the release publishes ${asset.name}, which the manifest does not list`,
          { asset: asset.name },
        ),
      );
    }
  }
  return { failures, assets: assetDigests(published) };
}

function assetDigests(published) {
  return published
    .map((asset) => ({ name: asset.name, sha256: asset.sha256 }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The commit `MERGE_READY` was recorded for must be the commit that entered
 * history. A pull request with no terminal record is `unattested` and one
 * whose merge destroyed the attested head's identity is `unverifiable`; both
 * are information, not failure.
 */
export function verifyMergeIntegrity(mergedPullRequests, attestations) {
  const failures = [];
  const pullRequests = [];
  for (const pullRequest of mergedPullRequests) {
    const attestation = attestations[pullRequest.number] ?? null;
    const entry = {
      number: pullRequest.number,
      merge_sha: pullRequest.merge_sha,
      attestation: { status: "UNATTESTED" },
    };
    if (attestation == null) {
      pullRequests.push(entry);
      continue;
    }
    if (attestation.ambiguous === true) {
      failures.push(
        failure(
          "ATTESTATION_AMBIGUOUS",
          `pull request #${pullRequest.number} has terminal records attesting different heads`,
          { pull_request: pullRequest.number },
        ),
      );
      entry.attestation = { status: "AMBIGUOUS" };
    } else if (pullRequest.merge_parents.length < 2) {
      entry.attestation = {
        status: "UNVERIFIABLE",
        workflow_id: attestation.workflow_id,
        attested_head_sha: attestation.head_sha,
      };
    } else if (pullRequest.merge_parents[1] !== attestation.head_sha) {
      failures.push(
        failure(
          "MERGE_INTEGRITY_MISMATCH",
          `pull request #${pullRequest.number} merged ${pullRequest.merge_parents[1]}, but ${attestation.workflow_id} attested ${attestation.head_sha}`,
          { pull_request: pullRequest.number },
        ),
      );
      entry.attestation = {
        status: "MISMATCHED",
        workflow_id: attestation.workflow_id,
        attested_head_sha: attestation.head_sha,
      };
    } else {
      entry.attestation = {
        status: "MATCHED",
        workflow_id: attestation.workflow_id,
        attested_head_sha: attestation.head_sha,
      };
    }
    pullRequests.push(entry);
  }
  return {
    failures,
    pullRequests: pullRequests.sort((left, right) => left.number - right.number),
  };
}

function assertObject(value, name) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

/**
 * Validate a collected release observation. A malformed observation is refused
 * by name here rather than producing a record built from fields nobody read.
 */
export function normalizeReleaseObservation(input) {
  const raw = assertObject(input, "release observation");
  if (raw.schema !== RELEASE_OBSERVATION_SCHEMA) {
    throw new Error(
      `release observation schema must be ${RELEASE_OBSERVATION_SCHEMA}`,
    );
  }
  const repository = assertObject(raw.repository, "observation.repository");
  if (!Number.isSafeInteger(repository.id) || repository.id <= 0) {
    throw new Error("observation.repository.id must be a positive integer");
  }
  if (typeof repository.full_name !== "string" || repository.full_name === "") {
    throw new Error("observation.repository.full_name must be a string");
  }
  if (parseVersion(raw.version) == null) {
    throw new Error("observation.version must be MAJOR.MINOR.PATCH");
  }
  if (!Number.isFinite(Date.parse(raw.collected_at ?? ""))) {
    throw new Error("observation.collected_at must be an RFC 3339 timestamp");
  }
  const tag = assertObject(raw.tag, "observation.tag");
  if (typeof tag.name !== "string" || tag.name === "") {
    throw new Error("observation.tag.name must be a string");
  }
  if (typeof tag.exists !== "boolean") {
    throw new Error("observation.tag.exists must be boolean");
  }
  if (!tag.exists) {
    return {
      ...raw,
      collected_at: new Date(Date.parse(raw.collected_at)).toISOString(),
    };
  }
  for (const field of ["object_sha", "target_sha"]) {
    if (!SHA_RE.test(tag[field] ?? "")) {
      throw new Error(`observation.tag.${field} must be a full SHA`);
    }
  }
  if (typeof raw.tag_reachable_from_default_branch !== "boolean") {
    throw new Error(
      "observation.tag_reachable_from_default_branch must be boolean",
    );
  }
  const range = assertObject(raw.range, "observation.range");
  if (range.kind === "TAG") {
    if (typeof range.tag !== "string" || !SHA_RE.test(range.target_sha ?? "")) {
      throw new Error("observation.range must name the previous extant tag");
    }
  } else if (range.kind !== "ROOT") {
    throw new Error("observation.range.kind must be TAG or ROOT");
  }
  if (!Array.isArray(raw.merged_pull_requests)) {
    throw new Error("observation.merged_pull_requests must be an array");
  }
  for (const [index, pullRequest] of raw.merged_pull_requests.entries()) {
    assertObject(pullRequest, `merged_pull_requests[${index}]`);
    if (
      !Number.isSafeInteger(pullRequest.number) ||
      pullRequest.number <= 0 ||
      !SHA_RE.test(pullRequest.merge_sha ?? "") ||
      !Array.isArray(pullRequest.merge_parents) ||
      !pullRequest.merge_parents.every((sha) => SHA_RE.test(sha ?? ""))
    ) {
      throw new Error(`merged_pull_requests[${index}] is malformed`);
    }
  }
  const release = assertObject(raw.release, "observation.release");
  if (typeof release.exists !== "boolean") {
    throw new Error("observation.release.exists must be boolean");
  }
  if (release.exists) {
    if (!Array.isArray(release.assets)) {
      throw new Error("observation.release.assets must be an array");
    }
    for (const [index, asset] of release.assets.entries()) {
      assertObject(asset, `release.assets[${index}]`);
      if (typeof asset.name !== "string" || !DIGEST_RE.test(asset.sha256 ?? "")) {
        throw new Error(`release.assets[${index}] is malformed`);
      }
    }
  }
  return {
    ...raw,
    collected_at: new Date(Date.parse(raw.collected_at)).toISOString(),
  };
}

/**
 * The one requirement list both phases run.
 *
 * Pre-flight checks what the repository alone can answer, so it can also run
 * in CI on the release pull request; it persists nothing and claims no
 * continuity with a later run. The final phase reruns every one of those
 * requirements against the peeled tag target and adds the requirements that
 * only exist once the tag and release are published.
 */
export function verifyRelease(input) {
  const phase = input.phase;
  if (phase !== "PRE" && phase !== "FINAL") {
    throw new TypeError("phase must be PRE or FINAL");
  }
  const failures = [];
  const notes = [];
  if (phase === "FINAL" && !input.observation.tag.exists) {
    // Nothing else in the final phase has a target to read: every remaining
    // requirement is about the tag's own content. The report is the catch.
    return {
      phase,
      status: "FAILED",
      failures: [
        failure(
          "TAG_MISSING",
          `${input.observation.tag.name} does not exist, so release ${input.version} cannot be recorded`,
        ),
      ],
      deferred: [],
      notes,
    };
  }
  const cutoff = input.cutoff;
  if (cutoff == null) {
    failures.push(
      failure(
        "CUTOFF_MARKER_MISSING",
        "the default branch's CHANGELOG header states no pull-request reference cutoff",
      ),
    );
  }
  const alignment = versionAlignment(input.version, input.files);
  failures.push(...alignment.failures);
  notes.push(...alignment.notes);
  const reconciliation = reconcileClaims({
    entries: parseChangelogEntries(input.files["CHANGELOG.md"] ?? ""),
    cutoff,
    version: input.version,
    previousVersion: input.previousVersion,
    mergedPullRequests: input.mergedPullRequests,
    phase,
  });
  failures.push(...reconciliation.failures);
  if (phase === "PRE") {
    return {
      phase,
      status: failures.length === 0 ? "PASSED" : "FAILED",
      failures,
      deferred: reconciliation.deferred,
      notes,
      reconciliation: reconciliation.status,
    };
  }
  if (!input.observation.tag_reachable_from_default_branch) {
    failures.push(
      failure(
        "TAG_UNREACHABLE",
        `${input.observation.tag.name} is not reachable from the default branch`,
      ),
    );
  }
  let assets = [];
  if (!input.observation.release.exists) {
    failures.push(
      failure(
        "RELEASE_MISSING",
        `no published release targets ${input.observation.tag.name}`,
      ),
    );
  } else {
    const assetResult = verifyAssets(
      input.observation.release.assets,
      input.localManifest,
    );
    failures.push(...assetResult.failures);
    assets = assetResult.assets;
  }
  const integrity = verifyMergeIntegrity(
    input.mergedPullRequests,
    input.attestations,
  );
  failures.push(...integrity.failures);
  return {
    phase,
    status: failures.length === 0 ? "PASSED" : "FAILED",
    failures,
    deferred: [],
    notes,
    reconciliation: reconciliation.status,
    record:
      failures.length === 0
        ? buildReleaseRecord({
            observation: input.observation,
            reconciliation,
            assets,
            pullRequests: integrity.pullRequests,
            cutoff,
            observationRef: input.observationRef,
            verifierVersion: input.verifierVersion,
          })
        : null,
  };
}

export function buildReleaseRecord({
  observation,
  reconciliation,
  assets,
  pullRequests,
  cutoff,
  observationRef,
  verifierVersion,
}) {
  return {
    schema: RELEASE_RECORD_SCHEMA,
    repository: {
      id: observation.repository.id,
      full_name: observation.repository.full_name,
    },
    version: observation.version,
    tag: {
      name: observation.tag.name,
      object_sha: observation.tag.object_sha,
      target_sha: observation.tag.target_sha,
    },
    range: observation.range,
    cutoff: { version: cutoff, source: "DEFAULT_BRANCH_CHANGELOG" },
    reconciliation: reconciliation.status,
    changelog_entries: reconciliation.entries,
    pull_requests: pullRequests,
    assets,
    observation: {
      path: observationRef.path,
      sha256: observationRef.sha256,
      collected_at: observation.collected_at,
      verifier_version: verifierVersion,
    },
  };
}

// Per-run provenance a fresh collection renews by construction: new provenance
// is not history divergence.
function semanticFields(record) {
  const { observation: _observation, ...semantic } = record;
  return semantic;
}

/**
 * One record per version. A re-run compares and reports; it never overwrites.
 *
 * A historical tag backfilled later -- the permitted human action -- moves the
 * range boundary, which narrows nothing retroactively and is reported as
 * superseded rather than as divergence. A semantic mismatch inside an
 * unchanged boundary means history changed after it was recorded.
 */
export function compareReleaseRecords(existing, fresh) {
  if (canonicalJson(existing.range) !== canonicalJson(fresh.range)) {
    return {
      status: "SUPERSEDED",
      message: `the recorded range boundary ${describeRange(existing.range)} is no longer the current one (${describeRange(fresh.range)})`,
    };
  }
  return canonicalJson(semanticFields(existing)) ===
    canonicalJson(semanticFields(fresh))
    ? { status: "EQUAL", message: "the existing record agrees with this run" }
    : {
        status: "DIVERGED",
        message:
          "the existing record disagrees with this run; history changed after it was recorded",
      };
}

function describeRange(range) {
  return range.kind === "ROOT" ? "the repository root" : range.tag;
}
