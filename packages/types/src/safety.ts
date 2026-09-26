// @wardenx/types — Module 20 (Field Safety) leaf contracts (M20-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package, so the downstream consumers
// (M8's encounter safety-context, M17's visit-day badge, M30/M33's operational dashboards, M36's
// `field_safety` recipient resolver, M19's after-hours parallel-recipient composition, M22's incident
// PDF, M32's future high-risk-area suggestion) import them with NO `dependsOn` edge. M20 never imports
// another module's feature package.
//
// LAYOUT READ (Wave P2-2 acceptance #1): the spec's §3.1 layout proposes a `packages/safety-client` leaf
// package holding `seams.ts` / `events.ts` / `alert-payloads.ts` / `policy-floor.ts`. That package is not
// in `architecture/module-manifest.ts`, and the wave's acceptance criterion #1 limits this wave's
// manifest changes to the already-applied `packages/triage-vendors` codePath (ADR-0028) and the two
// Track B web codePaths (ADR-0030). The manifest is the single source of truth, so M20's TYPE surface
// resolves HERE (including the §3.2 Phase-E policy floor, which §3.1 puts in the leaf package) and its
// domain services live under `apps/backend/src/modules/20-field-safety` — the M6 precedent for a module
// with no feature package, and the same call M19-T01 made about `packages/oncall`. Nothing in §3.1 is
// lost, only re-homed onto paths the fitness gates actually govern.
//
// M20-T01 ships the type-level surface every later M20 task builds on: the §3.2 pgEnum value mirrors,
// the seven vocabularies §3.3 spells inline on `text` columns, the §2.2 state vocabulary, the §3.3 owned
// tables with their §3.6 audit denylists and ADR-0004 retention classes (the M4 trigger arguments
// M20-T02 passes), the §3.2 Phase-E `SAFETY_POLICY_FLOOR` code constant and its tighten-only bounds, the
// §4.10 `m20.safety.*` outbox event names + a payload type per event, the subscribed-event names, the
// §4.9 typed M36 alert payloads, and the §4.3 seven published reader-seam interfaces + their read DTOs.
//
// NAMING: every exported symbol carries a `Safety` / `Sos` / `M20` prefix. `@wardenx/types` is
// re-exported wholesale from `./index.ts`, so a bare `IncidentSeverity` / `CheckInKind` / `PolicyFloor`
// would be a TS2308 collision the day M29 or M30 wants the same word (the M14 `IdgDecisionPayload` and
// M19 `TriageDisposition` precedents).
//
// SEAM-SHAPE READ: §4.3 writes every seam method as `(input: { … })`. The registered seams M20 sits
// beside — M17's `VisitReader` / `VisitAssignmentReader`, M18's `EvvLocationProvider`, M19's
// `OnCallProvider` — are all POSITIONAL with `orgId` first, and that is the shape the M1 seam registry
// and every existing consumer already speak. The methods below follow the platform convention rather
// than the spec's prose; the `orgId` argument ASSERTS against the caller's scope, it never selects
// (the M19-T06 rule). Method NAMES and semantics are the spec's, unchanged.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { OrgId, PatientId, ProviderEntityId } from "./admission";
import type { IsoInstant, LocationId, MembershipId } from "./care-plan";
import type { VisitId } from "./encounter";
import type { IsoDate } from "./scheduling";

// ── M20-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ─────────
export type SafetyPolicyId = string;
export type SafetyPolicyVersionId = string;
export type SafetyCheckInScheduleId = string;
export type SafetyCheckInId = string;
export type SafetySosAlertId = string;
export type SafetySosLocationStreamId = string;
export type SafetySosAlertStateHistoryId = string;
export type SafetyIncidentId = string;
export type SafetyIncidentStateHistoryId = string;
export type SafetyAcknowledgmentId = string;
export type SafetySupervisorSubscriptionId = string;
export type SafetyHighRiskAreaId = string;
export type SafetyEmergencyContactConsentId = string;

/** Soft refs M20 stores but does not own: the M2 device the row was posted from (a logical FK — M2's
 *  `ownedTables` carry no device table; the attestation surface is the ADR-0023 D2 M2-surface-inflation
 *  item, and here it is ADVISORY only per §2.2.2), and the M40 PSAP jurisdiction the `emergency_terminus`
 *  path surfaces to every recipient. */
export type SafetyDeviceId = string;
export type PsapJurisdictionId = string;

// ── §3.2 Phase-A pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────

/** `safety_check_in_kind` — §1.1 / D2. The three visit-bracketing kinds REQUIRE a `visitId`; the other
 *  two stand alone. */
export type SafetyCheckInKind =
  | "pre_visit"
  | "mid_visit"
  | "post_visit"
  | "between_visits"
  | "ad_hoc";

/** `safety_check_in_status` — the clinician's own attestation. `concerned_continue` is honoured (the
 *  clinician proceeds) AND surfaced; `concerned_stop` additionally opens a 15-minute callback timer. */
export type SafetyCheckInStatus = "ok" | "concerned_continue" | "concerned_stop";

/** `safety_check_in_state` — §2.2.1. */
export type SafetyCheckInState =
  | "proposed"
  | "recorded"
  | "overdue"
  | "escalated"
  | "superseded"
  | "incident_opened";

/**
 * `safety_sos_lifecycle_state` — §2.2.2.
 *
 * `emergency_terminus` is ADDED to the spec's §3.2 Phase-A block (see the pgEnum's own note): §2.2.2 and
 * the M20-F05 / S13 / INT-031 remediation make it the mandated end of the life-safety chain, and the
 * `CREATE TYPE` block it came from was never updated. Without the value the chain has no terminus and an
 * unacknowledged 3 a.m. SOS sits in `escalation_tier_3` forever — the exact failure S13 exists to close.
 */
export type SafetySosLifecycleState =
  | "raised"
  | "cancel_window_open"
  | "acknowledging"
  | "acknowledged"
  | "escalation_tier_1"
  | "escalation_tier_2"
  | "escalation_tier_3"
  | "emergency_terminus"
  | "resolving"
  | "resolved"
  | "cancelled_in_window"
  | "cancel_attempted_but_rejected"
  | "incident_opened";

/** `safety_sos_cancel_status` — D5. `cancel_attempted_but_rejected` is the hostile-actor signal: the
 *  cancel was pressed, the biometric did not pass, and the alert PROCEEDS as if no cancel happened. */
export type SafetySosCancelStatus =
  | "not_cancelled"
  | "cancelled_in_window"
  | "cancel_attempted_but_rejected";

/** `safety_incident_category` — §1.1. */
export type SafetyIncidentCategory =
  | "physical_assault"
  | "verbal_assault"
  | "threatened"
  | "dog_bite"
  | "animal_other"
  | "vehicle_accident_on_duty"
  | "theft_during_visit"
  | "medical_emergency_clinician_self"
  | "weather_emergency"
  | "environmental_hazard"
  | "near_miss"
  | "other";

/** `safety_incident_severity` — clinician-attested, supervisor-adjustable while `under_review` (§2.2.3). */
export type SafetyIncidentSeverity = "minor" | "moderate" | "serious" | "life_threatening";

/** `safety_incident_state` — §2.2.3. */
export type SafetyIncidentState =
  | "draft"
  | "submitted"
  | "under_review"
  | "returned_to_clinician"
  | "closed_with_action_plan"
  | "closed_no_action"
  | "reopened";

/** `safety_high_risk_category` — D12. Every category is ADVISORY; none blocks a visit. */
export type SafetyHighRiskCategory =
  | "documented_prior_incident"
  | "community_self_reported_unsafe"
  | "nighttime_only_advisory"
  | "weather_advisory_seasonal"
  | "general_caution";

/** `safety_subscription_model` — D8. The tenant-wide DEFAULT model on `safety_policy_version`; distinct
 *  from {@link SafetySubscriptionScopeKind}, which describes one existing row. */
export type SafetySubscriptionModel =
  | "location_scoped"
  | "provider_entity_scoped"
  | "role_scoped"
  | "explicit_only";

/** `safety_acknowledgment_target_kind` — §2.2.6. Exactly one of the three target FKs is non-null and
 *  this column says which. */
export type SafetyAcknowledgmentTargetKind = "sos_alert" | "incident" | "overdue_check_in";

/** `safety_emergency_contact_consent_status` — §2.2.8 / D10. `expired` (tenant rotation) is NOT
 *  `revoked` (the clinician withdrew): a coercion review has to be able to tell them apart. */
export type SafetyEmergencyContactConsentStatus = "granted" | "revoked" | "expired";

// ── §3.3 inline vocabularies (columns the schema spells as `text`; NOT §3.2 Phase-A pg types) ─────────
//
// §3.2 Phase A creates twelve types and stops. These seven vocabularies appear only as a trailing
// comment on a `text` column in §3.3, so M20-T02 lands them as CHECK constraints rather than inventing
// DDL the spec never declared. They still belong in the type surface: a route body, a seam DTO and a
// screen all have to agree on the members, and "it's a text column" is how a wire enum published as a
// bare string becomes a silent lie.

/** §3.3 `safety_sos_alert.cancel_biometric_result`. `not_required` is the tenant-policy case where
 *  `sosCancelRequiresBiometric` is false — it is NOT a pass, and the forensics read distinguishes them. */
export type SafetySosCancelBiometricResult = "passed" | "failed" | "not_required";

/** §3.3 / §4.2 `safety_sos_alert.outcome` — how the responder ended the SOS. */
export type SafetySosOutcome =
  | "no_action_needed"
  | "clinician_safe_continued"
  | "visit_cancelled"
  | "incident_opened"
  | "911_called"
  | "other";

/** §3.3 `safety_acknowledgment.outcome` — what the acknowledging responder actually DID. Distinct from
 *  {@link SafetySosOutcome}: the acknowledgment is the first act, the outcome is the last. */
export type SafetyAcknowledgmentOutcome =
  | "reached_clinician_by_phone"
  | "dispatched_supervisor"
  | "911_called"
  | "no_action_needed"
  | "other";

/** §3.3 `safety_supervisor_subscription.scope_kind` — what ONE row covers. */
export type SafetySubscriptionScopeKind = "explicit" | "location" | "provider_entity" | "role";

/** §3.3 `safety_supervisor_subscription.alert_kinds[]` — which alert classes this row pages on. Also the
 *  `alertKind` argument of {@link SafetySupervisorProvider.supervisorsForClinician}. */
export type SafetyAlertKind = "sos" | "overdue" | "incident" | "high_risk_area";

/** §3.3 `safety_high_risk_area.policy_for_visits_to_area` — D12. `requires_buddy_visit` is a FLAG M20
 *  emits; enforcing it is M17's routing concern, and M20 never blocks the visit either way. */
export type SafetyHighRiskAreaPolicy =
  | "advisory_only"
  | "requires_pre_visit_check_in"
  | "requires_buddy_visit";

/** §3.3 `safety_emergency_contact_consent.consent_purpose` — D6 / D10 / M20-F16. The three are separately
 *  grantable and separately revocable: declining `sos_coordinates` does NOT disable SOS (M20-F16 — the
 *  alert fans out without coordinates), and `continuous_location_during_sos` additionally requires the
 *  tenant's `sosContinuousLocationEnabled` opt-in before a single stream row may be written. */
export type SafetyConsentPurpose =
  | "sos_coordinates"
  | "continuous_location_during_sos"
  | "emergency_contact_call";

// ── §2.2 state vocabulary the workers, seams, routes and screens share ────────────────────────────────

/**
 * §2.2.2 — the SOS states an alert is still LIVE in. The SLA watchdog scans these; the supervisor board
 * shows them. `emergency_terminus` is deliberately in the OPEN set, not the terminal one: per M20-F05 it
 * re-escalates on a loop and exits only on acknowledgment, never on timeout. Treating it as terminal is
 * how the chain would quietly stop.
 */
export const SAFETY_SOS_OPEN_STATES = [
  "raised",
  "cancel_window_open",
  "acknowledging",
  "acknowledged",
  "escalation_tier_1",
  "escalation_tier_2",
  "escalation_tier_3",
  "emergency_terminus",
  "resolving",
] as const satisfies readonly SafetySosLifecycleState[];

/** §2.2.2 — the states no further SOS command advances out of. */
export const SAFETY_SOS_TERMINAL_STATES = [
  "resolved",
  "cancelled_in_window",
  "incident_opened",
] as const satisfies readonly SafetySosLifecycleState[];

/** §2.2.2 — the three tier states the SLA watchdog advances through, in order. `emergency_terminus` is
 *  what a tier-3 SLA breach enters; there is no `escalation_tier_4`. */
export const SAFETY_SOS_ESCALATION_TIERS = [
  "escalation_tier_1",
  "escalation_tier_2",
  "escalation_tier_3",
] as const satisfies readonly SafetySosLifecycleState[];

/** §2.2.3 — the incident states still awaiting somebody's action. */
export const SAFETY_INCIDENT_OPEN_STATES = [
  "draft",
  "submitted",
  "under_review",
  "returned_to_clinician",
  "reopened",
] as const satisfies readonly SafetyIncidentState[];

/** §2.2.3 — closed, but re-openable with a supervisor reason (which returns the row to `under_review`). */
export const SAFETY_INCIDENT_CLOSED_STATES = [
  "closed_with_action_plan",
  "closed_no_action",
] as const satisfies readonly SafetyIncidentState[];

/**
 * §2.2.1 — the schedule states the overdue detector acts on.
 *
 * `escalated` IS IN THE SET (M20-T03, corrected from the two-member version M20-T01 shipped). D4's ladder
 * has FOUR rungs and the row reaches `escalated` at the SECOND of them (§7.3: +15 min), so a detector that
 * stopped scanning there would never fire the 30-minute escalation rung nor the 60-minute SOS-equivalent
 * one — the two rungs that exist precisely because nobody has reached the clinician yet. The row stops being
 * actionable when a human resolves it: `recorded`, `superseded` or `incident_opened`. Migration 0112 widens
 * `scis_overdue_scan_idx` to match; a narrower index would leave the cron's own query unindexed.
 */
export const SAFETY_SCHEDULE_ACTIONABLE_STATES = [
  "proposed",
  "overdue",
  "escalated",
] as const satisfies readonly SafetyCheckInState[];

/** §4.2 — the dashboard's per-clinician overdue badge, derived from the D4 tier the schedule has
 *  crossed. Not a stored column: it is computed from `expectedAt` against the effective policy. */
export type SafetyOverdueBadge = "on_time" | "reminder" | "overdue" | "escalated";

/**
 * D4 / §7.3 — the overdue-escalation RUNG a silence has reached (M20-T03).
 *
 * Also not a stored column, and it cannot be one: §7.3's prose names schedule states (`escalation_tier_1`,
 * `sos_equivalent`) that the §3.2 `safety_check_in_state` enum does not have. The STORED ladder is
 * `proposed → overdue → escalated`; the rung is computed from `expectedAt` against the four policy
 * thresholds, and it is named for those knobs rather than for §7.3's prose because the knob is what a
 * tenant tightens. It rides the `m20.safety.check_in_escalated` payload so a consumer can tell the
 * supervisor-alert page from the SOS-equivalent one.
 */
export type SafetyOverdueTier =
  | "none"
  | "gentle_reminder"
  | "supervisor_alert"
  | "escalation"
  | "sos_equivalent";

/** §4.3 `SafetyCheckInProvider` — the per-kind badge M17 renders on the visit-day grid. */
export type SafetyCheckInBadge = "not_required" | "pending" | "recorded" | "overdue";

// ── §3.3 owned tables + the §3.6 audit denylist / retention class (M4 trigger arguments for M20-T02) ──

/** The thirteen tables M20 owns per the manifest `ownedTables`.
 *
 *  §3.2 Phase E additionally describes a `safety_high_risk_area_platform` pattern-2 platform-shared table
 *  for the seeded polygons. The manifest owns THIRTEEN tables and that is not one of them, so it is not
 *  declared here: adding a fourteenth owned table is a manifest change, and Wave P2-2 acceptance #1
 *  governs manifest changes. M20-T02 either lands it under a reviewed manifest edit or ships the
 *  platform polygons as a code-constant seed the way §3.2 Phase E already does for the policy floor. */
export type M20TableName =
  | "safety_acknowledgment"
  | "safety_check_in"
  | "safety_check_in_schedule"
  | "safety_emergency_contact_consent"
  | "safety_high_risk_area"
  | "safety_incident"
  | "safety_incident_state_history"
  | "safety_policy"
  | "safety_policy_version"
  | "safety_sos_alert"
  | "safety_sos_alert_state_history"
  | "safety_sos_location_stream"
  | "safety_supervisor_subscription";

/** The same thirteen as a runtime list (the M4 trigger loop and the §9.3 RLS proof both iterate it). */
export const M20_TABLE_NAMES = [
  "safety_acknowledgment",
  "safety_check_in",
  "safety_check_in_schedule",
  "safety_emergency_contact_consent",
  "safety_high_risk_area",
  "safety_incident",
  "safety_incident_state_history",
  "safety_policy",
  "safety_policy_version",
  "safety_sos_alert",
  "safety_sos_alert_state_history",
  "safety_sos_location_stream",
  "safety_supervisor_subscription",
] as const satisfies readonly M20TableName[];

/**
 * §3.6 — the columns the M4 write-audit trigger records as `<changed>` rather than by value.
 *
 * Two things stay deliberately OFF this list. `lifecycle_state` / `cancel_status` / `category` /
 * `severity` / `osha_reportable` are captured VERBATIM (§8.8.1): they are exactly the fields a surveyor,
 * an insurer or a deposition reads, and a denylisted enum would make the ledger useless for the purpose
 * it exists to serve. And `is_part_of_sos_bracket` is captured verbatim because it is the retention
 * router — an audit trail that cannot say which class a row was filed under cannot prove the purge was
 * lawful.
 *
 * Every entry is UNCONDITIONAL. §3.7's retention split is row-conditional, but a denylist cannot be: a
 * trigger deciding per row whether to capture a column would have to re-read the row's own state
 * mid-write, and the conditional would fail OPEN — the M19-T01 `answer_value_text` finding.
 */
export const M20_AUDIT_DENYLIST: { readonly [K in M20TableName]: readonly string[] } = {
  safety_acknowledgment: ["action_taken"],
  safety_check_in: ["concern_note", "posted_coordinates_cipher", "posted_coordinates_accuracy_m"],
  safety_check_in_schedule: [],
  safety_emergency_contact_consent: ["consent_scope_detail"],
  safety_high_risk_area: ["advisory_message"],
  safety_incident: [
    "narrative_cipher",
    "witnesses_cipher",
    "action_plan_cipher",
    "location_description",
    "reopen_reason",
    "workers_comp_claim_reference",
  ],
  safety_incident_state_history: ["reason"],
  safety_policy: [],
  safety_policy_version: ["edit_reason"],
  safety_sos_alert: [
    "posted_coordinates_cipher",
    "resolution_narrative_cipher",
    "acknowledger_dispatch_payload_cipher",
  ],
  safety_sos_alert_state_history: ["reason"],
  safety_sos_location_stream: ["coordinates_cipher", "device_telemetry"],
  safety_supervisor_subscription: [],
};

/**
 * §3.7 / §8.8.4 — the `audit_retention_class` each table's trigger STAMPS.
 *
 * The class is baked into the generated trigger function per table (M4's generator takes no row
 * predicate), so a table whose §3.7 class is row-CONDITIONAL must stamp the SAFER of the two.
 * `safety_check_in` is the case: §3.7 files SOS-bracketed and `concerned_*` rows as `compliance` and
 * routine `ok` rows as `operational`. Stamping `operational` would let the 90-day purge take the
 * check-ins that bracket an SOS — the workers-comp timeline §1.1 exists to preserve — so the trigger
 * stamps `compliance` and the routine-purge lives where it can see the row: an M20 cron predicated on
 * `is_part_of_sos_bracket = false AND status = 'ok'` (M20-T03). The fail direction is the only one
 * available: over-retaining a routine "I'm OK" costs storage, under-retaining an SOS bracket costs the
 * agency its evidence.
 */
export const M20_AUDIT_RETENTION_CLASS: {
  readonly [K in M20TableName]: "operational" | "compliance" | "legal_hold";
} = {
  safety_acknowledgment: "compliance",
  safety_check_in: "compliance",
  safety_check_in_schedule: "compliance",
  safety_emergency_contact_consent: "compliance",
  safety_high_risk_area: "operational",
  safety_incident: "compliance",
  safety_incident_state_history: "compliance",
  safety_policy: "compliance",
  safety_policy_version: "compliance",
  safety_sos_alert: "compliance",
  safety_sos_alert_state_history: "compliance",
  safety_sos_location_stream: "compliance",
  safety_supervisor_subscription: "operational",
};

/** §3.7 — the M4 `DataEraser` data class M20 registers at boot. Distinct from every other module's key
 *  (the registry is single-keyed; M24's `medicaid_billing_record`-vs-M23 collision is the precedent).
 *  The erase is NOT a delete: the SOS row, the incident's category/severity and the consent's
 *  proof-of-existence all survive as structural rows with their ciphers shredded — the safety record IS
 *  the row, and destroying it would destroy the very thing a 2031 review of a 2025 incident reads. */
export const M20_ERASER_DATA_CLASS = "safety_record" as const;

// ── §3.2 Phase E — the platform-floor safety policy as a CODE CONSTANT (M20-F03) ──────────────────────

/**
 * The platform-floor policy every tenant's `safety_policy_version` starts from and may only TIGHTEN
 * against (§2.2.4 / D4).
 *
 * M20-F03 struck the org-NULL platform row: `safety_policy.organization_id` is NOT NULL, so the seed
 * row could never have inserted and would never have matched the tenant-scoped RLS. The floor is a code
 * constant instead — M18's geofence floor is the precedent — that the migration seeds each tenant from
 * and the resolver merges under each tenant's row.
 */
export const SAFETY_POLICY_FLOOR = {
  midVisitCadenceMinutes: 60,
  midVisitMinVisitDurationMinutes: 60,
  preVisitWindowMinutes: 15,
  postVisitWindowMinutes: 5,
  gentleReminderMinutes: 5,
  supervisorAlertMinutes: 15,
  escalationMinutes: 30,
  sosEquivalentMinutes: 60,
  sosCancelWindowSeconds: 5,
  sosCancelRequiresBiometric: true,
  sosContinuousLocationEnabled: false,
  sosContinuousLocationSampleSeconds: 30,
  sosContinuousLocationMaxDurationHours: 4,
  sosTier1SlaSeconds: 60,
  sosTier2SlaSeconds: 120,
  sosTier3SlaSeconds: 300,
  subscriptionModel: "location_scoped",
  afterHoursStartHour: 18,
  afterHoursEndHour: 8,
  oshaReportableAutoFlagCategories: [] as readonly SafetyIncidentCategory[],
} as const;

/**
 * §2.2.4 / D4 — the bounds a tenant edit must stay inside. "Tighten-only" is not "smaller-only": a
 * SHORTER overdue threshold is tighter (the supervisor is alerted sooner) while a SHORTER mid-visit
 * cadence is also tighter (the clinician checks in more often), so the direction is per-knob and the
 * band, not a single comparison, is what M20-T03's editor enforces.
 *
 * The cadence band is the one §2.2.4 argues for explicitly: a tenant that could set "check in once per
 * 8-hour visit" would have defeated the safety purpose while passing every validation.
 */
export const SAFETY_POLICY_BOUNDS = {
  midVisitCadenceMinutes: { min: 30, max: 120 },
  midVisitMinVisitDurationMinutes: { min: 15, max: 240 },
  preVisitWindowMinutes: { min: 5, max: 60 },
  postVisitWindowMinutes: { min: 1, max: 30 },
  /** D4 — a tenant may alert SOONER than the floor, never later. */
  gentleReminderMinutes: { min: 1, max: 5 },
  supervisorAlertMinutes: { min: 1, max: 15 },
  escalationMinutes: { min: 1, max: 30 },
  sosEquivalentMinutes: { min: 1, max: 60 },
  /** D5 — the cancel window may be LONGER (more chance to undo an accidental press) but never shorter
   *  than the 5-second floor, which is what makes the press deliberate. */
  sosCancelWindowSeconds: { min: 5, max: 30 },
  sosContinuousLocationSampleSeconds: { min: 10, max: 300 },
  /** D6 / §8.7 forced sunset — the stream may run for LESS time, never more. */
  sosContinuousLocationMaxDurationHours: { min: 1, max: 4 },
  sosTier1SlaSeconds: { min: 15, max: 60 },
  sosTier2SlaSeconds: { min: 30, max: 120 },
  sosTier3SlaSeconds: { min: 60, max: 300 },
} as const;

/** §8.3 / M20-F05 — SOS delivery is NEVER rate-limited or suppressed. Above this many presses per hour
 *  per membership the platform FLAGS an anomaly (`m20.safety.sos_anomaly_volume` to compliance, a badge
 *  on the supervisor board) and the 11th press escalates exactly like the first. The threshold is
 *  deliberately absent from {@link SAFETY_POLICY_BOUNDS}: it is not tenant-tunable in either direction,
 *  because a tenant that could lower it could configure away a clinician's safety alert. */
export const SAFETY_SOS_ANOMALY_VOLUME_PER_HOUR = 10;

// ── §4.10 emitted outbox events ──────────────────────────────────────────────────────────────────────

/**
 * The `m20.safety.*` events M20 publishes. Every name is three-segment `mN.<resource>.<verb>` per the
 * M01 D8 / M03 D9 convention `arch:gaps` enforces.
 *
 * COUNT READ: the §4.10 table lists seventeen topics; the v0.3 changelog that MOVED this catalog into
 * the `m20.safety.*` namespace enumerates TWENTY-TWO and is the later authority. The five the table
 * never gained are each depended on elsewhere in the same spec: `sos_terminus_reached` is the INT-031
 * ops page §2.2.2/§2.7/§8.8.3 all require, `sos_anomaly_volume` is the §8.3 flag-not-gate, and
 * `device_attestation_anomaly` (§8.3), `incident_reported` (§4.9 / D9 — the draft is opened, distinct
 * from `incident_submitted`) and `policy_violation_recorded` (§8.2) are each named by a consumer.
 * Shipping the table's seventeen would leave those five with no topic to publish on.
 */
export const M20_EVENT_NAMES = [
  "m20.safety.check_in_recorded",
  "m20.safety.check_in_overdue",
  "m20.safety.check_in_escalated",
  "m20.safety.sos_alert_raised",
  "m20.safety.sos_alert_cancel_attempted_rejected",
  "m20.safety.sos_alert_acknowledged",
  "m20.safety.sos_alert_escalated",
  "m20.safety.sos_terminus_reached",
  "m20.safety.sos_alert_resolved",
  "m20.safety.sos_anomaly_volume",
  "m20.safety.device_attestation_anomaly",
  "m20.safety.incident_reported",
  "m20.safety.incident_submitted",
  "m20.safety.incident_closed_with_action",
  "m20.safety.incident_report_requested",
  "m20.safety.osha_reportable_incident_filed",
  "m20.safety.workers_comp_claim_initiated",
  "m20.safety.high_risk_area_entered",
  "m20.safety.policy_changed",
  "m20.safety.policy_violation_recorded",
  "m20.safety.coverage_gap_detected",
  "m20.safety.visit_cancellation_requested",
] as const;

/** One §4.10 outbox event name. */
export type M20EventName = (typeof M20_EVENT_NAMES)[number];

/**
 * §2.6 — the per-event key a DOWNSTREAM consumer collapses retries against, beyond the M1 envelope's
 * `event_id`. A tuple means the COMPOSITE is the key.
 *
 * `m20.safety.sos_alert_raised` is deliberately ABSENT. §2.6 / M20-F10 make the SOS press the one
 * non-idempotent write on the platform: every press records and every press fans out, so collapsing two
 * presses onto one `sosAlertId` key is exactly the suppression S13 forbids. The alert's DELIVERY is
 * de-duplicated by M36 on the outbox `event_id`, which is per-emit, not per-alert.
 *
 * TWO KEYS ARE COMPOSITE AND BOTH WERE SINGLE-FIELD UNTIL M20-T03 BUILT THE THING THEY KEY (the same class
 * of finding as `sos_alert_raised`, one layer down — a key that collapses a repetition the design REQUIRES):
 *   • `check_in_escalated` fires once per D4 rung crossed (§7.3: +15 min supervisor page, +30 escalation,
 *     +60 SOS-equivalent). Keyed on `scheduleId` alone, a conforming consumer drops rungs two and three —
 *     including the one §7.3 routes to Tier-1 voice.
 *   • `sos_terminus_reached` is emitted on EVERY loop iteration by construction (M20-F05: the terminus
 *     "keeps re-escalating … until a responder or WardenX ops acknowledges"). Keyed on `sosAlertId` alone,
 *     every page after the first is suppressed and the terminus becomes the silent wait it exists to end.
 */
export const M20_EVENT_IDEMPOTENCY_KEYS = {
  "m20.safety.check_in_recorded": "checkInId",
  "m20.safety.check_in_overdue": "scheduleId",
  "m20.safety.check_in_escalated": ["scheduleId", "tier"],
  "m20.safety.sos_alert_acknowledged": "sosAlertId",
  "m20.safety.sos_terminus_reached": ["sosAlertId", "loopIteration"],
  "m20.safety.sos_alert_resolved": "sosAlertId",
  "m20.safety.incident_reported": "incidentId",
  "m20.safety.incident_submitted": "incidentId",
  "m20.safety.incident_closed_with_action": "incidentId",
  "m20.safety.incident_report_requested": "incidentId",
  "m20.safety.osha_reportable_incident_filed": "incidentId",
  "m20.safety.workers_comp_claim_initiated": "incidentId",
  "m20.safety.visit_cancellation_requested": "sosAlertId",
} as const satisfies Partial<Record<M20EventName, string | readonly string[]>>;

/**
 * The events M20 SUBSCRIBES to (§3.1 `consumers/`, §4.8 queue catalog). Listed here — not only in the
 * worker files — so M20-T04's consumer wiring and the §9 tests share one source of truth, and so an
 * upstream rename breaks the build rather than silently orphaning a handler. M20 owns none of these
 * prefixes; consuming them needs no `dependsOn` edge.
 *
 * NAME READ: §4.8's queue table spells the M36 trigger `m36.delivery_failed` (two segments). The topic
 * M36 actually emits is `m36.notification.delivery_failed` — the same correction M19-T01 made.
 *
 * SHIFT READ: §3.1's consumer file is named for `m19.on_call_shift.opened` / `.closed`. M19-F12 retired
 * that pair and the canonical topics are `m19.oncall_shift.activated` / `.completed` — but F-094/#205
 * removed BOTH from this list rather than correcting the name, because `consumers/index.ts` has always
 * said there is nothing to consume: they were the re-sync trigger for a CACHED on-call resolution and M20
 * caches none (the D14 union is resolved live at fan-out, since a cached roster is a 3 a.m. staleness
 * bug). #204 dropped `m20` from the `activated` entry's `declaredConsumers` for the same reason, so
 * neither event routes here and neither ever will.
 */
export const M20_SUBSCRIBED_EVENT_NAMES = [
  "m17.visit.published",
  "m17.visit.assigned",
  "m17.visit.completed",
  "m17.visit.no_show_detected",
  "m18.evv.check_in_recorded",
  "m18.evv.check_out_recorded",
  "m18.evv.gps_spoof_suspected",
  // Subscribed and NOT routed here — both registered in `scripts/outbox-subscription-exceptions.ts`.
  // `m5.patient.deceased` and the M36 trigger are M20-T06's, which is why `consumers/index.ts` lists
  // them as out of scope for the M17/M18 binding #204 landed.
  "m36.notification.delivery_failed",
  "m5.patient.deceased",
] as const;

/** One subscribed event name. */
export type M20SubscribedEventName = (typeof M20_SUBSCRIBED_EVENT_NAMES)[number];

// ── §4.10 outbox payloads (the shape each subscriber type-checks against) ─────────────────────────────

/** Fields every M20 event carries so a consumer can scope and route without a second read. The
 *  `providerEntityId` is what M36's `field_safety` resolver keys the on-call union on (§4.5). */
export interface M20SafetyEventBase {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly occurredAt: IsoInstant;
}

/** `m20.safety.check_in_recorded` — info. No default recipients: the supervisor board updates over the
 *  M36 socket rooms, not by paging somebody every time a clinician says "I'm OK". */
export interface M20CheckInRecordedPayload extends M20SafetyEventBase {
  readonly checkInId: SafetyCheckInId;
  readonly scheduleId: SafetyCheckInScheduleId | null;
  readonly visitId: VisitId | null;
  readonly clinicianMembershipId: MembershipId;
  readonly kind: SafetyCheckInKind;
  readonly status: SafetyCheckInStatus;
  /** §8.8.2 — whether coordinates were captured, never the coordinates. */
  readonly coordinatesIncluded: boolean;
  readonly isPartOfSosBracket: boolean;
}

/** `m20.safety.check_in_overdue` — warn, to the subscribed supervisors. */
export interface M20CheckInOverduePayload extends M20SafetyEventBase {
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly clinicianMembershipId: MembershipId;
  readonly visitId: VisitId | null;
  readonly kind: SafetyCheckInKind;
  readonly expectedAt: IsoInstant;
  readonly minutesOverdue: number;
}

/** `m20.safety.check_in_escalated` — critical. After hours the next tier is the M19 on-call supervisor
 *  (D14), never a voicemail that waits until Monday. */
export interface M20CheckInEscalatedPayload extends M20SafetyEventBase {
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly clinicianMembershipId: MembershipId;
  readonly visitId: VisitId | null;
  readonly minutesOverdue: number;
  readonly afterHours: boolean;
  /** D4 — WHICH rung this emit is. One event per rung crossed (M20-T03), so a consumer that only knows
   *  `scheduleId` cannot tell the 15-minute supervisor page from the 60-minute SOS-equivalent one — and
   *  §7.3 routes them differently. `sos_equivalent` takes the Tier-1 voice channel and the
   *  `field_safety_composed` recipient set. */
  readonly tier: SafetyOverdueTier;
}

/** `m20.safety.sos_alert_raised` — critical, system-locked, non-idempotent by design (M20-F10). */
export interface M20SosAlertRaisedPayload extends M20SafetyEventBase {
  readonly sosAlertId: SafetySosAlertId;
  readonly postedByMembershipId: MembershipId;
  readonly postedAt: IsoInstant;
  readonly lastKnownVisitId: VisitId | null;
  /** §2.2.2 — the attestation gate is ADVISORY: a `false` here is a forensics signal and an anomaly
   *  event, never a reason the alert did not fan out. */
  readonly deviceAttested: boolean;
  /** M20-F16 — false when the clinician declined `sos_coordinates`. The SOS still fans out; the
   *  recipients are told there is no location rather than being shown a stale one. */
  readonly coordinatesCaptured: boolean;
}

/** `m20.safety.sos_alert_cancel_attempted_rejected` — warn. The hostile-actor signal (D5). */
export interface M20SosCancelAttemptedRejectedPayload extends M20SafetyEventBase {
  readonly sosAlertId: SafetySosAlertId;
  readonly attemptedAt: IsoInstant;
  readonly biometricResult: SafetySosCancelBiometricResult;
}

/** `m20.safety.sos_alert_acknowledged` — warn, back to the poster and the subscribers (close the loop). */
export interface M20SosAlertAcknowledgedPayload extends M20SafetyEventBase {
  readonly sosAlertId: SafetySosAlertId;
  readonly acknowledgedByMembershipId: MembershipId;
  readonly acknowledgedAt: IsoInstant;
  readonly tierAtAcknowledgment: SafetySosLifecycleState;
  readonly slaBreached: boolean;
}

/** `m20.safety.sos_alert_escalated` — critical, one per tier advance. */
export interface M20SosAlertEscalatedPayload extends M20SafetyEventBase {
  readonly sosAlertId: SafetySosAlertId;
  readonly fromTier: SafetySosLifecycleState;
  readonly toTier: SafetySosLifecycleState;
  readonly escalatedAt: IsoInstant;
  readonly reasonCode: "sla_breach" | "delivery_failed" | "manual";
}

/**
 * `m20.safety.sos_terminus_reached` — critical, system-locked (M20-F05 / S13 / INT-031).
 *
 * Emitted EVERY loop iteration, not once: §2.2.2 keeps re-escalating until a human acknowledges, so a
 * single fire-and-forget emit would turn the terminus back into the silent wait it exists to prevent.
 * `loopIteration` is what lets a consumer tell the tenth page from the first without suppressing either.
 */
export interface M20SosTerminusReachedPayload extends M20SafetyEventBase {
  readonly sosAlertId: SafetySosAlertId;
  readonly terminusReachedAt: IsoInstant;
  readonly loopIteration: number;
  readonly emergencyContactCallInitiated: boolean;
  /** §8.8.2 — the M40 jurisdiction is referenced by id; the PSAP number itself never enters an audit or
   *  outbox payload. Null when M40 could not resolve one for the last known location. */
  readonly psapJurisdictionId: PsapJurisdictionId | null;
  readonly wardenxOpsPaged: boolean;
}

/** `m20.safety.sos_alert_resolved` — info, to the poster + subscribers + the resolver. */
export interface M20SosAlertResolvedPayload extends M20SafetyEventBase {
  readonly sosAlertId: SafetySosAlertId;
  readonly resolvedByMembershipId: MembershipId;
  readonly outcome: SafetySosOutcome;
  readonly resolvedAt: IsoInstant;
}

/** `m20.safety.sos_anomaly_volume` — warn, to compliance. §8.3: a FLAG, never a gate. */
export interface M20SosAnomalyVolumePayload extends M20SafetyEventBase {
  readonly clinicianMembershipId: MembershipId;
  readonly pressesInWindow: number;
  readonly windowHours: number;
  readonly detectedAt: IsoInstant;
}

/** `m20.safety.device_attestation_anomaly` — warn, to compliance. §8.3: the alert from an unattested
 *  device still fanned out; this is the forensics trail behind it. */
export interface M20DeviceAttestationAnomalyPayload extends M20SafetyEventBase {
  readonly clinicianMembershipId: MembershipId;
  readonly deviceId: SafetyDeviceId | null;
  readonly sosAlertId: SafetySosAlertId | null;
  readonly checkInId: SafetyCheckInId | null;
  readonly detectedAt: IsoInstant;
}

/** `m20.safety.incident_reported` — info. The DRAFT was opened; nothing is filed yet. Distinct from
 *  `incident_submitted`, which is the immutability entry point. */
export interface M20IncidentReportedPayload extends M20SafetyEventBase {
  readonly incidentId: SafetyIncidentId;
  readonly affectedClinicianMembershipId: MembershipId;
  readonly reportedByMembershipId: MembershipId;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly occurredAt: IsoInstant;
  readonly linkedSosAlertId: SafetySosAlertId | null;
}

/** `m20.safety.incident_submitted` — warn, to supervisors + the compliance officer. */
export interface M20IncidentSubmittedPayload extends M20SafetyEventBase {
  readonly incidentId: SafetyIncidentId;
  readonly affectedClinicianMembershipId: MembershipId;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly occurredAt: IsoInstant;
  readonly oshaReportable: boolean;
  readonly linkedSosAlertId: SafetySosAlertId | null;
}

/** `m20.safety.incident_closed_with_action` — info. */
export interface M20IncidentClosedWithActionPayload extends M20SafetyEventBase {
  readonly incidentId: SafetyIncidentId;
  readonly closedByMembershipId: MembershipId;
  readonly closedAt: IsoInstant;
}

/** `m20.safety.incident_report_requested` — info; M22's renderer consumes it. M20 ships no PDF code. */
export interface M20IncidentReportRequestedPayload extends M20SafetyEventBase {
  readonly incidentId: SafetyIncidentId;
  readonly renderTargetKind: "pdf";
}

/** `m20.safety.osha_reportable_incident_filed` — warn, system-locked, to compliance + DON + org-admin.
 *  `reportingWindowHours` is the state-specific clock (8 h fatality / 24 h hospitalization) the filing
 *  has to beat; the filing itself is manual or M29's. */
export interface M20OshaReportableIncidentFiledPayload extends M20SafetyEventBase {
  readonly incidentId: SafetyIncidentId;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly signedOffByMembershipId: MembershipId;
  readonly signedOffAt: IsoInstant;
  readonly stateCode: string;
  readonly reportingWindowHours: number;
}

/** `m20.safety.workers_comp_claim_initiated` — info; a downstream WC integration picks it up. */
export interface M20WorkersCompClaimInitiatedPayload extends M20SafetyEventBase {
  readonly incidentId: SafetyIncidentId;
  readonly initiatedByMembershipId: MembershipId;
  readonly initiatedAt: IsoInstant;
}

/** `m20.safety.high_risk_area_entered` — warn, to the subscribed supervisors. Advisory only (D12). */
export interface M20HighRiskAreaEnteredPayload extends M20SafetyEventBase {
  readonly clinicianMembershipId: MembershipId;
  readonly areaId: SafetyHighRiskAreaId;
  readonly riskCategory: SafetyHighRiskCategory;
  readonly enteredAt: IsoInstant;
  readonly visitId: VisitId | null;
}

/** `m20.safety.policy_changed` — warn, to DON + compliance. */
export interface M20PolicyChangedPayload extends M20SafetyEventBase {
  readonly newVersionId: SafetyPolicyVersionId;
  readonly changedByMembershipId: MembershipId;
  readonly changedAt: IsoInstant;
  /** §8.8.2 — which knobs moved and in which direction. `loosen` should be unreachable (the editor is
   *  floor-bound); if one ever appears, the entry is itself the compliance flag. */
  readonly thresholdDiffs: readonly {
    readonly field: string;
    readonly direction: "tighten" | "loosen";
  }[];
}

/** `m20.safety.policy_violation_recorded` — warn (§8.2). The policy said one thing and the system
 *  observed another: a mid-visit suppression beyond what D13 allows, a cadence window that elapsed with
 *  the schedule never materialized, a coordinate read without the paired narrative. */
export interface M20PolicyViolationRecordedPayload extends M20SafetyEventBase {
  readonly violationKind:
    | "suppression_beyond_policy"
    | "cadence_not_materialized"
    | "coords_read_without_narrative"
    | "other";
  readonly subjectMembershipId: MembershipId | null;
  readonly detectedAt: IsoInstant;
  readonly policyVersionId: SafetyPolicyVersionId;
}

/** `m20.safety.coverage_gap_detected` — critical, system-locked, to DON + org-admin. */
export interface M20CoverageGapDetectedPayload extends M20SafetyEventBase {
  readonly clinicianMembershipId: MembershipId;
  readonly reason: SafetyCoverageGapReason;
  readonly detectedAt: IsoInstant;
}

/** `m20.safety.visit_cancellation_requested` — warn; M17's D3 cancellation handler does the cancel.
 *  M20 never writes M17's visit row. */
export interface M20VisitCancellationRequestedPayload extends M20SafetyEventBase {
  readonly sosAlertId: SafetySosAlertId;
  readonly visitId: VisitId;
  readonly requestedAt: IsoInstant;
}

/** The §4.10 topic → payload map every consumer type-checks against. */
export interface M20EventPayloadMap {
  "m20.safety.check_in_recorded": M20CheckInRecordedPayload;
  "m20.safety.check_in_overdue": M20CheckInOverduePayload;
  "m20.safety.check_in_escalated": M20CheckInEscalatedPayload;
  "m20.safety.sos_alert_raised": M20SosAlertRaisedPayload;
  "m20.safety.sos_alert_cancel_attempted_rejected": M20SosCancelAttemptedRejectedPayload;
  "m20.safety.sos_alert_acknowledged": M20SosAlertAcknowledgedPayload;
  "m20.safety.sos_alert_escalated": M20SosAlertEscalatedPayload;
  "m20.safety.sos_terminus_reached": M20SosTerminusReachedPayload;
  "m20.safety.sos_alert_resolved": M20SosAlertResolvedPayload;
  "m20.safety.sos_anomaly_volume": M20SosAnomalyVolumePayload;
  "m20.safety.device_attestation_anomaly": M20DeviceAttestationAnomalyPayload;
  "m20.safety.incident_reported": M20IncidentReportedPayload;
  "m20.safety.incident_submitted": M20IncidentSubmittedPayload;
  "m20.safety.incident_closed_with_action": M20IncidentClosedWithActionPayload;
  "m20.safety.incident_report_requested": M20IncidentReportRequestedPayload;
  "m20.safety.osha_reportable_incident_filed": M20OshaReportableIncidentFiledPayload;
  "m20.safety.workers_comp_claim_initiated": M20WorkersCompClaimInitiatedPayload;
  "m20.safety.high_risk_area_entered": M20HighRiskAreaEnteredPayload;
  "m20.safety.policy_changed": M20PolicyChangedPayload;
  "m20.safety.policy_violation_recorded": M20PolicyViolationRecordedPayload;
  "m20.safety.coverage_gap_detected": M20CoverageGapDetectedPayload;
  "m20.safety.visit_cancellation_requested": M20VisitCancellationRequestedPayload;
}

// ── §4.9 typed M36 alert payloads ────────────────────────────────────────────────────────────────────
//
// `systemLocked: true` means no tenant setting can disable the rule. M20 has FIVE locked rules — more
// than any other module — and that is the point of S13: an org under staffing pressure must not be able
// to quiet the SOS raise, its escalation, its terminus, the check-in escalation, or the coverage gap
// that says nobody is watching at all.
//
// No alert payload carries coordinates, a patient's full identity or any cleartext narrative (§8.2 /
// §8.3): the recipient set includes SMS and voice, so every field here leaves the platform.

/** `m20.safety.sos_alert_raised` — critical, system-locked, `in_app` + `push` + `sms` + `voice`. */
export interface SosAlertRaisedAlert {
  readonly eventType: "m20.safety.sos_alert_raised";
  readonly severity: "critical";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly postedByMembershipId: MembershipId;
  /** Minimum-necessary per §8.2: the clinician's FIRST name, so a supervisor knows who to call for. */
  readonly postedByFirstName: string;
  readonly postedAt: IsoInstant;
  /** A coarse, non-coordinate descriptor ("Springfield, near the 12th St corridor") a responder can act
   *  on without `safety.sos.read_coords`. Absent when M20-F16's declined-consent fallback applies — and
   *  the absence is the message: "no location available — call immediately". */
  readonly locationDescriptionMasked?: string;
  readonly lastKnownVisitId?: VisitId;
  readonly severityNote: "LIFE_SAFETY";
}

/** `m20.safety.sos_alert_escalated` — critical, system-locked. */
export interface SosAlertEscalatedAlert {
  readonly eventType: "m20.safety.sos_alert_escalated";
  readonly severity: "critical";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly fromTier: SafetySosLifecycleState;
  readonly toTier: SafetySosLifecycleState;
  readonly escalatedAt: IsoInstant;
  readonly reasonCode: string;
}

/** `m20.safety.sos_terminus_reached` — critical, system-locked, to WardenX ops as well as the org
 *  (INT-031). The `psapNumberAvailable` flag says a human CAN dial emergency services; the number
 *  itself is fetched by the responder's client from M40, never fanned out over SMS. */
export interface SosTerminusReachedAlert {
  readonly eventType: "m20.safety.sos_terminus_reached";
  readonly severity: "critical";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly terminusReachedAt: IsoInstant;
  readonly loopIteration: number;
  readonly emergencyContactCallInitiated: boolean;
  readonly psapNumberAvailable: boolean;
}

/** `m20.safety.sos_alert_acknowledged` — warn, to the composed set PLUS the original poster: the
 *  clinician who pressed the button is the one who most needs to know somebody answered. */
export interface SosAlertAcknowledgedAlert {
  readonly eventType: "m20.safety.sos_alert_acknowledged";
  readonly severity: "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly acknowledgedByMembershipId: MembershipId;
  readonly acknowledgedAt: IsoInstant;
}

/** `m20.safety.sos_alert_resolved` — info, to the composed set + poster + resolver. */
export interface SosAlertResolvedAlert {
  readonly eventType: "m20.safety.sos_alert_resolved";
  readonly severity: "info";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly resolvedByMembershipId: MembershipId;
  readonly outcome: SafetySosOutcome;
  readonly resolvedAt: IsoInstant;
}

/** `m20.safety.check_in_overdue` — warn, to the subscribed supervisors. */
export interface SafetyCheckInOverdueAlert {
  readonly eventType: "m20.safety.check_in_overdue";
  readonly severity: "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly clinicianMembershipId: MembershipId;
  readonly clinicianFirstName: string;
  readonly visitId?: VisitId;
  readonly kind: SafetyCheckInKind;
  readonly expectedAt: IsoInstant;
  readonly minutesOverdue: number;
}

/** `m20.safety.check_in_escalated` — critical, system-locked. */
export interface SafetyCheckInEscalatedAlert {
  readonly eventType: "m20.safety.check_in_escalated";
  readonly severity: "critical";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly clinicianMembershipId: MembershipId;
  readonly clinicianFirstName: string;
  readonly visitId?: VisitId;
  readonly minutesOverdue: number;
}

/** `m20.safety.high_risk_area_entered` — warn. The advisory message is tenant-authored and ≤200 chars. */
export interface SafetyHighRiskAreaEnteredAlert {
  readonly eventType: "m20.safety.high_risk_area_entered";
  readonly severity: "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly clinicianMembershipId: MembershipId;
  readonly clinicianFirstName: string;
  readonly areaId: SafetyHighRiskAreaId;
  readonly riskCategory: SafetyHighRiskCategory;
  readonly advisoryMessage: string;
  readonly enteredAt: IsoInstant;
  readonly visitId?: VisitId;
}

/** `m20.safety.incident_submitted` — warn, to supervisors + the compliance officer. */
export interface SafetyIncidentSubmittedAlert {
  readonly eventType: "m20.safety.incident_submitted";
  readonly severity: "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly incidentId: SafetyIncidentId;
  readonly affectedClinicianMembershipId: MembershipId;
  readonly category: SafetyIncidentCategory;
  readonly severityLevel: SafetyIncidentSeverity;
  readonly occurredAt: IsoInstant;
  readonly oshaReportable: boolean;
}

/** `m20.safety.osha_reportable_incident_filed` — warn, system-locked, to compliance + DON + org-admin. */
export interface SafetyOshaReportableIncidentFiledAlert {
  readonly eventType: "m20.safety.osha_reportable_incident_filed";
  readonly severity: "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly incidentId: SafetyIncidentId;
  readonly category: SafetyIncidentCategory;
  readonly severityLevel: SafetyIncidentSeverity;
  readonly signedOffByMembershipId: MembershipId;
  readonly stateCode: string;
  readonly reportingWindowHours: number;
}

/** `m20.safety.policy_changed` — warn, to DON + compliance. */
export interface SafetyPolicyChangedAlert {
  readonly eventType: "m20.safety.policy_changed";
  readonly severity: "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly newVersionId: SafetyPolicyVersionId;
  readonly changedByMembershipId: MembershipId;
  readonly changeSummary: string;
}

/** `m20.safety.coverage_gap_detected` — critical, system-locked, to DON + org-admin. Nobody is paged for
 *  this clinician; that is not a condition a tenant may switch off. */
export interface SafetyCoverageGapDetectedAlert {
  readonly eventType: "m20.safety.coverage_gap_detected";
  readonly severity: "critical";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly clinicianMembershipId: MembershipId;
  readonly reason: SafetyCoverageGapReason;
  readonly detectedAt: IsoInstant;
}

/** The §4.9 alert union M36 renders. */
export type SafetyAlertPayload =
  | SosAlertRaisedAlert
  | SosAlertEscalatedAlert
  | SosTerminusReachedAlert
  | SosAlertAcknowledgedAlert
  | SosAlertResolvedAlert
  | SafetyCheckInOverdueAlert
  | SafetyCheckInEscalatedAlert
  | SafetyHighRiskAreaEnteredAlert
  | SafetyIncidentSubmittedAlert
  | SafetyOshaReportableIncidentFiledAlert
  | SafetyPolicyChangedAlert
  | SafetyCoverageGapDetectedAlert;

/** The §4.9 alert event types no tenant setting may disable. */
export const M20_SYSTEM_LOCKED_ALERT_TYPES = [
  "m20.safety.sos_alert_raised",
  "m20.safety.sos_alert_escalated",
  "m20.safety.sos_terminus_reached",
  "m20.safety.check_in_escalated",
  "m20.safety.osha_reportable_incident_filed",
  "m20.safety.coverage_gap_detected",
] as const satisfies readonly SafetyAlertPayload["eventType"][];

/** §4.5 — the M36 recipient resolvers M20 registers or targets. `field_safety_composed` unions M20's
 *  supervisor subscriptions with M19's on-call roster during the after-hours window; the `_plus_poster`
 *  variant adds the clinician who raised the alert so the loop closes back to her. */
export const M20_RECIPIENT_RESOLVERS = [
  "field_safety_composed",
  "field_safety_composed_plus_poster",
  "safety_supervisors",
  "safety_supervisors_plus_compliance_officer",
] as const;

/** One M36 recipient-resolver name M20 depends on. */
export type M20RecipientResolver = (typeof M20_RECIPIENT_RESOLVERS)[number];

// ── §4.3 read DTOs ───────────────────────────────────────────────────────────────────────────────────

/** §2.2.5 / §4.3 — why a clinician has nobody watching. Kept as a closed union because the coverage-gap
 *  alert is system-locked: a free-text reason cannot be triaged by the DON it wakes up. */
export type SafetyCoverageGapReason =
  | "no_subscription"
  | "all_subscriptions_deactivated"
  | "vacation_forwards_unresolved";

/** §4.2 — where the dashboard's last-known-location marker came from. `evv_*` is M18's discrete
 *  check-in/out, `m20_check_in` is an opt-in coordinate on a safety check-in (D11), `sos_active` is the
 *  D6 stream. */
export type SafetyLocationSource = "evv_check_in" | "evv_check_out" | "m20_check_in" | "sos_active";

/**
 * §4.2 — the staleness of a clinician's last known position.
 *
 * There are NO coordinates in this DTO, deliberately. The supervisor board answers "when did we last
 * hear from her, and how", and that question needs a timestamp and a source, not a latitude. Keeping
 * coordinates out means rendering the board never touches `safety.sos.read_coords` and never trips the
 * §8.2 audit-warn read path — the coordinates live behind their own route, their own permission and
 * their own warn-severity audit entry, which is exactly the boundary D6 draws.
 */
export interface SafetyLastKnownLocationDto {
  readonly source: SafetyLocationSource;
  readonly sampledAt: IsoInstant;
  readonly ageMinutes: number;
}

/** §4.2 — one clinician's row on the supervisor live-awareness board. */
export interface SafetyClinicianStatusDto {
  readonly membershipId: MembershipId;
  readonly displayName: string;
  readonly currentVisitId: VisitId | null;
  /** Minimum-necessary per §1.3 / HIPAA §164.502(b): first name only, never the full patient identity. */
  readonly currentPatientFirstName: string | null;
  readonly lastKnownLocation: SafetyLastKnownLocationDto | null;
  readonly lastCheckInAt: IsoInstant | null;
  readonly lastCheckInStatus: SafetyCheckInStatus | null;
  readonly nextExpectedCheckInAt: IsoInstant | null;
  readonly overdueState: SafetyOverdueBadge;
  readonly activeSosAlert: {
    readonly id: SafetySosAlertId;
    readonly raisedAt: IsoInstant;
    readonly lifecycleState: SafetySosLifecycleState;
  } | null;
  readonly inHighRiskArea: {
    readonly areaId: SafetyHighRiskAreaId;
    readonly riskCategory: SafetyHighRiskCategory;
    readonly advisoryMessage: string;
  } | null;
  /** §7.7 — M18 owns the RESPONSE to a suspected spoof; M20 only shows the badge, so a supervisor
   *  scanning "is everyone OK?" sees both posture signals at once. */
  readonly gpsSpoofSuspected: boolean;
}

/** §4.2 — the whole board. `activeSosCount` and `overdueCount` are computed over the SAME snapshot as
 *  `clinicians`, so the tiles and the grid can never disagree on the screen. */
export interface SafetyDashboardSnapshot {
  readonly clinicians: readonly SafetyClinicianStatusDto[];
  readonly activeSosCount: number;
  readonly overdueCount: number;
  readonly fetchedAt: IsoInstant;
}

/** §4.3 — the incident summary M8 renders beside the encounter it happened during. No narrative
 *  cleartext: the M8 note is the clinical record, this is the structured safety context. */
export interface SafetyIncidentSummaryDto {
  readonly incidentId: SafetyIncidentId;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly lifecycleState: SafetyIncidentState;
  readonly occurredAt: IsoInstant;
  readonly affectedClinicianMembershipId: MembershipId;
  readonly visitId: VisitId | null;
  readonly linkedSosAlertId: SafetySosAlertId | null;
  readonly oshaReportable: boolean;
}

/** §8.6 — a coordinate pair rounded to three decimals (~110 m), the resolution the M32 boundary permits.
 *  The rounding happens inside M20, before the DTO is built; a full-precision coordinate never exists on
 *  the consumer side of the seam. */
export interface SafetyRoundedCoordinates {
  readonly latitude3: number;
  readonly longitude3: number;
}

/**
 * §4.3 / §8.6 — the M32 minimum-necessary incident projection: category, severity, when, and a coarse
 * where. No clinician identity, no patient identity, no narrative cleartext, no cipher (a cipher does
 * not cross a seam at all — the DEK never leaves M20's boundary).
 *
 * COORDINATE READ: `safety_incident` stores NO coordinates (§3.3 gives it only a denylisted
 * `location_description`). The only geography an incident has is the one on its linked SOS
 * (`posted_coordinates_cipher`), so `roundedCoordinates` is non-null exactly for SOS-linked incidents
 * and M20 decrypts-then-rounds inside its own boundary to build it. A freestanding incident — the dog
 * bite reported the next morning — is structurally invisible to an area query, which is a real limit of
 * the D12 suggestion model and not something the seam should paper over.
 */
export interface SafetyIncidentMinNecDto {
  readonly incidentId: SafetyIncidentId;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly occurredAt: IsoInstant;
  readonly roundedCoordinates: SafetyRoundedCoordinates | null;
}

/**
 * A polygon as stored: GeoJSON ring coordinates in `[longitude, latitude]` order, SRID 4326.
 *
 * M20-F07 struck PostGIS from Phase 1 (M1 is frozen; the ARCH-027 stack is pgvector + pgcrypto), so the
 * polygon is `jsonb` and point-in-polygon membership is an even-odd ray-cast in app code. The seam
 * therefore takes rings rather than the spec's `GeoJSON.Polygon` — the global `GeoJSON` namespace would
 * put a `@types/geojson` dependency on a leaf package for a type that is structurally this array. The
 * first ring is the outer boundary; any further rings are holes.
 */
export type SafetyPolygonRings = readonly (readonly (readonly [number, number])[])[];

/** §4.3 — the effective policy, floor merged under the tenant's current version. `versionId` is what a
 *  write snapshots onto its row so a 2031 replay of a 2026 incident reads the 2026 rules. */
export interface SafetyPolicyEffectiveDto {
  readonly organizationId: OrgId;
  readonly versionId: SafetyPolicyVersionId;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
  readonly midVisitCadenceMinutes: number;
  readonly midVisitMinVisitDurationMinutes: number;
  readonly preVisitWindowMinutes: number;
  readonly postVisitWindowMinutes: number;
  readonly gentleReminderMinutes: number;
  readonly supervisorAlertMinutes: number;
  readonly escalationMinutes: number;
  readonly sosEquivalentMinutes: number;
  readonly sosCancelWindowSeconds: number;
  readonly sosCancelRequiresBiometric: boolean;
  readonly sosContinuousLocationEnabled: boolean;
  readonly sosContinuousLocationSampleSeconds: number;
  readonly sosContinuousLocationMaxDurationHours: number;
  readonly sosTier1SlaSeconds: number;
  readonly sosTier2SlaSeconds: number;
  readonly sosTier3SlaSeconds: number;
  readonly subscriptionModel: SafetySubscriptionModel;
  readonly afterHoursStartHour: number;
  readonly afterHoursEndHour: number;
  readonly oshaReportableAutoFlagCategories: readonly SafetyIncidentCategory[];
}

/** §4.3 — one resolved paging recipient. `isVacationForwarded` is not cosmetic: M36 must deliver to the
 *  FORWARD target, and a consumer that ignored the flag would page a supervisor who is on a plane. */
export interface SafetySupervisorRecipientDto {
  readonly supervisorMembershipId: MembershipId;
  readonly scopeKind: SafetySubscriptionScopeKind;
  readonly isVacationForwarded: boolean;
  readonly vacationForwardToMembershipId: MembershipId | null;
}

/** §4.3 — one clinician nobody is subscribed to. */
export interface SafetyCoverageGapDto {
  readonly clinicianMembershipId: MembershipId;
  readonly reason: SafetyCoverageGapReason;
}

/** §4.3 — the per-visit badge trio M17 renders on the day grid. */
export interface SafetyVisitCheckInStatusDto {
  readonly preVisit: SafetyCheckInBadge;
  readonly midVisit: SafetyCheckInBadge;
  readonly postVisit: SafetyCheckInBadge;
}

/** The half-open instant window every metrics read is scoped to. */
export interface SafetyMetricsWindow {
  readonly from: IsoInstant;
  readonly to: IsoInstant;
}

// ── §4.3 the seven published reader seams ────────────────────────────────────────────────────────────

/**
 * §4.3 — the supervisor live-awareness board, also embedded by M17's visit-day view.
 *
 * FAIL POSTURE: this is an AVAILABILITY read for a Tier-1 module. A registry or query failure means "we
 * cannot tell you how your clinicians are", which the caller must surface as UNKNOWN — never as an empty
 * board, which reads identically to "everyone is fine" and is the one wrong answer a safety surface must
 * not give (the M19-T08 three-state banner rule).
 */
export interface SafetyDashboardProvider {
  clinicianStatusForLocation(
    orgId: OrgId,
    locationId: LocationId,
    asOfIso: IsoInstant,
  ): Promise<SafetyDashboardSnapshot>;
  clinicianStatusForSupervisor(
    orgId: OrgId,
    supervisorMembershipId: MembershipId,
    asOfIso: IsoInstant,
  ): Promise<SafetyDashboardSnapshot>;
}

/** §4.3 — M8's encounter-authoring surface: was there an incident during the visit being documented? */
export interface SafetyContextReader {
  activeIncidentForVisit(orgId: OrgId, visitId: VisitId): Promise<SafetyIncidentSummaryDto | null>;
  activeIncidentsForClinicianToday(
    orgId: OrgId,
    clinicianMembershipId: MembershipId,
    asOfDate: IsoDate,
  ): Promise<readonly SafetyIncidentSummaryDto[]>;
}

/** §4.3 / §8.6 — M32's future high-risk-area suggestion model. Minimum-necessary projection; cleartext
 *  never traverses, and the model never auto-adds a polygon (a Compliance Officer does). */
export interface SafetyIncidentReader {
  recentIncidentsForArea(
    orgId: OrgId,
    polygon: SafetyPolygonRings,
    sinceIso: IsoInstant,
  ): Promise<readonly SafetyIncidentMinNecDto[]>;
  recentIncidentsForClinician(
    orgId: OrgId,
    clinicianMembershipId: MembershipId,
    sinceIso: IsoInstant,
  ): Promise<readonly SafetyIncidentMinNecDto[]>;
}

/**
 * §4.3 — M30 / M33 operational dashboards. Aggregates only; no row-level PHI.
 *
 * Every rate ships WITH its denominator (`sampleSize` / `visitCount`), which the §4.3 signatures for
 * `getSosFrequency` and `getIncidentRate` omit. This is the M17 `VisitMetricsProvider` /
 * M19 `TriageCallMetricsProvider` precedent: M30 collapses a measure to `insufficient_n` below the
 * reportable floor, a bare rate cannot express that suppression, and back-computing a denominator from a
 * rate is how a number that should have been withheld gets published. There is no CMS measure here, but
 * an insurer or state-agency review reads these tiles the same way — "0 incidents" over four visits is
 * not a safety record.
 */
export interface SafetyMetricsProvider {
  getSosFrequency(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<{
    readonly count: number;
    readonly perHundredVisits: number;
    readonly visitCount: number;
  }>;
  getOverdueRate(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<{ readonly rate: number; readonly sampleSize: number }>;
  getIncidentRate(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<{
    readonly rate: number;
    readonly perHundredVisits: number;
    readonly visitCount: number;
  }>;
  getResponseTimeMedian(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<{
    readonly medianSeconds: number;
    readonly p95Seconds: number;
    readonly sampleSize: number;
  }>;
  getCheckInComplianceRate(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<{ readonly rate: number; readonly sampleSize: number }>;
  getAfterHoursSosCount(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<{ readonly count: number }>;
}

/** §4.3 — M17's visit-day badging. */
export interface SafetyCheckInProvider {
  checkInStatusForVisit(orgId: OrgId, visitId: VisitId): Promise<SafetyVisitCheckInStatusDto>;
}

/**
 * §4.3 — the ONLY read path to the effective policy (§2.2.4: consumers never read
 * `safety_policy_version` directly).
 *
 * `policyAtTime` is not a convenience: it is the replay path the whole policy-snapshot design exists for
 * — a 2031 review of a 2026 incident has to read the 2026 thresholds, and reading today's would turn a
 * policy that tightened into a regression that never happened.
 */
export interface SafetyPolicyProvider {
  effectivePolicy(orgId: OrgId, asOfIso?: IsoInstant): Promise<SafetyPolicyEffectiveDto>;
  policyAtTime(orgId: OrgId, atIso: IsoInstant): Promise<SafetyPolicyEffectiveDto>;
}

/**
 * §4.3 / §4.5 — who gets paged, for M36's `field_safety_composed` resolver and M19's after-hours union.
 *
 * FAIL POSTURE: an empty array is a REAL answer here — it means nobody is subscribed, which is precisely
 * the coverage gap {@link coverageGapsForOrg} reports and the system-locked critical alert wakes the DON
 * for. A registry outage must therefore NOT resolve to `[]`: it has to throw, so the caller falls back
 * to the tenant emergency number (M20-F01) instead of silently concluding that a 3 a.m. SOS has no
 * recipients. This is the same distinction M19's `currentOnCallActors` draws.
 */
export interface SafetySupervisorProvider {
  supervisorsForClinician(
    orgId: OrgId,
    clinicianMembershipId: MembershipId,
    alertKind: SafetyAlertKind,
  ): Promise<readonly SafetySupervisorRecipientDto[]>;
  coverageGapsForOrg(orgId: OrgId, asOfIso: IsoInstant): Promise<readonly SafetyCoverageGapDto[]>;
}

// ── Cross-module bindings M20 must resolve against the LOCKED upstream contracts (M20-T04 notes) ──────
//
// Three of the spec's §4.4 method names do not match what their owners actually published, and M20 binds
// to the OWNER's contract rather than redefining it (the M15/M17 `VolunteerComplianceProvider`
// precedent — a re-declared seam is a permanently unbound one):
//
//   §4.4 / D14 name `OnCallProvider.currentOnCallForProviderEntity(providerEntityId, asOf)`. M19
//   published `currentOnCallActors(orgId, providerEntityId, asOfIso)` returning `OnCallActor[]`, a union
//   DISCRIMINATED on membership-vs-external_vendor. M20-T04 must handle the vendor arm explicitly: an
//   external triage vendor has no membership id, so a Saturday-3-AM SOS covered by a vendor cannot union
//   into an M36 membership recipient list — the composed resolver has to decide what an external actor
//   means for the SOS channel, in the open, rather than dropping it into an empty list that looks
//   like a normal result.
//
//   §4.4 names `PatientAddressReader.geocodedAddressFor`. NO such seam exists — M5 publishes
//   `PatientReader` and `PatientCoverageReader` and nothing that returns a geocoded address. The D12
//   pre-visit high-risk-area evaluation therefore has no address source today. M20-T04 must either bind
//   to whatever M5/M17 actually expose for a visit address or ship the evaluator fail-closed (no
//   polygon match, advisory absent) and say so — never invent an M5 seam M5 does not own.
//
//   §8.5 names the client packages `packages/oncall-client`, `packages/evv-client` and
//   `packages/scheduling-client`. None exists (M20-F13 already corrected two of the three in the spec's
//   own dependency list): M17's, M18's and M19's seam CONTRACTS all live in `@wardenx/types`, which is
//   where M20 imports them from, with no `dependsOn` edge.
