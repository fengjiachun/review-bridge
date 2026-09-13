import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readWorkflowDocuments } from "../scripts/workflow-skill.mjs";

const root = fileURLToPath(new URL(
  "../templates/codex-plugin/skills/review-bridge-workflow/", import.meta.url,
));

test("manual preparation routes to each provider without loading other playbooks", async () => {
  const docs = await readWorkflowDocuments(path.join(root, "SKILL.md"));
  const entry = docs.get("SKILL.md");
  const prepare = docs.get("references/prepare.md");
  assert.match(entry, /Read only that route/);
  assert.match(entry, /\[Prepare\]\(references\/prepare\.md\)/);
  for (const provider of ["codex-task", "hermes", "deepseek-harness", "claude-desktop"]) {
    assert.ok(prepare.includes(`](${provider}.md)`));
    const route = `${entry}\n${prepare}\n${docs.get(`references/${provider}.md`)}`;
    assert.doesNotMatch(route, /start_autonomous_workflow|start_publication|```bash\nnode .*advisory-sandbox-launch/);
    for (const [other, launch] of [["codex-task", "codex exec --"], ["hermes", "hermes -p"], ["deepseek-harness", "dsh --profile"]]) {
      if (provider !== other) assert.ok(!route.includes(launch), `${provider} loads ${other}'s launch`);
    }
  }
  assert.match(docs.get("references/advisory-panel.md"), /\[CODEX_TASK sandbox\]\(codex-advisory\.md\)/);
  assert.match(docs.get("references/autonomous.md"), /\[Publish through GitHub\]\(publication\.md\)/);
  for (const [name, text] of docs) {
    for (const [, helper] of text.matchAll(/\.\.\/\.\.\/scripts\/([\w-]+\.mjs)/g)) {
      await fsp.access(path.resolve(root, "../../scripts", helper));
      assert.match(text, /Resolve all `\.\.\/\.\.\/scripts\/` helper paths from the directory containing/,
        `${name} must anchor helper paths to the entrypoint`);
    }
  }
});

test("a fresh findings route includes the cleanup required before its fix commit", async () => {
  const entry = await fsp.readFile(path.join(root, "SKILL.md"), "utf8");
  const findings = await fsp.readFile(path.join(root, "references", "findings.md"), "utf8");
  const route = `${entry}\n${findings}`.replace(/\s+/g, " ");
  assert.match(route, /remove comments that do not state a constraint the code cannot express/);
  assert.match(route, /remove tests that no behavior change can turn red/);
  assert.match(route, /fix commits before rereview/);
});

test("waiting keeps ledger revisions separate from cadence and local timeouts", async () => {
  const docs = await readWorkflowDocuments(path.join(root, "SKILL.md"));
  const entry = docs.get("SKILL.md").replace(/\s+/g, " ");
  assert.match(entry, /Unchanged observations do not advance the workflow revision/);
  assert.match(entry, /Prefer supported state-change waits or long polling/);
  assert.match(entry, /back off.*respect rate-limit and retry signals.*reset the cadence/);
  assert.match(entry, /25 seconds by default and accepts at most 30 seconds/);
  assert.match(entry, /call again with the same `state_version` until `changed` is true/);
  assert.match(entry, /timeout is neither a failed review nor proof that its reviewer has exited/);
  assert.match(docs.get("references/publication.md"), /shared waiting rules in \[the entrypoint\]/);
  assert.match(docs.get("references/autonomous.md"), /back off on\s+unchanged results/);
});

test("reference validation rejects broken routes and unreachable files", async (t) => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), "workflow-skill-"));
  t.after(() => fsp.rm(fixture, { recursive: true, force: true }));
  await fsp.mkdir(path.join(fixture, "references"));
  await fsp.writeFile(path.join(fixture, "SKILL.md"), "[Prepare](references/missing.md)\n");
  await assert.rejects(readWorkflowDocuments(path.join(fixture, "SKILL.md")), { code: "ENOENT" });
  await fsp.writeFile(path.join(fixture, "SKILL.md"), "# No routes\n");
  await fsp.writeFile(path.join(fixture, "references", "orphan.md"), "# Orphan\n");
  await assert.rejects(readWorkflowDocuments(path.join(fixture, "SKILL.md")), /unreachable workflow reference: orphan.md/);
});
