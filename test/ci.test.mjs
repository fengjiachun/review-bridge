import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("release metadata stays aligned with package.json", async () => {
  const [workflow, security, packageJson, plugin, extension] = await Promise.all([
    fsp.readFile(
      path.join(projectRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    ),
    fsp.readFile(path.join(projectRoot, "SECURITY.md"), "utf8"),
    fsp
      .readFile(path.join(projectRoot, "package.json"), "utf8")
      .then(JSON.parse),
    fsp
      .readFile(
        path.join(
          projectRoot,
          "templates",
          "codex-plugin",
          ".codex-plugin",
          "plugin.json",
        ),
        "utf8",
      )
      .then(JSON.parse),
    fsp
      .readFile(
        path.join(
          projectRoot,
          "templates",
          "claude-extension",
          "manifest.json",
        ),
        "utf8",
      )
      .then(JSON.parse),
  ]);
  assert.match(
    workflow,
    /id: package\s+run: .*require\('\.\/package\.json'\)\.version/,
  );
  assert.match(
    workflow,
    /path: dist\/review-bridge-v\$\{\{ steps\.package\.outputs\.version \}\}/,
  );
  assert.match(workflow, /if-no-files-found: error/);
  const supportedSeries = packageJson.version.split(".").slice(0, 2).join(".");
  assert.ok(
    security.includes(`Only the latest \`${supportedSeries}.x\` release`),
  );
  assert.equal(plugin.version, packageJson.version);
  assert.equal(extension.version, packageJson.version);
});
