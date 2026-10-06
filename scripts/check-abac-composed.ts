#!/usr/bin/env bun
/**
 * WardenX — ABAC predicate composition gate (GAP-067)
 * ---------------------------------------------------------------------------
 * `arch:abac-predicates` proves every `requireAbac(_, "<name>")` NAMES a declared predicate. It cannot
 * see the opposite failure: a predicate that is REGISTERED and never composed by any guard. That one is
 * silent in the same way — the registry, the boot wiring and the predicate's own unit suite are all
 * green while no route consults it. GAP-067 is the instance that surfaced it: M39 registered
 * `sud_consent_present` (the 42 CFR Part 2 need-to-know gate) for M22/M05/M08/M12 to compose, and nothing
 * did, so DocLens returned decrypted SUD content to any `intake.review` holder.
 *
 * WHAT IT CHECKS. Every declared predicate name is either
 *   - composed: some `requireAbac(_, "<name>")` (or a local wrapper of it — see below) names it; or
 *   - listed in `scripts/abac-uncomposed-allowlist.ts` with a REASON.
 * An allowlist entry that is now composed, no longer declared, or has an empty reason is an error, so an
 * entry cannot outlive its cause and the list can only shrink.
 *
 * "Declared" and "composed" use the same static reading as `check-abac-predicates.ts` (duplicated here,
 * not imported: that script runs on import and exits the process). Like it, this is a heuristic over
 * source text: it proves a name is NAMED by a guard, not that the guard is mounted on a route.
 *
 * Run:  bun run arch:abac-composed   (in `arch:fitness`)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ABAC_UNCOMPOSED_ALLOWLIST } from "./abac-uncomposed-allowlist";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "__tests__"]);

export interface CompositionScan {
  /** name → declaring file. */
  readonly declared: ReadonlyMap<string, string>;
  /** name → `file:line` of every guard that names it. */
  readonly composed: ReadonlyMap<string, readonly string[]>;
}

export type Violation =
  | { readonly kind: "uncomposed"; readonly name: string; readonly declaredIn: string }
  | { readonly kind: "stale-allowlist-composed"; readonly name: string }
  | { readonly kind: "stale-allowlist-undeclared"; readonly name: string }
  | { readonly kind: "allowlist-without-reason"; readonly name: string };

function sourceFiles(root: string): string[] {
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
  for (const r of SCAN_ROOTS) walk(join(root, r));
  return out;
}

/**
 * Blank `//` and block comments (keeping offsets and newlines) so an apostrophe in prose cannot flip the
 * quote state of the argument scanner — `require-abac.ts`'s own `requireStepUp` call carries one, which
 * made the unblanked scan miss the one place `step_up_recent` is composed.
 */
export function blankComments(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      i--;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      i--;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

function splitArgs(argText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i] as string;
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

function argSpan(src: string, openParen: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i] as string;
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return null;
}

const literal = (expr: string): string | null => /^(['"`])(.*)\1$/s.exec(expr.trim())?.[2] ?? null;

/** Collect every declared predicate name (same sources as `check-abac-predicates.ts`). */
function collectDeclared(sources: ReadonlyMap<string, string>, root: string): Map<string, string> {
  const declared = new Map<string, string>();
  const add = (name: string, file: string): void => {
    if (!declared.has(name)) declared.set(name, relative(root, file));
  };
  for (const [file, src] of sources) {
    const intrinsic = /M3_INTRINSIC_PREDICATES\s*:[^=]*=\s*\{/.exec(src);
    if (intrinsic) {
      const open = src.indexOf("{", intrinsic.index);
      const close = src.indexOf("};", open);
      for (const m of src.slice(open, close).matchAll(/^\s*(\w+)\s*[,:]/gm))
        add(m[1] as string, file);
    }
    const registersHere =
      src.includes("registerPredicate(") || src.includes("registerPredicateIdempotent(");
    for (const m of src.matchAll(/registerPredicate(?:Idempotent)?\(\s*(['"])(.*?)\1/g))
      add(m[2] as string, file);
    for (const m of src.matchAll(/export const \w*_PREDICATES\b[^=]*=\s*/g)) {
      const rest = src.slice((m.index ?? 0) + m[0].length);
      const arrayEnd = rest.indexOf("]");
      if (rest.startsWith("[") && arrayEnd !== -1) {
        for (const lit of rest.slice(0, arrayEnd).matchAll(/(['"])(.*?)\1/g))
          add(lit[2] as string, file);
        continue;
      }
      const derived = /^Object\.keys\(\s*(\w+)\s*\)/.exec(rest);
      if (!derived) continue;
      const decl = new RegExp(`const ${derived[1]}\\b[^=]*=\\s*\\{`).exec(src);
      if (!decl) continue;
      const open = src.indexOf("{", decl.index);
      const close = src.indexOf("};", open);
      for (const k of src.slice(open, close).matchAll(/^\s*(\w+)\s*:/gm)) add(k[1] as string, file);
    }
    if (registersHere) {
      for (const m of src.matchAll(/const \w*_PREDICATE\b[^=]*=\s*(['"])(.*?)\1/g))
        add(m[2] as string, file);
    }
  }
  return declared;
}

/** Collect every predicate name a `requireAbac` call (or a one-level local wrapper) names. */
function collectComposed(
  sources: ReadonlyMap<string, string>,
  root: string,
): Map<string, string[]> {
  // Identifiers resolve file-locally FIRST: `ABAC_PREDICATE`-style names repeat across modules, and a
  // repo-wide first-wins map resolves one module's guard to another module's predicate.
  const stringConsts = new Map<string, string>();
  const localConsts = new Map<string, Map<string, string>>();
  const memberConsts = new Map<string, string>();
  for (const [file, src] of sources) {
    const local = new Map<string, string>();
    localConsts.set(file, local);
    for (const m of src.matchAll(/(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(['"])(.*?)\2/g)) {
      local.set(m[1] as string, m[3] as string);
      if (!stringConsts.has(m[1] as string)) stringConsts.set(m[1] as string, m[3] as string);
    }
    for (const m of src.matchAll(/(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*\{/g)) {
      const open = src.indexOf("{", (m.index ?? 0) + m[0].length - 1);
      const close = src.indexOf("\n}", open);
      if (close === -1) continue;
      for (const p of src.slice(open, close).matchAll(/^\s*(\w+)\s*:\s*(['"])(.*?)\2/gm))
        memberConsts.set(`${m[1]}.${p[1]}`, p[3] as string);
    }
  }

  const wrapperArgIndex = new Map<string, number>();
  const wrapperBodies = new Set<string>();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(
      /const (\w+)\s*=\s*\(([^)]*)\)[^=]*=>\s*\n?\s*requireAbac\s*\(/g,
    )) {
      const params = splitArgs(m[2] as string).map((p) => (p.split(":")[0] as string).trim());
      const open = (m.index ?? 0) + m[0].length - 1;
      const text = argSpan(src, open);
      if (text === null) continue;
      const nameArg = splitArgs(text)[1];
      if (nameArg === undefined) continue;
      const idx = params.indexOf(nameArg);
      if (idx < 0) continue;
      wrapperArgIndex.set(m[1] as string, idx);
      wrapperBodies.add(`${file}:${open}`);
    }
  }

  const composed = new Map<string, string[]>();
  const collect = (callee: string, argIndex: number): void => {
    const pattern = new RegExp(`\\b${callee}\\s*\\(`, "g");
    for (const [file, src] of sources) {
      for (const m of src.matchAll(pattern)) {
        const index = m.index ?? 0;
        const lineStart = src.lastIndexOf("\n", index) + 1;
        const before = src.slice(lineStart, index);
        if (before.includes("//") || /^\s*\*/.test(before)) continue;
        if (/\b(const|function|export)\s*$/.test(before)) continue;
        const open = index + m[0].length - 1;
        if (wrapperBodies.has(`${file}:${open}`)) continue;
        const text = argSpan(src, open);
        if (text === null) continue;
        const nameArg = splitArgs(text)[argIndex];
        if (nameArg === undefined || /^\w+\s*:\s*\w/.test(nameArg)) continue;
        const name =
          literal(nameArg) ??
          (/^\w+$/.test(nameArg)
            ? (localConsts.get(file)?.get(nameArg) ?? stringConsts.get(nameArg))
            : undefined) ??
          memberConsts.get(nameArg);
        if (name === undefined) continue;
        const line = src.slice(0, index).split("\n").length;
        composed.set(name, [...(composed.get(name) ?? []), `${relative(root, file)}:${line}`]);
      }
    }
  };
  collect("requireAbac", 1);
  for (const [wrapper, index] of wrapperArgIndex) collect(wrapper, index);
  return composed;
}

export function scanAbacComposition(root: string = REPO_ROOT): CompositionScan {
  const sources = new Map<string, string>(
    sourceFiles(root).map((f) => [f, blankComments(readFileSync(f, "utf8"))]),
  );
  return { declared: collectDeclared(sources, root), composed: collectComposed(sources, root) };
}

export function findViolations(
  scan: CompositionScan,
  allowlist: Readonly<Record<string, string>> = ABAC_UNCOMPOSED_ALLOWLIST,
): Violation[] {
  const out: Violation[] = [];
  for (const [name, declaredIn] of scan.declared) {
    if (!scan.composed.has(name) && !Object.hasOwn(allowlist, name))
      out.push({ kind: "uncomposed", name, declaredIn });
  }
  for (const [name, reason] of Object.entries(allowlist)) {
    if (reason.trim().length === 0) out.push({ kind: "allowlist-without-reason", name });
    if (!scan.declared.has(name)) out.push({ kind: "stale-allowlist-undeclared", name });
    else if (scan.composed.has(name)) out.push({ kind: "stale-allowlist-composed", name });
  }
  return out;
}

function main(): never {
  const scan = scanAbacComposition();
  const violations = findViolations(scan);
  console.log(
    `ABAC composition: ${scan.declared.size} declared · ${scan.composed.size} composed by requireAbac · ${Object.keys(ABAC_UNCOMPOSED_ALLOWLIST).length} allowlisted`,
  );
  if (violations.length === 0) {
    console.log(
      "✔ every declared ABAC predicate is composed by a guard or allowlisted with a reason",
    );
    process.exit(0);
  }
  console.error(`\n✖ ${violations.length} ABAC composition violation(s):\n`);
  for (const v of violations) {
    if (v.kind === "uncomposed")
      console.error(
        `  '${v.name}' (${v.declaredIn}) is registered but no requireAbac composes it.\n      Compose it on the route/service that needs it, or add it to\n      scripts/abac-uncomposed-allowlist.ts WITH a reason.`,
      );
    else if (v.kind === "stale-allowlist-composed")
      console.error(`  '${v.name}' is allowlisted but now composed — remove the allowlist entry.`);
    else if (v.kind === "stale-allowlist-undeclared")
      console.error(`  '${v.name}' is allowlisted but no longer declared — remove the entry.`);
    else console.error(`  '${v.name}' is allowlisted without a reason.`);
  }
  process.exit(1);
}

if (import.meta.main) main();
