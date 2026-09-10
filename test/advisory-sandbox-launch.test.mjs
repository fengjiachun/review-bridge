import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadReview, prepareReview } from "../src/core.mjs";
import { commit, fixture as repositoryFixture } from "./helpers/repository-fixture";

// The advisory sandbox launcher is packaged beside the other plugin scripts
// and imports the server the same way, so it is exercised from a
// plugin-shaped copy: scripts/ holding the launcher, server/ linking to src/.
// Its --dry-run validates every input and prints the docker commands without
// touching Docker, which is what makes the mount table and the launch line
// assertable in CI.

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const launcherSource = path.join(
  projectRoot,
  "templates",
  "codex-plugin",
  "scripts",
  "advisory-sandbox-launch.mjs",
);
const REVIEW_ID = "rb-2026-09-10T000000-000Z-0badcafe";

async function fixture(t, { ledger = {}, checkoutName = "panel/review-bridge", realReview = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-advisory-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, "plugin");
  await fsp.mkdir(path.join(plugin, "scripts"), { recursive: true });
  await fsp.copyFile(launcherSource, path.join(plugin, "scripts", "advisory-sandbox-launch.mjs"));
  await fsp.symlink(path.join(projectRoot, "src"), path.join(plugin, "server"));

  const home = path.join(root, "home");
  const marketplace = path.join(home, "Runtime", "codex-marketplace");
  const pluginSource = path.join(marketplace, "plugins", "review-bridge");
  let checkout = path.join(home, checkoutName);
  let store = path.join(root, "store");
  let reviewId = REVIEW_ID;
  if (realReview) {
    // A ledger the server itself wrote, over a real repository, so the fake
    // reviewer below can move it with the server's own submit.
    const repo = await repositoryFixture();
    t.after(() => fsp.rm(repo.root, { recursive: true, force: true }));
    await commit(repo.repository, "export const value = 2;\n");
    const prepared = await prepareReview(repo.store, {
      repositoryPath: repo.repository,
      baseRef: repo.baseSha,
      requirement: "Author's claim (unverified), PR #1: \"change\"",
      implementationScope: "advisory panel member",
      forceFullReview: true,
      reviewerProvider: "CODEX_TASK",
      advisory: true,
    });
    checkout = repo.repository;
    store = repo.store;
    reviewId = prepared.id;
  }
  await fsp.mkdir(path.join(home, ".codex"), { recursive: true });
  await fsp.writeFile(path.join(home, ".codex", "auth.json"), "{}\n");
  await fsp.writeFile(
    path.join(home, ".codex", "config.toml"),
    `model = "x"\n\n[marketplaces.review-bridge-local]\nsource_type = "local"\nsource = "${marketplace}"\n\n[memories]\nuse_memories = true\n`,
  );
  await fsp.mkdir(path.join(marketplace, ".agents", "plugins"), { recursive: true });
  await fsp.writeFile(path.join(marketplace, ".agents", "plugins", "marketplace.json"), "{}\n");
  await fsp.mkdir(path.join(pluginSource, ".codex-plugin"), { recursive: true });
  await fsp.mkdir(path.join(pluginSource, "server"), { recursive: true });
  await fsp.writeFile(
    path.join(pluginSource, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "review-bridge", version: "9.9.9" }),
  );
  await fsp.writeFile(path.join(pluginSource, "server", "server.mjs"), "");
  if (!realReview) {
    await fsp.mkdir(checkout, { recursive: true });
    await fsp.mkdir(path.join(store, "reviews", REVIEW_ID), { recursive: true });
    await fsp.writeFile(
      path.join(store, "reviews", REVIEW_ID, "review.json"),
      JSON.stringify({
        id: REVIEW_ID,
        reviewer_provider: "CODEX_TASK",
        advisory: true,
        status: "WAITING_FOR_REVIEW",
        state_version: 1,
        repository_path: checkout,
        ...ledger,
      }),
    );
  }
  return {
    root,
    plugin,
    launcher: path.join(plugin, "scripts", "advisory-sandbox-launch.mjs"),
    home,
    marketplace,
    pluginSource,
    checkout,
    store,
    reviewId,
    authJson: path.join(home, ".codex", "auth.json"),
  };
}

// A stand-in `docker` on PATH: answers the launcher's version, image, network,
// proxy, log, and cleanup calls, plays the boundary probe back as JSON
// records derived from the probe's own argument, and plays the reviewer by
// moving the staged ledger with the server's own submit — or, when asked,
// by also leaving the kind of trace the copy-back must refuse.
async function fakeDocker(f, { tamper = "" } = {}) {
  const bin = path.join(f.root, "bin");
  await fsp.mkdir(bin, { recursive: true });
  const runner = path.join(bin, "fake-run.mjs");
  await fsp.writeFile(
    runner,
    `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const bind = (dst) => args.map((a) => a.match(new RegExp("^type=bind,src=(.*),dst=" + dst + "(,readonly)?$"))).find(Boolean)?.[1];
if (!args.includes("codex")) {
  const spec = JSON.parse(args[args.length - 1]);
  const out = [];
  for (const p of spec.absent) out.push({ kind: "path", path: p, present: false });
  const chain = [...spec.ancestors, spec.checkout];
  spec.ancestors.forEach((p, i) => out.push({ kind: "ancestor", path: p, children: [path.basename(chain[i + 1])] }));
  out.push({ kind: "checkout-head", value: spawnSync("git", ["-C", spec.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() });
  out.push({ kind: "store-writable", value: true });
  out.push({ kind: "egress", via: "proxy", code: "000", exit: 56 });
  out.push({ kind: "egress", via: "direct", code: "000", exit: 6 });
  out.push({ kind: "codex-version", value: "codex-cli 0.153.4" });
  out.push({ kind: "uid", value: process.getuid() });
  process.stdout.write(out.map((r) => JSON.stringify(r)).join("\\n") + "\\n");
} else {
  const staged = bind("/store");
  const reviewId = args[args.length - 1].match(/rb-[0-9TZ-]+-[a-f0-9]{8}/)[0];
  const { submitInitialReview } = await import(process.env.FAKE_CORE);
  process.stdout.write("OpenAI Codex v0.153.4\\napproval: granular\\nsandbox: danger-full-access\\nsession id: 00000000-0000-0000-0000-000000000000\\n");
  for (const tool of ["list_pending_reviews", "open_review"]) process.stdout.write("mcp: review-bridge-reviewer/" + tool + " started\\nmcp: review-bridge-reviewer/" + tool + " (completed)\\n");
  const tamper = process.env.FAKE_TAMPER || "";
  if (tamper !== "no-verdict") {
    await submitInitialReview(staged, reviewId, [{ severity: "major", title: "one", explanation: "first" }], "CODEX_TASK");
    process.stdout.write("mcp: review-bridge-reviewer/submit_review started\\nmcp: review-bridge-reviewer/submit_review (completed)\\n");
  }
  const reviewDir = path.join(staged, "reviews", reviewId);
  if (tamper === "outside") fs.writeFileSync(path.join(staged, "other.txt"), "x");
  if (tamper === "extra") fs.writeFileSync(path.join(reviewDir, "notes.txt"), "x");
  if (tamper === "snapshot") fs.appendFileSync(path.join(reviewDir, "rounds", "1", "manifest.json"), "\\n");
  if (tamper === "id") { const l = JSON.parse(fs.readFileSync(path.join(reviewDir, "review.json"), "utf8")); l.advisory = false; fs.writeFileSync(path.join(reviewDir, "review.json"), JSON.stringify(l)); }
  if (tamper === "sibling") { fs.mkdirSync(path.join(staged, "reviews", "rb-2026-01-01T000000-000Z-00000000"), { recursive: true }); fs.writeFileSync(path.join(staged, "reviews", "rb-2026-01-01T000000-000Z-00000000", "review.json"), "{}"); }
}
`,
  );
  await fsp.writeFile(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -e
case "$1 $2" in
  "version --format") echo "28.3.2 linux/arm64" ;;
  "image inspect") exit 0 ;;
  "network create"|"network connect"|"network rm"|"volume rm"|"rm -f") exit 0 ;;
  "logs "*) echo "2026-09-10T00:00:00.000Z listening 3128 allow chatgpt.com,api.openai.com"; echo "2026-09-10T00:00:01.000Z deny connect example.com:443"; echo "2026-09-10T00:00:02.000Z allow connect chatgpt.com:443" ;;
  "run -d") echo 0123456789ab ;;
  "run --rm") exec "\${FAKE_NODE}" "\${FAKE_RUN}" "$@" ;;
  *) echo "fake docker: unexpected $*" >&2; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_NODE: process.execPath,
    FAKE_RUN: runner,
    FAKE_CORE: path.join(f.plugin, "server", "core.mjs"),
    FAKE_TAMPER: tamper,
  };
}

function launch(f, args, env = {}) {
  return spawnSync(process.execPath, [f.launcher, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: f.home,
      CODEX_HOME: undefined,
      REVIEW_BRIDGE_HOME: f.store,
      ...env,
    },
  });
}

test("--help states the launch, the mounts, the egress allowlist, and the residual", async (t) => {
  const f = await fixture(t);
  const result = launch(f, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: advisory-sandbox-launch\.mjs --review-id <id>/);
  assert.match(result.stdout, /only launch an\s+advisory review takes/);
  assert.match(result.stdout, /Fails closed, exit 2, when Docker is unavailable or any mount source is\s+missing/);
  assert.match(result.stdout, /The host store is never mounted/);
  assert.match(result.stdout, /the validated verdict was copied back to the host store/);
  assert.match(result.stdout, /auth\.json is bind-mounted read-only and never copied\s+into an image layer/);
  assert.match(result.stdout, /admits chatgpt\.com and api\.openai\.com/);
  assert.match(result.stdout, /Residual: the one host secret inside the container is auth\.json/);
});

test("--dry-run prints the mount table and the container launch without Docker", async (t) => {
  const f = await fixture(t);
  const result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"], { PATH: "" });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  // Inputs derived from the ledger and the operator's config, not retyped.
  assert.match(out, new RegExp(`checkout ${f.checkout} \\(read-only, at its recorded path\\)`));
  assert.match(out, new RegExp(`marketplace ${f.marketplace} \\(plugin 9\\.9\\.9, read-only\\)`));
  // The mount table: read-only unless the reviewer must write it.
  const bind = (source, target, readonly) =>
    new RegExp(`--mount type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}(?: |'? )`);
  assert.match(out, bind(f.authJson, "/codex-home/auth\\.json", true));
  assert.match(out, bind(f.marketplace, "/marketplace", true));
  assert.match(
    out,
    bind(f.pluginSource, "/codex-home/plugins/cache/review-bridge-local/review-bridge/9\\.9\\.9", true),
  );
  assert.match(out, bind(f.checkout, f.checkout, true));
  // The host store is never mounted; a staged copy of the one review is.
  assert.doesNotMatch(out, new RegExp(`src=${f.store}[,/]`));
  assert.match(out, /store,dst=\/store'? /);
  assert.match(out, new RegExp(`store ${f.store} \\(never mounted; the review is staged under`));
  assert.match(out, /config\.toml,dst=\/codex-home\/config\.toml,readonly'? /);
  // CODEX_HOME is a volume and the working directory a tmpfs, not host
  // directories; the six binds above are the whole of the host inside.
  assert.match(out, /--mount type=volume,src=review-bridge-advisory-\S+-home,dst=\/codex-home /);
  assert.match(out, /--tmpfs \/work:rw,mode=1777/);
  const codexLine = out.split("\n").filter((line) => line.includes(" codex exec ")).pop();
  assert.equal((codexLine.match(/ --mount '?type=bind,/g) ?? []).length, 6);
  assert.doesNotMatch(codexLine, / -v /);
  assert.match(out, /cp -a \/codex-home\/sessions \/out\/sessions/);
  assert.match(out, /docker volume rm review-bridge-advisory-\S+-home/);
  // The container is the sandbox: danger-full-access inside, default
  // confinement outside, isolated CODEX_HOME, egress through the sidecar.
  assert.match(out, /codex exec --skip-git-repo-check --sandbox danger-full-access/);
  assert.doesNotMatch(out, /--security-opt/);
  assert.doesNotMatch(out, /--privileged/);
  assert.doesNotMatch(out, /dangerously-bypass/);
  assert.match(out, /docker network create --internal review-bridge-advisory-/);
  assert.match(out, /--network-alias egress .* --egress-proxy/);
  assert.match(out, /docker network connect bridge review-bridge-advisory-\S+-egress/);
  assert.match(out, /-e HTTPS_PROXY=http:\/\/egress:3128/);
  assert.match(out, /-e CODEX_HOME=\/codex-home/);
  assert.match(out, /\/codex-home\/config\.toml:\n(?:.*\n)*? {2}\[plugins\."review-bridge@review-bridge-local"\]\n {2}enabled = true/);
  assert.match(out, /source = "\/marketplace"/);
  // The launch line: guardian, granular refusal, memories off, author server
  // disabled, reviewer server restated at its container path with the store's
  // container path, the request naming the review id, stdin closed.
  assert.match(out, /-c 'approvals_reviewer="guardian_subagent"'/);
  assert.match(
    out,
    /-c 'approval_policy=\{granular=\{rules=false,sandbox_approval=false,skill_approval=false,request_permissions=false,mcp_elicitations=false\}\}'/,
  );
  assert.match(out, /-c memories\.use_memories=false -c memories\.generate_memories=false/);
  assert.match(out, /-c 'mcp_servers\.review-bridge-author\.command="node"' -c mcp_servers\.review-bridge-author\.enabled=false/);
  assert.match(
    out,
    /-c 'mcp_servers\.review-bridge-reviewer\.args=\["\/codex-home\/plugins\/cache\/review-bridge-local\/review-bridge\/9\.9\.9\/server\/server\.mjs","--role","reviewer","--reviewer-provider","CODEX_TASK"\]'/,
  );
  assert.match(out, /-c 'mcp_servers\.review-bridge-reviewer\.env\.REVIEW_BRIDGE_HOME="\/store"'/);
  assert.match(
    out,
    new RegExp(
      `'Independently review Review Bridge task \`${REVIEW_ID}\` using the packaged Review Bridge reviewer skill\\. Require \`reviewer_provider: CODEX_TASK\`, follow the review strategy, and submit every actionable finding\\.'`,
    ),
  );
  assert.match(out, /codex stdin is closed/);
  // The boundary probe is a node program handed its paths as one JSON
  // argument: the host home and the credential paths are in it, and so is
  // the egress check.
  assert.match(out, / node -e /);
  const spec = probeSpec(out);
  assert.ok(spec.absent.includes(`${f.home}/.codex/auth.json`));
  assert.ok(spec.absent.includes("/root/.ssh"));
  assert.ok(spec.absent.includes(f.store));
  assert.equal(spec.checkout, f.checkout);
  assert.equal(spec.store, "/store");
  assert.match(out, /https:\/\/example\.com/);
  assert.doesNotMatch(out, /if \[ -e /);
});

// The probe's JSON argument, as the dry run prints it (single-quoted, after
// the program text).
function probeSpec(out) {
  return JSON.parse(out.match(/'(\{"absent":[^\n]*\})'/)[1]);
}

test("a checkout path with a space stays one path through the mount and the probe", async (t) => {
  const f = await fixture(t, { checkoutName: "My Projects/review bridge" });
  const result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"], { PATH: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`--mount 'type=bind,src=${f.checkout},dst=${f.checkout},readonly'`),
  );
  const spec = probeSpec(result.stdout);
  assert.equal(spec.checkout, f.checkout);
  assert.ok(spec.ancestors.includes(path.dirname(f.checkout)));
});

test("with a stand-in docker the launcher stages the review, runs, validates, and copies the verdict back", async (t) => {
  const f = await fixture(t, { realReview: true, checkoutName: "My Projects/review bridge" });
  const env = await fakeDocker(f);
  const result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /criterion 1 MCP calls completed inside the container: PASS — list_pending_reviews 1\/1, open_review 1\/1, submit_review 1\/1/);
  assert.match(result.stdout, /criterion 2 host filesystem absent: PASS/);
  assert.match(
    result.stdout,
    /criterion 3 validated verdict copied back to the host store: PASS — copy-back applied under the review's state lock — status WAITING_FOR_REVIEW → REVIEW_SUBMITTED, state_version 1 → 2, findings 1, 0 round file\(s\) added/,
  );
  assert.match(result.stdout, /egress: example\.com via proxy → 000 curl-exit=56, without proxy → 000 curl-exit=6; proxy log: allow chatgpt\.com:443 ×1, deny example\.com:443 ×1/);
  const ledger = await loadReview(f.store, f.reviewId);
  assert.equal(ledger.status, "REVIEW_SUBMITTED");
  assert.equal(ledger.state_version, 2);
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.advisory, true);
  // The scratch directory named in the output holds the staged copy.
  const scratch = result.stdout.match(/^scratch (.+)$/m)[1];
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  assert.ok(await fsp.stat(path.join(scratch, "store", "reviews", f.reviewId, "review.json")));
});

test("the copy-back refuses a staged store that carries anything but the review's own transition, and leaves the host store unwritten", async (t) => {
  for (const [tamper, reason] of [
    ["outside", /unexpected file outside the staged review: other\.txt/],
    ["sibling", /unexpected file outside the staged review: reviews\/rb-2026-01-01T000000-000Z-00000000\/review\.json/],
    ["extra", /an unexpected file was created in the staged review: notes\.txt/],
    ["snapshot", /an existing snapshot file was modified: rounds\/1\/manifest\.json/],
    ["id", /the staged ledger's advisory changed to false/],
    ["no-verdict", /nothing to copy back — the staged ledger is unchanged/],
  ]) {
    const f = await fixture(t, { realReview: true });
    const env = await fakeDocker(f, { tamper });
    const result = launch(f, ["--review-id", f.reviewId], env);
    assert.equal(result.status, 1, `${tamper}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: FAIL — /, tamper);
    assert.match(result.stdout, reason, tamper);
    const ledger = await loadReview(f.store, f.reviewId);
    assert.equal(ledger.status, "WAITING_FOR_REVIEW", tamper);
    assert.equal(ledger.state_version, 1, tamper);
    const scratch = result.stdout.match(/^scratch (.+)$/m)[1];
    t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
    if (tamper !== "no-verdict") {
      assert.match(result.stdout, new RegExp(`staged copy kept at ${scratch}/store/reviews/${f.reviewId}`), tamper);
    }
  }
});

test("the launcher refuses a ledger that is not an advisory CODEX_TASK review waiting for review", async (t) => {
  for (const [ledger, message] of [
    [{ advisory: false }, /is not an advisory review; a review of the operator's own changes takes the host launch/],
    [{ reviewer_provider: "HERMES" }, /is bound to HERMES, not CODEX_TASK/],
    [{ status: "CLEAN" }, /is CLEAN, not WAITING_FOR_REVIEW/],
  ]) {
    const f = await fixture(t, { ledger });
    const result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, message);
  }
});

test("the launcher fails closed on a missing mount source, naming it", async (t) => {
  const f = await fixture(t);
  await fsp.rm(f.authJson);
  let result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(`operator's codex auth\\.json is missing: ${f.authJson}`));

  const g = await fixture(t);
  await fsp.rm(g.checkout, { recursive: true });
  result = launch(g, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(`author checkout the ledger records is missing: ${g.checkout}`));

  const h = await fixture(t);
  result = launch(h, ["--review-id", "rb-2026-09-10T000000-000Z-deadbeef", "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read the review ledger .*deadbeef\/review\.json/);

  const i = await fixture(t);
  await fsp.writeFile(path.join(i.home, ".codex", "config.toml"), "model = \"x\"\n");
  result = launch(i, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no --marketplace given and \[marketplaces\.review-bridge-local\] names no source/);
  result = launch(i, ["--review-id", REVIEW_ID, "--marketplace", i.marketplace, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
});

test("the launcher fails closed when Docker is unavailable", async (t) => {
  const f = await fixture(t);
  const result = launch(f, ["--review-id", REVIEW_ID], { PATH: "" });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /Docker is not available .*; the advisory member has no other launch/);
});

test("the launcher source keeps the container's default confinement and the read-only credential", async () => {
  const source = await fsp.readFile(launcherSource, "utf8");
  assert.doesNotMatch(source, /security-opt|seccomp=unconfined|apparmor=unconfined|--privileged/);
  assert.doesNotMatch(source, /dangerously-bypass-approvals-and-sandbox/);
  assert.match(source, /"--sandbox",\n\s*"danger-full-access"/);
  // auth.json is a bind mount, never a COPY into the image.
  assert.doesNotMatch(source, /COPY|ADD /);
  assert.match(source, /\[inputs\.authJson, `\$\{CONTAINER_CODEX_HOME\}\/auth\.json`, "ro"\]/);
  assert.match(source, /npm install -g @openai\/codex@\$\{CODEX_VERSION\}/);
  assert.match(source, /const CODEX_VERSION = "0\.153\.4"/);
  assert.match(source, /const EGRESS_ALLOW = \["chatgpt\.com", "api\.openai\.com"\]/);
});
