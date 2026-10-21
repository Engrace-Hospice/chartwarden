// @chartwarden/saas-tenant-platform · repositories barrel (M34 §3.3–§3.9).
//
// Seven Drizzle data ports over the seventeen M34-owned tables. Each repo is a thin reader/writer that
// takes the Drizzle client (or a `withOrgContext` transaction handle) in its constructor and issues plain
// Drizzle queries; the lifecycle/onboarding/shred/support/export SERVICES (next phase) wrap each call in
// `withOrgContext` (org-scoped) or `withPlatformContext` (platform-ops cross-tenant) so RLS scopes every
// statement — keeping tenant-scoping in one home. The org-less Phase-3 signup_intent/signup_token surface
// (§3.9) is platform-private (`withPlatformContext`); the public self-serve route stays deny-default in
// Phase 1, but the SignupIntentRepository + signup-intent service exist (token issuance is real).
//
//   TenantAccountRepository  — tenant_account (+ status-event ledger + platform→first-admin invitation)
//   TenantKeyRingRepository  — tenant_key_ring (+ destruction-phase log); DEK shred is SECURITY DEFINER
//   SupportRepository        — support_consent_grant + support_session + support_session_event
//   DsarExportRepository     — dsar_export_job (+ event ledger); patient-scoped FHIR/PDF, 30-day SLA
//   TenantExportRepository   — tenant_export_job (+ event ledger); org-scoped NDJSON archive
//   BaaRegisterRepository    — platform_tenant_baa_record; platform→tenant BAA register (≠ M40)
//   OnboardingRepository     — onboarding_task_template (catalog) + onboarding_task (per-tenant rows)
//   SignupIntentRepository   — tenant_signup_intent + tenant_signup_token (org-less, pre-provision, §3.9)
export { type SaasDb, type StatusEventCursor, TenantAccountRepository } from "./tenant-account";
export { type DestructionPhase, TenantKeyRingRepository } from "./tenant-key-ring";
export { type SupportEventCursor, SupportRepository } from "./support";
export { type DsarEventCursor, DsarExportRepository } from "./dsar-export";
export { type TenantExportEventCursor, TenantExportRepository } from "./tenant-export";
export { BaaRegisterRepository } from "./baa-register";
export { OnboardingRepository } from "./onboarding";
export { SignupIntentRepository } from "./signup-intent";
