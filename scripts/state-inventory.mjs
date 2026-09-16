#!/usr/bin/env node
// The state-space inventory (#145 phase 1). It measures; it deletes nothing.
//
// For every SCREAMING_CASE string literal in src/ it reports where the value is
// defined, produced and consumed, how often it appears in a real store and in
// the tests, and whether any path from a tool surface -- the server module and
// the packaged scripts -- reaches a unit that produces it. With --coverage it
// also reports whether a run actually executed each producer line, which is how
// the declared walk (test/required-inputs-walk.test.mjs) contributes: a line the
// walk executed is reachable by evidence rather than by inference.
//
// Blind spots, restated in the rendered report so no reader has to open this
// file to learn them:
//
//   - The universe is exact quoted literals. A value reached through a regex, a
//     prefix, a template, or a computed key is invisible here.
//   - Roles come from the text around the literal, not from a parse. A literal
//     whose role cannot be read is called ambiguous and counted as producer
//     evidence: a wrong "unreachable" is the expensive error, so every doubt
//     resolves towards reachable.
//   - Call edges are name matches, not resolved bindings, so same-named
//     functions in different files merge. That over-connects the graph, which
//     again only widens what counts as reachable.
//   - The store is one machine's history. Absence corroborates and proves
//     nothing; presence proves the value happens, so a store hit overrides an
//     unreachable verdict and is reported as a defect of this instrument.

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONSTANT = /"([A-Z][A-Z0-9_]{2,})"/g;
const UNIT_START =
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/;
// A CRLF checkout leaves "\r" on every split line; the text itself is kept
// raw so coverage offsets still line up, and the boundary tolerates it.
// A unit closes on a line that is only closers: "}" for a function, "});"
// for an arrow returning a parenthesized object, "]);" for a table.
const UNIT_END = /^[}\)\]]+[;,]?\r?$/;
const MODULE_UNIT = "<module>";
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// Ledger files this inventory reads. Everything else under the store -- the
// snapshots, the patches, the reviewer's prose -- belongs to the repositories
// under review and would count their words as our states.
const LEDGER_FILES = new Set([
  "review.json",
  "publication.json",
  "publication-gate.json",
  "gate.json",
  "remote-authorization.json",
  "observation.json",
  "workflow-binding.json",
  "workflow.json",
]);

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--project") args.project = argv[++i];
    else if (argv[i] === "--store") args.store = argv[++i];
    else if (argv[i] === "--no-store") args.store = null;
    else if (argv[i] === "--coverage") args.coverage = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

// The default src/core.mjs resolves, inlined so the instrument imports nothing
// it measures.
function defaultStoreRoot() {
  if (process.env.REVIEW_BRIDGE_HOME) return path.resolve(process.env.REVIEW_BRIDGE_HOME);
  return path.join(os.homedir(), "Library", "Application Support", "ReviewBridge");
}

async function listFiles(dir, suffix, depth = 6) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) files.push(...(await listFiles(full, suffix, depth - 1)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(full);
  }
  return files.sort();
}

// A unit is a top-level function: the span from its declaration to the bracket
// that closes it in column zero. Nested helpers belong to the unit enclosing
// them. Lines outside every unit are the module body, which runs on import.
function unitsOf(text) {
  const lines = text.split("\n");
  const lineUnit = new Array(lines.length).fill(MODULE_UNIT);
  const spans = new Map();
  let current = null;
  lines.forEach((line, index) => {
    if (current == null) {
      const match = UNIT_START.exec(line);
      if (match) current = { name: match[1] ?? match[2], start: index + 1 };
    }
    if (current != null) {
      lineUnit[index] = current.name;
      if (index + 1 > current.start && UNIT_END.test(line)) {
        spans.set(current.name, { start: current.start, end: index + 1 });
        current = null;
      }
    }
  });
  if (current != null) spans.set(current.name, { start: current.start, end: lines.length });
  return { lines, lineUnit, spans };
}

// Where each character stands: the innermost bracket still open, and for a
// call the identifier that opened it. One pass per file, strings and comments
// skipped, so a value on its own line inside a multi-line table or a multi-line
// call is read in the right context.
function contextOf(text) {
  const opener = new Array(text.length).fill("");
  const callee = new Array(text.length).fill("");
  const stack = [];
  let mode = "code";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    opener[index] = stack.at(-1)?.ch ?? "";
    callee[index] = stack.at(-1)?.callee ?? "";
    if (mode === "code") {
      if (ch === "/" && text[index + 1] === "/") mode = "line";
      else if (ch === "/" && text[index + 1] === "*") mode = "block";
      else if (ch === '"' || ch === "'" || ch === "`") {
        mode = "string";
        quote = ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        const before = text.slice(Math.max(0, index - 60), index);
        stack.push({ ch, callee: ch === "(" ? /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1] ?? "" : "" });
      } else if (ch === ")" || ch === "]" || ch === "}") stack.pop();
    } else if (mode === "line") {
      if (ch === "\n") mode = "code";
    } else if (mode === "block") {
      if (ch === "*" && text[index + 1] === "/") {
        mode = "code";
        index += 1;
      }
    } else if (mode === "string") {
      if (ch === "\\") index += 1;
      else if (ch === quote) mode = "code";
    }
  }
  return { opener, callee };
}

const PRODUCER_ROLES = new Set(["producer", "refusal", "ambiguous"]);
const MEMBERSHIP = /^(includes|has|indexOf|startsWith|endsWith|match|test)$/;
const REFUSAL = /^(fail|refuse|reject)$|Error$/;

// Consumer shapes are tested first because they are the only unambiguous ones.
// A member of a list or set literal is a table entry -- matched against, not
// handed out -- and so is a schema literal, which declares what an operator may
// send. A code a refusal carries is kept apart from a value written into a
// ledger, because a guard that never fired and a state nothing ever entered are
// different findings. Everything left over counts as producer evidence, later
// call arguments included: publicationDecision(status, reason) hands both out.
function roleOf(before, after, opener, callee) {
  if (/(===|!==|==|!=)\s*$/.test(before)) return "consumer";
  if (/^\s*(===|!==|==|!=)/.test(after)) return "consumer";
  if (/\bcase\s*$/.test(before)) return "consumer";
  if (opener === "(" && MEMBERSHIP.test(callee)) return "consumer";
  if (opener === "(" && /^(literal|enum)$/.test(callee)) return "table";
  if (opener === "(" && REFUSAL.test(callee)) return "refusal";
  if (/\bthrow\b/.test(before)) return "refusal";
  if (/(^|[^=!<>])=\s*$/.test(before)) return "producer";
  if (/(:|\breturn|\bpush\(|\badd\(|\?\?)\s*$/.test(before)) return "producer";
  if (opener === "[") return "table";
  return "ambiguous";
}

async function scanSource(srcDir) {
  const files = await listFiles(srcDir, ".mjs", 0);
  const sites = [];
  const units = new Map();
  const texts = new Map();
  for (const file of files) {
    const name = path.basename(file);
    const text = await fsp.readFile(file, "utf8");
    texts.set(name, text);
    const { lines, lineUnit, spans } = unitsOf(text);
    const { opener, callee } = contextOf(text);
    for (const [unit, span] of spans) {
      units.set(`${name}:${unit}`, {
        file: name,
        unit,
        ...span,
        body: lines.slice(span.start - 1, span.end).join("\n"),
      });
    }
    units.set(`${name}:${MODULE_UNIT}`, {
      file: name,
      unit: MODULE_UNIT,
      start: 1,
      end: lines.length,
      body: lines.filter((_, index) => lineUnit[index] === MODULE_UNIT).join("\n"),
    });
    let offset = 0;
    lines.forEach((line, index) => {
      const lineStart = offset;
      offset += line.length + 1;
      for (const match of line.matchAll(CONSTANT)) {
        sites.push({
          name: match[1],
          file: name,
          line: index + 1,
          unit: lineUnit[index],
          role: roleOf(
            line.slice(0, match.index),
            line.slice(match.index + match[0].length),
            opener[lineStart + match.index],
            callee[lineStart + match.index],
          ),
          text: line.trim().slice(0, 200),
        });
      }
    });
  }
  return { files, sites, units, texts };
}

// Roots are the tool surfaces: the server module, and every packaged or
// operator script that imports the server modules. Every module body is a root
// too, because the server's import runs it, so only function units can fall
// outside the closure.
async function reachableUnits(project, srcDir, units) {
  const rootFiles = [path.join(srcDir, "server.mjs")];
  for (const dir of [path.join(project, "scripts"), path.join(project, "templates")]) {
    for (const file of await listFiles(dir, ".mjs")) {
      if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue;
      if (/from "\.\.\/(server|src)\//.test(await fsp.readFile(file, "utf8"))) rootFiles.push(file);
    }
  }
  const byName = new Map();
  for (const key of units.keys()) {
    const unit = key.slice(key.indexOf(":") + 1);
    byName.set(unit, [...(byName.get(unit) ?? []), key]);
  }
  const reachable = new Set();
  const queue = [];
  const admit = (key) => {
    if (reachable.has(key)) return;
    reachable.add(key);
    queue.push(key);
  };
  const admitWords = (text) => {
    for (const word of new Set(text.match(WORD) ?? [])) for (const key of byName.get(word) ?? []) admit(key);
  };
  for (const [key, span] of units) {
    if (span.unit === MODULE_UNIT || span.file === "server.mjs") admit(key);
  }
  for (const file of rootFiles) admitWords(await fsp.readFile(file, "utf8"));
  while (queue.length > 0) admitWords(units.get(queue.pop())?.body ?? "");
  return { reachable, rootFiles: rootFiles.map((file) => path.relative(project, file)) };
}

async function scanTests(testDir) {
  const counts = new Map();
  // Test modules are .mjs files and the extensionless helpers under
  // test/helpers, which the suites import by bare path; a fixture with any
  // other extension is data, not a module that names a state.
  const testModules = (await listFiles(testDir, "")).filter(
    (file) => file.endsWith(".mjs") || path.extname(file) === "",
  );
  for (const file of testModules) {
    for (const match of (await fsp.readFile(file, "utf8")).matchAll(CONSTANT)) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
  }
  return counts;
}

// Which lines of each source file a recorded run executed. V8 reports ranges
// per function in source string offsets -- not bytes, which matters wherever a
// comment carries an em dash -- and the innermost range covering an offset
// decides it, so ranges are painted widest first. The union across every
// coverage file is taken: a line any process ran is executed. Checked against
// the uncovered lines node --experimental-test-coverage prints for the same run.
async function scanCoverage(dir, texts, srcDir) {
  const executed = new Map();
  for (const [name, text] of texts) executed.set(name, new Uint8Array(text.length));
  // A script is one of ours only when its URL resolves to the project's own
  // src file. The suite copies src/ into temp directories and imports the
  // copies, so a basename match would credit the copy's hits to the original.
  // Node records a module's real path in coverage URLs, so a checkout reached
  // through a symlink would never match its own scripts: both sides are
  // canonicalised before they are compared.
  const own = new Map();
  for (const name of texts.keys()) {
    const file = path.resolve(srcDir, name);
    own.set(await fsp.realpath(file).catch(() => file), name);
  }
  for (const file of await listFiles(dir, ".json", 2)) {
    const report = JSON.parse(await fsp.readFile(file, "utf8"));
    for (const script of report.result ?? []) {
      let scriptPath;
      try {
        const resolved = script.url?.startsWith("file:") ? path.resolve(fileURLToPath(script.url)) : null;
        scriptPath = resolved == null ? null : await fsp.realpath(resolved).catch(() => resolved);
      } catch {
        scriptPath = null;
      }
      const name = scriptPath == null ? null : own.get(scriptPath);
      const flags = name == null ? null : executed.get(name);
      if (!flags) continue;
      // One report at a time: paint this process's ranges into a scratch
      // bitmap, innermost last, then OR it in. Painting straight into the
      // aggregate would let a later report's unexecuted range erase a line an
      // earlier process ran, and the answer would depend on file order.
      const scratch = new Uint8Array(flags.length);
      const ranges = script.functions.flatMap((fn) => fn.ranges);
      ranges.sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
      for (const range of ranges) {
        scratch.fill(range.count > 0 ? 1 : 0, range.startOffset, Math.min(range.endOffset, scratch.length));
      }
      for (let i = 0; i < flags.length; i += 1) flags[i] |= scratch[i];
    }
  }
  const lines = new Map();
  for (const [name, text] of texts) {
    const flags = executed.get(name);
    const marks = [];
    let offset = 0;
    for (const line of text.split("\n")) {
      const width = line.length;
      marks.push(flags.subarray(offset, offset + width).includes(1));
      offset += width + 1;
    }
    lines.set(name, marks);
  }
  return lines;
}

function walkJson(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) walkJson(item, visit);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visit(key);
      walkJson(item, visit);
    }
  }
}

// A ledger is known by where the store keeps it, not by its basename: a
// reviewed repository can carry its own review.json, and a snapshot stores
// that file below reviews/<id>/rounds/<n>/files/. Only the store's own
// locations count -- a ledger directly under reviews/<id>/ or
// workflows/<id>/, or anything the release store writes under releases/.
function isCanonicalLedgerPath(storeRoot, file) {
  const parts = path.relative(storeRoot, file).split(path.sep);
  if (parts.includes("rounds")) return false;
  if (parts[0] === "releases") return parts.length >= 3;
  if (parts.length !== 3) return false;
  if (parts[0] === "reviews") return LEDGER_FILES.has(parts[2]);
  if (parts[0] === "workflows") return parts[2] === "workflow.json";
  return false;
}

// Only whole values in canonical ledgers count. A constant quoted inside a
// reviewer's comment body is that reviewer's prose, not a state this store
// ever held. Audit logs are not read: they are append-only files whose
// committed extent only their own reader's head cursor and event chain can
// decide, and re-deciding that here is a second copy of that reader.
async function scanStore(storeRoot, known) {
  const counts = new Map();
  const publicationEdges = new Map();
  let scanned = 0;
  for (const file of await listFiles(storeRoot, ".json")) {
    if (!isCanonicalLedgerPath(storeRoot, file)) continue;
    const base = path.basename(file);
    const text = await fsp.readFile(file, "utf8").catch(() => null);
    if (text == null) continue;
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      continue; /* a half-written ledger is not a state observation */
    }
    scanned += 1;
    walkJson(document, (value) => {
      if (known.has(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
    });
    if (base === "publication.json") {
      recordEdges(publicationEdges, (document.history ?? []).map((entry) => entry.status));
    }
  }
  return { counts, publicationEdges, scanned };
}

function recordEdges(edges, sequence) {
  let previous = null;
  for (const value of sequence) {
    if (typeof value !== "string") continue;
    if (value !== previous) {
      const edge = `${previous ?? "<start>"} -> ${value}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
    previous = value;
  }
}

// The domain of a field: the members of the named table when the source keeps
// one, otherwise every value the field is written or compared against.
function fieldDomain(texts, table, sites, field, files) {
  for (const text of texts.values()) {
    const found = new RegExp(`const ${table} = (?:Object.freeze\\()?(?:new Set\\()?\\[([^\\]]*)\\]`).exec(text);
    if (found) return new Set([...found[1].matchAll(CONSTANT)].map((match) => match[1]));
  }
  const domain = new Set();
  const pattern = new RegExp(`${field}\\s*(?:===|!==|==|!=|[:=])\\s*"([A-Z][A-Z0-9_]{2,})"`, "g");
  for (const site of sites) {
    if (files.has(site.file)) for (const match of site.text.matchAll(pattern)) domain.add(match[1]);
  }
  return domain;
}

// A defined edge is a pair one function holds: it compares the field against
// one value of the domain and writes another. Publication status is derived
// from the latest observation rather than stepped, so this over-approximates --
// "defined" here means only that both ends are written down together.
function definedEdges(sites, field, files, domain) {
  const byUnit = new Map();
  for (const site of sites) {
    if (!files.has(site.file) || !domain.has(site.name)) continue;
    const entry = byUnit.get(`${site.file}:${site.unit}`) ?? { from: new Set(), to: new Set() };
    if (new RegExp(`${field}\\s*(===|!==|==|!=)\\s*"${site.name}"`).test(site.text)) entry.from.add(site.name);
    else if (new RegExp(`${field}\\s*[:=]\\s*"${site.name}"`).test(site.text)) entry.to.add(site.name);
    byUnit.set(`${site.file}:${site.unit}`, entry);
  }
  const edges = new Set();
  for (const { from, to } of byUnit.values()) {
    for (const source of from) for (const target of to) if (source !== target) edges.add(`${source} -> ${target}`);
  }
  return edges;
}

// The four groups of the #145 report. Order is the ruling's: a value nothing in
// src writes can only arrive from outside -- a feed, an operator argument, the
// runtime -- so it is an external-input guard whatever the store says; a value
// the store holds happens, whatever this instrument infers; only then does the
// reachability of its producers decide.
// The site to trace a value from: one that writes, throws or tabulates it.
// When every site only compares the value, say so rather than pass a
// comparison off as a definition.
function definitionOf(own) {
  const defining = own.find((site) => PRODUCER_ROLES.has(site.role) || site.role === "table");
  return defining
    ? `${defining.file}:${defining.line}`
    : `${own[0].file}:${own[0].line} (first occurrence; no site in src defines it)`;
}

function classify(sites, reachable, storeCount, executedProducers = 0) {
  const producers = sites.filter((site) => PRODUCER_ROLES.has(site.role));
  const reachableProducers = producers.filter((site) => reachable.has(`${site.file}:${site.unit}`));
  // A producer line a recorded run executed is reachable whatever the
  // name-matched call graph says about its unit; execution is the stronger
  // evidence and it only ever moves a constant out of the deletion group.
  const executed = executedProducers > 0;
  const where = [...new Set(producers.map((site) => `${site.file}:${site.unit}`))].join(", ");
  if (producers.length === 0) {
    const files = [...new Set(sites.map((site) => site.file))].join(", ");
    return {
      group: "external_input_guard",
      reason:
        storeCount > 0
          ? `no site in src writes this value and a real ledger holds it: it arrives from outside, compared in ${files}`
          : `no site in src writes this value: it can only arrive from outside, compared in ${files}`,
    };
  }
  if (storeCount > 0) {
    return {
      group: "reachable_observed",
      reason:
        reachableProducers.length > 0 || executed
          ? null
          : `a real ledger holds this value although every producer sits outside the closure (${where}): this instrument is wrong here`,
    };
  }
  if (reachableProducers.length === 0 && !executed) {
    return { group: "unreachable", reason: `every producer sits in a unit no tool surface reaches: ${where}` };
  }
  return { group: "reachable_unobserved", reason: null };
}

function markdown(result) {
  const lines = [];
  const list = (key, title, note) => {
    const members = result.constants.filter((entry) => entry.group === key);
    lines.push(`## ${title} (${members.length})`, "", note, "");
    for (const entry of members) {
      const reason = entry.reason ? ` -- ${entry.reason}` : "";
      const kind = entry.refusals.length > 0 && entry.refusals.length === entry.producers.length ? " refusal-only," : "";
      lines.push(
        `- \`${entry.name}\`${kind} defined ${entry.definition}, store ${entry.store}, tests ${entry.tests}${
          entry.producers_executed == null ? "" : `, producer lines executed ${entry.producers_executed}/${entry.producers.length}`
        }${reason}`,
      );
    }
    lines.push("");
  };
  lines.push(
    "# State inventory",
    "",
    `Generated ${result.generated_at}. ${result.constants.length} distinct SCREAMING_CASE literals across ${result.src_files.length} source files, measured against the store at \`${result.store_root ?? "(none)"}\` (${result.store_scanned} ledger files read).`,
    "",
    `Tool surfaces taken as roots: ${result.roots.map((root) => `\`${root}\``).join(", ")}.`,
    "",
    `${result.unreachable_units.length} of ${result.unit_count} units lie outside the closure from those roots: ${result.unreachable_units.join(", ") || "none"}.`,
    "",
    `Neither in the store nor in any test: ${result.never_seen.length} constants.`,
    "",
  );
  list("reachable_observed", "Reachable and observed", "A tool surface reaches a producer, and a real ledger holds the value.");
  list("reachable_unobserved", "Reachable and never observed", "A tool surface reaches a producer; this store never held the value.");
  list("unreachable", "Unreachable from any tool surface", "No tool surface reaches a producer. This is the phase 2 input.");
  list("external_input_guard", "External-input guards", "Nothing in src writes the value; the code only compares received data against it. Kept by the #145 ruling.");
  lines.push(
    "## Transitions",
    "",
    `Publication status, domain of ${result.transitions.publication.domain.length}: ${result.transitions.publication.observed.length} edges observed, ${result.transitions.publication.defined_not_observed.length} defined here but never observed, ${result.transitions.publication.never_observed.length} members never entered at all.`,
    "",
    ...result.transitions.publication.defined_not_observed.map((edge) => `- defined, never observed: ${edge}`),
    ...result.transitions.publication.never_observed.map((name) => `- never entered: \`${name}\``),
    "",
    "Workflow phases are not tabulated: workflow.json carries only its current phase, and phase history lives in the action audit log, which this instrument does not read.",
    "",
    "Unquoted object keys are not read: a value that only a key writes appears here as an external-input guard. HISTORY_REWRITE_REQUIRED is the known case; read the group-4 list with that in mind.",
    "",
    "## Instrument defects",
    "",
    result.instrument_defects.length === 0
      ? "None: no observed value was called unreachable."
      : result.instrument_defects.join(", "),
    "",
  );
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const project = path.resolve(args.project ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const storeRoot = args.store === null ? null : path.resolve(args.store ?? defaultStoreRoot());
const srcDir = path.join(project, "src");

const { files, sites, units, texts } = await scanSource(srcDir);
const { reachable, rootFiles } = await reachableUnits(project, srcDir, units);
const testCounts = await scanTests(path.join(project, "test"));
const executedLines = args.coverage ? await scanCoverage(path.resolve(args.coverage), texts, srcDir) : null;
const names = new Set(sites.map((site) => site.name));
const store = storeRoot
  ? await scanStore(storeRoot, names)
  : { counts: new Map(), publicationEdges: new Map(), scanned: 0 };

const publicationFiles = new Set(["publication.mjs"]);
const statusDomain = fieldDomain(texts, "PUBLICATION_STATUSES", sites, "status", publicationFiles);
const entered = (edges, name) => [...edges.keys()].some((edge) => edge.endsWith(`-> ${name}`));

const result = {
  generated_at: new Date().toISOString(),
  store_root: storeRoot,
  store_scanned: store.scanned,
  coverage: args.coverage ? path.resolve(args.coverage) : null,
  src_files: files.map((file) => path.relative(project, file)),
  roots: rootFiles,
  unit_count: units.size,
  unreachable_units: [...units.keys()].filter((key) => !reachable.has(key)).sort(),
  constants: [...names].sort().map((name) => {
    const own = sites.filter((site) => site.name === name);
    const storeCount = store.counts.get(name) ?? 0;
    const site = (entry) => `${entry.file}:${entry.line} (${entry.unit}${reachable.has(`${entry.file}:${entry.unit}`) ? "" : ", unreachable"})`;
    const producers = own.filter((entry) => PRODUCER_ROLES.has(entry.role));
    const producersExecuted = executedLines
      ? producers.filter((entry) => executedLines.get(entry.file)?.[entry.line - 1]).length
      : null;
    return {
      name,
      definition: definitionOf(own),
      producers: producers.map(site),
      refusals: own.filter((entry) => entry.role === "refusal").map(site),
      consumers: own.filter((entry) => entry.role === "consumer").map(site),
      tables: own.filter((entry) => entry.role === "table").map(site),
      store: storeCount,
      tests: testCounts.get(name) ?? 0,
      producers_executed: producersExecuted,
      ...classify(own, reachable, storeCount, producersExecuted ?? 0),
    };
  }),
  transitions: {
    publication: {
      domain: [...statusDomain].sort(),
      observed: [...store.publicationEdges.entries()].map(([edge, count]) => `${edge} (${count})`).sort(),
      defined_not_observed: [...definedEdges(sites, "status", publicationFiles, statusDomain)]
        .filter((edge) => !store.publicationEdges.has(edge))
        .sort(),
      never_observed: [...statusDomain].filter((name) => !entered(store.publicationEdges, name)).sort(),
    },
  },
};
result.never_seen = result.constants.filter((entry) => entry.store === 0 && entry.tests === 0).map((entry) => entry.name);
result.instrument_defects = result.constants
  .filter((entry) => entry.group === "reachable_observed" && entry.reason != null)
  .map((entry) => entry.name);

process.stdout.write(args.json ? `${JSON.stringify(result, null, 1)}\n` : `${markdown(result)}\n`);
