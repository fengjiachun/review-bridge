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

Do not include proprietary source snapshots, Review Bridge store contents,
credentials, or raw model-review transcripts in issues or pull requests. Report
security issues privately as described in [SECURITY.md](SECURITY.md).
