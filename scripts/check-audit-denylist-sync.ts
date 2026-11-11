/**
 * ChartWarden - audit denylist sync check (ARCH-020 / TASK-063)
 * -----------------------------------------------------------
 * Every `M*_AUDIT_DENYLIST` constant in packages/types/src claims to be the source its module's
 * migration-authored `audit_phi_write_<table>()` trigger scrubs FROM — "Captured here as data so
 * M<N>-T0<x>'s `generateAuditTrigger(...)` denylist arguments derive from a single source" (per-file
 * comment). No pipeline ever actually generates a migration from these constants (every trigger is
 * hand-authored SQL), and until this gate nothing checked the two stayed in sync, so all 21 constants
 * had zero enforcement — some drifted (a phantom column name that never existed on the table; a real
 * column the migration protects that the constant never learned about).
 *
 * This gate makes the constant an enforced claim about what a table's migration trigger ACTUALLY
 * scrubs: for every table, the (non-nested) columns named in its `M*_AUDIT_DENYLIST` entry must appear,
 * verbatim, in that table's `audit_phi_write_<table>()` trigger's `audit_scrub(...)` column array —
 * exactly (not a subset in either direction). Adding a column to a constant without updating the
 * trigger (or vice versa) now fails CI, satisfying ARCH-020's acceptance criteria.
 *
 * NESTED JSONB-PATH ENTRIES (any string containing `->`, e.g. `data->>infusionDilution`,
 * `payload->>narrative`) — WX-PR-016 finding: `audit_scrub(jsonb, text[])` only redacts whole
 * TOP-LEVEL keys of whatever jsonb object it's given, but every table that declares a nested-path
 * denylist entry ALREADY redacts it correctly, by calling `audit_scrub()` a SECOND time on the
 * extracted nested object and writing the result back with `jsonb_set` — e.g.
 * `jsonb_set(v_before, '{data}', audit_scrub(v_before->'data', v_data_keys))`. The mechanism was never
 * missing; this gate just didn't verify it, so a real regression (someone deleting the `jsonb_set` call,
 * or dropping a key from the nested array) would have passed silently. `verifyNestedPaths()` below
 * checks the migration's function-block TEXT for that pattern per declared nested path, mirroring the
 * `CONDITIONAL_REDACTIONS` marker-string approach — it is not a full SQL parser, but it fails loudly if
 * the extract/scrub/write-back shape disappears.
 *
 * KNOWN_UNRESOLVED_DISAGREEMENTS below is a small, explicit, reviewed allowlist of PLAIN-column cases
 * where the constant and the migration disagree and this gate is NOT the place to pick a winner. Each
 * one was investigated during TASK-063: in every case at least one authoritative source (the module's
 * own ratified spec, or the migration's own cross-checked header comment) agrees with the CURRENT
 * migration behavior, not the constant — but the constant's claim also has a real, documented
 * PHI/compliance rationale behind it. Silently "fixing" either side would either erase a legitimate
 * compliance flag or force a redaction change with real audit-trail-visibility consequences, neither of
 * which is a hygiene-gate's call to make unilaterally. See the task backlog entry for TASK-063 for the
 * full writeup of each one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { M6_AUDIT_DENYLIST } from "../packages/types/src/admission";
import { M32_AUDIT_DENYLIST } from "../packages/types/src/ai-platform";
import { M9_AUDIT_DENYLIST } from "../packages/types/src/assessment";
import { M16_AUDIT_DENYLIST } from "../packages/types/src/bereavement";
import { M7_AUDIT_DENYLIST } from "../packages/types/src/care-plan";
import { M15_AUDIT_DENYLIST } from "../packages/types/src/discipline-plans";
import { M22_AUDIT_DENYLIST } from "../packages/types/src/documents";
import { M12_AUDIT_DENYLIST } from "../packages/types/src/dosespot";
import { M13_AUDIT_DENYLIST } from "../packages/types/src/emar";
import { M8_AUDIT_DENYLIST } from "../packages/types/src/encounter";
import { M18_AUDIT_DENYLIST } from "../packages/types/src/evv";
import { M29_AUDIT_DENYLIST } from "../packages/types/src/external-interfaces";
import { M28_AUDIT_DENYLIST } from "../packages/types/src/fhir";
import { M10_AUDIT_DENYLIST } from "../packages/types/src/hope";
import { M14_AUDIT_DENYLIST } from "../packages/types/src/idg";
import { M19_AUDIT_DENYLIST } from "../packages/types/src/oncall";
import { M11_AUDIT_DENYLIST } from "../packages/types/src/orders";
import { M31_AUDIT_DENYLIST } from "../packages/types/src/portal";
import { M20_AUDIT_DENYLIST } from "../packages/types/src/safety";
import { M17_AUDIT_DENYLIST } from "../packages/types/src/scheduling";
import { M21_AUDIT_DENYLIST } from "../packages/types/src/supplies";
import { MIGRATIONS_DIR, listMigrations } from "./lib/gate-scan";

const MODULES: ReadonlyArray<{
  readonly mod: string;
  readonly denylist: Readonly<Record<string, readonly string[]>>;
}> = [
  {
    mod: "M6",
    denylist: M6_AUDIT_DENYLIST,
  },
  {
    mod: "M7",
    denylist: M7_AUDIT_DENYLIST,
  },
  {
    mod: "M8",
    denylist: M8_AUDIT_DENYLIST,
  },
  {
    mod: "M9",
    denylist: M9_AUDIT_DENYLIST,
  },
  {
    mod: "M10",
    denylist: M10_AUDIT_DENYLIST,
  },
  {
    mod: "M11",
    denylist: M11_AUDIT_DENYLIST,
  },
  {
    mod: "M12",
    denylist: M12_AUDIT_DENYLIST,
  },
  {
    mod: "M13",
    denylist: M13_AUDIT_DENYLIST,
  },
  {
    mod: "M14",
    denylist: M14_AUDIT_DENYLIST,
  },
  {
    mod: "M15",
    denylist: M15_AUDIT_DENYLIST,
  },
  {
    mod: "M16",
    denylist: M16_AUDIT_DENYLIST,
  },
  {
    mod: "M17",
    denylist: M17_AUDIT_DENYLIST,
  },
  {
    mod: "M18",
    denylist: M18_AUDIT_DENYLIST,
  },
  {
    mod: "M19",
    denylist: M19_AUDIT_DENYLIST,
  },
  {
    mod: "M20",
    denylist: M20_AUDIT_DENYLIST,
  },
  {
    mod: "M21",
    denylist: M21_AUDIT_DENYLIST,
  },
  {
    mod: "M22",
    denylist: M22_AUDIT_DENYLIST,
  },
  {
    mod: "M28",
    denylist: M28_AUDIT_DENYLIST,
  },
  {
    mod: "M29",
    denylist: M29_AUDIT_DENYLIST,
  },
  {
    mod: "M31",
    denylist: M31_AUDIT_DENYLIST,
  },
  {
    mod: "M32",
    denylist: M32_AUDIT_DENYLIST,
  },
];

/** [module, table] pairs this gate deliberately does not enforce — see the file header. Each entry here
 *  MUST be paired with a writeup in the TASK-063 backlog entry; this is a reviewed exception list, not a
 *  place to quietly park a new drift.
 *
 *  `M7.care_plan_version` RESOLVED (post-TASK-066 follow-up): migration 0163 now redacts
 *  `state_snapshot` too — the constant, migration, and this gate agree, so it's a normal checked
 *  table now, not an exemption.
 *
 *  `M22.form_template_version` RESOLVED (WX-PR-016): the constant was the side that disagreed with
 *  reality — `payload_schema` is a serialized TypeBox render CONTRACT (field structure), not patient
 *  data, per the table's own schema-file comment ("structural, not PHI"). Removed from
 *  `M22_AUDIT_DENYLIST`; the platform-shared `chartwarden_audit_trigger()` this table uses correctly has no
 *  redaction at all, which is now what the constant claims too. Normal checked table now, not an
 *  exemption. */
const KNOWN_UNRESOLVED_DISAGREEMENTS = new Set<string>([]);

/**
 * Row-conditional redactions (AUDIT_DENYLIST_CATALOG, packages/audit/src/triggers/catalog.ts) —
 * the flat plain-column comparison above can't express "redacted only when a SQL condition holds
 * on the row", so these are verified separately: the migration's trigger body must literally
 * contain the catalog's own marker strings (the `v_denylist` pattern `generateAuditTrigger()`'s
 * row-conditional path emits, plus the specific condition/column), so a future edit that silently
 * reverts to no-redaction-at-all (the ORIGINAL bug here — the pre-migration-0164 trigger never
 * called `audit_scrub()` at all) fails this gate instead of passing silently.
 */
const CONDITIONAL_REDACTIONS: ReadonlyArray<{
  readonly key: string;
  readonly migration: string;
  readonly mustContain: readonly string[];
}> = [
  {
    key: "M29.lab_observation_value",
    migration: "packages/db/migrations/0164_lab_observation_value_sud_redaction.sql",
    mustContain: [
      "v_denylist",
      "sud_redacted_at_ingest",
      "'numeric_value'",
      "'string_value'",
      "audit_scrub(to_jsonb(OLD), v_denylist)",
      "audit_scrub(to_jsonb(NEW), v_denylist)",
    ],
  },
];

/** Extract each `audit_phi_write_<fn>()` function block together with its own `CREATE TRIGGER ... ON
 *  <table>` clause. The function-name suffix can be a TRUNCATED table name (Postgres's 63-char
 *  identifier limit — e.g. `audit_phi_write_ckit_template_medication()` triggers on the real table
 *  `comfort_kit_template_medication`), so the trigger's `ON <table>` is the only reliable table name.
 *  `paths` are applied IN ORDER so a later file's `CREATE OR REPLACE FUNCTION` for the SAME table
 *  overrides an earlier file's (the forward-fix-migration pattern — see `triggerMigrationsFor`). */
function parseMigrations(paths: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const path of paths) {
    const src = readFileSync(path, "utf8");
    const funcRe =
      /CREATE OR REPLACE FUNCTION audit_phi_write_\w+\(\)[\s\S]*?(?=CREATE OR REPLACE FUNCTION audit_phi_write_\w+\(\)|$)/g;
    for (const block of src.match(funcRe) ?? []) {
      const tableMatch = block.match(
        /CREATE (?:OR REPLACE )?TRIGGER\s+"[^"]+"\s+AFTER[^\n]*ON\s+(\w+)/,
      );
      if (!tableMatch) continue;
      const table = tableMatch[1]!;
      const arrMatch = block.match(/audit_scrub\([^,]+,\s*ARRAY\[([^\]]*)\]/);
      const vColsMatch = block.match(/v_cols\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/);
      const raw = arrMatch?.[1] ?? vColsMatch?.[1] ?? "";
      const cols = raw
        .split(",")
        .map((s) => s.trim().replace(/^'|'$/g, ""))
        .filter(Boolean);
      out[table] = [...new Set(cols)];
    }
  }
  return out;
}

/** Split a nested-path denylist entry ("data->>infusionDilution" or "built_snapshot->discipline_views")
 *  into [topLevelColumn, nestedKey]. `->>` (text) and `->` (jsonb) extraction are treated identically —
 *  the established redaction pattern replaces the whole nested value with `"<changed>"` regardless of
 *  its original type, so the distinction doesn't matter for what this checks. */
function splitNestedPath(entry: string): [string, string] {
  const idx = entry.indexOf("->");
  const top = entry.slice(0, idx);
  const rest = entry.slice(idx + 2);
  const nested = rest.startsWith(">") ? rest.slice(1) : rest;
  return [top, nested];
}

/** Find the LAST (CREATE OR REPLACE wins) `audit_phi_write_<table>()` function block across the given
 *  migration files, keyed by its trigger's real table name — same block-extraction parseMigrations()
 *  uses, kept separate so a change to one doesn't risk the other. */
function findTableBlock(table: string, migrations: readonly string[]): string {
  let block = "";
  for (const path of migrations) {
    const src = readFileSync(path, "utf8");
    const funcRe =
      /CREATE OR REPLACE FUNCTION audit_phi_write_\w+\(\)[\s\S]*?(?=CREATE OR REPLACE FUNCTION audit_phi_write_\w+\(\)|$)/g;
    for (const b of src.match(funcRe) ?? []) {
      const tableMatch = b.match(
        /CREATE (?:OR REPLACE )?TRIGGER\s+"[^"]+"\s+AFTER[^\n]*ON\s+(\w+)/,
      );
      if (tableMatch?.[1] === table) block = b;
    }
  }
  return block;
}

/** WX-PR-016: verify a table's trigger actually redacts each declared nested path, by checking its
 *  function-block text for the established extract -> audit_scrub -> jsonb_set-back shape, e.g.
 *  `jsonb_set(v_before, '{data}', audit_scrub(v_before->'data', v_data_keys))` with `'infusionDilution'`
 *  somewhere in that nested-keys array. Not a SQL parser — a regression that deletes the jsonb_set call,
 *  or drops a key from the nested array, makes one of these four substring checks fail, which is the
 *  same fidelity CONDITIONAL_REDACTIONS already relies on for the row-conditional case. */
function verifyNestedPaths(
  table: string,
  nestedCols: readonly string[],
  migrations: readonly string[],
): string[] {
  const block = findTableBlock(table, migrations);
  const missing: string[] = [];
  for (const entry of nestedCols) {
    const [top, nested] = splitNestedPath(entry);
    const hasExtract = block.includes(`->'${top}'`);
    const hasWriteback = block.includes(`'{${top}}'`) && block.includes("jsonb_set(");
    const hasScrubCall = block.includes("audit_scrub(");
    const hasNestedKey = block.includes(`'${nested}'`);
    if (!(hasExtract && hasWriteback && hasScrubCall && hasNestedKey)) missing.push(entry);
  }
  return missing;
}

/** Each migration's `audit_phi_write_*()` trigger tables, in apply order. */
const TRIGGER_TABLES_BY_MIGRATION = listMigrations().map((file) => {
  const path = join(MIGRATIONS_DIR, file);
  return { path, tables: Object.keys(parseMigrations([path])) };
});

/** Every migration that defines an audit trigger on one of `tables`, in apply order — so a later
 *  file's `CREATE OR REPLACE FUNCTION audit_phi_write_<table>()` wins over an earlier one for the SAME
 *  table (the forward-fix-migration pattern: never edit a shipped migration, ship one that redefines
 *  the trigger). */
function triggerMigrationsFor(tables: readonly string[]): string[] {
  return TRIGGER_TABLES_BY_MIGRATION.filter((m) => m.tables.some((t) => tables.includes(t))).map(
    (m) => m.path,
  );
}

const violations: string[] = [];
let tablesChecked = 0;
let nestedPathEntriesVerified = 0;

for (const { mod, denylist } of MODULES) {
  const migrations = triggerMigrationsFor(Object.keys(denylist));
  const migCols = parseMigrations(migrations);
  const migrationLabel = migrations.join(", ");
  for (const [table, cols] of Object.entries(denylist)) {
    const plain = cols.filter((c) => !c.includes("->"));
    const nested = cols.filter((c) => c.includes("->"));
    if (nested.length > 0) {
      const missingNested = verifyNestedPaths(table, nested, migrations);
      if (missingNested.length > 0) {
        violations.push(
          `${mod}.${table}: nested path(s) ${JSON.stringify(missingNested)} declared in the TS constant, but the migration trigger (${migrationLabel}) doesn't visibly redact them (the extract -> audit_scrub -> jsonb_set-back pattern wasn't found) — add the redaction, or fix the constant`,
        );
      } else {
        nestedPathEntriesVerified += nested.length;
        console.log(`  [nested-path, verified] ${mod}.${table}: ${JSON.stringify(nested)}`);
      }
    }
    if (KNOWN_UNRESOLVED_DISAGREEMENTS.has(`${mod}.${table}`)) {
      console.log(`  [known unresolved disagreement, see TASK-063] ${mod}.${table}`);
      continue;
    }
    tablesChecked += 1;
    const migSet = new Set(migCols[table] ?? []);
    const constSet = new Set(plain);
    const missingFromMigration = plain.filter((c) => !migSet.has(c));
    const missingFromConstant = [...migSet].filter((c) => !constSet.has(c));
    if (missingFromMigration.length > 0) {
      violations.push(
        `${mod}.${table}: ${JSON.stringify(missingFromMigration)} is denylisted in the TS constant but NOT scrubbed by the migration trigger (${migrationLabel}) — add it to the audit_scrub(...) column array, or if it's wrong, fix the constant`,
      );
    }
    if (missingFromConstant.length > 0) {
      violations.push(
        `${mod}.${table}: ${JSON.stringify(missingFromConstant)} is scrubbed by the migration trigger (${migrationLabel}) but missing from the TS constant — update M${mod.slice(1)}_AUDIT_DENYLIST to match`,
      );
    }
  }
}

for (const { key, migration, mustContain } of CONDITIONAL_REDACTIONS) {
  const src = readFileSync(migration, "utf8");
  const missing = mustContain.filter((marker) => !src.includes(marker));
  if (missing.length > 0) {
    violations.push(
      `${key}: row-conditional redaction marker(s) ${JSON.stringify(missing)} not found in ${migration} — the row-conditional AUDIT_DENYLIST_CATALOG protection for this table may have been reverted or edited`,
    );
  } else {
    console.log(`  [row-conditional, verified] ${key}`);
  }
}

if (violations.length === 0) {
  console.log(
    `OK audit-denylist-sync: ${tablesChecked} table(s) across ${MODULES.length} module(s) match verbatim (${nestedPathEntriesVerified} nested-path entries verified, ${KNOWN_UNRESOLVED_DISAGREEMENTS.size} known unresolved disagreements, ${CONDITIONAL_REDACTIONS.length} row-conditional redaction(s) verified — see above)`,
  );
  process.exit(0);
}

console.error(`FAIL audit-denylist-sync: ${violations.length} violation(s)`);
for (const v of violations) console.error(`  - ${v}`);
process.exit(1);
