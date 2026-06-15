/**
 * WardenX — Table Ownership Check
 * ------------------------------------------------------------------
 * The leak RLS does NOT catch: Module 8 reading Module 12's tables WITHIN the
 * same org. RLS enforces the tenant boundary; it says nothing about which module
 * may touch which table. Table ownership is part of the module boundary, so we
 * enforce it here.
 *
 * What it does:
 *   - For each module, scan its code paths for references to Drizzle schema tables
 *     (imports from packages/db/src/schema/* and use of exported table consts).
 *   - Flag any reference to a table the module does NOT own, unless:
 *       (a) the table is HELPER_ONLY (audit_event/outbox/idempotency) AND the
 *           reference is the owning helper package, or
 *       (b) the table is owned by a module in this module's dependsOn AND the
 *           access is READ-only via that module's repository (see note).
 *
 * Pragmatics: this is a fast, import-level static check (not a full type-graph).
 * It catches the common, dangerous case — a feature module importing another
 * module's schema and querying it directly. Cross-module READS must go through
 * the owner's exported repository/service, never its schema. That convention is
 * what keeps ownership meaningful; this check enforces the schema-import half of
 * it, and code review / the depcruise module-boundary rule covers the rest.
 *
 * Run:   bun run scripts/check-table-ownership.ts
 * CI:    exits 1 on any violation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MODULES,
  MODULE_BY_ID,
  HELPER_ONLY_TABLES,
  type ModuleDef,
} from "../architecture/module-manifest";

const REPO_ROOT = process.cwd();
const SCHEMA_DIR = "packages/db/src/schema";

// table const name <-> table sql name. We derive the sql name from the pgTable
// first-arg string in each schema file, and map back to the exported const.
// Shape we look for:  export const memberships = pgTable('membership', { ... })
type TableRef = { constName: string; sqlName: string; file: string };

function listFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(join(REPO_ROOT, dir)); } catch { return acc; }
  for (const e of entries) {
    const rel = join(dir, e);
    const abs = join(REPO_ROOT, rel);
    if (statSync(abs).isDirectory()) {
      if (e === "node_modules" || e === "dist" || e === ".turbo") continue;
      listFiles(rel, acc);
    } else if (/\.(ts|tsx)$/.test(e)) {
      acc.push(rel);
    }
  }
  return acc;
}

// 1. Build the table registry from schema files.
function buildTableRegistry(): TableRef[] {
  const refs: TableRef[] = [];
  for (const file of listFiles(SCHEMA_DIR)) {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const re = /export\s+const\s+(\w+)\s*=\s*pgTable\(\s*['"]([\w]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) refs.push({ constName: m[1]!, sqlName: m[2]!, file });
  }
  return refs;
}

// 2. Which module owns a given sql table name?
function ownerOf(sqlName: string): ModuleDef | undefined {
  return MODULES.find((mod) => mod.ownedTables.includes(sqlName));
}

// 3. Scan a module's files for schema-table references it shouldn't have.
type Violation = { module: ModuleDef; file: string; table: string; owner?: ModuleDef };

function scan(): Violation[] {
  const registry = buildTableRegistry();
  const byConst = new Map(registry.map((r) => [r.constName, r]));
  const violations: Violation[] = [];

  for (const mod of MODULES) {
    const ownAndDeps = new Set<number>([mod.id, ...mod.dependsOn]);
    const files = mod.codePaths.flatMap((p) => listFiles(p));
    for (const file of files) {
      // skip the module's own schema files
      if (file.startsWith(SCHEMA_DIR) && mod.id !== 1) continue;
      const src = readFileSync(join(REPO_ROOT, file), "utf8");

      for (const ref of registry) {
        // crude but effective: a word-boundary reference to the table const
        const used = new RegExp(`\\b${ref.constName}\\b`).test(src) &&
                     /from ['"].*schema/.test(src);
        if (!used) continue;

        const owner = ownerOf(ref.sqlName);

        // helper-only tables: only the helper package may reference them
        if (ref.sqlName in HELPER_ONLY_TABLES) {
          const helperOk =
            file.startsWith("packages/audit") ||
            file.startsWith("packages/shared") ||
            file.startsWith("packages/db");
          if (!helperOk) violations.push({ module: mod, file, table: ref.sqlName, owner });
          continue;
        }

        // owned by this module -> fine
        if (owner && owner.id === mod.id) continue;
        // owned table is unknown (unspecced) -> can't judge yet; skip conservatively
        if (!owner) continue;
        // owned by a dependency -> still a violation for DIRECT schema use:
        // cross-module access must go through the owner's repository, not its schema.
        if (ownAndDeps.has(owner.id)) {
          violations.push({ module: mod, file, table: ref.sqlName, owner });
          continue;
        }
        // owned by a non-dependency -> hard violation
        violations.push({ module: mod, file, table: ref.sqlName, owner });
      }
    }
  }
  return violations;
}

// 4. ADR-0011: catch ownership EVASIONS the import check misses — raw SQL naming
//    another module's table, PL/pgSQL trigger bodies reading another module's table,
//    withPlatformContext touching PHI without an org predicate, and migration writes
//    to helper-only tables outside the helper paths.
function scanEvasions(): Violation[] {
  const registry = buildTableRegistry();
  const sqlByName = new Map(registry.map((r) => [r.sqlName, r]));
  const out: Violation[] = [];
  const HELPER_PATHS = ["packages/audit", "packages/shared", "packages/db"];

  for (const mod of MODULES) {
    const ownAndDeps = new Set<number>([mod.id, ...mod.dependsOn]);
    for (const file of mod.codePaths.flatMap((p) => listFiles(p))) {
      if (file.startsWith(SCHEMA_DIR)) continue;
      const src = readFileSync(join(REPO_ROOT, file), "utf8");
      const isHelperPath = HELPER_PATHS.some((p) => file.startsWith(p));

      // (a) raw SQL / PL/pgSQL naming another module's owned table by sql name
      const inRawSql = /sql`|db\.execute\(|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|LANGUAGE\s+plpgsql/i.test(src);
      if (inRawSql) {
        for (const [sqlName, ref] of sqlByName) {
          const owner = ownerOf(sqlName);
          if (!owner || owner.id === mod.id) continue;
          // Helper-only tables (audit_event/outbox/idempotency) have a sanctioned helper home:
          // the M4 audit() helper + write-audit trigger *generator* live in packages/audit and
          // emit the raw `INSERT INTO audit_event` capture DDL by design (M04 §3.3). That is the
          // canonical capture path, not an ownership evasion — mirror the helper-path exemption
          // the Drizzle-ref (scan) and migration-write (check c) paths already grant.
          if (sqlName in HELPER_ONLY_TABLES && isHelperPath) continue;
          if (new RegExp(`(FROM|JOIN|INTO|UPDATE)\\s+${sqlName}\\b`, "i").test(src))
            out.push({ module: mod, file, table: sqlName, owner });
        }
      }
      // (b) withPlatformContext touching a PHI table with no org predicate (heuristic)
      if (/withPlatformContext\s*\(/.test(src) &&
          /\b(patient|clinical|encounter|observation)\w*\b/i.test(src) &&
          !/organization_id\s*=|app\.org_id/.test(src)) {
        out.push({ module: mod, file, table: "(PHI under withPlatformContext, no org predicate)", owner: undefined });
      }
      // (c) migration INSERT/UPDATE into a helper-only table outside helper paths
      if (!isHelperPath) {
        for (const t of Object.keys(HELPER_ONLY_TABLES))
          if (new RegExp(`(INSERT\\s+INTO|UPDATE)\\s+${t}\\b`, "i").test(src))
            out.push({ module: mod, file, table: t, owner: undefined });
      }
    }
  }
  return out;
}

const violations = [...scan(), ...scanEvasions()];
if (violations.length === 0) {
  console.log("✓ table ownership: no cross-module schema access, raw-SQL, or platform-bypass evasion");
  process.exit(0);
}

console.error(`✗ table ownership: ${violations.length} violation(s)\n`);
for (const v of violations) {
  const ownerLabel = v.owner ? `Module ${v.owner.id} (${v.owner.name})` : "a helper-only path";
  console.error(
    `  ${relative(REPO_ROOT, v.file)}\n` +
    `    Module ${v.module.id} (${v.module.name}) references table '${v.table}', owned by ${ownerLabel}.\n` +
    `    Fix: access it through the owner's exported repository/service, not its Drizzle schema.\n`
  );
}
process.exit(1);
