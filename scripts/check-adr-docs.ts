/**
 * ChartWarden - ADR corpus gate (docs/adr)
 * ------------------------------------
 * Companion to check-architecture-docs.ts / check-module-docs.ts / the docs:ui citation rules,
 * with the contract the ADR corpus demands: ADRs are IMMUTABLE once Accepted (their own
 * conventions section), so this gate never checks prose freshness — it checks the corpus's
 * integrity as a decision REGISTER:
 *
 *   1. INDEX      — docs/adr/README.md lists every ADR file exactly once, every row resolves to
 *                   its file, and numbering is unique and contiguous from 0001 (a gap means a
 *                   reserved-but-never-written decision; a duplicate means a numbering collision
 *                   like the ones that plagued the spec corpus).
 *   2. STATUS     — every ADR carries a parseable `**Status:**` line whose first word is one of
 *                   Accepted / Proposed / Superseded / Rejected / Deprecated. A Superseded ADR
 *                   must cite the superseding four-digit ADR on that line.
 *   3. AGREEMENT  — the index row's status cell must agree with the file's status word. (An ADR
 *                   sitting formally "Proposed" while indexed — and treated — as Accepted is
 *                   exactly the drift that lets unratified decisions ship.)
 *   4. CITATIONS  — every four-digit `ADR-NNNN` reference inside the corpus resolves to a file.
 *   5. LINKS      — every relative markdown link resolves on disk.
 *
 * Compliance of CODE with each ADR's Decision section is NOT mechanically checkable — that is
 * the audit layer (see audit/ADR_COMPLIANCE_AUDIT_*.md).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { group, groups } from "./lib/strict";

const ROOT = process.cwd();
const DIR = "docs/adr";
const STATUS_WORDS = new Set(["Accepted", "Proposed", "Superseded", "Rejected", "Deprecated"]);

interface Violation {
  readonly doc: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}
const violations: Violation[] = [];
const fail = (doc: string, line: number, rule: string, message: string) =>
  violations.push({ doc, line, rule, message });

const files = readdirSync(join(ROOT, DIR))
  .filter((f) => /^ADR-\d{4}-.+\.md$/.test(f))
  .sort();
const numbers = files.map((f) => f.slice(4, 8));
const numberSet = new Set(numbers);

// ---- Rule 1: numbering unique + contiguous ---------------------------------------------------
if (numberSet.size !== numbers.length)
  fail("(corpus)", 1, "INDEX", "duplicate ADR numbers on disk");
const max = Math.max(...numbers.map(Number));
for (let n = 1; n <= max; n++) {
  const id = String(n).padStart(4, "0");
  if (!numberSet.has(id))
    fail(
      "(corpus)",
      1,
      "INDEX",
      `numbering gap: ADR-${id} has no file (1…${String(max).padStart(4, "0")} should be contiguous)`,
    );
}

// ---- Rules 2: status lines -------------------------------------------------------------------
const statusByNumber = new Map<string, string>();
for (const f of files) {
  const text = readFileSync(join(ROOT, DIR, f), "utf8");
  const m = text.match(/\*\*Status:\*\*\s*\*{0,2}([A-Za-z]+)/);
  if (!m) {
    fail(f, 1, "STATUS", "no parseable `**Status:**` line");
    continue;
  }
  const word = group(m, 1, "ADR **Status:** line");
  statusByNumber.set(f.slice(4, 8), word);
  if (!STATUS_WORDS.has(word))
    fail(f, 1, "STATUS", `status word '${word}' not one of ${[...STATUS_WORDS].join("/")}`);
  if (word === "Superseded") {
    const statusLine = text.split("\n").find((l) => l.includes("**Status:**")) ?? "";
    if (!/ADR-\d{4}/.test(statusLine))
      fail(
        f,
        1,
        "STATUS",
        "Superseded status must cite the superseding ADR-NNNN on the status line",
      );
  }
}

// ---- Rules 1b + 3: index rows ----------------------------------------------------------------
const readme = readFileSync(join(ROOT, DIR, "README.md"), "utf8");
const rows = new Map<string, { line: number; status: string; target: string }>();
readme.split("\n").forEach((line, i) => {
  const m = line.match(
    /^\|\s*\[(\d{4})\]\(([^)]+)\)\s*\|.*\|\s*\*{0,2}([A-Za-z]+)\*{0,2}[^|]*\|\s*$/,
  );
  if (!m) return;
  const [num, target, status] = groups(m, 3, "ADR README index row");
  if (rows.has(num)) fail("README.md", i + 1, "INDEX", `ADR-${num} indexed more than once`);
  rows.set(num, { line: i + 1, status, target });
  if (!existsSync(join(ROOT, DIR, target)))
    fail("README.md", i + 1, "INDEX", `row ${num} links '${target}', which does not exist`);
});
for (const f of files) {
  const num = f.slice(4, 8);
  const row = rows.get(num);
  if (!row) {
    fail("README.md", 1, "INDEX", `ADR file ${f} has no index row`);
    continue;
  }
  if (row.target !== f)
    fail("README.md", row.line, "INDEX", `row ${num} links '${row.target}' but the file is '${f}'`);
  const fileStatus = statusByNumber.get(num);
  if (fileStatus && row.status !== fileStatus) {
    fail(
      "README.md",
      row.line,
      "AGREEMENT",
      `row ${num} says '${row.status}' but ${f} declares '${fileStatus}' — the register must not promote (or demote) a decision the file doesn't`,
    );
  }
}
for (const [num, row] of rows) {
  if (!numberSet.has(num))
    fail("README.md", row.line, "INDEX", `row ${num} has no ADR file on disk`);
}

// ---- Rules 4 + 5: citations + links ----------------------------------------------------------
let adrsChecked = 0;
let linksChecked = 0;
for (const f of [...files, "README.md"]) {
  const abs = join(ROOT, DIR, f);
  const lines = readFileSync(abs, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/\bADR-(\d{4})\b/g)) {
      adrsChecked++;
      const cited = group(m, 1, "ADR citation");
      if (!numberSet.has(cited))
        fail(f, i + 1, "CITATIONS", `cites ADR-${cited}, which has no file in ${DIR}`);
    }
    for (const m of line.matchAll(/\]\((\.\.?\/[^)#\s]+)(#[^)\s]*)?\)/g)) {
      linksChecked++;
      const href = group(m, 1, "ADR relative link");
      if (!existsSync(resolve(dirname(abs), href)))
        fail(f, i + 1, "LINKS", `relative link \`${href}\` does not resolve`);
    }
  }
}

if (violations.length === 0) {
  console.log(
    `OK adr-docs: ${files.length} ADRs (0001…${String(max).padStart(4, "0")} contiguous) · index parity · ${adrsChecked} cross-citations · ${linksChecked} links`,
  );
  process.exit(0);
}
console.error(`FAIL adr-docs: ${violations.length} violation(s)`);
for (const v of violations) console.error(`  - ${v.doc}:${v.line} [${v.rule}] ${v.message}`);
process.exit(1);
