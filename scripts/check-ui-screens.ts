/**
 * ChartWarden — UI Screen-Spec Corpus Consistency Check
 * -------------------------------------------------
 * Keeps the docs/design/ corpus internally coherent. Catches the drift that is easy
 * to introduce when adding screens by hand:
 *
 *   1. INDEX PARITY — every screen file under docs/design/screens/ is listed in
 *      CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md, and every index entry points to a file
 *      that exists (no orphans, no stragglers, no duplicates).
 *   2. LAYOUT-HEADING HYGIENE — every screen declares its layout via
 *      `## Layout Pattern` + a single `Use <name>.` line (no bare `## Layout`,
 *      no missing declaration).
 *   3. PATTERN RESOLUTION — every pattern token in a `Use A + B.` declaration
 *      resolves to a pattern defined in CHARTWARDEN_UI_LAYOUT_PATTERNS.md (a `### Name`
 *      base/foundational heading, or a Tier-3 modifier table row).
 *   6. STATUS PARITY (GAP-186) — SCREEN_SPEC_STATUS.md has exactly one row per indexed spec,
 *      a status of built|partial|deferred, a registered screen set (as listed in
 *      audit/ui-parity/ui-parity.json) on every built/partial row, and a reason on every
 *      deferred row. `ui:parity` only COUNTS specs vs screens; this is the per-spec join.
 *
 * Authoritative-by-construction: the glossary is the source of truth for pattern
 * names; the index is the source of truth for the screen set. This check asserts
 * the specs agree with both.
 *
 * Run:   bun run scripts/check-ui-screens.ts   (alias: bun run docs:ui)
 * CI:    exits 1 on any violation.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const UI_DIR = "docs/design";
const SCREENS_DIR = join(UI_DIR, "screens");
const INDEX_FILE = join(UI_DIR, "CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md");
const GLOSSARY_FILE = join(UI_DIR, "CHARTWARDEN_UI_LAYOUT_PATTERNS.md");

type Violation = { check: string; detail: string };
const violations: Violation[] = [];
const fail = (check: string, detail: string) => violations.push({ check, detail });

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function listScreens(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(REPO_ROOT, dir))) {
    const rel = join(dir, e);
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) listScreens(rel, acc);
    else if (/^CHARTWARDEN_UI_.+\.md$/.test(e)) acc.push(rel);
  }
  return acc;
}

// ---- gather the screen set (relative to docs/design/, matching index entries) ----
const screenFiles = listScreens(SCREENS_DIR)
  .map((p) => relative(UI_DIR, p))
  .sort();

// ---- 1. INDEX PARITY ----
const indexSrc = read(INDEX_FILE);
const indexEntries = [...indexSrc.matchAll(/`(screens\/[^`]+\.md)`/g)].map((m) => m[1]!);
const indexSet = new Set<string>();
for (const e of indexEntries) {
  if (indexSet.has(e)) fail("index-duplicate", `'${e}' is listed more than once in the index`);
  indexSet.add(e);
}
for (const f of screenFiles)
  if (!indexSet.has(f)) fail("index-missing", `${f} exists but is not listed in the screen index`);
for (const e of indexEntries)
  if (!existsSync(join(REPO_ROOT, UI_DIR, e)))
    fail("index-orphan", `index lists '${e}' but no such file exists`);

// ---- build the set of patterns DEFINED in the glossary ----
const glossarySrc = read(GLOSSARY_FILE);
const defined = new Set<string>();
// base / foundational patterns: "### Name **[named in specs]**" / "### Name **[proposed]**"
for (const m of glossarySrc.matchAll(/^###\s+(.+?)\s+\*\*\[/gm)) defined.add(m[1]!.trim());
// modifiers: bold tokens inside the Tier-3 modifier table
const tier3 = glossarySrc.slice(glossarySrc.indexOf("## Tier 3 — Modifiers"));
const tier3Body = tier3.slice(
  0,
  tier3.indexOf("\n## ", 1) >= 0 ? tier3.indexOf("\n## ", 1) : undefined,
);
for (const line of tier3Body.split("\n")) {
  if (!line.startsWith("| **")) continue;
  for (const m of line.matchAll(/\*\*([^*]+)\*\*/g)) defined.add(m[1]!.trim());
}

// ---- 2 & 3. per-screen: layout heading hygiene + pattern resolution ----
for (const f of screenFiles) {
  const src = read(join(UI_DIR, f));
  if (/^## Layout$/m.test(src))
    fail("bare-layout-heading", `${f} uses bare '## Layout' — must be '## Layout Pattern'`);

  const useLines = [...src.matchAll(/^Use (.+?)\.\s*$/gm)];
  if (useLines.length === 0) {
    fail("no-pattern", `${f} declares no layout pattern (expected a 'Use <name>.' line)`);
    continue;
  }
  if (useLines.length > 1)
    fail(
      "multi-pattern",
      `${f} declares ${useLines.length} 'Use ...' lines — expected exactly one`,
    );

  for (const token of useLines[0]![1]!.split("+").map((s) => s.trim())) {
    if (!defined.has(token))
      fail(
        "undefined-pattern",
        `${f} references layout pattern '${token}', not defined in the glossary`,
      );
  }
}

// ---- 4 & 5. corpus-wide citation integrity (2026-08-14, mirroring arch:architecture-docs /
// arch:module-docs): every four-digit ADR-NNNN citation anywhere under docs/design/ must resolve
// to a file in docs/adr/, and every relative markdown link must resolve on disk. Root docs
// (DESIGN.md, DEFERRED_SCREENS.md, …) were previously entirely ungated. Deliberately NO
// cited-path rule: screen specs are proposals and legitimately cite planned paths.
import { dirname, resolve } from "node:path";
const adrNumbers = new Set(
  readdirSync(join(REPO_ROOT, "docs/adr"))
    .filter((f) => /^ADR-\d{4}-/.test(f))
    .map((f) => f.slice(4, 8)),
);
function listAllMd(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(REPO_ROOT, dir))) {
    const rel = join(dir, e);
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) listAllMd(rel, acc);
    else if (e.endsWith(".md")) acc.push(rel);
  }
  return acc;
}
let adrsChecked = 0;
let linksChecked = 0;
for (const rel of listAllMd(UI_DIR)) {
  const lines = readFileSync(join(REPO_ROOT, rel), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(/\bADR-(\d{4})\b/g)) {
      adrsChecked++;
      if (!adrNumbers.has(m[1]!))
        fail("dead-adr-citation", `${rel}:${i + 1} cites ADR-${m[1]}, no such file in docs/adr/`);
    }
    for (const m of lines[i]!.matchAll(/\]\((\.\.?\/[^)#\s]+)(#[^)\s]*)?\)/g)) {
      linksChecked++;
      if (!existsSync(resolve(dirname(join(REPO_ROOT, rel)), m[1]!)))
        fail("dead-link", `${rel}:${i + 1} relative link \`${m[1]}\` does not resolve`);
    }
  }
}

// ---- 6. STATUS PARITY: docs/design/SCREEN_SPEC_STATUS.md joins every indexed spec to a screen set ----
const STATUS_FILE = join(UI_DIR, "SCREEN_SPEC_STATUS.md");
const STATUS_VALUES = new Set(["built", "partial", "deferred"]);
const statusRows = new Map<string, { status: string; modules: string[]; note: string }>();
if (!existsSync(join(REPO_ROOT, STATUS_FILE))) {
  fail("status-missing", `${STATUS_FILE} is missing — every indexed spec needs a status row`);
} else {
  let registered = new Set<string>();
  try {
    const parity = JSON.parse(read("audit/ui-parity/ui-parity.json")) as {
      registeredModules?: string[];
    };
    registered = new Set(parity.registeredModules ?? []);
  } catch {
    fail(
      "status-parity-json",
      "audit/ui-parity/ui-parity.json is unreadable (run `bun run ui:parity`)",
    );
  }
  for (const line of read(STATUS_FILE).split("\n")) {
    const m = /^\|\s*`(screens\/[^`]+\.md)`\s*\|\s*([a-z]+)\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line);
    if (!m) continue;
    const [, spec, status, modulesCell, note] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (statusRows.has(spec))
      fail("status-duplicate", `${spec} has more than one row in SCREEN_SPEC_STATUS.md`);
    const modules = [...modulesCell.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
    statusRows.set(spec, { status, modules, note: note.trim() });
    if (!STATUS_VALUES.has(status))
      fail("status-value", `${spec}: status '${status}' is not built|partial|deferred`);
    if (status === "deferred" && note.trim().length === 0)
      fail("status-reason", `${spec}: a deferred spec must state why it has no screen`);
    if (status !== "deferred") {
      if (modules.length === 0)
        fail("status-modules", `${spec}: ${status} but cites no screen set`);
      for (const mod of modules)
        if (registered.size > 0 && !registered.has(mod))
          fail(
            "status-unknown-module",
            `${spec}: '${mod}' is not a registered screen set in ui-parity.json`,
          );
    }
    if (status === "deferred" && modules.length > 0)
      fail(
        "status-deferred-modules",
        `${spec}: deferred but cites screen set(s) ${modules.join(", ")}`,
      );
  }
  for (const e of indexEntries)
    if (!statusRows.has(e))
      fail("status-row-missing", `${e} is indexed but has no row in SCREEN_SPEC_STATUS.md`);
  for (const spec of statusRows.keys())
    if (!indexSet.has(spec))
      fail(
        "status-row-orphan",
        `SCREEN_SPEC_STATUS.md has a row for ${spec}, which is not in the index`,
      );
}

// ---- report ----
const checked = `${screenFiles.length} screens · ${defined.size} patterns · ${indexEntries.length} index entries · ${adrsChecked} ADR citations · ${linksChecked} links`;
if (violations.length === 0) {
  console.log(`✓ ui-screens: corpus consistent (${checked})`);
  process.exit(0);
}
console.error(`✗ ui-screens: ${violations.length} issue(s)  [${checked}]\n`);
for (const v of violations) console.error(`  [${v.check}] ${v.detail}`);
process.exit(1);
