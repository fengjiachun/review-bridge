#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The only launch form for an advisory CODEX_TASK review. The container is the
// read boundary: nothing from the host exists inside it except the mounts
// listed in mountTable(), so an outside author's diff cannot steer the
// reviewer into reading host credentials — the paths are absent, not denied.
// Inside the container the reviewer runs with `--sandbox danger-full-access`
// on purpose: Codex's nested bubblewrap does not start under Docker's default
// seccomp/apparmor confinement, and relaxing that confinement to fit a second
// sandbox inside would weaken the one boundary that matters. Egress is routed
// through a sidecar proxy that admits only the model endpoints, so the one
// host secret inside (auth.json) has nowhere else to go.

const CODEX_VERSION = "0.153.4";
const BASE_IMAGE = "node:22.22.0-bookworm";
const MARKETPLACE_NAME = "review-bridge-local";
const PLUGIN_NAME = "review-bridge";
const AUTHOR_SERVER = "review-bridge-author";
const REVIEWER_SERVER = "review-bridge-reviewer";
const EGRESS_ALLOW = ["chatgpt.com", "api.openai.com"];
const PROXY_PORT = 3128;
const PROXY_ALIAS = "egress";
const CONTAINER_CODEX_HOME = "/codex-home";
const CONTAINER_MARKETPLACE = "/marketplace";
const CONTAINER_STORE = "/store";
const CONTAINER_WORK = "/work";
const CONTAINER_LAUNCHER = "/launcher";
// Host prefixes Docker Desktop does not keep serving: on macOS, files under an
// app-sandbox scratch directory (`/private/tmp/<app>-<uid>/…`) and on a
// removable volume were readable when a container started and returned
// `Permission denied` to a plain read a few seconds later, while the same
// files under the home directory stayed readable for whole runs (measured
// 2026-09-10, Docker Desktop 28.3.2). A checkout, marketplace, store, or
// scratch directory there is refused up front rather than probed or worked
// around.
const UNSERVED_HOST_PREFIXES = ["/private/tmp/", "/Volumes/"];

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(scriptPath), "..");

// /codex-home is created world-writable so the volume mounted there inherits
// that mode and the operator's uid can write it.
const DOCKERFILE = `FROM ${BASE_IMAGE}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ca-certificates procps util-linux \\
 && rm -rf /var/lib/apt/lists/* \\
 && git config --system safe.directory '*' \\
 && mkdir -m 1777 ${CONTAINER_CODEX_HOME} ${CONTAINER_WORK}
RUN npm install -g @openai/codex@${CODEX_VERSION} && codex --version
ENV CODEX_HOME=${CONTAINER_CODEX_HOME}
WORKDIR ${CONTAINER_WORK}
`;
// The tag carries the Dockerfile's hash, so a changed Dockerfile is a new
// image rather than a stale reuse.
const IMAGE = `review-bridge-advisory-codex:${CODEX_VERSION}-${crypto
  .createHash("sha256")
  .update(DOCKERFILE)
  .digest("hex")
  .slice(0, 8)}`;

const USAGE = `Usage: advisory-sandbox-launch.mjs --review-id <id> [--store <path>]
       [--marketplace <path>] [--dry-run]

  Launch the CODEX_TASK reviewer for one advisory review inside a Linux
  container that is the filesystem read boundary. This is the only launch an
  advisory review takes; the host launch in the workflow skill is for the
  operator's own changes and never reviews a third party's pull request.

  --review-id <id>     The advisory review to run. The ledger must be bound to
                       CODEX_TASK, carry advisory: true, and be waiting for
                       review; the author checkout is the ledger's own
                       repository_path and is mounted read-only at that same
                       path, because the reviewer server reads it by recorded
                       path and any other tree would be the wrong bytes.
  --store <path>       The review store (default: REVIEW_BRIDGE_HOME, else the
                       server's default). The host store is never mounted: the
                       one review's directory is staged into a scratch store
                       that is mounted read-write at ${CONTAINER_STORE}, and the
                       verdict is copied back only after validation.
  --marketplace <path> The packaged codex-marketplace directory (default: the
                       source of [marketplaces.${MARKETPLACE_NAME}] in the
                       operator's codex config.toml). Mounted read-only.
  --dry-run            Validate every input and print the docker commands
                       without running any of them. Needs no Docker.

  Fails closed, exit 2, when Docker is unavailable or any mount source is
  missing: the advisory member has no other launch. Also refused, exit 2: a
  checkout, marketplace, store, or scratch directory under /private/tmp/ or
  /Volumes/, because Docker Desktop stops serving files there a few seconds
  into a container; place the panel worktree and store under your home
  directory. The image (${BASE_IMAGE}
  plus @openai/codex@${CODEX_VERSION}) is built on first use and reused.
  The operator's ~/.codex/auth.json is bind-mounted read-only and never copied
  into an image layer. Egress from the container goes only through a sidecar
  proxy that admits ${EGRESS_ALLOW.join(" and ")}; everything else is refused.

  On exit the launcher prints the three criteria it just verified — the
  reviewer's MCP calls completed inside the container, the host filesystem
  was absent, the validated verdict was copied back to the host store — with
  the guardian's verdict per call and the proxy's egress log. The staged
  bytes are never copied: the verdict is replayed through the host's own
  submit_review against the host ledger, under that review's own state lock,
  with the findings the staged ledger records as the payload, and the host
  keeps the replay's result only when it equals the staged ledger field for
  field, timestamps aside. A staged ledger the replay cannot produce, a staged
  store that changed or added any other file, or a host ledger that moved
  since launch is refused; a failed check leaves the host store unwritten and
  the staged copy for inspection. The isolated CODEX_HOME lives
  in a Docker volume for the run and its sessions (the rollouts, guardian
  threads included) are copied into the scratch directory beside the codex
  transcript, which is kept and named for the record.

  Residual: the one host secret inside the container is auth.json, so the
  operator's credential rides into every advisory review. A narrowly scoped
  API key in place of the ChatGPT token is the operator's option; this
  launcher does not touch how auth.json is produced.
`;

function fail(message, code = 2) {
  process.stderr.write(`advisory-sandbox-launch: ${message}\n`);
  process.exit(code);
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseArgs(argv) {
  const options = {
    reviewId: null,
    store: null,
    marketplace: null,
    dryRun: false,
    egressProxy: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) fail(`${arg} needs a value\n${USAGE}`);
      index += 1;
      return next;
    };
    if (arg === "--review-id") options.reviewId = value();
    else if (arg === "--store") options.store = path.resolve(value());
    else if (arg === "--marketplace") options.marketplace = path.resolve(value());
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--egress-proxy") options.egressProxy = true;
    else if (arg === "--help") options.help = true;
    else fail(`unknown argument ${arg}\n${USAGE}`);
  }
  return options;
}

// The sidecar. A CONNECT-only proxy: an allowlisted host on 443 is tunnelled,
// anything else — another host, another port, a plain HTTP request — is
// refused with 403 and logged. The codex container sits on an internal Docker
// network with no route out, so this process is its only path to the network
// and its log is the complete egress record of the run.
function runEgressProxy() {
  const log = (...parts) =>
    process.stdout.write(`${new Date().toISOString()} ${parts.join(" ")}\n`);
  const allowed = (host, port) =>
    port === "443" &&
    EGRESS_ALLOW.some((domain) => host === domain || host.endsWith(`.${domain}`));
  const server = http.createServer((request, response) => {
    log("deny", "plain", request.method, request.url);
    response.writeHead(403);
    response.end();
  });
  server.on("connect", (request, socket, head) => {
    const [host, port = "443"] = request.url.split(":");
    if (!allowed(host, port)) {
      log("deny", "connect", request.url);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(443, host, () => {
      log("allow", "connect", request.url);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (error) => {
      log("error", request.url, error.code ?? error.message);
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
  });
  server.listen(PROXY_PORT, "0.0.0.0", () =>
    log("listening", String(PROXY_PORT), "allow", EGRESS_ALLOW.join(",")),
  );
}

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

// The runtime marketplace the operator registered, read from the one line of
// their config that names it. Anything more elaborate than this would be a
// TOML parser; the block has exactly one `source` key.
async function marketplaceFromCodexConfig() {
  const configPath = path.join(codexHome(), "config.toml");
  let config;
  try {
    config = await fsp.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const block = config.match(
    new RegExp(
      `^\\[marketplaces\\.${MARKETPLACE_NAME.replace(/[.-]/g, "\\$&")}\\]\\n(?<body>(?:[^[].*\\n?)*)`,
      "m",
    ),
  );
  const source = block?.groups.body.match(/^source\s*=\s*"(?<path>[^"]+)"/m);
  return source ? source.groups.path : null;
}

// Keys of the checkout's local and worktree Git configuration whose name ends
// in `.extraheader` or whose value is a URL carrying a credential. Values are
// never printed.
function gitConfigCredentialKeys(repository) {
  const keys = [];
  for (const scope of ["--local", "--worktree"]) {
    const result = spawnSync("git", ["-C", repository, "config", scope, "--list", "--null"], {
      encoding: "utf8",
    });
    // The local scope always reads in a repository; a failure there is git
    // itself failing, and the check must not pass by not running. The
    // worktree scope exists only with extensions.worktreeConfig.
    if (result.error || (result.status !== 0 && scope === "--local")) {
      fail(
        `cannot read the author checkout's Git configuration: ${result.error?.message ?? result.stderr.trim()}`,
      );
    }
    if (result.status !== 0) continue;
    for (const entry of result.stdout.split("\0")) {
      if (!entry) continue;
      const newline = entry.indexOf("\n");
      const key = newline === -1 ? entry : entry.slice(0, newline);
      const value = newline === -1 ? "" : entry.slice(newline + 1);
      // Userinfo is a credential when it carries a password in any scheme
      // (`user:pass@`) or appears at all in an http(s) URL, where a token can
      // stand as the user; `ssh://git@…` is a username and no secret.
      if (
        /\.extraheader$/i.test(key) ||
        /:\/\/[^/\s@]*:[^/\s@]*@/.test(value) ||
        /^https?:\/\/[^/\s@]+@/i.test(value)
      ) {
        keys.push(key);
      }
    }
  }
  return [...new Set(keys)];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

async function resolveInputs(options) {
  if (!options.reviewId || !/^rb-[0-9TZ-]+-[a-f0-9]{8}$/.test(options.reviewId)) {
    fail(`invalid --review-id\n${USAGE}`);
  }
  const { defaultStoreRoot } = await import("../server/core.mjs");
  const store = options.store ?? defaultStoreRoot();
  const ledgerPath = path.join(store, "reviews", options.reviewId, "review.json");
  let ledger;
  try {
    ledger = JSON.parse(await fsp.readFile(ledgerPath, "utf8"));
  } catch (error) {
    fail(`cannot read the review ledger ${ledgerPath}: ${error.message}`);
  }
  if (ledger.reviewer_provider !== "CODEX_TASK") {
    fail(
      `${options.reviewId} is bound to ${ledger.reviewer_provider}, not CODEX_TASK; the container runs the CODEX_TASK reviewer only`,
    );
  }
  if (ledger.advisory !== true) {
    fail(
      `${options.reviewId} is not an advisory review; a review of the operator's own changes takes the host launch in the workflow skill, not this one`,
    );
  }
  if (ledger.status !== "WAITING_FOR_REVIEW") {
    fail(
      `${options.reviewId} is ${ledger.status}, not WAITING_FOR_REVIEW; an advisory review has one round and this one is not waiting for it`,
    );
  }
  const repository = ledger.repository_path;
  if (typeof repository !== "string" || !path.isAbsolute(repository)) {
    fail(`${options.reviewId} records no absolute repository_path`);
  }
  const marketplace = options.marketplace ?? (await marketplaceFromCodexConfig());
  if (!marketplace) {
    fail(
      `no --marketplace given and [marketplaces.${MARKETPLACE_NAME}] names no source in ${path.join(codexHome(), "config.toml")}`,
    );
  }
  const pluginSource = path.join(marketplace, "plugins", PLUGIN_NAME);
  const authJson = path.join(codexHome(), "auth.json");
  const servedOnly = (candidates) => {
    for (const [target, label] of candidates) {
      const prefix = UNSERVED_HOST_PREFIXES.find(
        (p) => target === p.slice(0, -1) || target.startsWith(p),
      );
      if (prefix) {
        fail(
          `${label} ${target} is under ${prefix}: Docker Desktop stops serving files under ${prefix} a few seconds into a container; place the panel worktree and store under your home directory`,
        );
      }
    }
  };
  const hostPaths = [
    [store, "the review store"],
    [repository, "the author checkout the ledger records"],
    [marketplace, "the marketplace"],
    [os.tmpdir(), "the scratch directory (TMPDIR)"],
  ];
  servedOnly(hostPaths);
  const required = [
    [store, "the review store"],
    [repository, "the author checkout the ledger records"],
    [authJson, "the operator's codex auth.json"],
    [
      path.join(marketplace, ".agents", "plugins", "marketplace.json"),
      "the marketplace manifest",
    ],
    [
      path.join(pluginSource, ".codex-plugin", "plugin.json"),
      "the packaged plugin manifest",
    ],
    [path.join(pluginSource, "server", "server.mjs"), "the packaged reviewer server"],
  ];
  for (const [target, label] of required) {
    if (!(await exists(target))) {
      fail(`${label} is missing: ${target}`);
    }
  }
  for (const target of [store, repository, marketplace, authJson]) {
    if (target.includes(",")) {
      fail(`${target} contains a comma, which docker's --mount syntax cannot carry`);
    }
  }
  // The checkout's .git/config rides into the container with the mount, and
  // two things it commonly carries are host secrets: an
  // `http.<url>.extraheader` such as actions/checkout writes (a bearer token),
  // and a remote URL with a user in it. Refused up front, key names only.
  const credentialKeys = gitConfigCredentialKeys(repository);
  if (credentialKeys.length > 0) {
    fail(
      `the author checkout's Git configuration carries a credential (${credentialKeys.join(", ")}); the checkout is mounted whole, so clear it or use a checkout without it`,
    );
  }
  // Again on the real paths, so a symlink such as /tmp → /private/tmp cannot
  // slip a refused prefix past the check.
  servedOnly(
    await Promise.all(
      hostPaths.map(async ([target, label]) => [
        await fsp.realpath(target).catch(() => target),
        label,
      ]),
    ),
  );
  const pluginVersion = JSON.parse(
    await fsp.readFile(path.join(pluginSource, ".codex-plugin", "plugin.json"), "utf8"),
  ).version;
  if (typeof pluginVersion !== "string" || pluginVersion === "") {
    fail(`the packaged plugin manifest under ${pluginSource} names no version`);
  }
  return {
    reviewId: options.reviewId,
    store,
    ledgerPath,
    ledger,
    repository,
    marketplace,
    pluginSource,
    pluginVersion,
    authJson,
  };
}

// Every host path the container sees, and nothing else. Read-only unless the
// reviewer must write it, and what it writes is a staged copy of the one
// review, never the host store: under danger-full-access the reviewer's shell
// could otherwise read and rewrite every other ledger, lock, and workflow in
// the store, past the reviewer server's provider check and mutation lock. The
// isolated CODEX_HOME is a Docker volume and the working directory a tmpfs
// rather than host directories: nothing Codex keeps there — SQLite databases
// with write-ahead logs, rollouts, caches — needs to be on the host during
// the run, and a host bind would put that churn on the shared filesystem
// beside the checkout. The sessions are copied out afterwards.
function mountTable(inputs, scratch, volume, stagedStore) {
  const cache = `${CONTAINER_CODEX_HOME}/plugins/cache/${MARKETPLACE_NAME}/${PLUGIN_NAME}/${inputs.pluginVersion}`;
  return {
    cache,
    volume: [volume, CONTAINER_CODEX_HOME],
    mounts: [
      [path.join(scratch, "config.toml"), `${CONTAINER_CODEX_HOME}/config.toml`, "ro"],
      [inputs.authJson, `${CONTAINER_CODEX_HOME}/auth.json`, "ro"],
      [inputs.marketplace, CONTAINER_MARKETPLACE, "ro"],
      [inputs.pluginSource, cache, "ro"],
      [inputs.repository, inputs.repository, "ro"],
      [stagedStore, CONTAINER_STORE, "rw"],
    ],
  };
}

const LOCK_ARTIFACTS = new Set([".review-state.lock", ".review-state.lock.guard"]);

async function sha256File(file) {
  return crypto.createHash("sha256").update(await fsp.readFile(file)).digest("hex");
}

// Copy the one review into the scratch store and remember every byte of it,
// so that what comes back can be judged against what went in.
async function stageReview(inputs, stagedStore) {
  const source = path.join(inputs.store, "reviews", inputs.reviewId);
  const staged = path.join(stagedStore, "reviews", inputs.reviewId);
  await fsp.mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
  await fsp.cp(source, staged, {
    recursive: true,
    filter: (entry) => !LOCK_ARTIFACTS.has(path.basename(entry)),
  });
  const digests = new Map();
  for await (const file of walkFiles(staged)) {
    digests.set(path.relative(staged, file), await sha256File(file));
  }
  return { stagedStore, staged, digests };
}

// What may come back from the container at the file level: review.json
// changed, the server's lock artifacts, and nothing else — no other review,
// no new or edited or deleted file. Each failed check is a named reason.
async function inspectStagedStore(inputs, stage) {
  const reasons = [];
  const reviewPrefix = path.join("reviews", inputs.reviewId) + path.sep;
  const seen = new Set();
  let ledgerChanged = false;
  for await (const file of walkFiles(stage.stagedStore)) {
    const relative = path.relative(stage.stagedStore, file);
    if (!relative.startsWith(reviewPrefix)) {
      reasons.push(`unexpected file outside the staged review: ${relative}`);
      continue;
    }
    const inner = path.relative(stage.staged, file);
    if (LOCK_ARTIFACTS.has(inner)) continue;
    seen.add(inner);
    const digest = await sha256File(file);
    if (inner === "review.json") {
      ledgerChanged = digest !== stage.digests.get(inner);
    } else if (!stage.digests.has(inner)) {
      reasons.push(`an unexpected file was created in the staged review: ${inner}`);
    } else if (digest !== stage.digests.get(inner)) {
      reasons.push(`an existing snapshot file was modified: ${inner}`);
    }
  }
  for (const known of stage.digests.keys()) {
    if (!seen.has(known)) reasons.push(`a staged file was deleted: ${known}`);
  }
  return { reasons, ledgerChanged };
}

// The staged bytes are never trusted and never copied. The one mutation an
// advisory review admits is submit_review, so the staged ledger's findings
// are taken as that call's payload and replayed through the server's own
// submitInitialReview against a copy of the host ledger, under the host
// review's state lock; the host keeps the replay's result only when it equals
// the staged ledger field for field, timestamps aside. A staged ledger the
// replay cannot produce — a status the payload does not reach, a snapshot
// hash or a history the host never wrote — is refused.
const TIMESTAMP_FIELDS = new Set(["updated_at"]);

function comparableLedger(ledger) {
  const copy = JSON.parse(JSON.stringify(ledger));
  for (const field of TIMESTAMP_FIELDS) delete copy[field];
  if (Array.isArray(copy.history)) {
    copy.history = copy.history.map(({ at, ...event }) => event);
  }
  return copy;
}

function submitPayload(staged) {
  if (!Array.isArray(staged.findings)) {
    throw new Error("the staged ledger carries no findings array to replay");
  }
  return staged.findings.map((finding) => {
    const payload = {
      severity: finding?.severity,
      title: finding?.title,
      explanation: finding?.explanation,
      recommendation: finding?.recommendation,
    };
    if (finding?.path != null) payload.path = finding.path;
    if (finding?.line != null) payload.line = finding.line;
    return payload;
  });
}

async function replayAndCopyBack(inputs, stage, before, scratch, api) {
  const { loadReview, submitInitialReview, withStateLock, atomicWriteFile, canonicalJson } = api;
  const hostDirectory = path.join(inputs.store, "reviews", inputs.reviewId);
  const replayStore = path.join(scratch, "replay");
  const replayDirectory = path.join(replayStore, "reviews", inputs.reviewId);
  return withStateLock(
    { directory: hostDirectory, reviewId: inputs.reviewId, domain: "review" },
    async () => {
      const host = await loadReview(inputs.store, inputs.reviewId);
      if (host.state_version !== before.stateVersion) {
        throw new Error(
          `the host ledger advanced to state_version ${host.state_version} during the run`,
        );
      }
      const staged = await loadReview(stage.stagedStore, inputs.reviewId);
      await fsp.rm(replayStore, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(replayDirectory), { recursive: true, mode: 0o700 });
      await fsp.cp(hostDirectory, replayDirectory, {
        recursive: true,
        filter: (entry) => !LOCK_ARTIFACTS.has(path.basename(entry)),
      });
      await submitInitialReview(replayStore, inputs.reviewId, submitPayload(staged), "CODEX_TASK");
      const replayed = await loadReview(replayStore, inputs.reviewId);
      const expected = comparableLedger(replayed);
      const actual = comparableLedger(staged);
      if (canonicalJson(expected) !== canonicalJson(actual)) {
        const differing = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
          .filter((key) => canonicalJson(expected[key] ?? null) !== canonicalJson(actual[key] ?? null))
          .sort();
        throw new Error(
          `the staged ledger does not match the host's own replay of its submit_review payload (differs in: ${differing.join(", ")})`,
        );
      }
      await atomicWriteFile(
        path.join(hostDirectory, "review.json"),
        await fsp.readFile(path.join(replayDirectory, "review.json")),
      );
      return replayed;
    },
  );
}

// Bind mounts are given in the `--mount` form, not `-v`. On Docker Desktop
// 28.3.2 a `-v src:dst:ro` whose destination equals its source — the author
// checkout at its recorded path — is present when the container starts and
// missing moments later (git reads first succeeded, then failed with
// `Permission denied`, then `No such file or directory`; measured
// 2026-09-10), while the same mount through `--mount` stays put. The
// destination path has to equal the source for the checkout, so every mount
// takes the form that holds.
function bindMount([source, target, mode]) {
  return `type=bind,src=${source},dst=${target}${mode === "ro" ? ",readonly" : ""}`;
}

function containerArgs({ mounts, volume }, network, extra = [], { withoutCheckout = false } = {}) {
  const args = [
    "run",
    "--rm",
    "--network",
    network,
    "-w",
    CONTAINER_WORK,
    "--mount",
    `type=volume,src=${volume[0]},dst=${volume[1]}`,
    "--tmpfs",
    `${CONTAINER_WORK}:rw,mode=1777`,
  ];
  for (const mount of mounts) {
    if (withoutCheckout && mount[0] === mount[1]) continue;
    args.push("--mount", bindMount(mount));
  }
  args.push(
    "-e",
    `CODEX_HOME=${CONTAINER_CODEX_HOME}`,
    "-e",
    `HTTPS_PROXY=http://${PROXY_ALIAS}:${PROXY_PORT}`,
    "-e",
    `HTTP_PROXY=http://${PROXY_ALIAS}:${PROXY_PORT}`,
    ...extra,
  );
  return args;
}

const REVIEWER_REQUEST = (reviewId) =>
  `Independently review Review Bridge task \`${reviewId}\` using the packaged Review Bridge reviewer skill. Require \`reviewer_provider: CODEX_TASK\`, follow the review strategy, and submit every actionable finding.`;

// The launch inside the container. The same shape as the workflow skill's
// host launch minus the workspace-write pins, which the container makes
// moot, plus the reviewer server restated at its container path with the
// store's container path in its environment — a lone `env` key would turn the
// plugin's entry into a transport-less definition the config refuses to load.
function codexArgs(inputs, cache) {
  return [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "danger-full-access",
    "-c",
    'approvals_reviewer="guardian_subagent"',
    "-c",
    "approval_policy={granular={rules=false,sandbox_approval=false,skill_approval=false,request_permissions=false,mcp_elicitations=false}}",
    "-c",
    "memories.use_memories=false",
    "-c",
    "memories.generate_memories=false",
    "-c",
    `mcp_servers.${AUTHOR_SERVER}.command="node"`,
    "-c",
    `mcp_servers.${AUTHOR_SERVER}.enabled=false`,
    "-c",
    `mcp_servers.${REVIEWER_SERVER}.command="node"`,
    "-c",
    `mcp_servers.${REVIEWER_SERVER}.args=${JSON.stringify([
      `${cache}/server/server.mjs`,
      "--role",
      "reviewer",
      "--reviewer-provider",
      "CODEX_TASK",
    ])}`,
    "-c",
    `mcp_servers.${REVIEWER_SERVER}.cwd="${cache}"`,
    "-c",
    `mcp_servers.${REVIEWER_SERVER}.env.REVIEW_BRIDGE_HOME="${CONTAINER_STORE}"`,
    REVIEWER_REQUEST(inputs.reviewId),
  ];
}

// Paths that must be absent inside the container: the host home's sensitive
// contents — credential directories, the codex home, the macOS Library, the
// store — plus the macOS roots a host home and volumes live under. The home
// directory itself is not probed: `/home` and `/root` are directories of the
// Debian base image (with its own dotfiles under `/root`), so a host home at
// `/root` would read as present, and what the boundary is about is the
// contents anyway. An ancestor of the mounted checkout is present by
// construction, so for those the check is that they hold nothing but the way
// down to the mount — except the home directory itself, again because the
// image's own dotfiles may sit beside the mount there.
function hostPathProbe(inputs) {
  const home = os.homedir();
  const ancestors = [];
  for (let dir = path.dirname(inputs.repository); ; dir = path.dirname(dir)) {
    if (dir === path.dirname(dir)) break;
    if (dir !== home) ancestors.unshift(dir);
  }
  const absent = [
    path.join(home, ".ssh"),
    path.join(home, ".codex"),
    inputs.authJson,
    path.join(home, "Library"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    "/root/.ssh",
    "/Users",
    "/Volumes",
    inputs.store,
  ].filter((candidate) => candidate !== home && !ancestors.includes(candidate));
  return { absent: [...new Set(absent)], ancestors };
}

// The probe is a node program handed its paths as one JSON argument and
// answering in JSON lines, so a path with a space in it is one path on both
// sides. It runs in the same image with the same mounts as the reviewer.
const PROBE_PROGRAM = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const spec = JSON.parse(process.argv[1]);
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
for (const target of spec.absent) emit({ kind: "path", path: target, present: fs.existsSync(target) });
for (const target of spec.ancestors) {
  let children = null;
  try { children = fs.readdirSync(target); } catch {}
  emit({ kind: "ancestor", path: target, children });
}
if (spec.mode === "baseline") process.exit(0);
const head = spawnSync("git", ["-C", spec.checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
emit({ kind: "checkout-head", value: ((head.stdout || "") + (head.stderr || "")).trim() });
let writable = false;
try {
  const probe = path.join(spec.store, ".advisory-sandbox-probe");
  fs.writeFileSync(probe, "");
  fs.unlinkSync(probe);
  writable = true;
} catch {}
emit({ kind: "store-writable", value: writable });
const curl = (env) => {
  const result = spawnSync("curl", ["-sS", "-m", "15", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"], { encoding: "utf8", env });
  return { code: (result.stdout || "").trim(), exit: result.status };
};
emit({ kind: "egress", via: "proxy", ...curl(process.env) });
const direct = { ...process.env };
delete direct.HTTPS_PROXY;
delete direct.HTTP_PROXY;
emit({ kind: "egress", via: "direct", ...curl(direct) });
emit({ kind: "codex-version", value: (spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout || "").trim() });
emit({ kind: "uid", value: process.getuid() });
`;

// mode "baseline" runs in a container without the checkout mount and answers
// only the path and ancestor records; mode "mounted" runs with it and answers
// everything. The boundary is judged on the difference between the two.
function probeArgs(inputs, mode) {
  const { absent, ancestors } = hostPathProbe(inputs);
  return [
    "node",
    "-e",
    PROBE_PROGRAM,
    JSON.stringify({ mode, absent, ancestors, checkout: inputs.repository, store: CONTAINER_STORE }),
  ];
}

function parseProbeRecords(output) {
  const records = [];
  for (const line of output.split("\n")) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // not a record
    }
  }
  return records;
}

// The image has directories of its own — /root with its dotfiles, /usr with
// everything under it — so neither "absent" nor "holds exactly one entry" can
// be judged from the mounted container alone. The baseline container, same
// image and no checkout mount, says what the image contributes; a sensitive
// path is a leak when the baseline lacks it and the mounted container has
// it, and an ancestor is clean when the mount added exactly the one name
// that leads down to the checkout and removed nothing.
function evaluateBoundary(baselineOutput, mountedOutput, inputs) {
  const { ancestors } = hostPathProbe(inputs);
  // The one name an ancestor may gain: the checkout's next path segment below
  // it (not the next probed ancestor, which skips the home directory).
  const wayDown = (ancestor) => path.relative(ancestor, inputs.repository).split(path.sep)[0];
  const baseline = { paths: new Map(), ancestors: new Map() };
  for (const record of parseProbeRecords(baselineOutput)) {
    if (record.kind === "path") baseline.paths.set(record.path, record.present);
    else if (record.kind === "ancestor") baseline.ancestors.set(record.path, record.children);
  }
  const failures = [];
  const facts = { absent: [], present: [], children: [], egressProxied: null, egressDirect: null };
  if (baseline.paths.size + baseline.ancestors.size === 0) {
    failures.push("the baseline probe produced no records");
  }
  for (const record of parseProbeRecords(mountedOutput)) {
    if (record.kind === "path") {
      const inImage = baseline.paths.get(record.path) === true;
      if (!record.present) facts.absent.push(record.path);
      else if (inImage) facts.present.push(`${record.path} (in the image)`);
      else {
        facts.present.push(record.path);
        failures.push(`host path present inside the container: ${record.path}`);
      }
    } else if (record.kind === "ancestor") {
      const before = new Set(baseline.ancestors.get(record.path) ?? []);
      const after = new Set(record.children ?? []);
      const added = [...after].filter((name) => !before.has(name)).sort();
      const removed = [...before].filter((name) => !after.has(name)).sort();
      const expected = wayDown(record.path);
      facts.children.push(`${record.path}: +${added.join(",") || "∅"}${removed.length ? ` −${removed.join(",")}` : ""} over ${before.size} in the image`);
      if (!(ancestors.includes(record.path) && added.length === 1 && added[0] === expected && removed.length === 0)) {
        failures.push(
          `${record.path} changed by more than the way down to the checkout: added ${added.join(", ") || "nothing"}${removed.length ? `, removed ${removed.join(", ")}` : ""}, expected only ${expected}`,
        );
      }
    } else if (record.kind === "egress") {
      const summary = `${record.code} curl-exit=${record.exit}`;
      if (record.via === "proxy") {
        // Through the proxy the expected answer is its refusal; only a
        // success status means the allowlist let the host through.
        facts.egressProxied = summary;
        if (/^[23]\d\d$/.test(record.code)) {
          failures.push(`the proxy let https://example.com through (${summary})`);
        }
      } else {
        // Without the proxy any HTTP status at all — 403 and 5xx included —
        // means traffic left the container; only a connection-level failure
        // (no status, nonzero curl exit) is the boundary holding.
        facts.egressDirect = summary;
        if (record.code !== "000" || record.exit === 0) {
          failures.push(
            `the container reached https://example.com without the proxy (HTTP ${record.code}, curl exit ${record.exit})`,
          );
        }
      }
    } else if (record.kind === "checkout-head") {
      facts.checkoutHead = record.value;
      if (!/^[0-9a-f]{40}$/.test(record.value)) {
        failures.push(`git cannot read the mounted checkout: ${record.value}`);
      }
    } else if (record.kind === "store-writable") {
      facts.storeWritable = record.value;
      if (record.value !== true) failures.push("the staged store mount is not writable");
    } else if (record.kind === "codex-version") facts.codexVersion = record.value;
    else if (record.kind === "uid") facts.uid = String(record.value);
  }
  if (facts.absent.length + facts.present.length === 0) failures.push("the boundary probe produced no records");
  return { facts, failures };
}

function parseMcpLines(transcript) {
  const calls = new Map();
  for (const match of transcript.matchAll(
    /^mcp: ([^/\s]+)\/(\S+) (started|\(completed\)|\(failed.*)$/gm,
  )) {
    const key = `${match[1]}/${match[2]}`;
    const entry = calls.get(key) ?? { started: 0, completed: 0, failed: 0 };
    if (match[3] === "started") entry.started += 1;
    else if (match[3] === "(completed)") entry.completed += 1;
    else entry.failed += 1;
    calls.set(key, entry);
  }
  return calls;
}

async function* walkFiles(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

// The guardian's own rollouts under the isolated CODEX_HOME: one thread per
// codex session, one turn per approval, the verdict as the turn's agent
// message and the tool it judged in the approval request that opened it.
async function guardianVerdicts(sessionsRoot) {
  const verdicts = [];
  for await (const file of walkFiles(sessionsRoot)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = await fsp.readFile(file, "utf8");
    if (!text.includes('"thread_source":"guardian_review"')) continue;
    let turn = null;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = event.payload ?? {};
      if (event.type !== "event_msg") continue;
      if (payload.type === "task_started") {
        turn = { tool: null, startedAt: event.timestamp, outcome: null };
      } else if (payload.type === "user_message" && turn) {
        const tool = String(payload.message ?? "").match(/"tool_name":\s*"([^"]+)"/);
        if (tool) turn.tool = tool[1];
      } else if (payload.type === "agent_message" && turn) {
        try {
          const verdict = JSON.parse(payload.message);
          Object.assign(turn, {
            outcome: verdict.outcome ?? null,
            risk: verdict.risk_level ?? null,
            authorization: verdict.user_authorization ?? null,
          });
        } catch {
          turn.outcome = turn.outcome ?? "unparsed";
        }
      } else if (payload.type === "task_complete" && turn) {
        turn.seconds = (Date.parse(event.timestamp) - Date.parse(turn.startedAt)) / 1000;
        verdicts.push(turn);
        turn = null;
      } else if (payload.type === "turn_aborted" && turn) {
        turn.outcome = `aborted (${payload.reason ?? "unknown"})`;
        turn.seconds = (Date.parse(event.timestamp) - Date.parse(turn.startedAt)) / 1000;
        verdicts.push(turn);
        turn = null;
      }
    }
  }
  return verdicts;
}

// Codex prints `(failed)` both when the server answered a call with an error
// result and when the call failed to complete at all. The two differ for the
// criterion: an answered error (a path that is not in the snapshot, say) is
// the server working. The main rollout carries every tool output, so the
// server's error answers are counted there and set against the failed lines;
// only failures no answer accounts for count against the container.
async function serverErrorAnswers(sessionsRoot) {
  const messages = [];
  for await (const file of walkFiles(sessionsRoot)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = await fsp.readFile(file, "utf8");
    if (text.includes('"thread_source":"guardian_review"')) continue;
    for (const line of text.split("\n")) {
      if (!line || !line.includes("function_call_output") && !line.includes("custom_tool_call_output")) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = event.payload ?? {};
      if (!["function_call_output", "custom_tool_call_output"].includes(payload.type)) continue;
      const output = Array.isArray(payload.output)
        ? payload.output.map((part) => part?.text ?? "").join(" ")
        : String(payload.output ?? "");
      // The server's `{"error":"…"}` may arrive raw or JSON-escaped one level
      // deeper; the message ends at the first quote either way.
      for (const match of output.matchAll(/\{\\?"error\\?":\\?"((?:[^"\\]|\\[^"]){0,200})/g)) {
        messages.push(match[1]);
      }
    }
  }
  return messages;
}

function summarizeProxyLog(log) {
  const counts = new Map();
  for (const match of log.matchAll(/^\S+ (allow|deny|error) \S+ (\S+)$/gm)) {
    const key = `${match[1]} ${match[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort()
    .map(([key, count]) => `${key} ×${count}`)
    .join(", ");
}

async function ledgerFacts(ledgerPath) {
  const [ledger, info] = await Promise.all([
    fsp.readFile(ledgerPath, "utf8").then(JSON.parse),
    fsp.stat(ledgerPath),
  ]);
  return {
    status: ledger.status,
    stateVersion: ledger.state_version,
    updatedAt: ledger.updated_at,
    findings: Array.isArray(ledger.findings) ? ledger.findings.length : 0,
    mtime: info.mtime.toISOString(),
  };
}

function ensureDocker() {
  let result;
  try {
    result = run("docker", ["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"]);
  } catch (error) {
    fail(`Docker is not available (${error.message}); the advisory member has no other launch`);
  }
  if (result.status !== 0) {
    fail(
      `Docker is not available: ${(result.stderr || result.stdout).trim()}; the advisory member has no other launch`,
    );
  }
  const [, platform] = result.stdout.trim().split(" ");
  if (!platform.startsWith("linux/")) {
    fail(`Docker reports ${platform}; the read boundary needs a Linux container`);
  }
  return result.stdout.trim();
}

function ensureImage() {
  if (run("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0) {
    return "reused";
  }
  process.stdout.write(`building ${IMAGE} from ${BASE_IMAGE}\n`);
  const result = spawnSync("docker", ["build", "-t", IMAGE, "-"], {
    input: DOCKERFILE,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) fail(`docker build of ${IMAGE} failed`, 1);
  return "built";
}

function printCommand(prefix, args) {
  process.stdout.write(`${prefix} ${args.map(shellQuote).join(" ")}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.egressProxy) {
    runEgressProxy();
    return;
  }
  const inputs = await resolveInputs(options);
  const runId = crypto.randomBytes(4).toString("hex");
  const scratch = options.dryRun
    ? path.join(os.tmpdir(), `review-bridge-advisory-${inputs.reviewId}-<run>`)
    : await fsp.mkdtemp(path.join(os.tmpdir(), `review-bridge-advisory-${inputs.reviewId}-`));
  const network = `review-bridge-advisory-${runId}`;
  const proxyName = `${network}-egress`;
  const codexName = `${network}-codex`;
  const homeVolume = `${network}-home`;
  const stagedStore = path.join(scratch, "store");
  const table = mountTable(inputs, scratch, homeVolume, stagedStore);
  const { cache } = table;
  const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : null;
  const user = uid ? ["--user", uid, "-e", `HOME=${CONTAINER_WORK}`] : [];
  const configToml = [
    'model_reasoning_effort = "high"',
    `[plugins."${PLUGIN_NAME}@${MARKETPLACE_NAME}"]`,
    "enabled = true",
    `[marketplaces.${MARKETPLACE_NAME}]`,
    'source_type = "local"',
    `source = "${CONTAINER_MARKETPLACE}"`,
    "",
  ].join("\n");

  const networkCreate = ["network", "create", "--internal", network];
  const proxyRun = [
    "run",
    "-d",
    "--name",
    proxyName,
    "--network",
    network,
    "--network-alias",
    PROXY_ALIAS,
    "--mount",
    bindMount([path.dirname(scriptPath), CONTAINER_LAUNCHER, "ro"]),
    IMAGE,
    "node",
    `${CONTAINER_LAUNCHER}/${path.basename(scriptPath)}`,
    "--egress-proxy",
  ];
  const proxyConnect = ["network", "connect", "bridge", proxyName];
  const sessionsExport = [
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=volume,src=${homeVolume},dst=${CONTAINER_CODEX_HOME},readonly`,
    "--mount",
    bindMount([scratch, "/out", "rw"]),
    IMAGE,
    "sh",
    "-c",
    `cp -a ${CONTAINER_CODEX_HOME}/sessions /out/sessions 2>/dev/null; chown -R ${uid ?? "0:0"} /out/sessions 2>/dev/null; true`,
  ];
  const baselineRun = [
    ...containerArgs(table, network, user, { withoutCheckout: true }),
    IMAGE,
    ...probeArgs(inputs, "baseline"),
  ];
  const boundaryRun = [...containerArgs(table, network, user), IMAGE, ...probeArgs(inputs, "mounted")];
  const codexRun = [
    ...containerArgs(table, network, [...user, "--name", codexName]),
    IMAGE,
    ...codexArgs(inputs, cache),
  ];

  process.stdout.write(
    [
      `review ${inputs.reviewId} (${inputs.ledger.status}, state_version ${inputs.ledger.state_version})`,
      `store ${inputs.store} (never mounted; the review is staged under ${stagedStore})`,
      `checkout ${inputs.repository} (read-only, at its recorded path)`,
      `marketplace ${inputs.marketplace} (plugin ${inputs.pluginVersion}, read-only)`,
      `auth ${inputs.authJson} (read-only bind mount)`,
      `scratch ${scratch}`,
      "",
    ].join("\n"),
  );

  if (options.dryRun) {
    process.stdout.write(
      `dry run: nothing below is executed\n${CONTAINER_CODEX_HOME}/config.toml:\n${configToml.trimEnd().replace(/^/gm, "  ")}\n`,
    );
    printCommand("docker", networkCreate);
    printCommand("docker", proxyRun);
    printCommand("docker", proxyConnect);
    printCommand("docker", baselineRun);
    printCommand("docker", boundaryRun);
    printCommand("docker", codexRun);
    process.stdout.write("  (codex stdin is closed: the container is started with stdin ignored)\n");
    printCommand("docker", sessionsExport);
    process.stdout.write(`docker volume rm ${homeVolume}\n`);
    return;
  }

  const dockerVersion = ensureDocker();
  const imageState = ensureImage();
  await fsp.writeFile(path.join(scratch, "config.toml"), configToml);
  const transcriptPath = path.join(scratch, "codex.log");
  const before = await ledgerFacts(inputs.ledgerPath);
  const stage = await stageReview(inputs, stagedStore);
  const { loadReview, submitInitialReview } = await import("../server/core.mjs");
  const { withStateLock, atomicWriteFile, canonicalJson } = await import("../server/storage.mjs");

  let proxyLog = "";
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    spawnSync("docker", ["rm", "-f", codexName], { stdio: "ignore" });
    proxyLog = run("docker", ["logs", proxyName]).stdout ?? "";
    spawnSync("docker", ["rm", "-f", proxyName], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
    // The rollouts are the guardian evidence; copy them out before the
    // volume goes.
    spawnSync("docker", sessionsExport, { stdio: "ignore" });
    spawnSync("docker", ["volume", "rm", homeVolume], { stdio: "ignore" });
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }

  let codexExit = null;
  let elapsed = null;
  let headerAt = null;
  let boundary;
  try {
    for (const args of [networkCreate, proxyRun, proxyConnect]) {
      const result = run("docker", args);
      if (result.status !== 0) {
        throw new Error(`docker ${args[0]} ${args[1]} failed: ${result.stderr.trim()}`);
      }
    }
    const proxyDeadline = Date.now() + 15000;
    while (!run("docker", ["logs", proxyName]).stdout.includes("listening")) {
      if (Date.now() > proxyDeadline) throw new Error("the egress proxy did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // The boundary is measured before the reviewer runs, by a probe with no
    // model in it: once without the checkout mount for what the image itself
    // holds, once with it, and the launch stops here if the difference is
    // more than the checkout.
    const baselineProbe = run("docker", baselineRun);
    const probe = run("docker", boundaryRun);
    boundary = evaluateBoundary(baselineProbe.stdout, probe.stdout, inputs);
    if (baselineProbe.status !== 0 || probe.status !== 0 || boundary.failures.length > 0) {
      process.stderr.write(`${baselineProbe.stderr}${probe.stderr}${probe.stdout}`);
      throw new Error(
        `the container boundary did not hold:\n  ${boundary.failures.join("\n  ") || `probe exited ${probe.status}`}`,
      );
    }

    const started = Date.now();
    const transcript = fs.createWriteStream(transcriptPath);
    codexExit = await new Promise((resolve, reject) => {
      const child = spawn("docker", codexRun, { stdio: ["ignore", "pipe", "pipe"] });
      const forward = (stream) => {
        stream.on("data", (chunk) => {
          if (headerAt === null && chunk.toString().includes("session id:")) {
            headerAt = (Date.now() - started) / 1000;
          }
          process.stdout.write(chunk);
          transcript.write(chunk);
        });
      };
      forward(child.stdout);
      forward(child.stderr);
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
    // The last mcp: line is often the last bytes the child wrote; read the
    // transcript only once the stream has flushed them.
    await new Promise((resolve) => transcript.end(resolve));
    elapsed = (Date.now() - started) / 1000;
  } catch (error) {
    cleanup();
    fail(error.message, 1);
  } finally {
    cleanup();
  }

  const transcriptText = await fsp.readFile(transcriptPath, "utf8");
  const mcp = parseMcpLines(transcriptText);
  const reviewerCalls = [...mcp.entries()].filter(([key]) => key.startsWith(`${REVIEWER_SERVER}/`));
  const started = reviewerCalls.reduce((sum, [, entry]) => sum + entry.started, 0);
  const completed = reviewerCalls.reduce((sum, [, entry]) => sum + entry.completed, 0);
  const failedCalls = started - completed;
  const answeredErrors = failedCalls > 0 ? await serverErrorAnswers(path.join(scratch, "sessions")) : [];
  const explained = Math.min(failedCalls, answeredErrors.length);
  // The copy-back happens only after criteria 1 and 2 and the exit code have
  // passed: a host ledger advanced to REVIEW_SUBMITTED or CLEAN cannot be
  // launched again, so a run with an unexplained failure or a nonzero exit
  // must leave it where it was. Then: check what the container left in the
  // staged store at the file level, replay the verdict through the host's own
  // submit_review under the host review's lock, and keep the replay only if
  // it equals the staged ledger; otherwise refuse with the reasons.
  const mcpOk = started > 0 && completed + explained === started;
  const preCopyFailures = [
    ...(codexExit === 0 ? [] : [`codex exited ${codexExit}`]),
    ...(mcpOk ? [] : [failedCalls > explained ? `${failedCalls - explained} unexplained failed MCP call(s)` : "no reviewer MCP call completed"]),
    ...(boundary.failures.length === 0 ? [] : ["the boundary did not hold"]),
  ];
  const inspection = preCopyFailures.length > 0 ? { reasons: [], ledgerChanged: false } : await inspectStagedStore(inputs, stage);
  let copyBackOutcome;
  if (preCopyFailures.length > 0) {
    copyBackOutcome = { ok: false, detail: `refused — pre-copy criteria failed: ${preCopyFailures.join("; ")}; host store unwritten, staged copy kept at ${stage.staged}` };
  } else if (inspection.reasons.length > 0) {
    copyBackOutcome = { ok: false, detail: `copy-back refused — ${inspection.reasons.join("; ")}; host store unwritten, staged copy kept at ${stage.staged}` };
  } else if (!inspection.ledgerChanged) {
    copyBackOutcome = { ok: false, detail: "nothing to copy back — the staged ledger is unchanged, so no verdict was recorded" };
  } else {
    try {
      await replayAndCopyBack(inputs, stage, before, scratch, {
        loadReview,
        submitInitialReview,
        withStateLock,
        atomicWriteFile,
        canonicalJson,
      });
      copyBackOutcome = { ok: true, detail: null };
    } catch (error) {
      copyBackOutcome = { ok: false, detail: `copy-back refused — ${error.message}; host store unwritten, staged copy kept at ${stage.staged}` };
    }
  }
  const after = await ledgerFacts(inputs.ledgerPath);
  if (copyBackOutcome.ok) {
    copyBackOutcome.detail = `copy-back applied — the verdict was replayed through the host's own submit_review against the host ledger under its state lock and matched the staged ledger; status ${before.status} → ${after.status}, state_version ${before.stateVersion} → ${after.stateVersion}, findings ${after.findings}, review.json mtime ${before.mtime} → ${after.mtime}`;
  }
  const verdicts = await guardianVerdicts(path.join(scratch, "sessions"));
  const criteria = [
    [
      "1 MCP calls completed inside the container",
      mcpOk,
      reviewerCalls.length === 0
        ? "no reviewer MCP call in the transcript"
        : reviewerCalls
            .map(([key, entry]) => `${key.split("/")[1]} ${entry.completed}/${entry.started}`)
            .join(", ") +
          (failedCalls > 0
            ? `; ${explained} of ${failedCalls} failed call(s) answered by the server with an error (${answeredErrors.slice(0, 3).map((m) => `"${m}"`).join(", ")}${answeredErrors.length > 3 ? ", …" : ""})${failedCalls > explained ? `, ${failedCalls - explained} unexplained` : ""}`
            : ""),
    ],
    [
      "2 host filesystem absent",
      boundary.failures.length === 0,
      `absent (and not in the image): ${boundary.facts.absent.join(", ")}${boundary.facts.present.length ? `; present: ${boundary.facts.present.join(", ")}` : ""}${boundary.facts.children.length ? `; checkout ancestors against the unmounted baseline: ${boundary.facts.children.join("; ")}` : ""}`,
    ],
    ["3 validated verdict copied back to the host store", copyBackOutcome.ok, copyBackOutcome.detail],
  ];
  const lines = [
    "",
    "== advisory sandbox launch report ==",
    `review ${inputs.reviewId}  store ${inputs.store} (staged, never mounted)  scratch ${scratch}`,
    `docker ${dockerVersion}  image ${IMAGE} (${imageState})  ${boundary.facts.codexVersion ?? ""}  uid ${boundary.facts.uid ?? "?"}`,
    `codex exit ${codexExit}, ${elapsed?.toFixed(1)} s (header at +${headerAt?.toFixed(1) ?? "?"} s); transcript ${transcriptPath}`,
    ...criteria.map(([name, ok, detail]) => `criterion ${name}: ${ok ? "PASS" : "FAIL"} — ${detail}`),
    `egress: example.com via proxy → ${boundary.facts.egressProxied}, without proxy → ${boundary.facts.egressDirect}; proxy log: ${summarizeProxyLog(proxyLog) || "(empty)"}`,
    `guardian verdicts (${verdicts.length}):`,
    ...(verdicts.length
      ? verdicts.map(
          (turn) =>
            `  ${turn.tool ?? "?"}: ${turn.outcome ?? "?"} (risk ${turn.risk ?? "?"}, authorization ${turn.authorization ?? "?"}, ${turn.seconds?.toFixed(1)} s)`,
        )
      : ["  none found in the sessions copied out of the isolated CODEX_HOME"]),
    `residual: the one host secret inside was ${inputs.authJson}, egress limited to ${EGRESS_ALLOW.join(", ")} by the sidecar`,
    "",
  ];
  process.stdout.write(lines.join("\n"));
  const failed = criteria.some(([, ok]) => !ok);
  process.exit(codexExit !== 0 ? codexExit || 1 : failed ? 1 : 0);
}

await main();
