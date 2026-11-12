import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMissReport,
  renderMissReportMarkdown,
} from "../scripts/miss-report.mjs";
import { git } from "./helpers/repository-fixture";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_D = "d".repeat(40);

async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-miss-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = {};
  for (const name of ["repo", "other"]) {
    paths[name] = path.join(root, name);
    await fsp.mkdir(paths[name]);
    git(paths[name], "init", "-b", "main");
  }
  paths.store = path.join(root, "store");
  paths.gone = path.join(root, "gone");
  return paths;
}

async function writeReview(store, id, repositoryPath, heads) {
  const directory = path.join(store, "reviews", id);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(
    path.join(directory, "review.json"),
    JSON.stringify({
      id,
      repository_path: repositoryPath,
      status: "CLEAN",
      rounds: heads.map((head_sha, index) => ({
        round: index + 1,
        head_sha,
        snapshot_hash: `hash-${id}-${index + 1}`,
      })),
      findings: [{ id: "F1" }],
    }),
  );
}

function comment(id, login, head, extra = {}) {
  return {
    id,
    html_url: `https://example.invalid/pull/7#discussion_r${id}`,
    user: { login },
    path: "src/a|b.js",
    line: 20,
    original_line: 12,
    original_commit_id: head,
    body: `body ${id}`,
    ...extra,
  };
}

const run = (repositoryPath, storeRoot, api) =>
  buildMissReport({
    repository: "owner/name",
    pullRequest: 7,
    repositoryPath,
    storeRoot,
    api,
  });

function fakeApi(pages, reviewComments) {
  const calls = [];
  const api = (endpoint, options = {}) => {
    calls.push([endpoint, options.paginate === true]);
    return endpoint.includes("/comments")
      ? pages
      : {
          number: 7,
          html_url: "https://example.invalid/pull/7",
          user: { login: "author" },
          head: { sha: HEAD_B },
          review_comments: reviewComments,
        };
  };
  return { api, calls };
}

test("pairs threads across pages with the ledgers for their heads", async (t) => {
  const { repo, other, store, gone } = await setup(t);
  await writeReview(store, "rb-match", repo, [HEAD_A, HEAD_A]);
  await writeReview(store, "rb-other-repository", other, [HEAD_A]);
  await writeReview(store, "rb-gone", gone, [HEAD_A]);
  await writeReview(store, "rb-gone-only", gone, [HEAD_D]);
  await writeReview(store, "rb-other-head", repo, ["c".repeat(40)]);
  await fsp.mkdir(path.join(store, "reviews", "rb-publication-only"));
  await fsp.mkdir(path.join(store, "reviews", "rb-damaged"));
  await fsp.writeFile(
    path.join(store, "reviews", "rb-damaged", "review.json"),
    "{",
  );

  const { api, calls } = fakeApi(
    [
      [
        comment(1, "reviewer", HEAD_A),
        comment(2, "author", HEAD_A),
        comment(3, "author", HEAD_A, { in_reply_to_id: 1 }),
      ],
      [
        comment(4, "reviewer", HEAD_B, { line: null, original_line: 30 }),
        comment(5, "reviewer", HEAD_A, { in_reply_to_id: 1 }),
        comment(6, "reviewer", HEAD_D, { path: "src/`x`.py" }),
      ],
    ],
    6,
  );
  const report = await run(repo, store, api);

  assert.deepEqual(calls, [
    ["repos/owner/name/pulls/7", false],
    ["repos/owner/name/pulls/7/comments?per_page=100", true],
  ]);
  assert.deepEqual(
    report.threads.map((thread) => [thread.id, thread.line, thread.head]),
    [[1, 12, HEAD_A], [4, 30, HEAD_B], [6, 12, HEAD_D]],
  );
  assert.deepEqual(
    report.threads[0].replies.map((reply) => [reply.id, reply.author]),
    [[3, "author"], [5, "reviewer"]],
  );
  const entry = (review_id, round) => ({
    review_id,
    status: "CLEAN",
    findings: 1,
    snapshot_hash: `hash-${review_id}-${round}`,
  });
  assert.deepEqual(report.threads[0].matches, [entry("rb-match", 2)]);
  assert.deepEqual(report.threads[0].unverified_matches, [entry("rb-gone", 1)]);
  assert.deepEqual(report.threads[1].unverified_matches, []);
  assert.deepEqual(report.threads[2].matches, []);
  assert.deepEqual(report.threads[2].unverified_matches, [
    entry("rb-gone-only", 1),
  ]);
  assert.deepEqual(report.skipped_reviews, ["rb-damaged"]);

  const markdown = renderMissReportMarkdown(report);
  assert.match(markdown, /^3 review threads not opened/m);
  assert.match(
    markdown,
    /\| \[1\]\(https:\/\/example\.invalid\/pull\/7#discussion_r1\) \| reviewer \| `src\/a\\\|b\.js:12` \| `aaaaaaaaaa` \| `rb-match` \(CLEAN, 1\)<br>`rb-gone` \(CLEAN, 1, repository unverified\) \|/,
  );
  assert.match(
    markdown,
    /\| reviewer \| `src\/a\\\|b\.js:30` \| `bbbbbbbbbb` \| no local ledger for this head \|/,
  );
  assert.match(
    markdown,
    /\| `` src\/`x`\.py:12 `` \| `dddddddddd` \| `rb-gone-only` \(CLEAN, 1, repository unverified\) \|/,
  );
  assert.equal(markdown.match(/no local ledger/g).length, 1);
  assert.match(markdown, /Skipped 1 unreadable review ledgers: rb-damaged\./);
});

test("refuses a fetch that does not account for every review comment", async (t) => {
  const { repo, store } = await setup(t);
  const { api } = fakeApi([[comment(1, "reviewer", HEAD_A)]], 2);
  await assert.rejects(
    run(repo, store, api),
    /fetched 1 review comments but the pull request reports 2/,
  );
});

test("lists threads as unmatched when the store holds no reviews", async (t) => {
  const { repo, store } = await setup(t);
  const { api } = fakeApi([[comment(1, "reviewer", HEAD_A)]], 1);
  const report = await run(repo, store, api);
  assert.deepEqual(report.threads.map((thread) => thread.matches), [[]]);
  assert.match(renderMissReportMarkdown(report), /no local ledger for this head/);
  await assert.rejects(fsp.stat(store), { code: "ENOENT" });
});
