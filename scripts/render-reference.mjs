#!/usr/bin/env node
// Renders docs/reference.md from the source: the tools each server role
// registers, and the error codes src/ raises. test/render-reference.test.mjs
// fails when the committed page and a fresh rendering differ.

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REFERENCE_PATH = path.join(projectRoot, "docs", "reference.md");
const LITERAL = /^"([A-Z][A-Z0-9_]{2,})"$/;

async function listTools(role, store) {
  const args = [path.join(projectRoot, "src", "server.mjs"), "--role", role];
  if (role === "reviewer") {
    // Every provider registers the same reviewer tools; the binding differs.
    args.push("--reviewer-provider", "CODEX_TASK");
  }
  const client = new Client({ name: "render-reference", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args,
      env: { ...process.env, REVIEW_BRIDGE_HOME: store },
      stderr: "ignore",
    }),
  );
  try {
    return (await client.listTools()).tools
      .map((tool) => ({
        name: tool.name,
        summary: /^.*?\.(?=\s|$)/s.exec(tool.description)?.[0] ?? tool.description,
        required: tool.inputSchema.required ?? [],
      }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  } finally {
    await client.close();
  }
}

// The top-level comma-separated arguments of the call whose "(" is at `open`.
function callArguments(text, open) {
  const parts = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      const close = text.indexOf(char, index + 1);
      index = close < 0 ? text.length : close;
    } else if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth -= 1;
      if (depth === 0) {
        parts.push(text.slice(start, index));
        return parts.map((part) => part.trim());
      }
    } else if (char === "," && depth === 1) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return parts.map((part) => part.trim());
}

// A code is a literal passed where a function or constructor declares a
// parameter named `code`, a literal assigned to an error's `code`, or a value
// a `*ErrorCode` lookup returns.
export function scanErrorCodes(sources) {
  const raisers = new Map();
  for (const text of Object.values(sources)) {
    for (const match of text.matchAll(
      /(?:function\s+([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+)[^{]*\{\s*constructor)\s*\(([^)]*)\)/g,
    )) {
      const position = match[3].split(",").map((name) => name.trim()).indexOf("code");
      if (position >= 0) {
        raisers.set(match[1] ?? match[2], position);
      }
    }
  }
  const codes = new Map();
  const add = (code, file) => {
    if (!codes.has(code)) {
      codes.set(code, new Set());
    }
    codes.get(code).add(file);
  };
  for (const [file, text] of Object.entries(sources)) {
    for (const [name, position] of raisers) {
      for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${name}\\(`, "g"))) {
        if (/(?:function|class)\s+$/.test(text.slice(0, match.index))) {
          continue;
        }
        const argument = callArguments(text, match.index + name.length)[position];
        const code = LITERAL.exec(argument ?? "")?.[1];
        if (code != null) {
          add(code, file);
        }
      }
    }
    for (const match of text.matchAll(/\.code\s*=(?!=)([^;]*);/g)) {
      for (const literal of match[1].matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) {
        add(literal[1], file);
      }
    }
    for (const match of text.matchAll(/function\s+\w*ErrorCode\([^)]*\)\s*\{([\s\S]*?)\n\}/g)) {
      for (const literal of match[1].matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) {
        add(literal[1], file);
      }
    }
  }
  return [...codes]
    .map(([code, files]) => ({ code, files: [...files].sort() }))
    .sort((left, right) => (left.code < right.code ? -1 : 1));
}

const cell = (value) => value.replace(/\s+/g, " ").replaceAll("|", "\\|");

export async function renderReference() {
  const version = JSON.parse(
    await fsp.readFile(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
  const srcRoot = path.join(projectRoot, "src");
  const sources = {};
  for (const name of (await fsp.readdir(srcRoot)).filter((file) => file.endsWith(".mjs")).sort()) {
    sources[`src/${name}`] = await fsp.readFile(path.join(srcRoot, name), "utf8");
  }
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-reference-"));
  let roles;
  try {
    roles = [
      ["Author tools", "--role author", await listTools("author", store)],
      ["Reviewer tools", "--role reviewer", await listTools("reviewer", store)],
    ];
  } finally {
    await fsp.rm(store, { recursive: true, force: true });
  }
  const lines = [
    "# Reference",
    "",
    `Describes Review Bridge v${version}.`,
    "",
    "Generated by `node scripts/render-reference.mjs` from the tools `src/server.mjs`",
    "registers and the error codes `src/` raises. Do not edit it by hand.",
    "",
  ];
  for (const [heading, flag, tools] of roles) {
    lines.push(
      `## ${heading}`,
      "",
      `The server started with \`${flag}\`. The summary is the first sentence of each tool's description.`,
      "",
      "| Tool | Summary | Required inputs |",
      "| --- | --- | --- |",
      ...tools.map(
        (tool) =>
          `| \`${tool.name}\` | ${cell(tool.summary)} | ${tool.required.map((field) => `\`${field}\``).join(", ")} |`,
      ),
      "",
    );
  }
  lines.push(
    "## Error codes",
    "",
    "A failed tool call returns one of these in its `code` field.",
    "A code is listed when `src/` passes it as a literal where a function or constructor declares a `code` parameter,",
    "assigns it as a literal to an error's `code`, or returns it from a `*ErrorCode` lookup.",
    "A code chosen at run time from a variable is not seen.",
    "",
    "| Code | Raised in |",
    "| --- | --- |",
    ...scanErrorCodes(sources).map(
      (entry) => `| \`${entry.code}\` | ${entry.files.map((file) => `\`${file}\``).join(", ")} |`,
    ),
  );
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fsp.writeFile(REFERENCE_PATH, await renderReference());
}
