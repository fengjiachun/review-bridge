import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/storage.mjs";
import {
  compareReleaseRecords,
  cutoffVersion,
  normalizeReleaseObservation,
  parseChangelogEntries,
  verifyRelease,
} from "../scripts/release-evidence.mjs";
import {
  ASSET_DIGEST,
  ATTESTED_HEAD_SHA,
  FIRST_PARENT_SHA,
  MANIFEST,
  MERGE_SHA,
  PREVIOUS_TAG_SHA,
  TAG_TARGET_SHA,
  changelog,
  files,
  observation,
  verificationInput as input,
} from "./helpers/release-fixture.mjs";

function codes(result) {
  return result.failures.map((entry) => entry.code);
}

test("a release whose claims and facts agree passes and yields a record", () => {
  const result = verifyRelease(input());
  assert.deepEqual(result.failures, []);
  assert.equal(result.status, "PASSED");
  assert.equal(result.reconciliation, "RECONCILED");
  assert.equal(result.record.tag.target_sha, TAG_TARGET_SHA);
  assert.deepEqual(result.record.range, {
    kind: "TAG",
    tag: "v1.0.0",
    target_sha: PREVIOUS_TAG_SHA,
  });
  assert.deepEqual(result.record.changelog_entries, [
    {
      version: "1.1.0",
      sha256: parseChangelogEntries(changelog())[0].sha256,
      convention: "GOVERNED",
    },
  ]);
  assert.deepEqual(result.record.pull_requests, [
    { number: 7, merge_sha: MERGE_SHA, attestation: { status: "UNATTESTED" } },
  ]);
  assert.deepEqual(result.record.assets, [
    { name: "review-bridge-source-v1.1.0.zip", sha256: ASSET_DIGEST },
    { name: "SHA256SUMS.txt", sha256: observation().release.assets[0].sha256 },
  ]);
  assert.deepEqual(result.record.observation, {
    path: "/store/observations/x.json",
    sha256: "9".repeat(64),
    collected_at: "2026-01-03T00:00:00.000Z",
    verifier_version: "1.1.0",
  });
});

test("VERSION_ALIGNMENT names every carrier that disagrees", () => {
  const result = verifyRelease(
    input({
      files: files({
        "package.json": JSON.stringify({ version: "1.0.9" }),
        "README.md": "Install review-bridge v1.0.9.",
      }),
    }),
  );
  assert.deepEqual(
    result.failures
      .filter((entry) => entry.code === "VERSION_ALIGNMENT")
      .map((entry) => entry.carrier)
      .sort(),
    ["README.md", "package.json"],
  );
});

test("VERSION_ALIGNMENT fails when the top CHANGELOG entry is not the version", () => {
  const result = verifyRelease(
    input({ files: files({ text: changelog().replace("## 1.1.0", "## 1.2.0") }) }),
  );
  assert.ok(
    result.failures.some(
      (entry) =>
        entry.code === "VERSION_ALIGNMENT" && entry.carrier === "CHANGELOG.md",
    ),
  );
});

test("an absent carrier is reported rather than silently skipped", () => {
  const carriers = files();
  delete carriers["templates/claude-extension/manifest.json"];
  const result = verifyRelease(input({ files: carriers }));
  assert.deepEqual(result.notes, [
    "carrier_absent:templates/claude-extension/manifest.json",
  ]);
  assert.equal(result.status, "PASSED");
});

test("CUTOFF_MARKER_MISSING when the default branch states no cutoff", () => {
  assert.equal(cutoffVersion("# Changelog\n\n## 1.1.0 - 2026-01-02\n"), null);
  const result = verifyRelease(input({ cutoff: null }));
  assert.ok(codes(result).includes("CUTOFF_MARKER_MISSING"));
});

test("the cutoff is read from the header, not from an entry that mentions it", () => {
  assert.equal(
    cutoffVersion(
      "# Changelog\n\nPull-request references required from: 1.0.0\n\n## 1.1.0 - 2026-01-02\n",
    ),
    "1.0.0",
  );
  assert.equal(
    cutoffVersion(
      "# Changelog\n\n## 1.1.0 - 2026-01-02\n\nPull-request references required from: 9.9.9\n",
    ),
    null,
  );
});

test("ENTRY_REFERENCES_MISSING when a governed bullet names no pull request", () => {
  const result = verifyRelease(
    input({ files: files({ text: changelog({ entry: "- A shipped thing" }) }) }),
  );
  assert.deepEqual(
    result.failures
      .filter((entry) => entry.code === "ENTRY_REFERENCES_MISSING")
      .map((entry) => entry.bullet),
    [1],
  );
});

test("a nested sub-item belongs to the bullet that already names the change", () => {
  const entries = parseChangelogEntries(
    changelog({ entry: "- A shipped thing (#7)\n  - a detail of it" }),
  );
  assert.equal(entries[0].bullets.length, 1);
  assert.deepEqual(entries[0].bullets[0].references, [7]);
});

test("UNCLAIMED_MERGE when a merged pull request is in no entry", () => {
  const collected = observation();
  collected.merged_pull_requests.push({
    number: 8,
    merge_sha: MERGE_SHA,
    merge_parents: [FIRST_PARENT_SHA, ATTESTED_HEAD_SHA],
  });
  const result = verifyRelease(input({ observation: collected }));
  assert.deepEqual(
    result.failures
      .filter((entry) => entry.code === "UNCLAIMED_MERGE")
      .map((entry) => entry.pull_request),
    [8],
  );
});

test("UNFOUND_CLAIM fails in the final phase and defers in pre-flight", () => {
  const claimsNine = files({
    text: changelog({ entry: "- A shipped thing (#7)\n- Another one (#9)" }),
  });
  const final = verifyRelease(input({ files: claimsNine }));
  assert.deepEqual(
    final.failures
      .filter((entry) => entry.code === "UNFOUND_CLAIM")
      .map((entry) => entry.pull_request),
    [9],
  );
  const pre = verifyRelease(
    input({ phase: "PRE", files: claimsNine, observation: undefined }),
  );
  assert.deepEqual(pre.failures, []);
  assert.equal(pre.status, "PASSED");
  assert.deepEqual(
    pre.deferred.map((entry) => [entry.code, entry.pull_request]),
    [["UNFOUND_CLAIM", 9]],
  );
});

test("a locally visible merge no entry claims still fails in pre-flight", () => {
  const result = verifyRelease(
    input({
      phase: "PRE",
      observation: undefined,
      mergedPullRequests: [
        {
          number: 8,
          merge_sha: MERGE_SHA,
          merge_parents: [FIRST_PARENT_SHA, ATTESTED_HEAD_SHA],
        },
      ],
    }),
  );
  assert.deepEqual(codes(result), ["UNCLAIMED_MERGE"]);
});

test("a range containing a pre-convention entry is reported, not reconciled", () => {
  // A missing intermediate tag widens the range to the 1.0.0 entry, which
  // predates the cutoff, so the claim set is incomplete and neither comparison
  // direction can be judged.
  const result = verifyRelease(input({ cutoff: "1.1.0", previousVersion: null }));
  assert.deepEqual(result.failures, []);
  assert.equal(result.reconciliation, "PRE_CONVENTION");
  assert.deepEqual(
    result.record.changelog_entries.map((entry) => [
      entry.version,
      entry.convention,
    ]),
    [
      ["1.1.0", "GOVERNED"],
      ["1.0.0", "PRE_CONVENTION"],
    ],
  );
});

test("an entry at or after the cutoff cannot borrow the legacy exemption", () => {
  const result = verifyRelease(
    input({
      cutoff: "1.1.0",
      previousVersion: null,
      files: files({ text: changelog({ entry: "- A shipped thing" }) }),
    }),
  );
  assert.deepEqual(codes(result), ["ENTRY_REFERENCES_MISSING"]);
});

test("TAG_MISSING is the whole report for an unreleased version", () => {
  const result = verifyRelease(
    input({ observation: observation({ tag: { name: "v1.1.0", exists: false } }) }),
  );
  assert.deepEqual(codes(result), ["TAG_MISSING"]);
  assert.equal(result.status, "FAILED");
});

test("TAG_UNREACHABLE when the tag is not reachable from the default branch", () => {
  const result = verifyRelease(
    input({
      observation: observation({ tag_reachable_from_default_branch: false }),
    }),
  );
  assert.deepEqual(codes(result), ["TAG_UNREACHABLE"]);
});

test("RELEASE_MISSING when the tag carries no published release", () => {
  const result = verifyRelease(
    input({ observation: observation({ release: { exists: false } }) }),
  );
  assert.deepEqual(codes(result), ["RELEASE_MISSING"]);
});

test("ASSET_MANIFEST_ABSENT when the release publishes no checksum manifest", () => {
  const collected = observation();
  collected.release.assets = collected.release.assets.filter(
    (asset) => asset.name !== "SHA256SUMS.txt",
  );
  const result = verifyRelease(input({ observation: collected }));
  assert.deepEqual(codes(result), ["ASSET_MANIFEST_ABSENT"]);
});

test("ASSET_MANIFEST_MISMATCH when the published manifest is not the local one", () => {
  const result = verifyRelease(
    input({
      localManifest: `${"2".repeat(64)}  review-bridge-source-v1.1.0.zip\n`,
    }),
  );
  assert.deepEqual(codes(result).sort(), [
    "ASSET_DIGEST_MISMATCH",
    "ASSET_MANIFEST_MISMATCH",
  ]);
});

test("ASSET_MISSING when the manifest lists an unpublished asset", () => {
  const manifest = `${MANIFEST}${"3".repeat(64)}  review-bridge-reviewer-v1.1.0.mcpb\n`;
  const collected = observation();
  collected.release.assets[0].sha256 = sha256(manifest);
  const result = verifyRelease(
    input({ observation: collected, localManifest: manifest }),
  );
  assert.deepEqual(codes(result), ["ASSET_MISSING"]);
});

test("ASSET_UNEXPECTED when the release publishes an asset the manifest omits", () => {
  const collected = observation();
  collected.release.assets.push({
    name: "notes.txt",
    size: 3,
    sha256: "4".repeat(64),
  });
  const result = verifyRelease(input({ observation: collected }));
  assert.deepEqual(codes(result), ["ASSET_UNEXPECTED"]);
});

test("ASSET_DIGEST_MISMATCH when a published asset is not the built one", () => {
  const collected = observation();
  collected.release.assets[1].sha256 = "5".repeat(64);
  const result = verifyRelease(input({ observation: collected }));
  assert.deepEqual(codes(result), ["ASSET_DIGEST_MISMATCH"]);
});

test("MERGE_INTEGRITY_MISMATCH when the merged head is not the attested head", () => {
  const result = verifyRelease(
    input({
      attestations: {
        7: {
          workflow_id: "rbwf-2026-01-01T000000-000Z-abcdabcd",
          head_sha: "6".repeat(40),
        },
      },
    }),
  );
  assert.deepEqual(codes(result), ["MERGE_INTEGRITY_MISMATCH"]);
});

test("a matched attestation is recorded with the workflow that made it", () => {
  const result = verifyRelease(
    input({
      attestations: {
        7: {
          workflow_id: "rbwf-2026-01-01T000000-000Z-abcdabcd",
          head_sha: ATTESTED_HEAD_SHA,
        },
      },
    }),
  );
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.record.pull_requests[0].attestation, {
    status: "MATCHED",
    workflow_id: "rbwf-2026-01-01T000000-000Z-abcdabcd",
    attested_head_sha: ATTESTED_HEAD_SHA,
  });
});

test("a squash merge with an attestation is unverifiable, not a failure", () => {
  const collected = observation();
  collected.merged_pull_requests[0].merge_parents = [FIRST_PARENT_SHA];
  const result = verifyRelease(
    input({
      observation: collected,
      attestations: {
        7: {
          workflow_id: "rbwf-2026-01-01T000000-000Z-abcdabcd",
          head_sha: ATTESTED_HEAD_SHA,
        },
      },
    }),
  );
  assert.deepEqual(result.failures, []);
  assert.equal(result.record.pull_requests[0].attestation.status, "UNVERIFIABLE");
});

test("ATTESTATION_AMBIGUOUS when two terminal records attest different heads", () => {
  const result = verifyRelease(input({ attestations: { 7: { ambiguous: true } } }));
  assert.deepEqual(codes(result), ["ATTESTATION_AMBIGUOUS"]);
});

test("a malformed observation is refused by name", () => {
  assert.throws(
    () => normalizeReleaseObservation({ schema: "other" }),
    /release observation schema/,
  );
  assert.throws(
    () => normalizeReleaseObservation(observation({ repository: { id: 0 } })),
    /repository\.id/,
  );
  assert.throws(
    () =>
      normalizeReleaseObservation(
        observation({ merged_pull_requests: [{ number: 7, merge_sha: "short" }] }),
      ),
    /merged_pull_requests\[0\] is malformed/,
  );
});

test("re-run equality ignores provenance and reports a moved boundary", () => {
  const first = verifyRelease(input()).record;
  const second = verifyRelease(
    input({
      observationRef: {
        path: "/store/observations/y.json",
        sha256: "8".repeat(64),
      },
      observation: observation({ collected_at: "2026-02-01T00:00:00.000Z" }),
    }),
  ).record;
  assert.deepEqual(compareReleaseRecords(first, second), {
    status: "EQUAL",
    message: "the existing record agrees with this run",
  });
  const backfilled = verifyRelease(
    input({
      observation: observation({
        range: { kind: "TAG", tag: "v1.0.5", target_sha: PREVIOUS_TAG_SHA },
      }),
    }),
  ).record;
  assert.equal(compareReleaseRecords(first, backfilled).status, "SUPERSEDED");
  const diverged = { ...first, tag: { ...first.tag, target_sha: "7".repeat(40) } };
  assert.equal(compareReleaseRecords(first, diverged).status, "DIVERGED");
});
