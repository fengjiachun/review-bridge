import { sha256 } from "../../src/storage.mjs";
import { RELEASE_OBSERVATION_SCHEMA } from "../../scripts/release-evidence.mjs";

export const TAG_OBJECT_SHA = "a".repeat(40);
export const TAG_TARGET_SHA = "b".repeat(40);
export const PREVIOUS_TAG_SHA = "c".repeat(40);
export const MERGE_SHA = "d".repeat(40);
export const FIRST_PARENT_SHA = "e".repeat(40);
export const ATTESTED_HEAD_SHA = "f".repeat(40);
export const ASSET_DIGEST = "1".repeat(64);
export const MANIFEST = `${ASSET_DIGEST}  review-bridge-source-v1.1.0.zip\n`;

export function changelog({
  cutoff = "1.0.0",
  entry = "- A shipped thing (#7)",
} = {}) {
  return `# Changelog

Pull-request references required from: ${cutoff}

## 1.1.0 - 2026-01-02

### Added

${entry}

## 1.0.0 - 2026-01-01

### Added

- The first thing
`;
}

export function files({
  version = "1.1.0",
  text = changelog(),
  ...overrides
} = {}) {
  const series = version.split(".").slice(0, 2).join(".");
  return {
    "package.json": JSON.stringify({ version }),
    "CHANGELOG.md": text,
    "README.md": `Install review-bridge v${version}.`,
    "SECURITY.md": `Only the latest \`${series}.x\` release receives fixes.`,
    "templates/codex-plugin/.codex-plugin/plugin.json": JSON.stringify({
      version,
    }),
    "templates/claude-extension/manifest.json": JSON.stringify({ version }),
    ...overrides,
  };
}

export function observation(overrides = {}) {
  return {
    schema: RELEASE_OBSERVATION_SCHEMA,
    collected_at: "2026-01-03T00:00:00.000Z",
    repository: { id: 42, full_name: "owner/repo" },
    version: "1.1.0",
    default_branch: "main",
    tag: {
      name: "v1.1.0",
      exists: true,
      object_sha: TAG_OBJECT_SHA,
      target_sha: TAG_TARGET_SHA,
    },
    tag_reachable_from_default_branch: true,
    range: { kind: "TAG", tag: "v1.0.0", target_sha: PREVIOUS_TAG_SHA },
    merged_pull_requests: [
      {
        number: 7,
        merge_sha: MERGE_SHA,
        merge_parents: [FIRST_PARENT_SHA, ATTESTED_HEAD_SHA],
      },
    ],
    release: {
      exists: true,
      id: 1,
      published_at: "2026-01-02T00:00:00.000Z",
      checksum_manifest_text: MANIFEST,
      assets: [
        {
          name: "SHA256SUMS.txt",
          size: MANIFEST.length,
          sha256: sha256(MANIFEST),
        },
        {
          name: "review-bridge-source-v1.1.0.zip",
          size: 10,
          sha256: ASSET_DIGEST,
        },
      ],
    },
    ...overrides,
  };
}

export function verificationInput(overrides = {}) {
  const collected = overrides.observation ?? observation();
  return {
    phase: "FINAL",
    version: "1.1.0",
    files: files(),
    cutoff: "1.0.0",
    previousVersion: "1.0.0",
    mergedPullRequests: collected.merged_pull_requests ?? [],
    localManifest: MANIFEST,
    attestations: {},
    observationRef: {
      path: "/store/observations/x.json",
      sha256: "9".repeat(64),
    },
    verifierVersion: "1.1.0",
    ...overrides,
    observation: collected,
  };
}
