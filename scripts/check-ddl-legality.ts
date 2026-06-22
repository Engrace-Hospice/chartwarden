/**
 * WardenX — PostgreSQL DDL Legality Check  (ADR-0022; fitness check #12)
 * ------------------------------------------------------------------
 * Catches DDL that "Locked" specs ship which CANNOT be created in PostgreSQL —
 * the build would fail at migration time, not review time (audit X9 / BB#5):
 *
 *   1. PARTITION-KEY IN UNIQUE INDEX — a partitioned table's UNIQUE/PRIMARY KEY
 *      must include the partition column. `UNIQUE(natural_key)` on a table
 *      partitioned by organization_id/time is illegal.
 *   2. NO SUBQUERY IN CHECK — PostgreSQL forbids `SELECT` inside a CHECK constraint.
 *   3. NO DUPLICATE ENUM TYPE — `CREATE TYPE x AS ENUM`/`pgEnum('x', …)` may be
 *      defined only once; a second definition of the same name fails the migration.
 *
 * Heuristic, import-level static check (same posture as check-table-ownership.ts /
 * check-tenancy.ts) — it catches the common, dangerous cases and routes the rest to
 * review. Activates per file as the schema/migration source lands.
 *
 * Run:   bun run scripts/check-ddl-legality.ts
 * CI:    exits 1 on any violation (arch:fitness stage).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MODULES } from "../architecture/module-manifest";

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ["packages/db", ...MODULES.flatMap((m) => m.codePaths)];

type Violation = { file: string; rule: string; detail: string };

function listFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(join(REPO_ROOT, dir));
  } catch {
    return acc;
  }
  for (const e of entries) {
    const rel = join(dir, e);
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) {
      if (e === "node_modules" || e === "dist" || e === ".turbo") continue;
      listFiles(rel, acc);
    } else if (/\.(ts|sql)$/.test(e)) acc.push(rel);
  }
  return acc;
}

const violations: Violation[] = [];
// Track SQL `CREATE TYPE` and Drizzle `pgEnum` definitions SEPARATELY: the normal Drizzle pattern is
// one pgEnum (schema) + one generated CREATE TYPE (migration) for the same name — that is NOT a
// duplicate. A genuine duplicate is two CREATE TYPE, or two pgEnum, for the same name.
const sqlEnumDefs = new Map<string, string>();
const tsEnumDefs = new Map<string, string>();
const seen = new Set<string>();

for (const base of SCAN_DIRS) {
  for (const file of listFiles(base)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(join(REPO_ROOT, file), "utf8");

    // ---- Rule 2: subquery inside a CHECK constraint ----
    // CHECK ( ... SELECT ... ) — match CHECK(...) blocks containing a SELECT.
    const checkRe = /\bCHECK\s*\(([^;]*?)\)/gis;
    let cm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((cm = checkRe.exec(src))) {
      if (/\bSELECT\b/i.test(cm[1]!)) {
        violations.push({
          file,
          rule: "check-subquery",
          detail:
            "a CHECK constraint contains a SELECT — illegal in PostgreSQL (ADR-0022 D1.2); move to a BEFORE trigger / partial unique index",
        });
      }
    }

    // ---- Rule 3: duplicate enum type definitions (same KIND only) ----
    const flagEnum = (name: string, map: Map<string, string>, kind: string) => {
      const prev = map.get(name);
      if (prev) {
        violations.push({
          file,
          rule: "duplicate-enum",
          detail: `${kind} enum type '${name}' already defined in ${relative(REPO_ROOT, prev)} — a second definition of the same kind fails the migration (ADR-0022 D1.3)`,
        });
      } else {
        map.set(name, file);
      }
    };
    let sm: RegExpExecArray | null;
    const sqlEnumRe = /CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM/gi;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((sm = sqlEnumRe.exec(src))) flagEnum(sm[1]!, sqlEnumDefs, "SQL");
    let tm: RegExpExecArray | null;
    const tsEnumRe = /pgEnum\(\s*['"]([\w]+)['"]/gi;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((tm = tsEnumRe.exec(src))) flagEnum(tm[1]!, tsEnumDefs, "Drizzle");

    // ---- Rule 1: partition key absent from a unique index (heuristic) ----
    // Drizzle: a table declaring `.partitionedBy*('<col>'...)` or a // partitioned-by comment,
    // whose uniqueIndex(...) does not reference the partition column.
    const partCol =
      /partitionedBy\w*\(\s*['"](\w+)['"]/i.exec(src)?.[1] ??
      /PARTITION\s+BY\s+\w+\s*\(\s*(\w+)/i.exec(src)?.[1];
    if (partCol) {
      const uniqRe =
        /uniqueIndex\([^)]*\)\.on\(([^)]*)\)|UNIQUE\s*\(([^)]*)\)|PRIMARY\s+KEY\s*\(([^)]*)\)/gi;
      let um: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
      while ((um = uniqRe.exec(src))) {
        const cols = um[1] ?? um[2] ?? um[3] ?? "";
        if (!new RegExp(`\\b${partCol}\\b`).test(cols)) {
          violations.push({
            file,
            rule: "partition-key-not-in-unique",
            detail: `table partitioned by '${partCol}' has a UNIQUE/PK index not including it (\`${cols.trim().slice(0, 60)}\`) — illegal in PostgreSQL (ADR-0022 D1.1)`,
          });
        }
      }
    }
  }
}

if (violations.length === 0) {
  console.log(
    "✓ ddl-legality: no CHECK subqueries, duplicate enums, or partition-key/unique conflicts",
  );
  process.exit(0);
}
console.error(`✗ ddl-legality: ${violations.length} violation(s)\n`);
for (const v of violations)
  console.error(`  [${v.rule}] ${relative(REPO_ROOT, v.file)}\n    ${v.detail}\n`);
process.exit(1);
