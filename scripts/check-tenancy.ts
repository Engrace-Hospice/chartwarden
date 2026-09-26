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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
// M34 §3.2/§3.5 (D5/D6): the two SECURITY DEFINER DEK-lifecycle functions take their app-supplied
// inputs (the KEK-wrapped DEK ciphertext, its KEK id, and the optional destroying membership) as
// session GUCs rather than SQL args, so the wrapped key material never appears in a query string or
// the statement log. Like AUDIT_CONTEXT_VARS these are NOT RLS predicates — row visibility still
// keys ONLY on app.org_id — so they are permitted exclusively inside the key-ring SECURITY DEFINER
// path (recognized by `m34_provision_tenant_key_ring` / `m34_destroy_tenant_key_ring`).
const KEY_RING_CONTEXT_VARS = new Set<string>([
  "app.dek_kek_wrapped_ciphertext_b64",
  "app.dek_kek_id",
  "app.destroyed_by_membership_id",
]);
// Applied migrations whose non-canonical RLS policies a LATER migration has dropped. Migrations are
// immutable once applied (scripts/db/migrate.ts checksums them), so a policy that violated D2 can only
// be retired forward. An entry exempts its file from the session-variable rule ONLY IF the named
// superseding migration exists and drops every listed policy — verified below, so a stale entry
// fails instead of silently hiding a live policy. Reviewed change, like NON_ORG_SCOPED.
const SUPERSEDED_RLS_MIGRATIONS: Record<string, { supersededBy: string; policies: string[] }> = {
  // M2 pre-org membership picker: user-keyed policies replaced by the m2_list_own_memberships
  // SECURITY DEFINER function.
  "packages/db/migrations/0213_pre_org_membership_picker_rls.sql": {
    supersededBy: "packages/db/migrations/0231_m2_membership_picker_definer.sql",
    policies: ["membership_self_pre_org_read", "organization_member_pre_org_read"],
  },
  "packages/db/migrations/0214_pre_org_membership_picker_empty_user.sql": {
    supersededBy: "packages/db/migrations/0231_m2_membership_picker_definer.sql",
    policies: ["membership_self_pre_org_read", "organization_member_pre_org_read"],
  },
};

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
  // M10 HOPE modernization Phase 1A: CMS HOPE Data Specification reference tables.
  // These carry no tenant data and are immutable platform reference rows shared by every org.
  // The tenant-scoped item answers live in hope_assessment_answer, which is intentionally NOT listed.
  "hope_spec_version",
  "hope_spec_item",
  "hope_spec_item_isc",
  "hope_spec_item_option",
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
  // M22 Document Management (§3.3 / §4.5): the form-template library is platform-published —
  // `form_template` + `form_template_version` carry NO organization_id BY DESIGN (the same template
  // definition for every tenant; per-tenant branding is layered via the org-scoped
  // `tenant_template_overlay`). Dual-grant RLS in 0049 (platform writes, read-all within any tenant —
  // M38 `code_system` / M40 canonical-entity precedent). The other fifteen M22 tables carry
  // organization_id; `document` + `intake_upload_batch` additionally carry the three-column rule.
  "form_template",
  "form_template_version",
  // M34 SaaS Tenant Platform (§3.10 M34-F02 / ADR-0010, CANONICAL): EVERY tenant-scoped M34 table
  // carries organization_id NOT NULL and gets standard app.org_id RLS — NONE of them are listed here.
  // Only THREE M34 tables are genuinely org-less: onboarding_task_template (platform-shared read-only
  // catalog, SD-036 pattern-2 — SELECT USING(true)); tenant_signup_intent / tenant_signup_token
  // (pre-organization signup funnel — wardenx_app cannot SELECT; tenant_platform_writer only).
  "onboarding_task_template",
  "tenant_signup_intent",
  "tenant_signup_token",
  // M33 Reporting & Dashboards (§3.3 / §3.5): the three PLATFORM-global catalogs carry NO
  // organization_id BY DESIGN (retention class `platform`; identical rows for every tenant) and get a
  // read-all RLS policy (SELECT USING(true), writes via report_writer) in 0058 — the M34
  // onboarding_task_template / M38 code_system precedent. The other nine M33 tables carry
  // organization_id (report_run's is nullable for cross-tenant platform-wide refreshes) and use the
  // canonical app.org_id RLS.
  "report_base_catalog",
  "report_metric_catalog",
  "materialized_view_metadata",
  // M23 Billing — Medicare (§3.x / D12): wage_index_factor is platform-shared CCN-keyed annual CMS data
  // with NO organization_id BY DESIGN — one row per (CCN, fiscal year), loaded by the platform-only
  // wage-index loader on the annual CMS hospice rate update and read by the HIPPS/per-diem calculator at
  // claim assembly; tenants cannot edit. Read-all within any tenant, writes via the platform loader (the
  // M38 code_system / M34 onboarding_task_template precedent). The other sixteen M23 tables carry
  // organization_id and get standard app.org_id RLS (claim + claim_line additionally carry the three-column rule).
  "wage_index_factor",
  // M24 Billing — Medicaid (WX-PR-011): medicaid_state_plan_code is PLATFORM-shared per-state Medicaid
  // program catalog data with NO organization_id BY DESIGN — one row per (state, plan code), loaded by the
  // platform loader and snapshotted onto medicaid_claim.state_plan_code_id / _snapshot at claim assembly so
  // historic claims stay reproducible even if a state's plan catalog changes later. Read-all within any
  // tenant, writes via the platform loader (the M23 wage_index_factor precedent — self-owned by the
  // consuming billing module rather than routed through M40's entity-merge `MdmEntityProvider`, which is
  // sized for physician/facility/payer resolution, not a static reference list). The other fourteen M24
  // tables carry organization_id and get standard app.org_id RLS.
  "medicaid_state_plan_code",
  // M24 Billing — Medicaid (WX-PR-011 follow-up): medicaid_state_rate_schedule is PLATFORM-shared
  // per-state per-LOC per-county rate data with NO organization_id BY DESIGN, same posture as
  // medicaid_state_plan_code immediately above — see that entry's rationale (self-owned billing-module
  // reference table, not routed through M40). Snapshotted onto medicaid_claim_line.state_rate_schedule_id_
  // snapshot at assembly for the RHC/CHC/IRC/GIP lines only (never NF_RB — see the schema file's CHECK).
  "medicaid_state_rate_schedule",
  // M26 Cap Management (§3.3 / D3): cap_period_platform_constant is PLATFORM-shared CMS-published cap data
  // with NO organization_id BY DESIGN — one row per cap year ('FY2026'), published by the platform admin on
  // the annual CMS Hospice Wage Index Final Rule and snapshotted (immutable copy) into each tenant's
  // cap_period at open. Read-all within any tenant (USING(true)), writes only via the
  // cap.platform_constant.manage permission (the wage_index_factor / cost_report_validation_rule precedent).
  // The other eleven M26 tables carry organization_id and get standard app.org_id RLS.
  "cap_period_platform_constant",
  // M21 Supplies (§3.1.3 / D11): supply_item is the PLATFORM-shared canonical SKU catalog — one row per
  // real-world HCPCS-keyed item, rewritten wholesale by the annual CMS HCPCS loader, the same answer for
  // every tenant — with NO organization_id BY DESIGN. Dual-grant RLS in 0106: read-all
  // `USING (is_active = true)` TO wardenx_app, writes only via wardenx_admin; it audits through the M1
  // baseline `wardenx_audit_trigger()` because the M4 generator's body reads NEW.organization_id (the M22
  // form_template / M38 code_system / M39 consent_type_catalog precedent). The tenant half of the D11
  // canonical-plus-overlay pair, tenant_supply_item_extension, is intentionally NOT listed here — it carries
  // organization_id NOT NULL and gets standard app.org_id RLS. comfort_kit_template / _medication and
  // vendor_routing_rule are likewise NOT listed: their organization_id is NULLABLE only on the platform-floor
  // / platform-scope row, paired with a discriminator column and a CHECK pair, so the column is present and
  // the tenant rows are org-scoped. The other seven M21 tables carry organization_id NOT NULL.
  "supply_item",
  // M32 AI Platform (§3.3): SIX of the thirteen tables are the platform's AI-GOVERNANCE surface and
  // carry NO organization_id BY DESIGN. `ai_capability` is the capability registry — a tenant that
  // cannot SEE a capability cannot opt in to it (§5.3/W4), so read-all is the point, not a concession;
  // `ai_capability_lifecycle_event` is the append-only D2 approval ledger (a transition is a fact about
  // the capability, not about any tenant); `ai_capability_calibration` is the per-(capability, backend)
  // threshold + drift baseline; `ai_model_backend` is the version-pinned model registry, where a
  // per-tenant copy would let two tenants disagree about which model version answered; `ai_prompt_template`
  // is the versioned prompt registry and the D18 prohibited-zone key; `ai_evaluation_run` is governance
  // evaluation evidence run against the model on a held-out set, not inside a tenant. All six get
  // read-all `USING (true)` TO wardenx_app with writes only via wardenx_admin in 0116 (the M38
  // code_system / M22 form_template / M21 supply_item precedent); the four with an empty §3.4 denylist
  // audit through M1's baseline `wardenx_audit_trigger()`, and the two with a denylist get generated
  // scrubbing functions that resolve organization_id from the SESSION because the column does not exist.
  //
  // The other seven are intentionally NOT listed. Six carry organization_id NOT NULL under canonical
  // app.org_id RLS (ai_tenant_opt_in_record, ai_clinician_opt_out, ai_invocation, ai_token_ledger,
  // ai_hallucination_report, ai_routing_override), and `ai_kill_switch_state`'s organization_id is
  // NULLABLE only on the platform-wide kill row — the column is present and its RLS splits by COMMAND so
  // a tenant reads the platform row and can never write one.
  "ai_capability",
  "ai_capability_lifecycle_event",
  "ai_capability_calibration",
  "ai_model_backend",
  "ai_prompt_template",
  "ai_evaluation_run",
  // M28 FHIR Gateway (§3.3 / §3.5): `fhir_capability_snapshot` is the platform-singleton
  // CapabilityStatement (D11) and carries NO organization_id BY DESIGN — a conformance statement is the
  // same contract for every tenant. Read-all `USING (true)` TO wardenx_app, writes only via wardenx_admin
  // (0137; the M32 ai_capability / M38 code_system / M22 form_template precedent); it audits through M1's
  // baseline `wardenx_audit_trigger()`, which resolves the (absent) org from the session. The other seven
  // M28 tables carry organization_id and get standard app.org_id RLS.
  "fhir_capability_snapshot",
  // M35 Subscription Billing (§3.3 / §3.5): NINE tables carry no tenant-RLS organization_id BY DESIGN.
  //   • `plan` / `plan_meter` / `promo_code` — the platform-owned pricing + coupon catalog (D11). The
  //     same offer for every tenant, so read-all `USING (true)` TO wardenx_app, writes only via
  //     wardenx_admin (0143; the M38 code_system / M28 fhir_capability_snapshot precedent).
  //   • `revenue_recognition_snapshot` — the cross-tenant MRR/ARR aggregate (W-SB-15): platform-only
  //     read+write, never exposed to tenant queries.
  //   • `patient_pseudonym_key` — the M35-private HMAC key catalog: platform-only read+write; §3.6 grants
  //     it FULL audit exclusion (the key-rotation timeline must not enter the audit log), so it is the one
  //     M35 table with no write-audit trigger.
  //   • `stripe_webhook_event` / `stripe_api_call_audit` — a single Stripe webhook / API call may carry
  //     data spanning multiple tenants, so these ledgers are platform-only. `stripe_webhook_event` carries
  //     a best-effort `derived_organization_id` (NOT the RLS org column — no `\borganization_id\b` word
  //     boundary); `stripe_api_call_audit` DOES have a nullable `organization_id` column and is therefore
  //     NOT listed here (it satisfies the column-presence rule directly).
  //   • `platform_retained_invoice` / `platform_retained_invoice_line` — M35-F06 (ARCH-186/085/251): the
  //     7-year invoice-retention tables that receive invoice rows COPIED out of the tenant-scoped
  //     `invoice` table on offboarding (copy-then-delete). They carry `original_organization_id` for
  //     forensic traceability only (again, no `\borganization_id\b` word boundary), never a tenant RLS
  //     column. The twelve tenant-scoped M35 tables carry organization_id and get standard app.org_id RLS.
  "plan",
  "plan_meter",
  "promo_code",
  "revenue_recognition_snapshot",
  "patient_pseudonym_key",
  "stripe_webhook_event",
  "platform_retained_invoice",
  "platform_retained_invoice_line",
  // M29 External Interfaces (§3.3 / §3.5): the two NPPES cache tables carry NO organization_id BY DESIGN —
  // the CMS NPPES registry is the same public provider directory for every tenant. `nppes_provider` (keyed
  // by the 10-char NPI) and `nppes_sync_run` are read-all `USING (true)` TO wardenx_app, written only via
  // wardenx_admin under the platform-role nightly sync (0148; the M28 fhir_capability_snapshot / M38
  // code_system precedent). The other nine M29 tables carry organization_id and get standard app.org_id RLS.
  "nppes_provider",
  "nppes_sync_run",
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
    const superseded = SUPERSEDED_RLS_MIGRATIONS[file];
    const supersededOk =
      superseded !== undefined &&
      existsSync(join(REPO_ROOT, superseded.supersededBy)) &&
      superseded.policies.every((policy) =>
        new RegExp(`DROP\\s+POLICY\\s+(IF\\s+EXISTS\\s+)?"?${policy}"?`, "i").test(
          readFileSync(join(REPO_ROOT, superseded.supersededBy), "utf8"),
        ),
      );
    if (superseded && !supersededOk) {
      violations.push({
        file,
        rule: "rls-session-variable",
        detail: `listed as superseded by ${superseded.supersededBy}, but that migration is missing or does not drop ${superseded.policies.join(", ")}`,
      });
    }
    const isAuditCapture = /audit_phi_write|INSERT\s+INTO\s+audit_event/i.test(src);
    const isKeyRingDefiner = /m34_provision_tenant_key_ring|m34_destroy_tenant_key_ring/.test(src);
    let m: RegExpExecArray | null;
    SESSION_VAR_RE.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((m = SESSION_VAR_RE.exec(src))) {
      if (m[1] !== CANONICAL_VAR) {
        if (AUDIT_CONTEXT_VARS.has(m[1]!) && isAuditCapture) continue;
        if (KEY_RING_CONTEXT_VARS.has(m[1]!) && isKeyRingDefiner) continue;
        if (supersededOk) continue;
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
