/**
 * WardenX — activatable-row gate (#32)
 * ------------------------------------
 * `bun run arch:interactive-rows`
 *
 * A `<tr>` that opens a detail drawer on click is a CONTROL, but the element is not one: it is
 * neither a link nor a button, so it never enters the tab order. Before this gate, five such rows
 * across four screens left FOUR detail drawers reachable by pointer and by nothing else — WCAG 2.1
 * 2.1.1 Keyboard, Level A.
 *
 * `biome` does flag this (`lint/a11y/useKeyWithClickEvents`), but CI runs lint with
 * `continue-on-error: true` (#33), so it has never failed a build. This gate is blocking, and checks
 * the two halves biome cannot state together:
 *
 *   RULE A — a row that ACTS must be operable. `<tr onClick>` requires `tabIndex` plus a key
 *            handler, or the shared `interactiveRowProps()` helper that supplies both.
 *
 *   RULE B — a row that LOOKS actable must act. `className="wx-data-row-interactive"` paints
 *            `cursor: pointer` over the whole row and reserves a `:focus-visible` ring
 *            (apps/web/src/index.css). 22 rows carried it with no row-level handler at all: the
 *            pointer promised an interaction that did not exist, and the focus ring could never
 *            render because nothing in the row was focusable. That is a false affordance for every
 *            user, not only keyboard users.
 *
 * Parsing note: JSX opening tags are read with a brace-balanced scanner, not a regex. `<tr[^>]*>`
 * truncates at the `>` inside `onClick={() => …}`, which silently reclassifies rows — that mistake
 * put the true count of keyboard-inoperable rows at 1 when it was 5.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_ROOTS = ["apps/web/src", "apps/admin/src", "apps/portal/src"];
const INTERACTIVE_CLASS = "wx-data-row-interactive";

export interface RowFinding {
  rule: "unoperable" | "false-affordance";
  file: string;
  line: number;
  detail: string;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".tsx")) continue;
    if (entry.includes(".test.") || entry.includes(".stories.")) continue;
    out.push(full);
  }
}

/**
 * Every `<tag …>` opening tag in `src`, brace-balanced so that `=>`, nested object literals and
 * `}` inside string literals do not terminate the tag early.
 */
export function openingTags(src: string, tag: string): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  for (const m of src.matchAll(new RegExp(`<${tag}(?=[\\s/>])`, "g"))) {
    const start = m.index as number;
    let i = start + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i] as string;
      if (quote) {
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        out.push({ index: start, text: src.slice(start, i + 1) });
        break;
      }
    }
  }
  return out;
}

export function inspect(src: string, file: string): RowFinding[] {
  const findings: RowFinding[] = [];
  for (const { index, text } of openingTags(src, "tr")) {
    const line = src.slice(0, index).split("\n").length;
    const usesHelper = text.includes("interactiveRowProps");
    const hasClick = text.includes("onClick");
    const hasKey = /onKeyDown|onKeyUp|onKeyPress/.test(text);
    const hasTabIndex = text.includes("tabIndex");
    const looksInteractive = text.includes(INTERACTIVE_CLASS);

    // RULE A — a row that acts must be operable.
    if (hasClick && !usesHelper && !(hasKey && hasTabIndex)) {
      findings.push({
        rule: "unoperable",
        file,
        line,
        detail:
          "<tr onClick> with no keyboard path — a <tr> is not focusable, so whatever this opens is " +
          "unreachable without a pointer. Spread interactiveRowProps() from @chartwarden/ui.",
      });
      continue;
    }

    // RULE B — a row that looks actable must act.
    if (looksInteractive && !hasClick && !usesHelper) {
      findings.push({
        rule: "false-affordance",
        file,
        line,
        detail: `className="${INTERACTIVE_CLASS}" paints cursor:pointer over the whole row and reserves a :focus-visible ring, but the row has no row-level activation. Either wire it with interactiveRowProps(), or drop the class so the row stops advertising an interaction it does not have.`,
      });
    }
  }
  return findings;
}

export function run(repoRoot = process.cwd()): RowFinding[] {
  const files: string[] = [];
  for (const root of APP_ROOTS) walk(join(repoRoot, root), files);
  const findings: RowFinding[] = [];
  for (const file of files.sort()) {
    findings.push(...inspect(readFileSync(file, "utf8"), file.slice(repoRoot.length + 1)));
  }
  return findings;
}

function main(): void {
  const findings = run();
  if (findings.length === 0) {
    console.log(
      "OK interactive-rows: every <tr> that acts is keyboard-operable, and every row that looks " +
        "actable acts",
    );
    return;
  }
  console.error(`✗ interactive-rows: ${findings.length} violation(s)\n`);
  for (const f of findings) {
    console.error(`  [${f.rule}] ${f.file}:${f.line}\n    ${f.detail}\n`);
  }
  process.exit(1);
}

if (import.meta.main) main();
