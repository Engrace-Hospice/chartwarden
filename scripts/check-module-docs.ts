/**
 * WardenX - module-spec corpus gate (docs/modules)
 * ------------------------------------------------
 * Companion to check-architecture-docs.ts, with a deliberately DIFFERENT contract: module specs
 * are IMPLEMENTATION PROPOSALS (repo authority rule), so "describes something never built" is a
 * legal state here and there is NO cited-path-must-exist rule — proposals legitimately cite
 * planned paths. What this gate enforces is the integrity of the corpus *as a corpus*:
 *
 *   1. INDEX      — docs/modules/README.md lists exactly the 40 spec files on disk, one row per
 *                   module 01…40, each row's link resolving to the file it names.
 *   2. VERSION    — every spec declares a parseable version in its header (a `**Spec status:**` /
 *                   `**Spec version:**` / `**Version:**` field, or a `vX.Y` in the H1 title), and
 *                   the README's "Spec ver" column matches the HEADER version. Specs are re-locked
 *                   in place (the filename version is pinned and may lag — same convention the
 *                   architecture corpus adopted); the header is authoritative, and the index used
 *                   to track the filename, sitting one or two re-locks stale for 26 of 40 modules.
 *   3. ADRS       — every four-digit `ADR-NNNN` citation resolves to a file in docs/adr/, EXCEPT
 *                   on lines that also carry an `ARCH-\d+` audit-finding id: those are audit-era
 *                   composite citations (e.g. "ADR-0144 / ARCH-281#5") from the 2026-06 audit's
 *                   own ADR numbering, a historical namespace that never became docs/adr/ files.
 *                   (The architecture §21 short `ADR-00N` register is likewise a separate,
 *                   deliberately ungated namespace — see that section's numbering note.)
 *   4. LINKS      — every relative markdown link in the corpus resolves on disk.
 *   5. AUTHORITY  — every spec's first 40 lines carry the "implementation proposal" marker, so a
 *                   spec read standalone cannot be mistaken for an authoritative as-built record.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = process.cwd();
const DIR = "docs/modules";
const ADR_DIR = "docs/adr";

interface Violation {
  readonly doc: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}
const violations: Violation[] = [];
function fail(doc: string, line: number, rule: string, message: string): void {
  violations.push({ doc, line, rule, message });
}

/** Header version: field forms first, H1-title `vX.Y` fallback. Scans the first 25 lines. */
function headerVersion(text: string): string | null {
  const head = text.split("\n").slice(0, 25).join("\n");
  const field = head.match(
    /\*\*(?:Spec status|Spec version|Version|Status):\*\*[^\n]*?v?(\d+\.\d+(?:\.\d+)?)/,
  );
  if (field) return field[1];
  const title = head.match(/^# .*?\bv(\d+\.\d+(?:\.\d+)?)\b/m);
  return title ? title[1] : null;
}

const specFiles = readdirSync(join(ROOT, DIR))
  .filter((f) => /^WARDENX_MODULE_\d{2}_.+\.md$/.test(f))
  .sort();
const adrNumbers = new Set(
  readdirSync(join(ROOT, ADR_DIR))
    .filter((f) => /^ADR-\d{4}-/.test(f))
    .map((f) => f.slice(4, 8)),
);

// ---- Rule 1 + 2: index parity against README ------------------------------------------------
const readmePath = join(ROOT, DIR, "README.md");
const readme = readFileSync(readmePath, "utf8");
const rows = new Map<string, { version: string; file: string; line: number }>();
readme.split("\n").forEach((line, i) => {
  const m = line.match(
    /^\|\s*M(\d{2})\s*\|[^|]*\|\s*v?([\d.]+)\s*\|\s*\[`([^`]+)`\]\(\.\/([^)]+)\)\s*\|/,
  );
  if (!m) return;
  const [, num, version, label, target] = m;
  if (rows.has(num)) fail("README.md", i + 1, "INDEX", `module M${num} listed more than once`);
  rows.set(num, { version, file: target, line: i + 1 });
  if (label !== target)
    fail(
      "README.md",
      i + 1,
      "INDEX",
      `row M${num}: link label \`${label}\` != link target \`${target}\``,
    );
});

const versionByFile = new Map<string, string | null>();
for (const file of specFiles) {
  const num = file.slice(15, 17);
  const text = readFileSync(join(ROOT, DIR, file), "utf8");
  const hv = headerVersion(text);
  versionByFile.set(file, hv);
  const row = rows.get(num);
  if (!row) {
    fail("README.md", 1, "INDEX", `spec file ${file} has no M${num} row in the index`);
    continue;
  }
  if (row.file !== file)
    fail(
      "README.md",
      row.line,
      "INDEX",
      `row M${num} links \`${row.file}\` but the on-disk file is \`${file}\``,
    );
  if (hv === null) {
    fail(
      file,
      1,
      "VERSION",
      "no parseable version in the header (need a **Spec status:**/**Spec version:**/**Version:** field or vX.Y in the H1 title)",
    );
  } else if (row.version !== hv) {
    fail(
      "README.md",
      row.line,
      "VERSION",
      `row M${num} says v${row.version}, but ${file} declares v${hv} in its header (specs re-lock in place; the header wins and the index must track it)`,
    );
  }
}
for (const [num, row] of rows) {
  if (!specFiles.some((f) => f.slice(15, 17) === num)) {
    fail("README.md", row.line, "INDEX", `row M${num} has no matching spec file on disk`);
  }
}
if (rows.size !== 40)
  fail("README.md", 1, "INDEX", `index has ${rows.size} module rows; expected 40`);

// ---- Rules 3–5: per-file scans (specs, the index, and module-29-tasks) ----------------------
const allDocs: Array<{ rel: string; abs: string }> = [
  { rel: "README.md", abs: readmePath },
  ...specFiles.map((f) => ({ rel: f, abs: join(ROOT, DIR, f) })),
  ...readdirSync(join(ROOT, DIR, "module-29-tasks"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ rel: `module-29-tasks/${f}`, abs: join(ROOT, DIR, "module-29-tasks", f) })),
];

let adrsChecked = 0;
let adrsAuditEra = 0;
let linksChecked = 0;

for (const { rel, abs } of allDocs) {
  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");

  if (/^WARDENX_MODULE_/.test(rel)) {
    const head = lines.slice(0, 40).join("\n");
    if (!/implementation proposal/i.test(head)) {
      fail(
        rel,
        1,
        "AUTHORITY",
        'first 40 lines lack the "implementation proposal" authority marker',
      );
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const m of line.matchAll(/\bADR-(\d{4})\b/g)) {
      adrsChecked++;
      if (adrNumbers.has(m[1])) continue;
      if (/ARCH-\d+/.test(line)) {
        adrsAuditEra++; // audit-era composite citation — historical namespace, exempt
        continue;
      }
      fail(
        rel,
        i + 1,
        "ADRS",
        `cites ADR-${m[1]}, which has no file in ${ADR_DIR} (and no ARCH-nnn audit-era marker on the line)`,
      );
    }

    for (const m of line.matchAll(/\]\((\.\.?\/[^)#\s]+)(#[^)\s]*)?\)/g)) {
      linksChecked++;
      const target = resolve(dirname(abs), m[1]);
      if (!existsSync(target))
        fail(rel, i + 1, "LINKS", `relative link \`${m[1]}\` does not resolve`);
    }
  }
}

if (violations.length === 0) {
  console.log(
    `OK module-docs: ${specFiles.length} specs · index parity 40/40 · ${adrsChecked} ADR citations (${adrsAuditEra} audit-era exempt) · ${linksChecked} relative links`,
  );
  process.exit(0);
}
console.error(`FAIL module-docs: ${violations.length} violation(s)`);
for (const v of violations) console.error(`  - ${v.doc}:${v.line} [${v.rule}] ${v.message}`);
process.exit(1);
