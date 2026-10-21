// @chartwarden/subscription-billing — §3.5 owned-table catalog + §3.6 M4 audit-posture hints (M35-T01).
//
// Pure metadata the later tasks consume: T02 seeds the RLS split from {@link M35_TENANT_SCOPED_TABLES} /
// {@link M35_PLATFORM_SHARED_TABLES}; the T02 `register-eraser.ts` boot step feeds {@link M35_AUDIT_POSTURES}
// to M4's `AuditDenylistRegistry` as ADVISORY input (M35-F05 / ADR-0144: M4 is the decision-maker; M35 does
// NOT own or override the trigger-suppression denylist — it only registers a requested posture per table).

import type { M35TableName } from "@chartwarden/types";

/** §3.5 tenant-scoped tables — standard M1 RLS org-isolation + platform-admin bypass. */
export const M35_TENANT_SCOPED_TABLES = [
  "subscription",
  "subscription_state_history",
  "payment_method",
  "invoice",
  "invoice_line",
  "usage_event",
  "usage_period_aggregate",
  "patient_active_period",
  "user_active_period",
  "dunning_state",
  "promo_code_application",
  "refund",
] as const satisfies readonly M35TableName[];

/** §3.5 platform-shared / platform-only tables — universal read + platform-only write, or platform-only
 *  read+write (the pseudonym key + cross-tenant Stripe/aggregate ledgers). NOT org-RLS-scoped. */
export const M35_PLATFORM_SHARED_TABLES = [
  "plan",
  "plan_meter",
  "promo_code",
  "revenue_recognition_snapshot",
  "patient_pseudonym_key",
  "stripe_webhook_event",
  "stripe_api_call_audit",
  "platform_retained_invoice",
  "platform_retained_invoice_line",
] as const satisfies readonly M35TableName[];

/** True iff the table is tenant-RLS-scoped (drives the T02 RLS policy choice + the eraser plan). */
export function isTenantScopedTable(table: M35TableName): boolean {
  return (M35_TENANT_SCOPED_TABLES as readonly M35TableName[]).includes(table);
}

/**
 * §3.6 the ADVISORY audit posture M35 requests per table (M4 applies/overrides its own policy):
 *  - `audit_writes`      — request an audit row on writes (optionally excluding high-churn/secret fields).
 *  - `full_exclusion`    — request full trigger suppression (the table IS an append-only source-of-truth
 *                          log, or is high-volume, so an M4 audit of it would be recursive or ruinous).
 *  - `partial_exclusion` — audit only when the named condition holds; otherwise suppress.
 */
export type M35AuditPosture =
  | { kind: "audit_writes"; fieldExclusionHints?: readonly string[] }
  | { kind: "full_exclusion"; reason: string }
  | { kind: "partial_exclusion"; auditWhen: string };

/** §3.6 M35's per-table advisory registrations with M4's `AuditDenylistRegistry` (boot-time). */
export const M35_AUDIT_POSTURES: { readonly [K in M35TableName]: M35AuditPosture } = {
  subscription: {
    kind: "audit_writes",
    fieldExclusionHints: ["stripe_customer_id", "stripe_subscription_id"],
  },
  subscription_state_history: {
    kind: "full_exclusion",
    reason: "it IS the transition audit trail (recursive)",
  },
  payment_method: { kind: "audit_writes", fieldExclusionHints: ["card_*", "ach_*", "sepa_*"] },
  invoice: { kind: "audit_writes", fieldExclusionHints: ["hosted_invoice_url", "invoice_pdf_url"] },
  invoice_line: { kind: "audit_writes" },
  usage_event: {
    kind: "full_exclusion",
    reason: "high-volume append-only; stripe_api_call_audit is the trail",
  },
  usage_period_aggregate: {
    kind: "partial_exclusion",
    auditWhen: "stripe_usage_record_id IS NOT NULL",
  },
  patient_active_period: {
    kind: "full_exclusion",
    reason: "append-only pseudonym rows; M35 eraser destroys",
  },
  user_active_period: {
    kind: "full_exclusion",
    reason: "append-only pseudonym rows; M35 eraser destroys",
  },
  dunning_state: { kind: "audit_writes" },
  promo_code_application: { kind: "audit_writes" },
  refund: { kind: "audit_writes", fieldExclusionHints: ["approver_step_up_audit_event_id"] },
  plan: { kind: "audit_writes" },
  plan_meter: { kind: "audit_writes" },
  promo_code: { kind: "audit_writes" },
  revenue_recognition_snapshot: {
    kind: "full_exclusion",
    reason: "append-only platform-shared aggregate",
  },
  patient_pseudonym_key: {
    kind: "full_exclusion",
    reason: "key-rotation timeline must not enter the audit log",
  },
  stripe_webhook_event: { kind: "full_exclusion", reason: "it IS the source-of-truth webhook log" },
  stripe_api_call_audit: { kind: "full_exclusion", reason: "it IS the outbound-call audit ledger" },
  platform_retained_invoice: { kind: "audit_writes" },
  platform_retained_invoice_line: { kind: "audit_writes" },
};
