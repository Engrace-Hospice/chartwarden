// @wardenx/types — Module 16 (Bereavement) leaf contracts (M16-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M16 spec's references to
// `packages/domain/bereavement/{seam-interfaces,events,alerts}.ts` resolve their TYPE surface HERE, so the
// downstream consumers (M22 letter rendering, M28 FHIR `CarePlan`/`RelatedPerson`, M30 HQRP rates, M31
// portal self-service, M32 the Layer-2 risk narrative, M33 dashboards, M36 alerts + channel membership)
// import them with NO `dependsOn` edge. M16 never imports a feature package.
//
// M16-T01 ships the type-level surface every later M16 task builds on: the §3.2 pgEnum value mirrors, the
// §3.3 owned-table names + the D11 audit denylists (the M4 trigger arguments for M16-T02), the §4.4
// `m16.bereavement.*` outbox event names + payload types, the §4.5 subscribed-event names, the §4.10 typed
// M36 alert payloads, and the §4.6 / D13 published-seam interfaces + their read DTOs. The pure-data policy
// — the D4 death-date-anchored cadence floor, the D3/D17 risk rubric weights + scorer, the D15 per-kind
// encounter-backing rules, the D7/D9 closure + opt-out windows, the D18 external-source gate — lives in the
// `@wardenx/bereavement` FEATURE package. This file is type-only and importable by everyone with no edge.
//
// NAMING: every exported symbol carries the `Bereavement`/`Bereaved`/`M16` prefix. `@wardenx/types` is
// re-exported wholesale from `./index.ts`, so a bare `RiskTier` / `OutreachKind` / `ContactLog` would be a
// TS2308 collision the day another module wants the same word (the M14 `IdgDecisionPayload` precedent).

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { AdmissionId, LocalDate, PatientId, ProviderEntityId } from "./admission";
import type { ConsentId, IsoInstant, LocationId, MembershipId } from "./care-plan";
import type { DocumentId } from "./documents";
import type { EncounterId } from "./encounter";

// ── M16-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ──────────
export type BereavementPlanId = string;
export type BereavedContactId = string;
export type BereavementRiskScoreId = string;
export type BereavementOutreachId = string;
export type BereavementContactLogId = string;
export type BereavementAnniversaryReminderId = string;
export type BereavementPlanClosureId = string;
export type BereavementOptOutId = string;
export type BereavementExternalSourceGateOverrideId = string;
/** Soft refs M16 stores but does not own: the M31 portal account a bereaved contact signs in with, and the
 *  M40 `external_grief_resource` a complicated-grief referral routes to. */
export type BereavedPortalAccountId = string;
export type ExternalGriefResourceId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ──────────────────────

/** The §2.2 / D2 plan-root lifecycle (mirrors `bereavement_plan_status`). */
export type BereavementPlanStatus =
  | "eligible"
  | "initiating"
  | "active"
  | "paused"
  | "closed_completed"
  | "closed_declined"
  | "closed_early"
  | "closed_legal_hold_extended";

/** The §2.3 per-bereaved-person lifecycle (mirrors `bereaved_contact_status`). */
export type BereavedContactStatus =
  | "proposed"
  | "active"
  | "opted_out"
  | "deceased"
  | "unreachable"
  | "ineligible_post_review";

/** Relationship-to-decedent (mirrors `bereaved_contact_relationship`); M38 owns the value set (§2.5). */
export type BereavedContactRelationship =
  | "spouse"
  | "domestic_partner"
  | "parent"
  | "child"
  | "sibling"
  | "grandparent"
  | "grandchild"
  | "aunt_uncle"
  | "cousin"
  | "in_law"
  | "friend"
  | "neighbor"
  | "clergy"
  | "colleague"
  | "caregiver_non_family"
  | "other";

/** The touchpoint modality (mirrors `bereavement_outreach_kind`). D15: only `in_person_visit` is an M8
 *  encounter; every other kind is a direct M16 write. */
export type BereavementOutreachKind =
  | "phone_call"
  | "in_person_visit"
  | "sympathy_card"
  | "sympathy_letter"
  | "anniversary_letter"
  | "email"
  | "portal_message"
  | "group_support_invitation"
  | "external_referral";

/** The §2.4 scheduled-touchpoint lifecycle (mirrors `bereavement_outreach_status`). */
export type BereavementOutreachStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "declined"
  | "no_response"
  | "missed"
  | "cancelled";

/** What happened on a touchpoint (mirrors `bereavement_contact_log_outcome`). */
export type BereavementContactLogOutcome =
  | "engaged"
  | "brief_acknowledgement"
  | "declined"
  | "no_response"
  | "voicemail_left"
  | "wrong_number"
  | "returned_undeliverable"
  | "requested_followup"
  | "requested_no_further_contact"
  | "crisis_referral";

/** The D3 risk tier driving the D4 cadence (mirrors `bereavement_risk_tier`). The deterministic rubric only
 *  reaches `high`; `complicated` is a D8 screen-driven promotion. */
export type BereavementRiskTier = "low" | "moderate" | "high" | "complicated";

/** D3 hybrid model (mirrors `bereavement_risk_score_kind`). */
export type BereavementRiskScoreKind = "rule_deterministic" | "llm_augmented";

/** Why the program ended (mirrors `bereavement_plan_closure_reason`). */
export type BereavementPlanClosureReason =
  | "thirteen_month_completion"
  | "all_contacts_declined"
  | "patient_opt_out_pre_death"
  | "patient_opt_out_post_creation"
  | "tenant_offboarding"
  | "all_bereaved_deceased"
  | "geographic_relocation"
  | "family_legal_action"
  | "other_early";

/** D9 per-contact opt-out granularity (mirrors `bereavement_opt_out_kind`). */
export type BereavementOptOutKind = "full" | "channel_specific" | "pause_temporarily";

/** The §2.2 pause taxonomy (mirrors `bereavement_plan_pause_kind`). */
export type BereavementPlanPauseKind =
  | "operational"
  | "family_request"
  | "counselor_unavailable_temp";

/** The D4 milestone an outreach / reminder row belongs to (mirrors `bereavement_anniversary_mark`). */
export type BereavementAnniversaryMark =
  | "one_month"
  | "three_month"
  | "six_month"
  | "nine_month_high_risk_only"
  | "anniversary";

/** D17 — how many of the 8 rubric factors were knowable (mirrors `bereavement_data_completeness`). */
export type BereavementDataCompleteness = "complete" | "partial" | "minimal";

/** D17 — the band derived from the knowable-factor count (mirrors `bereavement_confidence_band`). */
export type BereavementConfidenceBand = "HIGH" | "MEDIUM" | "LOW";

/** §3.3.8 — how an opt-out reached M16. `m39_revocation_cascade` is the §2.6 consent-revocation path where
 *  M39 is the source of truth and M16 only cascades. */
export type BereavementOptOutSourceKind =
  | "counselor_recorded"
  | "portal_self_service"
  | "m39_revocation_cascade"
  | "written_request_uploaded";

/** §3.3.7 — who drove the closure. `cascade` is the all-contacts-opted-out / patient-opt-out path. */
export type BereavementCloseKind = "auto" | "manual" | "cascade";

// ── §3.3 owned tables + D11 audit denylists ───────────────────────────────────────────────────────────

/** M16's owned tables (the manifest `ownedTables` set). */
export type M16TableName =
  | "bereavement_plan"
  | "bereaved_contact"
  | "bereavement_risk_score"
  | "bereavement_outreach"
  | "bereavement_contact_log"
  | "bereavement_anniversary_reminder"
  | "bereavement_plan_closure"
  | "bereavement_opt_out"
  | "bereavement_idg_risk_flag"
  | "tenant_bereavement_external_source_gate_override";

/**
 * Per-table audit denylist (D11 / §3.7 / §8.1). Free-text PHI that must NOT enter `audit_event.before/after`
 * values — the M4 trigger captures a `<changed>` marker instead. Empty array = structural fields only.
 *
 * The columns are the `*_redacted` prose fields plus the two jsonb json-paths D11 names explicitly
 * (`data->>'customPersonalization'`, `data->>'narrative'`), which reach M16 on the outreach-artifact body
 * context. The `*_cipher` columns are NOT listed: they are already envelope-encrypted ciphertext, and
 * denylisting them would drop the only change-detection signal the audit row has for a contact-channel edit.
 * `bereavement_risk_score` additionally refuses UPDATE outright (D11 immutability) — the denylist covers the
 * INSERT capture of the narrative + the encrypted notes path inside `risk_factors_jsonb`.
 */
export const M16_AUDIT_DENYLIST: { readonly [K in M16TableName]: readonly string[] } = {
  bereavement_plan: ["pause_reason_redacted", "ipoc_bereavement_intent_summary_redacted"],
  bereaved_contact: ["ineligible_reason_redacted"],
  bereavement_risk_score: [
    "augmented_narrative_redacted",
    "risk_factors_jsonb->>notes_cipher",
    "risk_factors_jsonb->>narrative",
  ],
  bereavement_outreach: ["cancellation_reason_redacted"],
  bereavement_contact_log: ["contact_notes_cipher"],
  bereavement_anniversary_reminder: [],
  bereavement_plan_closure: ["reason_narrative_redacted"],
  bereavement_opt_out: ["reason_redacted"],
  bereavement_idg_risk_flag: ["rationale_text"],
  tenant_bereavement_external_source_gate_override: ["additional_rationale"],
} as const;

// ── D16 external-source provenance (the TypeBox-locked `external_source_metadata` shape) ──────────────

/**
 * D16 — the provenance blob stamped on a plan opened from `m6.bereavement.eligible` with
 * `source='hl7_external'`; NULL for `internal_clinician_recorded`. Read-only after insert EXCEPT for the
 * D18 cosign-receipt update. A surveyor traces plan → source HL7 message through this.
 */
export interface BereavementExternalSourceMetadata {
  readonly sourceProposalId: string;
  readonly sourceMessageId: string;
  readonly sourceFacilityMdmId: string;
  readonly sourceFacilityName: string;
  readonly ackReceivedAt: IsoInstant;
  readonly cosignStatus: "pending" | "cosigned";
  readonly cosignedAt?: IsoInstant;
  readonly medicalDirectorMembershipId?: MembershipId;
}

// ── §4.4 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ───────

/** The full §4.4 M16 outbox taxonomy, in canonical `m16.<resource>.<verb>` form. M36 consumes the channel
 *  lifecycle + every alert-bearing event; M22 the artifact-render handshakes; M28 the FHIR projection; M30
 *  the CoP rate numerators/denominators; M31 the portal-visible contact state; M33 everything. Publication
 *  wiring lands with the lifecycle services (M16-T03) and the routes/workers (M16-T06). */
export const M16_EVENT_NAMES = [
  "m16.bereavement.plan_opened",
  "m16.bereavement.plan_paused",
  "m16.bereavement.plan_resumed",
  "m16.bereavement.plan_closed_completed",
  "m16.bereavement.plan_closed_declined",
  "m16.bereavement.plan_closed_early",
  "m16.bereavement.plan_skipped_per_patient_opt_out",
  "m16.bereavement.external_source_cosign_received",
  "m16.bereavement.counselor_assigned",
  "m16.bereavement.volunteer_assigned",
  "m16.bereavement.contact_active",
  "m16.bereavement.contact_opted_out",
  "m16.bereavement.contact_opt_out_rescinded",
  "m16.bereavement.contact_deceased",
  "m16.bereavement.contact_unreachable",
  "m16.bereavement.contact_referred_external",
  "m16.bereavement.outreach_scheduled",
  "m16.bereavement.outreach_completed",
  "m16.bereavement.outreach_missed",
  "m16.bereavement.outreach_artifact_requested",
  "m16.bereavement.risk_score_computed",
  "m16.bereavement.anniversary_due_in_14_days",
] as const;

/** An M16 outbox event name (§4.4). */
export type M16EventName = (typeof M16_EVENT_NAMES)[number];

/** The §4.4 / §4.9 idempotency key each event's consumer de-duplicates on (beyond the M1 envelope's
 *  `event_id`, which every subscriber already keys on). */
export const M16_EVENT_IDEMPOTENCY_KEYS = {
  "m16.bereavement.plan_opened": "planId",
  "m16.bereavement.outreach_artifact_requested": "outreachId",
  "m16.bereavement.risk_score_computed": "scoreId",
  "m16.bereavement.anniversary_due_in_14_days": "anniversaryReminderId",
} as const satisfies Partial<Record<M16EventName, string>>;

/**
 * §4.5 — the events M16 SUBSCRIBES to. Listed here (not just in the worker files) so M16-T03's consumer
 * wiring and the §9 tests share one source of truth, and so a rename upstream breaks the build rather than
 * silently orphaning a handler. M16 owns none of these prefixes; consuming them needs no `dependsOn` edge.
 *
 * F-094/#205 — that last clause was a claim about a check nobody had written. Rule 6 of
 * `check-outbox-bindings.ts` is now that check, both ways: every name here resolves to a boot-catalogued
 * event that declares `m16`, and every catalogued event declaring `m16` is here. Before it the two
 * disagreed on 16 facts — including `idg.decision_recorded`, the ONE event M16 binds live, which this list
 * did not name.
 *
 * F-134/#248 — six names removed (`m5.patient.deceased`, `m6.admission.activated`,
 * `m6.discharge.death`, `m7.care_plan.discharged`, `m15.plan.discharged`, `m39.consent.renewed`): each
 * had been copied into both this list and the producing module's `declaredConsumers` on a claim
 * ("seeds the bereavement plan") that F-105 already disproved — `m6.bereavement.eligible` is the ONLY
 * path a `bereavement_plan` row can come into existence — or, for `m6.discharge.death`, was simply the
 * co-emitted source event `bereavement.eligible` is itself derived from in the same transaction. Neither
 * M16's own §4.5 table nor its `lifecycle/cascades.ts` deciders ever named any of the six.
 *
 * F-172/#248 — `m37.ipu_admission.death_recorded` removed too, the identical redundant-sibling shape:
 * M37's own spec names M16 here ("bereavement onboarding"), but M16's real intake mechanism is keyed off
 * the M6 admission (`m6.discharge.death`/`m6.admission.discharged` reason=death), which M37's own
 * `recordDeath` transition (newly bound, F-172) is itself driven from — so this event carries no fact
 * M16 doesn't already have earlier from the M6 side.
 */
export const M16_SUBSCRIBED_EVENT_NAMES = [
  // The two topics M16's `consumers/` actually decides on today.
  "m6.bereavement.eligible",
  "m6.discharge.cosigned",
  // Catalogued AND declaring `m16`, so the relay routes each of these here the day a binding lands.
  // `idg.decision_recorded` is the one M16 already binds LIVE — and the one this list did not name.
  "idg.decision_recorded",
  "m6.admission.discharged",
  "m39.consent.revoked",
  "m39.consent.signed",
  "m5.patient.bereavement_opt_out_changed",
  // §4.5 subscriptions the catalog does NOT declare `m16` on. Each is registered in
  // `scripts/outbox-subscription-exceptions.ts` with the reason, because the relay routes none of them
  // here and a handler written against these names would never run. `m17.shift_changed` used to sit in
  // this group and is gone instead: M17 emits no shift topic under any name, so there was nothing to
  // except.
  "m4.legal_hold.applied",
  "m4.legal_hold.released",
  "m8.encounter.signed",
  "m22.document.rendered",
  "m39.consent.created",
] as const;

/** One §4.5 subscribed event name. */
export type M16SubscribedEventName = (typeof M16_SUBSCRIBED_EVENT_NAMES)[number];

// ── §4.4 outbox payloads (the shape each subscriber type-checks against) ──────────────────────────────

/** `m16.bereavement.plan_opened` — the roster + 13-month schedule seeded and the plan reached `active`.
 *  M36 opens the `bereavement` channel with the pre-computed `archivesAt`; M22 renders the welcome packet.
 *  Consumers: M22, M28, M33, M36. */
export interface M16PlanOpenedPayload {
  readonly planId: BereavementPlanId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly deathDate: LocalDate;
  readonly assignedCounselorUserId: MembershipId;
  /** `death_date + 13 months` — M36 pre-computes the channel archive instant from this (D4 / §7.11). */
  readonly archivesAt: IsoInstant;
}

/** `m16.bereavement.plan_paused` — M36 write-disables the channel. Consumers: M33, M36. */
export interface M16PlanPausedPayload {
  readonly planId: BereavementPlanId;
  readonly pauseKind: BereavementPlanPauseKind;
  readonly pausedAt: IsoInstant;
}

/** `m16.bereavement.plan_resumed` — the forward schedule was regenerated. Consumers: M33, M36. */
export interface M16PlanResumedPayload {
  readonly planId: BereavementPlanId;
  readonly resumedAt: IsoInstant;
}

/** The §7.11 closeout counts the summary document and the M30 CoP rate read off the closure row. */
export interface M16OutreachStats {
  readonly completedCount: number;
  readonly missedCount: number;
  readonly contactsActiveCount: number;
  readonly contactsOptedOutCount: number;
}

/** `m16.bereavement.plan_closed_completed` — the 13-month clock ran out. M36's channel auto-archives via
 *  its pre-computed `archives_at`; M22 renders the closeout summary. Consumers: M22, M28, M30, M33, M36. */
export interface M16PlanClosedCompletedPayload {
  readonly planId: BereavementPlanId;
  readonly closedAt: IsoInstant;
  readonly outreachStats: M16OutreachStats;
}

/** `m16.bereavement.plan_closed_declined` — every enrollee opted out (D6). Consumers: M22, M30, M33, M36. */
export interface M16PlanClosedDeclinedPayload {
  readonly planId: BereavementPlanId;
  readonly closedAt: IsoInstant;
}

/** `m16.bereavement.plan_closed_early` — a D7 cosigned early close. Consumers: M22, M30, M33, M36. */
export interface M16PlanClosedEarlyPayload {
  readonly planId: BereavementPlanId;
  readonly reason: BereavementPlanClosureReason;
  readonly closedAt: IsoInstant;
  /** Null only on the D9 patient-opt-out-post-creation path, which is explicitly cosign-exempt. */
  readonly cosignedByUserId: MembershipId | null;
}

/** `m16.bereavement.plan_skipped_per_patient_opt_out` — M6 said eligible but the M5 patient-level directive
 *  said no (D9). Carries no `planId`: no plan row is opened. Consumers: M30, M33. */
export interface M16PlanSkippedPerPatientOptOutPayload {
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly deathDate: LocalDate;
}

/** `m16.bereavement.external_source_cosign_received` — D18. The coordinator UI refreshes over Socket.IO and
 *  the counselor's first-contact button unlocks. Consumers: M33 (+ the M1 realtime bridge). */
export interface M16ExternalSourceCosignReceivedPayload {
  readonly planId: BereavementPlanId;
  readonly organizationId: string;
  readonly cosignedAt: IsoInstant;
  readonly medicalDirectorMembershipId: MembershipId;
}

/** `m16.bereavement.counselor_assigned` — M36 adds the counselor to the channel and M3's
 *  `bereavement_window` predicate cache invalidates (§7.12). Consumers: M33, M36. */
export interface M16CounselorAssignedPayload {
  readonly planId: BereavementPlanId;
  readonly counselorUserId: MembershipId;
  readonly assignedAt: IsoInstant;
}

/** `m16.bereavement.volunteer_assigned` — the D10 reduced-PHI-scope volunteer joined. Consumers: M33, M36. */
export interface M16VolunteerAssignedPayload {
  readonly planId: BereavementPlanId;
  readonly volunteerUserId: MembershipId;
  readonly assignedAt: IsoInstant;
}

/** `m16.bereavement.contact_active` — a bereaved person confirmed (consent verified per D6).
 *  Consumers: M28 (FHIR `RelatedPerson`), M31, M33, M36. */
export interface M16ContactActivePayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly portalAccountId: BereavedPortalAccountId | null;
}

/** `m16.bereavement.contact_opted_out` — D9. `source` distinguishes the portal-self path from the
 *  M39-revocation cascade, which matters for the §7.8/§7.9 audit story. Consumers: M33, M36. */
export interface M16ContactOptedOutPayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly optOutKind: BereavementOptOutKind;
  readonly source: BereavementOptOutSourceKind;
}

/** `m16.bereavement.contact_opt_out_rescinded` — inside the D9 90-day window. Consumers: M33, M36. */
export interface M16ContactOptOutRescindedPayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
}

/** `m16.bereavement.contact_deceased` — the bereaved contact themselves died. Consumers: M33, M36. */
export interface M16ContactDeceasedPayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
}

/** `m16.bereavement.contact_unreachable` — the 3-strikes detector fired (§2.3). Consumers: M33, M36. */
export interface M16ContactUnreachablePayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly missedTouchpointCount: number;
}

/** `m16.bereavement.contact_referred_external` — complicated grief routed to the M40 external resource
 *  (§7.7); M36 raises the `clinical_urgent` alert. Consumers: M30, M33, M36. */
export interface M16ContactReferredExternalPayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly externalResourceId: ExternalGriefResourceId;
}

/** `m16.bereavement.outreach_scheduled` — a schedule-generator row landed. Consumer: M33. */
export interface M16OutreachScheduledPayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly outreachId: BereavementOutreachId;
  readonly kind: BereavementOutreachKind;
  readonly dueAt: IsoInstant;
}

/** `m16.bereavement.outreach_completed` — the CoP 418.64(d) numerator. `sourceEncounterId` is present
 *  exactly for `in_person_visit` (D15). Consumers: M30, M33. */
export interface M16OutreachCompletedPayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly outreachId: BereavementOutreachId;
  readonly outcome: BereavementContactLogOutcome;
  readonly sourceEncounterId?: EncounterId;
}

/** `m16.bereavement.outreach_missed` — the hourly worker's verdict past `late_grace_until`; feeds the M30
 *  rate denominator and the M36 counselor alert. Consumers: M30, M33, M36. */
export interface M16OutreachMissedPayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly outreachId: BereavementOutreachId;
  readonly dueAt: IsoInstant;
}

/** `m16.bereavement.outreach_artifact_requested` — the D14 outbox-only handoff to M22. M16 never renders a
 *  PDF and imports no M22 schema; M22 answers with `m22.document.rendered`. Consumer: M22. */
export interface M16OutreachArtifactRequestedPayload {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly outreachId: BereavementOutreachId;
  readonly templateKey: string;
  /** The §7.6 body context. Its free-text members (`customPersonalization`, `narrative`) are the D11
   *  audit-denylisted json-paths — typed `unknown` here because M22 owns the per-template shape. */
  readonly payloadJsonb: unknown;
}

/** `m16.bereavement.risk_score_computed` — an immutable D3/D8 score row appended. M30's screening measure
 *  filters `dataCompleteness === 'minimal'` out of its denominator (D17). Consumers: M30, M32, M33. */
export interface M16RiskScoreComputedPayload {
  readonly planId: BereavementPlanId;
  readonly contactId?: BereavedContactId;
  readonly scoreKind: BereavementRiskScoreKind;
  readonly tier: BereavementRiskTier;
  readonly scoreId: BereavementRiskScoreId;
  readonly dataCompleteness: BereavementDataCompleteness;
  readonly confidenceBand: BereavementConfidenceBand;
}

/** `m16.bereavement.anniversary_due_in_14_days` — the daily lookahead cron. Consumers: M33, M36. */
export interface M16AnniversaryDueIn14DaysPayload {
  readonly planId: BereavementPlanId;
  readonly mark: BereavementAnniversaryMark;
  readonly targetDate: LocalDate;
  readonly anniversaryReminderId: BereavementAnniversaryReminderId;
}

/** Name → payload map for the §4.4 taxonomy (the dispatcher's compile-time contract). */
export interface M16EventPayloadMap {
  "m16.bereavement.plan_opened": M16PlanOpenedPayload;
  "m16.bereavement.plan_paused": M16PlanPausedPayload;
  "m16.bereavement.plan_resumed": M16PlanResumedPayload;
  "m16.bereavement.plan_closed_completed": M16PlanClosedCompletedPayload;
  "m16.bereavement.plan_closed_declined": M16PlanClosedDeclinedPayload;
  "m16.bereavement.plan_closed_early": M16PlanClosedEarlyPayload;
  "m16.bereavement.plan_skipped_per_patient_opt_out": M16PlanSkippedPerPatientOptOutPayload;
  "m16.bereavement.external_source_cosign_received": M16ExternalSourceCosignReceivedPayload;
  "m16.bereavement.counselor_assigned": M16CounselorAssignedPayload;
  "m16.bereavement.volunteer_assigned": M16VolunteerAssignedPayload;
  "m16.bereavement.contact_active": M16ContactActivePayload;
  "m16.bereavement.contact_opted_out": M16ContactOptedOutPayload;
  "m16.bereavement.contact_opt_out_rescinded": M16ContactOptOutRescindedPayload;
  "m16.bereavement.contact_deceased": M16ContactDeceasedPayload;
  "m16.bereavement.contact_unreachable": M16ContactUnreachablePayload;
  "m16.bereavement.contact_referred_external": M16ContactReferredExternalPayload;
  "m16.bereavement.outreach_scheduled": M16OutreachScheduledPayload;
  "m16.bereavement.outreach_completed": M16OutreachCompletedPayload;
  "m16.bereavement.outreach_missed": M16OutreachMissedPayload;
  "m16.bereavement.outreach_artifact_requested": M16OutreachArtifactRequestedPayload;
  "m16.bereavement.risk_score_computed": M16RiskScoreComputedPayload;
  "m16.bereavement.anniversary_due_in_14_days": M16AnniversaryDueIn14DaysPayload;
}

// ── §4.10 typed M36 alert payloads ────────────────────────────────────────────────────────────────────

/** §4.10 — the anniversary lookahead notice, resolved to the plan's counselor. */
export interface BereavementAnniversaryDueAlert {
  readonly kind: "anniversary_due_in_14_days";
  readonly planId: BereavementPlanId;
  readonly mark: BereavementAnniversaryMark;
  readonly targetDate: LocalDate;
  readonly counselorUserId: MembershipId;
}

/** §4.10 — a touchpoint blew past its late grace. */
export interface BereavementOutreachMissedAlert {
  readonly kind: "outreach_missed";
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly outreachId: BereavementOutreachId;
  readonly outreachKind: BereavementOutreachKind;
  readonly dueAt: IsoInstant;
}

/** §4.10 — the 3-strikes detector proposes `markUnreachable`; the counselor reviews. */
export interface BereavementContactUnreachableAlert {
  readonly kind: "contact_unreachable";
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly missedTouchpointCount: number;
}

/** §4.10 — the `clinical_urgent` complicated-grief escalation (§7.7). */
export interface BereavementComplicatedGriefReferralAlert {
  readonly kind: "complicated_grief_referral";
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly externalResourceId: ExternalGriefResourceId;
}

/** §4.10 — M39 revoked a consent and M16 cascaded the contact to `opted_out` (§2.6); the remaining-active
 *  count tells the counselor whether the plan itself is about to close as `closed_declined`. */
export interface BereavementConsentRevokedCascadeAlert {
  readonly kind: "consent_revoked_cascade";
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly contactsRemainingActive: number;
}

/** §4.10 — a reassessment moved the tier (D8). `contactId` is null for the plan-level rollup row. */
export interface BereavementRiskTierEscalatedAlert {
  readonly kind: "risk_tier_escalated";
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId | null;
  readonly fromTier: BereavementRiskTier;
  readonly toTier: BereavementRiskTier;
}

/** §4.10 — the D7 early close is waiting on a clinical-supervisor cosign. */
export interface BereavementCloseEarlyPendingCosignAlert {
  readonly kind: "plan_close_early_pending_cosign";
  readonly planId: BereavementPlanId;
  readonly requestedByUserId: MembershipId;
  readonly reason: string;
}

/** The §4.10 discriminated union of every typed alert M16 emits to M36. */
export type BereavementAlertPayload =
  | BereavementAnniversaryDueAlert
  | BereavementOutreachMissedAlert
  | BereavementContactUnreachableAlert
  | BereavementComplicatedGriefReferralAlert
  | BereavementConsentRevokedCascadeAlert
  | BereavementRiskTierEscalatedAlert
  | BereavementCloseEarlyPendingCosignAlert;

// ── §4.6 read DTOs ────────────────────────────────────────────────────────────────────────────────────

/** §4.6 — the plan header every consumer reads. PHI-minimal by construction: no contact channels, no
 *  narrative prose; the decedent is referenced by id, never by name. */
export interface BereavementPlanView {
  readonly planId: BereavementPlanId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId | null;
  readonly status: BereavementPlanStatus;
  readonly deathDate: LocalDate;
  readonly openedAt: IsoInstant | null;
  readonly closedAt: IsoInstant | null;
  readonly assignedCounselorUserId: MembershipId | null;
  readonly assignedVolunteerUserId: MembershipId | null;
  readonly currentRiskTier: BereavementRiskTier | null;
  /** D16/D18 — present only for external-source plans; drives the coordinator banner + the first-contact
   *  gate. `null` means an internal-clinician-recorded death, which is never gated. */
  readonly externalSource: BereavementExternalSourceMetadata | null;
  /** `death_date + 13 months` (D4). M36 archives the channel here; M5 expires the bereavement-window cache. */
  readonly windowEndsAt: IsoInstant;
}

/** §4.6 — one bereaved person on the roster. The contact channels stay behind the route layer (they are
 *  envelope-encrypted per-column); a seam consumer gets reachability booleans, not the values. */
export interface BereavedContactView {
  readonly contactId: BereavedContactId;
  readonly planId: BereavementPlanId;
  readonly status: BereavedContactStatus;
  readonly relationshipCode: BereavedContactRelationship;
  readonly displayName: string;
  readonly preferredLanguageIso639: string;
  readonly portalAccountId: BereavedPortalAccountId | null;
  readonly consentRecordId: ConsentId | null;
  readonly currentRiskTier: BereavementRiskTier | null;
  /** D10 — true when the row is scoped down for a bereavement volunteer's reduced-PHI read. */
  readonly volunteerVisibleOnly: boolean;
  readonly allowedOutreachKinds: readonly BereavementOutreachKind[];
  readonly confirmedAt: IsoInstant | null;
  readonly optedOutAt: IsoInstant | null;
}

/** §4.6 — the closeout / survey-reconstruction rollup (§7.11 / §7.15). */
export interface BereavementPlanSummary {
  readonly plan: BereavementPlanView;
  readonly contacts: readonly BereavedContactView[];
  readonly stats: M16OutreachStats;
  readonly closureReason: BereavementPlanClosureReason | null;
  readonly closureDocumentId: DocumentId | null;
}

/** §4.6 — one scheduled or historical touchpoint. */
export interface BereavementOutreachView {
  readonly outreachId: BereavementOutreachId;
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly kind: BereavementOutreachKind;
  readonly status: BereavementOutreachStatus;
  readonly anniversaryMark: BereavementAnniversaryMark | null;
  readonly dueAt: IsoInstant;
  readonly lateGraceUntil: IsoInstant;
  readonly completedAt: IsoInstant | null;
  readonly assigneeUserId: MembershipId | null;
  readonly renderedDocumentId: DocumentId | null;
  readonly sourceEncounterId: EncounterId | null;
}

/** §4.6 — the `listForPlan` filter set. */
export interface BereavementOutreachFilters {
  readonly contactId?: BereavedContactId;
  readonly status?: readonly BereavementOutreachStatus[];
  readonly kind?: readonly BereavementOutreachKind[];
  readonly dueFromIso?: IsoInstant;
  readonly dueToIso?: IsoInstant;
}

/** §4.6 — the per-status volume M33's operational dashboard charts. */
export type BereavementOutreachStatusCounts = {
  readonly [K in BereavementOutreachStatus]: number;
};

/** §4.6 — the CoP 418.64(d) compliance rate as COUNTS, never a pre-divided rate: M30 needs the denominator
 *  itself for CMS small-N suppression (the M15-T05 / M30 seam lesson — a rate alone is unsuppressable). */
export interface BereavementCopComplianceCounts {
  readonly numerator: number;
  readonly denominator: number;
}

/** §4.6 — the scope every M16 rollup is computed over (mirrors M15's `ComplianceScope`; M16 denormalizes
 *  the PE / location columns onto its tables for the same reason). */
export interface BereavementScope {
  readonly orgId: string;
  readonly providerEntityId?: ProviderEntityId;
  readonly locationId?: LocationId;
  readonly fromIso?: IsoInstant;
  readonly toIso?: IsoInstant;
}

/** D17 — one of the 8 deterministic rubric factors. `unknown` is a THIRD explicit value, never a silent
 *  `false`: treating an unknowable factor as absent understates risk (D17's rejected alternative (a)). */
export type BereavementFactorValue = true | false | "unknown";

/** D3/D17 — the 8-factor input vector the deterministic scorer consumes. */
export interface BereavementRiskFactorInputs {
  readonly ambivalentRelationship: BereavementFactorValue;
  readonly suddenUnexpectedDeath: BereavementFactorValue;
  readonly priorUnresolvedLoss: BereavementFactorValue;
  readonly preExistingMentalHealth: BereavementFactorValue;
  readonly socialIsolation: BereavementFactorValue;
  readonly financialStrain: BereavementFactorValue;
  readonly primaryCaregiverRole: BereavementFactorValue;
  readonly activeSubstanceUse: BereavementFactorValue;
}

/** One of the 8 D17 factor names. */
export type BereavementRiskFactorName = keyof BereavementRiskFactorInputs;

/** §4.6 — the factor snapshot M32 reads before composing a Layer-2 narrative. `redactedCategories` is the
 *  §7.13 42 CFR Part 2 story: when M15's `MswRiskFactorReader` filtered SUD content out at the SQL layer,
 *  the snapshot says so, so a surveyor can reconstruct why the score moved. */
export interface BereavementRiskFactorsSnapshot {
  readonly contactId: BereavedContactId;
  readonly planId: BereavementPlanId;
  readonly asOf: IsoInstant;
  readonly factors: BereavementRiskFactorInputs;
  readonly pg13Score: number | null;
  readonly ipgrScore: number | null;
  readonly dataCompleteness: BereavementDataCompleteness;
  readonly confidenceBand: BereavementConfidenceBand;
  readonly redactedCategories: readonly string[];
}

/** §4.6 — the deterministic score read (D3: the tier is the source of truth; the LLM cannot move it). */
export interface BereavementDeterministicScore {
  readonly scoreId: BereavementRiskScoreId;
  /** The D17 weighted score over the KNOWABLE factors only, in [0, 1]. */
  readonly score: number;
  readonly tier: BereavementRiskTier;
  readonly dataCompleteness: BereavementDataCompleteness;
  readonly confidenceBand: BereavementConfidenceBand;
  readonly assessedAt: IsoInstant;
}

/** §4.6 — the M32 Layer-2 result written back onto the score row. AI Governance §7.4: `tier` is advisory
 *  narrative context ONLY; `registerAugmentation` never overwrites the deterministic tier. */
export interface BereavementAugmentationResult {
  readonly narrative: string;
  readonly modelRef: string;
  readonly requestId: string;
  readonly augmentedScore: number | null;
  readonly augmentedTier: BereavementRiskTier | null;
}

/** §4.6 — the tier distribution M30's chart and M33's dashboard read. */
export type BereavementRiskTierDistribution = {
  readonly [K in BereavementRiskTier]: number;
};

/** §4.6 — who is on the hook for a plan (M36's `bereavement_counselor_for_plan` recipient resolver, and
 *  M3's `bereavement_window` predicate). */
export interface BereavementAssignment {
  readonly planId: BereavementPlanId;
  readonly counselorUserId: MembershipId | null;
  readonly volunteerUserId: MembershipId | null;
  readonly status: BereavementPlanStatus;
}

/** §4.6 — what an M31 portal session may see of the bereavement program. Deliberately narrow: a bereaved
 *  contact sees their OWN contact row, their own touchpoints, and the opt-out control — never the roster,
 *  never another survivor's state, never the decedent's clinical record. */
export interface BereavedPortalScope {
  readonly contactId: BereavedContactId;
  readonly planId: BereavementPlanId;
  readonly status: BereavedContactStatus;
  readonly inBereavementWindow: boolean;
  readonly mayOptOut: boolean;
  /** D9 — true only inside the 90-day self-service rescind window. */
  readonly mayRescindOptOut: boolean;
}

// ── §4.6 / D13 seams this module publishes (impls injected at boot in M16-T05) ────────────────────────

/**
 * §4.6 — bereavement-plan reads (consumed by M28 FHIR, M30 HQRP, M31 portal, M33 reporting, M36 channel
 * membership). Every method is org-scoped by its first argument, matching the M15/M17 seam convention: the
 * caller's RLS context is established by `withOrgContext` before the impl runs.
 */
export interface BereavementPlanProvider {
  planById(orgId: string, planId: BereavementPlanId): Promise<BereavementPlanView | null>;
  planByAdmissionId(orgId: string, admissionId: AdmissionId): Promise<BereavementPlanView | null>;
  /** D4 — true while `asOf` sits inside `[death_date, death_date + 13 months)` AND the plan is not closed. */
  isInBereavementWindow(
    orgId: string,
    planId: BereavementPlanId,
    asOfIso: IsoInstant,
  ): Promise<boolean>;
  contactsForPlan(
    orgId: string,
    planId: BereavementPlanId,
  ): Promise<readonly BereavedContactView[]>;
  summarize(orgId: string, planId: BereavementPlanId): Promise<BereavementPlanSummary | null>;
}

/** §4.6 — outreach reads (consumed by M30's CoP rate and M33's operational dashboard). */
export interface BereavementOutreachProvider {
  listForPlan(
    orgId: string,
    planId: BereavementPlanId,
    filters: BereavementOutreachFilters,
  ): Promise<readonly BereavementOutreachView[]>;
  countByStatus(scope: BereavementScope): Promise<BereavementOutreachStatusCounts>;
  copComplianceCounts(scope: BereavementScope): Promise<BereavementCopComplianceCounts>;
}

/** §4.6 — risk-factor reads + the Layer-2 write-back (consumed by M32; the distribution by M30/M33). */
export interface BereavementRiskFactorsProvider {
  factorsForContact(
    orgId: string,
    contactId: BereavedContactId,
    asOfIso: IsoInstant,
  ): Promise<BereavementRiskFactorsSnapshot | null>;
  deterministicScore(
    orgId: string,
    contactId: BereavedContactId,
  ): Promise<BereavementDeterministicScore | null>;
  registerAugmentation(
    orgId: string,
    contactId: BereavedContactId,
    augmentation: BereavementAugmentationResult,
  ): Promise<BereavementRiskScoreId>;
}

/** §4.6 / D13 — the assignment read M36's recipient resolver and M3's `bereavement_window` predicate use. */
export interface BereavementAssignmentReader {
  assignmentForPlan(
    orgId: string,
    planId: BereavementPlanId,
  ): Promise<BereavementAssignment | null>;
  plansForCounselor(
    orgId: string,
    counselorUserId: MembershipId,
  ): Promise<readonly BereavementPlanView[]>;
}

/** §4.6 / D13 — the M31 portal scope for a bereaved-person session class. */
export interface BereavedPortalScopeProvider {
  scopeForPortalAccount(
    orgId: string,
    portalAccountId: BereavedPortalAccountId,
  ): Promise<readonly BereavedPortalScope[]>;
}

/** §4.6 / D13 — the M30 HQRP + M33 rollups. Counts, never rates: a zero denominator must stay visible so
 *  CMS small-N suppression downstream is honest. */
export interface BereavementComplianceProvider {
  copOutreachCounts(scope: BereavementScope): Promise<BereavementCopComplianceCounts>;
  /** D17 — the screening-completeness measure EXCLUDES `minimal` rows from its denominator. */
  riskScreeningCompletenessCounts(scope: BereavementScope): Promise<BereavementCopComplianceCounts>;
  planClosureCounts(
    scope: BereavementScope,
  ): Promise<{ readonly [K in BereavementPlanClosureReason]: number }>;
}

/** §4.6 / D13 — the tier distribution (consumed by M30's chart and M33's dashboard). */
export interface BereavementRiskTierProvider {
  tierDistribution(scope: BereavementScope): Promise<BereavementRiskTierDistribution>;
}

/** TASK-015 — one M40 `external_grief_resource` row, the M31 bereaved-portal "resources" list item. */
export interface ExternalGriefResource {
  readonly id: ExternalGriefResourceId;
  readonly name: string;
  readonly url: string | null;
  readonly description: string | null;
}

/**
 * The M31 bereaved-portal resources read (`GET /portal/bereavement/resources`). DENY-STUB ONLY today
 * — no `external_grief_resource` table exists anywhere in `packages/db` (M40 has not built this
 * surface); `ExternalGriefResourceId` above is a forward-reference type alias only, per the existing
 * comment on that type. Fails closed (empty list) until M40 ships the catalog and registers a real impl.
 */
export interface ExternalGriefResourceReader {
  resourcesForOrg(organizationId: string): Promise<readonly ExternalGriefResource[]>;
}
