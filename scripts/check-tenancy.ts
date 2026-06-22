/**
 * WardenX — Tenancy & RLS Invariant Check  (ADR-0010; fitness check #10)
 * ------------------------------------------------------------------
 * Enforces, statically, the three tenancy invariants that prose alone let drift
 * across the corpus (audit X3/X4/S5):
 *
 *   1. THREE-COLUMN RULE (ARCH-011) — every PHI-bearing table carries
 *      `organization_id` and (nullable only on org-level entities)
 *      `provider_entity_id` + `location_id`.
 *   2. CANONICAL RLS VARIABLE — the only session variable any policy or
 *      `current_setting(...)` may key on is `app.org_id` (set by withOrgContext()).
 *      Bans `app.organization_id`, `app.tenant_id`, `app.current_org_id`,
 *      `wardenx.org_id`, `app.current_organization_id`, etc.
 *   3. NO DANGEROUS POLICY SHAPES — bans `OR organization_id IS NULL` in a
 *      tenant-writable policy and permissive `FOR ALL` policies that OR together.
 *
 * This is a fast, heuristic, import-level static check (same posture as
 * check-table-ownership.ts) — it catches the common dangerous cases and routes
 * the rest to review. It activates per file as the implementation lands; until a
 * module's schema/migration source exists, there is nothing to scan for it.
 *
 * Run:   bun run scripts/check-tenancy.ts
 * CI:    exits 1 on any violation (arch:fitness stage).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MODULES, type ModuleDef } from "../architecture/module-manifest";

const REPO_ROOT = process.cwd();
const SCHEMA_DIR = "packages/db/src/schema";

const CANONICAL_VAR = "app.org_id";
// Any current_setting('app.*'|'wardenx.*') that is NOT the canonical var is a violation.
const SESSION_VAR_RE = /current_setting\(\s*['"]((?:app|wardenx)\.[a-z_]+)['"]/g;
// Audit *attribution* context vars (M04 §3.3): the write-audit trigger reads request context to
// stamp WHO/WHICH-correlation/provider/location into the immutable audit_event row. These are NOT
// RLS predicates — ADR-0010 D2 governs row *visibility*, which still keys ONLY on app.org_id; these
// only populate audit columns. Permitted exclusively inside the audit-capture path (the audit()
// helper / write-audit trigger generator, recognized by `audit_phi_write` / `INSERT INTO audit_event`).
const AUDIT_CONTEXT_VARS = new Set<string>([
  "app.user_id",
  "app.correlation_id",
  "app.provider_entity_id",
  "app.location_id",
]);
// Tables that are NOT tenant-scoped by org_id (user-owned cross-org, or pure platform reference).
// A spec opts a table out by adding it here with a justification (reviewed change).
const NON_ORG_SCOPED = new Set<string>([
  "user",
  "account",
  "verification",
  "session", // user-owned, cross-org (M2 §3.x)
  "two_factor",
  "passkey", // user-owned credentials
  "audit_denylist_catalog",
  "audit_action_catalog", // platform reference, read-all
  "permission", // M3 §3.6: platform-global read-only catalog mirror, no org column
  "outbox_event_catalog",
  "organization_settings_registry",
  "state_retention_override", // platform reference (writes via platform role)
  "organization",
  "provider_entity",
  "location", // the tenancy spine itself
  "system_status",
  "feature_flag", // platform/global (own RLS, ADR-0010 D3 read policy)
  // M38 Terminology (§3.7): platform-shared canonical reference. Read-all `USING(true)`;
  // writes only via the `terminology_loader` role (no org column by design). The one
  // org-scoped M38 table, value_set_tenant_extension, is intentionally NOT listed here —
  // it carries organization_id and gets standard app.org_id RLS in M38-T03.
  "code_system",
  "code_system_version",
  "concept_icd10cm",
  "concept_snomed",
  "concept_loinc",
  "concept_rxnorm",
  "value_set",
  "value_set_member",
  "value_set_expansion",
  "deprecation_mapping",
  "concept_embedding",
  "terminology_update_log",
  // M36 Secure Messaging (§3.4–3.6, §3.11): five tables carry no organization_id BY DESIGN.
  // `presence` + `delivery_endpoint` are user-owned and cross-org (the human, not the tenant —
  // same posture as `session`). `message_attachment` + `notification_delivery` are pure children
  // of `message`/`alert` (ON DELETE cascade) and inherit tenancy via the parent FK; RLS is
  // applied through the parent-join in M36-T03. `alert_payload_catalog` is platform-floor
  // reference, read-all, populated at boot from the §3.12 Foundation Registry. The ten remaining
  // M36 tables carry organization_id and get standard app.org_id RLS in M36-T03.
  "presence",
  "delivery_endpoint",
  "message_attachment",
  "notification_delivery",
  "alert_payload_catalog",
  // M40 Master Data Management (§2.3, §3.3–3.5): seven tables carry no organization_id BY DESIGN.
  // The §2.3 canonical-vs-overlay dividing line makes canonical master data org-less — one row
  // per real-world entity, registry-sourced, the same answer for every tenant. `external_physician`
  // / `facility` / `payer` are the canonical entities; `entity_relationship` + `merge_request` are
  // the cross-cutting workflow tables that operate over them; `nppes_sync_log` +
  // `nppes_sync_coordination` are platform-operational NPPES sync state. The four remaining M40
  // tables (external_physician_tenant_overlay, mdm_provisional, mdm_baa_record, mdm_baa_required)
  // carry organization_id and get standard app.org_id RLS in M40-T03.
  "external_physician",
  "facility",
  "payer",
  "entity_relationship",
  "merge_request",
  "nppes_sync_log",
  "nppes_sync_coordination",
  // M39 Consent (§3.3, §3.5): consent_type_catalog is platform-shared reference (the ten v1
  // consent types + bereavement + custom slot) with NO organization_id BY DESIGN — dual-grant RLS
  // (M40 §3.6 pattern): PLATFORM-scope writes only, read-all within any tenant. Same posture as
  // M38's code_system. The other ten M39 tables carry organization_id and get standard app.org_id
  // RLS in M39-T03; the four patient-bearing ones (consent_record / delegated_access /
  // consent_eval_audit / consent_renewal_cycle) additionally carry the three-column rule.
  "consent_type_catalog",
]);
// PHI signal: a table referencing a patient is PHI-bearing and MUST be fully org-scoped.
const PHI_SIGNAL_RE =
  /\b(patient_id|patientId|mrn|deceased_date|clinical|encounter_id|observation)\b/i;

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

// ---- Rule 2 + 3: scan every module's code + schema + migrations -----------
const allPaths = [SCHEMA_DIR, ...MODULES.flatMap((m: ModuleDef) => m.codePaths)];
const scanned = new Set<string>();
for (const base of allPaths) {
  for (const file of listFiles(base)) {
    if (scanned.has(file)) continue;
    scanned.add(file);
    const src = readFileSync(join(REPO_ROOT, file), "utf8");

    // Rule 2 — canonical session variable
    const isAuditCapture = /audit_phi_write|INSERT\s+INTO\s+audit_event/i.test(src);
    let m: RegExpExecArray | null;
    SESSION_VAR_RE.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((m = SESSION_VAR_RE.exec(src))) {
      if (m[1] !== CANONICAL_VAR) {
        if (AUDIT_CONTEXT_VARS.has(m[1]!) && isAuditCapture) continue;
        violations.push({
          file,
          rule: "rls-session-variable",
          detail: `uses current_setting('${m[1]}') — the only allowed RLS variable is '${CANONICAL_VAR}' (ADR-0010 D2)`,
        });
      }
    }

    // Rule 3a — OR organization_id IS NULL in a writable policy
    if (
      /\bOR\s+\w*organization_id\s+IS\s+NULL\b/i.test(src) &&
      /\bWITH\s+CHECK\b|\bFOR\s+ALL\b/i.test(src)
    ) {
      violations.push({
        file,
        rule: "rls-or-is-null-write",
        detail:
          "a tenant-writable policy contains `OR organization_id IS NULL` — bans tenant writes to global rows (ADR-0010 D3)",
      });
    }
    // Rule 3b — two permissive FOR ALL policies on the same table (heuristic)
    const forAll = src.match(/CREATE\s+POLICY\s+\w+\s+ON\s+(\w+)\s+FOR\s+ALL/gi) || [];
    const byTable = new Map<string, number>();
    for (const p of forAll) {
      const t = /ON\s+(\w+)/i.exec(p)?.[1] ?? "";
      byTable.set(t, (byTable.get(t) ?? 0) + 1);
    }
    for (const [t, n] of byTable)
      if (n > 1)
        violations.push({
          file,
          rule: "rls-permissive-or",
          detail: `table '${t}' has ${n} permissive FOR ALL policies that OR together (ADR-0010 D3)`,
        });
  }
}

// ---- Rule 1: three-column rule on PHI-bearing schema tables ---------------
for (const file of listFiles(SCHEMA_DIR)) {
  const src = readFileSync(join(REPO_ROOT, file), "utf8");
  // crude pgTable block split
  const re = /export\s+const\s+\w+\s*=\s*pgTable\(\s*['"]([\w]+)['"]\s*,([\s\S]*?)\n\}\)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
  while ((m = re.exec(src))) {
    const sqlName = m[1]!;
    const body = m[2]!;
    if (NON_ORG_SCOPED.has(sqlName)) continue;
    const isPhi = PHI_SIGNAL_RE.test(body);
    const hasOrg = /\borganization_id\b/.test(body) || /organizationId\s*:/.test(body);
    if (!hasOrg) {
      violations.push({
        file,
        rule: "missing-organization_id",
        detail: `table '${sqlName}' has no organization_id column (ARCH-011 / ADR-0010 D1)${isPhi ? " — PHI-bearing" : ""}`,
      });
    }
    if (isPhi) {
      const hasPE = /provider_entity_id/.test(body) || /providerEntityId/.test(body);
      const hasLoc = /location_id/.test(body) || /locationId/.test(body);
      if (!hasPE || !hasLoc)
        violations.push({
          file,
          rule: "missing-pe-or-location",
          detail: `PHI table '${sqlName}' missing ${!hasPE ? "provider_entity_id" : ""}${!hasPE && !hasLoc ? " + " : ""}${!hasLoc ? "location_id" : ""} (ARCH-011, nullable only on org-level entities)`,
        });
    }
  }
}

if (violations.length === 0) {
  console.log("✓ tenancy: three-column rule, canonical app.org_id, no dangerous RLS shapes");
  process.exit(0);
}
console.error(`✗ tenancy: ${violations.length} violation(s)\n`);
for (const v of violations)
  console.error(`  [${v.rule}] ${relative(REPO_ROOT, v.file)}\n    ${v.detail}\n`);
process.exit(1);
