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

/** Global password lifecycle state; deliberately independent from account and membership status. */
export const credentialState = pgEnum("credential_state", ["active", "password_change_required"]);

/** M1 §3.10 — an idempotency record is either claimed-and-running or finished-with-a-cached-response. */
export const idempotencyState = pgEnum("idempotency_state", ["pending", "complete"]);

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
  // The five classes M16/M19/M31's ABAC predicates have always compared against (migration 0219).
  // They were absent for as long as those predicates have existed, so every one of them denied
  // unconditionally — indistinguishable from a correct refusal, because the readers default an absent
  // class to `staff` and then deny that too.
  "patient_portal", // M31 — the patient's own portal session (grant kind `patient_self`)
  "caregiver_portal", // M31 — a family caregiver / DPOA acting for the patient
  "bereaved_portal", // M31/M16 — the post-death bereavement surface (grant `bereaved_mode`)
  "external_triage_vendor", // M19 — an answering-service organization's session
  "external_triage_operator", // M19 — one operator within that vendor
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
  // CMS HOPE assessment-instrument items (J2030 / J2050 / J2051 …) — the authority that publishes the
  // HOPE item roster, so `hope_j_codes` has a system to be curated under (F-059, mig 0229). Sits beside
  // `revenue` / `carc` / `rarc` rather than the clinical terminologies: all four are administrative code
  // lists published by a body, not concept graphs.
  "cms_hope",
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
export const messageBodyKind = pgEnum("message_body_kind", ["plain", "markdown", "system", "rich"]);

// `message_status` — message lifecycle (§2.4.2). `deleted` is a tombstone; body_cipher is
// RETAINED until retention expiry (M36-F02 / ADR-0004 / ARCH-185), never zeroed early.
export const messageStatus = pgEnum("message_status", ["sent", "edited", "deleted"]);

// `message_urgency` (WP 4.1, ADR-0068, migration 1105): `routine` is every message; `urgent` is set only by the
// "Urgent clinical" entry and is fixed at send; `important` has no writer until WP 4.2. Never inferred from text.
export const messageUrgency = pgEnum("message_urgency", ["routine", "important", "urgent"]);

// WP 4.2 (ADR-0069, migration 1107): the acknowledgment-request aggregate. Mirrors ACK_STATUSES / ACK_CLASSES / ACK_EVENT_TYPES in
// @wardenx/types (pinned by a test). `escalated` and `failed_unreachable` have no writer until WP 4.4 / 4.5; `critical_symptom`
// has none until the clinical lead signs off who may raise or take it.
export const messageAckStatus = pgEnum("message_ack_status", [
  "pending",
  "acknowledged",
  "escalated",
  "resolved",
  "cancelled",
  "failed_unreachable",
]);
export const messageAckClass = pgEnum("message_ack_class", [
  "important",
  "urgent",
  "critical_symptom",
]);
// `route_unavailable` and `ladder_exhausted` were added by migration 1112 (WP 4.4, ADR-0070).
export const messageAckEventType = pgEnum("message_ack_event_type", [
  "requested",
  "delivered",
  "opened",
  "acknowledged",
  "overdue",
  "escalated",
  "reassigned",
  "resolved",
  "cancelled",
  "delivery_failed",
  "route_unavailable",
  "ladder_exhausted",
]);

// `message_receipt_status` — per-recipient receipt state (§3.4): `delivered` (fanned out server-side) |
// `read` (explicitly read). `ack` is a retired value kept only to match the DB enum (a Postgres enum value
// cannot be dropped in place); migration 1079 CHECK-blocks it. It is NOT a clinical acknowledgement
// (ADR-0056 item 1). The column is typed delivered | read in the Drizzle schema.
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
  // GAP-057 (migration 0740) — the two M34 resolvers the composition root registers onto M36's registry.
  "compliance_officer_for_tenant",
  "platform_security_owner",
  // GAP-040 (migration 1001) - members holding any of `resolver_args.permissionKeys`.
  "permission_holders",
]);

// `alert_outcome` — terminal fan-out outcome of a dispatched alert (§2.4.3).
// F-109 (migration 0240): `pending` is the state §2.4.3's machine OPENS in and the enum never had, which
// is why `alert.outcome` was `NOT NULL DEFAULT 'delivered'` — a column that cannot say "not settled yet"
// says the most flattering thing it can, and nothing ever corrected it.
export const alertOutcome = pgEnum("alert_outcome", ["pending", "delivered", "partial", "failed"]);

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

// `facility_kind` — the canonical `facility` subtype (§3.3). `nf`/`ltch`/`psych` (additive, WX-PR-011
// place-of-service follow-up) were added so the full 9-value CMS hospice Q5001-Q5009 place-of-service
// space is representable: `snf` (skilled) vs `nf` (non-skilled nursing facility) disambiguates Q5004 vs
// Q5003, `ltch` is Q5007, `psych` (inpatient psychiatric) is Q5008 — none of the original 6 values could
// express these, so Q-code derivation could never be more than a coarse approximation.
export const facilityKind = pgEnum("facility_kind", [
  "hospital",
  "alf",
  "snf",
  "ipu",
  "clinic",
  "other",
  "nf",
  "ltch",
  "psych",
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
  // A visiting RN beside the RN case manager (migration 0399); any number may be open per patient.
  "rn",
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

/** `consent_recipient_kind` — the named-recipient classes on consent_record_recipient (§3.2, D6).
 *  `workforce_member` (mig 0209) is the one INTERNAL class: `recipient_entity_id` holds an M2
 *  membership id, so a §2.31 release can name the individual staff members it authorizes rather than
 *  only external parties. See `evaluateForInternalAccess` in @wardenx/consent for what naming one
 *  does (and for why a release that names none still authorizes the treating program). */
export const consentRecipientKind = pgEnum("consent_recipient_kind", [
  "external_physician",
  "facility",
  "pharmacy",
  "irb",
  "family_member",
  "attorney",
  "employer",
  "researcher",
  "workforce_member",
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
  "under_review",
  "pending_information",
  "qualified",
  "declined",
  "duplicate",
  "withdrawn",
  "converted",
]);

export const referralPatientResolutionStatus = pgEnum("referral_patient_resolution_status", [
  "unresolved",
  "possible_match",
  "matched",
  "created",
]);

export const referralPriority = pgEnum("referral_priority", ["routine", "high", "urgent"]);

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

/** `election_statement_status` — the §7.3 draft → signed → voided lifecycle (M6L-T03). */
export const electionStatementStatus = pgEnum("election_statement_status", [
  "drafted",
  "signed",
  "voided",
]);

// ── FY2027 election statement addendum (42 CFR 418.24(c)/(d), CMS-1851-F; mig 0381) ────────────────

/** `election_addendum_status` — the addendum version lifecycle (state-machines/election-addendum.ts):
 *  draft → furnished → signed | refused | signature_not_required, or draft → not_required. */
export const electionAddendumStatus = pgEnum("election_addendum_status", [
  "draft",
  "furnished",
  "signed",
  "refused",
  "signature_not_required",
  "not_required",
]);

/** `election_addendum_trigger` — why this version exists: the election itself, or a plan-of-care change. */
export const electionAddendumTrigger = pgEnum("election_addendum_trigger", [
  "initial",
  "poc_change",
]);

/** `election_addendum_furnish_method` — a written copy is always given; electronic only supplements it. */
export const electionAddendumFurnishMethod = pgEnum("election_addendum_furnish_method", [
  "paper",
  "electronic_with_paper_copy",
]);

/** `election_addendum_signer_kind` — who signed the acknowledgement of receipt (418.24(c)(9)). */
export const electionAddendumSignerKind = pgEnum("election_addendum_signer_kind", [
  "beneficiary",
  "representative",
]);

/** `election_addendum_acknowledgement_source` — how the (c)(9) acknowledgement was captured: keyed in WardenX, or a
 *  scanned signed paper copy linked to its M22 document version (mig 0395). */
export const electionAddendumAcknowledgementSource = pgEnum(
  "election_addendum_acknowledgement_source",
  ["structured", "uploaded"],
);

/** `election_addendum_content_source` — where the 418.24(c) content of a version lives: in WardenX, or on a
 *  signed paper copy that was scanned (the version was never completed in WardenX; mig 0396). */
export const electionAddendumContentSource = pgEnum("election_addendum_content_source", [
  "structured",
  "scanned_paper",
]);

/** `election_addendum_exemption_reason` — 418.24(d)(3)/(4): the patient died, revoked, or was discharged
 *  before the addendum was furnished (→ not_required) or signed (→ signature_not_required). */
export const electionAddendumExemptionReason = pgEnum("election_addendum_exemption_reason", [
  "death",
  "revocation",
  "discharge",
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

/** `level_of_care_period_status` — the §2.3.5 persisted lifecycle states (M6-T04 confirm-handshake fix,
 * 2026-08-05). `pending` is a synthetic pre-create sentinel the state machine uses and never persists.
 * `assigning`: IRC/GIP requested but the M37 IPU bed is not yet confirmed — NOT a billable period (M24's
 * claim assembly excludes it). `active`: RHC/CHC (always) or IRC/GIP with a confirmed bed. `ended`: closed
 * (mirrors `ended_at IS NOT NULL`, kept in sync at every close so status is always self-describing). */
export const levelOfCarePeriodStatus = pgEnum("level_of_care_period_status", [
  "assigning",
  "active",
  "ended",
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
  "other",
]);

/** `discharge_event_status` — the D11 two-step for-cause cascade (M6L-T04): pending_cosign → completed/voided. */
export const dischargeEventStatus = pgEnum("discharge_event_status", [
  "pending_cosign",
  "completed",
  "voided",
]);

/**
 * `physician_signer_capacity` — the 42 CFR 418.25(a) / 418.26(b) physician signer set (migration 0388): the
 * hospice medical director, the physician designee (§ 418.3), or the physician member of the patient's IDG.
 * Never the attending physician, an NP or a PA. Shared by the discharge order and the admission recommendation.
 */
export const physicianSignerCapacity = pgEnum("physician_signer_capacity", [
  "medical_director",
  "physician_designee",
  "idg_physician_member",
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
  // FY2027 (CMS-1851-F, 42 CFR 418.24(d), mig 0380) — the election statement addendum clocks: furnish within
  // 5 calendar days of the election's effective date, and an update within 3 calendar days of a plan-of-care
  // change that affects the addendum's determinations.
  "election_addendum_initial",
  "election_addendum_update",
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

/** `care_plan_idg_proposal_status` — M14 decision proposal state in M7's governed review flow. */
export const carePlanIdgProposalStatus = pgEnum("care_plan_idg_proposal_status", [
  "proposed",
  "in_review",
  "applied",
  "conflict",
]);

/** `care_plan_idg_proposed_change_status` — per-mutation application state. */
export const carePlanIdgProposedChangeStatus = pgEnum("care_plan_idg_proposed_change_status", [
  "proposed",
  "applied",
  "conflict",
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

/** `problem_proposal_status` — F-238: a DocLens-extracted diagnosis awaiting a clinician (pending), or
 *  the clinician's decision (accepted → a `problem` row exists; dismissed → nothing was charted). */
export const problemProposalStatus = pgEnum("problem_proposal_status", [
  "pending",
  "accepted",
  "dismissed",
]);

/** `problem_proposal_icd10_validation` — F-238: M38's verdict on the as-written code as of the referral
 *  date; `unvalidated` = M38 could not answer (the code is kept, never dropped or replaced). */
export const problemProposalIcd10Validation = pgEnum("problem_proposal_icd10_validation", [
  "valid",
  "not_valid_as_of",
  "unvalidated",
]);

/** `problem_proposal_document_role` — F-238: how the SOURCE DOCUMENT labels the diagnosis. A suggestion
 *  only; it never sets `problem.kind` (terminal/related/unrelated is the hospice physician's call). */
export const problemProposalDocumentRole = pgEnum("problem_proposal_document_role", [
  "principal",
  "secondary",
  "history",
  "unspecified",
]);

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

/** `encounter_type` — the §2.2 visit types (14 + the three therapy types of migration 1055) that drive the template engine + compliance gate. */
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
  // Therapy visits (migration 1055) — reported as 042x/043x/044x visit lines (CMS Pub. 100-04 ch. 11 §30.3).
  "pt_visit",
  "ot_visit",
  "slp_visit",
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
  // Therapists (migration 1055): physical, occupational, speech-language pathology.
  "pt",
  "ot",
  "slp",
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
export const assessmentActingAs = pgEnum("assessment_acting_as", [
  "self",
  "patient_representative",
]);

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

/** `hope_sfv_status` — the §2.2.3 Symptom-Follow-Up-Visit lifecycle (open → completed/overdue → missed/withdrawn). */
export const hopeSfvStatus = pgEnum("hope_sfv_status", [
  "open",
  "completed",
  "overdue",
  "missed",
  "withdrawn",
]);

/** `hope_submission_status` — the §2.2.4 iQIES submission-batch lifecycle. */
export const hopeSubmissionStatus = pgEnum("hope_submission_status", [
  "ready",
  "queued",
  "packaged",
  "exported",
  "in_flight",
  "submitted_pending_result",
  "accepted",
  "rejected",
  "partially_accepted",
  "accepted_with_warnings",
  "file_error",
]);

/** `hope_submission_item_status` — the per-assessment outcome within a submission batch. */
export const hopeSubmissionItemStatus = pgEnum("hope_submission_item_status", [
  "accepted",
  "accepted_with_warnings",
  "rejected",
  "pending",
  "blocked",
  "unmatched",
]);

/** `hope_validation_severity` — a §3 `hope_validation_finding`'s blocking class (error vs warning). */
export const hopeValidationSeverity = pgEnum("hope_validation_severity", ["error", "warning"]);

/** `j2051_severity` — the CMS-defined four-level symptom-impact item (D4; drives the 2-day SFV trigger). */
export const j2051Severity = pgEnum("j2051_severity", ["none", "mild", "moderate", "severe"]);

/** `hope_isc` — WardenX's internal HOPE item-set code for routing active CMS items by timepoint. */
export const hopeIsc = pgEnum("hope_isc", ["HA", "HUV", "HD", "XX"]);

/** `hope_answer_state` — canonical item answer state; skipped+NULL serializes to CMS `^`. */
export const hopeAnswerState = pgEnum("hope_answer_state", ["answered", "skipped"]);

/** `hope_answer_source` — provenance of a canonical HOPE item answer. */
export const hopeAnswerSource = pgEnum("hope_answer_source", [
  "user",
  "patient_prefill",
  "admission_prefill",
  "derived",
  "imported",
  "correction_copy",
]);

/** `hope_spec_item_kind` — coarse internal classification for CMS item master rows. */
export const hopeSpecItemKind = pgEnum("hope_spec_item_kind", [
  "assessment",
  "control",
  "calculated",
  "filler",
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
  // F-166 (#248) — the M21 `m21.supply_request.cancelled` cascade: a staff member cancelled the supply/
  // DME/comfort-kit fulfillment request directly at M21 (never through M11's own discharge cascade, which
  // already discontinues the order itself before asking M21), so M11 releases the still-in-flight source
  // order it never touched.
  "supply_request_cancelled",
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

/** `hospice_coverage` — COP27 (42 CFR 418.24(b)(6)/(c)): the hospice's coverage determination on a drug
 *  (M12 `medication_order`) or a dme/supply request (M21 `supply_request`). Shared by both owning tables;
 *  created once in migration 0385. Mirrors `HOSPICE_COVERAGE_VALUES` in `@wardenx/types`. */
export const hospiceCoverage = pgEnum("hospice_coverage", [
  "covered_related",
  "not_covered_unrelated",
  "not_covered_other",
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
  "doclens_intake", // F-238 (0311) — reviewer-attested DocLens referral line; reconciliation-only
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
export const offlineSyncStatus = pgEnum("offline_sync_status", ["pending", "synced", "rejected"]);

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
  "discipline_plan_update",
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
  // F-166 (#248, migration 0260) — M19's after-hours triage dispatch, additive-only.
  "triage_dispatch_m19",
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
  "notice_of_rights",
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
  "comfort_kit_receipt", // M13 — the kit-DEPLOYMENT receipt the patient/family signs for
  "supply_bill_of_lading", // M21 — the dispatch shipping manifest (mig 0196)
  "comfort_kit_return_receipt", // M21 — the DEA-1304 controlled-substance return receipt (mig 0196)
  "report_export", // M33 — an ad-hoc "export now" PDF/XLSX render (mig 0197)
  "report_schedule_run", // M33 — one scheduled-report OCCURRENCE's rendered artifact (mig 0197)
  "referral", // M6 — referral inbox artifact (mig 0219)
  // F-099 (mig 0239) — the artifacts behind six render requests that were emitted from production write
  // paths and consumed by nothing. M16's welcome packet files against `bereavement_letter` below, so it
  // needs no value of its own; M27's three artifact kinds are three types because they are separately
  // retained and separately superseded.
  "hope_summary", // M10 — the printable HOPE assessment summary
  "safety_incident_report", // M20 — the incident report PDF (M20 ships no PDF code)
  "appeal_packet", // M25 — the tier-specific denial-appeal letter
  "cost_report_ecr", // M27 — the electronic cost report itself
  "cost_report_pi", // M27 — the provider-information supplement
  "cost_report_supporting_doc", // M27 — a supporting document filed with the submission
  "body_release_authorization", // M37 — `ipu_body_release.release_document_id`'s target
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
  // F-144 (#248, mig 0251) — the six document kinds behind `m23.billing.document_render_requested`,
  // `m24.medicaid_billing.document_render_requested`, and `m25.denial_resolution_letter
  // .render_requested`, all three catalogued and none ever emitted (see packages/types/src/documents.ts).
  "noe_confirmation_receipt",
  "notr_confirmation_receipt",
  "claim_acknowledgment_letter",
  "denial_appeal_cover_letter",
  "medicaid_claim_acknowledgment_letter",
  "denial_resolution_letter",
  // M25 ADR response packet (mig 1108) — the cover sheet and enclosure index for a filed ADR response.
  "adr_response_packet",
  // F-161 (#248, mig 0252) — the M7 care-plan PDF. `m7.care_plan.version_signed`'s own catalog comment
  // ("drives the M8 encounter gate + M22 PDF") was decisive and no template existed for it at all.
  "care_plan",
  // F-192 (#248, mig 0267) — the M6 transfer document. `m6.transfer.created`'s own render request is the
  // M22 spec's own "discharge_summary (transfer variant)" — a distinct type, not a second version of
  // `discharge_summary`, since a transfer is not a discharge for cause/death/routine.
  "discharge_summary_transfer",
  // F-208 (#248, mig 0277) — the M9 printable assessment summary. Distinct from `hope_summary` (M10's
  // per-assessment HOPE timepoint PDF): `m9.assessment.summary_requested` carries no per-request id, so
  // this renders as ONE evolving per-patient document, versioned via the F-168 append mechanism.
  "assessment_summary",
  // F-224 (#248, mig 0290) — the M19 caregiver / attending triage-call summaries behind
  // `m19.triage.summary_requested`: one document per triage call, one aggregate type per audience.
  "triage_summary_caregiver",
  "triage_summary_attending",
  // FY2027 (mig 0380) — the 42 CFR 418.24(c) "Patient Notification of Hospice Non-Covered Items, Services,
  // and Drugs" (the election statement addendum), one document per addendum version.
  "election_addendum",
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

/** F-237 — `intake_batch_sud_status` — the §7.4 W4 / D8 SUD-detection state of an intake batch. */
export const intakeBatchSudStatus = pgEnum("intake_batch_sud_status", [
  "not_detected",
  "detected",
  "confirmed",
  "rejected",
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Module 15 — Discipline Care Plans (§3.2 · M15-T01). The four CoP-driven discipline plan kinds
// (418.76 Aide POC · 418.64 MSW + Spiritual · 418.78 Volunteer) with the D2 hybrid version/signature
// lifecycle, the D6 discipline-assessment vocabulary, the 418.76(h)(2) supervisory attestation mode, and
// the 418.78(b)/(e) volunteer gate + hour-ledger vocabularies. The eleven Drizzle tables land in M15-T02
// (`packages/db/src/schema/discipline-plans/`); the leaf mirrors live in `@wardenx/types`
// (`discipline-plans.ts`) so M14/M16/M17/M22/M27/M28/M30/M33 read them with no `dependsOn` edge.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `discipline_plan_kind` — the D1 shared-row discriminator; selects which per-kind TypeBox validates
 *  `discipline_care_plan.data` and which §3.5 `RequiredSignerSet` the version's quorum is built from. */
export const disciplinePlanKind = pgEnum("discipline_plan_kind", [
  "aide_poc",
  "msw_plan",
  "spiritual_plan",
  "volunteer_plan",
]);

/** `discipline_plan_status` — the §2.2.1 plan-root lifecycle. `draft` at bootstrap (`m6.admission.activated`
 *  for the first three kinds; first volunteer assignment for `volunteer_plan`), `active` on the first signed
 *  version, `draft_revising` while an IDG-opened next version is in flight, `discharged` terminal. */
export const disciplinePlanStatus = pgEnum("discipline_plan_status", [
  "draft",
  "active",
  "draft_revising",
  "discharged",
]);

/** `discipline_plan_version_status` — the §2.2.2 / D2 hybrid-versioning lifecycle (M7 D1 verbatim). The
 *  `state_snapshot` is SEALED at the `in_review` transition; an edit-after-snapshot or any signer rejection
 *  returns the version to `draft` and clears prior signatures. */
export const disciplinePlanVersionStatus = pgEnum("discipline_plan_version_status", [
  "draft",
  "in_review",
  "signed",
  "superseded",
]);

/** `discipline_plan_version_kind` — mirrors M7's version taxonomy. The `discharge` version is auto-built
 *  and auto-signed by the system actor on `m6.admission.discharged` to seal the terminal state. */
export const disciplinePlanVersionKind = pgEnum("discipline_plan_version_kind", [
  "initial",
  "idg_review",
  "interim_revision",
  "discharge",
]);

/** `discipline_goal_source` — D5 / M7 D6 verbatim attribution. A `agent_stated` goal requires a non-null
 *  `acting_consent_id` naming an active M39 `dpoa_healthcare` consent; `original_text` is immutable for
 *  every non-`clinical` source. */
export const disciplineGoalSource = pgEnum("discipline_goal_source", [
  "clinical",
  "patient_stated",
  "family_stated",
  "agent_stated",
]);

/** `discipline_goal_status` — the §2.2.3 goal lifecycle. */
export const disciplineGoalStatus = pgEnum("discipline_goal_status", [
  "not_started",
  "in_progress",
  "met",
  "not_met",
  "revised",
  "discontinued",
]);

/** `discipline_intervention_status` — the §2.2.3 intervention lifecycle; `discontinued` requires a reason. */
export const disciplineInterventionStatus = pgEnum("discipline_intervention_status", [
  "active",
  "discontinued",
  "completed",
]);

/** `discipline_assessment_kind` — the D6 per-discipline assessment taxonomy. Explicitly DISTINCT from M9's
 *  scored clinical scales (PPS/FAST/PAINAD/ESAS-r); these are domain-narrative structured forms. */
export const disciplineAssessmentKind = pgEnum("discipline_assessment_kind", [
  "msw_psychosocial",
  "chaplain_spiritual",
  "aide_environmental",
  "volunteer_relationship",
]);

/** `discipline_assessment_status` — append-only correction-of-record mirroring M9 D9 (§2.2.3). */
export const disciplineAssessmentStatus = pgEnum("discipline_assessment_status", [
  "draft",
  "signed",
  "amended",
]);

/** `aide_supervisory_attestation_mode` — 42 CFR §418.76(h)(2): the RN supervisory contact is either made
 *  with the aide present or as an observation of the aide's work at the patient's home. */
export const aideSupervisoryAttestationMode = pgEnum("aide_supervisory_attestation_mode", [
  "aide_present",
  "observation_of_work",
]);

/** `volunteer_gate_kind` — the 42 CFR §418.78(b)(1)/(d) per-volunteer compliance postures M17's
 *  pre-schedule gate reads through `VolunteerComplianceProvider` (D7). */
export const volunteerGateKind = pgEnum("volunteer_gate_kind", [
  "background_check",
  "tb_screening",
  "confidentiality_agreement",
  "initial_training",
  "annual_ce",
  "assignment_specific_training",
  "vaccination_status",
]);

/** `volunteer_gate_status` — §2.2.6. `expiring_soon` is derived nightly 30 days ahead of `valid_until`; it
 *  drives the 30/14/7/1-day M36 alerts but does NOT block scheduling. `expired`/`revoked`/`not_yet_satisfied`
 *  all fail the gate (fail-CLOSED per M15-F11). */
export const volunteerGateStatus = pgEnum("volunteer_gate_status", [
  "satisfied",
  "expiring_soon",
  "expired",
  "revoked",
  "not_yet_satisfied",
]);

/** `volunteer_hour_entry_source` — the §2.2.7 ledger numerator sources for the 42 CFR §418.78(e) ratio.
 *  M15-F04: administrative volunteer time gets its OWN typed source (`volunteer_admin_hours`) rather than
 *  being smuggled through `manual_adjustment`; `manual_adjustment` survives as the audited correction path
 *  behind the `volunteer_compliance.adjust_hours` permission (§4.4) and carries `adjustment_reason`. */
export const volunteerHourEntrySource = pgEnum("volunteer_hour_entry_source", [
  "encounter",
  "volunteer_admin_hours",
  "manual_adjustment",
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Module 16 — Bereavement (§3.2 · M16-T01). The CoP 418.64(d) post-death program vocabulary: the D2
// eight-state plan machine, the D1 per-bereaved-person contact machine, the D4 death-date-anchored
// outreach cadence (kind × status × anniversary mark), the D3/D17 deterministic risk rubric's tier /
// score-kind / completeness / confidence bands, and the D7/D9 closure + opt-out taxonomies. The nine
// Drizzle tables land in M16-T02 (`packages/db/src/schema/bereavement/`); the leaf mirrors live in
// `@wardenx/types` (`bereavement.ts`) so M22/M28/M30/M31/M32/M33/M36 read them with no `dependsOn` edge.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `bereavement_plan_status` — the §2.2 / D2 plan-root lifecycle. `eligible` on the `m6.bereavement.eligible`
 *  intake (both source branches per D16), `initiating` once a counselor is assigned, `active` once the roster
 *  + 13-month schedule seed. The three terminal closes are distinct on purpose (survey reconstruction reads
 *  WHY a program ended); `closed_legal_hold_extended` is the M4-driven retention extension that returns to
 *  its original close state on release. */
export const bereavementPlanStatus = pgEnum("bereavement_plan_status", [
  "eligible",
  "initiating",
  "active",
  "paused",
  "closed_completed",
  "closed_declined",
  "closed_early",
  "closed_legal_hold_extended",
]);

/** `bereaved_contact_status` — the §2.3 per-person lifecycle (D1: the CoP obligation is to EACH survivor,
 *  so consent / opt-out / schedule / risk are per-contact). `ineligible_post_review` is the complicated-grief
 *  route-to-external terminal-for-now state, reversible on clinical re-evaluation. */
export const bereavedContactStatus = pgEnum("bereaved_contact_status", [
  "proposed",
  "active",
  "opted_out",
  "deceased",
  "unreachable",
  "ineligible_post_review",
]);

/** `bereaved_contact_relationship` — relationship-to-decedent. M38 owns the authoritative value set (§2.5);
 *  this enum mirrors it for index/integrity locally. */
export const bereavedContactRelationship = pgEnum("bereaved_contact_relationship", [
  "spouse",
  "domestic_partner",
  "parent",
  "child",
  "sibling",
  "grandparent",
  "grandchild",
  "aunt_uncle",
  "cousin",
  "in_law",
  "friend",
  "neighbor",
  "clergy",
  "colleague",
  "caregiver_non_family",
  "other",
]);

/** `bereavement_outreach_kind` — the touchpoint modality. D15 boundary: `in_person_visit` is an M8
 *  encounter (the contact log carries `source_encounter_id`); every other kind is a direct M16 write with a
 *  NULL `source_encounter_id`. */
export const bereavementOutreachKind = pgEnum("bereavement_outreach_kind", [
  "phone_call",
  "in_person_visit",
  "sympathy_card",
  "sympathy_letter",
  "anniversary_letter",
  "email",
  "portal_message",
  "group_support_invitation",
  "external_referral",
]);

/** `bereavement_outreach_status` — the §2.4 scheduled-touchpoint lifecycle. `missed` is the hourly worker's
 *  verdict once `late_grace_until` passes; a `lateAttempt` inside the grace re-opens it to `in_progress`
 *  (audit-flagged, NOT a compliance failure). */
export const bereavementOutreachStatus = pgEnum("bereavement_outreach_status", [
  "scheduled",
  "in_progress",
  "completed",
  "declined",
  "no_response",
  "missed",
  "cancelled",
]);

/** `bereavement_contact_log_outcome` — what actually happened on a touchpoint. Three consecutive
 *  `no_response` rows drive the §2.3 `markUnreachable` proposal; `requested_no_further_contact` is the
 *  counselor-captured opt-out signal (the opt-out row itself is separate). `artifact_rendered` (GAP-130,
 *  mig 0492) is SYSTEM-only: the §4.5 M22 render callback's log row for an auto-completed card/letter. */
export const bereavementContactLogOutcome = pgEnum("bereavement_contact_log_outcome", [
  "engaged",
  "brief_acknowledgement",
  "declined",
  "no_response",
  "voicemail_left",
  "wrong_number",
  "returned_undeliverable",
  "requested_followup",
  "requested_no_further_contact",
  "crisis_referral",
  "artifact_rendered",
]);

/** `bereavement_risk_tier` — the D3 deterministic tier that drives the D4 cadence. The rubric itself only
 *  reaches `high`; `complicated` is a PROMOTION written by a positive complicated-grief screen (D8 / §7.7),
 *  never a weighted-sum outcome. */
export const bereavementRiskTier = pgEnum("bereavement_risk_tier", [
  "low",
  "moderate",
  "high",
  "complicated",
]);

/** `bereavement_risk_score_kind` — D3 hybrid model. The `rule_deterministic` row is the source of truth and
 *  must exist before any `llm_augmented` row for the same `(plan, contact, assessed_at)` (§2.5); the LLM
 *  narrative can never change the tier (AI Governance §7.4). */
export const bereavementRiskScoreKind = pgEnum("bereavement_risk_score_kind", [
  "rule_deterministic",
  "llm_augmented",
]);

/** `bereavement_plan_closure_reason` — why the program ended. The five early-close reasons carry the D7
 *  clinical-supervisor cosign requirement (CHECK-enforced in M16-T02); the two opt-out reasons and the
 *  13-month completion do not. */
export const bereavementPlanClosureReason = pgEnum("bereavement_plan_closure_reason", [
  "thirteen_month_completion",
  "all_contacts_declined",
  "patient_opt_out_pre_death",
  "patient_opt_out_post_creation",
  "tenant_offboarding",
  "all_bereaved_deceased",
  "geographic_relocation",
  "family_legal_action",
  "other_early",
]);

/** `bereavement_opt_out_kind` — D9 per-contact opt-out granularity. Only `full` closes the contact;
 *  `channel_specific` restricts modalities and `pause_temporarily` suspends without closing. */
export const bereavementOptOutKind = pgEnum("bereavement_opt_out_kind", [
  "full",
  "channel_specific",
  "pause_temporarily",
]);

/** `bereavement_plan_pause_kind` — the §2.2 pause taxonomy. A pause cancels future-scheduled outreach;
 *  `resumePlan` regenerates the schedule forward from now to the 13-month ceiling. */
export const bereavementPlanPauseKind = pgEnum("bereavement_plan_pause_kind", [
  "operational",
  "family_request",
  "counselor_unavailable_temp",
]);

/** `bereavement_anniversary_mark` — the D4 milestone an outreach/reminder row belongs to.
 *  `nine_month_high_risk_only` exists only on the elevated-risk (moderate and above) cadence. */
export const bereavementAnniversaryMark = pgEnum("bereavement_anniversary_mark", [
  "one_month",
  "three_month",
  "six_month",
  "nine_month_high_risk_only",
  "anniversary",
]);

/** `bereavement_data_completeness` — D17. How many of the 8 rubric factors were KNOWABLE. M30's HQRP
 *  risk-screening measure filters `minimal` out of its denominator so tenants with many external-source
 *  (transfer-from-hospital) deaths are not penalized for data they could not have had. */
export const bereavementDataCompleteness = pgEnum("bereavement_data_completeness", [
  "complete",
  "partial",
  "minimal",
]);

/** `bereavement_confidence_band` — D17. The band derived from the knowable-factor count, surfaced next to
 *  the score so a counselor can tell a high-confidence low score from a low-confidence one. */
export const bereavementConfidenceBand = pgEnum("bereavement_confidence_band", [
  "HIGH",
  "MEDIUM",
  "LOW",
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Module 21 — Supplies, DME & Comfort Kits (§3.1.1 · M21-T01). The D1 single-`supply_request`-row
// discriminator + its D2 ten-state fulfillment machine, the D4 vendor-routing precedence vocabulary, and
// the controlled-substance chain of custody the DEA 21 CFR §1304 perpetual log projects from: the D6
// dispatch mode / source / schedule, the D17 deployment site, and the D8 return + disposal machine. The
// eleven Drizzle tables land in M21-T02 (`packages/db/src/schema/supplies/`); the leaf mirrors live in
// `@wardenx/types` (`supplies.ts`) so M11/M13/M22/M27/M30/M33/M36/M37 read them with no `dependsOn` edge.
//
// NAMING: M21's SQL enum names carry the spec's `m21_` prefix (§3.1.1 is the normative schema per §3.0 /
// ADR-0023). Unlike every earlier module's unprefixed names this is deliberate — `delivery_method`,
// `return_state`, `dispatch_source` and `disposal_method` are words M18/M24/M37 will each want, and a
// pgEnum name is CLUSTER-global. The TS binding stays descriptive-unprefixed, as elsewhere in this file.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `m21_supply_request_kind` — the D1 shared-row discriminator; selects which per-kind TypeBox validates
 *  `supply_request.data` (`@wardenx/supplies/kinds/*`) and which §2.2 transitions the row may take. M11
 *  signs one order `kind='comfort_kit'`; M21 splits it into `comfort_kit_deploy` (first placement) vs
 *  `comfort_kit_replenish` (M13 drawdown crossed threshold) because only the latter has no M11 order. */
export const supplyRequestKind = pgEnum("m21_supply_request_kind", [
  "dme",
  "supply",
  "comfort_kit_deploy",
  "comfort_kit_replenish",
]);

/** `m21_supply_request_status` — the §2.2 / D2 fulfillment lifecycle. Seven forward states plus the two
 *  cancellation states and the kit-only `returned` branch. `cancellation_pending` exists because a
 *  post-`ordered` cancellation is a REQUEST to the vendor, not a fact: the row keeps its real state until
 *  the vendor confirms (a DME already on the truck cannot be un-shipped by our writing `cancelled`). */
export const supplyRequestStatus = pgEnum("m21_supply_request_status", [
  "requested",
  "vendor_assigned",
  "ordered",
  "in_transit",
  "delivered",
  "received_confirmed",
  "completed",
  "cancelled",
  "cancellation_pending",
  "returned",
]);

/** `m21_deployment_site` — D17. The one discriminator unifying home / ALF / SNF-as-residence / IPU-room
 *  kits behind a single dispatch surface; `ipu_room` is the only value that carries `ipu_room_id` (the
 *  M37 forward seam) and the only one with no patient delivery address. */
export const comfortKitDeploymentSite = pgEnum("m21_deployment_site", [
  "home",
  "alf",
  "snf_residence",
  "ipu_room",
]);

/** `m21_pharmacy_dispatch_mode` — D6. WHO physically fills the kit. `supply_hub_dispatch` is the only
 *  mode with a null vendor (the agency's own DEA-registered hub); the two partner modes carry an M40
 *  Pharmacy reference and differ in whether the prescription routed through M12 DoseSpot first. */
export const pharmacyDispatchMode = pgEnum("m21_pharmacy_dispatch_mode", [
  "supply_hub_dispatch",
  "partner_pharmacy_dispatch",
  "dosespot_to_partner_pharmacy",
]);

/** `m21_fulfillment_mode` — D4. What a resolved `vendor_routing_rule` assigns. `vendor` is the only value
 *  requiring a non-null `assigned_vendor_id` (SQL CHECK); the other three are internal or pharmacy paths
 *  where a null vendor is CORRECT rather than an unresolved routing failure. */
export const supplyFulfillmentMode = pgEnum("m21_fulfillment_mode", [
  "vendor",
  "internal_supply_hub",
  "partner_pharmacy",
  "dosespot_to_partner_pharmacy",
]);

/** `m21_controlled_substance_schedule` — the DEA schedule of a kit medication (21 CFR §1308). Only CII–CV
 *  appear: a CI substance has no accepted medical use and can never be on a comfort-kit line. Presence of
 *  a value is what arms the lot / expiration NOT NULL CHECK and the D8 5% discrepancy rule. */
export const controlledSubstanceSchedule = pgEnum("m21_controlled_substance_schedule", [
  "CII",
  "CIII",
  "CIV",
  "CV",
]);

/** `m21_disposal_method` — D6 / CoP 418.106(f)(3) / DEA 21 CFR §1317. How the kit's remaining controlled
 *  substance stopped existing. `dispose_at_home_by_witnessed_destruction` is the only value requiring a
 *  witness membership distinct from the retriever AND the reconciler (SQL CHECK) — it is the value with
 *  no downstream custodian to corroborate the count. */
export const comfortKitDisposalMethod = pgEnum("m21_disposal_method", [
  "take_back_by_supply_team",
  "dispose_at_home_by_witnessed_destruction",
  "transferred_to_disposing_pharmacy",
]);

/** `m21_return_state` — the §2.6 / D8 chain-of-custody machine on `comfort_kit_return`. `overdue` (30d) and
 *  `unreturnable` (90d) are STATES, not flags, because a kit that never comes back is a survey-reportable
 *  disposition needing an attested reason — not a retrieval still in progress. */
export const comfortKitReturnState = pgEnum("m21_return_state", [
  "requested",
  "assigned",
  "retrieving",
  "retrieved",
  "reconciled",
  "overdue",
  "unreturnable",
]);

/** `m21_routing_scope_kind` — D4. The precedence ladder a `vendor_routing_rule` sits on, most specific
 *  first: `sku` > `location` > `tenant` > `platform`. `platform` is the only scope with a null `org_id`
 *  (SQL CHECK) and the only one tenants may read but never write. */
export const vendorRoutingScopeKind = pgEnum("m21_routing_scope_kind", [
  "sku",
  "location",
  "tenant",
  "platform",
]);

/** `m21_delivery_method` — D7. How the item physically reached the patient, captured with the courier
 *  attestation at the `delivered` transition. Recorded on every kind because the DME liability question
 *  ("who put the hospital bed in the room?") is asked long after the row goes terminal. */
export const supplyDeliveryMethod = pgEnum("m21_delivery_method", [
  "agency_courier",
  "vendor_direct_ship",
  "pharmacy_partner_courier",
  "patient_pickup",
  "in_facility_internal",
]);

/** `m21_dispatch_source` — D6. Which DEA registration the kit left from. Distinct from
 *  `m21_pharmacy_dispatch_mode`: the mode is the ROUTING decision, the source is the physical origin the
 *  1304 perpetual log debits. */
export const comfortKitDispatchSource = pgEnum("m21_dispatch_source", [
  "supply_hub",
  "pharmacy_partner",
  "dosespot_pharmacy",
]);

/** `m21_comfort_kit_dispatch_status` — M21-F04. The dispatch row's own lifecycle, which does NOT track the
 *  parent `supply_request.status`: the request goes terminal (`completed`) at deployment, while the
 *  dispatch stays live for the whole return + reconciliation tail. `reconciled_with_discrepancy` is a
 *  separate terminal from `reconciled` so the survey query is an equality, not a join to the content rows. */
export const comfortKitDispatchStatus = pgEnum("m21_comfort_kit_dispatch_status", [
  "dispatched",
  "deployed_at_patient",
  "partially_returned",
  "fully_returned",
  "reconciled",
  "reconciled_with_discrepancy",
]);

/** `m21_caregiver_signature_capture_method` — F-193 (#248). D7's spec line ("caregiver signature is
 *  optional via M22's signature flow, triggered when policy or tenant config requires it") named a
 *  capture mechanism M22 was never going to build (M22's own spec disclaims signature capture; F-191
 *  dropped the misdeclared `m22` consumer off `m21.supply_request.delivered`). This is M21's OWN capture,
 *  synchronous and always optional — mirrors the SHAPE (not the type; M21's manifest `dependsOn` has no
 *  edge to M39) of `@wardenx/consent`'s proven `ConsentCaptureEvidence.captureMethod`, narrowed to what is
 *  plausible for a courier-delivery caregiver signature: no portal session, no uploaded PDF, no notary —
 *  just typed-in-app, a witnessed verbal account, or an explicit decline (still evidence: "asked, refused"
 *  is worth recording even though nothing downstream gates on it). */
export const supplyCaregiverSignatureCaptureMethod = pgEnum(
  "m21_caregiver_signature_capture_method",
  ["typed_signature_in_app", "witnessed_verbal_documented", "declined"],
);

// ── Module 19 — On-Call Triage (§3.2 Phase A, M19-T01) ───────────────────────────────────────────────
//
// NAMING: M19's §3.2 SQL enum names carry NO `m19_` prefix (unlike M21's §3.1.1, which spells its own
// prefix into the normative DDL). The spec's Phase-A `CREATE TYPE` block is followed verbatim — none of
// the thirteen names collides with an existing type in this file.

/** `oncall_model` — D3. The tenant's after-hours deployment model. Only `direct` is enabled at Phase 1;
 *  `hybrid` and `centralized` are structurally complete behind a per-customer feature flag (default OFF)
 *  until the vendor BAA + PHI-minimization profile clear Compliance. */
export const oncallModel = pgEnum("oncall_model", ["direct", "hybrid", "centralized"]);

/** `oncall_shift_status` — §2.2.2. `scheduled → active → completed | cancelled`. The `scheduled → active`
 *  transition is what pins `on_call_shift.policy_snapshot` (D7) and re-syncs M36's `on_call` channel. */
export const oncallShiftStatus = pgEnum("oncall_shift_status", [
  "scheduled",
  "active",
  "completed",
  "cancelled",
]);

/** `oncall_shift_discipline` — who the shift designates. `external` is the Hybrid/Centralized case where
 *  the recipient is a vendor actor, not a membership; §3.3's `actorIntegrity` CHECK makes the two
 *  mutually exclusive (external ⇒ vendor id set + membership null, and the converse). */
export const oncallShiftDiscipline = pgEnum("oncall_shift_discipline", [
  "clinical_rn",
  "clinical_lpn",
  "medical_director",
  "msw",
  "chaplain",
  "external",
]);

/** `triage_call_state` — §2.2.1 / D6. `documented_pending_encounter` (M19-F06 / ADR-0022) sits between
 *  disposition selection and `documented`: the call parks there while awaiting `m8.encounter.signed` for
 *  `linked_encounter_id` (D8), and it is also where the §2.7 D-B degraded-mode flow strands a call when
 *  the M8 `EncounterCreator` seam is unreachable. */
export const triageCallState = pgEnum("triage_call_state", [
  "open",
  "protocol_in_progress",
  "awaiting_callback",
  "disposition_pending",
  "documented_pending_encounter",
  "documented",
  "escalated_unresolved",
  "abandoned",
  "closed",
]);

/** `triage_call_caller_kind` — who is on the other end. `system_inbound` covers the D10 machine-opened
 *  calls (M17 no-show, M18 late check-out) where no human dialled in. */
export const triageCallCallerKind = pgEnum("triage_call_caller_kind", [
  "patient",
  "caregiver",
  "external_clinician",
  "portal_session",
  "system_inbound",
  "bereaved_family",
]);

/** `triage_call_inbound_channel` — the transport the call arrived on. */
export const triageCallInboundChannel = pgEnum("triage_call_inbound_channel", [
  "phone",
  "sms",
  "email",
  "portal_message",
  "inbound_visit_failure",
  "inbound_evv_anomaly",
  "inbound_alert_failure",
]);

/**
 * `triage_call_source` — what caused the row to exist. Feeds the D10 idempotency guard
 * (`triage_call_source_dedupe_uq` on `source_outbox_event_id`) and the §4.10 `opened` payload.
 *
 * SPEC READ (M19-F08): `paper_origin` is ADDED to the §3.2 Phase-A list. §2.7 step 1 requires the BCP
 * re-entry path to open the call with **`source='paper_origin'`** and `paper_origin_flag=true`; the F08
 * amendment added the two `paper_origin_*` columns to §3.3 but never updated this enum, so following
 * §3.2 verbatim would leave §2.7 unimplementable. The value is additive and breaks nothing; M19-T02
 * carries the CHECK that keeps the flag and the enum value in lock-step so the two cannot disagree.
 */
export const triageCallSource = pgEnum("triage_call_source", [
  "manual",
  "no_show",
  "late_checkout",
  "geofence_anomaly",
  "m36_delivery_failure",
  "paper_origin",
]);

/** `triage_disposition` — D6. The enumerable commitment that ends the call and that every downstream
 *  consumer (M8, M11, M12, M17, M22, M30, M37) acts on. Deliberately NOT free text. */
export const triageDisposition = pgEnum("triage_disposition", [
  "caregiver_education_only",
  "prn_intervention_authorized",
  "verbal_order_recorded",
  "visit_dispatched_now",
  "visit_scheduled_first_light",
  "gip_admission_proposed",
  "ed_transfer_acknowledged",
  "pronouncement_scheduled",
  "escalated_unresolved",
  "abandoned",
]);

/** `triage_escalation_tier` — D7. `tier_5_external` is the only tier whose recipient is a vendor rather
 *  than a membership; §3.3's `recipientIntegrity` CHECK enforces exactly one of the two per row. */
export const triageEscalationTier = pgEnum("triage_escalation_tier", [
  "tier_1_rn_supervisor",
  "tier_2_clinical_manager",
  "tier_3_medical_director",
  "tier_4_compliance_officer",
  "tier_5_external",
]);

/** `triage_escalation_trigger` — why the escalation row exists. `mandatory_protocol` and
 *  `red_flag_question` are the two the server writes itself (D5/D7); a tenant cannot suppress either. */
export const triageEscalationTrigger = pgEnum("triage_escalation_trigger", [
  "manual",
  "red_flag_question",
  "mandatory_protocol",
  "sla_breach",
]);

/** `triage_protocol_answer_type` — the shape of one protocol question's answer. Selects which of
 *  `triage_call_answer`'s three typed value columns the server writes (D5 evaluates the red-flag match
 *  against that column, never against a client-supplied flag). */
export const triageProtocolAnswerType = pgEnum("triage_protocol_answer_type", [
  "boolean",
  "integer",
  "scale_0_10",
  "free_text",
  "enum",
]);

/** `triage_risk_band` — D11. The M32 hospitalization-risk advisory band. ADVISORY ONLY: it gates
 *  nothing, alters no disposition option, and is excluded from the M31 portal projection. */
export const triageRiskBand = pgEnum("triage_risk_band", ["low", "medium", "high"]);

/** `triage_ai_confidence` — D12. The band M32's protocol suggestion arrived with. Below the governance
 *  floor the suggestion is still SHOWN (de-emphasized) and still never auto-applied. */
export const triageAiConfidence = pgEnum("triage_ai_confidence", ["low", "medium", "high"]);

// ── Module 20 — Field Safety (§3.2 Phase A, M20-T01) ─────────────────────────────────────────────────
//
// NAMING: like M19's, M20's §3.2 Phase-A `CREATE TYPE` block spells its SQL type names WITHOUT a module
// prefix (unlike M21's §3.1.1, which spells `m21_` into the normative DDL). The block is followed
// verbatim — none of the twelve names collides with an existing type in this file.
//
// §3.3 declares the COLUMNS that carry these vocabularies as `text` with a trailing comment naming the
// enum. §3.2 Phase A is the authority for which vocabularies become a real pg type; M20-T02 binds the
// columns to the types below. The seven vocabularies §3.3 spells inline and Phase A does NOT create
// (`cancel_biometric_result`, the SOS `outcome`, the acknowledgment `outcome`, `scope_kind`,
// `alert_kinds`, `policy_for_visits_to_area`, `consent_purpose`) stay text + CHECK, and live as leaf
// unions in `@wardenx/types`' `safety.ts` — adding pg types the spec never declared would be this
// module inventing DDL.

/** `safety_check_in_kind` — §1.1 / D2. The discriminator that makes a check-in a discrete EVENT rather
 *  than a timer state: `pre_visit` / `mid_visit` / `post_visit` bracket a visit (and REQUIRE a
 *  `visit_id`), `between_visits` and `ad_hoc` stand alone. */
export const safetyCheckInKind = pgEnum("safety_check_in_kind", [
  "pre_visit",
  "mid_visit",
  "post_visit",
  "between_visits",
  "ad_hoc",
]);

/** `safety_check_in_status` — the clinician's own attestation. The two `concerned_*` values require a
 *  `concern_note` ≥20 chars (§2.3 CHECK) and route the row to `compliance` retention (§3.7) — the
 *  routine "I'm OK" is `operational` and is purged. */
export const safetyCheckInStatus = pgEnum("safety_check_in_status", [
  "ok",
  "concerned_continue",
  "concerned_stop",
]);

/** `safety_check_in_state` — §2.2.1. The state lives on the SCHEDULE row for `proposed`/`overdue`/
 *  `escalated` and on the check-in row for `recorded`/`superseded`; `incident_opened` is the terminus
 *  where a supervisor opened an incident on the clinician's behalf. */
export const safetyCheckInState = pgEnum("safety_check_in_state", [
  "proposed",
  "recorded",
  "overdue",
  "escalated",
  "superseded",
  "incident_opened",
]);

/**
 * `safety_sos_lifecycle_state` — §2.2.2.
 *
 * `emergency_terminus` is ADDED to the spec's §3.2 Phase-A block. §2.2.2 and the M20-F05 / S13 /
 * INT-031 remediation make it the mandated end of the life-safety chain — the state a tier-3 SLA breach
 * with no acknowledgment enters, which auto-dials the consented emergency contact, surfaces the M40 PSAP
 * number to every recipient, pages WardenX ops, and KEEPS re-escalating until a human acknowledges. The
 * amendment added the state to the state machine, §8.8's audit catalog and the `m20_sos_terminus_reached_total`
 * metric, and never updated the `CREATE TYPE` block it came from. Following Phase A verbatim would leave
 * the terminus unwritable and an unacknowledged 3 a.m. SOS sitting in `escalation_tier_3` forever, which
 * is the exact failure S13 exists to close.
 */
export const safetySosLifecycleState = pgEnum("safety_sos_lifecycle_state", [
  "raised",
  "cancel_window_open",
  "acknowledging",
  "acknowledged",
  "escalation_tier_1",
  "escalation_tier_2",
  "escalation_tier_3",
  "emergency_terminus",
  "resolving",
  "resolved",
  "cancelled_in_window",
  "cancel_attempted_but_rejected",
  "incident_opened",
]);

/** `safety_sos_cancel_status` — D5. `cancel_attempted_but_rejected` is the hostile-actor signal: the
 *  cancel was pressed, the biometric did not pass, and the alert PROCEEDS as if no cancel happened. */
export const safetySosCancelStatus = pgEnum("safety_sos_cancel_status", [
  "not_cancelled",
  "cancelled_in_window",
  "cancel_attempted_but_rejected",
]);

/** `safety_incident_category` — §1.1. The structured taxonomy an OSHA-equivalent state filing and a
 *  workers-comp carrier both read; `near_miss` is deliberately in the same enum as `physical_assault`
 *  because the near-miss is the one a safety program is supposed to act on BEFORE the assault. */
export const safetyIncidentCategory = pgEnum("safety_incident_category", [
  "physical_assault",
  "verbal_assault",
  "threatened",
  "dog_bite",
  "animal_other",
  "vehicle_accident_on_duty",
  "theft_during_visit",
  "medical_emergency_clinician_self",
  "weather_emergency",
  "environmental_hazard",
  "near_miss",
  "other",
]);

/** `safety_incident_severity` — clinician-attested at report, supervisor-adjustable while `under_review`
 *  (§2.2.3). Feeds the D9 `osha_reportable` default heuristic, which a supervisor must still sign off. */
export const safetyIncidentSeverity = pgEnum("safety_incident_severity", [
  "minor",
  "moderate",
  "serious",
  "life_threatening",
]);

/** `safety_incident_state` — §2.2.3. `reopened` exists so new evidence does not force a second incident
 *  row that breaks the workers-comp timeline; it re-enters `under_review`. */
export const safetyIncidentState = pgEnum("safety_incident_state", [
  "draft",
  "submitted",
  "under_review",
  "returned_to_clinician",
  "closed_with_action_plan",
  "closed_no_action",
  "reopened",
]);

/** `safety_high_risk_category` — D12. The polygon is ADVISORY in every category: it never blocks a
 *  visit, it surfaces a warning and (per tenant policy) makes the pre-visit check-in mandatory. */
export const safetyHighRiskCategory = pgEnum("safety_high_risk_category", [
  "documented_prior_incident",
  "community_self_reported_unsafe",
  "nighttime_only_advisory",
  "weather_advisory_seasonal",
  "general_caution",
]);

/** `safety_subscription_model` — D8. The TENANT-WIDE default model on `safety_policy_version`. Distinct
 *  from a subscription row's own `scope_kind`: the model says how rows are generated by default, the
 *  scope kind says what one existing row covers. */
export const safetySubscriptionModel = pgEnum("safety_subscription_model", [
  "location_scoped",
  "provider_entity_scoped",
  "role_scoped",
  "explicit_only",
]);

/** `safety_acknowledgment_target_kind` — §2.2.6. Exactly one of the three target FK columns is non-null,
 *  and this column says which (the CHECK and the reader both key off it). */
export const safetyAcknowledgmentTargetKind = pgEnum("safety_acknowledgment_target_kind", [
  "sos_alert",
  "incident",
  "overdue_check_in",
]);

/** `safety_emergency_contact_consent_status` — §2.2.8 / D10. `expired` is a tenant consent-rotation
 *  outcome and is NOT `revoked`: the clinician never withdrew consent, the acknowledgment aged out, and
 *  the two must stay distinguishable in a coercion review. */
export const safetyEmergencyContactConsentStatus = pgEnum(
  "safety_emergency_contact_consent_status",
  ["granted", "revoked", "expired"],
);

// ── Module 32 (AI Platform) — §3.1 enums (M32-T01) ────────────────────────────────────────────────
//
// The spec puts these in `packages/db/src/schema/ai-platform/enums.ts`; the repo defines every pgEnum
// exactly once HERE (the file header's ADR-0022 D1.3 rule that `check-ddl-legality.ts` enforces), so
// they resolve on the path the gates actually govern. M32-T02 binds the columns to the types below and
// emits the `CREATE TYPE` statements; the value mirrors a consumer reads live in `@wardenx/types`'
// `ai-platform.ts`, kept in lock-step with these tuples by an M32-T01 test.
//
// §3.1 declares TWENTY-ONE enums; the vocabularies §3.2 spells inline on `text` columns
// (`ai_model_backend.zdr_status`, `ai_routing_override.override_reason`,
// `ai_hallucination_report.triage_disposition`, `ai_tenant_opt_in_record.routing_preference_snapshot`,
// `ai_prompt_template.output_entity_target_prefix` / `output_type_prefix`, the `actor_role` /
// `reporter_role` free-text columns) stay text + CHECK and live as leaf unions in `@wardenx/types` —
// adding pg types §3.1 never declared would be this module inventing DDL.

/** `ai_capability_lifecycle_state` — D2's eight-state governance FSM. The ORDER is the promotion
 *  ladder; `packages/ai-platform`'s state machine is the authority on which edges are legal. */
export const aiCapabilityLifecycleState = pgEnum("ai_capability_lifecycle_state", [
  "PROPOSED",
  "DESIGN_REVIEW",
  "EVALUATION",
  "PILOT",
  "APPROVED",
  "MONITORING",
  "DEPRECATED",
  "RETIRED",
]);

/** `ai_capability_risk_tier` — AI Governance §4.2. `high` forces tenant opt-in + clinical review. */
export const aiCapabilityRiskTier = pgEnum("ai_capability_risk_tier", ["high", "medium", "low"]);

/** `ai_capability_owning_role` — who signs a lifecycle transition. Doubles as
 *  `ai_capability_lifecycle_event.actor_role`, so the ledger cannot record a transition signed by a
 *  role that is not one of the four accountable governance roles. */
export const aiCapabilityOwningRole = pgEnum("ai_capability_owning_role", [
  "ai_safety_owner",
  "clinical_reviewer",
  "ai_engineer",
  "privacy_officer",
]);

/** `ai_fda_samd_classification` — Software-as-a-Medical-Device posture. `not_samd` is the Phase-1
 *  value for every registered capability; the column exists so a future clinical-decision capability
 *  cannot be registered without stating its classification. */
export const aiFdaSamdClassification = pgEnum("ai_fda_samd_classification", [
  "class_i",
  "class_ii",
  "class_iii",
  "class_iv",
  "not_samd",
]);

/** `ai_model_backend_kind` — the D19/D17 fork. `cloud` requires a BAA + ZDR (the §3.2.4
 *  `cloudBaaCheck`); `local` requires license terms + an artifact reference (`localLicenseCheck`). */
export const aiModelBackendKind = pgEnum("ai_model_backend_kind", ["cloud", "local"]);

/** `ai_backend_health_status` — `unknown` is the registered-but-never-probed state and is DISTINCT
 *  from `unhealthy`: a backend nobody has reached yet must not read as one that answered badly. */
export const aiBackendHealthStatus = pgEnum("ai_backend_health_status", [
  "healthy",
  "degraded",
  "unhealthy",
  "unknown",
]);

/** `ai_prompt_template_status` — D3. Only `active` is resolvable by `AIPromptRegistry`; `deprecated`
 *  and `archived` stay readable so a 2031 audit can reconstruct the template a 2026 invocation used. */
export const aiPromptTemplateStatus = pgEnum("ai_prompt_template_status", [
  "active",
  "deprecated",
  "archived",
]);

/** `ai_tenant_opt_in_status` — §3.2.6 defaults to `opted_out`: the row's EXISTENCE is not consent. */
export const aiTenantOptInStatus = pgEnum("ai_tenant_opt_in_status", [
  "active",
  "paused",
  "opted_out",
]);

/** `ai_invocation_status` — `capability_unavailable` is a RECORDED outcome, not an absent row: a gate
 *  refusal is itself the §164.528 evidence that no PHI left the platform. */
export const aiInvocationStatus = pgEnum("ai_invocation_status", [
  "completed",
  "failed",
  "timed_out",
  "killed",
  "capability_unavailable",
]);

/** `ai_invocation_hitl_outcome` — the human-in-the-loop decision. `pending` is the insert default and
 *  the ONLY column §3.5's immutability trigger lets a consumer module update after the fact. */
export const aiInvocationHitlOutcome = pgEnum("ai_invocation_hitl_outcome", [
  "accepted",
  "edited",
  "rejected",
  "pending",
  "not_applicable",
]);

/** `ai_routing_decision` — WHICH link of the capability's chain served the call. */
export const aiRoutingDecision = pgEnum("ai_routing_decision", [
  "primary",
  "fallback_1",
  "fallback_2",
]);

/** `ai_routing_reason` — WHY that link served it. §3.1 adds `cost_cap_fallback` beyond the four the
 *  §2.1 ERD lists, so D7's hard-cap fallback is distinguishable from a vendor outage in the ledger. */
export const aiRoutingReason = pgEnum("ai_routing_reason", [
  "default",
  "tenant_override",
  "kill_switch_fallback",
  "vendor_outage_fallback",
  "cost_cap_fallback",
]);

/** `ai_hallucination_severity` — `critical` is the D16 SEV-1 trigger: platform-wide kill + automatic
 *  demotion to DEPRECATED within 60 seconds. */
export const aiHallucinationSeverity = pgEnum("ai_hallucination_severity", [
  "critical",
  "high",
  "medium",
  "low",
]);

/** `ai_hallucination_kind` — §3.1 adds `fake_clinical_recommendation` beyond the §2.1 ERD list. */
export const aiHallucinationKind = pgEnum("ai_hallucination_kind", [
  "fabricated_medication",
  "misattributed_symptom",
  "fake_diagnosis",
  "fabricated_quote",
  "misquoted_patient",
  "wrong_dose",
  "fake_clinical_recommendation",
  "other",
]);

/** `ai_hallucination_triage_status` — D9's queue. `escalated_to_clinical_safety` is a TERMINAL status
 *  for M32 and an OPEN one for the clinical-safety committee; it is not `closed`. */
export const aiHallucinationTriageStatus = pgEnum("ai_hallucination_triage_status", [
  "open",
  "investigating",
  "root_cause_identified",
  "mitigated",
  "closed",
  "escalated_to_clinical_safety",
]);

/** `ai_evaluation_run_stage` — which governance gate the run is evidence for (D10). */
export const aiEvaluationRunStage = pgEnum("ai_evaluation_run_stage", [
  "stage_3_evaluation",
  "stage_4_pilot",
  "reapproval",
  "drift_response",
  "post_incident",
]);

/** `ai_evaluation_run_status` — the run's own lifecycle, distinct from its `decision`. */
export const aiEvaluationRunStatus = pgEnum("ai_evaluation_run_status", [
  "pending",
  "in_progress",
  "passed",
  "failed",
  "aborted",
]);

/** `ai_evaluation_run_decision` — §3.1 adds `no_decision` (the §3.2.11 insert default) so a `pending`
 *  run is not forced to claim an outcome it has not reached. */
export const aiEvaluationRunDecision = pgEnum("ai_evaluation_run_decision", [
  "approve_for_pilot",
  "approve_for_ga",
  "reject",
  "recalibrate_thresholds",
  "no_decision",
]);

/** `ai_kill_switch_reason` — D8. §3.1 adds `lifecycle_demotion` beyond the §2.1 ERD list: the switch
 *  D16 trips automatically when a capability is demoted needs a reason distinct from the human ones. */
export const aiKillSwitchReason = pgEnum("ai_kill_switch_reason", [
  "sev1_hallucination",
  "sev2_hallucination",
  "cost_cap_reached",
  "vendor_outage_exceeded_sla",
  "prompt_injection_detected",
  "manual_safety_pause",
  "misuse_detected",
  "bias_drift_severe",
  "lifecycle_demotion",
]);

/** `ai_kill_switch_activation_actor_kind` — WHO tripped it; §3.1 adds the two automated monitors the
 *  §2.1 ERD omits. Reused for `deactivation_actor_kind`, which is why an automated kind must stay
 *  expressible on the way OUT as well as the way in. */
export const aiKillSwitchActivationActorKind = pgEnum("ai_kill_switch_activation_actor_kind", [
  "ai_safety_owner",
  "incident_commander",
  "automated_cost_watch",
  "automated_drift_monitor",
  "automated_vendor_health_monitor",
  "automated_lifecycle_demotion",
]);

/** `ai_lifecycle_approval_kind` — the governance gate a lifecycle event is the record of. The kind
 *  names the STAGE, not the outcome: an EVALUATION→PROPOSED rejection and an EVALUATION→PILOT
 *  approval are both `stage_3_evaluation`, distinguished by `from_state`/`to_state`. */
export const aiLifecycleApprovalKind = pgEnum("ai_lifecycle_approval_kind", [
  "stage_1_proposal",
  "stage_2_design_review",
  "stage_3_evaluation",
  "stage_4_pilot",
  "stage_5_ga",
  "reapproval",
  "deprecation",
  "retirement",
  "incident_demotion",
]);

// ── Module 28 (FHIR Gateway) — §3.2 Phase-A enums (M28-T01) ────────────────────────────────────────
//
// The spec's §3.3 code block imports these from `packages/db/src/schema/fhir/enums.ts`; the repo defines
// every pgEnum exactly once HERE (the file header's ADR-0022 D1.3 rule that `check-ddl-legality.ts`
// enforces), so they resolve on the path the gates govern. M28-T02 binds the eight owned tables' enum
// columns to these and emits the `CREATE TYPE` statements in `0028_fhir_gateway.sql` Phase A; the value
// mirrors a consumer reads live in `@wardenx/types`' `fhir.ts`, kept in lock-step by an M28-T01 test.
//
// §3.2 declares TEN enums. Vocabularies the spec spells inline on `text` columns — the SMART/OAuth
// `scopes` (`fhir_client.allowed_scopes[]`, whose closed set is `SUPPORTED_SCOPES` in
// `packages/fhir/src/auth/scopes.ts`, not a pg type), the FHIR `resource_type` on projections, and the
// `owner_module`-agnostic search parameters — stay text and live as leaf unions in `@wardenx/types`.

/** `fhir_client_type` — the credential family a client authenticates with. Phase 1 onboards both, but
 *  §2.2 ships only `api_key` credential rows; `smart_backend_services` pins a `jwks_uri` (§2.3). */
export const fhirClientType = pgEnum("fhir_client_type", ["smart_backend_services", "api_key"]);

/** `fhir_client_tier` — the rate-limit class. The platform floor is per-tier (tier-1 100 / tier-2 10 /
 *  tier-3 1 RPS, §2.3); a tenant may TIGHTEN below the floor, never loosen above it. */
export const fhirClientTier = pgEnum("fhir_client_tier", ["tier-1", "tier-2", "tier-3"]);

/** `fhir_client_status` — the §2.2 onboarding FSM. `pending_approval → active` needs TWO distinct
 *  memberships (Org Admin + Compliance Officer, D12); `revoked` is terminal + tombstoned in audit. */
export const fhirClientStatus = pgEnum("fhir_client_status", [
  "pending_approval",
  "active",
  "suspended",
  "revoked",
  "rejected",
]);

/** `fhir_client_credential_kind` — `api_key` ships in Phase 1; `jwks_pin` is the future option to pin a
 *  specific JWK by `kid` rather than rely on `jwks_uri` rotation (§2.2). */
export const fhirClientCredentialKind = pgEnum("fhir_client_credential_kind", [
  "api_key",
  "jwks_pin",
]);

/** `fhir_client_credential_status` — rotation retires the prior row and opens a 30-day overlap window in
 *  which both verify, then the prior is destruction-erased per M4 (§2.2). */
export const fhirClientCredentialStatus = pgEnum("fhir_client_credential_status", [
  "active",
  "retired",
]);

/** `fhir_bulk_export_status` — the §2.2 async-export FSM. `completed` mints output URLs with a 24h TTL;
 *  a sweeper walks `completed → expired` and purges the MinIO NDJSON. */
export const fhirBulkExportStatus = pgEnum("fhir_bulk_export_status", [
  "accepted",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

/** `fhir_bulk_export_request_kind` — which `$export` variant the job serves (system / Group / Patient). */
export const fhirBulkExportRequestKind = pgEnum("fhir_bulk_export_request_kind", [
  "system",
  "group",
  "patient",
]);

/** `fhir_inbound_status` — the §2.2 staged-proposal FSM. The owner module's reviewer is the only actor
 *  authorized to accept/reject (D8); SLA breach walks `pending → expired` and fires an M36 alert (D12). */
export const fhirInboundStatus = pgEnum("fhir_inbound_status", [
  "pending",
  "accepted",
  "rejected",
  "expired",
]);

/** `fhir_inbound_owner_module` — the WardenX module that owns the native write on acceptance. Phase 1
 *  routes Patient demographics → M5 and MedicationStatement → M12 (§2.3 `KNOWN_OWNER_MODULES`). */
export const fhirInboundOwnerModule = pgEnum("fhir_inbound_owner_module", ["m5", "m12"]);

/** `fhir_version_enum` — the FHIR release a capability snapshot advertises. Phase 1 serves `4.0.1`
 *  (US Core R4); `5.0.0`/`6.0.0` are the compile-shell targets that ship at their respective locks. */
export const fhirVersionEnum = pgEnum("fhir_version_enum", ["4.0.1", "5.0.0", "6.0.0"]);
// ── M31 Patient/Family Portal & Telehealth (§3.3, M31-T02) ──────────────────────────────────────────
// The five pgEnums backing the manifest's THREE owned tables (portal_account, portal_access_grant,
// telehealth_visit). The value lists mirror `@wardenx/types` `packages/types/src/portal.ts` (the T01
// leaf contract) VERBATIM so the wire union and the DB enum cannot drift. The spec's text columns
// (`revoke_cascade_source`, `scheduled_visit_setting`, `end_reason`) stay `text` — they are validated at
// the write boundary against the corresponding T01 union, not pinned as pgEnums (§3.3).

/** §2.1/§3.3 `portal_account_relationship` — who the account holder is to the patient (D2). */
export const portalAccountRelationship = pgEnum("portal_account_relationship", [
  "patient_self",
  "family_caregiver",
  "dpoa_healthcare_agent",
  "personal_representative_post_death",
  "bereaved_family_member",
]);

/** §2.2.1/§3.3 `portal_account_status` — the account lifecycle (`bereaved` is the D4 lateral flip). */
export const portalAccountStatus = pgEnum("portal_account_status", [
  "invited",
  "active",
  "suspended",
  "revoked",
  "bereaved",
]);

/** §2.2.2/§3.3 `portal_access_grant_kind` — the per-patient grant class (D5/D6/D7). */
export const portalAccessGrantKind = pgEnum("portal_access_grant_kind", [
  "family_caregiver",
  "dpoa_healthcare",
  "patient_self",
  "personal_representative",
  "bereaved_family",
]);

/** §2.2.3/§3.3 `telehealth_lifecycle_state` — the visit/room state machine (D8/D14). */
export const telehealthLifecycleState = pgEnum("telehealth_lifecycle_state", [
  "room_minted",
  "patient_joined",
  "clinician_joined",
  "in_progress",
  "ended_clean",
  "ended_aborted",
  "reconciled",
]);

/** §3.3 `telehealth_vendor` — the adapter behind a room (Daily.co default per D1). */
export const telehealthVendor = pgEnum("telehealth_vendor", [
  "daily_co",
  "twilio_video",
  "native_webrtc",
]);

// ── Module 35 (Subscription Billing) — §3.3 the fourteen enum types (M35-T02) ──────────────────────────
//
// The spec §3.3 code block imports these from `packages/subscription-billing/src/schema/enums.ts`; the
// repo defines every pgEnum ONCE in this central @wardenx/db enums surface (check-ddl-legality bans
// duplicate pgEnum definitions, ADR-0022 D1.3), so they resolve on the path the gates govern. The value
// tuples MIRROR `@wardenx/subscription-billing`'s `enums.ts` (each pinned there with
// `as const satisfies readonly <LeafUnion>[]` against `@wardenx/types`), kept in lock-step so the two
// definition sites cannot drift (the M30 "wire enum as Type.String()" precedent). Migrations 0140–0142
// emit the matching `CREATE TYPE`s; RLS/grants + the M4 write-audit triggers land in 0143.

/** `plan_tier` — the pricing tier a plan belongs to (§2.1). */
export const planTier = pgEnum("plan_tier", ["starter", "professional", "enterprise"]);

/** `billing_cadence` — monthly vs annual billing period. */
export const billingCadence = pgEnum("billing_cadence", ["monthly", "annual"]);

/** `subscription_status` — the §2.2 subscription lifecycle FSM. */
export const subscriptionStatus = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "at_risk",
  "suspended",
  "canceled",
  "paused",
]);

/** `dunning_stage` — the §4.15 dunning state machine (D7). */
export const dunningStage = pgEnum("dunning_stage", [
  "none",
  "day_1",
  "day_7",
  "day_14",
  "day_21",
  "day_28_suspend",
  "day_60_cancel",
  "resolved",
]);

/** `invoice_status` — mirrors Stripe's invoice lifecycle. */
export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
]);

/** `invoice_line_kind` — the category of an invoice line. */
export const invoiceLineKind = pgEnum("invoice_line_kind", [
  "subscription",
  "metered",
  "one_time",
  "tax",
  "discount",
  "credit",
  "proration",
]);

/** `refund_status` — the §D16 four-stage refund workflow FSM. */
export const refundStatus = pgEnum("refund_status", [
  "requested",
  "approved",
  "denied",
  "executed_success",
  "executed_failed",
]);

/** `refund_kind` — the shape of a refund. */
export const refundKind = pgEnum("refund_kind", ["full", "partial", "credit_only"]);

/** `promo_kind` — how a promo code discounts. */
export const promoKind = pgEnum("promo_kind", ["percent_off", "amount_off"]);

/** `promo_duration` — how long a promo applies. */
export const promoDuration = pgEnum("promo_duration", ["once", "repeating", "forever"]);

/** `payment_method_kind` — the Stripe payment-method family. */
export const paymentMethodKind = pgEnum("payment_method_kind", [
  "card",
  "us_bank_account",
  "sepa_debit",
  "other",
]);

/** `usage_event_type` — the metered usage dimensions (§4.4/§4.12). */
export const usageEventType = pgEnum("usage_event_type", [
  "active_patient",
  "active_user",
  "claim_submitted_medicare",
  "claim_submitted_medicaid",
  "ai_tokens_consumed",
  "fhir_egress_request",
  "hl7_message_inbound",
  "hl7_message_outbound",
]);

/** `usage_event_source_module` — which WardenX module emitted a usage event. */
export const usageEventSourceModule = pgEnum("usage_event_source_module", [
  "m1",
  "m2",
  "m5",
  "m23",
  "m24",
  "m28",
  "m29",
  "m32",
]);

/** `inactivity_reason` — why a patient/user active period ended (§3.3 patient_active_period). */
export const inactivityReason = pgEnum("inactivity_reason", [
  "discharged",
  "died",
  "revoked",
  "transferred",
]);

// ─────────────────────────────────────────────────────────────────────────────
// M37 Inpatient Unit (IPU) Management — §3.2 (23 enums). Value tuples MIRROR the
// leaf union types in packages/inpatient/src/enums.ts (single definition site here;
// ddl-legality bans duplicate pgEnum). None collide with existing billing/clinical enums.
// ─────────────────────────────────────────────────────────────────────────────

/** `ipu_room_kind` — room class within a unit (§3.2). */
export const ipuRoomKind = pgEnum("ipu_room_kind", [
  "private",
  "semi_private",
  "family",
  "shared_overflow",
]);

/** `ipu_bed_cleaning_status` — bed turnover state machine (§2.12 D13). */
export const ipuBedCleaningStatus = pgEnum("ipu_bed_cleaning_status", [
  "ready",
  "reserved",
  "occupied",
  "discharged_dirty",
  "cleaning",
  "retired",
]);

/** `ipu_admission_kind` — GIP vs IRC vs arranged-inpatient (§2.2). */
export const ipuAdmissionKind = pgEnum("ipu_admission_kind", ["gip", "irc", "arranged"]);

/** `ipu_admission_state` — admission lifecycle (§2.2 D2). */
export const ipuAdmissionState = pgEnum("ipu_admission_state", [
  "pending",
  "bed_pending",
  "bed_assigned",
  "active",
  "transferring",
  "transferred",
  "discharged",
  "deceased",
  "closed",
]);

/** `ipu_admission_transition_kind` — transfer/discharge transition taxonomy (§2.2). */
export const ipuAdmissionTransitionKind = pgEnum("ipu_admission_transition_kind", [
  "to_unit",
  "to_home",
  "to_facility",
  "to_other_hospice",
  "revocation",
  "expired_benefit",
]);

/** `ipu_shift_role` — role a membership fills on a shift (§2.3). */
export const ipuShiftRole = pgEnum("ipu_shift_role", [
  "charge_rn",
  "rn",
  "np_in_rn_role",
  "lpn",
  "cna",
  "unit_secretary",
  "housekeeping",
  "pharmacist",
  "social_worker_in_unit",
  "chaplain_in_unit",
  "medical_director_in_unit",
]);

/** `ipu_shift_assignment_state` — staff-assignment lifecycle (§2.3). */
export const ipuShiftAssignmentState = pgEnum("ipu_shift_assignment_state", [
  "tentative",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
]);

/** `gip_criterion_kind` — GIP admission-criterion discriminator (§2.4 D4). */
export const gipCriterionKind = pgEnum("gip_criterion_kind", [
  "acute_symptom_management",
  "imminent_death_terminal_care",
  "medications_treatments_inpatient_only",
]);

/** `irc_episode_state` — 5-day IRC cap lifecycle (§2.5 D6). */
export const ircEpisodeState = pgEnum("irc_episode_state", [
  "active",
  "approaching_cap",
  "breached",
  "closed",
]);

/** `ipu_restraint_kind` — restraint device class (§2.10 D11). */
export const ipuRestraintKind = pgEnum("ipu_restraint_kind", [
  "soft_limb",
  "posey_vest",
  "mitt",
  "side_rail_4",
]);

/** `ipu_restraint_event_state` — restraint application state (§2.10). */
export const ipuRestraintEventState = pgEnum("ipu_restraint_event_state", ["active", "released"]);

/** `ipu_restraint_reassessment_outcome` — restraint reassessment decision (§2.10). */
export const ipuRestraintReassessmentOutcome = pgEnum("ipu_restraint_reassessment_outcome", [
  "continue",
  "modify",
  "release",
]);

/** `ipu_visitor_relationship` — visitor relationship to patient (§2.7 D8). */
export const ipuVisitorRelationship = pgEnum("ipu_visitor_relationship", [
  "spouse",
  "parent",
  "child",
  "sibling",
  "grandparent",
  "grandchild",
  "in_law",
  "aunt_uncle",
  "cousin",
  "friend",
  "clergy",
  "volunteer",
  "caregiver_paid",
  "legal_representative",
  "other",
]);

/** `ipu_visitor_restriction_scope` — unit-wide vs per-patient restriction (§2.7). */
export const ipuVisitorRestrictionScope = pgEnum("ipu_visitor_restriction_scope", [
  "unit",
  "patient",
]);

/** `ipu_visitor_restriction_kind` — restriction severity (§2.7). */
export const ipuVisitorRestrictionKind = pgEnum("ipu_visitor_restriction_kind", [
  "full_block",
  "immediate_family_only",
  "mask_required",
  "time_limited",
  "no_overnight",
]);

/** `ipu_meal_slot` — meal service slot (§2.8). */
export const ipuMealSlot = pgEnum("ipu_meal_slot", ["breakfast", "lunch", "dinner", "snack"]);

/** `ipu_equipment_type` — durable/biomed equipment class (§2.9 D10). */
export const ipuEquipmentType = pgEnum("ipu_equipment_type", [
  "hospital_bed",
  "oxygen_concentrator",
  "suction_machine",
  "iv_pump",
  "bipap",
  "cpap",
  "lift",
  "scale",
  "vitals_monitor",
  "comfort_mattress",
  "low_air_loss_mattress",
]);

/** `ipu_equipment_location_kind` — where a piece of equipment currently sits (§2.9). */
export const ipuEquipmentLocationKind = pgEnum("ipu_equipment_location_kind", [
  "unit",
  "room",
  "bed",
  "storage",
  "sent_for_repair",
  "retired",
]);

/** `ipu_equipment_status` — equipment lifecycle status (§2.9). */
export const ipuEquipmentStatus = pgEnum("ipu_equipment_status", [
  "active",
  "maintenance",
  "retired",
  "lost",
  "sent_for_repair",
]);

/** `ipu_equipment_inspection_kind` — biomed inspection type (§2.9 D10). */
export const ipuEquipmentInspectionKind = pgEnum("ipu_equipment_inspection_kind", [
  "annual_biomed",
  "per_use_safety",
  "post_repair_safety",
  "recall_response",
]);

/** `ipu_equipment_inspection_outcome` — inspection result (§2.9). */
export const ipuEquipmentInspectionOutcome = pgEnum("ipu_equipment_inspection_outcome", [
  "pass",
  "fail",
  "conditional_pass",
  "retired",
]);

/** `ipu_body_release_state` — post-mortem body-release coordination (§2.11 D12). */
export const ipuBodyReleaseState = pgEnum("ipu_body_release_state", [
  "pending",
  "funeral_home_identified",
  "released",
  "closed",
]);

/** `ipu_remote_arrangement_billing_basis` — arranged-inpatient billing basis (CoP 418.112). */
export const ipuRemoteArrangementBillingBasis = pgEnum("ipu_remote_arrangement_billing_basis", [
  "bundled",
  "per_diem_passthrough",
]);

/** `credential_discipline` — GAP-093, `membership_credential.credential_type`. Mirrors M17's
 *  `SchedulingDiscipline` vocab (`packages/scheduling/src/policy.ts`) — an active credential of a
 *  discipline is what the D8 `clinician_credentials_active` pre-schedule gate checks for, alongside
 *  (not instead of) the `discipline_matches_visit` RBAC-role check. */
export const credentialDiscipline = pgEnum("credential_discipline", [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "volunteer",
  /** PHYSICIAN — MD *or* DO. The two are the same level with the same scope, and this codebase has
   *  always treated them as one value (`VISIT_PURPOSE_DISCIPLINES` documents its physician-intent
   *  purposes as "MD/DO or NP" while listing `md`). `issuing_body` records which board issued it. */
  "md",
  "np",
  /** Physician Assistant — a distinct licence BELOW MD/DO, added by 0221 (F-030). Not in any
   *  `VISIT_PURPOSE_DISCIPLINES` list: holding the licence is not visit authority, and the Medicare
   *  hospice face-to-face encounter is physician-or-NP only (42 CFR 418.22(a)(4)). */
  "pa",
]);

/** `credential_status` — GAP-093. `active` is the only status the D8 gate accepts; `suspended`/
 *  `revoked` both fail it (fail-closed) but are kept distinct for the audit trail (why access
 *  stopped, not just that it did). */
export const credentialStatus = pgEnum("credential_status", ["active", "suspended", "revoked"]);

/** `elevated_approval_kind` — GAP-043, `membership_elevated_approval.approval_kind`. A NAMED authority a
 *  tenant grants to a specific membership, over and above the RBAC permission that lets it reach the
 *  route at all. `cost_report_approval` is the first: M27's §4.7 `cost_report_approver_for_provider`
 *  predicate keys on it (spec pseudo-code `hasElevatedApproval(membershipId, 'cost_report_approval')`),
 *  because certifying a CMS-1984-14 filing is a named-officer act, not something every membership
 *  holding `cost_report.approve_for_submit` should inherit. Additive: a new authority adds a member. */
export const elevatedApprovalKind = pgEnum("elevated_approval_kind", ["cost_report_approval"]);

/** `device_attestation_platform` — the §12.1 mobile platform an attestation covers. Web is not a member:
 *  a browser offers no hardware-backed posture assertion, so a browser session simply carries no
 *  attestation and the §12.4 gate denies it, which is the intended answer rather than a missing value. */
export const deviceAttestationPlatform = pgEnum("device_attestation_platform", ["ios", "android"]);

/** `device_attestation_provider` — WHAT the platform's verdict rests on (SecHardening §12.4). The value is
 *  the evidence class, not the outcome: it records how the assertion was proved so a later reviewer can
 *  tell a hardware-backed attestation from a managed-fleet one. `managed_enrollment` is the org-secret
 *  HMAC path M2 verifies itself; the two vendor providers are the hardware paths whose signature check
 *  runs in the `DeviceAttestationVerifier` adapter. */
export const deviceAttestationProvider = pgEnum("device_attestation_provider", [
  "managed_enrollment",
  "apple_app_attest",
  "google_play_integrity",
]);

/** `device_attestation_verdict` — the platform's OWN answer about the device. `failed` rows are retained
 *  rather than dropped: a device that repeatedly fails the §12.4 posture check is exactly the signal the
 *  server-side audit complement is supposed to surface. */
export const deviceAttestationVerdict = pgEnum("device_attestation_verdict", [
  "attested",
  "failed",
  "revoked",
]);
