import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import test from "node:test";
import {
  REFERENCE_PATH,
  renderReference,
  scanErrorCodes,
} from "../scripts/render-reference.mjs";

test("docs/reference.md is what the source renders", async () => {
  assert.equal(
    await fsp.readFile(REFERENCE_PATH, "utf8"),
    await renderReference(),
    "docs/reference.md is stale; run node scripts/render-reference.mjs",
  );
});

test("an error code is a literal in a declared code position", () => {
  const codes = scanErrorCodes({
    "src/a.mjs": `
function fail(code, message) { throw new Error(message); }
function parse(content, code, message) { fail(code, message); }
function lockErrorCode(domain) {
  return { review: "REVIEW_BUSY" }[domain];
}
fail("DIRECT_CODE", "x", { status: "NOT_A_CODE" });
parse(bytes, "FORWARDED_CODE", "y");
parse("NOT_A_CODE_EITHER", code, "z");
fail(code, "chosen at run time");
combined.code = releaseError?.code ?? "ASSIGNED_CODE";
if (error?.code === "COMPARED_NOT_RAISED") {}
`,
    "src/b.mjs": `class StoreError extends Error {
  constructor(code, message) { super(message); }
}
throw new StoreError(
  "MULTILINE_CODE",
  \`\${path} (see "NOT_A_CODE")\`,
);
fail("DIRECT_CODE", "again");
`,
  });
  assert.deepEqual(codes, [
    { code: "ASSIGNED_CODE", files: ["src/a.mjs"] },
    { code: "DIRECT_CODE", files: ["src/a.mjs", "src/b.mjs"] },
    { code: "FORWARDED_CODE", files: ["src/a.mjs"] },
    { code: "MULTILINE_CODE", files: ["src/b.mjs"] },
    { code: "REVIEW_BUSY", files: ["src/a.mjs"] },
  ]);
});
