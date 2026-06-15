// @wardenx/db — Drizzle enums (M1 Foundation §3.2). The shared pgEnum type surface
// that the tenancy-spine and identity tables build on. Defined exactly once here
// (check-ddl-legality.ts bans duplicate pgEnum definitions, ADR-0022 D1.3).
import { pgEnum } from "drizzle-orm/pg-core";

export const organizationStatus = pgEnum("organization_status", [
  "created",
  "active",
  "suspended",
  "closed",
]);

export const providerEntityStatus = pgEnum("provider_entity_status", [
  "created",
  "active",
  "suspended",
  "closed",
]);

export const locationStatus = pgEnum("location_status", [
  "created",
  "active",
  "suspended",
  "closed",
]);

export const userStatus = pgEnum("user_status", ["created", "active", "suspended", "deactivated"]);

export const membershipStatus = pgEnum("membership_status", [
  "pending",
  "active",
  "suspended",
  "revoked",
]);

export const auditActorKind = pgEnum("audit_actor_kind", [
  "user",
  "system",
  "integration",
  "external_collaborator",
]);

export const auditOutcome = pgEnum("audit_outcome", ["success", "failure", "denied"]);

export const auditSeverity = pgEnum("audit_severity", ["info", "warn", "critical"]);

export const auditRetentionClass = pgEnum("audit_retention_class", [
  "operational", // 1 year
  "compliance", // 7 years default (HIPAA floor 6 — §164.316(b)(2); standardized to 7, ADR-0004 / M4 D1)
  "legal_hold", // indefinite
]);

export const systemStatusValue = pgEnum("system_status_value", [
  "operational",
  "degraded",
  "outage",
]);

export const featureFlagValueType = pgEnum("feature_flag_value_type", [
  "bool",
  "string",
  "number",
  "json",
]);

export const featureFlagKind = pgEnum("feature_flag_kind", [
  "product", // long-lived behavior toggle
  "rollout", // percentage-based gradual rollout
  "kill_switch", // emergency disable; default-off; bypass cache
  "migration", // temporary; tied to deployment; auto-expires
]);

export const outboxEventStatus = pgEnum("outbox_event_status", [
  "pending",
  "dispatching",
  "dispatched",
  "failed",
]);

// --- Module 2 (Identity & Org) enums (M2-T02; M2 spec §3.2) ---------------------
// Defined here (the single shared enum surface) per ADR-0022 D1.3 / check-ddl-legality.ts:
// one pgEnum per name.
//
// `session_class` (M2-T03; M2 spec §2.2.4, §3.2) drives a session's timeout policy,
// scope, and allowed operations. The session table is M1-owned and shared by all four
// classes; M2 extends it via Better Auth additionalFields (M2 spec §3.6).
export const sessionClass = pgEnum("session_class", [
  "staff", // password/passkey + org chosen at login; scoped to one organization
  "auditor", // magic-link + 2FA within an engagement window; read-only, no concurrency
  "external_collaborator", // one-time 30-min magic-link; scoped to one patient
  "funeral_home", // magic-link issued at/after death; scoped to one deceased patient
]);

export const invitationStatus = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "expired",
  "revoked",
]);

export const twoFactorMethod = pgEnum("two_factor_method", [
  "totp",
  "sms", // accessibility fallback; never carries PHI
]);

export const stepUpFactor = pgEnum("step_up_factor", ["webauthn", "totp", "sms"]);

// --- Module 3 (Authorization) enums (M3-T01; M3 spec §3.2) ----------------------
// Defined here (the single shared enum surface) per ADR-0022 D1.3 / check-ddl-legality.ts:
// one pgEnum per name. These back the role/break-glass/engagement tables that land in
// M3-T02/M3-T03; the catalog (code-owned, packages/auth/src/permissions) ships in M3-T01.
//
// `role_category` — the twelve role categories A–L (M3 spec §3.2, Appendix A).
export const roleCategory = pgEnum("role_category", [
  "clinical_staff", // A
  "clinical_leadership", // B
  "operations", // C
  "admin_executive", // D
  "billing_finance", // E
  "compliance_quality", // F
  "volunteer", // G
  "patient_family", // H
  "external_auditor", // I
  "external_collaborator", // J
  "platform_staff", // K
  "temporary_special", // L
]);

// `scope_level` — how broadly a role grants (org-wide down to a single patient).
export const scopeLevel = pgEnum("scope_level", [
  "organization",
  "provider_entity",
  "location",
  "patient",
]);

// `break_glass_status` — emergency-access lifecycle (M3 spec §2.3.2).
export const breakGlassStatus = pgEnum("break_glass_status", [
  "active",
  "cosign_pending",
  "expired",
  "revoked",
  "denied",
]);

// `engagement_status` — auditor-engagement lifecycle (M3 spec §2.3.3).
export const engagementStatus = pgEnum("engagement_status", [
  "scheduled",
  "active",
  "closed",
  "cancelled",
]);

// `engagement_type` — the kind of external audit an engagement represents.
export const engagementType = pgEnum("engagement_type", [
  "cms_survey",
  "state_survey",
  "tpe_probe",
  "upic_investigation",
  "cost_report_field_audit",
  "financial_audit",
  "accreditation",
  "other",
]);

// --- Module 4 (Audit & Compliance Log) enums (M4-T01; M4 spec §3.2) --------------
// Defined here (the single shared enum surface) per ADR-0022 D1.3 / check-ddl-legality.ts:
// one pgEnum per name. These back the lifecycle/integrity/catalog tables that land in
// M4-T04 and the PHI-denylist categories the trigger generator consumes (M4-T02/§5).
//
// NOTE: `audit_retention_class` (above, M1) gains its fourth value `compliance_42cfr_part2`
// via migration 0035 with the Part 2 eraser semantics (M4-T05/§3.7.1, M4-T08/§6) — it is
// intentionally NOT widened here, where no migration backs the change yet.

// `legal_hold_status` — legal-hold lifecycle (§2.4.3): a hold is active until released.
export const legalHoldStatus = pgEnum("legal_hold_status", ["active", "released"]);

// `destruction_status` — destruction-certificate state machine (§2.4.2). `partial_refused`
// (M04-F08) is required by the §6 eraser / W-M4-09: Part 2 rows refuse erasure while the
// patient is alive or within 6 years post-death.
export const destructionStatus = pgEnum("destruction_status", [
  "pending",
  "approved",
  "held",
  "executed",
  "partial_refused",
]);

// `audit_export_format` — compliance-export file formats (§3.5 audit_export).
export const auditExportFormat = pgEnum("audit_export_format", ["csv", "ndjson", "pdf"]);

// `phi_denylist_category` — the three named high-sensitivity column categories the write-audit
// trigger generator scrubs to a change-marker (§2.3, §5; M4 D10). The trigger generator (M4-T02)
// and the audit_denylist_catalog table (M4-T04) consume these.
export const phiDenylistCategory = pgEnum("phi_denylist_category", [
  "pii_high_sensitivity",
  "sud_value",
  "narrative_free_text",
]);
