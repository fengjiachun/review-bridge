#!/usr/bin/env node
// The panel checkout for an advisory review, made the one way the workflow
// skill describes: a `--template=` clone of the pull request's repository
// outside every authoring tree, the target branch and the pull request head
// fetched into refs of this flow's own, the head checked out detached, the
// merge base computed from those refs. Every git call runs in the isolated
// environment the container launcher uses for its own host git, so nothing
// in the pull request's tree — a `.gitattributes` naming a filter — can run
// anything on the host while the checkout is made.
import fs from "node:fs";
import path from "node:path";
import { isolatedGit } from "./isolated-git.mjs";

const USAGE = `Usage: advisory-panel-checkout.mjs <remote-url> <pr-number> <target-branch> <path>

  Clones <remote-url> with --template= and --no-checkout into <path>, which
  must not exist yet and should lie outside every authoring tree; fetches
  '+<target-branch>:refs/review-bridge/<pr-number>/base' and
  '+pull/<pr-number>/head:refs/review-bridge/<pr-number>/head'; checks out
  refs/review-bridge/<pr-number>/head detached; prints the checkout path, the
  base, the head, and the merge base as full SHAs.

  Every git call runs isolated from the operator's global and system
  configuration, HOME, hooks, and GIT_* environment (the ssh agent socket is
  passed through; no credential helper is consulted). Fails closed, exit 2,
  on any git failure.
`;

function fail(message) {
  process.stderr.write(`advisory-panel-checkout: ${message}\n`);
  process.exitCode = 2;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.length !== 4) {
    fail(`expected <remote-url> <pr-number> <target-branch> <path>\n${USAGE}`);
    return;
  }
  const [remote, prNumber, target, given] = args;
  if (!/^[1-9][0-9]*$/.test(prNumber)) return fail(`invalid pull request number: ${prNumber}`);
  if (!/^[A-Za-z0-9._\/-]+$/.test(target) || target.startsWith("-")) return fail(`invalid target branch name: ${target}`);
  const checkout = path.resolve(given);
  if (fs.existsSync(checkout)) return fail(`${checkout} already exists; the panel checkout must be a fresh clone`);
  const base = `refs/review-bridge/${prNumber}/base`;
  const head = `refs/review-bridge/${prNumber}/head`;
  const git = (label, cmd) => {
    const result = isolatedGit(cmd);
    if (result.error || result.status !== 0) {
      fail(`${label} failed: ${result.error?.message ?? result.stderr.trim()}`);
      return null;
    }
    return result.stdout.trim();
  };
  if (git("clone", ["clone", "--quiet", "--template=", "--no-checkout", "--", remote, checkout]) === null) return;
  if (git("fetch", ["-C", checkout, "fetch", "--quiet", "origin", `+${target}:${base}`, `+pull/${prNumber}/head:${head}`]) === null) return;
  if (git("checkout", ["-C", checkout, "checkout", "--quiet", "--detach", head]) === null) return;
  const baseSha = git("rev-parse", ["-C", checkout, "rev-parse", "--verify", `${base}^{commit}`]);
  const headSha = git("rev-parse", ["-C", checkout, "rev-parse", "--verify", `${head}^{commit}`]);
  const mergeBase = git("merge-base", ["-C", checkout, "merge-base", base, head]);
  if (baseSha === null || headSha === null || mergeBase === null) return;
  process.stdout.write(`checkout ${checkout}\nbase ${baseSha}\nhead ${headSha}\nmerge-base ${mergeBase}\n`);
}

main();
