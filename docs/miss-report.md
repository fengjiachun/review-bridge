# Pair remote review threads with local reviews

`scripts/miss-report.mjs` answers one question about a pull request: for each
review thread someone other than its author opened on GitHub, which local
reviews had already looked at that head? Run it with Node from a checkout of
this repository; it is not part of the packaged client runtimes.

```bash
node scripts/miss-report.mjs GreptimeTeam/greptimedb 10342 --repository ~/code/greptimedb
node scripts/miss-report.mjs owner/name 42 --repository /path/to/checkout --json > corpus.json
node scripts/miss-report.mjs owner/name 42 --repository /path/to/checkout --store /tmp/review-fixtures
```

It needs the authenticated GitHub CLI and reads the pull request and its
review comments through `gh api`. `--repository` is a local checkout of the
named repository. `--store` overrides `REVIEW_BRIDGE_HOME`; without either, the
command reads the same default store as the servers. It writes nothing: no
ledger, record, index, or lock. The output is a projection for analysis, not
evidence, and no gate reads it.

## What is listed

A thread is a review comment that is not a reply. Threads opened by the pull
request's author are left out; replies are kept with their thread. The command
stops with an error when the number of comments it fetched differs from the
count the pull request reports.

Each thread is paired by the commit it was written against (GitHub's
`original_commit_id`), and its location is the line at that commit. A local
review is listed for a thread in one of two ways:

- **Match.** One of the review's rounds captured that head, and the review's
  recorded `repository_path` belongs to the same Git repository as
  `--repository`, linked worktrees included.
- **Repository unverified.** A round captured that head, but the recorded
  `repository_path` can no longer be read as a Git repository, typically a
  worktree removed after the merge. The review is listed apart and marked,
  because its repository cannot be compared.

A review for that head recorded in a different repository is not listed. When
neither kind exists the thread reads `no local ledger for this head`.

## Output

The default output is a Markdown table: thread link, author, location, the
head's first ten characters, and each listed review with its status and
finding count. Review directories whose `review.json` cannot be parsed or has no
rounds are named below the table.

`--json` prints the corpus instead: the pull request, every thread with its
full body and replies, and for each listed review its id, status, finding
count, and the snapshot hash of the last round that captured the head.
Matches are under `matches` and unverified reviews under
`unverified_matches`.

The command pairs threads with reviews by head only. It does not compare a
thread with a review's findings, so a listed review means that head was
reviewed locally, not that the thread's point was raised there.
