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
export const messageReceiptStatus = pgEnum("message_receipt_status", [
  "delivered",
  "read",
  "ack",
]);

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
