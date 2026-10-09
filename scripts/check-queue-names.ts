#!/usr/bin/env bun
/**
 * WardenX — BullMQ queue-name uniqueness gate
 * ---------------------------------------------------------------------------
 * A BullMQ queue is identified ONLY by its string name. Two modules that declare the same name share one Redis queue,
 * so each module's Worker competes for the other's jobs: whichever worker is free takes the job, runs the wrong
 * processor against the wrong payload, and (after the retry budget) promotes it to the DLQ. That is exactly what
 * happened to M23 and M27, which both declared a queue literally named `validation-run`: an M27 worker picked up an
 * M23 job and failed it with "cost_report_validation … not found". Nothing in the type system, the module boundaries
 * or the unit tests can see it, because each module is internally consistent — the collision exists only between them.
 *
 * WHAT IT ENFORCES. Every queue name DECLARED in source belongs to exactly one owner (an app module directory or a
 * workspace package). A name declared by two owners fails the gate. Declarations are read statically from:
 *   - `const …_QUEUES = { key: "name", … }` catalog objects (work + cron queues),
 *   - `const …_QUEUE = "name"` single-queue constants,
 *   - `dlq: "name"` entries — a DLQ shares the same Redis namespace, so a DLQ named like another module's queue counts.
 * The same name declared twice inside ONE owner is allowed (a catalog and a legacy alias), since those cannot compete.
 *
 * The repo convention is a module-scoped name (`m13.…`, `m18.…`, `m21.…`, `messaging.…`, `medicaid-…`, `cap-…`, `fhir.…`);
 * a few older modules still use bare names, which is fine until two of them pick the same word — which is what this
 * catches. Test files are skipped. A scanner floor (MIN_EXPECTED_NAMES) fails the gate if the regexes ever stop
 * matching, so the check cannot rot into a silent pass.
 *
 * Run:  bun run arch:queue-names   (in `arch:fitness`)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["apps/backend/src", "packages"];
const MIN_EXPECTED_NAMES = 80;

export interface QueueDeclaration {
  readonly name: string;
  readonly owner: string;
  readonly file: string;
}

export interface QueueCollision {
  readonly name: string;
  readonly declarations: readonly QueueDeclaration[];
}

/** The owner of a source file: its module directory (`23-billing-medicare`) or workspace package (`packages/audit`). */
export function ownerOf(file: string): string {
  const mod = /^apps\/backend\/src\/modules\/([^/]+)\//.exec(file);
  if (mod) return `module:${mod[1]}`;
  const pkg = /^packages\/([^/]+)\//.exec(file);
  if (pkg) return `package:${pkg[1]}`;
  return `app:${file.split("/").slice(0, 4).join("/")}`;
}

/** Pull the text of the `{ … }` that opens at `open` (balanced braces; string/comment content cannot unbalance ours). */
function balancedBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

const CATALOG_RE = /\bconst\s+[A-Z][A-Z0-9_]*QUEUES\s*(?::[^=]+)?=\s*\{/g;
const SINGLE_RE = /\bconst\s+[A-Z][A-Z0-9_]*_QUEUE\s*(?::\s*string\s*)?=\s*"([^"]+)"[^\n]*/g;
/** A line ending in this marker REFERENCES another owner's queue (e.g. a one-shot migration off it); it declares nothing. */
const REFERENCE_MARKER = "queue-names:reference";
const DLQ_RE = /\bdlq:\s*"([^"]+)"/g;
const ENTRY_RE = /^\s*[A-Za-z0-9_]+:\s*"([^"]+)"\s*,?\s*(?:\/\/.*)?$/gm;

/** Every queue name declared in one source text. Pure — the unit test drives this directly. */
export function queueNamesIn(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(CATALOG_RE)) {
    const block = balancedBlock(src, (m.index ?? 0) + m[0].length - 1);
    for (const e of block.matchAll(ENTRY_RE)) names.push(e[1] as string);
  }
  for (const m of src.matchAll(SINGLE_RE)) {
    if (!m[0].includes(REFERENCE_MARKER)) names.push(m[1] as string);
  }
  for (const m of src.matchAll(DLQ_RE)) names.push(m[1] as string);
  return names;
}

/** Names declared by more than one owner. */
export function findQueueCollisions(declarations: readonly QueueDeclaration[]): QueueCollision[] {
  const byName = new Map<string, QueueDeclaration[]>();
  for (const d of declarations) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  return [...byName.entries()]
    .filter(([, ds]) => new Set(ds.map((d) => d.owner)).size > 1)
    .map(([name, ds]) => ({ name, declarations: ds }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.(test|live\.test|spec)\.ts$/.test(entry)) out.push(full);
  }
}

export function collectQueueDeclarations(root: string = REPO_ROOT): QueueDeclaration[] {
  const files: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    const abs = join(root, scanRoot);
    try {
      walk(abs, files);
    } catch {
      // a scan root that does not exist in this checkout contributes nothing
    }
  }
  const declarations: QueueDeclaration[] = [];
  for (const abs of files) {
    const file = relative(root, abs);
    const src = readFileSync(abs, "utf8");
    if (!/QUEUE|dlq:/.test(src)) continue;
    for (const name of queueNamesIn(src)) declarations.push({ name, owner: ownerOf(file), file });
  }
  return declarations;
}

if (import.meta.main) {
  const declarations = collectQueueDeclarations();
  const distinct = new Set(declarations.map((d) => d.name));
  if (distinct.size < MIN_EXPECTED_NAMES) {
    console.error(
      `✗ queue-names: the scanner found only ${distinct.size} queue name(s) (expected ≥ ${MIN_EXPECTED_NAMES}); its patterns no longer match the catalogs — fix scripts/check-queue-names.ts rather than ignoring this.`,
    );
    process.exit(1);
  }
  const collisions = findQueueCollisions(declarations);
  if (collisions.length === 0) {
    console.log(
      `✓ queue-names: ${distinct.size} distinct queue name(s) across ${new Set(declarations.map((d) => d.owner)).size} owner(s), none shared between owners`,
    );
    process.exit(0);
  }
  console.error(
    `✗ queue-names: ${collisions.length} queue name(s) declared by more than one owner\n`,
  );
  for (const c of collisions) {
    console.error(`  "${c.name}"`);
    for (const d of c.declarations) console.error(`    - ${d.owner}  (${d.file})`);
  }
  console.error(
    "\n  Two modules on one queue name share one Redis queue: each module's worker takes the other's jobs and\n" +
      "  fails them into the DLQ. Give each module its own prefixed name (e.g. `m23.validation-run`).",
  );
  process.exit(1);
}
