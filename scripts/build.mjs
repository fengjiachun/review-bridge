import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = process.env.REVIEW_BRIDGE_OUTPUT_ROOT
  ? path.resolve(process.env.REVIEW_BRIDGE_OUTPUT_ROOT)
  : path.join(projectRoot, "dist", "review-bridge-v0.4.1");
const codexMarketplace = path.join(outputRoot, "codex-marketplace");
const codexPlugin = path.join(codexMarketplace, "plugins", "review-bridge");
const claudeSource = path.join(outputRoot, "claude-extension-source");
const mcpbOutput = path.join(outputRoot, "review-bridge-reviewer-v0.4.1.mcpb");
const dxtOutput = path.join(outputRoot, "review-bridge-reviewer-v0.4.1.dxt");
const sourceOutput = path.join(outputRoot, "review-bridge-source-v0.4.1.zip");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  if (result.stdout.trim()) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.trim()) {
    process.stderr.write(result.stderr);
  }
  return result.stdout;
}

async function installRuntime(target) {
  const runtimePackage = {
    name: "review-bridge-runtime",
    version: "0.4.1",
    private: true,
    type: "module",
    dependencies: {
      "@modelcontextprotocol/sdk": "1.29.0",
      zod: "3.25.76",
    },
    overrides: {
      "@hono/node-server": "2.0.11",
    },
    engines: { node: ">=18" },
  };
  await fsp.writeFile(
    path.join(target, "package.json"),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
  );
  run(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    target,
  );
}

async function copyServer(target) {
  const serverTarget = path.join(target, "server");
  await fsp.mkdir(serverTarget, { recursive: true });
  await fsp.copyFile(
    path.join(projectRoot, "src", "server.mjs"),
    path.join(serverTarget, "server.mjs"),
  );
  await fsp.copyFile(
    path.join(projectRoot, "src", "core.mjs"),
    path.join(serverTarget, "core.mjs"),
  );
  await fsp.copyFile(
    path.join(projectRoot, "src", "storage.mjs"),
    path.join(serverTarget, "storage.mjs"),
  );
  await fsp.copyFile(
    path.join(projectRoot, "src", "publication.mjs"),
    path.join(serverTarget, "publication.mjs"),
  );
  await fsp.copyFile(
    path.join(projectRoot, "src", "github-adapter.mjs"),
    path.join(serverTarget, "github-adapter.mjs"),
  );
  await fsp.copyFile(
    path.join(projectRoot, "src", "github-observation.mjs"),
    path.join(serverTarget, "github-observation.mjs"),
  );
}

const workingTreeStatus = run(
  "git",
  ["status", "--porcelain", "--untracked-files=all"],
  projectRoot,
);
if (workingTreeStatus.trim()) {
  throw new Error(
    "refusing to build from a dirty working tree; commit or stash changes first",
  );
}

await fsp.rm(outputRoot, { recursive: true, force: true });
await fsp.mkdir(outputRoot, { recursive: true });

await fsp.cp(path.join(projectRoot, "templates", "codex-plugin"), codexPlugin, {
  recursive: true,
});
await fsp.copyFile(path.join(projectRoot, "LICENSE"), path.join(codexPlugin, "LICENSE"));
await copyServer(codexPlugin);
await installRuntime(codexPlugin);
await fsp.mkdir(path.join(codexMarketplace, ".agents", "plugins"), {
  recursive: true,
});
await fsp.writeFile(
  path.join(codexMarketplace, ".agents", "plugins", "marketplace.json"),
  `${JSON.stringify(
    {
      name: "review-bridge-local",
      interface: { displayName: "Review Bridge Local" },
      plugins: [
        {
          name: "review-bridge",
          source: { source: "local", path: "./plugins/review-bridge" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Developer Tools",
        },
      ],
    },
    null,
    2,
  )}\n`,
);

await fsp.cp(
  path.join(projectRoot, "templates", "claude-extension"),
  claudeSource,
  { recursive: true },
);
await fsp.copyFile(path.join(projectRoot, "LICENSE"), path.join(claudeSource, "LICENSE"));
await copyServer(claudeSource);
await installRuntime(claudeSource);

const mcpbCli = path.join(projectRoot, "node_modules", ".bin", "mcpb");
run(mcpbCli, ["validate", claudeSource], projectRoot);
run(mcpbCli, ["pack", claudeSource, mcpbOutput], projectRoot);
await fsp.copyFile(mcpbOutput, dxtOutput);

await fsp.copyFile(path.join(projectRoot, "README.md"), path.join(outputRoot, "README.md"));
run(
  "git",
  ["archive", "--format=zip", "-o", sourceOutput, "HEAD"],
  projectRoot,
);

const checksumFiles = [mcpbOutput, dxtOutput, sourceOutput];
const checksumLines = [];
for (const filePath of checksumFiles) {
  const digest = crypto
    .createHash("sha256")
    .update(await fsp.readFile(filePath))
    .digest("hex");
  checksumLines.push(`${digest}  ${path.basename(filePath)}`);
}
await fsp.writeFile(
  path.join(outputRoot, "SHA256SUMS.txt"),
  `${checksumLines.join("\n")}\n`,
);
process.stdout.write(`Built ${outputRoot}\n`);
