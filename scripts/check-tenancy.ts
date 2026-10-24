/**
 * ChartWarden — Tenancy & RLS Invariant Check  (ADR-0010; fitness check #10)
 * ------------------------------------------------------------------
 * Enforces, statically, the four tenancy invariants that prose alone let drift
 * across the corpus (audit X3/X4/S5):
 *
 *   1. THREE-COLUMN RULE (ARCH-011) — every PHI-bearing table carries
 *      `organization_id` and (nullable only on org-level entities)
 *      `provider_entity_id` + `location_id`.
 *   2. CANONICAL RLS VARIABLE — the only session variable any policy or
 *      `current_setting(...)` may key on is `app.org_id` (set by withOrgContext()).
 *      Bans `app.organization_id`, `app.tenant_id`, `app.current_org_id`,
 *      `wardenx.org_id`, `app.current_organization_id`, etc. Its two exemptions
 *      (audit attribution, M34 key ring) are scoped to the STATEMENT they were
 *      written for and never reach a policy predicate — see Rule 2a/2b below and
 *      #22. Policy predicates are judged on the migrations' NET effect, so a
 *      violation a later migration drops and replaces stops counting — a static
 *      replay of apply order, NOT a catalog read, because `arch:fitness` runs
 *      where there is no database; see survivingPolicies() for the full argument
 *      and for what that costs.
 *   3. NO DANGEROUS POLICY SHAPES — bans `OR organization_id IS NULL` in a
 *      tenant-writable policy and permissive `FOR ALL` policies that OR together.
 *   4. RLS ENABLED ⇒ RLS FORCED (F-087) — `ENABLE ROW LEVEL SECURITY` exempts the
 *      table's OWNER, and migrate.ts connects as `DATABASE_ADMIN_URL ?? DATABASE_URL`,
 *      so a deployment that migrates with only DATABASE_URL set makes `chartwarden_app`
 *      the owner and every policy on an unFORCEd table stops applying to it. Judged
 *      on the migrations' NET effect, like Rule 2 — and modelling the two catalog
 *      sweeps (0118/0159) rather than hardcoding them. The answer to this had been a
 *      manual re-sweep FOUR times (0118 · 0159 · 0203 · F-087), each found by
 *      querying a live schema; see checkForceRls().
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
// Any current_setting('app.*'|'wardenx.*') that is NOT the canonical var is a violation. The
// doubled quote is not a typo: inside dynamic SQL (`EXECUTE format('CREATE POLICY … USING
// (… current_setting(''app.user_id'') …)')`) the literal is escaped by doubling, and a scan that
// only accepts a single quote reads straight past every policy the five DO-block migrations build.
const SESSION_VAR_RE = /current_setting\(\s*['"]{1,2}((?:app|wardenx)\.[a-z_]+)['"]{1,2}/g;
// Audit *attribution* context vars (M04 §3.3): the write-audit trigger reads request context to
// stamp WHO/WHICH-correlation/provider/location into the immutable audit_event row. These are NOT
// RLS predicates — ADR-0010 D2 governs row *visibility*, which still keys ONLY on app.org_id; these
// only populate audit columns. Permitted exclusively inside the audit-capture path (the audit()
// helper / write-audit trigger generator, recognized by `audit_phi_write` / `INSERT INTO audit_event`)
// IN THE SAME STATEMENT, and never inside a policy predicate — this used to be tested against the
// whole file, which is how it exempted an org-unscoped policy sitting beside an audit trigger (#22).
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
// path (recognized by `m34_provision_tenant_key_ring` / `m34_destroy_tenant_key_ring`), in the same
// statement, and never inside a policy predicate.
const KEY_RING_CONTEXT_VARS = new Set<string>([
  "app.dek_kek_wrapped_ciphertext_b64",
  "app.dek_kek_id",
  "app.destroyed_by_membership_id",
]);
// WP 4.2 (ADR-0069): the acknowledgment-request UPDATE guard and the history INSERT guard bind WHO acts (acknowledge / resolve only
// as the assigned user, reassign as a party, cancel as the sender; an event names the session's own user) to the session's
// `app.user_id`. That is an authorization BACKSTOP against application bugs on a transition, NOT an RLS predicate and not a defence
// against a compromised application role: row visibility still keys only on app.org_id. Permitted only in a SQL statement whose
// HEAD is `CREATE [OR REPLACE] FUNCTION` of one of those two functions (a name in a comment or a body elsewhere does not count),
// and never inside a policy.
// WP 5.8 (ADR-0087): the break-glass READ-trail insert guard is the same kind of backstop: a read row is recorded only against a live grant
// whose grantee is the session's own `app.user_id`, so nobody can log reads against someone else's grant. Same rule: that one function head,
// never a policy; row visibility still keys only on app.org_id.
// WP 5.7 (ADR-0089): the export DOWNLOAD trail guard is the same backstop: a row is recorded only by the job's requester (`app.user_id`)
// against a ready, unexpired job. Same rule: that one function head, never a policy. The export JOB guard binds the requester (insert)
// and the decider (approve/reject) to `app.user_id` the same way.
// WP 6.7 (ADR-0099): the family setting / contact / invitation guards bind the acting staff member (create, close, block, revoke) to `app.user_id`.
// WP 6.6 (ADR-0096): the external-share guards bind the creator (insert) and the revoker to `app.user_id`; the read-trail guard checks a live session/share.
// WP 5.6 (ADR-0055 item 7): the message REDACTION guard binds the requester (insert) and the approver (approval) to `app.user_id`: two
// people, enforced in the database. Same rule: that one function head, never a policy.
const ACK_ACTOR_GUARD_HEAD =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(?:message_ack_request_update_guard|message_ack_event_insert_guard|message_break_glass_read_guard|message_export_download_guard|message_export_job_guard|message_redaction_guard|message_external_share_guard|message_external_share_read_guard|message_ack_broadcast_guard|message_ack_broadcast_recipient_guard|message_family_setting_guard|message_family_contact_guard|message_family_invitation_guard)\s*\(/i;
// ADR-0078: `app.ack_supervisor_reassign` is the transaction-local marker the application sets for a supervisor reassign; the same
// backstop, the same two functions, never a policy.
const ACK_ACTOR_VARS = new Set<string>(["app.user_id", "app.ack_supervisor_reassign"]);
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
  // M38 loader pipeline (GAP-108, migration 0364): the seven common-shape concept tables, the loader-only staging
  // area and the licence attestations — all platform-shared (no org column), loader-written, RLS FORCEd.
  "concept_icd10pcs",
  "concept_ndc",
  "concept_hcpcs",
  "concept_cvx",
  "concept_revenue",
  "concept_carc",
  "concept_rarc",
  "concept_staging",
  "terminology_license_attestation",
  // M10 HOPE modernization Phase 1A: CMS HOPE Data Specification reference tables.
  // These carry no tenant data and are immutable platform reference rows shared by every org.
  // The tenant-scoped item answers live in hope_assessment_answer, which is intentionally NOT listed.
  "hope_spec_version",
  "hope_spec_item",
  "hope_spec_item_isc",
  "hope_spec_item_option",
  // M36 Secure Messaging (§3.4–3.6, §3.11): five tables carry no organization_id BY DESIGN.
  // `presence` + `delivery_endpoint` are user-owned and cross-org (the human, not the tenant —
  // same posture as `session`). `notification_delivery` + `alert_receipt`
  // are pure children of `alert` (ON DELETE cascade) and inherit tenancy via the parent
  // FK (`message_attachment` left this list in 1075: it carries organization_id + composite FKs now); RLS is applied through the parent-join — `alert_receipt` (migration 0243) shipped with
  // neither the join policy nor the chartwarden_app grant its siblings got in M36-T03, so every real
  // request touching it 42501'd; migration 0247 gives it the same shape. `alert_payload_catalog`
  // is platform-floor reference, read-all, populated at boot from the §3.12 Foundation Registry.
  // The remaining M36 tables carry organization_id and get standard app.org_id RLS in M36-T03.
  "presence",
  "delivery_endpoint",
  "notification_delivery",
  "alert_receipt",
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
  // (pre-organization signup funnel — chartwarden_app cannot SELECT; tenant_platform_writer only).
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
  // M23 (migration 1058): the CMS hospice wage-index geography (ZIP -> county -> CBSA / rural / transition code and
  // the published index) is platform-shared reference data like wage_index_factor: no organization_id, no PHI,
  // tenants SELECT only, the billing_platform_loader role writes.
  "hospice_zip_county",
  "hospice_zip3_area",
  "hospice_cbsa_county",
  "hospice_cbsa_wage_index",
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
  // `USING (is_active = true)` TO chartwarden_app, writes only via chartwarden_admin; it audits through the M1
  // baseline `chartwarden_audit_trigger()` because the M4 generator's body reads NEW.organization_id (the M22
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
  // read-all `USING (true)` TO chartwarden_app with writes only via chartwarden_admin in 0116 (the M38
  // code_system / M22 form_template / M21 supply_item precedent); the four with an empty §3.4 denylist
  // audit through M1's baseline `chartwarden_audit_trigger()`, and the two with a denylist get generated
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
  // same contract for every tenant. Read-all `USING (true)` TO chartwarden_app, writes only via chartwarden_admin
  // (0137; the M32 ai_capability / M38 code_system / M22 form_template precedent); it audits through M1's
  // baseline `chartwarden_audit_trigger()`, which resolves the (absent) org from the session. The other seven
  // M28 tables carry organization_id and get standard app.org_id RLS.
  "fhir_capability_snapshot",
  // M35 Subscription Billing (§3.3 / §3.5): NINE tables carry no tenant-RLS organization_id BY DESIGN.
  //   • `plan` / `plan_meter` / `promo_code` — the platform-owned pricing + coupon catalog (D11). The
  //     same offer for every tenant, so read-all `USING (true)` TO chartwarden_app, writes only via
  //     chartwarden_admin (0143; the M38 code_system / M28 fhir_capability_snapshot precedent).
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
  // by the 10-char NPI) and `nppes_sync_run` are read-all `USING (true)` TO chartwarden_app, written only via
  // chartwarden_admin under the platform-role nightly sync (0148; the M28 fhir_capability_snapshot / M38
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

// ---- SQL structure: statements, policy statements, clause bodies ----------
// Rule 2's two exemptions (AUDIT_CONTEXT_VARS / KEY_RING_CONTEXT_VARS) used to be tested against
// the whole FILE: one `INSERT INTO audit_event` anywhere exempted every non-canonical
// current_setting() in it. The repo's own convention puts a module's RLS policies and its audit
// triggers in the SAME migration (`*_rls_audit_triggers.sql`), so the exemption fired on exactly
// the files most likely to define a policy — which is how an `app.user_id`-keyed, org-unscoped
// `FOR ALL` policy on an org-scoped table (#21) sat green in `0017` while leaking cross-tenant
// reads AND writes. The exemptions are now scoped to the STATEMENT they were written for, and no
// policy body is ever exempt. That needs the file split into statements, which needs a lexer that
// survives comments, quoted identifiers and dollar-quoted function bodies.
interface Span {
  readonly start: number;
  readonly end: number;
}

/** Top-level statement extents: split on `;` outside comments, quotes and dollar-quoted bodies. */
function sqlStatements(src: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "-" && src[i + 1] === "-") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      // PostgreSQL block comments nest.
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    const tag = DOLLAR_TAG_RE.exec(src.slice(i, i + 64));
    if (c === "$" && tag) {
      const close = src.indexOf(tag[0], i + tag[0].length);
      i = close === -1 ? src.length : close + tag[0].length;
      continue;
    }
    if (c === ";") {
      out.push({ start, end: i });
      start = ++i;
      continue;
    }
    i++;
  }
  if (src.slice(start).trim().length > 0) out.push({ start, end: src.length });
  return out;
}
const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Index just past a `'…'` / `"…"` run starting at `open`, honouring the doubled-quote escape. */
function skipQuoted(src: string, open: number, quote: string): number {
  let i = open + 1;
  while (i < src.length) {
    if (src[i] === quote) {
      if (src[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return src.length;
}

/** A statement's text with leading whitespace and leading `--` / block comments removed. */
function statementHead(text: string): string {
  let s = text;
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("--")) {
      const nl = t.indexOf("\n");
      s = nl === -1 ? "" : t.slice(nl + 1);
      continue;
    }
    if (t.startsWith("/*")) {
      const close = t.indexOf("*/");
      s = close === -1 ? "" : t.slice(close + 2);
      continue;
    }
    return t;
  }
}

// `CREATE POLICY x ON only "public"."t"` — either side of the dot may be quoted, ONLY is optional.
const IDENT = String.raw`(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = new RegExp(`^(?:${IDENT}\\s*\\.\\s*)?(${IDENT})$`);
function normIdent(raw: string): string {
  const tail = QUALIFIED.exec(raw.trim())?.[1] ?? raw.trim();
  return tail.replace(/^"|"$/g, "").toLowerCase();
}
const POLICY_TARGET_RE = new RegExp(
  `^(CREATE|ALTER|DROP)\\s+POLICY\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(${IDENT})\\s+ON\\s+(?:ONLY\\s+)?((?:${IDENT}\\s*\\.\\s*)?${IDENT})`,
  "i",
);
const POLICY_RENAME_RE = new RegExp(`\\bRENAME\\s+TO\\s+(${IDENT})`, "i");
const DROP_TABLE_RE = new RegExp(
  `^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?((?:${IDENT}\\s*\\.\\s*)?${IDENT}(?:\\s*,\\s*(?:${IDENT}\\s*\\.\\s*)?${IDENT})*)`,
  "i",
);

interface PolicyStatement {
  readonly verb: "CREATE" | "ALTER" | "DROP";
  readonly name: string;
  readonly table: string;
  readonly text: string;
}
function parsePolicyStatement(text: string): PolicyStatement | null {
  const head = statementHead(text);
  const m = POLICY_TARGET_RE.exec(head);
  if (!m) return null;
  return {
    verb: m[1]!.toUpperCase() as PolicyStatement["verb"],
    name: normIdent(m[2]!),
    table: normIdent(m[3]!),
    text: head,
  };
}

/**
 * Index of the first `re` match at parenthesis depth 0 — `USING` and `WITH CHECK` are policy
 * keywords, but `USING` is also a JOIN clause that can appear inside a policy's own subquery.
 */
function topLevelIndex(text: string, re: RegExp): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, c) - 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m.index === i) return i;
    }
  }
  return -1;
}

/** The balanced `( … )` run starting at the first `(` at or after `from`. */
function balancedAfter(text: string, from: number): string | null {
  const open = text.indexOf("(", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, c) - 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

/** A policy's `USING` and `WITH CHECK` predicate bodies, labelled. */
function policyClauses(text: string): { label: string; body: string }[] {
  const out: { label: string; body: string }[] = [];
  const withCheck = topLevelIndex(text, /\bWITH\s+CHECK\b/giy);
  if (withCheck !== -1) {
    const body = balancedAfter(text, withCheck);
    if (body) out.push({ label: "WITH CHECK", body });
  }
  const using = topLevelIndex(text, /\bUSING\b/giy);
  if (using !== -1 && (withCheck === -1 || using < withCheck)) {
    const body = balancedAfter(text, using);
    if (body) out.push({ label: "USING", body });
  }
  return out;
}

function sessionVars(text: string): string[] {
  const found: string[] = [];
  SESSION_VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
  while ((m = SESSION_VAR_RE.exec(text))) found.push(m[1]!);
  return found;
}

/**
 * A policy on this table has to be constrained to the current tenant.
 *
 * NON_ORG_SCOPED opts a table out of Rule 1 because it has no `organization_id` COLUMN to point at
 * — `presence` and `delivery_endpoint` are the human's rows, not the tenant's, so `app.user_id` is
 * the whole of their moat and is correct. That is a statement about columns, not about visibility:
 * the three entries the list itself annotates "the tenancy spine itself" carry the tenant identity
 * in `organization.id` / their own `organization_id`, and a policy on them still has to name it.
 * The pre-org membership picker (#15) leaked whole organizations from inside one of them.
 */
const TENANCY_SPINE = new Set<string>(["organization", "provider_entity", "location"]);
const mustBeOrgScoped = (table: string) => !NON_ORG_SCOPED.has(table) || TENANCY_SPINE.has(table);

/**
 * Every policy that still EXISTS once the migrations have been applied in order, keyed
 * `table::policy`. The gate reads files, so without this a remediated violation stays red forever:
 * the offending `CREATE POLICY` text never leaves `0017`, it is superseded by a `DROP` + `CREATE`
 * in a later migration. `migrate.ts` applies files in plain lexicographic order, so replaying that
 * order here is the same net effect the database ends up with, minus the database.
 *
 * NOT a catalog read, deliberately: `arch:fitness` runs where there is no database — that is the
 * whole reason the live suites are `skipIf`-guarded — so a catalog-reading gate would skip in CI,
 * which is the one place it has to speak. `m1-rls-isolation.live.test.ts` asserts against
 * `pg_policies` as the catalog-side complement, and runs in the `rls-live` job.
 *
 * KNOWN LIMIT: a policy created through dynamic SQL (`EXECUTE format('CREATE POLICY …')` inside a
 * DO block) is one opaque statement to this pass and is not tracked. Rule 2's ordinary text scan
 * still sees the session variables inside it — including through the doubled quotes dynamic SQL
 * escapes them with — and no statement that builds a policy is exempt.
 * Measured 2026-08-25 against a database with all 216 migrations applied: `pg_policies` held 700
 * policies, this pass tracked 482, and all 482 existed — the replay claims no policy the database
 * does not have. Of the 218 it cannot see, none keys on a non-canonical session variable.
 */
function survivingPolicies(files: readonly string[]): Map<string, PolicyDef> {
  const live = new Map<string, PolicyDef>();
  const key = (table: string, name: string) => `${table}::${name}`;
  for (const file of [...files].sort()) {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const span of sqlStatements(src)) {
      const text = src.slice(span.start, span.end);
      const head = statementHead(text);
      const dropped = DROP_TABLE_RE.exec(head);
      if (dropped) {
        for (const raw of dropped[1]!.split(",")) {
          const table = normIdent(raw);
          for (const k of [...live.keys()]) if (k.startsWith(`${table}::`)) live.delete(k);
        }
        continue;
      }
      const stmt = parsePolicyStatement(text);
      if (!stmt) continue;
      const k = key(stmt.table, stmt.name);
      if (stmt.verb === "DROP") {
        live.delete(k);
        continue;
      }
      if (stmt.verb === "CREATE") {
        live.set(k, { file, table: stmt.table, name: stmt.name, text: stmt.text });
        continue;
      }
      const rename = POLICY_RENAME_RE.exec(stmt.text);
      const existing = live.get(k);
      if (rename) {
        if (existing) {
          live.delete(k);
          const renamed = normIdent(rename[1]!);
          live.set(key(stmt.table, renamed), { ...existing, name: renamed, file });
        }
        continue;
      }
      // ALTER POLICY … USING/WITH CHECK replaces the predicate; anything else (roles) leaves it.
      if (policyClauses(stmt.text).length > 0)
        live.set(k, { file, table: stmt.table, name: stmt.name, text: stmt.text });
    }
  }
  return live;
}
/**
 * How many `CREATE`/`ALTER`/`DROP POLICY` keywords a file carries at CODE level — outside comments, string
 * literals and dollar-quoted bodies. Guard on the guard: this must reconcile with the number of
 * statements Rule 2a actually parsed. If the splitter ever mis-spans a policy — merging it with the
 * audit trigger that so often sits beside it — the policy would fall back to the text scan with
 * that statement's exemptions in reach, which is precisely the hole this gate closes, re-opened
 * silently. A count that does not add up is a hard failure, not a warning.
 */
function codeLevelPolicyKeywords(src: string): number {
  const at = /(?:CREATE|ALTER|DROP)\s+POLICY\b/iy;
  let count = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "-" && src[i + 1] === "-") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    const tag = DOLLAR_TAG_RE.exec(src.slice(i, i + 64));
    if (c === "$" && tag) {
      const close = src.indexOf(tag[0], i + tag[0].length);
      i = close === -1 ? src.length : close + tag[0].length;
      continue;
    }
    at.lastIndex = i;
    if (at.test(src)) count++;
    i++;
  }
  return count;
}

interface PolicyDef {
  readonly file: string;
  readonly table: string;
  readonly name: string;
  readonly text: string;
}

const violations: Violation[] = [];

// ---- Rule 2 + 3: scan every module's code + schema + migrations -----------
/**
 * Rule 2a — a policy predicate that survives to the end state must be constrained to the current
 * tenant. NEITHER exemption reaches here: both are justified in their own comment as "NOT RLS
 * predicates", and ADR-0010 D2 contemplates no exemption for one.
 *
 * The test is per CLAUSE, not per policy: `USING (org = app.org_id AND user_id = app.user_id)` is
 * the correct shape and stays green, while a `WITH CHECK` that drops the org conjunct is the hole
 * #21 actually was — it accepted a row for ANY organization_id satisfying the FK.
 */
function checkPolicyPredicate(def: PolicyDef): void {
  if (!mustBeOrgScoped(def.table)) return;
  for (const { label, body } of policyClauses(def.text)) {
    const vars = sessionVars(body);
    if (vars.includes(CANONICAL_VAR)) continue;
    const nonCanonical = [...new Set(vars.filter((v) => v !== CANONICAL_VAR))];
    if (nonCanonical.length === 0) continue;
    const named = nonCanonical.map((v) => `'${v}'`).join(", ");
    violations.push({
      file: def.file,
      rule: "rls-policy-not-org-scoped",
      detail: [
        `policy '${def.name}' on '${def.table}' keys its ${label} predicate on ${named} with no`,
        `'${CANONICAL_VAR}' conjunct — a permissive policy is a GRANT, not a filter, so this is`,
        "the WHOLE of what the role may reach on the table, and it is not tenant-scoped",
        "(ADR-0010 D1/D2)",
      ].join(" "),
    });
  }
}

/** `CREATE`/`ALTER POLICY` extents in a non-SQL source (DDL held in a TypeScript string). */
function policyWindows(src: string): Span[] {
  const out: Span[] = [];
  const re = /\b(?:CREATE|ALTER)\s+POLICY\b/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
  while ((m = re.exec(src))) {
    let i = m.index;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (c === "'" || c === '"') {
        i = skipQuoted(src, i, c) - 1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth <= 0) break;
    }
    const end = Math.min(i, src.length);
    out.push({ start: m.index, end });
    re.lastIndex = end;
  }
  return out;
}

let policyKeywordSites = 0;
let parsedPolicyStatements = 0;
const allPaths = [SCHEMA_DIR, ...MODULES.flatMap((m: ModuleDef) => m.codePaths)];
const scanned = new Set<string>();
const sqlFiles: string[] = [];
for (const base of allPaths) {
  for (const file of listFiles(base)) {
    if (scanned.has(file)) continue;
    scanned.add(file);
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const isSql = file.endsWith(".sql");
    if (isSql) {
      sqlFiles.push(file);
      policyKeywordSites += codeLevelPolicyKeywords(src);
    }

    // Rule 2b — canonical session variable everywhere a policy predicate ISN'T. Policy statements
    // are handed to Rule 2a below (in migration apply order, so a superseded one stops counting);
    // every other statement gets the two exemptions, scoped to THAT statement rather than to the
    // whole file. TypeScript has no statement structure to scope to, so it keeps file scope — but
    // DDL it carries in a string is still located, and the exemptions still do not enter a policy.
    const spans: readonly Span[] = isSql
      ? sqlStatements(src)
      : [{ start: 0, end: src.length } as Span];
    const tsPolicies = isSql ? [] : policyWindows(src);
    for (const span of spans) {
      const text = src.slice(span.start, span.end);
      if (isSql && parsePolicyStatement(text) !== null) {
        parsedPolicyStatements++;
        continue;
      }
      const isAuditCapture = /audit_phi_write|INSERT\s+INTO\s+audit_event/i.test(text);
      const isKeyRingDefiner = /m34_provision_tenant_key_ring|m34_destroy_tenant_key_ring/.test(
        text,
      );
      // A statement that BUILDS a policy is never exempt — including one that builds it through
      // dynamic SQL, where Rule 2a cannot follow it. The known limit is that such a policy is not
      // TRACKED; it must not also become the one place the exemptions can still hide inside.
      // SQL only: for TypeScript `text` is the whole file, where this would mean nothing — the
      // tsPolicies windows below are what keeps the exemption out of a policy there.
      const isAckActorGuard = isSql && ACK_ACTOR_GUARD_HEAD.test(statementHead(text));
      const buildsPolicy = isSql && /\b(?:CREATE|ALTER)\s+POLICY\b/i.test(text);
      let m: RegExpExecArray | null;
      SESSION_VAR_RE.lastIndex = 0;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
      while ((m = SESSION_VAR_RE.exec(text))) {
        if (m[1] === CANONICAL_VAR) continue;
        const at = span.start + m.index;
        if (tsPolicies.some((w) => at >= w.start && at < w.end)) continue; // Rule 2a's business
        if (!buildsPolicy && AUDIT_CONTEXT_VARS.has(m[1]!) && isAuditCapture) continue;
        if (!buildsPolicy && KEY_RING_CONTEXT_VARS.has(m[1]!) && isKeyRingDefiner) continue;
        if (!buildsPolicy && ACK_ACTOR_VARS.has(m[1]!) && isAckActorGuard) continue;
        violations.push({
          file,
          rule: "rls-session-variable",
          detail: `uses current_setting('${m[1]}') — the only allowed RLS variable is '${CANONICAL_VAR}' (ADR-0010 D2)`,
        });
      }
    }
    for (const w of tsPolicies) {
      const text = statementHead(src.slice(w.start, w.end));
      const target = POLICY_TARGET_RE.exec(text);
      if (!target) continue;
      checkPolicyPredicate({
        file,
        table: normIdent(target[3]!),
        name: normIdent(target[2]!),
        text,
      });
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

// Rule 2a — every policy the migrations leave BEHIND, judged in apply order. A violation that a
// later migration drops and replaces is remediated; the offending text staying in its original
// file forever is not the same thing, and a gate that cannot tell the two apart can never go green.
for (const def of survivingPolicies(sqlFiles).values()) checkPolicyPredicate(def);

// ---- Rule 4: RLS enabled ⇒ RLS FORCEd ------------------------------------
const RLS_ENABLE_RE = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?((?:${IDENT}\\s*\\.\\s*)?${IDENT})\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
  "i",
);
const RLS_FORCE_RE = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?((?:${IDENT}\\s*\\.\\s*)?${IDENT})\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
  "i",
);
const RLS_UNFORCE_RE = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?((?:${IDENT}\\s*\\.\\s*)?${IDENT})\\s+NO\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
  "i",
);
const RLS_DISABLE_RE = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?((?:${IDENT}\\s*\\.\\s*)?${IDENT})\\s+DISABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
  "i",
);

/**
 * A CATALOG SWEEP — a statement that reads `pg_class.relforcerowsecurity` and issues
 * `FORCE ROW LEVEL SECURITY` from what it finds. Migrations 0118 and 0159 are both exactly this:
 * a `DO $$ … $$` loop over every table with RLS on and FORCE off. The replay cannot execute it, so
 * it models it — a sweep forces everything enabled AT THAT POINT in the apply order, which is what
 * the loop's own `WHERE c.relrowsecurity AND NOT c.relforcerowsecurity` predicate says.
 *
 * Detected by what the statement DOES, not by its filename, so a fourth sweep needs no edit here.
 * Requiring BOTH tokens is what keeps it narrow: a DO block that merely mentions FORCE without
 * consulting the catalog is not a sweep and is not credited as one.
 */
function isForceRlsCatalogSweep(text: string): boolean {
  return /\brelforcerowsecurity\b/i.test(text) && /\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(text);
}

/**
 * Rule 4 — every table the migrations leave with RLS ENABLED must also be left FORCEd.
 *
 * `ENABLE ROW LEVEL SECURITY` does not apply to the table's OWNER. Every policy in this repo is
 * `TO chartwarden_app`, and `scripts/db/migrate.ts` connects as `DATABASE_ADMIN_URL ?? DATABASE_URL` —
 * so a deployment that runs the migrator with only `DATABASE_URL` set makes `chartwarden_app` the owner
 * and every policy on an unFORCEd table stops applying to the application's own role. Migration
 * 0118's header sets that out in full; it is not a hypothetical, it is why 0118 exists.
 *
 * There is no `rolbypassrls` flag to catch it: the boot guard in `apps/backend/src/index.ts` checks
 * BYPASSRLS, and ownership is not BYPASSRLS. The catalog-side complement
 * (`rls-isolation.live.test.ts`, "every RLS table is FORCEd") is the only other thing that asks —
 * and it runs in `rls-live`, so it speaks only where there is a database.
 *
 * THIS RULE EXISTS BECAUSE THE ANSWER HAS BEEN A MANUAL RE-SWEEP FOUR TIMES. 0118 forced 370
 * tables; 0159 re-swept the 66 that M28/M29/M35/M37 had added since; 0203 hand-patched two M24
 * tables; F-087 found one more. Each round was found by querying a live schema, and each fixed the
 * tables that existed that day without preventing the next one — a mitigation applied four times is
 * a missing gate, not a policy.
 *
 * Judged on the migrations' NET effect in apply order, the same posture as Rule 2a and for the same
 * reason: `arch:fitness` runs where there is no database.
 *
 * KNOWN LIMIT, and it is the mirror of Rule 2a's: a table whose RLS is ENABLED by dynamic SQL is
 * invisible here, so it is never demanded to be FORCEd. That direction is a MISS, never a false
 * alarm — the rule can fail to notice a table, but it cannot invent one. Partition LEAVES are the
 * deliberate case: 0118's event trigger enables + forces them at CREATE time and
 * `rls-isolation.live.test.ts` asserts that against the catalog.
 */
function checkForceRls(files: readonly string[]): void {
  const enabled = new Map<string, string>(); // table → the file that enabled it
  const forced = new Set<string>();
  for (const file of [...files].sort()) {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const span of sqlStatements(src)) {
      const text = src.slice(span.start, span.end);
      const head = statementHead(text);

      const dropped = DROP_TABLE_RE.exec(head);
      if (dropped) {
        for (const raw of dropped[1]!.split(",")) {
          const table = normIdent(raw);
          enabled.delete(table);
          forced.delete(table);
        }
        continue;
      }
      const disable = RLS_DISABLE_RE.exec(head);
      if (disable) {
        enabled.delete(normIdent(disable[1]!));
        continue;
      }
      const unforce = RLS_UNFORCE_RE.exec(head);
      if (unforce) {
        forced.delete(normIdent(unforce[1]!));
        continue;
      }
      const force = RLS_FORCE_RE.exec(head);
      if (force) {
        forced.add(normIdent(force[1]!));
        continue;
      }
      const enable = RLS_ENABLE_RE.exec(head);
      if (enable) {
        enabled.set(normIdent(enable[1]!), file);
        continue;
      }
      if (isForceRlsCatalogSweep(text)) for (const t of enabled.keys()) forced.add(t);
    }
  }
  for (const [table, file] of [...enabled].sort()) {
    if (forced.has(table)) continue;
    violations.push({
      file,
      rule: "rls-enabled-not-forced",
      detail: [
        `table '${table}' is left with RLS ENABLED but never FORCEd — RLS does not apply to a`,
        "table's OWNER, and migrate.ts connects as `DATABASE_ADMIN_URL ?? DATABASE_URL`, so on a",
        "deployment that migrates with only DATABASE_URL set, chartwarden_app owns this table and every",
        "policy on it stops applying to it (ADR-0010 D2; migration 0118).",
        `\n  Fix: add \`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;\` beside the ENABLE.`,
      ].join(" "),
    });
  }
}
checkForceRls(sqlFiles);

if (policyKeywordSites !== parsedPolicyStatements) {
  console.error(
    [
      `✗ tenancy: policy accounting does not reconcile — ${policyKeywordSites} CREATE/ALTER/DROP`,
      `POLICY keyword(s) at code level, ${parsedPolicyStatements} parsed as policy statements.`,
      "\n  A policy the statement splitter mis-spans falls through to the plain text scan, where",
      "the audit/key-ring exemptions are reachable again — the exact blind spot this gate closes.",
      "\n  Fix sqlStatements()/parsePolicyStatement() rather than the count.",
    ].join(" "),
  );
  process.exit(1);
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
  console.log(
    "✓ tenancy: three-column rule, canonical app.org_id, no dangerous RLS shapes, RLS forced",
  );
  process.exit(0);
}
console.error(`✗ tenancy: ${violations.length} violation(s)\n`);
for (const v of violations)
  console.error(`  [${v.rule}] ${relative(REPO_ROOT, v.file)}\n    ${v.detail}\n`);
process.exit(1);
