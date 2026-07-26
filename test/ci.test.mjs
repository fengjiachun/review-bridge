import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("CI derives its required artifact path from package.json", async () => {
  const workflow = await fsp.readFile(
    path.join(projectRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /id: package\s+run: .*require\('\.\/package\.json'\)\.version/,
  );
  assert.match(
    workflow,
    /path: dist\/review-bridge-v\$\{\{ steps\.package\.outputs\.version \}\}/,
  );
  assert.match(workflow, /if-no-files-found: error/);
});
