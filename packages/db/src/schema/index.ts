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
// M38-T02 — Clinical Terminology Service schema (M38 spec §3.3–3.6). M38 owns 13 tables.
// Twelve are platform-shared canonical reference (NON_ORG_SCOPED, read-all `USING(true)`,
// written only via the `terminology_loader` role per §3.7) — the catalog (code_system /
// code_system_version), the four Phase-1 per-system concept tables (icd10cm/snomed/loinc/
// rxnorm — §2.3 one-table-per-system, NOT one polymorphic concept table), value sets +
// members + the materialized expansion, deprecation_mapping, the pgvector concept_embedding
// (semantic search behind the `ai.full` flag, table-only in Phase 1), and the append-only
// terminology_update_log. The thirteenth, value_set_tenant_extension, is the only org-scoped
// table (app.org_id RLS + audit trigger land in M38-T03). RLS/grants/triggers/migration +
// the pg_trgm/vector extensions are M38-T03; this task is schema only.
export * from "./terminology/code-systems";
export * from "./terminology/code-system-versions";
export * from "./terminology/concept-icd10cm";
export * from "./terminology/concept-snomed";
export * from "./terminology/concept-loinc";
export * from "./terminology/concept-rxnorm";
export * from "./terminology/value-sets";
export * from "./terminology/value-set-members";
export * from "./terminology/value-set-expansion";
export * from "./terminology/value-set-tenant-extension";
export * from "./terminology/deprecation-mapping";
export * from "./terminology/concept-embedding";
export * from "./terminology/terminology-update-log";
// M36-T02 — Secure Messaging & Alerts schema (M36 spec §3.3–3.6, §3.11, §3.13). M36 owns 15
// tables. Most are org-scoped (channel, channel_member, message, message_receipt, alert,
// alert_rule, user_notification_preferences, tenant_alert_routing_override, notification_template,
// tenant_notification_template_overlay — standard app.org_id RLS lands in M36-T03). Five carry
// no organization_id by design and sit on the check-tenancy NON_ORG_SCOPED allowlist: presence
// + delivery_endpoint (user-owned, cross-org — like session), message_attachment +
// notification_delivery (pure children of message/alert, tenancy via the parent FK), and
// alert_payload_catalog (platform-floor reference, populated at boot from the §3.12 Foundation
// Registry). No PHI table carries the three-column PE/location rule — bodies are encrypted
// (message.body_cipher) and subjects are FK-less pointers. RLS/grants/audit triggers/migration
// are M36-T03; this task is schema only.
export * from "./messaging/channels";
export * from "./messaging/channel-members";
export * from "./messaging/messages";
export * from "./messaging/message-attachments";
export * from "./messaging/message-receipts";
export * from "./messaging/presence";
export * from "./messaging/delivery-endpoints";
export * from "./messaging/alert-rules";
export * from "./messaging/alerts";
export * from "./messaging/notification-deliveries";
export * from "./messaging/user-notification-preferences";
export * from "./messaging/alert-payload-catalog";
export * from "./messaging/tenant-alert-routing-override";
export * from "./messaging/notification-template";
export * from "./messaging/tenant-notification-template-overlay";
// M40-T02 — Master Data Management schema (M40 spec §3.3–3.5). M40 owns 11 tables. The §2.3
// canonical-vs-overlay dividing line decides org-scoping: the three CANONICAL tables
// (external_physician, facility, payer) are org-less platform master data — registry-sourced,
// the same answer for every tenant — and so are the cross-cutting workflow tables that operate
// over them (entity_relationship, merge_request) and the platform-operational NPPES sync state
// (nppes_sync_log, nppes_sync_coordination); all seven sit on the check-tenancy NON_ORG_SCOPED
// allowlist. The four ORG-SCOPED tables carry organization_id and get standard app.org_id RLS:
// external_physician_tenant_overlay (this-tenant opinion about a physician — the only Phase-1
// overlay), mdm_provisional (tenant-staged entity, §2.4.3), and the BAA pair mdm_baa_record +
// mdm_baa_required (§7.7). No table carries the three-column PE/location rule — none reference a
// patient (provider/facility/payer master data). RLS/grants (the locked two-table canonical/
// overlay pattern), the M4 write-audit triggers, and the migration are M40-T03; this task is
// schema only.
export * from "./mdm/external-physicians";
export * from "./mdm/external-physicians-overlay";
export * from "./mdm/facilities";
export * from "./mdm/payers";
export * from "./mdm/entity-relationships";
export * from "./mdm/merge-requests";
export * from "./mdm/nppes-sync-log";
export * from "./mdm/nppes-sync-coordination";
export * from "./mdm/mdm-provisional";
export * from "./mdm/mdm-baa-records";
export * from "./mdm/mdm-baa-required";

// ── Module 5 (Patient & Demographics) — the patient spine + demographics (§3.3–3.5) ──────────
// PHI-bearing tables: every one carries the three-column tenancy rule (organization_id NOT NULL +
// nullable provider_entity_id/location_id, populated at admission — M05-F04). M5-T02 ships the six
// core tables (patient + identifier/name-alias/address/phone/email); T03 adds coverage/caregiver/
// contact; T04 adds caseload/privacy/match/merge/amendment; RLS + M4 write-audit triggers (sensitive
// columns on the denylist) + the migration land in M5-T05 (§3.6–3.7).
export * from "./patient/patients";
export * from "./patient/patient-identifiers";
export * from "./patient/patient-name-aliases";
export * from "./patient/patient-addresses";
export * from "./patient/patient-phones";
export * from "./patient/patient-emails";
// T03 — coverage / caregiver / contact (§3.4).
export * from "./patient/patient-payers";
export * from "./patient/caregivers";
export * from "./patient/patient-caregivers";
export * from "./patient/emergency-contacts";
export * from "./patient/patient-communication-preferences";
// T04 — caseload / privacy / match / merge / amendment (§3.5).
export * from "./patient/patient-assignments";
export * from "./patient/patient-privacy-flag-snapshots";
export * from "./patient/patient-match-reviews";
export * from "./patient/patient-merges";
export * from "./patient/patient-amendment-requests";
