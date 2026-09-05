# Contributing

Review Bridge accepts focused bug fixes, tests, documentation improvements, and
small workflow changes.

1. Create a topic branch from the current `main`.
2. Keep changes limited to one behavior or release concern.
3. Run:

   ```bash
   npm ci
   npm test
   npm audit --omit=dev
   npm run build
   npm run verify:build
   ```

4. Open a pull request describing the behavior change and verification.
5. Add a CHANGELOG bullet under `## Unreleased` naming your pull request, for
   example `(#63)`. A merge that deliberately stays out of the prose still
   belongs in the entry, under an `### Internal` heading. Release verification
   compares the entry's pull-request numbers against the merges GitHub reports
   for the range in both directions, so an unnamed merge and a claim with no
   merge behind it each fail by name.

   The CHANGELOG header states the first version this applies to. Entries
   older than it are reported as `pre-convention` and are not reconciled;
   moving the marker is a visible edit to the file it governs.

Do not include proprietary source snapshots, Review Bridge store contents,
credentials, or raw model-review transcripts in issues or pull requests. Report
security issues privately as described in [SECURITY.md](SECURITY.md).

## Verifying a release

Before tagging, from the release pull request, naming its own number:

```bash
node scripts/verify-release.mjs --pre --release-pull-request <n>
```

The release entry claims the release pull request itself, so that tagging its
merge commit puts that merge inside the range the entry describes and no later
release inherits the line. That merge does not exist during pre-flight, so the
flag exempts that one number from `UNFOUND_CLAIM` and reports it back as
`release_pull_request`. Every other unfound claim is still reported, and the
final phase accepts no exemption: by then the merge exists, and a claim still
unfound is the tag sitting on the wrong commit.

After the tag and release are published, from a clean checkout of the tag:

```bash
npm run build
node scripts/collect-release-observation.mjs --version <x.y.z>
node scripts/verify-release.mjs --final --observation <path> --build-dir dist/review-bridge-v<x.y.z>
```

The final phase needs the authenticated GitHub CLI and writes one evidence
record per version into the private store. Both phases read only; tagging,
publishing, and merging stay human work.

The collector walks the release range to the commit total GitHub reports and
refuses a walk that cannot account for it, so a range it cannot read whole is
a loud failure rather than a short observation.
