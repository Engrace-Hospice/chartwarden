// @wardenx/db — Module 35 (Subscription Billing) schema barrel: the twenty-one `ownedTables`
// `architecture/module-manifest.ts` gives M35 (§3.3).
//
// TENANT-SCOPED (twelve) — organization_id NOT NULL, RLS keyed ONLY on canonical app.org_id (§3.5):
//   subscription · subscription_state_history · payment_method · invoice · invoice_line ·
//   usage_event · usage_period_aggregate · patient_active_period · user_active_period ·
//   dunning_state · promo_code_application · refund
// `usage_event` is MONTHLY-PARTITIONED by recorded_at (composite PK declared in SQL, 0142); its audit
// trigger is a GENERATED function that hard-codes the parent name (the M32 `ai_token_ledger` lesson).
//
// PLATFORM-SHARED / PLATFORM-ONLY (nine) — no tenant RLS org column, listed in check-tenancy's
// NON_ORG_SCOPED set (§3.5):
//   plan · plan_meter · promo_code            — read-all catalog, platform-only write
//   revenue_recognition_snapshot              — platform-only cross-tenant aggregate
//   patient_pseudonym_key                     — M35-private HMAC key catalog (full audit exclusion)
//   stripe_webhook_event · stripe_api_call_audit — Stripe ledgers that may span tenants
//   platform_retained_invoice · platform_retained_invoice_line — 7-year invoice retention (M35-F06)
//
// NONE OF THE M35 TABLES IS PHI-BEARING BY THE TENANCY GATE'S HEURISTIC: patient/user activity is stored
// only as a 32-hex HMAC pseudonym (W-SB-08), never a raw patient_id. Enums land in `packages/db/src/enums.ts`
// (M35-T02); tables in migrations 0140–0142; RLS/grants + the M4 write-audit triggers in 0143.
export * from "./dunning-state";
export * from "./invoice";
export * from "./invoice-line";
export * from "./patient-active-period";
export * from "./patient-pseudonym-key";
export * from "./payment-method";
export * from "./plan";
export * from "./plan-meter";
export * from "./platform-retained-invoice";
export * from "./platform-retained-invoice-line";
export * from "./promo-code";
export * from "./promo-code-application";
export * from "./refund";
export * from "./revenue-recognition-snapshot";
export * from "./stripe-api-call-audit";
export * from "./stripe-webhook-event";
export * from "./subscription";
export * from "./subscription-state-history";
export * from "./usage-event";
export * from "./usage-period-aggregate";
export * from "./user-active-period";
