// @wardenx/types — Module 31 (Patient/Family Portal & Telehealth) leaf contracts (M31-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M31 spec's references to
// `packages/domain/portal/{seam-interfaces,schemas,lay-language}.ts` resolve their TYPE surface HERE, so the
// downstream consumers (M8 encounter attach, M17 room back-ref, M22 document association, M28 SMART
// user-launch, M30 patient-engagement + §4004 access-rate + §164.528 accounting, M33 dashboards, M34 SaaS
// console) import them with NO `dependsOn` edge. M31 never imports a feature package for a type.
//
// SCOPE (authority: architecture/module-manifest.ts wins over the spec's §2 15-entity ERD — ADR-0005).
// The manifest owns THREE tables — `portal_account`, `portal_access_grant`, `telehealth_visit` — so this
// leaf ships the concrete type foundation for those three (the §3.3 pgEnum mirrors defined in the spec,
// their id aliases, the §3.6 audit denylists, the owned-table-name set). The published §4.3 reader seams
// and §4.10 outbox taxonomy are shipped in full as the module's forward-facing wire contract (later tasks
// bind only the three-table-backed portions; fields sourced from non-owned entities resolve to reduced /
// derived values or stay deferred). This mirrors the M16 `bereavement.ts` T01 precedent: ship the
// type-level surface every later M31 task builds on. The pure-data policy (the D9 two-party recording
// matrix, the D17 lay-language redaction, the session lifecycle) lives in the M31 backend + the
// `@wardenx/telehealth-client` adapter — never here. This file is type-only and importable by everyone.
//
// NAMING: every exported symbol carries the `Portal`/`Telehealth`/`M31` prefix. `@wardenx/types` is
// re-exported wholesale from `./index.ts`, so a bare `AccountStatus` / `GrantKind` / `Vendor` would be a
// TS2308 collision the day another module wants the same word (the M14 `IdgDecisionPayload` precedent).

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { OrgId, PatientId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";
import type { EncounterId, VisitId } from "./encounter";
// `PortalSessionId` is a shared soft-ref already declared by M19 on-call (./oncall); imported for internal
// use only — re-declaring/re-exporting it would be a TS2308 collision under `export *` (M16 precedent).
import type { PortalSessionId } from "./oncall";

// ── M31-owned id aliases (mirror the §3.3 uuid PKs of the three owned tables; packages/types cannot
// import @wardenx/db) ──────────────────────────────────────────────────────────────────────────────────
export type PortalAccountId = string;
export type PortalAccessGrantId = string;
export type TelehealthVisitId = string;
/** Soft ref M31 mints but does not own as a table in the manifest: the M2 user backing the account.
 *  (The M2 `PortalSessionId` the portal binds to is imported from ./oncall above, not re-declared.) */
export type PortalUserId = string;

// ── §3.3 pgEnum value mirrors (kept in lock-step with `packages/db/src/schema/portal/*`) ───────────────

/** §2.1 / §3.3 `portal_account_relationship` — who the account holder is to the patient (D2). */
export type PortalAccountRelationship =
  | "patient_self"
  | "family_caregiver"
  | "dpoa_healthcare_agent"
  | "personal_representative_post_death"
  | "bereaved_family_member";

/** §2.2.1 / §3.3 `portal_account_status` — the account lifecycle (`bereaved` is the D4 lateral flip). */
export type PortalAccountStatus = "invited" | "active" | "suspended" | "revoked" | "bereaved";

/** §2.2.2 / §3.3 `portal_access_grant_kind` — the per-patient grant class (D5/D6/D7). */
export type PortalAccessGrantKind =
  | "family_caregiver"
  | "dpoa_healthcare"
  | "patient_self"
  | "personal_representative"
  | "bereaved_family";

/** §2.2.2 `portal_access_grant.revoke_cascade_source` (text column) — why a grant was revoked; a
 *  non-null value is required whenever `revoked_at` is set (the §3.3 CHECK). */
export type PortalGrantRevokeCascadeSource =
  | "user_action"
  | "consent_revoked"
  | "patient_deceased"
  | "admission_discharged"
  | "bereavement_window_expired"
  | "legal_hold"
  | "destruction";

/** §2.2.3 / §3.3 `telehealth_lifecycle_state` — the visit/room state machine (D8/D14). */
export type TelehealthLifecycleState =
  | "room_minted"
  | "patient_joined"
  | "clinician_joined"
  | "in_progress"
  | "ended_clean"
  | "ended_aborted"
  | "reconciled";

/** §3.3 `telehealth_vendor` — the adapter behind a room (Daily.co default per D1). */
export type TelehealthVendor = "daily_co" | "twilio_video" | "native_webrtc";

/** §2.2.3 `telehealth_visit.scheduled_visit_setting` (text column) — the M17-visit modality. */
export type TelehealthScheduledVisitSetting = "telephonic" | "patient_home_with_video";

/** §2.2.3 `telehealth_visit.end_reason` (text column) — required once the visit reaches an ended state. */
export type TelehealthEndReason =
  | "clean"
  | "patient_dropped"
  | "clinician_dropped"
  | "both_dropped"
  | "vendor_outage"
  | "recording_consent_absent"
  | "other";

/** §2.4 / §4.3 D17 lay-language data categories — the disclosure taxonomy the portal reads over and the
 *  §164.528 accounting log records. NOT clinical vocab: these are the redacted lay buckets (D17). */
export type PortalDataCategory =
  | "care_plan"
  | "medications"
  | "administrations"
  | "assessments"
  | "visits"
  | "documents"
  | "messages"
  | "supplies"
  | "triage"
  | "bereavement";

// ── §3.3 owned tables + §3.6 audit denylists ─────────────────────────────────────────────────────────

/** The three §3.3 owned tables (the manifest `ownedTables` set for M31). The spec's §2.1 ERD proposes a
 *  wider 15-entity model; the manifest is authoritative (ADR-0005) and owns exactly these three. */
export type M31TableName = "portal_account" | "portal_access_grant" | "telehealth_visit";

/**
 * §3.6 per-table audit denylist (the M4 PHI trigger arguments for M31-T02). The listed `*_cipher` /
 * `*_jsonb` columns must NOT enter `audit_event.before/after`: the trigger captures a `<changed>` marker
 * instead. `scope_set_jsonb` is denylisted for size (grant metadata is logged separately); the two
 * envelope-encrypted room identifiers + the free-text end-reason detail carry vendor/PHI-leakable content.
 */
export const M31_AUDIT_DENYLIST: { readonly [K in M31TableName]: readonly string[] } = {
  portal_account: ["display_name_cipher", "email_cipher", "phone_cipher"],
  portal_access_grant: ["scope_set_jsonb", "revoke_reason_cipher"],
  telehealth_visit: ["vendor_room_id_cipher", "vendor_room_url_cipher", "end_reason_detail_cipher"],
} as const;

// ── §2.2.2 / §4.3 resolved scope set (the platform-floor + tenant-tighten grant scope) ─────────────────

/**
 * §2.3 `portal_access_grant.scope_set_jsonb` shape after `validateScopeSet(scope, kind, tenantOverlay)`.
 * Per-category read permission; a tenant may TIGHTEN a floor-allowed category to `false` but never loosen
 * a floor-denied one to `true` (the §2.3 validation rule).
 */
export interface PortalScopeSet {
  readonly categories: { readonly [K in PortalDataCategory]?: boolean };
  /** The platform-floor version this scope was resolved against (D5). */
  readonly floorVersion: string;
}

// ── §4.10 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ──────

/** The full §4.10 M31 outbox taxonomy, in canonical `m31.<resource>.<verb>` form. M17 back-refs the
 *  room; M8 attaches the encounter on `visit_ended`; M22 associates the recording + intake; M30/M33 read
 *  the engagement + telehealth metrics; M4 audits everything. Publication wiring lands with the lifecycle
 *  services (M31-T03/T05) and the routes/outbox (M31-T06); only the three-table-backed events emit as real
 *  in the reduced scope. */
export const M31_EVENT_NAMES = [
  "m31.portal_account.invited",
  "m31.portal_account.activated",
  "m31.portal_account.suspended",
  "m31.portal_account.revoked",
  "m31.portal_account.shredded",
  "m31.portal_account.bereaved_mode_entered",
  "m31.portal_account.bereaved_window_closed",
  "m31.portal_access_grant.granted",
  "m31.portal_access_grant.revoked",
  "m31.telehealth.room_created",
  "m31.telehealth.visit_started",
  "m31.telehealth.visit_ended",
  "m31.telehealth.recording_started",
  "m31.telehealth.recording_completed",
  "m31.telehealth.recordings_shredded",
  "m31.portal_document.upload_started",
  "m31.portal_document.uploaded",
  "m31.portal_document.upload_rejected",
  "m31.portal_amendment_request.submitted",
  "m31.portal_session.opened",
  "m31.portal_session.closed",
  "m31.portal_message.sent_via_m36",
] as const;

export type M31EventName = (typeof M31_EVENT_NAMES)[number];

/** The §4.10 upstream events M31 subscribes to (verified as live by `validateSeams()` at boot). */
export const M31_SUBSCRIBED_EVENT_NAMES = [
  "m39.consent.created",
  "m39.consent.revoked",
  "m6.admission.discharged",
  "m16.bereavement.plan_opened",
  "m16.bereavement.plan_closed_completed",
  "m17.visit.published",
  "m17.visit.rescheduled",
  "m17.visit.cancelled",
  "m22.document.rendered",
  "m8.encounter.signed",
  "m4.legal_hold.applied",
  "m4.legal_hold.released",
] as const;

export type M31SubscribedEventName = (typeof M31_SUBSCRIBED_EVENT_NAMES)[number];

// ── §4.10 outbox payloads (lean; PHI-minimal — ids not names, per D17/§8.4) ────────────────────────────

export interface M31PortalAccountInvitedPayload {
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
  readonly relationship: PortalAccountRelationship;
  readonly issuedByMembershipId: MembershipId;
}

export interface M31PortalAccountActivatedPayload {
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
  readonly relationship: PortalAccountRelationship;
  readonly activatedAt: IsoInstant;
}

export interface M31PortalAccountSuspendedPayload {
  readonly portalAccountId: PortalAccountId;
  readonly reason: string;
}

export interface M31PortalAccountRevokedPayload {
  readonly portalAccountId: PortalAccountId;
  readonly reason: PortalGrantRevokeCascadeSource;
  readonly affectedPatientIds: readonly PatientId[];
}

export interface M31PortalAccountShreddedPayload {
  readonly portalAccountId: PortalAccountId;
  readonly certificateId: string;
}

export interface M31PortalAccountBereavedModeEnteredPayload {
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
  readonly bereavementPlanId: string;
}

export interface M31PortalAccountBereavedWindowClosedPayload {
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
}

export interface M31PortalAccessGrantGrantedPayload {
  readonly grantId: PortalAccessGrantId;
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
  readonly grantKind: PortalAccessGrantKind;
}

export interface M31PortalAccessGrantRevokedPayload {
  readonly grantId: PortalAccessGrantId;
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
  readonly revokeCascadeSource: PortalGrantRevokeCascadeSource;
}

export interface M31TelehealthRoomCreatedPayload {
  readonly telehealthVisitId: TelehealthVisitId;
  readonly m17VisitId: VisitId;
  readonly patientId: PatientId;
  readonly vendor: TelehealthVendor;
}

export interface M31TelehealthVisitStartedPayload {
  readonly telehealthVisitId: TelehealthVisitId;
  readonly m17VisitId: VisitId;
  readonly startedAt: IsoInstant;
}

export interface M31TelehealthVisitEndedPayload {
  readonly telehealthVisitId: TelehealthVisitId;
  readonly m17VisitId: VisitId;
  readonly lifecycleState: TelehealthLifecycleState;
  readonly endReason: TelehealthEndReason;
  readonly totalDurationSec: number;
  readonly audioOnlyFallback: boolean;
}

/** Name → payload map for the three-table-backed core of the §4.10 taxonomy (the dispatcher's
 *  compile-time contract). The document/session/recording-detail events reference non-owned entities in
 *  the reduced scope and carry an `unknown` payload until their backing tables land. */
export interface M31EventPayloadMap {
  "m31.portal_account.invited": M31PortalAccountInvitedPayload;
  "m31.portal_account.activated": M31PortalAccountActivatedPayload;
  "m31.portal_account.suspended": M31PortalAccountSuspendedPayload;
  "m31.portal_account.revoked": M31PortalAccountRevokedPayload;
  "m31.portal_account.shredded": M31PortalAccountShreddedPayload;
  "m31.portal_account.bereaved_mode_entered": M31PortalAccountBereavedModeEnteredPayload;
  "m31.portal_account.bereaved_window_closed": M31PortalAccountBereavedWindowClosedPayload;
  "m31.portal_access_grant.granted": M31PortalAccessGrantGrantedPayload;
  "m31.portal_access_grant.revoked": M31PortalAccessGrantRevokedPayload;
  "m31.telehealth.room_created": M31TelehealthRoomCreatedPayload;
  "m31.telehealth.visit_started": M31TelehealthVisitStartedPayload;
  "m31.telehealth.visit_ended": M31TelehealthVisitEndedPayload;
}

// ── §4.3 published-seam read DTOs (PHI-minimal by construction — ids not names) ─────────────────────────

/** §4.3 `PortalAccountReader` digest — the account header every consumer reads. No cipher columns. */
export interface PortalAccountDigest {
  readonly portalAccountId: PortalAccountId;
  readonly userId: PortalUserId;
  readonly relationship: PortalAccountRelationship;
  readonly status: PortalAccountStatus;
  readonly activatedAt: IsoInstant | null;
  readonly lastActiveAt: IsoInstant | null;
}

/** §4.3 `PortalAccessGrantReader` digest — one active/revoked grant. Scope categories, not raw jsonb. */
export interface PortalAccessGrantDigest {
  readonly grantId: PortalAccessGrantId;
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
  readonly grantKind: PortalAccessGrantKind;
  readonly scopeSet: PortalScopeSet;
  readonly grantedAt: IsoInstant;
  readonly revokedAt: IsoInstant | null;
}

/** §4.3 `PortalEngagementProvider` org-aggregate metrics (for M33 ops dashboards / M30 measure family). */
export interface PortalEngagementMetrics {
  readonly accountsActive: number;
  readonly accountsInvited: number;
  readonly accountsRevoked: number;
  readonly accountsBereaved: number;
  readonly patientsWithActiveGrant: number;
  readonly sessionsInWindow: number;
}

/** §4.3 `TelehealthVisitReader` digest — read by M8 to attach the encounter on `visit_ended`. */
export interface TelehealthVisitDigest {
  readonly telehealthVisitId: TelehealthVisitId;
  readonly m17VisitId: VisitId;
  readonly patientId: PatientId;
  readonly assignedMembershipId: MembershipId;
  readonly lifecycleState: TelehealthLifecycleState;
  readonly vendor: TelehealthVendor;
  readonly scheduledVisitSetting: TelehealthScheduledVisitSetting;
  readonly audioOnlyFallbackActive: boolean;
  readonly visitStartedAt: IsoInstant | null;
  readonly visitEndedAt: IsoInstant | null;
  readonly totalDurationSec: number | null;
  readonly endReason: TelehealthEndReason | null;
  readonly linkedEncounterId: EncounterId | null;
}

/** §4.3 `PortalDisclosureAccountingProvider` record — one §164.528 disclosure line for a patient. */
export interface PortalDisclosureRecord {
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
  readonly routePath: string;
  readonly dataCategoriesDisclosed: readonly PortalDataCategory[];
  readonly viewedAt: IsoInstant;
}

// ── §4.3 the seven published reader seams (registered at boot via M1 SeamRegistry) ─────────────────────

/** Used by M28 SMART user-launch, M30 quality, M33 reporting, M34 SaaS console. */
export interface PortalAccountReader {
  tenantPortalAccountCount(
    orgId: OrgId,
  ): Promise<{ active: number; invited: number; revoked: number; bereaved: number }>;
  accountsForPatient(orgId: OrgId, patientId: PatientId): Promise<PortalAccountDigest[]>;
  accountByUserId(orgId: OrgId, userId: PortalUserId): Promise<PortalAccountDigest | null>;
}

/** Used by M28 SMART user-launch + Phase-2 EHR-launch + M30 §4004 patient-access-rate. */
export interface PortalAccessGrantReader {
  activeGrantsForAccount(
    orgId: OrgId,
    portalAccountId: PortalAccountId,
  ): Promise<PortalAccessGrantDigest[]>;
  activeGrantForAccountAndPatient(
    orgId: OrgId,
    portalAccountId: PortalAccountId,
    patientId: PatientId,
  ): Promise<PortalAccessGrantDigest | null>;
  patientsWithActiveGrantsInOrg(
    orgId: OrgId,
    asOf: IsoInstant,
  ): Promise<{ patientId: PatientId; grantCount: number }[]>;
}

/** Used by M30 patient-engagement measure family (HQRP FY 2028+), M33 ops dashboards. */
export interface PortalEngagementProvider {
  engagementForPatient(
    orgId: OrgId,
    patientId: PatientId,
    withinDays: number,
  ): Promise<{
    hasActiveAccount: boolean;
    daysActive: number;
    lastViewedAt: IsoInstant | null;
    messagesSent: number;
    documentsViewed: number;
    amendmentsSubmitted: number;
    administrationsAttested: number;
  }>;
  engagementMetricsForOrg(
    orgId: OrgId,
    fromIso: IsoInstant,
    toIso: IsoInstant,
  ): Promise<PortalEngagementMetrics>;
}

/** Used by M30 telehealth-completion measure, M33 ops dashboards, M35 Phase-2 billing. */
export interface TelehealthMetricsProvider {
  metricsForOrg(
    orgId: OrgId,
    fromIso: IsoInstant,
    toIso: IsoInstant,
  ): Promise<{
    visitsTotal: number;
    visitsCompletedClean: number;
    visitsCompletedAborted: number;
    audioOnlyFallbackRate: number;
    recordingRate: number;
    vendorOutageDurationMin: number;
  }>;
  minutesByTenant(
    orgId: OrgId,
    fromIso: IsoInstant,
    toIso: IsoInstant,
  ): Promise<{ totalMinutes: number; recordedMinutes: number }>;
}

/** Used by M8 to attach the encounter on `m31.telehealth.visit_ended`. */
export interface TelehealthVisitReader {
  getById(
    orgId: OrgId,
    telehealthVisitId: TelehealthVisitId,
  ): Promise<TelehealthVisitDigest | null>;
  getByM17VisitId(orgId: OrgId, m17VisitId: VisitId): Promise<TelehealthVisitDigest | null>;
}

/** Used by M28 Phase-2 SMART user-launch to mint a patient-context FHIR session. */
export interface PortalSessionMinter {
  mintSessionForSmartLaunch(input: {
    orgId: OrgId;
    portalAccountId: PortalAccountId;
    patientId: PatientId;
    requestedScopes: string[];
    smartLaunchContext: { iss: string; launchTokenHash: string };
  }): Promise<{
    sessionId: PortalSessionId;
    activeGrantId: PortalAccessGrantId;
    resolvedScopes: string[];
  }>;
}

/** Used by M30 §164.528 disclosure-accounting scorecard + M22 amendment-disclosure-tracking. */
export interface PortalDisclosureAccountingProvider {
  disclosuresForPatient(
    orgId: OrgId,
    patientId: PatientId,
    fromIso: IsoInstant,
    toIso: IsoInstant,
  ): Promise<PortalDisclosureRecord[]>;
}

// ── §4.9 typed M36 alert payloads (the discriminated union M31 emits to M36's AlertEmitter) ────────────

/** §4.9 — a portal invite has sat unread past 72h; resolved to the inviter. */
export interface PortalInviteUnread72hAlert {
  readonly kind: "invite_unread_72h";
  readonly inviteId: string;
  readonly patientId: PatientId;
  readonly hoursOutstanding: number;
}

/** §4.9 — the telehealth vendor circuit tripped; resolved to tenant admins. */
export interface TelehealthVendorOutageAlert {
  readonly kind: "telehealth_vendor_outage";
  readonly vendor: TelehealthVendor;
  readonly breakerState: string;
  readonly affectedVisitsCount: number;
}

/** §4.9 — recording started (or was requested) in a two-party state without recorded consent. */
export interface TelehealthRecordingConsentAbsentAlert {
  readonly kind: "telehealth_recording_consent_absent_in_two_party_state";
  readonly telehealthVisitId: TelehealthVisitId;
  readonly patientId: PatientId;
  readonly stateCode: string;
}

/** §4.9 — a portal document upload failed to land in M22 intake. */
export interface PortalDocumentUploadFailedIntakeAlert {
  readonly kind: "portal_document_upload_failed_intake";
  readonly uploadId: string;
  readonly patientId: PatientId;
  readonly rejectionReason: string;
}

/** §4.9 — an account activation looks anomalous (e.g. unexpected geo). */
export interface PortalAccountActivationAnomalyAlert {
  readonly kind: "portal_account_activation_anomaly";
  readonly portalAccountId: PortalAccountId;
  readonly detail: string;
}

/** §4.9 — video has been down (audio-only) persistently; resolved to the assigned clinician. */
export interface TelehealthAudioOnlyFallbackPersistentAlert {
  readonly kind: "telehealth_audio_only_fallback_persistent";
  readonly telehealthVisitId: TelehealthVisitId;
  readonly fallbackDurationSec: number;
}

/** §4.9 — a bereaved portal window is about to close; resolved to the bereavement counselor. */
export interface PortalBereavedWindowClosingSoonAlert {
  readonly kind: "bereaved_window_closing_soon";
  readonly portalAccountId: PortalAccountId;
  readonly patientId: PatientId;
  readonly daysUntilClose: number;
}

/** The §4.9 discriminated union of every typed alert M31 emits to M36. */
export type PortalAlertPayload =
  | PortalInviteUnread72hAlert
  | TelehealthVendorOutageAlert
  | TelehealthRecordingConsentAbsentAlert
  | PortalDocumentUploadFailedIntakeAlert
  | PortalAccountActivationAnomalyAlert
  | TelehealthAudioOnlyFallbackPersistentAlert
  | PortalBereavedWindowClosingSoonAlert;
