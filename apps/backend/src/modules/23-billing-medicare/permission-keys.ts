// apps/backend/src/modules/23-billing-medicare/permission-keys.ts — M23 (§4.6 / §6).
//
// The twenty-eight permission keys Module 23 (Billing — Medicare) registers into Module 3's catalog — the
// §4.6 binding cross-module handshake. M3 must include these before M23's claim / NOE / NOTR / validation /
// rule-config / eligibility / sequestration / MAC-credential routes (§4.1) can be authorized; those routes
// gate on `requirePermission(key)`. The catalog `abac` field is the DEFAULT predicate per key; the route
// layer additionally composes the explicit §4.7 chain M23 owns (provider_entity_billing_scope /
// claim_in_billing_manager_caseload / override_role_eligible / regulatory_required_rule_protected) over the
// M3-base `inOrg` / `caseload_or_scope`.
//
// Categories (admin-UI grouping): every key groups under `billing` (the §4.6 catalog category); the
// platform-only key (`billing.rule_config.platform_admin`) is the lone exception the route layer additionally
// guards by the platform-scope check (the M27 cost_report / cost_report_admin split precedent, simplified to
// the single `billing` category the spec §4.6 declares).
//
// SOURCE OF TRUTH: the spec §4.6 places the canonical `M23_PERMISSION_KEYS` tuple in `@wardenx/billing`
// (packages/billing) — but that package is still a Phase-0 placeholder (no business logic yet), so this P1
// file is SELF-CONTAINED: it declares the keys + the `M23PermissionKey` union locally. When the billing
// package lands its `M23_PERMISSIONS` tuple, the Integrate phase (P3) reconciles this map against it (the M27
// pattern: backend permission-keys.ts mirrors the pure package tuple, asserted equal in test). The KEYS here
// are the §4.6 verbatim list and MUST stay in lock-step with `@wardenx/billing` + the §4.1 route inventory.
import type { PermissionDef } from "@wardenx/auth";

/**
 * The §4.6 permission keys M23 owns (registered into M3). Single-owner across the platform registry.
 * `as const satisfies` pins the literal keys while validating each value against `PermissionDef`; the
 * `abac` default is the dominant §4.7 predicate per key (the route composes it after the base `inOrg` /
 * `caseload_or_scope`). The step-up requirement on submit/replace/void/credential-admin (§6) is enforced
 * at the route layer (M2 SESSION_POLICY), not in the catalog `abac` field.
 */
export const M23_CONTRIBUTED_PERMISSIONS = {
  // --- claim surface (§6) ---
  "billing.claim.assemble": {
    resource: "billing_claim",
    action: "assemble",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.claim.read": {
    resource: "billing_claim",
    action: "read",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.update_draft": {
    resource: "billing_claim",
    action: "update_draft",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.delete_draft": {
    resource: "billing_claim",
    action: "delete_draft",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.submit": {
    resource: "billing_claim",
    action: "submit",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.replace": {
    resource: "billing_claim",
    action: "replace",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.void": {
    resource: "billing_claim",
    action: "void",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.read_ar_dashboard": {
    resource: "billing_claim",
    action: "read_ar_dashboard",
    category: "billing",
    abac: "inOrg",
  },
  "billing.claim.read_metrics": {
    resource: "billing_claim",
    action: "read_metrics",
    category: "billing",
    abac: "inOrg",
  },
  // --- NOE surface ---
  "billing.noe.read": {
    resource: "billing_noe",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.noe.submit": {
    resource: "billing_noe",
    action: "submit",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.noe.cancel": {
    resource: "billing_noe",
    action: "cancel",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- NOTR surface ---
  "billing.notr.read": {
    resource: "billing_notr",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.notr.submit": {
    resource: "billing_notr",
    action: "submit",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.notr.cancel": {
    resource: "billing_notr",
    action: "cancel",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- validation surface ---
  "billing.validation.read_run": {
    resource: "billing_validation",
    action: "read_run",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.validation.run": {
    resource: "billing_validation",
    action: "run",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.validation.override": {
    resource: "billing_validation",
    action: "override",
    category: "billing",
    abac: "override_role_eligible",
  },
  "billing.validation.read_override": {
    resource: "billing_validation",
    action: "read_override",
    category: "billing",
    abac: "inOrg",
  },
  // --- rule-config surface ---
  "billing.rule_config.read": {
    resource: "billing_rule_config",
    action: "read",
    category: "billing",
    abac: "inOrg",
  },
  "billing.rule_config.edit": {
    resource: "billing_rule_config",
    action: "edit",
    category: "billing",
    abac: "regulatory_required_rule_protected",
  },
  "billing.rule_config.platform_admin": {
    resource: "billing_rule_config",
    action: "platform_admin",
    category: "billing",
    abac: "none",
  },
  // --- eligibility surface ---
  "billing.eligibility.check": {
    resource: "billing_eligibility",
    action: "check",
    category: "billing",
    abac: "caseload_or_scope",
  },
  "billing.eligibility.read": {
    resource: "billing_eligibility",
    action: "read",
    category: "billing",
    abac: "caseload_or_scope",
  },
  // --- sequestration-policy surface ---
  "billing.sequestration_policy.read": {
    resource: "billing_sequestration_policy",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.sequestration_policy.edit": {
    resource: "billing_sequestration_policy",
    action: "edit",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- MAC credential surface ---
  "billing.mac_credential.read": {
    resource: "billing_mac_credential",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.mac_credential.admin": {
    resource: "billing_mac_credential",
    action: "admin",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- hospice rate-table surface (F-210: tenant-entered CMS per-diem rates) ---
  "billing.rate_table.read": {
    resource: "billing_rate_table",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.rate_table.admin": {
    resource: "billing_rate_table",
    action: "admin",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- tenant-entered hospice visit-charge schedule (charge per 15-minute unit per discipline) ---
  "billing.visit_charge.read": {
    resource: "billing_visit_charge",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.visit_charge.admin": {
    resource: "billing_visit_charge",
    action: "admin",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- tenant-entered wage index (F-211) ---
  "billing.wage_index.read": {
    resource: "billing_wage_index",
    action: "read",
    category: "billing",
    abac: "inOrg",
  },
  "billing.wage_index.admin": {
    resource: "billing_wage_index",
    action: "admin",
    category: "billing",
    abac: "inOrg",
  },
  "billing.dde.read": {
    resource: "billing_dde",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.dde.work": {
    resource: "billing_dde",
    action: "work",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.dde.mark_submitted": {
    resource: "billing_dde",
    action: "mark_submitted",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.dde.admin": {
    resource: "billing_dde",
    action: "admin",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.clearinghouse.resolve_attempt": {
    resource: "billing_clearinghouse_attempt",
    action: "resolve",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of every §4.6 permission key M23 owns. Kept in lock-step with `@wardenx/billing` (P3 reconcile). */
export type M23PermissionKey = keyof typeof M23_CONTRIBUTED_PERMISSIONS;

/** The ordered §4.6 key list — the canonical surface the Integrate phase asserts equal to the package tuple. */
export const M23_PERMISSION_KEY_LIST: readonly M23PermissionKey[] = [
  "billing.claim.assemble",
  "billing.claim.read",
  "billing.claim.update_draft",
  "billing.claim.delete_draft",
  "billing.claim.submit",
  "billing.claim.replace",
  "billing.claim.void",
  "billing.claim.read_ar_dashboard",
  "billing.claim.read_metrics",
  "billing.noe.read",
  "billing.noe.submit",
  "billing.noe.cancel",
  "billing.notr.read",
  "billing.notr.submit",
  "billing.notr.cancel",
  "billing.validation.read_run",
  "billing.validation.run",
  "billing.validation.override",
  "billing.validation.read_override",
  "billing.rule_config.read",
  "billing.rule_config.edit",
  "billing.rule_config.platform_admin",
  "billing.eligibility.check",
  "billing.eligibility.read",
  "billing.sequestration_policy.read",
  "billing.sequestration_policy.edit",
  "billing.mac_credential.read",
  "billing.mac_credential.admin",
  "billing.rate_table.read",
  "billing.rate_table.admin",
  "billing.visit_charge.read",
  "billing.visit_charge.admin",
  "billing.wage_index.read",
  "billing.wage_index.admin",
  "billing.dde.read",
  "billing.dde.work",
  "billing.dde.mark_submitted",
  "billing.dde.admin",
];

export type M23ContributedPermissionKey = keyof typeof M23_CONTRIBUTED_PERMISSIONS;
