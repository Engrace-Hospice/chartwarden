/**
 * WardenX - audit denylist sync check (ARCH-020 / TASK-063)
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
 * TWO KINDS OF ENTRY THIS GATE DELIBERATELY DOES NOT ENFORCE, both by design, not oversight:
 *
 *   1. NESTED JSONB-PATH ENTRIES (any string containing `->`, e.g. `data->>infusionDilution`,
 *      `payload->>narrative`). `audit_scrub(jsonb, text[])` only redacts whole TOP-LEVEL keys — it has
 *      no mechanism to strip a single nested path inside a jsonb column, so no migration trigger could
 *      ever satisfy one of these literally. Several tables' own schema comments explicitly say so (e.g.
 *      discipline_assessment: "a top-level column denylist would miss them"). Building nested-path-aware
 *      redaction is a real, separate engineering task — this gate does not silently ignore these
 *      entries, it prints them every run so they stay visible, but it cannot fail a check the mechanism
 *      structurally cannot pass.
 *
 *   2. KNOWN_UNRESOLVED_DISAGREEMENTS below — a small, explicit, reviewed allowlist of PLAIN-column
 *      cases where the constant and the migration disagree and this gate is NOT the place to pick a
 *      winner. Each one was investigated during TASK-063: in every case at least one authoritative
 *      source (the module's own ratified spec, or the migration's own cross-checked header comment)
 *      agrees with the CURRENT migration behavior, not the constant — but the constant's claim also has
 *      a real, documented PHI/compliance rationale behind it. Silently "fixing" either side would either
 *      erase a legitimate compliance flag or force a redaction change with real audit-trail-visibility
 *      consequences, neither of which is a hygiene-gate's call to make unilaterally. See the task
 *      backlog entry for TASK-063 for the full writeup of each one.
 */
import { readFileSync } from "node:fs";
import { M6_AUDIT_DENYLIST } from "../packages/types/src/admission";
import { M7_AUDIT_DENYLIST } from "../packages/types/src/care-plan";
import { M8_AUDIT_DENYLIST } from "../packages/types/src/encounter";
import { M9_AUDIT_DENYLIST } from "../packages/types/src/assessment";
import { M10_AUDIT_DENYLIST } from "../packages/types/src/hope";
import { M11_AUDIT_DENYLIST } from "../packages/types/src/orders";
import { M12_AUDIT_DENYLIST } from "../packages/types/src/dosespot";
import { M13_AUDIT_DENYLIST } from "../packages/types/src/emar";
import { M14_AUDIT_DENYLIST } from "../packages/types/src/idg";
import { M15_AUDIT_DENYLIST } from "../packages/types/src/discipline-plans";
import { M16_AUDIT_DENYLIST } from "../packages/types/src/bereavement";
import { M17_AUDIT_DENYLIST } from "../packages/types/src/scheduling";
import { M18_AUDIT_DENYLIST } from "../packages/types/src/evv";
import { M19_AUDIT_DENYLIST } from "../packages/types/src/oncall";
import { M20_AUDIT_DENYLIST } from "../packages/types/src/safety";
import { M21_AUDIT_DENYLIST } from "../packages/types/src/supplies";
import { M22_AUDIT_DENYLIST } from "../packages/types/src/documents";
import { M28_AUDIT_DENYLIST } from "../packages/types/src/fhir";
import { M29_AUDIT_DENYLIST } from "../packages/types/src/external-interfaces";
import { M31_AUDIT_DENYLIST } from "../packages/types/src/portal";
import { M32_AUDIT_DENYLIST } from "../packages/types/src/ai-platform";

const MODULES: ReadonlyArray<{
  readonly mod: string;
  readonly denylist: Readonly<Record<string, readonly string[]>>;
  /** One or more migration files, in order. Later files' `CREATE OR REPLACE FUNCTION
   *  audit_phi_write_<table>()` wins over an earlier file's definition of the SAME function — the
   *  forward-fix-migration pattern (never edit an already-shipped migration; ship a new one that
   *  redefines the trigger). Most modules need only their original RLS/audit migration; a module
   *  gets a second entry here only when a later migration patches one of its triggers. */
  readonly migrations: readonly string[];
}> = [
  { mod: "M6", denylist: M6_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0027_admission_m6_rls_audit_triggers.sql"] },
  {
    mod: "M7",
    denylist: M7_AUDIT_DENYLIST,
    migrations: [
      "packages/db/migrations/0029_care_plan_m7_rls_audit_triggers.sql",
      // TASK-063 follow-up: redacts care_plan_version.state_snapshot (was the one KNOWN_UNRESOLVED_DISAGREEMENTS entry).
      "packages/db/migrations/0163_care_plan_version_state_snapshot_redaction.sql",
    ],
  },
  { mod: "M8", denylist: M8_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0031_encounters_m8_rls_audit_triggers.sql"] },
  { mod: "M9", denylist: M9_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0033_assessment_m9_rls_audit_triggers.sql"] },
  { mod: "M10", denylist: M10_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0035_hope_m10_rls_audit_triggers.sql"] },
  { mod: "M11", denylist: M11_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0037_orders_m11_rls_audit_triggers.sql"] },
  { mod: "M12", denylist: M12_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0039_dosespot_m12_rls_audit_triggers.sql"] },
  { mod: "M13", denylist: M13_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0041_emar_m13_rls_audit_triggers.sql"] },
  { mod: "M14", denylist: M14_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0043_idg_m14_rls_audit_triggers.sql"] },
  { mod: "M15", denylist: M15_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0099_discipline_plans_m15_rls_audit_triggers.sql"] },
  { mod: "M16", denylist: M16_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0102_bereavement_m16_rls_audit_triggers.sql"] },
  { mod: "M17", denylist: M17_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql"] },
  { mod: "M18", denylist: M18_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0047_evv_m18_rls_audit_triggers.sql"] },
  { mod: "M19", denylist: M19_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0108_oncall_m19_rls_audit_triggers.sql"] },
  { mod: "M20", denylist: M20_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0111_field_safety_m20_rls_audit_triggers.sql"] },
  { mod: "M21", denylist: M21_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0106_supplies_m21_rls_audit_triggers.sql"] },
  { mod: "M22", denylist: M22_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0049_documents_m22_rls_audit_triggers.sql"] },
  { mod: "M28", denylist: M28_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0137_fhir_gateway_m28_rls_audit_triggers.sql"] },
  {
    mod: "M29",
    denylist: M29_AUDIT_DENYLIST,
    migrations: [
      "packages/db/migrations/0148_external_interfaces_m29_rls_audit_triggers.sql",
      // TASK-063 follow-up: row-conditional SUD redaction on lab_observation_value.observation_value.
      "packages/db/migrations/0164_lab_observation_value_sud_redaction.sql",
    ],
  },
  { mod: "M31", denylist: M31_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0139_portal_m31_rls_audit_triggers.sql"] },
  { mod: "M32", denylist: M32_AUDIT_DENYLIST, migrations: ["packages/db/migrations/0116_ai_platform_m32_rls_audit_triggers.sql"] },
];

/** [module, table] pairs this gate deliberately does not enforce — see the file header. Each entry here
 *  MUST be paired with a writeup in the TASK-063 backlog entry; this is a reviewed exception list, not a
 *  place to quietly park a new drift.
 *
 *  `M7.care_plan_version` RESOLVED (post-TASK-066 follow-up): migration 0163 now redacts
 *  `state_snapshot` too — the constant, migration, and this gate agree, so it's a normal checked
 *  table now, not an exemption. */
const KNOWN_UNRESOLVED_DISAGREEMENTS = new Set<string>([
  // Constant claims `payload_schema`; the migration uses M1's generic platform-baseline trigger (this
  // table is platform-shared, not org-scoped, and has no per-table redaction mechanism at all). Also
  // genuinely unclear whether a form's serialized TypeBox render schema is PHI at all (it describes
  // FIELD STRUCTURE, not patient data) — needs a decision, not a default.
  "M22.form_template_version",
]);

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
 *  overrides an earlier file's (the forward-fix-migration pattern — see the `MODULES` comment). */
function parseMigrations(paths: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const path of paths) {
    const src = readFileSync(path, "utf8");
    const funcRe =
      /CREATE OR REPLACE FUNCTION audit_phi_write_\w+\(\)[\s\S]*?(?=CREATE OR REPLACE FUNCTION audit_phi_write_\w+\(\)|$)/g;
    for (const block of src.match(funcRe) ?? []) {
      const tableMatch = block.match(/CREATE (?:OR REPLACE )?TRIGGER\s+"[^"]+"\s+AFTER[^\n]*ON\s+(\w+)/);
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

const violations: string[] = [];
let tablesChecked = 0;
let nestedPathEntries = 0;

for (const { mod, denylist, migrations } of MODULES) {
  const migCols = parseMigrations(migrations);
  const migrationLabel = migrations.join(", ");
  for (const [table, cols] of Object.entries(denylist)) {
    const plain = cols.filter((c) => !c.includes("->"));
    const nested = cols.filter((c) => c.includes("->"));
    nestedPathEntries += nested.length;
    if (nested.length > 0) {
      console.log(`  [nested-path, not enforced] ${mod}.${table}: ${JSON.stringify(nested)}`);
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
    `OK audit-denylist-sync: ${tablesChecked} table(s) across ${MODULES.length} module(s) match verbatim (${nestedPathEntries} nested-path entries not enforced, ${KNOWN_UNRESOLVED_DISAGREEMENTS.size} known unresolved disagreements, ${CONDITIONAL_REDACTIONS.length} row-conditional redaction(s) verified — see above)`,
  );
  process.exit(0);
}

console.error(`FAIL audit-denylist-sync: ${violations.length} violation(s)`);
for (const v of violations) console.error(`  - ${v}`);
process.exit(1);
