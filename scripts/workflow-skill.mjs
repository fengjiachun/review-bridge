import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";

// Validation reads every reachable document; drivers load only their selected route.
export async function readWorkflowDocuments(entrypoint) {
  const root = path.dirname(path.resolve(entrypoint));
  const documents = new Map();
  async function visit(relative) {
    if (documents.has(relative)) return;
    const text = await fsp.readFile(path.join(root, relative), "utf8");
    documents.set(relative, text);
    for (const [, target] of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
      const resolved = path.resolve(root, path.dirname(relative), target);
      assert.ok(resolved.startsWith(`${root}${path.sep}`), `skill link escapes root: ${target}`);
      await visit(path.relative(root, resolved));
    }
  }
  await visit("SKILL.md");
  for (const name of await fsp.readdir(path.join(root, "references"))) {
    if (name.endsWith(".md")) {
      assert.ok(documents.has(path.join("references", name)), `unreachable workflow reference: ${name}`);
    }
  }
  return documents;
}

export async function readWorkflowSkill(entrypoint) {
  const documents = await readWorkflowDocuments(entrypoint);
  // Existing prose contracts inspect labels independently of Markdown link syntax.
  return [...documents.values()].join("\n\n").replace(/\[([^\]]+)\]\([^)]+\.md\)/g, "$1");
}
