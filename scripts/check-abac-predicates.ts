/**
 * WardenX — ABAC Named-Predicate Resolution Check  (M3 §4.2; fitness check #15)
 * ----------------------------------------------------------------------------
 * Every name a route gates on must be a name some module DECLARES.
 *
 * WHY THIS GATE EXISTS. `requireAbac(permission, "<name>")` resolves `<name>` through M3's
 * registry, which FAILS CLOSED on an unknown name (registry.ts: `fn ? fn(...) : false`). That is
 * the right posture for a security control and a terrible one for a typo: a route gated on a name
 * nobody registered is not broken-loudly, it is a 403 for every caller, forever, with the build,
 * every unit suite and every other fitness check green. It surfaces only when someone runs the app
 * and wonders why an endpoint they hold the permission for refuses them.
 *
 * That is not hypothetical — it is where this check came from. M30 composed 15 guards across 7
 * route files on the M3-base `inOrg` predicate that NOTHING ever registered; the whole Quality
 * surface was unreachable and no gate noticed. A follow-up sweep found one more (`device_attestation_valid`,
 * M33's bulk PHI drilldown export).
 *
 * WHAT IT CHECKS. Every `requireAbac(_, "<name>")` literal in app/package source resolves to a
 * declared predicate name, where "declared" means one of:
 *   - a key of `M3_INTRINSIC_PREDICATES` (packages/auth — seeded, live before any module boots);
 *   - a literal passed to `registerPredicate("<name>", ...)`;
 *   - an element of an exported `*_PREDICATES` array (the per-module ownership set every
 *     `abac-predicates.ts` declares), or the keys of the object such an array is derived from;
 *   - a `*_PREDICATE = "<name>"` const in a file that registers predicates.
 *
 * THERE IS DELIBERATELY NO DEFERRAL ALLOWLIST. A predicate that cannot be resolved yet is
 * expressed as a REGISTERED predicate that denies with a documented reason (see
 * `deviceAttestationValid` in packages/auth/src/abac/registry.ts), never as an unregistered name.
 * Both refuse the request identically; only the first is distinguishable from a mistake.
 *
 * SCOPE. Static and heuristic, like check-tenancy.ts / check-table-ownership.ts: it reads the
 * declarations, not the runtime registry, so it proves a name is OWNED — not that the owning
 * module's boot path ran. Each module's own unit suite covers the second half.
 *
 * Run:   bun run scripts/check-abac-predicates.ts
 * CI:    exits 1 on any unresolved name (arch:fitness stage).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "__tests__"]);

/** Every .ts source file under the scan roots, excluding build output and test fixtures. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.includes(".test."))
        out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

/**
 * Split a call's argument list on TOP-LEVEL commas — the second argument is the predicate name,
 * and arg 0 is routinely an expression containing commas of its own (`P(\`x\`, y)`, object args).
 */
function splitArgs(argText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i]!;
    if (quote) {
      if (ch === quote && argText[i - 1] !== "\\") quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

/** The source span of a call's arguments, starting at the index of its opening paren. */
function argSpan(src: string, openParen: number): { text: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { text: src.slice(openParen + 1, i), end: i };
    }
  }
  return null;
}

/** Unwrap a quoted string literal, or null when the expression is not a plain literal. */
function literal(expr: string): string | null {
  const m = /^(['"`])(.*)\1$/s.exec(expr.trim());
  return m ? m[2]! : null;
}

interface Use {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

const files = sourceFiles();
const sources = new Map<string, string>(files.map((f) => [f, readFileSync(f, "utf8")]));

// ── Declared names ────────────────────────────────────────────────────────────────────────────
const declared = new Map<string, string>(); // name -> declaring file (first wins, for diagnostics)
const addDeclared = (name: string, file: string): void => {
  if (!declared.has(name)) declared.set(name, relative(REPO_ROOT, file));
};
/** `NAME = "literal"` consts, repo-wide — used to resolve an identifier passed to requireAbac. */
const stringConsts = new Map<string, string>();
/** `NAME.prop` → literal, for the name-map objects some modules gate through (M6's shape). */
const memberConsts = new Map<string, string>();

for (const [file, src] of sources) {
  for (const m of src.matchAll(/(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(['"])(.*?)\2/g)) {
    if (!stringConsts.has(m[1]!)) stringConsts.set(m[1]!, m[3]!);
  }
  for (const m of src.matchAll(/(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*\{/g)) {
    const open = src.indexOf("{", m.index + m[0].length - 1);
    const close = src.indexOf("\n}", open);
    if (close === -1) continue;
    for (const p of src.slice(open, close).matchAll(/^\s*(\w+)\s*:\s*(['"])(.*?)\2/gm)) {
      memberConsts.set(`${m[1]!}.${p[1]!}`, p[3]!);
    }
  }

  // M3's intrinsic seed — the predicates live before any module boots.
  const intrinsic = /M3_INTRINSIC_PREDICATES\s*:[^=]*=\s*\{/.exec(src);
  if (intrinsic) {
    const open = src.indexOf("{", intrinsic.index);
    const close = src.indexOf("};", open);
    for (const m of src.slice(open, close).matchAll(/^\s*(\w+)\s*[,:]/gm)) addDeclared(m[1]!, file);
  }

  const registersHere = src.includes("registerPredicate(");

  // Literal registrations: registerPredicate("name", fn).
  for (const m of src.matchAll(/registerPredicate\(\s*(['"])(.*?)\1/g)) addDeclared(m[2]!, file);

  // Per-module ownership sets: `export const M<N>_..._PREDICATES = [...]`, the convention every
  // abac-predicates.ts follows (their registrars loop over a record keyed by these names).
  for (const m of src.matchAll(/export const \w*_PREDICATES\b[^=]*=\s*/g)) {
    const rest = src.slice(m.index + m[0].length);
    const arrayEnd = rest.indexOf("]");
    if (rest.startsWith("[") && arrayEnd !== -1) {
      for (const lit of rest.slice(0, arrayEnd).matchAll(/(['"])(.*?)\1/g)) addDeclared(lit[2]!, file);
      continue;
    }
    // `Object.keys(SOME_MAP)` — declare the keys of the object literal it names (M39's shape).
    const derived = /^Object\.keys\(\s*(\w+)\s*\)/.exec(rest);
    if (derived) {
      const decl = new RegExp(`const ${derived[1]!}\\b[^=]*=\\s*\\{`).exec(src);
      if (decl) {
        const open = src.indexOf("{", decl.index);
        const close = src.indexOf("};", open);
        for (const k of src.slice(open, close).matchAll(/^\s*(\w+)\s*:/gm)) addDeclared(k[1]!, file);
      }
    }
  }

  // Single-name consts in a file that registers predicates: `export const X_PREDICATE = "name"`.
  if (registersHere) {
    for (const m of src.matchAll(/const \w*_PREDICATE\b[^=]*=\s*(['"])(.*?)\1/g))
      addDeclared(m[2]!, file);
  }
}

// ── Guard wrappers ────────────────────────────────────────────────────────────────────────────
// Most modules do not call `requireAbac` at the route: they define a local factory in guards.ts —
// `export const ABAC = (key: string, predicate: string) => requireAbac(key, predicate, {...})` —
// and the route names its predicate at the WRAPPER call. Follow one level of indirection so those
// names are checked too; without it M24/M26/M17/M18/M30's guards would go unverified.
// Keyed by wrapper name repo-wide: the shape is uniform, and a same-named wrapper elsewhere would
// at worst have one more literal checked against the same declaration set.
const wrapperArgIndex = new Map<string, number>();
/** `file:offset` of each `requireAbac(` that IS a wrapper body — checked at its call sites instead. */
const wrapperBodies = new Set<string>();

for (const [file, src] of sources) {
  for (const m of src.matchAll(/const (\w+)\s*=\s*\(([^)]*)\)[^=]*=>\s*\n?\s*requireAbac\s*\(/g)) {
    const params = splitArgs(m[2]!).map((p) => p.split(":")[0]!.trim());
    const open = m.index + m[0].length - 1;
    const span = argSpan(src, open);
    if (!span) continue;
    const nameArg = splitArgs(span.text)[1];
    if (nameArg === undefined) continue;
    const idx = params.indexOf(nameArg);
    if (idx < 0) continue;
    wrapperArgIndex.set(m[1]!, idx);
    wrapperBodies.add(`${file}:${open}`);
  }
}

// ── Used names ────────────────────────────────────────────────────────────────────────────────
const uses: Use[] = [];
const unresolvable: Use[] = [];

/** Record every `callee(...)` whose argument at `argIndex` names an ABAC predicate. */
function collectUses(callee: string, argIndex: number): void {
  const pattern = new RegExp(`\\b${callee}\\s*\\(`, "g");
  for (const [file, src] of sources) {
    for (const m of src.matchAll(pattern)) {
      // Prose, not a guard: doc comments quote these calls freely, and require-abac.ts declares
      // the signature itself. Neither reaches the registry.
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const before = src.slice(lineStart, m.index);
      if (before.includes("//") || /^\s*\*/.test(before)) continue;
      if (/\b(const|function|export)\s*$/.test(before)) continue; // the wrapper's own definition

      const open = m.index + m[0].length - 1;
      if (wrapperBodies.has(`${file}:${open}`)) continue; // checked at the wrapper's call sites

      const span = argSpan(src, open);
      if (!span) continue;
      const args = splitArgs(span.text);
      const nameArg = args[argIndex];
      if (nameArg === undefined) continue;
      if (/^\w+\s*:\s*\w/.test(nameArg)) continue; // a parameter declaration, not a call

      const lit = literal(nameArg);
      const name =
        lit ??
        (/^\w+$/.test(nameArg) ? stringConsts.get(nameArg) : undefined) ??
        memberConsts.get(nameArg);
      const line = src.slice(0, m.index).split("\n").length;
      const use: Use = { name: name ?? nameArg, file: relative(REPO_ROOT, file), line };
      if (name === undefined) unresolvable.push(use);
      else uses.push(use);
    }
  }
}

collectUses("requireAbac", 1);
for (const [wrapper, index] of wrapperArgIndex) collectUses(wrapper, index);

// ── Report ────────────────────────────────────────────────────────────────────────────────────
const violations = uses.filter((u) => !declared.has(u.name));
const distinctUsed = new Set(uses.map((u) => u.name));

console.log(
  `ABAC predicates: ${declared.size} declared · ${distinctUsed.size} used by requireAbac across ${uses.length} guard(s)`,
);

if (unresolvable.length > 0) {
  // Not a failure: an expression-valued name cannot be checked statically, but it must be visible.
  console.log(`\n  note — ${unresolvable.length} guard(s) name a predicate by expression:`);
  for (const u of unresolvable) console.log(`    ${u.file}:${u.line}  ${u.name}`);
}

if (violations.length > 0) {
  console.error(`\n✖ ${violations.length} guard(s) name a predicate NOTHING declares.`);
  console.error(
    "  The registry fails closed on an unknown name, so each of these is a permanently dead\n" +
      "  endpoint — a 403 for every caller, regardless of permission.\n",
  );
  const byName = new Map<string, Use[]>();
  for (const v of violations) byName.set(v.name, [...(byName.get(v.name) ?? []), v]);
  for (const [name, at] of byName) {
    console.error(`  '${name}'`);
    for (const u of at) console.error(`      ${u.file}:${u.line}`);
  }
  console.error(
    "\n  Fix by REGISTERING the name — with real semantics, or (when its inputs do not exist yet)\n" +
      "  as a predicate that denies and says why, like `deviceAttestationValid`. Do not drop the guard.",
  );
  process.exit(1);
}

console.log("✔ every requireAbac predicate name is declared by an owning module");
