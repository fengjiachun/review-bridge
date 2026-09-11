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
import { isolatedGit, isSshRemote, sshAcceptedHostKeys, sshTrustsOnFirstUse } from "./isolated-git.mjs";

const USAGE = `Usage: advisory-panel-checkout.mjs <remote-url> <pr-number> <target-branch> <path>

  Clones <remote-url> with --template= and --no-checkout into <path>, which
  must not exist yet and should lie outside every authoring tree; fetches
  '+refs/heads/<target-branch>:refs/review-bridge/<pr-number>/base' and
  '+pull/<pr-number>/head:refs/review-bridge/<pr-number>/head'; checks out
  refs/review-bridge/<pr-number>/head detached; prints the checkout path, the
  base, the head, and the merge base as full SHAs.

  Every git call runs isolated from the operator's global and system
  configuration, HOME, hooks, and GIT_* environment. ssh is pinned the same
  way and does not follow the operator's home: no ssh configuration is read
  (-F /dev/null), no key on disk is offered (a lone IdentityFile=/dev/null
  replaces the default ~/.ssh/id_* list), the agent named by SSH_AUTH_SOCK is
  the one credential source (IdentityAgent, with IdentitiesOnly left off so
  the agent's keys are actually presented), and ProxyCommand and ProxyJump are off,
  so no configuration can make ssh run a command. Host keys are checked
  against the operator's ~/.ssh/known_hosts, or taken on first use when that
  file does not exist, which is stated in the output. No credential helper is
  consulted, so an https remote must be reachable without one, and an ssh
  remote without an agent is refused. A host key taken on first use is kept
  for the run, so every call of one checkout checks the same key, and the
  fingerprint is printed; it is not kept across runs.  Fails closed, exit 2,
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
  // Branch-name legality is git's to decide (`release@v1` and `release+1`
  // are legal); the script refuses only what git's own check would or what
  // would break the refspec: a leading '-' (an option), a ':', whitespace, or
  // a control character.
  if (target.startsWith("-") || /[:\s\x00-\x1f\x7f]/.test(target)) return fail(`invalid target branch name: ${target}`);
  const legal = isolatedGit(["check-ref-format", "--branch", target]);
  if (legal.error || legal.status !== 0) return fail(`invalid target branch name: ${target}`);
  const checkout = path.resolve(given);
  if (fs.existsSync(checkout)) return fail(`${checkout} already exists; the panel checkout must be a fresh clone`);
  if (isSshRemote(remote)) {
    if (!process.env.SSH_AUTH_SOCK) {
      return fail(`${remote} is an ssh remote and no ssh agent is available; the agent is the only credential source this script supports`);
    }
    if (sshTrustsOnFirstUse()) {
      process.stdout.write(
        "host key trusted on first use (no ~/.ssh/known_hosts): accepted for this run only, not kept — create ~/.ssh/known_hosts to verify the host across runs\n",
      );
    }
  }
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
  // The source is written out in full: a bare `<target>` would resolve by
  // git's ref search, and a branch legitimately named `refs/heads/main` would
  // then lose to the ordinary `main`.
  if (git("fetch", ["-C", checkout, "fetch", "--quiet", "origin", `+refs/heads/${target}:${base}`, `+pull/${prNumber}/head:${head}`]) === null) return;
  if (git("checkout", ["-C", checkout, "checkout", "--quiet", "--detach", head]) === null) return;
  const baseSha = git("rev-parse", ["-C", checkout, "rev-parse", "--verify", `${base}^{commit}`]);
  const headSha = git("rev-parse", ["-C", checkout, "rev-parse", "--verify", `${head}^{commit}`]);
  const mergeBase = git("merge-base", ["-C", checkout, "merge-base", base, head]);
  if (baseSha === null || headSha === null || mergeBase === null) return;
  for (const fingerprint of sshAcceptedHostKeys()) process.stdout.write(`accepted host key ${fingerprint}\n`);
  process.stdout.write(`checkout ${checkout}\nbase ${baseSha}\nhead ${headSha}\nmerge-base ${mergeBase}\n`);
}

main();
