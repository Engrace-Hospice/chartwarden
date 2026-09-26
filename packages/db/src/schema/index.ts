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
// GAP-043 — the M2 per-membership named-approval-authority registry (`cost_report_approval` first).
export * from "./membership-elevated-approvals";
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
export * from "./outbox-consumer-receipts";
export * from "./organization-settings-registry";
export * from "./outbox-event-catalog";
// WX-PR-014 — the §4.8 BullMQ worker consumer-idempotency ledger (M30's first bindable consumer; any
// future background worker binds the same ProcessingLogPort shape over this one table).
export * from "./processing-log";
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
export * from "./messaging/alert-receipts";
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

// ── Module 39 (Consent & Authorization Management) — the consent platform (§3.3) ─────────────
// M39 owns 11 tables (M39-T02). consent_type_catalog is platform-shared (no organization_id;
// dual-grant RLS, allow-listed in check-tenancy NON_ORG_SCOPED). The four patient-bearing tables
// (consent_record, delegated_access, consent_eval_audit, consent_renewal_cycle) carry the three-
// column tenancy rule; the rest are org-scoped children of consent_record. consent_eval_audit is
// INSERT-only + monthly-partitioned (logical Drizzle def here; PARTITION BY in the T03 migration).
// RLS + grants + M4 write-audit triggers + migration 0039 land in M39-T03 (§3.4–3.7).
export * from "./consent/consent-type-catalog";
export * from "./consent/tenant-consent-type-overlay";
export * from "./consent/consent-record";
export * from "./consent/consent-record-recipient";
export * from "./consent/consent-record-dpoa-agent";
export * from "./consent/consent-revocation";
export * from "./consent/consent-expiration-reminder";
export * from "./consent/delegated-access";
export * from "./consent/consent-document-link";
export * from "./consent/consent-eval-audit";
export * from "./consent/consent-renewal-cycle";
// M6-T02 — Admission, Election & Certification tables (M6 spec §3.3). M6 owns the
// admission episode root + referral intake + the benefit-period ledger (election_period /
// election_statement / certification_of_terminal_illness / face_to_face_encounter) +
// level_of_care_period + the terminal events (revocation_event / transfer_event / discharge_event) +
// notice_of_rights_acknowledgment + compliance_window + admission_evidence. Patient/encounter-bearing tables
// (referral / admission / election_statement / face_to_face_encounter /
// notice_of_rights_acknowledgment / admission_evidence) carry the three-column tenancy rule; the rest are org-scoped via
// their admission/election_period FK. Cross-module refs (M5 patient/caregiver, M40 physician/facility/
// referral-source, M39 consent, M22 document) are plain uuid app-validated, not cross-module FKs. RLS
// + grants + M4 write-audit triggers + migration land in M6-T03 (§3.6–3.7).
export * from "./admission/referrals";
export * from "./admission/referral-activity";
export * from "./admission/referral-notes";
export * from "./admission/admissions";
export * from "./admission/election-periods";
export * from "./admission/election-statements";
export * from "./admission/certifications";
export * from "./admission/face-to-face-encounters";
export * from "./admission/level-of-care-periods";
export * from "./admission/revocation-events";
export * from "./admission/transfer-events";
export * from "./admission/discharge-events";
export * from "./admission/notice-of-rights-acknowledgments";
export * from "./admission/compliance-windows";
export * from "./admission/admission-evidence";

// ── Module 7 (Care Plan / IPOC) — the interdisciplinary plan of care (§3.3) ──────────────────
// M7 owns 6 tables (M7-T02): the care_plan root + the immutable care_plan_version snapshot ledger +
// care_plan_signature (the D5 quorum) + the problem/goal/intervention authoring spine. All six are
// patient/admission-scoped clinical records → the three-column tenancy rule (organization_id +
// provider_entity_id + location_id all NOT NULL, denormalized from the admission at bootstrap so
// IDG/overdue reporting runs location-/PE-scoped without joining M5/M6). Cross-module refs (M5 patient,
// M6 admission, M14 idg_meeting, M39 consent, M11 order) are plain uuid app-validated, NOT cross-module
// FKs; actor refs go to M1 `membership`. RLS + grants + M4 write-audit triggers + migration 0029 land
// in M7-T02 (§3.4–3.6).
export * from "./care-plan/care-plans";
export * from "./care-plan/care-plan-versions";
export * from "./care-plan/care-plan-signatures";
export * from "./care-plan/problems";
export * from "./care-plan/goals";
export * from "./care-plan/interventions";
export * from "./care-plan/idg-decision-applications";

// ── Module 8 (Encounters & Visit Notes) — the documentation spine (§3.3) ─────────────────────
// M8 owns 10 tables (M8-T02): the encounter root + encounter_signature (D13 step-up signatures) +
// encounter_addendum (post-sign corrections) + encounter_care_plan_link (M7 element references) +
// cosignature_request (the D3 cosign workflow) + vitals + mileage + the HearthNote pipeline trio
// (hearthnote_selection / hearthnote_assembled_output / hearthnote_llm_modification). All ten are
// patient-level, location-anchored clinical events → the three-column tenancy rule (organization_id +
// provider_entity_id + location_id all NOT NULL, denormalized from the M17 visit / M6 admission context
// so location-scoped ABAC, M33 multi-CCN reporting, and the M23 Q-code derivation run without joining
// M5/M6). Cross-module refs (M5 patient, M6 admission/face_to_face, M17 visit, M18 evv_event,
// M38 code_system_version, M16 bereavement_plan, M22 document, M7 problem/goal/intervention) are plain
// uuid app-validated, NOT cross-module FKs; actor refs go to M1 `membership`. Destruction (§3.6, M4 D9)
// crypto-erases the `*_cipher` columns and structurally redacts via the existing `clinical_record`
// eraser (wired in M8-T12). RLS + grants + M4 write-audit triggers + migration 0031 land in M8-T03.
export * from "./encounter/encounters";
export * from "./encounter/encounter-addenda";
export * from "./encounter/encounter-signatures";
export * from "./encounter/encounter-care-plan-links";
export * from "./encounter/cosignature-requests";
export * from "./encounter/vitals";
export * from "./encounter/mileage";
export * from "./encounter/hearthnote-selections";
export * from "./encounter/hearthnote-assembled-outputs";
export * from "./encounter/hearthnote-llm-modifications";

// ── Module 9 (Clinical Assessments Suite) — the validated-scale spine (§3.3) ──────────────────
// M9 owns 5 tables (M9-T02): the shared `clinical_assessment` base table (one row per measurement
// across all 14 scales, the per-scale shape in the `data` jsonb, the score server-computed — D1/D6) +
// assessment_cosignature (the §7.4 LPN cosignature) + significant_change_event (the §2.4 D2 detector
// output) + scale_license (the D3 proprietary-scale gating) + scale_policy (the D2 tenant-tightened
// thresholds/cadence). The three patient-level tables (clinical_assessment / assessment_cosignature /
// significant_change_event) carry the three-column tenancy rule (organization_id + provider_entity_id +
// location_id all NOT NULL, denormalized from the admission); scale_license / scale_policy are org-level
// licensing/policy config → organization_id only (the ARCH-011 org-level carve-out). Cross-module refs
// (M5 patient, M6 admission, M8 source_encounter, M39 acting_consent) are plain uuid app-validated, NOT
// cross-module FKs; actor refs go to M1 `membership`. `clinical_assessment` is PARTITION BY RANGE
// (captured_at) monthly (D11) — converted from the logical Drizzle shape in the RLS migration alongside
// the DEFERRABLE self-FK + the correction-supersede trigger. RLS + grants + M4 write-audit triggers +
// the partition conversion land in migration 0033 (M9-T02, §3.4/§3.5/§3.6).
export * from "./assessment/clinical-assessments";
export * from "./assessment/assessment-cosignatures";
export * from "./assessment/significant-change-events";
export * from "./assessment/scale-licenses";
export * from "./assessment/scale-policies";

// ── Module 10 (HOPE Engine) — the CMS HOPE timepoint + iQIES submission spine (§3.3) ─────────
// M10 owns 11 tables: the existing HOPE workflow infrastructure (timepoint schedule, partitioned
// hope_assessment aggregate root, SFV, validation findings, submissions/items) plus the Phase 1A
// versioned CMS specification reference tables and canonical item answer table. The spec tables are
// platform reference, while hope_assessment_answer is org-scoped and links to hope_assessment by logical
// UUID because the parent is partitioned with a composite PK.
export * from "./hope/hope-timepoint-schedules";
export * from "./hope/hope-spec-versions";
export * from "./hope/hope-spec-items";
export * from "./hope/hope-spec-item-isc";
export * from "./hope/hope-spec-item-options";
export * from "./hope/hope-assessments";
export * from "./hope/hope-assessment-answers";
export * from "./hope/symptom-follow-up-visits";
export * from "./hope/hope-validation-findings";
export * from "./hope/hope-submissions";
export * from "./hope/hope-submission-items";
export * from "./hope/hope-submission-result-events";

// ---------------------------------------------------------------------------
// Module 11 — Orders (M11-T02)
// ---------------------------------------------------------------------------
// M11 owns 7 tables (M11-T02): the `order_record` root for all eight §2.1 non-medication order kinds +
// order_signature (the §2.5 D4 polymorphic signature/cosignature ledger, target_kind = order |
// medication_order) + verbal_order (the §2.3 D3 verbal-order receipt + 48h timer) + standing_order /
// standing_order_instance (the §2.4 D5 cadence template + its spawn history) + order_discontinuation (the
// clinician/cascade discontinuation ledger) + order_verbal_policy (the per-org §2.3 verbal-window config).
// All 7 carry the three-column tenancy rule (organization_id + provider_entity_id + location_id all
// NOT NULL, denormalized from the admission so location/PE access checks + Q-code/claim attribution run
// without joining M6, §3.3 tenancy note). Cross-module refs (M5 patient, M6 admission, M8 source_encounter,
// M9 triggering_assessment, M10 triggering_hope_assessment, M14 idg_decision, M40 ordering physician) are
// plain uuid app-validated, NOT cross-module FKs (M11 dependsOn [6,36,38,40]); the polymorphic target_id
// (order_signature / verbal_order) and the partition-aware order_record_id (standing_order_instance /
// order_discontinuation) carry NO SQL FK; the only intra-module FK is standing_order_id; actor refs go to
// M1 `membership`. `order_record` is PARTITION BY RANGE (created_at) monthly — converted from the logical
// Drizzle shape in the RLS migration alongside the §3.4 state-transition triggers (replace-supersede /
// verbal-set-pending / signature-apply / lab-initial-states). RLS + grants + M4 write-audit triggers + the
// partition conversion land in migration 0037 (M11-T02, §3.3/§3.4/§3.6/§3.8).
export * from "./orders/standing-orders";
export * from "./orders/order-records";
export * from "./orders/order-signatures";
export * from "./orders/verbal-orders";
export * from "./orders/standing-order-instances";
export * from "./orders/order-discontinuations";
export * from "./orders/order-verbal-policies";
export * from "./orders/order-idg-decision-applications";

// ---------------------------------------------------------------------------
// Module 12 — DoseSpot Integration (M12-T02)
// ---------------------------------------------------------------------------
// M12 owns 6 tables (M12-T02): the `medication_order` root for every DoseSpot-prescribed medication (the
// §2.2 D2 draft→…→active→completed/discontinued lifecycle + the orthogonal §4.10 DoseSpot send-state; all
// clinician free-text lives inside the per-class TypeBox `data`, so the whole column is denylisted, §7.6) +
// medication_order_transmission (the §4.10 audit-anchor for every adapter call, D8 idempotency) +
// refill_request (the §2.7 D9 pharmacy refill inbox) + dosespot_webhook_event (the §7.4 D7 DEK-encrypted
// inbound webhook receipt) + dosespot_prescriber (the per-tenant roster backing the §4.7 ABAC predicates +
// §1311.115 IAL2/EPCS gates) + epcs_signing_attempt (the §1311.205 records-of-application, behind the OFF
// `dosespot.epcs` flag). The two PHI-bearing tables (medication_order / refill_request) carry the
// three-column tenancy rule (organization_id + provider_entity_id + location_id NOT NULL, denormalized from
// the admission/source order). Cross-module refs (M5 patient, M6 admission, M40 prescribing physician /
// pharmacy MDM, M38 RxNorm/NDC codes) are plain uuid/text app-validated, NOT cross-module FKs (M12 dependsOn
// [5,11,38,40]); medication_order is partitioned, so every reference TO it (transmission / refill /
// epcs_signing_attempt / self-ref replaces) carries NO single-column SQL FK; actor refs go to M1 `membership`.
// `medication_order` is PARTITION BY RANGE (created_at) monthly — converted from the logical Drizzle shape in
// the RLS migration. RLS + grants + M4 write-audit triggers + the partition conversion land in the RLS
// migration (M12-T02, §3.3/§3.5/§7.6).
export * from "./dosespot/medication-orders";
export * from "./dosespot/medication-order-transmissions";
export * from "./dosespot/refill-requests";
export * from "./dosespot/dosespot-webhook-events";
export * from "./dosespot/dosespot-prescribers";
export * from "./dosespot/epcs-signing-attempts";
export * from "./dosespot/medication-order-idg-decision-applications";

// ---------------------------------------------------------------------------
// M13 owns 12 tables (M13-T02): the central `administration_record` (one row per recorded medication
// administration — the §2.1 six modes via the discriminated `mode` + per-mode TypeBox `data`; the §2.2 D6
// committed→{pending_caregiver_review}→superseded/voided lifecycle; free-text in denylisted top-level columns
// AND nested `data` json-paths, §3.6 D12) + scheduled_dose (the §2.3 D2 materialized slots from M12's
// sigStructured) + prn_administration (the §2.4 D3 PRN wrapper + effectiveness-reassessment M9 reads) +
// missed_dose (the §2.5 D4 lapsed-slot pairing) + administration_witness (the §2.6 D7 controlled-substance
// double-witness + §7.4 token digest) + comfort_kit_deployment / comfort_kit_drawdown (the §2.7 D5 kit
// lifecycle + replenishment events to M21) + medication_reconciliation_worksheet / _decision (the §2.8 D17
// admission/transfer/discharge/recert reconciliation) + barcode_scan_event (BCMA five-rights capture) +
// administration_offline_queue (the §2.10 D18 server-side idempotency ledger) + administration_policy
// (per-tenant grace/reassessment/state-override config). The six patient-bearing tables (administration_record /
// scheduled_dose / prn_administration / missed_dose / comfort_kit_deployment / medication_reconciliation_worksheet)
// carry the three-column tenancy rule (organization_id + provider_entity_id + location_id NOT NULL, denormalized
// from the admission); the other six are org-scoped via their parent. Cross-module refs (M5 patient, M6 admission,
// M12 medication_order — resolved through the seam, NEVER imported — M8 encounter, M9 assessment, M21 supply, M22
// document) are plain uuid app-validated, NOT cross-module FKs (M13 dependsOn [12,36,38]); `administration_record`
// is PARTITION BY RANGE (administered_at) monthly, so every reference TO it carries NO single-column SQL FK and the
// offline (device_id, local_id) idempotency is enforced at the app layer (PG cannot enforce cross-partition unique
// without the partition key). The partition conversion + RLS + grants + M4 write-audit triggers land in the RLS
// migration (M13-T02, §3.3/§3.5/§3.6).
export * from "./emar/administration-records";
export * from "./emar/scheduled-doses";
export * from "./emar/prn-administrations";
export * from "./emar/missed-doses";
export * from "./emar/administration-witnesses";
export * from "./emar/comfort-kit-deployments";
export * from "./emar/comfort-kit-drawdowns";
export * from "./emar/medication-reconciliation-worksheets";
export * from "./emar/medication-reconciliation-decisions";
export * from "./emar/barcode-scan-events";
export * from "./emar/administration-offline-queue";
export * from "./emar/administration-policy";

// ---------------------------------------------------------------------------
// Module 14 — Interdisciplinary Group / IDG (M14-T02)
// ---------------------------------------------------------------------------
// M14 owns 9 tables (M14-T02): idg_recurring_policy (the §2.2/§2.3 per-location cadence template) +
// idg_meeting (the §2.2 meeting-occurrence lifecycle + frozen quorum snapshot) + idg_attendance (the §2.7
// per-attendee participation backing the quorate_decision ABAC) + idg_agenda_item (the §2.7 ordered agenda)
// + idg_decision (the §2.6 D4 canonical-payload decision ledger + open→emitted→superseded) + idg_action_item
// (the D8 follow-up task lifecycle + downstream-artifact auto-close) + idg_minutes / idg_minutes_amendment
// (the D10 immutable-on-final minutes + W-MIN-01 amendment ledger) + idg_patient_packet (the §2.4 D1 frozen
// pre-meeting packet + the M14-F01/ADR-0018 D2 per-patient 15-day review anchor column). The four patient-
// bearing tables (idg_agenda_item / idg_decision / idg_action_item carry a nullable patient_id → nullable
// three-column tenancy; idg_patient_packet carries patient_id + admission_id NOT NULL → provider_entity_id +
// location_id NOT NULL); the other five are org/location-scoped. Cross-module refs (M5 patient, M6 admission,
// M22 document, and the polymorphic linked_artifact) are plain uuid app-validated, NOT cross-module FKs (M14
// dependsOn [7,8,36]); actor refs go to M1 `membership` as plain uuid; only the tenancy spine + intra-module
// parents carry FKs. `idg_patient_packet` is PARTITION BY RANGE (built_at) monthly (D12) — converted from the
// logical Drizzle shape in the RLS migration, so its "one packet per meeting+patient" rule is a plain index +
// app-enforced. RLS + grants + M4 write-audit triggers + the partition conversion land in the RLS migration
// (M14-T02, §3.3/§3.4).
export * from "./idg/idg-recurring-policies";
export * from "./idg/idg-meetings";
export * from "./idg/idg-attendance";
export * from "./idg/idg-agenda-items";
export * from "./idg/idg-decisions";
export * from "./idg/idg-action-items";
export * from "./idg/idg-minutes";
export * from "./idg/idg-minutes-amendments";
export * from "./idg/idg-patient-packets";

// ---------------------------------------------------------------------------
// M17 owns 8 tables (M17-T02, §3.3; membership_credential added post-launch, GAP-093): visit (the §2.2.1 D3 eight-state scheduling aggregate + EVV-bracket
// flag + route-optimizer cache) + visit_state_history (the D3 append-only transition ledger, written in the
// same tx as each transition) + recurring_visit (the §2.2.3 D4 RRULE-subset cadence policy, source of truth
// for materialized child visits) + visit_proposal (the §2.2.4 D5 scheduler inbox, idempotent per source
// event) + clinician_availability (the D7 positive-declaration weekly pattern) + time_off (the D7 negative-
// overlay PTO workflow) + route_segment (the D10 optimized day-route legs; mileage is a proposal — M8 owns
// billable). M17 is the Location-scoped module (M17-F01, BLOCKER): every table carries the three tenancy
// columns — provider_entity_id + location_id NOT NULL on the patient-scoped tables (visit / recurring_visit /
// visit_proposal), nullable on the clinician/route-scoped ones (visit_state_history / clinician_availability /
// time_off / route_segment). Cross-module refs (M5 patient / patient_address, M6 admission, M8 encounter, M40
// facility, M18 evv_event, M31 telehealth) are plain uuid app-validated (M17 dependsOn [5,8,40]); actor/
// assignment refs go to M1 `membership` as SQL FKs; only the tenancy spine + membership carry FKs. `visit`
// is PARTITION BY RANGE (service_date) and `visit_state_history` PARTITION BY RANGE (transitioned_at), both
// monthly (D14) — converted from the logical Drizzle shape in the RLS migration, so refs TO `visit` are
// plain uuid (no SQL FK). The D6 visit-overlap + D7 PTO-overlap GiST EXCLUDE backstops also land in that SQL
// migration. RLS + grants + M4 write-audit triggers land in M17-T02 (§3.3/§3.5/§3.6).
export * from "./scheduling/visits";
export * from "./scheduling/visit-state-history";
export * from "./scheduling/recurring-visits";
export * from "./scheduling/visit-proposals";
export * from "./scheduling/clinician-availability";
export * from "./scheduling/time-off";
export * from "./scheduling/route-segments";
// M17 owns an 8th table added post-launch (GAP-093, §1.1 D8): membership_credential — the clinical-
// license/certification roster the `clinician_credentials_active` pre-schedule gate reads. STAFF-scoped
// (organization_id + membership_id only, no patient/PE/location reference — the volunteer_compliance_gate
// precedent for the same reason). RLS + grants + M4 audit trigger land in migration 0191.
export * from "./scheduling/membership-credentials";

// ---------------------------------------------------------------------------
// M18 owns 6 tables (M18-T02, §3.3): evv_event (the §2.2.1 D2 append-only discrete check-in/check-out ledger
// — one row per capture; the visit-level bracket state is M17's domain, derived from these) + evv_geofence_
// evaluation (the D3 per-event geofence calculation record) + evv_geofence_policy (the D3 three-layer policy:
// platform floor → tenant default → per-address override) + evv_device (the D8 per-clinician device-
// registration lifecycle) + evv_missing_resolution (the D6 missing-EVV resolution machine — documented_missing
// is never a Medicare claim gate, ADR-0008) + evv_aggregator_submission (the D7 per-state aggregator submission
// machine). Only evv_event is PHI-bearing by the three-column rule (it carries patient_id) → it gets
// provider_entity_id + location_id NOT NULL; the other five are org-scoped (joinable to PHI only via
// visit_id/evv_event_id) or tenant-config (geofence_policy) / membership-scoped (device). evv_event is
// PARTITION BY RANGE (event_at) monthly (D12, `evv_record` 7-year retention) — the Drizzle shape is logical
// (composite PK incl. the partition key); the PARTITION BY + the per-LEAF partial-UNIQUE backstops (active-
// pair D2 / offline-idempotency D5, which omit the partition key and so cannot live on the parent) + the
// append-only immutability trigger (§3.2 Phase C) land in the RLS migration (0047). Cross-module refs (M5
// patient / patient_address, M17 visit, M8 encounter, M2 device_attestation / step_up_session) are plain uuid
// app-validated (M18 dependsOn [17]); only the tenancy spine + membership carry SQL FKs. RLS + grants + M4
// write-audit triggers (GPS coords + free-text reasons denylisted, §3.6) land in M18-T02 (0047).
export * from "./evv/evv-event";
export * from "./evv/evv-geofence-evaluation";
export * from "./evv/evv-geofence-policy";
export * from "./evv/evv-device";
export * from "./evv/evv-missing-resolution";
export * from "./evv/evv-aggregator-submission";
export * from "./evv/evv-visit-registrations";
// M22 Document Management (M22-T02, §3.3): 17 tables. `document` + `intake_upload_batch` are PHI-bearing by
// the three-column rule (they carry patient_id → provider_entity_id + location_id present, nullable as the
// org-level-entity carve-out); the rest are org-scoped (joining to PHI via document/batch) except
// `form_template` + `form_template_version`, which are platform-shared catalog (NO organization_id BY DESIGN,
// NON_ORG_SCOPED, dual-grant RLS — M38/M40 precedent). `document_access_log` / `form_fill` / `extraction_job`
// / `extraction_candidate` are PARTITION BY RANGE monthly — the Drizzle shape here is logical (composite PK
// incl. the partition key); the PARTITION BY + monthly children land in the RLS migration (0049). Cross-module
// refs (M5 patient, M6 admission, owning-module aggregates) are plain uuid app-validated (M22 dependsOn [1,5]);
// only the org spine + intra-M22 parents carry SQL FKs. RLS + grants + M4 write-audit triggers (cipher /
// free-text PHI columns denylisted, §3.6) land in M22-T02 (0049).
export * from "./documents/index";
// M34 SaaS Tenant Platform (M34 spec §3.3 / §10.1 / §13). M34 owns 16 tables. Six carry
// organization_id from day one and get standard app.org_id RLS: tenant_account (1:1 with
// organization) plus the two DSAR job+event pairs and the two tenant-export job+event pairs
// (dsar_export_job(_event) / tenant_export_job(_event)). The other ten are FK-join-scoped or
// platform/operational and carry NO organization_id in this phase (sit on the check-tenancy
// NON_ORG_SCOPED allowlist): tenant_account_status_event, tenant_key_ring,
// tenant_key_destruction_log, support_consent_grant, support_session, support_session_event and
// platform_tenant_baa_record are FK-join-scoped (tenancy via their tenant_account/support_session
// parent — F02 adds organization_id later); onboarding_task_template, onboarding_task,
// tenant_signup_intent and tenant_signup_token are platform/operational (org-less). RLS + grants +
// the M4 write-audit triggers + the key-ring SECURITY DEFINER functions land in migrations
// 0051–0055; this barrel is schema only.
export * from "./saas/index";
// M33 Reporting (M33 spec §3.3). M33 owns 12 tables. THREE are PLATFORM-global catalogs with NO
// organization_id (retention class `platform`, immutable except by migration → on the check-tenancy
// NON_ORG_SCOPED allowlist): report_base_catalog, report_metric_catalog, materialized_view_metadata.
// The other nine are org-scoped and carry organization_id (report_run's is NULLABLE — cross-tenant
// platform-wide refreshes carry no org). Three are PARTITION BY RANGE monthly — the Drizzle shape
// here is logical (composite PK incl. the partition key); the PARTITION BY + monthly children land in
// the M33 RLS migration: report_schedule_run (scheduled_for), report_run (started_at) and the insert-
// only, destruction-blocked report_drilldown_audit (accessed_at, retention class `compliance`).
// dashboard_tile_cache is transient/non-partitioned. The `report_mv.*` materialized views are raw
// CREATE MATERIALIZED VIEW SQL in the migration (invisible to ownership/orphan checks), not Drizzle
// tables. Cross-module refs (M2 membership, M22 document) are plain uuid app-validated; only intra-M33
// FKs (mv_key / base_key / definition / view / schedule chains) carry SQL FKs. RLS + grants + the M4
// write-audit triggers (report_drilldown_audit.query_filters_cipher denylisted, §3.6) land in the M33
// RLS migration; this barrel is schema only.
export * from "./reporting/index";
// M30 HQRP & Quality (M30 spec §3.3). M30 owns 18 tables across three subdomains: measures (5),
// compliance-program (9), safety-surveillance (4). EVERY table carries organization_id NOT NULL and
// gets standard app.org_id RLS (M34-F02 / ADR-0010 canonical posture) — NONE are on the check-tenancy
// NON_ORG_SCOPED allowlist. Four are monthly-partitioned (cahps_decedent_sample, incident_report,
// mortality_review, infection_surveillance_event) — the Drizzle shape is logical (composite PK incl.
// the partition key); PARTITION BY + RLS + grants + M4 write-audit triggers land in the M30 migrations.
// incident_report + infection_surveillance_event carry a bare patient_id (PHI), so per ARCH-011 they
// also carry provider_entity_id + location_id (location_id added beyond §3.3's column list — the
// three-column rule wins over the spec proposal). risk_register_view is a materialized view (not an
// owned base table) defined in the migration.
export * from "./quality/index";
// M27 Cost Report (M27 spec §3.3, D22). M27 owns 14 tables (the cost_report root + worksheet/snapshot/
// validation cluster + bad-debt/statistics/imports/mapping/submission/compliance-window). EVERY table
// carries organization_id and gets standard app.org_id RLS (ADR-0010 canonical posture) EXCEPT
// cost_report_validation_rule whose organization_id is NULLABLE (platform-default rows) — it is on the
// check-tenancy NON_ORG_SCOPED allowlist with a platform-OR-org RLS policy. NONE are partitioned (M27 is
// low row-count). No PHI (D18) — aggregate financial/statistical only. Tables/enums/FKs/indexes land in
// migration 0069; RLS + grants in 0070; the M4 write-audit triggers (raw_payload_cipher /
// materialized_inputs / worksheet_snapshot denylisted, §3.6) in 0071.
export * from "./cost-report/index";

// M23 Billing (Medicare): 17 owned tables (§3.3) — claim/claim_line/claim_state_history/
// claim_submission/claim_acknowledgment/noe_record/notr_record/hipps_calculation/sia_calculation/
// validation_rule_config/validation_run/validation_result/validation_override/sequestration_policy/
// wage_index_factor/mac_submitter_credential/eligibility_check. Every table is org-scoped
// (organization_id NOT NULL) EXCEPT wage_index_factor, which is PLATFORM-SHARED (no organization_id,
// D12) and lives on the check-tenancy NON_ORG_SCOPED allowlist (SELECT-only USING(true) for app_user,
// loader-only writes). No PHI/MBI is ever stored or audit-captured (D13, §3.6, §8.7). Tables/enums in
// migrations 0074–0076; RLS/grants 0077; platform wage-index 0078; M4 write-audit triggers 0079; seed 0080.
export * from "./billing/index";

// M25 Remittance & Denials: 11 owned tables (§3.3) — remittance_advice/remittance_line/
// remittance_service_line/remittance_adjustment/remittance_remark (the four-level X12 5010 835 posting
// hierarchy) + denial_case/denial_case_assignment/denial_taxonomy_overlay (the denial worklist) +
// appeal_case/appeal_case_event (the five-tier Medicare appeal hierarchy) + patient_responsibility_ledger.
// EVERY table is org-scoped (organization_id NOT NULL) → canonical app.org_id RLS; denial_taxonomy_overlay
// is strictly org-scoped (M25-F09 — NO platform-default NULL-org rows; platform CARC/RARC live in M38).
// remittance_line/service_line/adjustment/remark are MONTHLY PARTITION BY RANGE(received_at) (D11) — DDL in
// SQL only. No MBI/PHI is audit-captured (D13); free_text/override_payload/narrative columns are denylisted
// (§3.6). Enums are m25_-prefixed. Enums + non-partitioned tables migration 0081; partitioned lines 0082;
// RLS/grants 0083; M4 write-audit + appeal closed-row immutability triggers 0084.
export * from "./remittance/index";

// M26 Cap Management: 12 owned tables (§3.3) — cap_period_platform_constant (PLATFORM-shared, no org
// column, NON_ORG_SCOPED allowlist, read-all USING(true)) + cap_period/cap_period_methodology_lock (the
// per-tenant cap-year lifecycle) + cap_beneficiary_accrual(+_line) / cap_inpatient_accrual(+_day_line)
// (the accrual ledger; the two line tables PARTITION BY LIST(cap_period_id)) + cap_projection_snapshot
// (append-only, LIST(cap_period_id)-partitioned) + cap_threshold_event (the band-transition queue) +
// cap_psr_import/cap_psr_reconciliation (PS&R) + cap_settlement (one-per-period year-close worksheet).
// All 11 tenant tables are org-scoped (organization_id NOT NULL → canonical app.org_id RLS). Money is
// BIGINT cents; no MBI/PHI is audit-captured (D13). Enums are m26_-prefixed. Enums + platform constant
// migration 0085; non-partitioned tenant tables 0086; the three LIST(cap_period_id)-partitioned tables
// 0087; tenant RLS/grants 0088; platform-constant RLS (isolated) 0089; M4 write-audit 0090; seed 0091.
export * from "./cap/index";

// M24 Billing — Medicaid: 14 owned tables (§3.3) — medicaid_claim (PE-partitioned root) + medicaid_claim_line
// (PE-partitioned) + medicaid_claim_line_encounter (join) + medicaid_claim_state_history (org-partitioned log)
// + medicaid_submission/medicaid_acknowledgment (per-attempt + 999/277CA acks) + medicaid_validation_run/
// _result (org-partitioned) /_override/_rule_config + medicaid_eligibility_check (30-day cache) + rb_arrangement
// (R&B contract; no-overlap EXCLUDE) + rb_day (org-partitioned billing day) + state_medicaid_trading_partner_
// credential (per-PE per-state per-channel creds). All 14 org-scoped (organization_id NOT NULL → canonical
// app.org_id RLS, single org-only policy per ADR-0010 D3; PE narrowing is M3 ABAC). Enums are m24_-prefixed;
// per-CCN tenancy spine (ARCH-011). Recipient ID never stored/audited (D12/§3.6). Money is INTEGER cents.
// Enums migration 0092; non-partitioned tables 0093; PE-partitioned 0094; org-partitioned 0095; RLS/grants
// 0096; M4 write-audit + service-date-within-claim trigger 0097.
export * from "./medicaid-billing/index";

// M15 Discipline Care Plans: 11 owned tables (§3.3) — discipline_care_plan (the one-per-(admission, kind)
// ROOT for the four CoP discipline plans) + discipline_care_plan_version/_signature (the §2.2.2 M7-verbatim
// version chain, snapshot sealed at in_review, §3.5 D11 required-signer quorum) + discipline_goal/
// discipline_intervention/discipline_assessment (the authored content; goals hang off M7 problems by
// LOGICAL uuid) + aide_supervisory_visit (the 418.76(h) 14-day RN attestation ledger) + volunteer_assignment
// + volunteer_compliance_gate (the 418.78(b)/(d) per-volunteer postures M17's deny-stub is waiting on) +
// volunteer_hour_ledger/_entry (the 418.78(e) 5% ratio NUMERATOR; the denominator is M27's cost basis, read
// through a seam, never stored). All 11 org-scoped (organization_id NOT NULL → canonical app.org_id RLS);
// the eight patient-bearing tables also carry provider_entity_id + location_id NOT NULL (M15-F05) so the
// §4.3 compliance seams roll up per PE/location without joining through M5/M6. NOTHING is partitioned
// (M15-F06 / ADR-0022 D1.1 — the partial unique indexes win over a partition key at trivial volumes).
// Tables + enums migration 0098; RLS/grants + M4 write-audit (incl. the nested `data`/`state_snapshot`
// jsonb re-scrub) 0099.
export * from "./discipline-plans/index";

// M16 Bereavement: 9 owned tables (§3.3) — the D1 tripartite shape (bereavement_plan, the one-per-
// death-discharged-admission ROOT carrying the single 13-month CoP 418.64(d) clock → bereaved_contact, one
// row per SURVIVOR because the obligation runs to each person → bereavement_contact_log, the leaf where one
// outreach fans out to many addressees) plus bereavement_risk_score (the append-only, UPDATE-refusing D3/D17
// rubric ledger), bereavement_outreach (the D4 death-anchored schedule), bereavement_anniversary_reminder
// (the lookahead worker's idempotency ledger), bereavement_plan_closure (D7's why-it-ended record with the
// early-close cosign + 40-char CHECKs) and bereavement_opt_out (D9 level two). The ninth,
// tenant_bereavement_external_source_gate_override, is org-level CONFIG — D18's tighten-only surface, whose
// shape (no "disable" column) IS the enforcement that tenants may not loosen the medical-director cosign.
// All 9 org-scoped (organization_id NOT NULL → canonical app.org_id RLS); the eight patient-bearing tables
// also carry provider_entity_id NOT NULL + location_id for the §4.6 compliance rollups. ONLY
// bereavement_contact_log is partitioned (D12 / §3.6, monthly RANGE by contact_at). Enums + unpartitioned
// tables migration 0100; the partitioned contact log 0101; RLS/grants + M4 write-audit (incl. the nested
// risk_factors_jsonb re-scrub) + risk-score immutability 0102.
export * from "./bereavement/index";

// M21 Supplies, DME & Comfort Kits: 11 owned tables (§3.1) in three layers — CATALOG (supply_item, the
// platform-shared HCPCS SKU catalog with no organization_id at all + tenant_supply_item_extension for the
// tenant's own non-billable items; comfort_kit_template + _medication, D3's four-medication platform floor
// on the same floor-plus-overlay shape; vendor_routing_rule, D4's deterministic routing ladder with no
// fallback chain; par_stock, D5's per-Location shelf posture with derived — never stored — severity),
// REQUEST (supply_request, D1's ONE shared row across dme | supply | comfort_kit_deploy |
// comfort_kit_replenish with the per-kind payload in a TypeBox-validated `data` jsonb), and KIT CUSTODY
// (comfort_kit_dispatch → comfort_kit_dispatched_content, the DEA 21 CFR §1304 outbound perpetual log with
// controlled-only lot/expiration → comfort_kit_return, the §2.6 chain-of-custody machine with the
// witness-distinctness CHECK → comfort_kit_returned_content, where the single discrepancy formula
// `dispatched − returned − disposed_at_home` closes the count and flags controlled lines at 5%). Nine
// tables are org-scoped on canonical app.org_id RLS; comfort_kit_template/_medication and
// vendor_routing_rule carry organization_id NULLABLE paired with a platform discriminator + CHECK pair so a
// tenant reads the floor and can never write it; supply_item is genuinely org-less (NON_ORG_SCOPED,
// dual-grant RLS, M1 baseline audit trigger — the M22 form_template posture). Exactly two tables are
// partitioned, on different keys: supply_request monthly by created_at (migration 0104) and
// comfort_kit_dispatch monthly by dispatched_at (0105). Enums + the nine unpartitioned tables 0103;
// RLS/grants + M4 write-audit + the discrepancy and expiration-floor triggers 0106.
export * from "./supplies/index";

// M19 On-Call Triage: 10 owned tables (§3.3) in four layers — CONFIG (tenant_oncall_policy, D3/D7's
// per-(org, PE) model + tier ladder + callback SLA + the two default-OFF AI gates, now carrying the §2.7
// D-D `emergency_contact_e164` the degraded path names; external_triage_vendor, D13/ADR-0026's BAA-gated
// binding to a vendor whose canonical entity is M40's and for which M19 mints NO tokens), ROSTER
// (on_call_shift — the CoP 418.100(c)(2) proof that a nurse was reachable at 2 a.m., with D7's
// policy_snapshot pinned at open and an actor-integrity CHECK making membership and vendor mutually
// exclusive), CATALOG (triage_protocol + triage_protocol_question, D4's platform-floor-plus-tenant-overlay
// where D5's server-evaluated red_flag_match predicates and D7's mandatory-escalation tiers live), and
// CALL (triage_call, D6's nine-state after-hours clinical record with D10's source-outbox dedupe and the
// M19-F08 paper-origin pair; the append-only triage_call_answer ledger with one original answer per
// question and corrections by append; triage_escalation, D7's ladder where three of four trigger kinds are
// server-written; triage_call_state_history, whose transition GAP is how §2.7 detects an outage window;
// and triage_paper_reentry_worklist, the 72-hour BCP list — the tenth table §12/§13 predate). Eight tables
// are org-scoped NOT NULL on canonical app.org_id RLS; triage_protocol/_question carry organization_id
// NULLABLE on the platform-floor row only, paired with the is_system_locked discriminator + a CHECK pair
// in both directions. The four call tables also carry provider_entity_id NOT NULL + location_id nullable
// (the three-column rule the §3.3 block omits). NOTHING is partitioned — §10/§12 ask for monthly
// partitions on the three call tables, but a partition key in a UNIQUE index would destroy both the D10
// redelivery guard and the one-original-answer-per-question rule, and forbid the children's real FKs
// (full reasoning in oncall/triage-calls.ts). Enums land in M19-T01; the ten tables migration 0107;
// RLS/grants + the ten M4 write-audit triggers + the §2.3 forward-transition guard 0108.
export * from "./oncall/index";

// M20 Field Safety: 13 owned tables (§3.3) in five layers — POLICY (safety_policy + safety_policy_version,
// §2.2.4/D4's per-tenant posture with the tighten-only bands as CHECKs and the overdue ladder ordered, every
// other row pinning the version it was written under), OBLIGATION+ATTESTATION (safety_check_in_schedule, what
// the 30-second overdue detector scans, keyed M20-F04 on (visit_id, kind, expected_at) so a 2-hour visit can
// carry several mid-visit rows; safety_check_in, the clinician's own statement, coordinates OFF by default
// per D11 and the three coordinate columns moving together), SOS (safety_sos_alert — the press, never
// deduplicated per §2.6, with `emergency_terminus` IN the SLA-watchdog index because M20-F05/S13 makes it an
// OPEN state that re-escalates until acknowledged; safety_sos_location_stream, self-limiting by the D6/§8.7
// 4-hour sunset and the §3.7 resolve+90d delete; safety_sos_alert_state_history), INCIDENT+ACT
// (safety_incident with D9's OSHA sign-off pair enforced at the DB, safety_incident_state_history, and
// safety_acknowledgment whose exactly-one-target CHECK runs in both directions so the discriminator cannot
// disagree with the FK it names), and CONFIG (safety_supervisor_subscription — the paging layer, whose active
// -pair unique index is NULLS NOT DISTINCT or three-of-four nullable columns make the rule vacuous;
// safety_high_risk_area, advisory jsonb polygon rings with NO PostGIS per M20-F07 and organization_id NOT
// NULL per M20-F03; safety_emergency_contact_consent, the clinician's own three separately-revocable
// purposes). All thirteen are org-scoped NOT NULL on canonical app.org_id RLS and there is NO org-NULL row
// anywhere in the module; eight also carry provider_entity_id NOT NULL + location_id nullable (the
// three-column rule the §3.3 block omits). NOTHING is partitioned. Enums + the thirteen tables land in
// migration 0110; RLS/grants + the thirteen M4 write-audit triggers + the §2.3 active-SOS guard on the
// location stream in 0111.
export * from "./safety/index";

// M32 AI Platform: 13 owned tables (§3.2) in three tenancy layers. SIX are PLATFORM-SHARED with no
// organization_id at all — ai_capability (the governance registry), ai_capability_lifecycle_event (the
// append-only D2 approval ledger), ai_capability_calibration (per-(capability, backend) thresholds +
// the drift baseline), ai_model_backend (the version-pinned model registry whose two CHECKs make "no
// cloud route without a BAA and ZDR" and "no local route without a license and an artifact" DB facts),
// ai_prompt_template (the D18 prohibited-zone key; the prompt TEXT stays in version control and the row
// pins its SHA-256) and ai_evaluation_run — all listed in check-tenancy.ts's NON_ORG_SCOPED set, read-all
// within any tenant, writes via wardenx_admin. SIX are tenant-scoped on canonical app.org_id RLS:
// ai_tenant_opt_in_record (where the row's EXISTENCE is not consent — the STATUS is, defaulting to
// opted_out), ai_clinician_opt_out (membership-keyed, one LIVE refusal per capability), ai_invocation,
// ai_token_ledger, ai_hallucination_report and ai_routing_override. ONE is mixed —
// ai_kill_switch_state, organization_id NULLABLE with NULL meaning a platform-wide kill, split by
// COMMAND so a tenant reads the platform row and can never write one.
//
// ai_invocation and ai_token_ledger are PARTITIONED MONTHLY (invoked_at / accrued_at) with composite
// PKs declared in SQL. ai_invocation is the §164.528 disclosure ledger — a refused call is a RECORDED
// row, because only a written row proves that no PHI left the platform — and §3.7's eraser therefore
// SHREDS THE DEK rather than deleting it. ai_invocation + ai_hallucination_report additionally carry
// provider_entity_id NOT NULL + location_id (ARCH-011's three-column rule, which §3.2 omits). Enums land
// in M32-T01; tables in migrations 0113–0115; RLS/grants + the thirteen M4 write-audit triggers + the
// §3.5 immutability triggers in 0116.
export * from "./ai-platform/index";
// Module 28 (FHIR Gateway) — the eight §3.3 owned tables. Seven tenant-scoped (canonical app.org_id RLS)
// + the platform-shared `fhir_capability_snapshot` (read-all, writes via wardenx_admin). Two are
// partitioned monthly (`fhir_client_session` on issued_at, `fhir_inbound_resource` on proposed_at) with
// composite PKs declared in SQL. Enums land in M28-T01; tables in migrations 0134–0136; RLS/grants + the
// M4 write-audit triggers in 0137.
export * from "./fhir/index";

// M31 Patient/Family Portal & Telehealth: 3 owned tables (§3.3, ADR-0005 — the manifest is authoritative
// over the spec §2 15-entity ERD, which proposes a wider model that never materializes as M31 tables).
// portal_account is D2's account root (one per org × M2 user × relationship) — NOT patient-scoped, since
// per-patient reach is a separate portal_access_grant, so it carries organization_id but no PE/location;
// its display-name/email/phone ciphers are envelope-encrypted + §3.6 audit-denylisted. portal_access_grant
// is D5/D6/D7's per-patient authorization (the resolved scope_set_jsonb + M39 consent provenance);
// telehealth_visit is D8/D14's video-visit root, unique per M17 visit, whose encounter M8 attaches on
// visit_ended. Both patient-bearing tables carry provider_entity_id NOT NULL + location_id (ARCH-011's
// three-column rule, which the spec §3.3 sketch omits) and RLS keys on canonical app.org_id ALONE. None
// are partitioned. Enums + the three tables 0138; RLS/grants + the three M4 write-audit triggers (D11
// §3.6 denylists) 0139.
export * from "./portal/index";

// M35 Subscription Billing (Stripe): 21 owned tables (§3.3). Twelve tenant-scoped (canonical app.org_id
// RLS) — subscription/_state_history, payment_method, invoice/_line, usage_event (monthly-PARTITIONED by
// recorded_at, composite PK in SQL), usage_period_aggregate, patient/user_active_period (pseudonymized —
// no raw patient/membership id), dunning_state, promo_code_application, refund. Nine platform-shared /
// platform-only (NON_ORG_SCOPED) — plan/_meter + promo_code (read-all catalog), revenue_recognition_snapshot
// (cross-tenant aggregate), patient_pseudonym_key (M35-private HMAC keys, full audit exclusion — no trigger),
// stripe_webhook_event/_api_call_audit (may span tenants), platform_retained_invoice/_line (M35-F06 7-year
// invoice retention, copy-then-delete on offboarding). NONE are PHI-bearing by the tenancy heuristic. Enums
// in enums.ts (M35-T02); tables 0140–0142; RLS/grants + M4 write-audit triggers 0143.
export * from "./subscription-billing/index";

// Module 29 (External Interfaces) — the eleven owned tables (§3.3). Nine tenant-scoped on canonical
// app.org_id RLS + the two platform-shared NPPES directory tables (read-all, writes via wardenx_admin).
// Five are partitioned monthly (hl7_message_inbound/lab_observation/lab_observation_value on received_at,
// hl7_message_outbound on queued_at, hl7_inbound_proposal on proposed_at) with composite PKs in SQL; RLS +
// M4 write-audit triggers in migration 0148. Enums in ./external-interfaces/enums.
export * from "./external-interfaces/index";

// M37 Inpatient Unit (IPU) Management: 26 owned tables (§3.3), all TENANT-SCOPED (canonical app.org_id
// RLS). Four are MONTHLY-PARTITIONED — ipu_admission_state_history / ipu_bed_cleaning_event / ipu_visitor
// / ipu_meal_service. Fully outbox-decoupled (D17): no cross-module schema FKs either direction; the
// daily ipu_census_snapshot feeds M23/M26/M27 via outbox, and the ipu_iv_safety_overlay closes the M13
// IV-pump overlay deferral. Enums in enums.ts; tables + RLS/grants + M4 triggers in migrations 0149–0153.
export * from "./ipu/index";
