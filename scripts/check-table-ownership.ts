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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  HELPER_ONLY_TABLES,
  MODULES,
  MODULE_BY_ID,
  type ModuleDef,
} from "../architecture/module-manifest";

const REPO_ROOT = process.cwd();
const SCHEMA_DIR = "packages/db/src/schema";

/**
 * TASK-014/ARCH-017 — sql table names a cross-module DIRECT `schema.<table>` read is sanctioned for,
 * reviewed individually below. Recognizing the `schema.<table>` member-access import style (the
 * `import { schema } from "@chartwarden/db"` convention ~280 files use) made every one of these visible
 * to this gate for the first time; none is a NEW decision made here — each was already the
 * deliberate, load-bearing pattern in its own file. Content-keyed, like check-tenancy.ts's
 * `NON_ORG_SCOPED` — a table joins this set only with a reviewed justification, not to silence a
 * finding.
 */
const CROSS_MODULE_SCHEMA_READ_EXEMPT = new Set<string>([
  // M1 Foundation's "who is this actor" identity facts (organization/membership/user/session/
  // account/verification). Every module's own ABAC resolver (`abac-resolver-drizzle.ts` /
  // `abac-predicates.ts` / `*-route-service-db.ts`) independently derives caseload/role/discipline
  // facts from these — the SAME join `ActorEnrichmentReader`/`createDbActorEnrichmentReader`
  // (packages/auth/src/rbac/drizzle-store.ts) already performs, repeated per-module because no
  // single shared reader seam covers every module's differently-shaped ABAC query yet (unlike
  // M17's `VisitReader`, which M18 now consumes instead of reading `visit` directly — see below).
  // Retrofitting all ~20 of these onto one shared seam is a real but separately-scoped refactor;
  // until then a direct read of these SPECIFIC, narrow, non-PHI identity tables is the sanctioned
  // pattern platform-wide, not a per-module escape hatch.
  "organization",
  "membership",
  "user",
  "session",
  "account",
  "verification",
  // M3 Authorization's role-key facts — the identical "what roles does this membership hold" join
  // every module's own ABAC layer performs (same reasoning as the M1 cohort above; M30's
  // `abac-predicates.ts` is today's consumer).
  "role",
  "membership_role",
  // M7 Care Plan's `intervention` — M11 (Orders), as the PRODUCER of the order fact `intervention`
  // soft-references (`linked_order_id`), owns this cross-module join on the READ side by design
  // (the M13↔M9 D6 "producer owns the join" precedent) — the alternative is M7 importing M11's
  // schema, which architecture §11 blocks outright. See the inline comment at
  // `apps/backend/src/modules/11-orders/seams/drizzle-store.ts` (`const CPI = schema.interventions`).
  "intervention",
  // M5 Patient's `patient` + M4 Audit's `legal_hold` — the universal erase-precondition reads every
  // module's `erasers/*.ts` performs: "is this patient deceased long enough to open the destruction
  // window" (M39's fail-closed deceased-proof read) and "is this resource under an active legal
  // hold" before any eraser may proceed. Cross-cutting by nature — every eraser needs both facts —
  // and, like `intervention` above, a pre-existing documented pattern this gate simply could not
  // see until the `schema.<table>` detection style landed.
  "patient",
  "legal_hold",
  // M17 Scheduling's `visit` — M18 (EVV) reads it not for its own sake but to CORRELATE within the
  // SAME transaction as its own `evv_event`/`evv_resolution` tables (an existence anchor at
  // `bracketForVisit`, and a windowed id-set at `complianceCountsForWindow` that a second batched
  // `inArray` read joins against — see `apps/backend/src/modules/18-evv/seams/drizzle-store.ts`).
  // M17 DOES publish a `VisitReader` seam M18 is the documented consumer of, but its three methods
  // (`visitForEncounter` / `visitsScheduledForMembershipOnDate` / `completedVisitsForPatientSince`)
  // answer different questions than M18 asks and, being an OUT-OF-TRANSACTION seam call, cannot
  // preserve the single-transaction read M18's compliance windows depend on — the exact "stale
  // pre-commit read" failure mode M18's own write-lifecycle design deliberately avoids (read the
  // view WITHIN `tx`, never after). Routing this through the seam would trade a visible, reviewed
  // direct read for a subtler transaction-consistency regression; the direct read is correct.
  "visit",
]);

// table const name <-> table sql name. We derive the sql name from the pgTable
// first-arg string in each schema file, and map back to the exported const.
// Shape we look for:  export const memberships = pgTable('membership', { ... })
type TableRef = { constName: string; sqlName: string; file: string };

function listFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(join(REPO_ROOT, dir));
  } catch {
    return acc;
  }
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
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
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

      // The `import { schema } from "@chartwarden/db"` (or `import * as schema from "..."`) namespace
      // binding — keyed to the LOCAL identifier `schema`, not the import specifier's spelling. The
      // old `used` check below required the specifier string itself to contain "schema"
      // (`from '.../schema/...'`), which a bare `from "@chartwarden/db"` never does — so every
      // `schema.<table>` member-access read (the dominant style repo-wide: M18's `schema.visit`,
      // M30's `schema.roles`/`schema.membershipRoles`, ~30+ ABAC-resolver files reading M1's
      // `schema.memberships`/`schema.organizations`/`schema.users`) was invisible to this gate.
      const schemaBindingImported =
        /import\s+(?:\{[^}]*\bschema\b[^}]*\}|\*\s+as\s+schema)\s+from\s+['"][^'"]+['"]/.test(src);

      for (const ref of registry) {
        // Named-import style: `import { visit } from '.../schema/...'`.
        const namedImportUsed =
          new RegExp(`\\b${ref.constName}\\b`).test(src) && /from ['"].*schema/.test(src);
        // Namespace-binding style: `schema.<table>` member access, regardless of the import
        // specifier's own spelling (see comment above).
        const namespaceUsed =
          schemaBindingImported && new RegExp(`\\bschema\\.${ref.constName}\\b`).test(src);
        const used = namedImportUsed || namespaceUsed;
        if (!used) continue;

        const owner = ownerOf(ref.sqlName);

        // helper-only tables: only the helper package (or the OWNING module's own dispatcher/
        // middleware — apps/backend/src/bootstrap is Module 1's own codePath, and the outbox
        // dispatcher / idempotency store living there ARE "packages/shared (outbox dispatcher …)"
        // the manifest comment describes, just organized under bootstrap rather than the package)
        // may reference them.
        if (ref.sqlName in HELPER_ONLY_TABLES) {
          const helperOk =
            file.startsWith("packages/audit") ||
            file.startsWith("packages/shared") ||
            file.startsWith("packages/db") ||
            (owner !== undefined && owner.id === mod.id);
          if (!helperOk) violations.push({ module: mod, file, table: ref.sqlName, owner });
          continue;
        }

        // owned by this module -> fine
        if (owner && owner.id === mod.id) continue;
        // owned table is unknown (unspecced) -> can't judge yet; skip conservatively
        if (!owner) continue;
        // A small, reviewed set of cross-module DIRECT schema reads that are the sanctioned
        // pattern rather than an evasion — see CROSS_MODULE_SCHEMA_READ_EXEMPT for the per-table
        // justification. Recognizing `schema.<table>` member access (ARCH-017) made every one of
        // these visible for the first time; each was already a deliberate, documented design
        // choice in its own file BEFORE this gate could see it, not a new decision made here.
        if (CROSS_MODULE_SCHEMA_READ_EXEMPT.has(ref.sqlName)) continue;
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
      // Live RLS isolation harnesses (packages/db/migrations/__tests__/*.live.test.ts) apply the
      // FULL migration set and intentionally seed/query EVERY module's tables as superuser to prove
      // cross-tenant RLS denial — that is their entire purpose. They are test infrastructure, not a
      // module reaching into another's tables in production, so cross-module raw-SQL references here
      // are by design, not an ownership evasion. (The original rls-isolation + m34 harnesses only
      // escaped this scan by luck — neither happened to contain a literal that trips `inRawSql`.)
      if (/migrations\/__tests__\/.*\.live\.test\.ts$/.test(file)) continue;
      // packages/audit/__tests__/*.test.ts asserting on generateAuditTrigger()'s OUTPUT (TASK-063
      // follow-up): the row-conditional AUDIT_DENYLIST_CATALOG entry (packages/audit/src/triggers/
      // catalog.ts) names a real example table — lab_observation, M29-owned — as its
      // conditionalCheck's FROM clause, since the whole point of the generator is to emit DDL that
      // OTHER modules' migrations call to reference THEIR OWN tables. A test proving the generator's
      // SHAPE for that one real catalog entry necessarily contains that table name in an asserted
      // string, same as the live-RLS-harness exemption above: this is test infrastructure exercising
      // a shared code-generation utility, not a module reaching into another's tables at runtime.
      if (/^packages\/audit\/__tests__\/.*\.test\.ts$/.test(file)) continue;
      const src = readFileSync(join(REPO_ROOT, file), "utf8");
      const isHelperPath = HELPER_PATHS.some((p) => file.startsWith(p));

      // (a) raw SQL / PL/pgSQL naming another module's owned table by sql name
      const inRawSql =
        /sql`|db\.execute\(|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|LANGUAGE\s+plpgsql/i.test(src);
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
      if (
        /withPlatformContext\s*\(/.test(src) &&
        /\b(patient|clinical|encounter|observation)\w*\b/i.test(src) &&
        !/organization_id\s*=|app\.org_id/.test(src)
      ) {
        out.push({
          module: mod,
          file,
          table: "(PHI under withPlatformContext, no org predicate)",
          owner: undefined,
        });
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
  console.log(
    "✓ table ownership: no cross-module schema access, raw-SQL, or platform-bypass evasion",
  );
  process.exit(0);
}

console.error(`✗ table ownership: ${violations.length} violation(s)\n`);
for (const v of violations) {
  const ownerLabel = v.owner ? `Module ${v.owner.id} (${v.owner.name})` : "a helper-only path";
  console.error(
    `  ${relative(REPO_ROOT, v.file)}\n    Module ${v.module.id} (${v.module.name}) references table '${v.table}', owned by ${ownerLabel}.\n    Fix: access it through the owner's exported repository/service, not its Drizzle schema.\n`,
  );
}
process.exit(1);
