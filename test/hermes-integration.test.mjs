import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as hermesConfig from "../scripts/hermes-config.mjs";

const { parseHermesMcpSnippet } = hermesConfig;

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const hermesTemplates = path.join(projectRoot, "templates", "hermes");
const serverPath = path.join(projectRoot, "src", "server.mjs");
const RELEASE_VERSION = "0.6.0";
const RELEASE_PATH_PLACEHOLDER = "__REVIEW_BRIDGE_RELEASE_PATH__";
const STORE_PLACEHOLDER = "__REVIEW_BRIDGE_HOME__";

// The Hermes direct MCP reference documents command, args, env, and
// tools.include filtering but no cwd key. The reviewer server exposes exactly
// this tool set (the same contract test/mcp-smoke.test.mjs asserts).
const REVIEWER_TOOLS = [
  "list_pending_reviews",
  "open_review",
  "read_review_artifact",
  "read_snapshot_file",
  "search_snapshot",
  "submit_rereview",
  "submit_review",
].sort();

async function readRequired(relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  await fsp.access(filePath);
  return fsp.readFile(filePath, "utf8");
}

function scalarValues(value) {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(scalarValues);
  }
  return [String(value)];
}

async function listSourceToolNames(role, store) {
  const args = [serverPath, "--role", role];
  if (role === "reviewer") {
    args.push("--reviewer-provider", "HERMES");
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...process.env, REVIEW_BRIDGE_HOME: store },
    stderr: "pipe",
  });
  const client = new Client({
    name: "review-bridge-hermes-template-test",
    version: RELEASE_VERSION,
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

test("Hermes MCP snippet parser preserves scalar types and quoted hashes", () => {
  const parsed = parseHermesMcpSnippet(`
config:
  enabled: true
  timeout: 300
  ratio: -1.5
  quoted_boolean: "true"
  quoted_number: '300'
  label: "reviewer # one"
  plain: value # trailing comment
  values:
    - false
    - 60
    - "false # string"
`);
  assert.deepEqual(parsed, {
    config: {
      enabled: true,
      timeout: 300,
      ratio: -1.5,
      quoted_boolean: "true",
      quoted_number: "300",
      label: "reviewer # one",
      plain: "value",
      values: [false, 60, "false # string"],
    },
  });
});

for (const [name, yaml] of [
  ["tabs", "root:\n\tchild: value\n"],
  ["over-indented mapping sibling", "root:\n  first: value\n    second: value\n"],
  ["over-indented list sibling", "root:\n  values:\n    - one\n      - two\n"],
  ["child beneath scalar", "root:\n  scalar: value\n    child: value\n"],
  ["malformed dedent", "root:\n  child: value\n sibling: value\n"],
  ["mixed list and mapping", "root:\n  values:\n    - one\n    key: value\n"],
  ["mixed mapping and list", "root:\n  values:\n    key: value\n    - one\n"],
  ["unconsumed root mapping", "- one\nkey: value\n"],
]) {
  test(`Hermes MCP snippet parser rejects ${name}`, () => {
    assert.throws(() => parseHermesMcpSnippet(yaml));
  });
}

for (const [name, value] of [
  ["block sequence entry", "-"],
  ["explicit mapping key", "?"],
  ["mapping value", ":"],
  ["flow entry", ",value"],
  ["flow sequence end", "]value"],
  ["flow mapping end", "}value"],
  ["comment", "# value"],
  ["alias", "*shared"],
  ["anchor", "&shared value"],
  ["tag", "!secret value"],
  ["literal multiline scalar", "|"],
  ["folded multiline scalar", ">"],
  ["flow list", "[one, two]"],
  ["flow mapping", "{one: two}"],
  ["directive", "%name"],
  ["reserved at sign", "@name"],
  ["reserved backtick", "`name"],
  ["document start", "---"],
  ["document end", "..."],
  ["null scalar", "null"],
]) {
  test(`Hermes MCP snippet parser rejects unsupported ${name} syntax`, () => {
    assert.throws(() => parseHermesMcpSnippet(`value: ${value}\n`));
  });
}

test("Hermes MCP snippet parser rejects duplicate keys at every level", () => {
  for (const yaml of [
    "value: one\nvalue: two\n",
    "root:\n  value: one\n  value: two\n",
  ]) {
    assert.throws(() => parseHermesMcpSnippet(yaml), /duplicate/i);
  }
});

test("Hermes config rendering requires resolved absolute release and store paths", () => {
  const server = parseHermesMcpSnippet(`
server:
  command: node
  args:
    - __REVIEW_BRIDGE_RELEASE_PATH__/server/server.mjs
  env:
    REVIEW_BRIDGE_HOME: __REVIEW_BRIDGE_HOME__
  enabled: true
  timeout: 300
  connect_timeout: 60
`).server;
  const releasePath = path.join(
    path.sep,
    "opt",
    `review-bridge-v${RELEASE_VERSION}`,
    "hermes-integration",
  );
  const reviewBridgeHome = path.join(path.sep, "var", "lib", "review-bridge");
  const rendered = hermesConfig.renderAndValidateHermesServerConfig(server, {
    releasePath,
    reviewBridgeHome,
  });
  assert.equal(
    rendered.args[0],
    path.join(releasePath, "server", "server.mjs"),
  );
  assert.equal(rendered.env.REVIEW_BRIDGE_HOME, reviewBridgeHome);

  assert.throws(
    () =>
      hermesConfig.renderAndValidateHermesServerConfig(server, {
        releasePath: "relative-release",
        reviewBridgeHome,
      }),
    /absolute/i,
  );
  assert.throws(
    () =>
      hermesConfig.renderAndValidateHermesServerConfig(server, {
        releasePath,
        reviewBridgeHome: "relative-store",
      }),
    /absolute/i,
  );
  assert.throws(
    () =>
      hermesConfig.renderAndValidateHermesServerConfig(
        { ...server, command: "__UNKNOWN_PLACEHOLDER__" },
        { releasePath, reviewBridgeHome },
    ),
    /placeholder/i,
  );
  assert.throws(
    () =>
      hermesConfig.renderAndValidateHermesServerConfig(
        { ...server, args: ["server/server.mjs"] },
        { releasePath, reviewBridgeHome },
      ),
    /absolute release path/i,
  );
  assert.throws(
    () =>
      hermesConfig.renderAndValidateHermesServerConfig(
        { ...server, env: { REVIEW_BRIDGE_HOME: "relative-store" } },
        { releasePath, reviewBridgeHome },
      ),
    /REVIEW_BRIDGE_HOME/i,
  );
});

test("Hermes config semantic validation rejects quoted booleans and numbers", () => {
  const releasePath = path.join(path.sep, "opt", "hermes-integration");
  const reviewBridgeHome = path.join(path.sep, "var", "lib", "review-bridge");
  for (const [enabled, timeout, connectTimeout] of [
    ['"true"', "300", "60"],
    ["true", '"300"', "60"],
    ["true", "300", '"60"'],
  ]) {
    const server = parseHermesMcpSnippet(`
server:
  command: node
  args:
    - __REVIEW_BRIDGE_RELEASE_PATH__/server/server.mjs
  env:
    REVIEW_BRIDGE_HOME: __REVIEW_BRIDGE_HOME__
  enabled: ${enabled}
  timeout: ${timeout}
  connect_timeout: ${connectTimeout}
`).server;
    assert.throws(
      () =>
        hermesConfig.renderAndValidateHermesServerConfig(server, {
          releasePath,
          reviewBridgeHome,
        }),
      /boolean|number/i,
    );
  }

  const quotedToolBoolean = parseHermesMcpSnippet(`
server:
  command: node
  args:
    - __REVIEW_BRIDGE_RELEASE_PATH__/server/server.mjs
  env:
    REVIEW_BRIDGE_HOME: __REVIEW_BRIDGE_HOME__
  enabled: true
  timeout: 300
  connect_timeout: 60
  tools:
    resources: "false"
`).server;
  assert.throws(
    () =>
      hermesConfig.renderAndValidateHermesServerConfig(quotedToolBoolean, {
        releasePath,
        reviewBridgeHome,
      }),
    /boolean/i,
  );
});

test("Hermes config rejects exponent forms that PyYAML resolves as strings", () => {
  const releasePath = path.join(path.sep, "opt", "hermes-integration");
  const reviewBridgeHome = path.join(path.sep, "var", "lib", "review-bridge");
  for (const timeout of ["3e2", "3e+2", "3.0e2"]) {
    assert.throws(
      () => {
        const server = parseHermesMcpSnippet(`
server:
  command: node
  args:
    - __REVIEW_BRIDGE_RELEASE_PATH__/server/server.mjs
  env:
    REVIEW_BRIDGE_HOME: __REVIEW_BRIDGE_HOME__
  enabled: true
  timeout: ${timeout}
  connect_timeout: 60
`).server;
        hermesConfig.renderAndValidateHermesServerConfig(server, {
          releasePath,
          reviewBridgeHome,
        });
      },
      /unsupported numeric scalar/i,
      timeout,
    );
  }
});

test("Hermes reviewer MCP snippet binds HERMES with an exact release path and only reviewer tools", async (t) => {
  const store = await fsp.mkdtemp(
    path.join(os.tmpdir(), "review-bridge-hermes-template-"),
  );
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const yaml = await readRequired(
    path.join("templates", "hermes", "mcp", "reviewer.config.yaml"),
  );
  const parsed = parseHermesMcpSnippet(yaml);
  const servers = parsed.mcp_servers;
  assert.deepEqual(Object.keys(servers), ["review-bridge-reviewer"]);
  const server = servers["review-bridge-reviewer"];
  assert.deepEqual(Object.keys(server).sort(), [
    "args",
    "command",
    "connect_timeout",
    "enabled",
    "env",
    "timeout",
    "tools",
  ]);
  assert.equal(server.command, "node");
  // args[0] is the server entry placeholder that the README requires rendering
  // to an absolute path within one exact build; it must not be a floating
  // `./server/server.mjs` or shell interpolation.
  const args = server.args;
  assert.equal(
    args[0],
    `${RELEASE_PATH_PLACEHOLDER}/server/server.mjs`,
  );
  assert.deepEqual(args.slice(1), [
    "--role",
    "reviewer",
    "--reviewer-provider",
    "HERMES",
  ]);
  assert.deepEqual(server.env, { REVIEW_BRIDGE_HOME: STORE_PLACEHOLDER });
  assert.equal(server.enabled, true);
  assert.equal(server.timeout, 300);
  assert.equal(server.connect_timeout, 60);
  assert.deepEqual(Object.keys(server.tools).sort(), [
    "include",
    "prompts",
    "resources",
  ]);
  assert.deepEqual(server.tools.include.slice().sort(), REVIEWER_TOOLS);
  assert.equal(server.tools.resources, false);
  assert.equal(server.tools.prompts, false);
  assert.deepEqual(await listSourceToolNames("reviewer", store), REVIEWER_TOOLS);
  assert.equal("cwd" in server, false, "Hermes direct MCP config has no cwd key");
  assert.equal("review-bridge-author" in servers, false);
  assert.doesNotMatch(scalarValues(parsed).join("\n"), /\$\(|`|\$\{/);
});

test("Hermes author MCP snippet is separate, unfiltered, and starts only --role author", async (t) => {
  const store = await fsp.mkdtemp(
    path.join(os.tmpdir(), "review-bridge-hermes-template-"),
  );
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const yaml = await readRequired(
    path.join("templates", "hermes", "mcp", "author.config.yaml"),
  );
  const parsed = parseHermesMcpSnippet(yaml);
  const servers = parsed.mcp_servers;
  assert.deepEqual(Object.keys(servers), ["review-bridge-author"]);
  const server = servers["review-bridge-author"];
  assert.deepEqual(Object.keys(server).sort(), [
    "args",
    "command",
    "connect_timeout",
    "enabled",
    "env",
    "timeout",
  ]);
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, [
    `${RELEASE_PATH_PLACEHOLDER}/server/server.mjs`,
    "--role",
    "author",
  ]);
  assert.deepEqual(server.env, { REVIEW_BRIDGE_HOME: STORE_PLACEHOLDER });
  assert.equal(server.enabled, true);
  assert.equal(server.timeout, 300);
  assert.equal(server.connect_timeout, 60);
  assert.equal("review-bridge-reviewer" in servers, false);
  assert.equal("cwd" in server, false);
  assert.equal("tools" in server, false, "author tools must not be filtered");
  assert.equal(server.args.includes("--reviewer-provider"), false);
  assert.doesNotMatch(scalarValues(parsed).join("\n"), /\$\(|`|\$\{/);
  const authorTools = await listSourceToolNames("author", store);
  for (const tool of [
    "prepare_review",
    "start_publication",
    "record_github_snapshot",
    "start_autonomous_workflow",
  ]) {
    assert.ok(authorTools.includes(tool), `author server is missing ${tool}`);
  }
});

test("Hermes snippets share one REVIEW_BRIDGE_HOME and keep secrets and shell interpolation out", async () => {
  const reviewer = await readRequired(
    path.join("templates", "hermes", "mcp", "reviewer.config.yaml"),
  );
  const author = await readRequired(
    path.join("templates", "hermes", "mcp", "author.config.yaml"),
  );
  const parsed = [
    parseHermesMcpSnippet(reviewer),
    parseHermesMcpSnippet(author),
  ];
  const values = parsed.flatMap(scalarValues);
  assert.equal(values.filter((value) => value === STORE_PLACEHOLDER).length, 2);
  assert.equal(
    values.filter((value) => value.startsWith(RELEASE_PATH_PLACEHOLDER)).length,
    2,
  );
  assert.deepEqual(
    parsed.map((config) => Object.values(config.mcp_servers)[0].env),
    [
      { REVIEW_BRIDGE_HOME: STORE_PLACEHOLDER },
      { REVIEW_BRIDGE_HOME: STORE_PLACEHOLDER },
    ],
  );
  assert.doesNotMatch(
    values.join("\n"),
    /github_pat_|ghp_|GITHUB_TOKEN|GH_TOKEN|Bearer\s+\S/i,
  );
  assert.doesNotMatch(values.join("\n"), /\$\(|`|\$\{/);
});

test("Hermes reviewer skill is reviewer-scoped and preserves artifact-reading rules", async (t) => {
  const store = await fsp.mkdtemp(
    path.join(os.tmpdir(), "review-bridge-hermes-template-"),
  );
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const skill = await readRequired(
    path.join(
      "templates",
      "hermes",
      "skills",
      "review-bridge-reviewer",
      "SKILL.md",
    ),
  );
  // Fresh Hermes reviewer context, HERMES binding, reviewer-only tools.
  assert.match(skill, /fresh Hermes reviewer (conversation|context)/i);
  assert.match(skill, /reviewer_provider:\s*HERMES/);
  assert.match(skill, /reviewer-scoped/i);
  assert.match(skill, /submit tools update the review\s+ledger/is);
  assert.doesNotMatch(skill, /read-only Review Bridge reviewer tools/i);
  for (const tool of REVIEWER_TOOLS) {
    assert.match(skill, new RegExp(`\\b${tool}\\b`));
  }
  // No author/publication tool is named or made available by this skill.
  for (const tool of await listSourceToolNames("author", store)) {
    assert.doesNotMatch(skill, new RegExp(`\\b${tool}\\b`));
  }
  // FULL/SUCCESSOR artifact-reading rules are preserved.
  assert.match(skill, /successor\.json/);
  assert.match(skill, /successor\.diff/);
  assert.match(skill, /patch\.diff/);
  assert.match(skill, /patch_index/);
  assert.match(skill, /read_snapshot_file/);
  assert.match(skill, /search_snapshot/);
  assert.match(skill, /next_offset/);
});

test("Codex workflow skill documents manual Hermes provider selection and handoff", async () => {
  const skill = await readRequired(
    path.join(
      "templates",
      "codex-plugin",
      "skills",
      "review-bridge-workflow",
      "SKILL.md",
    ),
  );
  const providerSelection = skill.match(
    /6\. Choose `reviewer_provider` explicitly:(?<body>[\s\S]*?)\n7\. Call `prepare_review`/,
  );
  assert.ok(providerSelection, "manual reviewer provider section is missing");
  assert.match(
    providerSelection.groups.body,
    /- `HERMES` for a fresh(?:, independent)? Hermes reviewer (?:conversation|context)/i,
  );

  const reviewerHandoff = skill.match(
    /9\. Start a fresh reviewer context(?<body>[\s\S]*?)\n10\. Require/,
  );
  assert.ok(reviewerHandoff, "manual reviewer handoff section is missing");
  assert.match(
    reviewerHandoff.groups.body,
    /For\s+`HERMES`,[^.]*fresh[^.]*Hermes reviewer (?:conversation|context)[\s\S]*?only the review\s+ID[\s\S]*?packaged\s+reviewer skill/i,
  );
});

test("Hermes README documents profile separation, exact release pinning, absolute rendering, and boundaries", async () => {
  const readme = await readRequired(path.join("templates", "hermes", "README.md"));
  assert.match(readme, /separate profiles/i);
  assert.match(readme, /auto-injects?\s+every (selected\s+)?tool/i);
  assert.match(readme, /REVIEW_BRIDGE_HOME/);
  assert.match(readme, /one exact Review Bridge (release|build|version)/i);
  assert.match(readme, /absolute path/i);
  assert.match(readme, /__REVIEW_BRIDGE_RELEASE_PATH__/);
  assert.match(readme, /v0\.6\.0/);
  assert.match(readme, /install/i);
  assert.match(readme, /upgrade/i);
  assert.match(readme, /verify/i);
  assert.match(readme, /CODEX_TASK/);
  assert.match(readme, /provenance/i);
  assert.match(readme, /not.*cryptographic/i);
  assert.match(readme, /local HERMES reviewer gate has passed/i);
  assert.match(readme, /author\/publication side/i);
});

test("Hermes install and release artifacts use the 0.6.0 release identity", async () => {
  const [
    packageJson,
    packageLock,
    build,
    verifyBuild,
    server,
    claudeManifest,
    codexManifest,
    rootReadme,
    hermesReadme,
    hermesAuthorConfig,
    hermesReviewerConfig,
    changelog,
  ] = await Promise.all([
    readRequired("package.json"),
    readRequired("package-lock.json"),
    readRequired(path.join("scripts", "build.mjs")),
    readRequired(path.join("scripts", "verify-build.mjs")),
    readRequired(path.join("src", "server.mjs")),
    readRequired(path.join("templates", "claude-extension", "manifest.json")),
    readRequired(
      path.join("templates", "codex-plugin", ".codex-plugin", "plugin.json"),
    ),
    readRequired("README.md"),
    readRequired(path.join("templates", "hermes", "README.md")),
    readRequired(path.join("templates", "hermes", "mcp", "author.config.yaml")),
    readRequired(path.join("templates", "hermes", "mcp", "reviewer.config.yaml")),
    readRequired("CHANGELOG.md"),
  ]);

  // v0.5.0 was released before Hermes support existed, so it cannot be the
  // tag or output path used by the current Hermes installation instructions.
  assert.match(hermesReadme, /exact `v0\.6\.0` tag/);

  const rootPackage = JSON.parse(packageJson);
  const lock = JSON.parse(packageLock);
  assert.equal(rootPackage.version, RELEASE_VERSION);
  assert.equal(lock.version, RELEASE_VERSION);
  assert.equal(lock.packages[""].version, RELEASE_VERSION);
  assert.equal(JSON.parse(claudeManifest).version, RELEASE_VERSION);
  assert.equal(JSON.parse(codexManifest).version, RELEASE_VERSION);
  assert.match(server, /version: "0\.6\.0"/);

  for (const currentReleaseText of [
    build,
    verifyBuild,
    rootReadme,
    hermesReadme,
    hermesAuthorConfig,
    hermesReviewerConfig,
  ]) {
    assert.doesNotMatch(currentReleaseText, /v0\.5\.0|0\.5\.0/);
  }

  assert.match(build, /releaseVersion/);
  assert.match(verifyBuild, /releaseVersion/);
  assert.match(rootReadme, /v0\.6\.0/);
  assert.match(hermesReadme, /v0\.6\.0/);
  assert.match(hermesAuthorConfig, /v0\.6\.0/);
  assert.match(hermesReviewerConfig, /v0\.6\.0/);

  const currentChangelog = changelog.match(
    /^## 0\.6\.0[^\n]*\n(?<body>[\s\S]*?)(?=^## )/m,
  );
  const previousChangelog = changelog.match(
    /^## 0\.5\.0[^\n]*\n(?<body>[\s\S]*?)(?=^## )/m,
  );
  assert.ok(currentChangelog, "the 0.6.0 changelog entry is missing");
  assert.match(currentChangelog.groups.body, /HERMES/);
  assert.ok(previousChangelog, "the historical 0.5.0 changelog entry is missing");
  assert.doesNotMatch(previousChangelog.groups.body, /HERMES|hermes-integration/);
});

test("build script packages a versioned hermes-integration directory and preserves Codex and Claude outputs", async () => {
  const [build, packageJson] = await Promise.all([
    readRequired(path.join("scripts", "build.mjs")),
    readRequired("package.json"),
  ]);
  assert.equal(JSON.parse(packageJson).version, RELEASE_VERSION);
  assert.match(build, /hermes-integration/);
  assert.match(build, /outputRoot/);
  assert.match(build, /releaseVersion/);
  assert.match(build, /templates["']?,?\s*["']hermes/);
  assert.match(build, /copyServer\(hermesIntegration\)/);
  assert.match(build, /installRuntime\(hermesIntegration\)/);
  // Existing Codex and Claude artifacts must remain.
  assert.match(build, /codex-marketplace/);
  assert.match(build, /claude-extension-source/);
  assert.match(build, /mcpbOutput/);
  assert.match(build, /sourceOutput/);
});

test("verify-build validates packaged Hermes artifacts, HERMES binding, isolation, shared store, and reviewer launch", async () => {
  const verify = await readRequired(path.join("scripts", "verify-build.mjs"));
  assert.match(verify, /hermes-integration/);
  assert.match(verify, /REVIEW_BRIDGE_HOME/);
  assert.match(verify, /renderAndValidateHermesServerConfig/);
  assert.match(verify, /"HERMES"/);
  assert.match(verify, /--reviewer-provider/);
  assert.match(verify, /review-bridge-reviewer/);
  assert.match(verify, /review-bridge-author/);
  // The verify script must launch the packaged HERMES reviewer against a
  // temporary shared store and assert reviewer-only tools.
  assert.match(verify, /list_pending_reviews/);
  assert.match(verify, /open_review/);
  assert.match(verify, /mkdtemp/);
  assert.match(verify, /hermesReviewer.*listTools/s);
  assert.match(verify, /hermesAuthor/s);
  // Version consistency with the release metadata.
  assert.match(verify, /releaseVersion/);
  assert.match(verify, /package\.json/);
});

test("root README and CHANGELOG document Hermes as a local reviewer provider", async () => {
  const [readme, changelog] = await Promise.all([
    readRequired("README.md"),
    readRequired("CHANGELOG.md"),
  ]);
  assert.match(readme, /Hermes/);
  assert.match(readme, /REVIEW_BRIDGE_HOME/);
  assert.match(readme, /hermes-integration/);
  assert.match(readme, /CODEX_TASK/);
  assert.match(readme, /configured.*provenance.*not cryptographic/is);
  assert.match(readme, /local HERMES gate passes/i);
  assert.match(readme, /author\/publication-side operation/i);
  assert.match(changelog, /Hermes/i);
  assert.match(changelog, /hermes-integration|profile/);
});

test("root README provider isolation covers Hermes in security and troubleshooting", async () => {
  const readme = await readRequired("README.md");
  const security = readme.match(
    /## Security and scope(?<body>[\s\S]*?)\n## /,
  );
  const troubleshooting = readme.match(
    /## Troubleshooting(?<body>[\s\S]*?)\n## /,
  );
  assert.ok(security, "Security and scope section is missing");
  assert.ok(troubleshooting, "Troubleshooting section is missing");

  for (const [name, section] of [
    ["Security and scope", security.groups.body],
    ["Troubleshooting", troubleshooting.groups.body],
  ]) {
    for (const provider of ["CLAUDE_DESKTOP", "CODEX_TASK", "HERMES"]) {
      assert.ok(
        section.includes("`" + provider + "`"),
        `${name} omits ${provider}`,
      );
    }
  }

  assert.match(
    security.groups.body,
    /mismatched reviewer processes cannot list, read, or submit it/i,
  );
  assert.match(
    troubleshooting.groups.body,
    /immutably bound to\s+one provider[\s\S]*?reviewer cannot list\s+or open\s+a review bound to either of the other providers/i,
  );
  assert.match(
    readme,
    /Autonomous local task creation remains `CODEX_TASK`-only\./,
  );
});
