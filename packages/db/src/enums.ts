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

export const userStatus = pgEnum("user_status", [
  "created",
  "active",
  "suspended",
  "deactivated",
]);

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
