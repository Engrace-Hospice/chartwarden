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

// --- Module 38 (Clinical Terminology Service) enums (M38-T01/T02; M38 spec §3.2) ---
// Defined here (the single shared enum surface) per ADR-0022 D1.3 / check-ddl-legality.ts:
// one pgEnum per name. These back the platform-shared terminology catalog + per-system
// concept tables (M38-T02, §3.3–3.6) and mirror the type-level unions in
// packages/terminology/src/interfaces/kinds.ts (M38-T01, §2.3).
//
// `code_system_id` — the code systems M38 owns (§3.2). 'cpt' is DELIBERATELY ABSENT
// until D4 unlocks (AMA CPT license, §1.2/§1.3/§7.8): the enum itself prevents any
// row, concept table, or seam from referencing CPT prematurely.
export const codeSystemId = pgEnum("code_system_id", [
  "icd10cm",
  "icd10pcs",
  "snomed",
  "loinc",
  "rxnorm",
  "ndc",
  "hcpcs",
  "cvx",
  "revenue",
  "carc",
  "rarc",
  // 'cpt' — reserved; not in enum until D4 unlocks (§7.8).
]);

// `concept_status` — per-row concept lifecycle (§2.4.1). A `retired` row is still
// returned by an as-of lookup whose asOf <= end_date (historical-record validation).
export const conceptStatus = pgEnum("concept_status", ["active", "deprecated", "retired"]);

// `value_set_scope` — value-set scope (§3.2).
export const valueSetScope = pgEnum("value_set_scope", ["platform", "hospice", "hqrp"]);

// `deprecation_mapping_kind` — the successor relationship a deprecation carries (§2.2, §3.2).
export const deprecationMappingKind = pgEnum("deprecation_mapping_kind", [
  "equivalent",
  "broader",
  "narrower",
  "none",
  "see_other",
]);

// `version_load_status` — code-system version lifecycle (§2.4.2, §3.2).
export const versionLoadStatus = pgEnum("version_load_status", [
  "loading",
  "staged",
  "active",
  "superseded",
  "failed",
]);

// `terminology_update_action` — append-only terminology_update_log action (§3.2, §3.6).
export const terminologyUpdateAction = pgEnum("terminology_update_action", [
  "loaded",
  "deprecated",
  "expanded",
  "embedded",
  "tenant_extension_added",
  "tenant_extension_removed",
]);

// --- Module 36 (Secure Messaging & Alerts) enums (M36-T01; M36 spec §3.2) --------
// Defined here (the single shared enum surface) per ADR-0022 D1.3 / check-ddl-legality.ts:
// one pgEnum per name. These back the 15 M36 tables (channels/membership, messages,
// alerts/notifications, the payload catalog) that land in M36-T02 (§3.3–3.6, §3.11, §3.13),
// and mirror the type-level unions in packages/messaging/src/interfaces/kinds.ts (M36-T01,
// §2.3). The migration that emits the CREATE TYPEs is M36-T03 (§3.9).

// `channel_kind` — THE single discriminator that drives a channel's lifecycle,
// membership source, and retention class (§2.3). Enforced at the schema level (M36-T02)
// with a per-kind CHECK on subject_id/retention_class; kind is immutable after insert.
export const channelKind = pgEnum("channel_kind", [
  "care_team", // subject = patient_id; auto via CareTeamProvider; care_related (6+ yr)
  "discipline", // subject = org_id + discipline; auto via M2 role membership; care_related
  "location", // subject = location_id; auto via M2 default_location_ids; care_related
  "on_call", // subject = provider_entity_id; auto via OnCallProvider (M19); care_related
  "dm", // 1:1, no subject; manual; care_related (clinician DMs discuss patients)
  "announcement", // tenant-wide admin broadcast; the one operational (1 yr) channel
  "bereavement", // subject = bereavement_plan_id (M16); care_related; 13-mo display window
]);

// `channel_retention_class` — the channel's retention clock (§2.3, M36-F02 / ADR-0004).
// Only the non-clinical `announcement` channel is `operational` (1 yr); everything else is
// clinical communication (`care_related`, 6+ yr). `bereavement` carries its own class.
export const channelRetentionClass = pgEnum("channel_retention_class", [
  "operational",
  "care_related",
  "bereavement",
]);

// `channel_member_role` — a member's role within a channel (§3.3).
export const channelMemberRole = pgEnum("channel_member_role", [
  "owner",
  "member",
  "read_only",
  "portal_caregiver", // added via M39 consent for portal caregivers
]);

// `channel_member_source` — auto-synced vs manually-added membership (§2.5). `auto` rows
// (care_team/discipline/location/on_call) are owned by the sync job; manual edits need an
// audited admin override.
export const channelMemberSource = pgEnum("channel_member_source", ["auto", "manual"]);

// `message_author_kind` — a message authored by a user vs the system (§3.4).
export const messageAuthorKind = pgEnum("message_author_kind", ["user", "system"]);

// `message_body_kind` — body rendering hint (§3.4).
export const messageBodyKind = pgEnum("message_body_kind", ["plain", "markdown", "system"]);

// `message_status` — message lifecycle (§2.4.2). `deleted` is a tombstone; body_cipher is
// RETAINED until retention expiry (M36-F02 / ADR-0004 / ARCH-185), never zeroed early.
export const messageStatus = pgEnum("message_status", ["sent", "edited", "deleted"]);

// `message_receipt_status` — per-recipient receipt state (§3.4).
export const messageReceiptStatus = pgEnum("message_receipt_status", ["delivered", "read", "ack"]);

// `presence_status` — Socket.IO-driven user presence (§3.5).
export const presenceStatus = pgEnum("presence_status", ["online", "away", "offline"]);

// `alert_category` — the broad class of an alert (§3.6). `field_safety` + `critical` is the
// only combination allowed on the `voice` notification channel (§2.5 SOS-only rule).
export const alertCategory = pgEnum("alert_category", [
  "clinical_urgent",
  "clinical_routine",
  "operational",
  "field_safety",
  "administrative",
  "system",
]);

// `alert_severity` — the legacy `alert`/`alert_rule` severity ladder (§3.2). DISTINCT from the
// broader `alert_payload_severity` catalog ladder below (M36-F06b): the two are intentionally
// separate Postgres types so the migration emits two non-conflicting CREATE TYPEs.
export const alertSeverity = pgEnum("alert_severity", ["info", "warn", "critical"]);

// `alert_recipient_resolver` — the named resolver an alert_rule uses to compute recipients
// (§3.6). The registered resolver set is validated at boot (M36-T05); `system_locked` rules
// cannot have their resolver changed (§2.5).
export const alertRecipientResolver = pgEnum("alert_recipient_resolver", [
  "care_team",
  "on_call",
  "discipline",
  "role_set",
  "tenant_admins",
  "user_list",
  "broadcast",
]);

// `alert_outcome` — terminal fan-out outcome of a dispatched alert (§2.4.3).
export const alertOutcome = pgEnum("alert_outcome", ["delivered", "partial", "failed"]);

// `notification_channel` — the per-recipient delivery channels (§3.6). `in_app` is the always-
// available floor; `voice` is SOS-only (§2.5).
export const notificationChannel = pgEnum("notification_channel", [
  "in_app",
  "push",
  "sms",
  "email",
  "voice",
]);

// `notification_status` — per recipient × channel delivery state (§2.4.4).
export const notificationStatus = pgEnum("notification_status", [
  "pending",
  "sent",
  "delivered",
  "failed",
  "skipped_quiet_hours",
  "forwarded",
]);

// `delivery_endpoint_channel` — the out-of-band channels a user can register an endpoint on
// (§3.5). `in_app`/`voice` are not endpoint-registered (in-app is implicit; voice reuses sms).
export const deliveryEndpointChannel = pgEnum("delivery_endpoint_channel", [
  "push",
  "sms",
  "email",
]);

// `delivery_endpoint_verification` — endpoint verification lifecycle (§3.5).
export const deliveryEndpointVerification = pgEnum("delivery_endpoint_verification", [
  "verified",
  "pending",
  "expired",
]);

// `alert_payload_severity` — M36-F06b / ADR-0022 D1.3: the payload-catalog severity ladder is a
// DISTINCT Postgres type (NOT a second `alert_severity`). It is the platform-floor severity
// ladder for the typed alert-payload registry (§3.11); tenants may TIGHTEN via the D11 routing
// override but never loosen. The legacy `alert_severity` (above) still backs `alert`/`alert_rule`.
export const alertPayloadSeverity = pgEnum("alert_payload_severity", [
  "INFO",
  "WARN",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

// --- Module 40 (Master Data Management) enums (M40-T01; M40 spec §3.2) ------------
// Defined here (the single shared enum surface) per ADR-0022 D1.3 / check-ddl-legality.ts:
// one pgEnum per name. These back the 11 M40 tables (canonical external_physician/facility/
// payer, the external_physician_tenant_overlay, and the cross-cutting merge/provisional/baa/
// nppes-sync tables) that land in M40-T02 (§3.3–3.5), and mirror the type-level unions in
// packages/mdm/src/interfaces/kinds.ts (M40-T01, §2.3–2.4). The migration that emits the
// CREATE TYPEs is M40-T03 (§3.9). `mdm_entity_kind` carries all seven §2.3 kinds for
// forward-compatibility; Phase 1 ships canonical tables for only physician/facility/payer.

// `mdm_entity_status` — the canonical-entity lifecycle (§2.4.1). `provisional` is a
// tenant-proposed, not-yet-registry-matched row; `merged` rows carry a non-null
// `merged_into_id` (the §2.5 CHECK) and redirect transparently (§7.2).
export const mdmEntityStatus = pgEnum("mdm_entity_status", [
  "active",
  "deactivated",
  "merged",
  "provisional",
]);

// `mdm_entity_kind` — the seven real-world entity kinds MDM canonicalizes (§2.3). The
// discriminator on `entity_relationship`/`merge_request`/`mdm_provisional` that constrains
// which canonical table a row references (the §2.5 intra-kind CHECKs). Phase 1 materializes
// canonical tables for physician/facility/payer only; the other four are forward-declared.
export const mdmEntityKind = pgEnum("mdm_entity_kind", [
  "physician",
  "facility",
  "pharmacy",
  "referral_source",
  "payer",
  "dme_vendor",
  "funeral_home",
]);

// `mdm_merge_status` — the merge-request lifecycle (§2.4.2). `approved` locks
// canonical_id + duplicate_id; `executed` means the duplicate flipped to `merged` and the
// reference re-pointing job was enqueued.
export const mdmMergeStatus = pgEnum("mdm_merge_status", [
  "pending",
  "approved",
  "rejected",
  "executed",
]);

// `mdm_merge_proposer` — who proposed a merge (§2.4.2): the NPPES sync, an admin, a tenant,
// or the fuzzy-dedup job.
export const mdmMergeProposer = pgEnum("mdm_merge_proposer", [
  "nppes",
  "admin",
  "tenant",
  "fuzzy_job",
]);

// `mdm_provisional_status` — the provisional-entity lifecycle (§2.4.3). A getOrCreate with
// no identifier match writes a `pending` provisional row; enrichment/admin `promoted` it,
// dedup `merged` it, or admin `rejected` it.
export const mdmProvisionalStatus = pgEnum("mdm_provisional_status", [
  "pending",
  "promoted",
  "merged",
  "rejected",
]);

// `mdm_nppes_sync_mode` — the registry-sync cadence recorded on nppes_sync_log (§4.3): the
// nightly delta over known NPIs, a weekly full sweep, or a single-NPI on-demand lookup.
export const mdmNppesSyncMode = pgEnum("mdm_nppes_sync_mode", [
  "nightly_delta",
  "weekly_full",
  "on_demand",
]);

// `mdm_baa_status` — per-tenant BAA execution state on mdm_baa_record (§2.3 overlay / §7.7).
// The BAA gate on disclosure (M22/M28/M29) denies where a BAA is `mdm_baa_required` and the
// tenant's record is not `executed`.
export const mdmBaaStatus = pgEnum("mdm_baa_status", ["executed", "pending", "n_a"]);

// `facility_kind` — the canonical `facility` subtype (§3.3).
export const facilityKind = pgEnum("facility_kind", [
  "hospital",
  "alf",
  "snf",
  "ipu",
  "clinic",
  "other",
]);

// `payer_kind` — the canonical `payer` subtype (§3.3).
export const payerKind = pgEnum("payer_kind", [
  "medicare",
  "medicaid",
  "medicare_advantage",
  "commercial",
  "other",
]);

// ── Module 5 (Patient & Demographics) §3.2 ────────────────────────────────────────────────
// race/ethnicity/language/gender are stored as text codes against USCDI value-sets (M38), not
// enums — the value-sets are too large and update annually (§3.2).

/** `patient_status` — the patient lifecycle (§3.2). `merged` rows redirect via `merged_into_id`. */
export const patientStatus = pgEnum("patient_status", [
  "prospective",
  "active",
  "on_hold",
  "discharged",
  "deceased",
  "merged",
]);

/** `patient_address_kind` — append-only address classification (§3.2, M5 D5). */
export const patientAddressKind = pgEnum("patient_address_kind", [
  "home",
  "facility",
  "mailing",
  "temporary",
  "prior",
]);

/** `patient_identifier_kind` — the §2.2 identifier strategy. `partner_mrn` added additively (§3.8). */
export const patientIdentifierKind = pgEnum("patient_identifier_kind", [
  "mrn",
  "mbi",
  "ssn",
  "state_id",
  "prior_mrn",
  "hospice_external",
  "partner_mrn",
]);

/** `patient_payer_coverage_kind` — coverage classification on `patient_payer` (§3.2). */
export const patientPayerCoverageKind = pgEnum("patient_payer_coverage_kind", [
  "medicare_ffs",
  "medicare_advantage",
  "medicaid",
  "commercial",
  "hospice_carve_out",
  "self_pay",
]);

/** `patient_caregiver_relationship` — caregiver relationship to the patient (§3.2). */
export const patientCaregiverRelationship = pgEnum("patient_caregiver_relationship", [
  "spouse",
  "child",
  "parent",
  "sibling",
  "other_family",
  "friend",
  "guardian",
  "paid_caregiver",
]);

/** `patient_caregiver_lr_authority` — legal-representative authority a caregiver holds (§3.2). */
export const patientCaregiverLrAuthority = pgEnum("patient_caregiver_lr_authority", [
  "dpoa_healthcare",
  "guardian",
  "next_of_kin",
  "none",
]);

/** `patient_assignment_role` — the care-team role on `patient_assignment` (§3.2). */
export const patientAssignmentRole = pgEnum("patient_assignment_role", [
  "primary_rn",
  "attending_clinician",
  "case_manager_msw",
  "chaplain",
  "aide",
  "np",
  "md",
  "volunteer",
  "bereavement",
]);

/** `patient_match_review_status` — soft-duplicate review queue state (§3.2, §7.3). */
export const patientMatchReviewStatus = pgEnum("patient_match_review_status", [
  "open",
  "merged",
  "not_a_match",
  "cancelled",
]);

/** `patient_amendment_status` — §164.526 right-to-amend request state (§3.2, §7.7). */
export const patientAmendmentStatus = pgEnum("patient_amendment_status", [
  "pending",
  "accepted",
  "denied",
  "withdrawn",
]);

/** `patient_phone_kind` — phone classification on `patient_phone` (§3.2). */
export const patientPhoneKind = pgEnum("patient_phone_kind", [
  "mobile",
  "home",
  "work",
  "facility",
]);

// ── Module 39 (Consent & Authorization Management) §3.2 ───────────────────────────────────
// M39-T01. One pgEnum per §3.2 CREATE TYPE; these back the 11 M39 tables (consent_record +
// its per-recipient / per-DPOA-agent joins, revocation, reminders, renewal-cycle, delegated-
// access projection, the catalog + tenant overlay, the consent_document_link, and the monthly-
// partitioned consent_eval_audit) landing in M39-T02 (§3.3). They mirror the type-level unions
// in packages/consent/src/interfaces/kinds.ts (M39-T01). The migration emitting the CREATE
// TYPEs is M39-T03 (§3.4). Enum string values that begin with a digit (`42_cfr_part_2_release`,
// the `N_days` reminder kinds) are legal Postgres labels and TS string-literal members.

/** `consent_type_key` — the ten v1 platform-floor consent types + the post-mortem bereavement
 *  type + the tenant-extensible `custom` slot (§3.2, D2). */
export const consentTypeKey = pgEnum("consent_type_key", [
  "portal_access",
  "dpoa_healthcare",
  "dpoa_financial",
  "family_caregiver_access",
  "42_cfr_part_2_release",
  "media_release",
  "research_participation",
  "telehealth_consent",
  "advance_directive_acknowledgment",
  "hipaa_release",
  "bereavement_outreach_consent",
  "custom",
]);

/** `consent_scope_discriminator` — the typed scope shape a consent type carries (§3.2). */
export const consentScopeDiscriminator = pgEnum("consent_scope_discriminator", [
  "categorical",
  "per_recipient",
  "per_named_agent",
  "per_encounter",
]);

/** `consent_status` — the consent_record lifecycle (§2.2, §3.2). Append-only: an "edit" is a
 *  new row pointing at the prior via supersedes_consent_record_id. */
export const consentStatus = pgEnum("consent_status", [
  "draft",
  "active",
  "superseded",
  "revoked",
  "expired",
]);

/** `consent_grantor_kind` — the chain-of-authority grantor model (§3.2, D5). Non-self grantors
 *  carry an acting_consent_id FK proving authority. */
export const consentGrantorKind = pgEnum("consent_grantor_kind", [
  "patient_self",
  "dpoa_healthcare_agent",
  "dpoa_financial_agent",
  "court_guardian",
  "parent_for_minor",
  "healthcare_surrogate",
  "bereaved_person_self",
]);

/** `consent_capture_method` — how the signature evidence was captured (§3.2, D4). */
export const consentCaptureMethod = pgEnum("consent_capture_method", [
  "electronic_portal_signature",
  "typed_signature_in_app",
  "uploaded_signed_pdf",
  "witnessed_verbal_documented",
  "notarized",
]);

/** `consent_recipient_kind` — the named-recipient classes on consent_record_recipient (§3.2, D6). */
export const consentRecipientKind = pgEnum("consent_recipient_kind", [
  "external_physician",
  "facility",
  "pharmacy",
  "irb",
  "family_member",
  "attorney",
  "employer",
  "researcher",
  "free_text",
]);

/** `consent_revocation_actor_kind` — who performed an explicit revocation (§3.2, D7). */
export const consentRevocationActorKind = pgEnum("consent_revocation_actor_kind", [
  "patient_self_via_portal",
  "staff",
  "dpoa_agent",
  "court_order",
  "platform_admin_break_glass",
]);

/** `consent_revocation_cascade_status` — typed revocation-cascade progress (§3.2, D7). */
export const consentRevocationCascadeStatus = pgEnum("consent_revocation_cascade_status", [
  "pending",
  "in_progress",
  "completed",
  "partial_failed",
]);

/** `consent_reminder_kind` — the platform-floor 90/30/14/7/1-day reminder cadence (§3.2, D9). */
export const consentReminderKind = pgEnum("consent_reminder_kind", [
  "90_days",
  "30_days",
  "14_days",
  "7_days",
  "1_day",
]);

/** `consent_renewal_cycle_status` — the renewal-cycle lifecycle (§3.2, D8). */
export const consentRenewalCycleStatus = pgEnum("consent_renewal_cycle_status", [
  "open",
  "renewed",
  "closed_expired",
  "closed_revoked",
  "closed_no_longer_applicable",
]);

/** `consent_dpoa_agent_kind` — primary + alternate ordering on consent_record_dpoa_agent (§3.2, D5). */
export const consentDpoaAgentKind = pgEnum("consent_dpoa_agent_kind", [
  "primary",
  "alternate_1",
  "alternate_2",
]);

/** `consent_dpoa_activation_condition` — when DPOA authority becomes operative (§3.2, D5). */
export const consentDpoaActivationCondition = pgEnum("consent_dpoa_activation_condition", [
  "immediate",
  "upon_incapacity_attested",
  "upon_physician_determination",
  "upon_incompetence_court_order",
]);

/** `consent_dpoa_scope_kind` — the per-agent authority scope (§3.2, D5). */
export const consentDpoaScopeKind = pgEnum("consent_dpoa_scope_kind", [
  "healthcare_full",
  "healthcare_end_of_life_only",
  "financial_narrow",
  "financial_broad",
]);

/** `consent_dpoa_term_kind` — the per-agent term (§3.2, D5). */
export const consentDpoaTermKind = pgEnum("consent_dpoa_term_kind", [
  "indefinite",
  "until_date",
  "event_driven",
]);

/** `consent_delegated_access_scope` — the delegated_access projection scope tiers (§3.2, D10). */
export const consentDelegatedAccessScope = pgEnum("consent_delegated_access_scope", [
  "view_only_minimal",
  "view_only_full",
  "view_and_message",
  "view_message_and_decisions",
]);

// ── Module 6 (Admission, Election & Certification) §3.2 ───────────────────────────────────────
// The three `compliance_window_kind` external-signal values + `severity='info'` + `referral_status`
// `withdrawn` back the AdmissionEventApplier (M29 HL7 path, M6-T11); they are additive but declared
// here in full so the §3.3 tables (M6-T02) compile against the final enum (ADR-0022 D1.3: one
// pgEnum definition site, no later ALTER-then-redeclare).

/** `referral_status` — the §3.2 referral lifecycle; `withdrawn` backs the cancel-admit path (D16). */
export const referralStatus = pgEnum("referral_status", [
  "received",
  "evaluated",
  "accepted",
  "rejected",
  "withdrawn",
  "admitted",
]);

/** `referral_source_channel` — how a referral arrived (§3.2). */
export const referralSourceChannel = pgEnum("referral_source_channel", [
  "phone",
  "fax",
  "portal",
  "walk_in",
  "self_referral",
  "physician_office",
  "hospital_discharge_planner",
]);

/** `admission_status` — the §3.2 admission lifecycle (§2.3.1 state machine). */
export const admissionStatus = pgEnum("admission_status", [
  "referred",
  "pending",
  "notice_of_rights_acknowledged",
  "active",
  "on_hold",
  "discharged",
  "bereavement",
  "closed",
]);

/** `election_period_kind` — CMS benefit-period length (90/90/60/60/… §2.2). */
export const electionPeriodKind = pgEnum("election_period_kind", ["ninety_day", "sixty_day"]);

/** `election_period_status` — the §3.2 election-period lifecycle (§2.3.2). */
export const electionPeriodStatus = pgEnum("election_period_status", [
  "pending",
  "signed",
  "active",
  "completed",
]);

/** `election_period_completion_cause` — why a period ended (§3.2). */
export const electionPeriodCompletionCause = pgEnum("election_period_completion_cause", [
  "next_period",
  "revocation",
  "transfer",
  "discharge",
]);

/** `election_signer_kind` — who signed the election statement (§3.2). */
export const electionSignerKind = pgEnum("election_signer_kind", ["patient", "representative"]);

/** `election_signature_method` — how the election signature was captured (§3.2). */
export const electionSignatureMethod = pgEnum("election_signature_method", [
  "wet_ink_scanned",
  "electronic_witnessed",
]);

/** `cti_status` — the §3.2 certification-of-terminal-illness lifecycle (§2.3.3). */
export const ctiStatus = pgEnum("cti_status", [
  "drafted",
  "awaiting_hospice_md",
  "awaiting_attending",
  "signed",
  "voided",
  "superseded",
]);

/** `f2f_encounter_status` — the §3.2 face-to-face lifecycle (§2.3.4). */
export const f2fEncounterStatus = pgEnum("f2f_encounter_status", [
  "scheduled",
  "completed",
  "attested",
]);

/** `f2f_performer_role` — who may attest a recert F2F (§3.2). */
export const f2fPerformerRole = pgEnum("f2f_performer_role", ["hospice_md", "hospice_np"]);

/** `f2f_encounter_location` — where the F2F took place (§3.2). */
export const f2fEncounterLocation = pgEnum("f2f_encounter_location", [
  "patient_home",
  "alf",
  "snf",
  "ipu",
  "hospital",
  "telehealth",
]);

/** `level_of_care` — the four CMS hospice levels of care (§3.2; §2.3.5). */
export const levelOfCare = pgEnum("level_of_care", [
  "routine_home_care",
  "continuous_home_care",
  "inpatient_respite_care",
  "general_inpatient_care",
]);

/** `revocation_reason` — why a beneficiary revoked the election (§3.2). */
export const revocationReason = pgEnum("revocation_reason", [
  "seek_curative_treatment",
  "dissatisfaction",
  "transferred_out",
  "other",
]);

/** `transfer_direction` — inbound vs outbound hospice transfer (§3.2). */
export const transferDirection = pgEnum("transfer_direction", ["in", "out"]);

/** `discharge_type` — the §3.2 discharge reasons (drives §6.3 reason-specific permissions). */
export const dischargeType = pgEnum("discharge_type", [
  "death",
  "revocation",
  "transfer",
  "no_longer_terminal",
  "moved_out_of_service_area",
  "for_cause",
]);

/** `nor_acknowledgment_method` — how the Notice of Rights was acknowledged (§3.2). */
export const norAcknowledgmentMethod = pgEnum("nor_acknowledgment_method", [
  "wet_ink_scanned",
  "electronic_witnessed",
  "verbal_with_witness",
]);

/** `compliance_window_kind` — every tracked compliance window (§3.2). The last three values back the
 * external-signal windows the `AdmissionEventApplier` opens (§2.2 note; D15). */
export const complianceWindowKind = pgEnum("compliance_window_kind", [
  "initial_assessment_48h",
  "comprehensive_assessment_5d",
  "care_plan_5d",
  "f2f_recert_30d_prior",
  "recert_due_14d",
  "recert_due_7d",
  "cti_signature_lookahead_14d",
  "notice_of_rights",
  "concurrent_hospital_admission",
  "external_discharge_notice",
  "hl7_admission_cancellation",
]);

/** `compliance_window_status` — the §3.2 window lifecycle (open→closing_soon→overdue→closed). */
export const complianceWindowStatus = pgEnum("compliance_window_status", [
  "open",
  "closing_soon",
  "overdue",
  "closed",
]);

/** `compliance_window_severity` — `info` backs the external-signal windows (D15). */
export const complianceWindowSeverity = pgEnum("compliance_window_severity", [
  "warning",
  "alert",
  "info",
]);

// ── Module 7 (Care Plan / IPOC) §3.2 ──────────────────────────────────────────────────────────
// All 11 enums declared in full here (one pgEnum definition site, no later ALTER-then-redeclare;
// ADR-0022 D1.3) so the §3.3 tables (M7-T02) compile against the final enum. The hybrid versioning
// model (§2.2) keys off `care_plan_version_status` (draft→in_review→signed→superseded) and
// `care_plan_version_kind` (initial/idg_review/interim_revision/discharge).

/** `care_plan_status` — the §3.2 care-plan root lifecycle (§2.2.1 state machine). */
export const carePlanStatus = pgEnum("care_plan_status", ["draft", "active", "discharged"]);

/** `care_plan_version_status` — the §3.2 per-version lifecycle (§2.2.2 state machine). */
export const carePlanVersionStatus = pgEnum("care_plan_version_status", [
  "draft",
  "in_review",
  "signed",
  "superseded",
]);

/** `care_plan_version_kind` — why a version was opened (§3.2). */
export const carePlanVersionKind = pgEnum("care_plan_version_kind", [
  "initial",
  "idg_review",
  "interim_revision",
  "discharge",
]);

/** `problem_kind` — terminal/related/unrelated (drives M23 claim ICD-10 sequencing; §3.2). */
export const problemKind = pgEnum("problem_kind", ["terminal", "related", "unrelated"]);

/** `problem_source` — provenance of a care-plan problem (§3.2). */
export const problemSource = pgEnum("problem_source", [
  "clinical",
  "patient_reported",
  "family_reported",
  "history",
  "intake_extraction",
]);

/** `problem_status` — the §3.2 problem lifecycle (§2.2.3). */
export const problemStatus = pgEnum("problem_status", ["active", "resolved", "inactive"]);

/** `goal_source` — patient/family/agent-stated goals preserve `original_text` verbatim (D6; §3.2). */
export const goalSource = pgEnum("goal_source", [
  "clinical",
  "patient_stated",
  "family_stated",
  "agent_stated",
]);

/** `goal_status` — the §3.2 goal lifecycle (§2.2.3). */
export const goalStatus = pgEnum("goal_status", [
  "not_started",
  "in_progress",
  "met",
  "not_met",
  "revised",
  "discontinued",
]);

/** `intervention_status` — the §3.2 intervention lifecycle (§2.2.3). */
export const interventionStatus = pgEnum("intervention_status", [
  "active",
  "discontinued",
  "completed",
]);

/** `intervention_discipline` — the discipline that owns a care-plan intervention (§3.2). */
export const interventionDiscipline = pgEnum("intervention_discipline", [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "md_np",
  "pt",
  "ot",
  "st",
  "volunteer",
  "music_therapy",
  "dietitian",
  "bereavement",
]);

/** `care_plan_signer_role` — the role under which a `care_plan_signature` is captured (§3.2). */
export const carePlanSignerRole = pgEnum("care_plan_signer_role", [
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
]);

// ── Module 8 — Encounters & Visit Notes (§3.2). 13 versioned enums driving the encounter lifecycle,
// the HearthNote three-layer pipeline, the cosignature/late-entry workflows, and the EVV bracket. New
// values require a manifest edit + a vocabulary update (§2.2). Tables + RLS land in M8-T02/T03. ─────

/** `encounter_type` — the 14 §2.2 visit types that drive the template engine + compliance gate. */
export const encounterType = pgEnum("encounter_type", [
  "routine_visit",
  "admission_visit",
  "recert_visit",
  "face_to_face",
  "telephonic",
  "lpn_visit",
  "chha_visit",
  "msw_assessment",
  "msw_followup",
  "chaplain_assessment",
  "chaplain_visit",
  "volunteer_visit",
  "bereavement_contact",
  "idg_followup",
]);

/** `encounter_discipline` — the §2.2 authoring/signing discipline (mirrors the M2/M3 catalog). */
export const encounterDiscipline = pgEnum("encounter_discipline", [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "volunteer",
  "md",
  "np",
]);

/** `encounter_status` — the §2.3 encounter lifecycle state machine. */
export const encounterStatus = pgEnum("encounter_status", [
  "draft",
  "finalized",
  "signed",
  "cosign_pending",
  "cosigned",
  "voided",
]);

/** `late_entry_tier` — the §2.5 D4 late-entry tier reified at finalize-time. */
export const lateEntryTier = pgEnum("late_entry_tier", [
  "normal",
  "late_entry",
  "significant_late_entry",
  "administrative_override",
]);

/** `signature_kind` — which signature slot an `encounter_signature` row fills (§3.3). */
export const signatureKind = pgEnum("signature_kind", ["primary", "cosignature", "addendum"]);

/** `signature_method` — the step-up method used to authenticate a sign (§3.3 / D13). */
export const signatureMethod = pgEnum("signature_method", [
  "passkey",
  "biometric",
  "password_plus_otp",
]);

/** `cosignature_status` — the §2.4 D3 cosignature-request lifecycle. */
export const cosignatureStatus = pgEnum("cosignature_status", [
  "pending",
  "routed",
  "acknowledged",
  "escalated",
  "hard_cap_reached",
  "supervisor_released",
  "signed",
]);

/** `vital_unit` — the unit a vitals measurement is captured in (§3.3 `vitals`). */
export const vitalUnit = pgEnum("vital_unit", [
  "mmHg",
  "bpm",
  "breaths_per_min",
  "c",
  "f",
  "percent_o2",
  "kg",
  "lb",
  "cm",
  "in",
  "mg_dl",
  "mmol_l",
]);

/** `pain_scale` — the validated pain instrument used for a vitals row (§3.3 `vitals`). */
export const painScale = pgEnum("pain_scale", ["nrs_0_10", "flacc", "painad", "verbal_descriptor"]);

/** `evv_bracket_state` — whether EVV check-in/out bracketed the visit or the gap is documented (§2.7 D9). */
export const evvBracketState = pgEnum("evv_bracket_state", [
  "evv_present",
  "evv_missing_documented",
]);

/** `layer2_eligibility_reason` — why the HearthNote Layer-2 LLM path is (in)eligible (§2.6 / M08-F01 /
 * ADR-0012 D4: the cloud path stays INELIGIBLE until M32's BAA+ZDR gate passes). */
export const layer2EligibilityReason = pgEnum("layer2_eligibility_reason", [
  "eligible",
  "tenant_flag_off",
  "clinician_opted_out",
  "encounter_type_excluded",
  "token_budget_exceeded",
  "baa_not_executed",
  "routing_preference_blocks_cloud",
  "kill_switch_active",
]);

/** `layer2_passage_decision` — a clinician's per-passage decision on a Layer-2 modification (§2.6). */
export const layer2PassageDecision = pgEnum("layer2_passage_decision", [
  "accept",
  "edit",
  "reject",
]);

/** `assembled_output_kind` — whether an assembled-output row is a primary or addendum finalize (§3.3). */
export const assembledOutputKind = pgEnum("assembled_output_kind", [
  "primary_finalize",
  "addendum_finalize",
]);

// ── Module 9 (Clinical Assessments Suite) §3.2 ────────────────────────────────────────────────
// The 14-scale shared-base `clinical_assessment` table keys on `scale_type`; per-scale `data` shape +
// scoring live in `packages/assessments/src/scales/<scale>/` (D1). Enum values mirror the leaf type
// surface in `@wardenx/types` (`assessment.ts`); the §3.3 tables (M9-T02) compile against the final
// enum set (ADR-0022 D1.3: one pgEnum definition site, no later ALTER-then-redeclare).

/** `scale_type` — the 14 §1.1 validated instruments a `clinical_assessment` row may carry (D1). */
export const scaleType = pgEnum("scale_type", [
  "pps",
  "kps",
  "fast",
  "painad",
  "flacc",
  "esas_r",
  "nyha",
  "meld",
  "bode",
  "flacker",
  "gds",
  "braden",
  "morse",
  "aims",
]);

/** `assessment_status` — the §2.2.1 lifecycle: a correction supersedes its target (append-only, D9). */
export const assessmentStatus = pgEnum("assessment_status", ["active", "superseded"]);

/** `assessment_acting_as` — whether the reporter is the patient or an attributed representative (DPOA). */
export const assessmentActingAs = pgEnum("assessment_acting_as", ["self", "patient_representative"]);

/** `significant_change_rule_id` — the §2.4 threshold-crossing rules the detector evaluates (D2). */
export const significantChangeRuleId = pgEnum("significant_change_rule_id", [
  "pps_drop_20_in_14d",
  "kps_drop_20_in_14d",
  "esas_total_increase_20_in_7d",
  "esas_symptom_ge_7",
  "painad_ge_4",
  "nyha_class_iv",
  "braden_le_12",
  "morse_ge_51",
  "meld_ge_30",
  "fast_progression_30d",
  "gds_progression_30d",
  "flacker_increase",
  "aims_emergent_dyskinesia",
]);

/** `significant_change_status` — the §2.2.2 ack lifecycle for a detected change (open → ack/escalated). */
export const significantChangeStatus = pgEnum("significant_change_status", [
  "open",
  "acknowledged",
  "escalated",
]);

/** `scale_license_status` — the §2.2.3 per-tenant licensure state for a proprietary scale (D3). */
export const scaleLicenseStatus = pgEnum("scale_license_status", [
  "active",
  "pending_renewal",
  "expired",
]);

// ── Module 10 (HOPE Engine) §3.2 ──────────────────────────────────────────────────────────────
// The shared `hope_assessment` row keys on `rfa_kind` and carries a per-section TypeBox-typed `data`
// jsonb (D1/D11 — single jsonb, no annual ALTER TABLE churn). Enum values mirror the leaf type surface
// in `@wardenx/types` (`hope.ts`); the §3.3 tables (M10-T02) compile against the final enum set
// (ADR-0022 D1.3: one pgEnum definition site, no later ALTER-then-redeclare).

/** `hope_rfa_kind` — the five §2 Reasons-For-Assessment a HOPE timepoint/assessment may carry. */
export const hopeRfaKind = pgEnum("hope_rfa_kind", [
  "01_admission",
  "02_huv1",
  "03_huv2",
  "04_sfv",
  "05_discharge",
]);

/** `hope_discharge_reason` — the Discharge-RFA branch discriminator (D9; null for non-discharge RFAs). */
export const hopeDischargeReason = pgEnum("hope_discharge_reason", [
  "death",
  "revocation",
  "transfer_to_hospice",
  "live_discharge",
]);

/** `hope_assessment_status` — the §2.2.2 lifecycle: draft → signed → (correction) superseded. */
export const hopeAssessmentStatus = pgEnum("hope_assessment_status", [
  "draft",
  "signed",
  "superseded",
]);

/** `hope_schedule_status` — the §2.2.1 timepoint-window lifecycle (open → completed/expired/skipped). */
export const hopeScheduleStatus = pgEnum("hope_schedule_status", [
  "open",
  "completed",
  "expired",
  "skipped",
]);

/** `hope_sfv_status` — the §2.2.3 Symptom-Follow-Up-Visit lifecycle (open → completed/overdue → missed). */
export const hopeSfvStatus = pgEnum("hope_sfv_status", [
  "open",
  "completed",
  "overdue",
  "missed",
]);

/** `hope_submission_status` — the §2.2.4 iQIES submission-batch lifecycle. */
export const hopeSubmissionStatus = pgEnum("hope_submission_status", [
  "queued",
  "in_flight",
  "accepted",
  "rejected",
  "partially_accepted",
]);

/** `hope_submission_item_status` — the per-assessment outcome within a submission batch. */
export const hopeSubmissionItemStatus = pgEnum("hope_submission_item_status", [
  "accepted",
  "rejected",
  "pending",
]);

/** `hope_validation_severity` — a §3 `hope_validation_finding`'s blocking class (error vs warning). */
export const hopeValidationSeverity = pgEnum("hope_validation_severity", [
  "error",
  "warning",
]);

/** `j2051_severity` — the CMS-defined four-level symptom-impact item (D4; drives the 2-day SFV trigger). */
export const j2051Severity = pgEnum("j2051_severity", [
  "none",
  "mild",
  "moderate",
  "severe",
]);

/** `hope_schedule_generated_by` — provenance of a timepoint schedule row (§2 `generated_by`). */
export const hopeScheduleGeneratedBy = pgEnum("hope_schedule_generated_by", [
  "auto_admission",
  "auto_discharge",
  "sfv_trigger",
  "manual_admin",
]);

// ── Module 11 (Orders) §3.2 ───────────────────────────────────────────────────────────────────
// The shared `order_record` row keys on `kind` and carries a per-kind TypeBox-typed `data` jsonb
// (D1 — single jsonb, no per-kind ALTER TABLE churn). `transmission_status` / `results_status` are
// the §2.2 orthogonal lab-only observed states (never lifecycle states). Enum values mirror the leaf
// type surface in `@wardenx/types` (`orders.ts`); the §3.3 tables (M11-T02) compile against the final
// enum set (ADR-0022 D1.3: one pgEnum definition site, no later ALTER-then-redeclare).

/** `order_kind` — the eight §2.1 non-medication order kinds. */
export const orderKind = pgEnum("order_kind", [
  "lab",
  "dme",
  "level_of_care_change",
  "recertification",
  "comfort_kit",
  "supply",
  "ancillary_service",
  "idg_requested",
]);

/** `order_status` — the §2.2 D2 lifecycle (draft → … → active → completed/discontinued). */
export const orderStatus = pgEnum("order_status", [
  "draft",
  "pending_signature",
  "verbal_pending",
  "active",
  "completed",
  "discontinued",
  "expired_unsigned",
]);

/** `order_priority` — the §2.1 lab/dispatch priority (ORC-7 / OBR-5 in the §4.4 ORM payload). */
export const orderPriority = pgEnum("order_priority", ["routine", "stat", "asap"]);

/** `order_signature_target_kind` — the §2.8 D14 polymorphic-signature discriminator (M11 order vs M12 med order). */
export const orderSignatureTargetKind = pgEnum("order_signature_target_kind", [
  "order",
  "medication_order",
]);

/** `order_signature_kind` — the §2.5 polymorphic `order_signature.signature_kind`. */
export const orderSignatureKind = pgEnum("order_signature_kind", [
  "signature",
  "cosignature",
  "verbal_attestation",
]);

/** `verbal_order_status` — the §2.3 D3 verbal-order timer lifecycle. */
export const verbalOrderStatus = pgEnum("verbal_order_status", [
  "pending",
  "signed_in_time",
  "expired_unsigned",
]);

/** `standing_order_cadence` — the §2.4 D5 template spawn cadence. */
export const standingOrderCadence = pgEnum("standing_order_cadence", [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "prn",
]);

/** `standing_order_status` — the §2.4 D5 standing-order template lifecycle. */
export const standingOrderStatus = pgEnum("standing_order_status", [
  "active",
  "paused",
  "expired",
  "discontinued",
]);

/** `standing_order_spawned_by` — provenance of a §2.4 `standing_order_instance` (worker vs PRN request). */
export const standingOrderSpawnedBy = pgEnum("standing_order_spawned_by", [
  "system",
  "clinician_request",
]);

/** `order_discontinuation_reason` — the §2.6 D13 discontinuation reasons (operator + auto-cascade). */
export const orderDiscontinuationReason = pgEnum("order_discontinuation_reason", [
  "clinical_judgement",
  "patient_request",
  "adverse_event",
  "replaced_by_corrected_order",
  "admission_discharged",
  "level_of_care_change",
  "standing_order_discontinued",
  "corrected_replacement",
  "expired_verbal",
]);

/** `order_transmission_status` — the §2.2 / §4.10 orthogonal lab-wire dispatch state (M29-driven). */
export const orderTransmissionStatus = pgEnum("order_transmission_status", [
  "not_required",
  "pending",
  "pending_retry",
  "transmitted",
  "failed",
]);

/** `order_results_status` — the §2.2 / §4.10 orthogonal lab-results-received state (M29-driven). */
export const orderResultsStatus = pgEnum("order_results_status", [
  "not_expected",
  "awaiting_results",
  "partial_results_received",
  "results_received",
  "results_overdue",
]);

// ── Module 12 (DoseSpot Integration) §3.2 ──────────────────────────────────────────────────────
// The prescribing surface. `medication_order_status` is the §2.2 D2 lifecycle (note the EPCS-only
// `epcs_identity_pending` branch + the `queued_for_transmission`/`transmitted`/`ack_received` wire
// states). `dosespot_send_state` is the orthogonal transmission observed-state (mirrors M11's lab
// dispatch split). Values mirror the leaf type surface in `@wardenx/types` (`dosespot.ts`); the §3.3
// tables (M12-T02) compile against this final set (ADR-0022 D1.3: one definition site, no ALTER-redeclare).

/** `medication_order_status` — the §2.2 D2 medication-order lifecycle (incl. EPCS + transmission states). */
export const medicationOrderStatus = pgEnum("medication_order_status", [
  "draft",
  "pending_signature",
  "verbal_pending",
  "epcs_identity_pending",
  "signed",
  "queued_for_transmission",
  "transmitted",
  "ack_received",
  "nack_received",
  "active",
  "completed",
  "discontinued",
  "transmission_failed",
  "expired_unsigned",
]);

/** `med_class` — the §2.1 medication taxonomy (standard / controlled / compounded). */
export const medClass = pgEnum("med_class", ["standard", "controlled_substance", "compounded"]);

/** `dea_schedule` — the §2.4 DEA controlled-substance schedules subject to the EPCS gate. */
export const deaSchedule = pgEnum("dea_schedule", ["II", "III", "IV", "V"]);

/** `dosespot_send_state` — the §2.2 / §4.10 orthogonal NewRx-transmission observed state. */
export const dosespotSendState = pgEnum("dosespot_send_state", [
  "not_required",
  "queued",
  "in_flight",
  "transmitted",
  "acked",
  "nacked",
  "failed",
]);

/** `refill_request_status` — the §2.7 D9 refill-inbox lifecycle. */
export const refillRequestStatus = pgEnum("refill_request_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

/** `refill_response_channel` — the §2.7 channel a refill decision is communicated back through. */
export const refillResponseChannel = pgEnum("refill_response_channel", [
  "electronic_via_dosespot",
  "phone",
  "fax",
  "in_person",
]);

/** `medication_history_source` — the §2.8 provenance of a medication-history record. */
export const medicationHistorySource = pgEnum("medication_history_source", [
  "dosespot_medhx",
  "manual_entry",
  "reconciliation_carryforward",
]);

/** `dosespot_webhook_event_type` — the §2.5 / §7.4 D7 typed inbound webhook taxonomy. */
export const dosespotWebhookEventType = pgEnum("dosespot_webhook_event_type", [
  "script_status_update",
  "refill_request",
  "medication_history_result",
  "patient_mismatch",
  "prescriber_status_changed",
]);

/** `ial2_status` — the §2.4 §1311.115 IAL2 identity-proofing status for an EPCS prescriber. */
export const ial2Status = pgEnum("ial2_status", [
  "not_started",
  "in_progress",
  "verified",
  "expired",
  "revoked",
]);

/** `epcs_certification_status` — the §2.4 D18 per-tenant EPCS certification gate (Drummond / ADR-006). */
export const epcsCertificationStatus = pgEnum("epcs_certification_status", [
  "not_certified",
  "audit_in_progress",
  "certified",
  "revoked",
]);

/** `epcs_signing_attempt_outcome` — the §2.4 §1311.205 record-of-application outcome per signing attempt. */
export const epcsSigningAttemptOutcome = pgEnum("epcs_signing_attempt_outcome", [
  "pending",
  "succeeded",
  "failed_2fa",
  "failed_timeout",
  "failed_validation",
]);

/** `epcs_second_factor_type` — the §2.4 §1311.116 second-factor used at controlled-substance signing. */
export const epcsSecondFactorType = pgEnum("epcs_second_factor_type", [
  "totp",
  "passkey",
  "push_confirm",
]);

/** `medication_order_discontinuation_reason` — the §2.2 / §2.12 discontinuation reasons (operator + cascade). */
export const medicationOrderDiscontinuationReason = pgEnum(
  "medication_order_discontinuation_reason",
  [
    "clinical_judgement",
    "patient_request",
    "adverse_event",
    "replaced_by_corrected_order",
    "admission_discharged",
    "pharmacy_nack",
    "corrected_replacement",
    "expired_verbal",
    "transmission_failed",
    "no_refills_no_renewal",
  ],
);

// ── Module 13 (eMAR & Med Administration) §3.2 enums (M13-T01) ─────────────────────────────────────────

/** `administration_mode` — the §2.1 six administration modes (single-dose + the five IV-continuous segments). */
export const administrationMode = pgEnum("administration_mode", [
  "single_dose",
  "iv_continuous_start",
  "iv_continuous_rate_change",
  "iv_continuous_pause",
  "iv_continuous_resume",
  "iv_continuous_stop",
]);

/** `administration_status` — the §2.2 D6 PERSISTED lifecycle states (the transient `committing` /
 * synthetic `pending_offline_sync` states are never written). */
export const administrationStatus = pgEnum("administration_status", [
  "committed",
  "pending_caregiver_review",
  "superseded",
  "voided",
]);

/** `administration_actor_kind` — who recorded the administration (§2.2 / §2.9). */
export const administrationActorKind = pgEnum("administration_actor_kind", [
  "clinician",
  "caregiver_attested",
  "system_iv_session_event", // reserved for M37 pump-emitted events at IPU lock
]);

/** `administration_late_entry_tier` — the §2.5 D8 late-entry tier resolved at write. */
export const administrationLateEntryTier = pgEnum("administration_late_entry_tier", [
  "normal",
  "late",
  "significant_late",
  "administrative_override",
]);

/** `scheduled_dose_status` — the §2.3 D2 materialized-schedule row state. */
export const scheduledDoseStatus = pgEnum("scheduled_dose_status", [
  "pending",
  "administered",
  "missed",
  "cancelled",
  "intentionally_held",
]);

/** `scheduled_dose_cancellation_reason` — why a future scheduled dose was cancelled (§2.3). */
export const scheduledDoseCancellationReason = pgEnum("scheduled_dose_cancellation_reason", [
  "order_discontinued",
  "admission_discharged",
  "corrected_replacement",
  "tenant_policy",
]);

/** `missed_dose_kind` — how the missed dose arose (§2.5 D4). */
export const missedDoseKind = pgEnum("missed_dose_kind", [
  "detected_by_sweep",
  "intentionally_held",
  "patient_refused",
]);

/** `administration_witness_kind` — controlled-substance witness presence mode (§2.6 D7). */
export const administrationWitnessKind = pgEnum("administration_witness_kind", [
  "co_present",
  "telephonic", // reserved for the Phase-2 telehealth-witness workflow
]);

/** `administration_witnesses_scope` — what the witness attested (§2.6). */
export const administrationWitnessesScope = pgEnum("administration_witnesses_scope", [
  "administration_only",
  "wastage_only",
  "administration_and_wastage",
]);

/** `prn_requested_by_kind` — the PRN trigger provenance (§2.4 D3). */
export const prnRequestedByKind = pgEnum("prn_requested_by_kind", [
  "clinician_observed",
  "patient_request",
  "caregiver_request",
  "scheduled_reassessment_protocol",
]);

/** `reconciliation_trigger_kind` — the M6 event that opened the worksheet (§2.8 D17). */
export const reconciliationTriggerKind = pgEnum("reconciliation_trigger_kind", [
  "admission",
  "transfer_in",
  "discharge",
  "recertification",
]);

/** `reconciliation_worksheet_status` — the §2.8 worksheet lifecycle. */
export const reconciliationWorksheetStatus = pgEnum("reconciliation_worksheet_status", [
  "pending",
  "in_progress",
  "finalized",
  "voided",
]);

/** `reconciliation_decision_kind` — the per-line reconciliation decision (§2.8). */
export const reconciliationDecisionKind = pgEnum("reconciliation_decision_kind", [
  "carry_forward",
  "discontinue",
  "hold",
  "new_order",
  "document_only",
]);

/** `comfort_kit_disposal_status` — the §2.7 D5 deployment disposal lifecycle. */
export const comfortKitDisposalStatus = pgEnum("comfort_kit_disposal_status", [
  "deployed",
  "return_required",
  "returned",
  "disposed_unreturned",
]);

/** `comfort_kit_replenishment_urgency` — the §2.7 replenishment-needed urgency. */
export const comfortKitReplenishmentUrgency = pgEnum("comfort_kit_replenishment_urgency", [
  "routine",
  "urgent",
]);

/** `offline_sync_status` — the §2.10 D18 server-side offline-queue ingest state. */
export const offlineSyncStatus = pgEnum("offline_sync_status", [
  "pending",
  "synced",
  "rejected",
]);

// ── Module 14 (Interdisciplinary Group / IDG) — §3.2 enums (M14-T01) ──────────────────────────────────

/** `idg_meeting_status` — the §2.2 meeting lifecycle. `scheduled → packets_building → packets_ready →
 * live → adjourned`, with terminal `cancelled` / `rescheduled` branches. */
export const idgMeetingStatus = pgEnum("idg_meeting_status", [
  "scheduled",
  "packets_building",
  "packets_ready",
  "live",
  "adjourned",
  "cancelled",
  "rescheduled",
]);

/** `idg_attendance_status` — per-attendee participation (§1.1 / §2.7). */
export const idgAttendanceStatus = pgEnum("idg_attendance_status", [
  "present",
  "tardy",
  "partial",
  "absent",
  "excused",
]);

/** `idg_agenda_item_kind` — the §2.7 agenda-item taxonomy (carry-forward of overdue action items is its
 * own kind so the next meeting's cover surfaces it). */
export const idgAgendaItemKind = pgEnum("idg_agenda_item_kind", [
  "patient_review",
  "carry_forward",
  "administrative_note",
  "family_meeting_setup",
  "other",
]);

/** `idg_decision_kind` — the §2.6 D4 canonical decision taxonomy; the discriminator on the
 * `idg.decision_recorded` payload union (`IdgDecisionRecordedPayload`). */
export const idgDecisionKind = pgEnum("idg_decision_kind", [
  "care_plan_update",
  "order_request",
  "medication_recommendation",
  "level_of_care_consideration",
  "recertification_consideration",
  "family_meeting_needed",
  "bereavement_risk_flag",
  "referral",
  "team_note",
]);

/** `idg_decision_status` — `open` at record-time; flips to `emitted` in the adjournment outbox burst;
 * `superseded` when a later meeting's decision replaces it (§2.7 / §2.8). */
export const idgDecisionStatus = pgEnum("idg_decision_status", ["open", "emitted", "superseded"]);

/** `idg_action_item_status` — the §1.1 / D8 action-item lifecycle; `auto_closed` is set by the
 * downstream-artifact auto-close engine (care-plan version / order / encounter / medication order). */
export const idgActionItemStatus = pgEnum("idg_action_item_status", [
  "open",
  "in_progress",
  "completed",
  "cancelled",
  "auto_closed",
]);

/** `idg_action_item_linked_kind` — which downstream absorbing artifact closes an action item (D8). */
export const idgActionItemLinkedKind = pgEnum("idg_action_item_linked_kind", [
  "care_plan_version",
  "order",
  "encounter",
  "medication_order",
]);

/** `idg_minutes_status` — append-only-annotation while `in_progress`; immutable on `final` (D10). */
export const idgMinutesStatus = pgEnum("idg_minutes_status", ["in_progress", "final"]);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Module 17 — Scheduling & Route Optimization (§3.2). The reconciled (M17-F03) eight-state visit machine +
// the proposal/recurring/time-off lifecycles + the EVV-bracket flag column. The Drizzle tables land in
// M17-T02 (`packages/db/src/schema/scheduling/`); the leaf mirrors live in `@wardenx/types` (`scheduling.ts`).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `visit_status` — the §2.2.1 / D3 (M17-F03-reconciled) eight-state visit lifecycle. `proposed` is worker
 * output awaiting scheduler review; `en_route`/`in_visit` are EVV-authoritative (M18) or clinician-self-
 * attested; `completed` is set on `m8.encounter.signed`; `no_show`/`cancelled`/`rescheduled` are terminal. */
export const visitStatus = pgEnum("visit_status", [
  "proposed",
  "published",
  "en_route",
  "in_visit",
  "completed",
  "no_show",
  "cancelled",
  "rescheduled",
]);

/** `visit_purpose` — the §1.1 discipline+intent taxonomy (the §4.2 `CreateVisitRequest` value set governs). */
export const visitPurpose = pgEnum("visit_purpose", [
  "routine_visit",
  "prn",
  "aide_poc",
  "msw_assessment",
  "msw_followup",
  "chaplain_visit",
  "chaplain_assessment",
  "volunteer_visit",
  "f2f",
  "recert",
  "loc_change",
  "pronouncement",
  "admission_visit",
  "discharge_visit",
]);

/** `visit_setting` — the §2.3 service-location class; drives the address/facility validation rules. */
export const visitSetting = pgEnum("visit_setting", [
  "patient_home",
  "facility",
  "inpatient_unit",
  "telephonic",
]);

/** `visit_proposal_status` — the §2.2.4 D5 proposal lifecycle; `stale` is set when not actioned by the
 * cadence hard-cutoff. */
export const visitProposalStatus = pgEnum("visit_proposal_status", [
  "pending",
  "published",
  "dismissed",
  "stale",
]);

/** `visit_proposal_source` — the §2.2.4 origin of a proposal (the upstream module that drove it). */
export const visitProposalSource = pgEnum("visit_proposal_source", [
  "frequency_driven_m7",
  "supervisory_cadence_m15",
  "order_required_m11",
  "idg_decision_m14",
]);

/** `recurring_visit_status` — the §2.2.3 D4 policy lifecycle; `discontinued` cascade-cancels future children. */
export const recurringVisitStatus = pgEnum("recurring_visit_status", ["active", "discontinued"]);

/** `time_off_kind` — the §1.1 D7 PTO taxonomy. */
export const timeOffKind = pgEnum("time_off_kind", [
  "pto",
  "sick",
  "bereavement",
  "training",
  "other",
]);

/** `time_off_state` — the §2.2.6 D7 approval lifecycle; `consumed` is set when the window passes. */
export const timeOffState = pgEnum("time_off_state", [
  "requested",
  "approved",
  "denied",
  "cancelled",
  "consumed",
]);

// NOTE: the §1.1 / D3 EVV-bracket flag column on `visit` reuses the existing shared `evvBracketState`
// pgEnum (`evv_present` | `evv_missing_documented`) defined above for M8 — those two values are exactly the
// M17 body vocabulary (§2.2.1 / line 76 / §7.6; the struck M17-F03 `evv_missing_attested` belonged to the
// discarded state machine, not the flag). `check-ddl-legality` bans a duplicate pgEnum, so M17-T02's
// `visits.ts` imports the shared one. The §3.2 Phase-A enum list correctly names only the eight M17-owned
// enums above.

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Module 18 — Electronic Visit Verification (EVV) (§3.2 Phase-A). The eight M18-owned enums driving the
// append-only `evv_event` (check-in/out), the three-layer geofence policy, per-clinician device lifecycle,
// the §2.2.4 missing-EVV resolution machine, and the per-state aggregator submission machine. The Drizzle
// tables land in M18-T02 (`packages/db/src/schema/evv/`); the leaf mirrors live in `@wardenx/types`
// (`evv.ts`). M18 owns no shared EVV enum overlap with M8/M17 — the M17 `visit.evvBracketState` flag reuses
// M8's `evv_bracket_state`; M18's discrete-event vocabulary below is distinct.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `evv_event_kind` — the §2.2.1 / D2 discrete event class. `mid_visit_pulse` is reserved for Phase 2. */
export const evvEventKind = pgEnum("evv_event_kind", ["check_in", "check_out"]);

/** `evv_event_gps_quality` — the §3.2 GPS-quality ladder stamped on every `evv_event`. `degraded_attested`
 * is the clinician-attested-after-3-retakes path; `outside_geofence`/`no_geofence_baseline` route to the
 * advisory-not-block missing-resolution flow (D3); `suspected_spoof` is the D9 detector flag. */
export const evvEventGpsQuality = pgEnum("evv_event_gps_quality", [
  "high",
  "acceptable",
  "degraded_attested",
  "outside_geofence",
  "no_geofence_baseline",
  "suspected_spoof",
]);

/** `evv_device_platform` — the §2.3 mobile platform; web is refused at the route handler (no enum member). */
export const evvDevicePlatform = pgEnum("evv_device_platform", ["ios", "android"]);

/** `evv_device_status` — the §2.2.3 D8 per-clinician device-registration lifecycle. */
export const evvDeviceStatus = pgEnum("evv_device_status", [
  "pending_approval",
  "approved",
  "suspended",
  "rejected",
  "retired",
]);

/** `evv_geofence_policy_scope` — the §2.2.2 D3 three-layer policy resolution order (narrowest wins). */
export const evvGeofencePolicyScope = pgEnum("evv_geofence_policy_scope", [
  "platform",
  "tenant",
  "patient_address",
]);

/** `evv_missing_resolution_kind` — the §2.2.4 D6 classification of the unresolved missing event. */
export const evvMissingResolutionKind = pgEnum("evv_missing_resolution_kind", [
  "missing_checkin",
  "missing_checkout",
  "outside_geofence_at_checkin",
  "outside_geofence_at_checkout",
  "device_integrity_failed_at_attempt",
]);

/** `evv_missing_resolution_status` — the §2.2.4 D6 resolution machine. `closed_system_checkout_received` is
 * the system-driven auto-close when a late check-out pairs the open missing-checkout row (M18-F09 / ADR-0022;
 * NO human attestation — `closed_clinician_attested` is reserved for an actual clinician self-attest). */
export const evvMissingResolutionStatus = pgEnum("evv_missing_resolution_status", [
  "open",
  "closed_clinician_attested",
  "closed_supervisor_override",
  "closed_visit_voided",
  "closed_documented_at_encounter",
  "closed_system_checkout_received",
]);

/** `evv_aggregator_submission_status` — the §2.2.5 D7 per-state aggregator submission machine. */
export const evvAggregatorSubmissionStatus = pgEnum("evv_aggregator_submission_status", [
  "pending",
  "queued",
  "submitting",
  "submitted",
  "accepted",
  "rejected",
  "timeout",
  "cancelled",
]);

// ── Module 22 (Document Management) §3.2 pgEnums ──────────────────────────────────────────────────────
// The 19 enums of `0022_documents.sql` Phase 1. `compliance_42cfr_part2` (the SUD-class retention value)
// is added to `document_retention_class` here at the single definition site even though the spec notes M4's
// migration 0035 carries the SQL ENUM-extension — the Drizzle enum value set is the source of truth and
// must list every legal value (M22 exercises it; M4 owns the column-level retention semantics, §3.2).

/** §3.2 `document_retention_class` — drives partition lifecycle + destruction-cert eligibility. */
export const documentRetentionClass = pgEnum("document_retention_class", [
  "compliance", // 7y default, anchored to original disposition
  "clinical_record", // anchored to patient lifecycle per M5
  "bereavement", // 13 months per M16
  "operational", // 1y
  "intake_artifact", // raw upload; disposition+30d (no writeback) | promoted to clinical_record (writeback)
  "compliance_42cfr_part2", // SUD-class content; eraser refused during patient lifetime (D23)
]);

/** §3.2 `document_source_kind` — how the document entered the platform. */
export const documentSourceKind = pgEnum("document_source_kind", [
  "form_render",
  "user_upload",
  "api_ingest",
  "fax_ingest",
  "portal_upload",
  "extraction_writeback",
  "consent_capture",
]);

/** §3.2 `document_aggregate_type` — the owning-module artifact the document materializes. */
export const documentAggregateType = pgEnum("document_aggregate_type", [
  "election_statement",
  "cti",
  "f2f",
  "nor",
  "revocation",
  "discharge_summary",
  "nomnc",
  "abn",
  "hipaa_privacy_notice",
  "code_status_directive",
  "encounter",
  "order_record",
  "medication_order",
  "medication_administration_record",
  "medication_reconciliation_worksheet",
  "patient_medication_list",
  "comfort_kit_receipt",
  "idg_patient_packet",
  "idg_minutes",
  "aide_poc",
  "msw_plan",
  "spiritual_plan",
  "volunteer_plan",
  "bereavement_letter",
  "visit_confirmation",
  "evv_verification",
  "patient_amendment_statement_of_disagreement",
  "consent_record",
  "intake_source",
  "other",
]);

/** §3.2 `document_status` — the §2.2.1 document lifecycle. */
export const documentStatus = pgEnum("document_status", [
  "active",
  "superseded",
  "legal_hold",
  "destroyed_tombstone",
]);

/** §3.2 `form_render_engine` — the two render backends (one interface). */
export const formRenderEngine = pgEnum("form_render_engine", ["react_pdf", "puppeteer"]);

/** §3.2 `form_fill_status` — the §2.2.4 render-instance lifecycle. */
export const formFillStatus = pgEnum("form_fill_status", [
  "queued",
  "rendering",
  "rendered",
  "failed",
  "delivered",
]);

/** §3.2 `intake_batch_status` — the §2.2.5 intake-batch lifecycle (incl. F19 split/parse-fail states). */
export const intakeBatchStatus = pgEnum("intake_batch_status", [
  "uploaded",
  "docling_complete",
  "classifier_complete",
  "extraction_complete",
  "in_review",
  "writeback_complete",
  "discarded",
  "split_into_children",
  "split_resolved_no_split",
  "parse_failed",
]);

/** §3.2 `classified_page_doc_type` — the per-page classifier output document type. */
export const classifiedPageDocType = pgEnum("classified_page_doc_type", [
  "discharge_summary",
  "med_recon",
  "hp",
  "lab",
  "imaging",
  "consult",
  "insurance_card",
  "photo_id",
  "advance_directive",
  "dpoa",
  "transfer_record",
  "unknown",
]);

/** §3.2 `extraction_job_status` — the §2.2.6 extraction-job lifecycle (incl. F19 capability states). */
export const extractionJobStatus = pgEnum("extraction_job_status", [
  "queued",
  "extracting",
  "verifying",
  "discrepancy_check",
  "ready_for_review",
  "in_review",
  "committed",
  "discarded",
  "failed",
  "awaiting_capability",
  "stalled",
]);

/** §3.2 `extraction_candidate_risk_level` — gates bulk-approve (high = per-field only). */
export const extractionCandidateRiskLevel = pgEnum("extraction_candidate_risk_level", [
  "low",
  "medium",
  "high",
]);

/** §3.2 `extraction_candidate_field_kind` — the value shape of an extracted field. */
export const extractionCandidateFieldKind = pgEnum("extraction_candidate_field_kind", [
  "text",
  "code",
  "date",
  "boolean",
  "measurement",
  "enum",
]);

/** §3.2 `extraction_candidate_code_system` — the canonical code system a value resolved to. */
export const extractionCandidateCodeSystem = pgEnum("extraction_candidate_code_system", [
  "rxnorm",
  "icd10",
  "loinc",
  "snomed",
  "ndc",
  "none",
]);

/** §3.2 `extraction_discrepancy_kind` — cross-source vs chart-existing disagreement. */
export const extractionDiscrepancyKind = pgEnum("extraction_discrepancy_kind", [
  "cross_source",
  "chart_existing",
]);

/** §3.2 `extraction_discrepancy_status` — open/resolved. */
export const extractionDiscrepancyStatus = pgEnum("extraction_discrepancy_status", [
  "open",
  "resolved",
]);

/** §3.2 `extraction_decision_kind` — the reviewer's per-field action. */
export const extractionDecisionKind = pgEnum("extraction_decision_kind", [
  "approve",
  "approve_with_edit",
  "reject",
]);

/** §3.2 `extraction_review_status` — the §2.2.7 review-session lifecycle. */
export const extractionReviewStatus = pgEnum("extraction_review_status", [
  "in_progress",
  "complete",
  "abandoned",
]);

/** §3.2 `chart_target_module` — the owning module a writeback drafts into. */
export const chartTargetModule = pgEnum("chart_target_module", [
  "m5",
  "m7",
  "m9",
  "m11",
  "m12",
  "m13",
  "m22",
  "m40",
]);

/** §3.2 `document_access_kind` — the `auditRead` / access-log access classification. */
export const documentAccessKind = pgEnum("document_access_kind", [
  "metadata_read",
  "content_download",
  "signed_url_issued",
  "signed_url_consumed",
  "portal_view",
  "disclosure_export",
]);

/** §3.2 `document_access_purpose` — the §164.528 accounting-of-disclosures purpose. */
export const documentAccessPurpose = pgEnum("document_access_purpose", [
  "treatment",
  "payment",
  "operations",
  "disclosure",
  "patient_access",
  "amendment_review",
  "survey_export",
]);

// ── M34 SaaS Tenant Platform §3.7 DSAR + Tenant Export ──────────────────────

/** M34 §3.7 `dsar_export_job_status` — the DSAR export job lifecycle. */
export const dsarExportJobStatus = pgEnum("dsar_export_job_status", [
  "requested",
  "generating",
  "review_pending",
  "fulfilled",
  "denied",
  "extended",
]);

/** M34 §3.7 `dsar_request_source` — who the DSAR request originated from. */
export const dsarRequestSource = pgEnum("dsar_request_source", [
  "patient",
  "caregiver",
  "legal_representative",
  "authorized_third_party",
]);

/** M34 §3.7 `tenant_export_job_status` — the tenant-export job lifecycle. */
export const tenantExportJobStatus = pgEnum("tenant_export_job_status", [
  "requested",
  "generating",
  "fulfilled",
  "expired",
  "cancelled",
]);

/** M34 §3.7 `tenant_export_job_purpose` — the captured justification class for a tenant export. */
export const tenantExportJobPurpose = pgEnum("tenant_export_job_purpose", [
  "migration",
  "baa_termination",
  "compliance_audit",
  "surveyor_request",
]);
