import path from "node:path";

const INDENT_WIDTH = 2;
const PLACEHOLDER = /__[A-Z][A-Z0-9_]*__/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function syntaxError(line, message) {
  const location = line ? ` at line ${line.number}` : "";
  return new Error(`invalid Hermes MCP snippet${location}: ${message}`);
}

function stripComment(raw, number) {
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'" && raw[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (
      character === "#" &&
      (index === 0 || /\s/.test(raw[index - 1]))
    ) {
      return raw.slice(0, index);
    }
  }
  if (quote !== null) {
    throw syntaxError({ number }, "unterminated quoted scalar");
  }
  return raw;
}

function parseQuotedScalar(value, line) {
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) {
      throw syntaxError(line, "unexpected content after double-quoted scalar");
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw syntaxError(line, "invalid double-quoted scalar");
    }
  }

  if (!value.endsWith("'")) {
    throw syntaxError(line, "unexpected content after single-quoted scalar");
  }
  let parsed = "";
  const inner = value.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] !== "'") {
      parsed += inner[index];
      continue;
    }
    if (inner[index + 1] !== "'") {
      throw syntaxError(line, "invalid single-quoted scalar");
    }
    parsed += "'";
    index += 1;
  }
  return parsed;
}

function parseScalar(value, line) {
  if (value === "") throw syntaxError(line, "empty scalar");
  if (value.startsWith('"') || value.startsWith("'")) {
    return parseQuotedScalar(value, line);
  }
  if (value.includes('"') || value.includes("'")) {
    throw syntaxError(line, "quotes are supported only around a whole scalar");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (NUMBER.test(value)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw syntaxError(line, "numeric scalar must be finite");
    }
    return parsed;
  }
  if (/^(?:true|false|null|yes|no|on|off)$/i.test(value) || value === "~") {
    throw syntaxError(line, `unsupported typed scalar: ${value}`);
  }
  if (
    /^[+-]?(?:\d|\.\d)/.test(value) ||
    /^\.(?:inf|nan)$/i.test(value)
  ) {
    throw syntaxError(line, `unsupported numeric scalar: ${value}`);
  }
  if (
    /^(?:[-?:]$|[,\[\]{}#&*!|>@%`])/.test(value) ||
    value === "---" ||
    value === "..."
  ) {
    throw syntaxError(line, `unsupported YAML syntax: ${value}`);
  }
  if (/:($|\s)/.test(value)) {
    throw syntaxError(line, "nested mappings must use an indented block");
  }
  if (/\s/.test(value)) {
    throw syntaxError(line, "plain strings cannot contain whitespace");
  }
  return value;
}

// Parse only the Review Bridge-owned snippet grammar: mappings with unquoted
// identifier keys, nested by exactly two spaces, and lists whose items are
// scalars or mappings. Unsupported YAML features are rejected instead of
// approximated. Both packaged snippet shapes parse here — the Hermes
// `mcp_servers` mapping and the DeepSeek Harness cordis patch array.
export function parseMcpSnippet(text) {
  const lines = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const number = index + 1;
    if (raw.includes("\t")) {
      throw syntaxError({ number }, "tabs are not allowed");
    }
    const withoutComment = stripComment(raw, number).trimEnd();
    if (withoutComment.trim() === "") continue;
    const indent = withoutComment.match(/^ */)[0].length;
    if (indent % INDENT_WIDTH !== 0) {
      throw syntaxError(
        { number },
        `indentation must use exact ${INDENT_WIDTH}-space levels`,
      );
    }
    const text = withoutComment.slice(indent);
    // A block-sequence item holding a mapping puts that mapping's first key on
    // the dash line. Split it into a sequence marker plus an ordinary mapping
    // line one level in, so the block parsers below need no second notion of
    // where a nested mapping starts.
    if (/^- [A-Za-z0-9_-]+:(?: |$)/.test(text)) {
      lines.push({ indent, number, text: "-", sequence: true });
      lines.push({
        indent: indent + INDENT_WIDTH,
        number,
        text: text.slice(2),
      });
      continue;
    }
    lines.push({ indent, number, text });
  }
  if (lines.length === 0) throw syntaxError(null, "snippet is empty");
  if (lines[0].indent !== 0) {
    throw syntaxError(lines[0], "the root collection must start at column 1");
  }

  let position = 0;
  const isListItem = (line) =>
    line.sequence === true || /^-(?: |$)/.test(line.text);

  function parseBlock(expectedIndent) {
    const first = lines[position];
    if (!first || first.indent !== expectedIndent) {
      throw syntaxError(
        first,
        `expected a collection at indentation ${expectedIndent}`,
      );
    }
    return isListItem(first)
      ? parseList(expectedIndent)
      : parseMapping(expectedIndent);
  }

  function parseList(expectedIndent) {
    const values = [];
    while (position < lines.length) {
      const line = lines[position];
      if (line.indent < expectedIndent) break;
      if (line.indent > expectedIndent) {
        throw syntaxError(line, "list item is over-indented");
      }
      if (!isListItem(line)) {
        throw syntaxError(line, "cannot mix mapping and list entries");
      }
      if (line.sequence) {
        position += 1;
        values.push(parseBlock(expectedIndent + INDENT_WIDTH));
        continue;
      }
      if (!line.text.startsWith("- ") || line.text.slice(2).startsWith(" ")) {
        throw syntaxError(line, "list items require one space after '-'");
      }
      const scalar = line.text.slice(2);
      if (
        !scalar.startsWith('"') &&
        !scalar.startsWith("'") &&
        /^[A-Za-z0-9_-]+\s*:/.test(scalar)
      ) {
        throw syntaxError(line, "lists may contain scalar values only");
      }
      values.push(parseScalar(scalar, line));
      position += 1;
      if (
        position < lines.length &&
        lines[position].indent > expectedIndent
      ) {
        throw syntaxError(lines[position], "list scalars cannot have children");
      }
    }
    return values;
  }

  function parseMapping(expectedIndent) {
    const mapping = {};
    while (position < lines.length) {
      const line = lines[position];
      if (line.indent < expectedIndent) break;
      if (line.indent > expectedIndent) {
        throw syntaxError(line, "mapping entry is over-indented");
      }
      if (isListItem(line)) {
        throw syntaxError(line, "cannot mix mapping and list entries");
      }
      const colon = line.text.indexOf(":");
      if (colon <= 0) {
        throw syntaxError(line, "mapping entry requires a key and ':'");
      }
      const key = line.text.slice(0, colon);
      if (!/^[A-Za-z0-9_-]+$/.test(key)) {
        throw syntaxError(line, `unsupported mapping key: ${key}`);
      }
      if (Object.hasOwn(mapping, key)) {
        throw syntaxError(line, `duplicate key: ${key}`);
      }

      const remainder = line.text.slice(colon + 1);
      if (remainder !== "" && !remainder.startsWith(" ")) {
        throw syntaxError(line, "mapping values require one space after ':'");
      }
      let value;
      if (remainder === "") {
        position += 1;
        const child = lines[position];
        if (!child || child.indent <= expectedIndent) {
          throw syntaxError(line, `key ${key} requires a nested value`);
        }
        if (child.indent !== expectedIndent + INDENT_WIDTH) {
          throw syntaxError(
            child,
            `nested value must be indented exactly ${INDENT_WIDTH} spaces`,
          );
        }
        value = parseBlock(expectedIndent + INDENT_WIDTH);
      } else {
        if (remainder.slice(1).startsWith(" ")) {
          throw syntaxError(line, "mapping values require one space after ':'");
        }
        value = parseScalar(remainder.slice(1), line);
        position += 1;
        if (
          position < lines.length &&
          lines[position].indent > expectedIndent
        ) {
          throw syntaxError(lines[position], `scalar key ${key} cannot have children`);
        }
      }
      Object.defineProperty(mapping, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    return mapping;
  }

  const parsed = parseBlock(0);
  if (position !== lines.length) {
    throw syntaxError(lines[position], "unconsumed input");
  }
  return parsed;
}

function renderValue(value, replacements) {
  if (typeof value === "string") {
    return value
      .replaceAll("__REVIEW_BRIDGE_RELEASE_PATH__", replacements.releasePath)
      .replaceAll("__REVIEW_BRIDGE_HOME__", replacements.reviewBridgeHome);
  }
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, replacements));
  }
  if (!value || typeof value !== "object") {
    throw new Error("Hermes MCP config contains an unsupported value type");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (PLACEHOLDER.test(key)) {
        throw new Error(`unresolved Hermes MCP placeholder in key: ${key}`);
      }
      return [key, renderValue(item, replacements)];
    }),
  );
}

function assertNoPlaceholder(value) {
  if (typeof value === "string" && PLACEHOLDER.test(value)) {
    throw new Error(`unresolved Hermes MCP placeholder: ${value}`);
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoPlaceholder);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(assertNoPlaceholder);
  }
}

export function renderAndValidateHermesServerConfig(
  serverConfig,
  { releasePath, reviewBridgeHome },
) {
  if (typeof releasePath !== "string" || !path.isAbsolute(releasePath)) {
    throw new Error("Hermes exact release path must be absolute");
  }
  if (
    typeof reviewBridgeHome !== "string" ||
    !path.isAbsolute(reviewBridgeHome)
  ) {
    throw new Error("REVIEW_BRIDGE_HOME must be absolute");
  }

  const rendered = renderValue(serverConfig, {
    releasePath,
    reviewBridgeHome,
  });
  assertNoPlaceholder(rendered);

  if (rendered.command !== "node") {
    throw new Error("Hermes MCP server command must be node");
  }
  if (!Array.isArray(rendered.args) || rendered.args.some((arg) => typeof arg !== "string")) {
    throw new Error("Hermes MCP server args must be a list of strings");
  }
  const expectedServerPath = path.join(releasePath, "server", "server.mjs");
  if (
    rendered.args[0] !== expectedServerPath ||
    !path.isAbsolute(rendered.args[0])
  ) {
    throw new Error("Hermes MCP server path must use the exact absolute release path");
  }
  if (
    !rendered.env ||
    rendered.env.REVIEW_BRIDGE_HOME !== reviewBridgeHome ||
    !path.isAbsolute(rendered.env.REVIEW_BRIDGE_HOME)
  ) {
    throw new Error("rendered REVIEW_BRIDGE_HOME must be the exact absolute path");
  }
  if (typeof rendered.enabled !== "boolean") {
    throw new Error("Hermes enabled must be a boolean");
  }
  for (const field of ["timeout", "connect_timeout"]) {
    if (typeof rendered[field] !== "number" || !Number.isFinite(rendered[field])) {
      throw new Error(`Hermes ${field} must be a finite number`);
    }
  }
  for (const field of ["resources", "prompts"]) {
    if (
      rendered.tools &&
      Object.hasOwn(rendered.tools, field) &&
      typeof rendered.tools[field] !== "boolean"
    ) {
      throw new Error(`Hermes tools.${field} must be a boolean`);
    }
  }
  return rendered;
}

// The DeepSeek Harness snippets are cordis patch layers, so the packaged file
// is an entry array rather than a server mapping. Pull the one MCP client
// entry out of it, rejecting a snippet that declares more than one — a second
// client entry is how the opposite role's server would reach the profile.
export function deepSeekHarnessClientEntry(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("DeepSeek Harness patch snippet must be an entry array");
  }
  const inserted = entries.flatMap((entry) =>
    Array.isArray(entry?.insert) ? entry.insert : [],
  );
  const clients = inserted.filter(
    (entry) => entry?.name === "@deepseek-ai/dsh-mcp-client",
  );
  if (clients.length !== 1) {
    throw new Error(
      `DeepSeek Harness patch snippet must insert exactly one MCP client, found ${clients.length}`,
    );
  }
  return clients[0];
}

export function renderAndValidateDeepSeekHarnessClient(
  entry,
  { releasePath, reviewBridgeHome },
) {
  if (typeof releasePath !== "string" || !path.isAbsolute(releasePath)) {
    throw new Error("DeepSeek Harness exact release path must be absolute");
  }
  if (
    typeof reviewBridgeHome !== "string" ||
    !path.isAbsolute(reviewBridgeHome)
  ) {
    throw new Error("REVIEW_BRIDGE_HOME must be absolute");
  }

  const rendered = renderValue(entry, { releasePath, reviewBridgeHome });
  assertNoPlaceholder(rendered);

  const config = rendered.config;
  if (!config || typeof config !== "object") {
    throw new Error("DeepSeek Harness MCP client entry requires a config");
  }
  // A network transport would take the reviewer's tools off this machine and
  // out of the operator's sight, so the packaged snippet may only spawn the
  // packaged server over stdio.
  if (config.transport !== "stdio") {
    throw new Error("DeepSeek Harness MCP client transport must be stdio");
  }
  for (const field of ["url", "headers"]) {
    if (Object.hasOwn(config, field)) {
      throw new Error(`stdio DeepSeek Harness client cannot set ${field}`);
    }
  }
  if (typeof config.serverName !== "string" || config.serverName === "") {
    throw new Error("DeepSeek Harness serverName must be a non-empty string");
  }
  if (config.command !== "node") {
    throw new Error("DeepSeek Harness MCP server command must be node");
  }
  if (
    !Array.isArray(config.args) ||
    config.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error("DeepSeek Harness MCP server args must be a list of strings");
  }
  const expectedServerPath = path.join(releasePath, "server", "server.mjs");
  if (config.args[0] !== expectedServerPath) {
    throw new Error(
      "DeepSeek Harness MCP server path must use the exact absolute release path",
    );
  }
  if (
    !config.env ||
    config.env.REVIEW_BRIDGE_HOME !== reviewBridgeHome ||
    !path.isAbsolute(config.env.REVIEW_BRIDGE_HOME)
  ) {
    throw new Error("rendered REVIEW_BRIDGE_HOME must be the exact absolute path");
  }
  // Without this the client activates with no tools when the server fails to
  // start, leaving a reviewer that improvises instead of stopping.
  if (config.failOnStartupError !== true) {
    throw new Error("DeepSeek Harness client must fail on startup error");
  }
  return rendered;
}
