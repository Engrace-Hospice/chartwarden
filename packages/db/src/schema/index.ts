// @wardenx/db — Drizzle schema BARREL (M1-owned, the central multi-tenant PostgreSQL
// schema surface). Each module adds its `ownedTables` here as it lands in Phase 1;
// check-table-ownership.ts / check-tenancy.ts / check-ddl-legality.ts enforce the
// moment a table appears. drizzle-kit reads this barrel (drizzle.config.ts) to
// generate migrations.
//
// M1-T01 — tenancy spine: organization -> provider_entity -> location (+ shared enums).
export * from "../enums";
export * from "./organizations";
export * from "./provider-entities";
export * from "./locations";
// M1-T02 — identity base tables (Better Auth–compatible): user, membership, session,
// account, verification. user/account/verification/session are cross-org
// (NON_ORG_SCOPED); membership is org-scoped (three-column rule applies).
export * from "./users";
export * from "./memberships";
export * from "./sessions";
export * from "./accounts";
export * from "./verifications";
// M1-T03 — audit + platform tables. audit_event (partitioned), system_status,
// feature_flag (+ feature_flag_evaluation), idempotency_key, outbox_event, and the
// two platform-shared registries (organization_settings_registry, outbox_event_catalog).
// audit_event/outbox_event/idempotency_key are HELPER-ONLY (written via packages/audit
// + packages/shared middleware, never by feature modules).
export * from "./audit-events";
export * from "./system-status";
export * from "./feature-flags";
export * from "./idempotency-keys";
export * from "./outbox-events";
export * from "./organization-settings-registry";
export * from "./outbox-event-catalog";
// M2-T02 — Identity & Org tables (M2 spec §3.3–3.7). two_factor + passkey are user-owned
// auth credentials (NON_ORG_SCOPED, user-ownership RLS); organization_invitation +
// tenant_step_up_policy_override are org-scoped (app.org_id RLS + audit trigger).
// M2-T03 (M2 spec §3.6) extends the M1-owned `session` table in place (./sessions) with
// the session_class enum + class/scope/engagement/screen-lock/step-up additionalFields.
export * from "./two-factor";
export * from "./passkeys";
export * from "./organization-invitations";
export * from "./tenant-step-up-policy-overrides";
// M3-T02 — Authorization roles & joins (M3 spec §3.3–3.4). `permission` is the read-only
// platform-global mirror of the code catalog (NON_ORG_SCOPED). `role` carries a nullable
// organization_id (NULL = platform template). `role_permission` + `membership_role` are the
// grant joins; both get hand-reviewed RLS in M3-T04 (role_permission bespoke, membership_role
// standard app.org_id).
export * from "./permissions";
export * from "./roles";
export * from "./role-permissions";
export * from "./membership-roles";
// M3-T03 — Break-glass & auditor engagements (M3 spec §3.5). Both org-scoped on
// organization_id (standard app.org_id RLS in M3-T04); neither is a PHI table (they carry
// only target *references*), so the PE/location columns do not apply. break_glass_event is
// the emergency-access record (§7.4); auditor_engagement is the time-bound, scoped read
// window for external auditors (§7.5).
export * from "./break-glass";
export * from "./auditor-engagements";
// M4-T04 — Audit lifecycle / integrity / catalog tables (M4 spec §3.5). legal_hold,
// destruction_certificate, audit_export are org-scoped (standard app.org_id RLS lands in
// M4-T05); audit_seal is the Phase-2 tamper-evidence chain (nullable org). state_retention_override,
// audit_denylist_catalog, audit_action_catalog are platform-shared reference (NON_ORG_SCOPED per the
// check-tenancy allowlist). None are PHI tables, so the PE/location columns do not apply.
export * from "./legal-holds";
export * from "./destruction-certificates";
export * from "./state-retention-overrides";
export * from "./audit-exports";
export * from "./audit-seals";
export * from "./audit-denylist-catalog";
export * from "./audit-action-catalog";
