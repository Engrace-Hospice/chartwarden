/**
 * WardenX — OpenAPI schema-provenance gate (#31 / #36)
 * ----------------------------------------------------
 * `bun run arch:openapi-provenance`
 *
 * WHAT THE EXISTING GATES DO NOT CHECK
 *
 * `openapi:check` re-runs the emitter and diffs the result against the committed
 * docs/api/openapi.json. `client:check` re-runs openapi-typescript and diffs against the committed
 * packages/ui/src/core/api/schema.ts. Both compare GENERATED OUTPUT TO GENERATED OUTPUT: they prove
 * the artifacts are current, and nothing about whether the contract is RIGHT. A route wired to the
 * wrong schema regenerates perfectly consistently, so the emitted contract does not look absent or
 * stale — it looks satisfied.
 *
 * That is exactly how #31 shipped. `TenantExportJobListResponseSchema` is exported by BOTH
 * routes/platform/platform-typebox.ts and routes/tenant/tenant-typebox.ts, and enrichments.ts aliased
 * both to one name. The second binding won, so `GET /api/v1/platform/tenant-export-jobs` — a
 * CROSS-TENANT ops list — published the tenant-scoped shape, with no `organizationId` to attribute a
 * job to a tenant and none of the four `held*` fields its own `?held=true` filter selects on. Every
 * gate stayed green.
 *
 * THREE RULES
 *
 * 1. ALIAS UNIQUENESS — no local name may be bound by more than one import. A duplicate silently
 *    discards one schema: the last binding wins and every route naming that alias publishes it,
 *    whatever contract the route was written against. This is the mechanism of #31.
 *
 * 2. DIRECTORY PROVENANCE — a route may use schemas co-located with its own registration file, or
 *    shared from an ANCESTOR directory. It may never reach into a SIBLING surface. A route in
 *    routes/platform/ using routes/platform/platform-typebox is right; using routes/typebox (the
 *    module's shared root) is right; using routes/tenant/tenant-typebox is the #31 defect.
 *
 * 3. KEY UNIQUENESS (F-061 / #156) — no `METHOD /path` key may be declared by more than one entry.
 *    This is rule 1 one level up, and it went unasked for the whole life of the registry. The file
 *    is a base literal followed by 47 `Object.assign(ROUTE_ENRICHMENTS, {...})` blocks, so a second
 *    entry for a key REPLACES the first wholesale — not field-by-field. 441 keys were declared
 *    twice and 422 of the pairs DISAGREED; 62% of the original base literal was unreachable text.
 *    Nothing could see it: `openapi:check` proves the contract was regenerated from the resolved
 *    map, `arch:openapi-coverage` counts routes with NO enrichment, `client:check` runs downstream
 *    of resolution, and rule 2 above reads the same collapsed Map. Every gate ran on what survived
 *    `Object.assign` and none asked what it discarded.
 *
 *    It is not merely dead text. A superseded schema is worse than a wrong one — wrong somewhere a
 *    reader will still find it, and right nowhere anything checks. M7's shadowed care-plan DTO
 *    declared `requiredSignerSet: Type.Array(Type.String())` while the wire had always sent
 *    `{ role, count }`; two screens were written from it and would have thrown on the first
 *    finalized version (#155). And the shadowing silently DEGRADED the published contract 123
 *    times, where the later block re-summarised a route it did not know was already documented.
 *
 *    There is deliberately NO allowlist, and the one shape that could argue for one is banned with
 *    it: an entry that reads `...ROUTE_ENRICHMENTS["<its own key>"]` to extend an earlier entry.
 *    Seventeen M32 routes were written that way and they worked — but they make a key's published
 *    value depend on evaluation ORDER, which is the property that failed, and they are
 *    indistinguishable at a glance from the 424 that were silently clobbered. With one entry per
 *    key, extending it means editing it.
 *
 * SCOPE, STATED OUT LOUD
 *
 * Rule 2 can only attribute schemas imported by RELATIVE path — those resolve to a file whose
 * directory can be compared to the route's. Two kinds of schema cannot be placed this way: consts
 * declared locally in enrichments.ts, and imports from workspace packages (`@chartwarden/billing`).
 * Those are not silently dropped — the run prints how many route→schema pairs went unattributed and
 * why. A gate that quietly skipped a third of its input while reporting OK would be the same class
 * of lie this file exists to catch.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ScannedRoute, routeKey, scanRoutes } from "./openapi/scan-routes";

const REPO_ROOT = process.cwd();
const ENRICHMENTS = join(REPO_ROOT, "scripts/openapi/enrichments.ts");

export interface ImportBinding {
  /** the local name introduced in enrichments.ts */
  local: string;
  /** the name as exported by the source module */
  imported: string;
  /** the module specifier as written */
  from: string;
  /** absolute, extension-less path when `from` is relative; null for package imports */
  resolved: string | null;
}

export interface Violation {
  rule: "duplicate-alias" | "sibling-surface" | "duplicate-key" | "order-dependent-entry";
  message: string;
}

/**
 * Walk a brace-balanced object literal starting at `open` (the index of its `{`).
 *
 * Hand-rolled rather than regex because enrichments.ts is 12k lines of nested TypeBox literals,
 * prose comments containing unmatched braces and apostrophes, and single-line entries. A non-greedy
 * `\{[\s\S]*?\}` match runs straight past a one-line entry into the following block and attributes
 * the NEXT route's schemas to it — which is precisely the false positive this scanner was written
 * to eliminate (it briefly reported the M35 Stripe webhook publishing an M30 CAHPS schema).
 */
function objectAt(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i] as string;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced object literal at index ${open} in enrichments.ts`);
}

/** Top-level `body:` / `response:` / `query:` identifiers of one enrichment entry. */
export function schemaIdentifiers(entryBody: string): string[] {
  // Flatten away nested objects/arrays/calls so an identifier inside `Type.Object({ ... })` is not
  // mistaken for the entry's own schema binding.
  let depth = 0;
  let quote: string | null = null;
  let flat = "";
  for (let i = 0; i < entryBody.length; i++) {
    const c = entryBody[i] as string;
    if (quote) {
      if (depth === 0) flat += c;
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && entryBody[i + 1] === "/") {
      const nl = entryBody.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === "/" && entryBody[i + 1] === "*") {
      const end = entryBody.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      if (depth === 0) flat += c;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      continue;
    }
    if (depth === 0) flat += c;
  }
  const ids: string[] = [];
  for (const m of flat.matchAll(
    /(?:^|,)\s*(?:body|response|query)\s*:\s*([A-Za-z0-9_$]+)\s*(?=,|$)/g,
  )) {
    ids.push(m[1] as string);
  }
  return ids;
}

/** Every named import binding in enrichments.ts. */
export function importBindings(src: string, enrichmentsPath = ENRICHMENTS): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    const from = m[2] as string;
    const resolved = from.startsWith(".") ? resolve(dirname(enrichmentsPath), from) : null;
    for (const raw of (m[1] as string).split(",")) {
      const entry = raw.replace(/\/\/[^\n]*/g, "").trim();
      if (!entry) continue;
      const aliased = entry.match(/^(?:type\s+)?([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
      if (aliased) {
        out.push({
          imported: aliased[1] as string,
          local: aliased[2] as string,
          from,
          resolved,
        });
        continue;
      }
      const bare = entry.match(/^(?:type\s+)?([A-Za-z0-9_$]+)$/);
      if (bare) {
        out.push({ imported: bare[1] as string, local: bare[1] as string, from, resolved });
      }
    }
  }
  return out;
}

/** `METHOD /path` → the schema identifiers its enrichment names. */
export function routeSchemaIdentifiers(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]+)":\s*\{/g)) {
    const open = (m.index as number) + m[0].length - 1;
    out.set(m[1] as string, schemaIdentifiers(objectAt(src, open)));
  }
  return out;
}

/** Rule 1 — no local name bound twice. */
export function duplicateAliases(bindings: ImportBinding[]): Violation[] {
  const byLocal = new Map<string, ImportBinding[]>();
  for (const b of bindings) {
    const seen = byLocal.get(b.local) ?? [];
    seen.push(b);
    byLocal.set(b.local, seen);
  }
  const out: Violation[] = [];
  for (const [local, uses] of byLocal) {
    if (uses.length < 2) continue;
    out.push({
      rule: "duplicate-alias",
      message: `${local} is bound by ${uses.length} imports — the last one wins and the others are silently discarded:\n${uses.map((u) => `      ${u.imported} from ${u.from}`).join("\n")}`,
    });
  }
  return out;
}

/**
 * Every `"METHOD /path":` entry in enrichments.ts, with the 1-based line each is declared on.
 *
 * Deliberately the SAME enumeration `routeSchemaIdentifiers` uses, so the two rules cannot disagree
 * about what an entry is: that function returns a Map and therefore reports only the survivor of a
 * duplicated key, which is exactly the blindness rule 3 exists to remove.
 */
export function routeKeyOccurrences(src: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const m of src.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]+)":\s*\{/g)) {
    const key = m[1] as string;
    const line = src.slice(0, m.index as number).split("\n").length;
    const seen = out.get(key) ?? [];
    seen.push(line);
    out.set(key, seen);
  }
  return out;
}

/**
 * Rule 3 — one entry per route key, and no entry whose value depends on an earlier one.
 *
 * `Object.assign` replaces a key's value WHOLESALE, so a second entry does not extend the first, it
 * erases it. The spread form (`...ROUTE_ENRICHMENTS["<key>"]`) is the one way to write a second entry
 * that keeps the first, and it is refused with the duplicates: it makes the published value a
 * function of block order, and it reads at a glance exactly like the 424 entries that were silently
 * clobbered.
 */
export function duplicateRouteKeys(src: string): Violation[] {
  const out: Violation[] = [];
  for (const [key, lines] of routeKeyOccurrences(src)) {
    if (lines.length < 2) continue;
    out.push({
      rule: "duplicate-key",
      message: `${key} is declared by ${lines.length} entries (lines ${lines.join(", ")}) — Object.assign replaces the value wholesale, so only the last is published and the rest are unreachable text a reader will still find`,
    });
  }
  for (const m of src.matchAll(/\.\.\.ROUTE_ENRICHMENTS\[\s*"([^"]+)"\s*\]/g)) {
    const line = src.slice(0, m.index as number).split("\n").length;
    out.push({
      rule: "order-dependent-entry",
      message: `line ${line} extends the earlier entry for ${m[1]} by spreading it — write ONE entry per key instead; an entry whose published value depends on block order is the shape rule 3 exists to prevent`,
    });
  }
  return out;
}

export interface ProvenanceReport {
  checked: number;
  /** pairs whose schema is a local const or a package import — not placeable by directory */
  unattributed: number;
  unattributedNames: string[];
  violations: Violation[];
}

/** Rule 2 — a route's schema must come from its own directory or an ancestor, never a sibling. */
export function directoryProvenance(
  routes: ScannedRoute[],
  routeSchemas: Map<string, string[]>,
  bindings: ImportBinding[],
  repoRoot = REPO_ROOT,
): ProvenanceReport {
  const sourceOf = new Map(bindings.map((b) => [b.local, b.resolved]));
  const known = new Set(bindings.map((b) => b.local));
  const byKey = new Map(routes.map((r) => [routeKey(r), r]));

  let checked = 0;
  const unattributedNames = new Set<string>();
  let unattributed = 0;
  const violations: Violation[] = [];

  for (const [key, ids] of routeSchemas) {
    const route = byKey.get(key);
    if (!route) continue; // emit.ts already fails on enrichments targeting a dead route
    const routeDir = dirname(join(repoRoot, route.file));
    for (const id of ids) {
      const resolved = known.has(id) ? sourceOf.get(id) : undefined;
      if (!resolved) {
        // a const declared in enrichments.ts, or a workspace-package import: no file to compare
        unattributed++;
        unattributedNames.add(id);
        continue;
      }
      checked++;
      const schemaDir = dirname(resolved);
      const ok = routeDir === schemaDir || routeDir.startsWith(`${schemaDir}/`);
      if (ok) continue;
      violations.push({
        rule: "sibling-surface",
        message: `${key}\n      route  : ${route.file}\n      schema : ${id}\n      from   : ${resolved.slice(repoRoot.length + 1)}\n      the schema lives in a sibling surface, not this route's directory or an ancestor`,
      });
    }
  }
  return { checked, unattributed, unattributedNames: [...unattributedNames].sort(), violations };
}

export function run(repoRoot = REPO_ROOT): {
  violations: Violation[];
  report: ProvenanceReport;
  routeKeys: number;
} {
  const enrichmentsPath = join(repoRoot, "scripts/openapi/enrichments.ts");
  const src = readFileSync(enrichmentsPath, "utf8");
  const bindings = importBindings(src, enrichmentsPath);
  const dupes = duplicateAliases(bindings);
  const dupeKeys = duplicateRouteKeys(src);
  const report = directoryProvenance(
    scanRoutes(repoRoot),
    routeSchemaIdentifiers(src),
    bindings,
    repoRoot,
  );
  return {
    violations: [...dupes, ...dupeKeys, ...report.violations],
    report,
    routeKeys: routeKeyOccurrences(src).size,
  };
}

function main(): void {
  const { violations, report, routeKeys } = run();
  const total = report.checked + report.unattributed;
  if (violations.length === 0) {
    console.log(
      `OK openapi-provenance: ${report.checked}/${total} route→schema pairs attributed to a source file, all from the route's own directory or an ancestor; no duplicate aliases; ${routeKeys} route keys each declared exactly once`,
    );
    console.log(
      `   ${report.unattributed} pair(s) not placeable by directory (${report.unattributedNames.length} distinct: local consts in enrichments.ts and @chartwarden/* package imports) — reported, not silently skipped`,
    );
    return;
  }
  console.error(`✗ openapi-provenance: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.message}\n`);
  }
  console.error(
    "  A route wired to the wrong schema regenerates consistently, so openapi:check and\n" +
      "  client:check cannot see it — they compare generated output to generated output.\n" +
      "  A route DECLARED TWICE is worse: every gate reads the map Object.assign left behind, so\n" +
      "  the discarded entry is checked by nothing and free to drift into whatever a reader copies.\n",
  );
  process.exit(1);
}

if (import.meta.main) main();
