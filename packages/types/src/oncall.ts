// @wardenx/types — Module 19 (On-Call Triage) leaf contracts (M19-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package, so the downstream consumers
// (M36's `on_call` recipient resolver, M20's after-hours SOS parallel recipient, M14's IDG packet, M31's
// portal care-log, M30/M33's operational measures, M32's advisory models) import them with NO `dependsOn`
// edge. M19 never imports another module's feature package.
//
// LAYOUT READ (Wave P2-2 acceptance #1): the spec's §3.1 layout proposes a `packages/oncall` feature
// package holding `seams.ts` / `events.ts` / `disposition-types.ts` / `protocol-catalog.ts`. That package
// is NOT in `architecture/module-manifest.ts` and the wave's acceptance criterion #1 limits this wave's
// manifest changes to the already-applied `packages/triage-vendors` codePath (ADR-0028) and the two
// Track B web codePaths (ADR-0030). The manifest is the single source of truth, so M19's TYPE surface
// resolves HERE, its domain services live under `apps/backend/src/modules/19-oncall` (the M6 precedent
// for a module with no feature package), and the vendor-adapter boundary stays in
// `@wardenx/triage-vendors` (§8.5 / architecture §25.14). Nothing in the spec's §3.1 is lost — only
// re-homed onto paths the fitness gates actually govern.
//
// M19-T01 ships the type-level surface every later M19 task builds on: the §3.2 pgEnum value mirrors, the
// §3.3 owned-table names + the §3.6 audit denylists and retention classes (the M4 trigger arguments
// M19-T02 passes), the §2.2.1 state/transition vocabulary, the D6 per-disposition discriminated union,
// the §4.10 `m19.*` outbox event names + payload types, the subscribed-event names, the §4.9 typed M36
// alert payloads, and the §4.3 five published reader-seam interfaces + their read DTOs.
//
// NAMING: every exported symbol carries a `Triage` / `OnCall` / `Oncall` / `M19` prefix.
// `@wardenx/types` is re-exported wholesale from `./index.ts`, so a bare `Disposition` /
// `EscalationTier` / `RiskBand` would be a TS2308 collision the day M20 / M30 / M37 wants the same word
// (the M14 `IdgDecisionPayload` precedent).
//
// SPEC READ (ADR-0005 authority): where the §11 D-list prose and the §3.3 Drizzle block name a column
// differently, §3.3 is normative and is what the mirrors below follow — D3's `deployment_model` is
// §3.3's `model`, D13's `phi_minimization_profile` is §3.3's `default_minimization_policy`, and D9's
// `linked_order_ids` is §3.3's `linked_verbal_order_ids`. Likewise §12/§13 still say "nine owned tables"
// and `packages/triage`; the manifest's TEN tables (incl. `triage_paper_reentry_worklist`, added by the
// M19-F08 BCP amendment) and `packages/triage-vendors` win.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { AdmissionId, OrgId, PatientId, ProviderEntityId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";
import type { EncounterId } from "./encounter";
import type { OrderRecordId } from "./orders";
import type { IsoDate, MeasureCounts, VisitProposalId } from "./scheduling";

// ── M19-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ─────────
export type TenantOncallPolicyId = string;
export type ExternalTriageVendorId = string;
export type OnCallShiftId = string;
export type TriageProtocolId = string;
export type TriageProtocolQuestionId = string;
export type TriageCallId = string;
export type TriageCallAnswerId = string;
export type TriageEscalationId = string;
export type TriageCallStateHistoryId = string;
export type TriagePaperReentryWorklistId = string;

/** Soft refs M19 stores but does not own: the M40 canonical vendor entity behind an
 *  `external_triage_vendor` row, the M5 caregiver a caller resolved to, the M31 portal session a
 *  portal-originated call arrived on, and the system-generated outage window a BCP worklist row belongs
 *  to. Each is a LOGICAL FK — validated through the owning module's reader seam at write time, never a
 *  SQL FK (§3.3). The M17 proposal id a dispatch disposition produces is M17's own `VisitProposalId`,
 *  imported above rather than re-declared. */
export type MdmVendorId = string;
export type TriageCaregiverId = string;
export type PortalSessionId = string;
export type OutageWindowId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────────────

/** `oncall_model` — D3. Only `direct` is enabled at Phase 1; `hybrid`/`centralized` are structurally
 *  complete behind a per-customer feature flag (default OFF) pending vendor BAA + Compliance sign-off. */
export type OncallModel = "direct" | "hybrid" | "centralized";

/** `oncall_shift_status` — §2.2.2. */
export type OncallShiftStatus = "scheduled" | "active" | "completed" | "cancelled";

/** `oncall_shift_discipline` — who the shift designates. `external` is the Hybrid/Centralized case where
 *  the recipient is a vendor actor rather than a membership. */
export type OncallShiftDiscipline =
  | "clinical_rn"
  | "clinical_lpn"
  | "medical_director"
  | "msw"
  | "chaplain"
  | "external";

/** `triage_call_state` — §2.2.1 / D6. `documented_pending_encounter` (M19-F06 / ADR-0022) is where the
 *  call parks after disposition selection while awaiting `m8.encounter.signed` (D8), and where the §2.7
 *  D-B degraded-mode flow strands it when the M8 `EncounterCreator` seam is unreachable. */
export type TriageCallState =
  | "open"
  | "protocol_in_progress"
  | "awaiting_callback"
  | "disposition_pending"
  | "documented_pending_encounter"
  | "documented"
  | "escalated_unresolved"
  | "abandoned"
  | "closed";

/** `triage_call_caller_kind` — `system_inbound` covers the D10 machine-opened calls (M17 no-show, M18
 *  late check-out) where no human dialled in. */
export type TriageCallCallerKind =
  | "patient"
  | "caregiver"
  | "external_clinician"
  | "portal_session"
  | "system_inbound"
  | "bereaved_family";

/** `triage_call_inbound_channel` — the transport the call arrived on. */
export type TriageCallInboundChannel =
  | "phone"
  | "sms"
  | "email"
  | "portal_message"
  | "inbound_visit_failure"
  | "inbound_evv_anomaly"
  | "inbound_alert_failure"
  | "inbound_afterhours_request";

/**
 * `triage_call_source` — what caused the row to exist.
 *
 * SPEC READ (M19-F08): `paper_origin` is ADDED to the §3.2 Phase-A list. §2.7 step 1 requires the BCP
 * re-entry path to open the call with `source='paper_origin'` and `paper_origin_flag=true`; the F08
 * amendment added the two `paper_origin_*` columns to §3.3 but never updated the enum, so following §3.2
 * verbatim would leave §2.7 unimplementable. M19-T02 carries the CHECK keeping flag and enum in step.
 */
export type TriageCallSource =
  | "manual"
  | "no_show"
  | "late_checkout"
  | "geofence_anomaly"
  | "m36_delivery_failure"
  | "paper_origin"
  | "m36_afterhours_request";

/** `triage_disposition` — D6. The enumerable commitment that ends the call. */
export type TriageDisposition =
  | "caregiver_education_only"
  | "prn_intervention_authorized"
  | "verbal_order_recorded"
  | "visit_dispatched_now"
  | "visit_scheduled_first_light"
  | "gip_admission_proposed"
  | "ed_transfer_acknowledged"
  | "pronouncement_scheduled"
  | "escalated_unresolved"
  | "abandoned";

/** `triage_escalation_tier` — D7. `tier_5_external` is the only tier whose recipient is a vendor. */
export type TriageEscalationTier =
  | "tier_1_rn_supervisor"
  | "tier_2_clinical_manager"
  | "tier_3_medical_director"
  | "tier_4_compliance_officer"
  | "tier_5_external";

/** `triage_escalation_trigger` — `red_flag_question` and `mandatory_protocol` are the two the SERVER
 *  writes itself (D5/D7); no tenant policy can suppress either. */
export type TriageEscalationTrigger =
  | "manual"
  | "red_flag_question"
  | "mandatory_protocol"
  | "sla_breach";

/** `triage_protocol_answer_type` — selects which of `triage_call_answer`'s three typed value columns the
 *  server writes, and therefore which column D5's red-flag match is evaluated against. */
export type TriageProtocolAnswerType = "boolean" | "integer" | "scale_0_10" | "free_text" | "enum";

/**
 * D5 (M19-T03) — the shape stored in `triage_protocol_question.red_flag_match`, and therefore the shape
 * the platform-floor seed encodes and the server-side evaluator reads.
 *
 * It is a CLOSED, declarative union rather than an expression string on purpose. `red_flag_match` decides
 * whether a suicidal-ideation answer writes a mandatory escalation; if it were a snippet the catalog
 * evaluated, a tenant-authored protocol would be arbitrary code running inside the escalation path, and a
 * malformed one would fail at 2 a.m. in the direction of NOT escalating. Each arm names exactly one of the
 * three typed answer columns, so a predicate can never be evaluated against a column the question does not
 * write (`answerTypeForMatch` in the protocol engine is the compile-time-checked mapping).
 *
 * `text_any` exists because a `free_text` red-flag question ("describe what the caller said") is a flag on
 * the PRESENCE of an answer, not on its content: matching prose would need the caller's own words to be
 * pattern-matched, and those words are the §3.6-denylisted column.
 */
export type TriageRedFlagMatch =
  /** `boolean` questions — fires when the recorded boolean equals `value`. */
  | { readonly kind: "bool_is"; readonly value: boolean }
  /** `integer` / `scale_0_10` — fires at or above the threshold (pain ≥ 7). */
  | { readonly kind: "int_at_least"; readonly threshold: number }
  /** `integer` / `scale_0_10` — fires at or below (glucose ≤ 60). */
  | { readonly kind: "int_at_most"; readonly threshold: number }
  /** `enum` — fires when the recorded member is in the set. */
  | { readonly kind: "enum_in"; readonly values: readonly string[] }
  /** `free_text` — fires when any non-blank text was recorded. */
  | { readonly kind: "text_any" };

/** `triage_risk_band` — D11. ADVISORY ONLY: gates nothing, alters no disposition option, and is excluded
 *  from the M31 portal projection. */
export type TriageRiskBand = "low" | "medium" | "high";

/** `triage_ai_confidence` — D12. Below the governance floor the suggestion is still SHOWN (de-emphasized)
 *  and, at any confidence, never auto-applied. */
export type TriageAiConfidence = "low" | "medium" | "high";

// ── §2.2.1 state vocabulary the seams, routes and screens share ───────────────────────────────────────

/**
 * The states a call is still LIVE in — the set behind §3.3's `triage_call_open_pe_idx` partial index and
 * the supervisor open-cases view. `documented_pending_encounter` is deliberately IN this set (M19-F06 /
 * ADR-0022): a call stranded by a down M8 seam must stay visible to the supervisor, not silently drop
 * off the board because its disposition was picked.
 */
export const TRIAGE_CALL_OPEN_STATES = [
  "open",
  "protocol_in_progress",
  "awaiting_callback",
  "disposition_pending",
  "documented_pending_encounter",
  "escalated_unresolved",
] as const satisfies readonly TriageCallState[];

/** The states no command advances out of. `documented` is NOT terminal — the `close-documented.cron`
 *  worker moves it to `closed` after the 30-minute amendment grace (§2.2.1). */
export const TRIAGE_CALL_TERMINAL_STATES = [
  "closed",
  "abandoned",
] as const satisfies readonly TriageCallState[];

/** §2.2.4 — the escalation row's own three-step life. Mandatory-escalation rows (the four D7 protocols)
 *  are the ones a call close may NOT auto-resolve; they need an explicit `resolveEscalation` write. */
export type TriageEscalationState = "open" | "acknowledged" | "resolved";

// ── §3.3 owned tables + the §3.6 audit denylist / retention class (M4 trigger arguments for M19-T02) ──

/** The twelve tables M19 owns (the twelfth, `triage_afterhours_decision`, is ADR-0082 slice S2, migration 1134) per the manifest `ownedTables`. §12/§13 of the spec still say nine — they
 *  predate the M19-F08 BCP amendment that added `triage_paper_reentry_worklist`, and neither mentions
 *  `on_call_roster_sync_queue` (F-165, #248 — the §4.8 `m19.shift-sync.debounced` debounce table); the
 *  manifest wins. */
export type M19TableName =
  | "tenant_oncall_policy"
  | "external_triage_vendor"
  | "on_call_shift"
  | "on_call_roster_sync_queue"
  | "triage_protocol"
  | "triage_protocol_question"
  | "triage_call"
  | "triage_call_answer"
  | "triage_escalation"
  | "triage_call_state_history"
  | "triage_paper_reentry_worklist"
  | "triage_afterhours_decision";

export const M19_TABLE_NAMES = [
  "tenant_oncall_policy",
  "external_triage_vendor",
  "on_call_shift",
  "on_call_roster_sync_queue",
  "triage_protocol",
  "triage_protocol_question",
  "triage_call",
  "triage_call_answer",
  "triage_escalation",
  "triage_call_state_history",
  "triage_paper_reentry_worklist",
  "triage_afterhours_decision",
] as const satisfies readonly M19TableName[];

/**
 * §3.6 — the columns the M4 PHI write-audit trigger excludes from value capture. The row diff still
 * records THAT the column changed and who changed it; the cleartext is not copied into the audit row.
 * Surveyor-grade reconstruction reads the row itself (subject to ABAC).
 *
 * DENYLIST READ: `triage_call_answer.answer_value_text` is denylisted UNCONDITIONALLY here, while §3.6
 * qualifies it with "when the parent question has `answer_type='free_text'`". A trigger fires on the
 * answer row and has no cheap, non-racing way to read the parent question's type mid-write, and the
 * conditional would fail OPEN — capturing a free-text answer's cleartext whenever the lookup could not
 * be resolved. The enum/boolean/integer answers a blanket denylist also scrubs are fully reconstructible
 * from their own typed columns (`answer_value_int` / `answer_value_bool`, neither denylisted), so
 * nothing auditable is lost. The `red_flag_hit` column is deliberately NOT denylisted — it is the D5
 * tamper-evidence that the server evaluated the flag, and scrubbing it would erase the only record a
 * mandatory-escalation-suppression investigation reads.
 */
export const M19_AUDIT_DENYLIST: { readonly [K in M19TableName]: readonly string[] } = {
  tenant_oncall_policy: [],
  external_triage_vendor: [],
  on_call_shift: ["cancellation_reason", "compensation_metadata"],
  on_call_roster_sync_queue: [],
  triage_protocol: [],
  triage_protocol_question: [],
  triage_call: [
    "caller_phone_e164",
    "caller_quote_cipher",
    "transcript_cipher",
    "chief_complaint_text",
  ],
  triage_call_answer: ["answer_value_text"],
  triage_escalation: ["trigger_detail", "resolution"],
  triage_call_state_history: [],
  triage_paper_reentry_worklist: [],
  triage_afterhours_decision: [],
} as const;

/**
 * §3.6 / ADR-0004 — the retention class each owned table's audit rows carry. Values are the real
 * `audit_retention_class` pgEnum members (`operational` 1 y / `compliance` 7 y / `legal_hold`
 * indefinite), not a prose label: migration 0033's precedent maps the clinical record itself onto
 * `compliance` (CoP 418.104 six-year floor, standardized to seven per ADR-0004 / M4 D1).
 *
 * Every clinical/coverage table is `compliance`, and that uniformity is the considered answer rather
 * than a default. The call tables ARE the clinical record. `on_call_shift` is the CoP 418.100(c)(2)
 * proof that a nurse was reachable at 2 a.m. — the single most survey-load-bearing row M19 writes.
 * `tenant_oncall_policy` and the protocol pair hold the D7 mandatory-escalation floor, so an edit to
 * them is exactly what a suppression investigation reads. `external_triage_vendor` carries the BAA
 * attestation. `triage_paper_reentry_worklist` is the DR-013/066 BCP evidence that the paper-origin
 * calls were reconciled — its 72-hour operational LIFETIME says nothing about how long the audit of it
 * must live. `on_call_roster_sync_queue` is the one exception (F-165, #248) — see its own entry below.
 */
export const M19_AUDIT_RETENTION_CLASS: {
  readonly [K in M19TableName]: "operational" | "compliance" | "legal_hold";
} = {
  tenant_oncall_policy: "compliance",
  external_triage_vendor: "compliance",
  on_call_shift: "compliance",
  // F-165 (#248) — the §4.8 debounce/catch-up queue backing the `m19.shift-sync.debounced` reconciler.
  // `operational`, not `compliance`: it is process bookkeeping for a reconciliation PASS, not the
  // clinical/coverage record itself (that's `on_call_shift`, immediately above) — the same distinction
  // migration 0253's `dosespot_sync_queue` trigger already draws for the identical queue shape.
  on_call_roster_sync_queue: "operational",
  triage_protocol: "compliance",
  triage_protocol_question: "compliance",
  triage_call: "compliance",
  triage_call_answer: "compliance",
  triage_escalation: "compliance",
  triage_call_state_history: "compliance",
  triage_paper_reentry_worklist: "compliance",
  triage_afterhours_decision: "operational",
} as const;

/** §3.7 — the M4 `DataEraser` data class M19 registers at boot. The triage call itself survives
 *  de-identified (a tombstone keyed on org+shift+opened_at) because M8's signed encounter carries a
 *  back-reference to it; the answers, escalations and state history are deleted outright. */
export const M19_ERASER_DATA_CLASS = "triage_record" as const;

// ── §4.2 / D6 per-disposition payload (the discriminated union `disposition_data` is validated against) ─

/** D6 — the typed payload each disposition carries in `triage_call.disposition_data`. Discriminated on
 *  `disposition` so a handler that reads a field the chosen disposition does not carry is a compile
 *  error, not a runtime shrug. The `escalated_unresolved` and `abandoned` arms exist because both are
 *  reachable as dispositions in the §3.2 enum even though they are also call states. */
export type TriageDispositionData =
  | {
      readonly disposition: "caregiver_education_only";
      /** What the caregiver was taught, in the clinician's words. PHI-bearing free text. */
      readonly educationSummary: string;
      readonly followUpCallAt: IsoInstant | null;
    }
  | {
      readonly disposition: "prn_intervention_authorized";
      /** D15 — the EXISTING M11/M12 order authorized for PRN use. M19 validates it through the owning
       *  module's reader; it never writes an order row itself. */
      readonly orderRecordId: OrderRecordId | null;
      readonly medicationOrderId: string | null;
      readonly instructionsGiven: string;
    }
  | {
      readonly disposition: "verbal_order_recorded";
      /** D9 — the M11 verbal order taken during the call, recorded through `OrderSignatureProvider`
       *  with step-up auth. M19 stores only the id it gets back. */
      readonly orderRecordId: OrderRecordId;
      readonly attendingPhysicianId: string | null;
    }
  | {
      readonly disposition: "visit_dispatched_now";
      readonly requestedDiscipline: string;
      readonly requestedArrivalBy: IsoInstant;
      readonly reason: string;
    }
  | {
      readonly disposition: "visit_scheduled_first_light";
      readonly requestedDiscipline: string;
      readonly proposedForDate: IsoDate;
      readonly reason: string;
    }
  | {
      readonly disposition: "gip_admission_proposed";
      readonly gipCriteriaSummary: string;
      readonly preferredFacility: string | null;
    }
  | {
      readonly disposition: "ed_transfer_acknowledged";
      /** The patient/family election text captured verbatim — this is the revocation-adjacent record a
       *  surveyor asks for when a hospice patient reaches an ED. */
      readonly electionText: string;
      readonly transportArrangedBy: "family" | "ems" | "facility" | "unknown";
    }
  | {
      readonly disposition: "pronouncement_scheduled";
      readonly pronouncingDiscipline: string;
      readonly expectedArrivalBy: IsoInstant | null;
    }
  | {
      readonly disposition: "escalated_unresolved";
      readonly escalationId: TriageEscalationId;
      readonly tier: TriageEscalationTier;
    }
  | {
      readonly disposition: "abandoned";
      readonly reason: string;
      readonly callbackAttempts: number;
    };

// ── §4.10 emitted outbox events ──────────────────────────────────────────────────────────────────────

/**
 * The `m19.*` events M19 publishes. Every name is the §4.10 catalog's verbatim topic and every one
 * already satisfies the M01 D8 / M03 D9 `mN.<resource>.<verb>` convention `arch:gaps` enforces, so no
 * normalization was needed (unlike M21's three two-segment names).
 *
 * `m19.oncall_shift.activated` is the SINGLE canonical shift-open topic per M19-F12 — the older
 * duplicate `m19.on_call_shift.opened` is retired; M20's shift-changed consumer and M36's channel-
 * rotation synchronizer both subscribe here. M33 already subscribes to `m19.triage_call.opened` and
 * `m19.triage_call.closed` (`packages/reporting/src/catalog/outbox-subscription-map.ts`), so renaming
 * either would break a LIVE consumer, not a hypothetical one.
 */
export const M19_EVENT_NAMES = [
  "m19.triage_call.opened",
  "m19.triage_call.protocol_applied",
  "m19.triage_call.red_flag_hit",
  "m19.triage_call.escalation_recorded",
  "m19.triage_call.disposition_selected",
  "m19.triage_call.documented",
  "m19.triage_call.visit_needed",
  "m19.triage_call.gip_admission_proposed",
  "m19.triage_call.care_plan_change_indicated",
  "m19.triage_call.closed",
  "m19.oncall_shift.activated",
  "m19.oncall_shift.completed",
  "m19.oncall_shift.coverage_gap",
  "m19.triage.summary_requested",
  // GAP-057 follow-up (b11) — the §4.8 `callback-sla` / `escalation-sla` crons' findings; M36 turns each into
  // its `m19.triage.*_sla_breached` page (`36-messaging/outbox-consumers/oncall-alerts.ts`).
  "m19.triage_call.callback_sla_breached",
  "m19.triage_call.escalation_sla_breached",
  // ADR-0082 slice S2 — the id-only answer to `m36.afterhours_triage.requested`; M36 declares the consumer.
  "m19.afterhours_triage.outcome",
] as const;

/** One §4.10 outbox event name. */
export type M19EventName = (typeof M19_EVENT_NAMES)[number];

/** §2.6 — the per-event idempotency key a consumer de-duplicates on, beyond the M1 envelope's `event_id`
 *  every subscriber already keys on. M19's own emits are keyed `(triageCallId, topic, transitionedAt)`
 *  by the M1 outbox helper; this map is what a DOWNSTREAM consumer collapses retries against. */
export const M19_EVENT_IDEMPOTENCY_KEYS = {
  "m19.triage_call.opened": "triageCallId",
  "m19.triage_call.documented": "triageCallId",
  "m19.triage_call.visit_needed": "triageCallId",
  "m19.triage_call.gip_admission_proposed": "triageCallId",
  "m19.triage_call.closed": "triageCallId",
  "m19.oncall_shift.activated": "shiftId",
  "m19.oncall_shift.completed": "shiftId",
} as const satisfies Partial<Record<M19EventName, string>>;

/**
 * The events M19 SUBSCRIBES to (§3.1 `consumers/`, §4.8 queue catalog). Listed here — not only in the
 * worker files — so M19-T04's consumer wiring and the §9 tests share one source of truth, and so an
 * upstream rename breaks the build rather than silently orphaning a handler. M19 owns none of these
 * prefixes; consuming them needs no `dependsOn` edge.
 *
 * NAME READ: §4.8's queue table spells the M36 trigger `m36.delivery_failed` (two segments). The form used
 * here — `m36.notification.delivery_failed` — is what §3.1's consumer filename comment names and the only
 * one satisfying the three-segment convention. F-094/#205 corrects what this paragraph used to assert: M36
 * does not "actually emit" it, under that name or any other. M36 contributes NO event catalog to the boot
 * dispatcher (there is no `M36_OUTBOX_EVENTS`), so `./consumers/m36-delivery-failed.ts` waits on a topic no
 * producer can publish. Registered in `scripts/outbox-subscription-exceptions.ts` rather than deleted: the
 * handler and M20's matching `delivery_failed` SOS escalation reason are the record that this integration
 * is intended and unbuilt.
 *
 * `m17.visit.assigned` is M17's canonical roster-change signal (M17 §4.11 emits no separate
 * `m17.roster.changed`), and is what the debounced Direct-model shift-sync reconciles on.
 */
// F-140 (#248) checked every entry above the "not routed" split against M19's own spec text rather than
// trusting the F-094 comparison at face value. `m17.visit.unassigned`/`.time_off.approved`/
// `.reassignment_needed` and both `m20.safety.*` events are each a SEAM PULL M19's own spec describes at
// the point of use (the shift-sync worker re-pulls the roster off `.assigned` alone; the "go on shift"
// gate reads PTO/credential state fresh via an M17 reader; M20 pulls M19's `OnCallProvider` seam for its
// after-hours recipient set) — never a push subscription, and no consumer file exists or is planned for
// any of the five. Both `m39.consent.delegated_access.*` events are the same shape: portal-caregiver
// access is gated by a live `ConsentEvaluator.isActive` seam pull, per request, not a cached push. All
// seven removed at the source (`events-by-m17.ts`/`events-by-m20.ts`/`events-by-m39.ts`) and here.
export const M19_SUBSCRIBED_EVENT_NAMES = [
  "m17.visit.no_show_detected",
  "m17.visit.assigned",
  "m18.evv.late_check_out_detected",
  // GAP-058 — routed AND bound (`consumers/m8-encounter-signed-binding.ts`): M8 declares `m19` on it.
  "m36.notification.delivery_failed",
  // ADR-0082 slice S2 - routed AND bound (`consumers/bindings.ts`): M36 catalogues it (slice S1), declares `m19`.
  "m36.afterhours_triage.requested",
  "m8.encounter.signed",
  // ADR-0082 slice S1 - declared by M36 on the catalog entry; the D10 consumer is slice S2 (unbound until then, see
  // `scripts/outbox-deferred-consumers.ts`).
  "m36.afterhours_triage.requested",
  // Subscribed and NOT routed here — each registered in `scripts/outbox-subscription-exceptions.ts`.
  "m11.order.verbal_expired_unsigned",
  "m5.patient.deceased",
] as const;

/** One subscribed event name. */
export type M19SubscribedEventName = (typeof M19_SUBSCRIBED_EVENT_NAMES)[number];

// ── §4.10 outbox payloads (the shape each subscriber type-checks against) ─────────────────────────────

/** Fields every M19 call-scoped event carries so a consumer can scope without a second read. */
export interface M19TriageCallEventBase {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly occurredAt: IsoInstant;
}

/** `m19.triage_call.opened`. `paperOrigin`/`originalOpenedAt` are the §2.7 step-5 BCP fields: downstream
 *  consumers (M14 IDG, M30 HQRP) order chronologically on the ORIGINAL call time, not the re-entry
 *  wall-clock, or a paper-origin call sorts as if it happened after the outage it happened during. */
export interface M19TriageCallOpenedPayload extends M19TriageCallEventBase {
  readonly onCallShiftId: OnCallShiftId;
  readonly source: TriageCallSource;
  readonly patientId: PatientId | null;
  readonly paperOrigin: boolean;
  readonly originalOpenedAt: IsoInstant | null;
}

/** `m19.triage_call.protocol_applied` — carries the version PINNED at apply time (D4 mid-call freeze). */
export interface M19TriageCallProtocolAppliedPayload extends M19TriageCallEventBase {
  readonly triageProtocolId: TriageProtocolId;
  readonly protocolVersion: string;
  readonly mandatoryEscalation: TriageEscalationTier | null;
}

/** `m19.triage_call.red_flag_hit` — the escalation row is created in the SAME transaction as the answer
 *  (D5), so `escalationId` is always populated. */
export interface M19TriageCallRedFlagHitPayload extends M19TriageCallEventBase {
  readonly questionId: TriageProtocolQuestionId;
  readonly escalationId: TriageEscalationId;
}

/** `m19.triage_call.escalation_recorded`. */
export interface M19TriageCallEscalationRecordedPayload extends M19TriageCallEventBase {
  readonly escalationId: TriageEscalationId;
  readonly tier: TriageEscalationTier;
  readonly triggerKind: TriageEscalationTrigger;
}

/** `m19.triage_call.disposition_selected`. */
export interface M19TriageCallDispositionSelectedPayload extends M19TriageCallEventBase {
  readonly disposition: TriageDisposition;
  readonly dispositionData: TriageDispositionData;
}

/** `m19.triage_call.documented` — emitted when `m8.encounter.signed` lands for the linked encounter, so
 *  `linkedEncounterId` is non-null by construction. `dispositionSummary` is lay-safe prose, not the
 *  clinician's free text. */
export interface M19TriageCallDocumentedPayload extends M19TriageCallEventBase {
  readonly linkedEncounterId: EncounterId;
  readonly patientId: PatientId;
  readonly dispositionSummary: string;
}

/** `m19.triage_call.visit_needed` → M17's proposal queue. `requestedArrivalBy` is set for
 *  `visit_dispatched_now`; `proposedForDate` for `visit_scheduled_first_light`. `visitKind` (F-166,
 *  #248) is the discriminator the M17 consumer needs: `visit_dispatched_now` and `pronouncement_scheduled`
 *  are otherwise indistinguishable from the payload's own non-null fields alone. */
export interface M19TriageCallVisitNeededPayload extends M19TriageCallEventBase {
  readonly patientId: PatientId;
  readonly requestedDiscipline: string;
  readonly requestedArrivalBy: IsoInstant | null;
  readonly proposedForDate: IsoDate | null;
  readonly reason: string;
  readonly visitKind: "dispatch_now" | "first_light" | "pronouncement";
}

/** `m19.triage_call.gip_admission_proposed` → M37's intake worklist PULLS it (F-219, `gipProposalsForOrg`). */
export interface M19TriageCallGipAdmissionProposedPayload extends M19TriageCallEventBase {
  readonly patientId: PatientId;
  readonly gipCriteriaSummary: string;
  readonly preferredFacility: string | null;
}

/** `m19.triage_call.care_plan_change_indicated` → M14's packet build PULLS it as a flagged event (F-218). */
export interface M19TriageCallCarePlanChangeIndicatedPayload extends M19TriageCallEventBase {
  readonly patientId: PatientId;
  readonly changeKind: string;
}

/** `m19.triage_call.closed`. */
export interface M19TriageCallClosedPayload extends M19TriageCallEventBase {
  readonly finalDisposition: TriageDisposition | null;
}

/** Fields every M19 shift-scoped event carries. */
export interface M19OnCallShiftEventBase {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly occurredAt: IsoInstant;
}

/** `m19.oncall_shift.activated` — the single canonical shift-open topic (M19-F12). Exactly one of
 *  `membershipId` / `externalActorId` is non-null, mirroring §3.3's `actorIntegrity` CHECK. */
export interface M19OnCallShiftActivatedPayload extends M19OnCallShiftEventBase {
  readonly shiftId: OnCallShiftId;
  readonly discipline: OncallShiftDiscipline;
  readonly membershipId: MembershipId | null;
  readonly externalActorId: ExternalTriageVendorId | null;
  readonly openedAt: IsoInstant;
}

/** `m19.oncall_shift.completed` — M36 removes the departing actor from the `on_call` channel. */
export interface M19OnCallShiftCompletedPayload extends M19OnCallShiftEventBase {
  readonly shiftId: OnCallShiftId;
}

/** `m19.oncall_shift.coverage_gap` — the §2.4 watchdog finding. Emitted every 30 minutes for as long as
 *  the gap stands; boot NEVER refuses to start over one (DR-010 / M19-F08 — blocking boot would turn an
 *  administrative scheduling lapse into a complete Tier-1 outage). */
export interface M19OnCallShiftCoverageGapPayload extends M19OnCallShiftEventBase {
  readonly gapStartsAt: IsoInstant;
  readonly gapEndsAt: IsoInstant;
  readonly discipline: OncallShiftDiscipline;
}

/** `m19.triage.summary_requested` → M22 renders the caregiver/attending summary document (F-224: produced
 *  by the explicit `POST /api/v1/triage-calls/:id/request-summary` staff action). The content fields are an
 *  ALLOWLIST of enumerated facts — never a free-text field, answer, transcript or medication. */
export interface M19TriageSummaryRequestedPayload extends M19TriageCallEventBase {
  readonly recipientKind: "caregiver" | "attending";
  readonly patientId: PatientId;
  readonly callOpenedAt: IsoInstant;
  readonly requestedByMembershipId: MembershipId;
  readonly disposition: TriageDisposition;
  readonly requestedDiscipline: string | null;
  readonly requestedArrivalBy: IsoInstant | null;
  readonly proposedForDate: IsoDate | null;
  readonly transportArrangedBy: "family" | "ems" | "facility" | "unknown" | null;
}

/** `m19.triage_call.callback_sla_breached` — an `awaiting_callback` call outlived its callback target. */
export interface M19TriageCallCallbackSlaBreachedPayload extends M19TriageCallEventBase {
  readonly slaTargetMinutes: number;
  readonly minutesElapsed: number;
}

/** `m19.triage_call.escalation_sla_breached` — an escalation row stayed unacknowledged past its tier SLA. */
export interface M19TriageCallEscalationSlaBreachedPayload extends M19TriageCallEventBase {
  readonly escalationId: TriageEscalationId;
  readonly tier: TriageEscalationTier;
  readonly mandatory: boolean;
  readonly slaTargetMinutes: number;
  readonly minutesOpen: number;
}

/** `m19.afterhours_triage.outcome` (ADR-0082) — id-only. `triageCallId` is null unless the outcome is
 *  `opened` or `coalesced`; `no_coverage` rides alongside the existing `m19.oncall_shift.coverage_gap`. */
export interface M19AfterHoursTriageOutcomePayload {
  readonly sourceOutboxEventId: string;
  readonly triageCallId: TriageCallId | null;
  readonly outcome: "opened" | "coalesced" | "no_coverage";
}

/** The §4.10 topic → payload map every emitter and consumer type-checks against. */
export interface M19EventPayloadMap {
  "m19.triage_call.opened": M19TriageCallOpenedPayload;
  "m19.triage_call.protocol_applied": M19TriageCallProtocolAppliedPayload;
  "m19.triage_call.red_flag_hit": M19TriageCallRedFlagHitPayload;
  "m19.triage_call.escalation_recorded": M19TriageCallEscalationRecordedPayload;
  "m19.triage_call.disposition_selected": M19TriageCallDispositionSelectedPayload;
  "m19.triage_call.documented": M19TriageCallDocumentedPayload;
  "m19.triage_call.visit_needed": M19TriageCallVisitNeededPayload;
  "m19.triage_call.gip_admission_proposed": M19TriageCallGipAdmissionProposedPayload;
  "m19.triage_call.care_plan_change_indicated": M19TriageCallCarePlanChangeIndicatedPayload;
  "m19.triage_call.closed": M19TriageCallClosedPayload;
  "m19.oncall_shift.activated": M19OnCallShiftActivatedPayload;
  "m19.oncall_shift.completed": M19OnCallShiftCompletedPayload;
  "m19.oncall_shift.coverage_gap": M19OnCallShiftCoverageGapPayload;
  "m19.triage.summary_requested": M19TriageSummaryRequestedPayload;
  "m19.triage_call.callback_sla_breached": M19TriageCallCallbackSlaBreachedPayload;
  "m19.triage_call.escalation_sla_breached": M19TriageCallEscalationSlaBreachedPayload;
  "m19.afterhours_triage.outcome": M19AfterHoursTriageOutcomePayload;
}

// ── §4.9 typed M36 alert payloads ────────────────────────────────────────────────────────────────────
//
// `systemLocked: true` on a rule means no tenant setting can disable it (§4.9). The three locked rules
// are the D7 mandatory-escalation surface and the coverage-gap surface — precisely the two an org under
// staffing pressure would be most tempted to silence.

/** `m19.triage.case_opened` — `severity` is `warn` rather than `info` when the call was machine-opened
 *  by a D10 inbound trigger (§4.9: "sometimes warn if from inbound trigger"), because nobody has
 *  necessarily looked at it yet. */
export interface TriageCaseOpenedAlert {
  readonly eventType: "m19.triage.case_opened";
  readonly severity: "info" | "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly source: TriageCallSource;
  readonly openedAt: IsoInstant;
}

/** `m19.triage.protocol_red_flag_hit` — system-locked. */
export interface TriageProtocolRedFlagHitAlert {
  readonly eventType: "m19.triage.protocol_red_flag_hit";
  readonly severity: "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly escalationId: TriageEscalationId;
  /** The question's prompt, never the caller's answer text. */
  readonly questionPrompt: string;
}

/** `m19.triage.mandatory_escalation_triggered` — system-locked, `critical`, routed by tier. */
export interface TriageMandatoryEscalationTriggeredAlert {
  readonly eventType: "m19.triage.mandatory_escalation_triggered";
  readonly severity: "critical";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly escalationId: TriageEscalationId;
  readonly tier: TriageEscalationTier;
  /** The protocol's chief-complaint label (e.g. "Suicidal ideation") — the catalog label, not the
   *  caller's words. */
  readonly protocolLabel: string;
}

/** `m19.triage.callback_sla_breached`. */
export interface TriageCallbackSlaBreachedAlert {
  readonly eventType: "m19.triage.callback_sla_breached";
  readonly severity: "warn";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly slaTargetMinutes: number;
  readonly minutesElapsed: number;
}

/** `m19.triage.documented` → the patient's care-team channel, lay-language preview. */
export interface TriageDocumentedAlert {
  readonly eventType: "m19.triage.documented";
  readonly severity: "info";
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly triageCallId: TriageCallId;
  readonly dispositionSummary: string;
}

/** `m19.oncall.coverage_gap_detected` — system-locked, `critical`, to org-admin + clinical-supervisor.
 *  The alert namespace's name differs from the outbox topic (`m19.oncall_shift.coverage_gap`); both are
 *  the §4.9/§4.10 catalog's own spellings and they address different registries. */
export interface OnCallCoverageGapDetectedAlert {
  readonly eventType: "m19.oncall.coverage_gap_detected";
  readonly severity: "critical";
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly gapStartsAt: IsoInstant;
  readonly gapEndsAt: IsoInstant;
  readonly discipline: OncallShiftDiscipline;
}

/** The §4.9 alert union M36 renders. */
export type OncallAlertPayload =
  | TriageCaseOpenedAlert
  | TriageProtocolRedFlagHitAlert
  | TriageMandatoryEscalationTriggeredAlert
  | TriageCallbackSlaBreachedAlert
  | TriageDocumentedAlert
  | OnCallCoverageGapDetectedAlert;

/** The §4.9 alert event types, and which of them no tenant setting may disable. */
export const M19_SYSTEM_LOCKED_ALERT_TYPES = [
  "m19.triage.protocol_red_flag_hit",
  "m19.triage.mandatory_escalation_triggered",
  "m19.oncall.coverage_gap_detected",
] as const satisfies readonly OncallAlertPayload["eventType"][];

// ── §4.3 published-seam read DTOs ────────────────────────────────────────────────────────────────────

/**
 * One actor currently on call. Discriminated because an EXTERNAL vendor actor has no membership and no
 * user id: M36's `on_call` recipient resolver (`RecipientSourcePorts.onCallMembers`) resolves to user
 * ids, and the only safe way to bind a vendor shift to that port is for the vendor arm to be
 * structurally incapable of supplying one. A flat DTO with a nullable `userId` would let a vendor-covered
 * night resolve to an empty recipient list that LOOKS like a normal result; here the caller must decide
 * what an external actor means for its channel, in the open.
 */
export type OnCallActor =
  | {
      readonly kind: "membership";
      readonly shiftId: OnCallShiftId;
      readonly membershipId: MembershipId;
      readonly userId: string;
      readonly discipline: OncallShiftDiscipline;
      /** True for the shift's `backup_membership_id` holder. */
      readonly isBackup: boolean;
      readonly shiftStartsAt: IsoInstant;
      readonly shiftEndsAt: IsoInstant;
    }
  | {
      readonly kind: "external_vendor";
      readonly shiftId: OnCallShiftId;
      readonly externalActorId: ExternalTriageVendorId;
      /** The vendor-side identifier (`on_call_shift.external_actor_label`); null when unlabelled. */
      readonly externalActorLabel: string | null;
      readonly discipline: "external";
      readonly shiftStartsAt: IsoInstant;
      readonly shiftEndsAt: IsoInstant;
    };

/** §4.3 — a shift as M36's channel synchronizer and M20's after-hours SOS path read it. Exactly one of
 *  `primaryOnCallMembershipId` / `externalActorId` is non-null (§3.3 `actorIntegrity`). */
export interface OnCallShiftDto {
  readonly shiftId: OnCallShiftId;
  readonly providerEntityId: ProviderEntityId;
  readonly discipline: OncallShiftDiscipline;
  readonly status: OncallShiftStatus;
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
  readonly primaryOnCallMembershipId: MembershipId | null;
  readonly backupMembershipId: MembershipId | null;
  readonly externalActorId: ExternalTriageVendorId | null;
  readonly externalActorLabel: string | null;
  readonly openedAt: IsoInstant | null;
  readonly closedAt: IsoInstant | null;
}

/**
 * §4.3 — the M32 hospitalization-risk model's input. FEATURES ONLY, never PHI verbatim: no caller name
 * or phone, no chief-complaint free text, and never the `caller_quote_cipher` / `transcript_cipher`
 * columns (a cipher does not cross a seam at all — the DEK does not leave M19's boundary). The protocol
 * is identified by its catalog KEY, which is platform vocabulary rather than anything a caller said.
 */
export interface TriageCallFeatureDto {
  readonly triageCallId: TriageCallId;
  readonly openedAt: IsoInstant;
  readonly source: TriageCallSource;
  readonly callerKind: TriageCallCallerKind;
  readonly selectedProtocolKey: string | null;
  readonly chiefComplaintSnomed: string | null;
  readonly disposition: TriageDisposition | null;
  readonly redFlagAnswerCount: number;
  readonly highestEscalationTier: TriageEscalationTier | null;
  readonly minutesToDisposition: number | null;
}

/** §4.3 — one line in M14's IDG packet: what happened after hours since the last meeting. Labels come
 *  from the protocol catalog, so this DTO carries no clinician free text. */
export interface TriageCallDigest {
  readonly triageCallId: TriageCallId;
  readonly openedAt: IsoInstant;
  readonly chiefComplaintLabel: string | null;
  readonly chiefComplaintSnomed: string | null;
  readonly disposition: TriageDisposition | null;
  readonly escalated: boolean;
  readonly linkedEncounterId: EncounterId | null;
}

/** One answered protocol question inside a packet slice. The typed value columns are carried as given;
 *  `redFlagHit` is the server's D5 evaluation, never a client assertion. */
export interface TriageCallAnswerSlice {
  readonly answerId: TriageCallAnswerId;
  readonly questionId: TriageProtocolQuestionId;
  readonly questionOrder: number;
  readonly prompt: string;
  readonly answerType: TriageProtocolAnswerType;
  readonly answerValueText: string | null;
  readonly answerValueInt: number | null;
  readonly answerValueBool: boolean | null;
  readonly redFlagHit: boolean;
  readonly answeredAt: IsoInstant;
  readonly answeredByMembershipId: MembershipId;
  /** Non-null when this row amends an earlier answer (§2.2.3 amend-by-append). */
  readonly correctionOfAnswerId: TriageCallAnswerId | null;
}

/** One escalation inside a packet slice. */
export interface TriageEscalationSlice {
  readonly escalationId: TriageEscalationId;
  readonly tier: TriageEscalationTier;
  readonly triggerKind: TriageEscalationTrigger;
  readonly escalatedAt: IsoInstant;
  readonly acknowledgedAt: IsoInstant | null;
  readonly resolvedAt: IsoInstant | null;
  readonly escalatedToMembershipId: MembershipId | null;
  readonly escalatedToExternalActorId: ExternalTriageVendorId | null;
}

/**
 * §4.3 — the full call payload M14's IDG aggregator renders from (M14 does its own PHI minimization).
 * `chiefComplaintText` IS included; the two encrypted columns are NOT, and never will be — §3.6
 * denylists them from audit capture for the same reason they must not cross a module boundary.
 */
export interface TriageCallPacketSlice {
  readonly triageCallId: TriageCallId;
  readonly patientId: PatientId | null;
  readonly admissionId: AdmissionId | null;
  readonly onCallShiftId: OnCallShiftId;
  readonly state: TriageCallState;
  readonly source: TriageCallSource;
  readonly callerKind: TriageCallCallerKind;
  readonly callerRelationshipLabel: string | null;
  readonly chiefComplaintText: string | null;
  readonly chiefComplaintSnomed: string | null;
  readonly selectedProtocolId: TriageProtocolId | null;
  readonly selectedProtocolVersion: string | null;
  readonly disposition: TriageDisposition | null;
  readonly dispositionData: TriageDispositionData | null;
  readonly linkedEncounterId: EncounterId | null;
  readonly linkedVerbalOrderIds: readonly OrderRecordId[];
  readonly linkedVisitProposalId: VisitProposalId | null;
  readonly openedAt: IsoInstant;
  readonly documentedAt: IsoInstant | null;
  readonly closedAt: IsoInstant | null;
  readonly answers: readonly TriageCallAnswerSlice[];
  readonly escalations: readonly TriageEscalationSlice[];
}

/**
 * §4.3 / §5.3 — the M31 portal's lay-language care-log entry. Deliberately narrow:
 *  - `dispositionSummaryLay` is plain English ("Symptom managed by phone advice"), NEVER the raw
 *    `disposition` enum the family cannot interpret;
 *  - no hospitalization-risk band (D11 excludes the advisory from the portal projection);
 *  - no vendor-handoff detail (D13 minimization — the family does not need to know whether the agency
 *    or an external triage service answered);
 *  - no protocol answers, no escalation tiers, no clinician free text.
 */
export interface PortalTriageSummary {
  readonly triageCallId: TriageCallId;
  /** In the PATIENT's local timezone, resolved by M19 before it leaves the seam. */
  readonly occurredAt: IsoInstant;
  readonly callerRelationshipLabel: string | null;
  readonly callerKind: TriageCallCallerKind;
  readonly dispositionSummaryLay: string;
  readonly visitDispatched: boolean;
  readonly visitScheduledFirstLight: boolean;
}

/** §4.3 — one bar of the escalation-tier distribution. */
export interface EscalationTierCount {
  readonly tier: TriageEscalationTier;
  readonly count: number;
}

/** §4.3 — one bar of the chief-complaint Pareto. Keyed on the protocol CATALOG entry, so the chart is
 *  aggregatable across tenants without any tenant's free text leaving its org. */
export interface ChiefComplaintBucket {
  readonly protocolKey: string;
  readonly chiefComplaintLabel: string;
  readonly count: number;
}

/** The half-open instant window every metrics read is scoped to. */
export interface TriageMetricsWindow {
  readonly from: IsoInstant;
  readonly to: IsoInstant;
}

// ── §4.3 the five published reader seams ─────────────────────────────────────────────────────────────

/**
 * §4.3 — who is on call right now. M36's `on_call` recipient resolver and M20's after-hours SOS parallel
 * recipient (M20 §7.5 D14) both resolve through this seam; landing it is what RETIRES the Phase-1 SOS
 * degraded fallback (Wave P2-2 acceptance #3).
 *
 * FAIL POSTURE: this is an AVAILABILITY read for a Tier-1 module, so its deny-stub must not be modelled
 * on an authorization deny. A registry outage here means "we cannot tell you who is on call", which the
 * caller must surface as a degraded alert path — not as "nobody is on call", which reads identically to
 * a real coverage gap and would silently swallow a 2 a.m. escalation.
 */
export interface OnCallProvider {
  /** M36-consumed: the actors on call for this provider entity at `asOfIso`. */
  currentOnCallActors(
    orgId: OrgId,
    providerEntityId: ProviderEntityId,
    asOfIso: IsoInstant,
  ): Promise<readonly OnCallActor[]>;
  /** M36's channel re-sync reads this on the shift-transition event consumer. */
  activeShiftsAt(orgId: OrgId, asOfIso: IsoInstant): Promise<readonly OnCallShiftDto[]>;
}

/** §4.3 — M32's feature read and M14's since-last-IDG read. Both are strictly READ; neither can move a
 *  call's state. */
export interface TriageCallReader {
  /** M32 hospitalization-risk model input — features only, never PHI verbatim. */
  recentCallsForPatient(
    orgId: OrgId,
    patientId: PatientId,
    sinceIso: IsoInstant,
  ): Promise<readonly TriageCallFeatureDto[]>;
  /** M14 IDG packet — the after-hours activity since the last meeting. */
  callsForPatientSince(
    orgId: OrgId,
    patientId: PatientId,
    sinceIso: IsoInstant,
  ): Promise<readonly TriageCallDigest[]>;
}

/** §4.3 — the packet-rendering read and the M11 reverse lookup. */
export interface TriageCallProvider {
  /** M14 IDG aggregator — the full slice; M14 does its own PHI minimization. */
  callForPacket(orgId: OrgId, triageCallId: TriageCallId): Promise<TriageCallPacketSlice | null>;
  /** M11's verbal-order timer worker — the triage context behind an order that is about to expire
   *  unsigned, so the reminder reaches the on-call actor who took it rather than the day shift. */
  triageContextForVerbalOrder(
    orgId: OrgId,
    verbalOrderId: OrderRecordId,
  ): Promise<{ readonly triageCallId: TriageCallId; readonly onCallShiftId: OnCallShiftId } | null>;
}

/** §4.3 / §5.3 — the ONLY M19 seam the M31 portal may reach. */
export interface PortalTriageReader {
  summaryForPatient(
    orgId: OrgId,
    patientId: PatientId,
    withinHours: number,
  ): Promise<readonly PortalTriageSummary[]>;
}

/**
 * §4.3 — M30/M33 operational and quality measures.
 *
 * The `*Rate` methods are the §4.3 catalog's own signatures and are what a M33 dashboard tile needs.
 * The `*Counts` siblings are ADDED (the M17 `VisitMetricsProvider.getOnTimeVisitCounts` precedent):
 * M30's `ratioResult()` collapses a measure to `insufficient_n` below the CMS reportable floor, and that
 * suppression IS the public-reporting rule — a bare rate cannot express it, and back-computing a
 * denominator would publish a number CMS requires withheld. A measure-feeding read exposes the pair.
 */
export interface TriageCallMetricsProvider {
  getResponseTimeP95(orgId: OrgId, windowIso: TriageMetricsWindow): Promise<number>;
  getHospitalizationAvoidanceRate(orgId: OrgId, windowIso: TriageMetricsWindow): Promise<number>;
  /** The population behind {@link getHospitalizationAvoidanceRate} — M30's measure input. */
  getHospitalizationAvoidanceCounts(
    orgId: OrgId,
    windowIso: TriageMetricsWindow,
  ): Promise<MeasureCounts>;
  getEscalationDistribution(
    orgId: OrgId,
    windowIso: TriageMetricsWindow,
  ): Promise<readonly EscalationTierCount[]>;
  getAfterHoursVisitConversionRate(orgId: OrgId, windowIso: TriageMetricsWindow): Promise<number>;
  /** The population behind {@link getAfterHoursVisitConversionRate}. */
  getAfterHoursVisitConversionCounts(
    orgId: OrgId,
    windowIso: TriageMetricsWindow,
  ): Promise<MeasureCounts>;
  getChiefComplaintPareto(
    orgId: OrgId,
    windowIso: TriageMetricsWindow,
  ): Promise<readonly ChiefComplaintBucket[]>;
  /** §2.4 / §9.7 — minutes in the window with no `clinical_rn` shift covering an active ProviderEntity.
   *  The coverage-gap measure the watchdog's alerts are the real-time face of. */
  getCoverageGapMinutes(orgId: OrgId, windowIso: TriageMetricsWindow): Promise<number>;
}

// ── Cross-module bindings M19 must resolve against the LOCKED upstream contracts (M19-T05 notes) ──────
//
// Two of the spec's §4.4 / D-list method names do not exist on the seams their owners actually published,
// and M19 binds to the OWNER's contract rather than redefining it (the M15/M17 `VolunteerComplianceProvider`
// precedent — a re-declared seam is a permanently unbound one):
//
//   D8 names `EncounterCreator.createTriageTelephonicContact(...)`. M8 published exactly one method,
//   `createDraftEncounter(input: CreateEncounterInput)` (`./encounter`), and `encounter_type` has no
//   `triage_telephonic_contact` member — the value M19 passes is `telephonic`. M19-T05 calls the real
//   method; it does not ask M8 to grow a bespoke one.
//
//   D9 names `OrderSignatureProvider.recordVerbalOrder(...)` with a `triage_context`. M19-T05 binds
//   whatever M11 published on `./orders` and stores the returned id in `linked_verbal_order_ids`.
//
// Both are recorded here rather than in a task file because the mismatch is a CONTRACT fact a reader of
// these types needs, and because the temptation at T05 will be to widen the upstream interface.

/** The `encounter_type` M19 opens its M8 draft encounter with (D1/D8). Not a new enum member — the
 *  existing `telephonic` value; M19's own `triage_call` row is what makes the contact a triage one. */
export const M19_ENCOUNTER_TYPE = "telephonic" as const;

/** §2.7 — the BCP paper-origin re-entry worklist's lifetime: the worklist expires 72 hours after the
 *  outage-end timestamp, after which un-reconciled rows stop nagging the DON. */
export const TRIAGE_PAPER_REENTRY_WORKLIST_TTL_HOURS = 72;

/** §2.6 — the Idempotency-Key dedupe window every M19 state-transition route enforces (M1 middleware). */
export const TRIAGE_IDEMPOTENCY_WINDOW_HOURS = 24;

/** §2.2.1 — the amendment grace after which `close-documented.cron` moves `documented → closed`. */
export const TRIAGE_DOCUMENTED_CLOSE_GRACE_MINUTES = 30;

/** §4.8 `awaiting-callback-timeout.cron` — the default grace a call may sit in `awaiting_callback` before the
 *  cron advances it to `disposition_pending` (a tenant may only TIGHTEN it, via `state_overrides`). */
export const TRIAGE_AWAITING_CALLBACK_GRACE_MINUTES = 60;

/** §4.8 `callback-sla.cron` — the platform floor for the callback target when the tenant's
 *  `callback_sla_per_severity` names no usable number (the spec's own `clinical_urgent` example). */
export const TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES = 30;

/** §4.8 `escalation-sla` — minutes an escalation may stay unacknowledged, per tier, when the tenant's
 *  `escalation_tiers` carries no `slaMinutes` for it. Deliberately tight: the spec names no number. */
export const TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES = {
  tier_1_rn_supervisor: 15,
  tier_2_clinical_manager: 30,
  tier_3_medical_director: 15,
  tier_4_compliance_officer: 60,
  tier_5_external: 15,
} as const;

/** §4.8 `escalation-sla` — an unacknowledged breach re-pages at most this often (a standing breach is still
 *  a breach; M36 collapses redeliveries, this paces fresh emissions). */
export const TRIAGE_ESCALATION_SLA_REPAGE_MINUTES = 30;

/** §4.8 — the canonical coverage-gap watchdog cadence (M19-F12 resolves the spec's own hourly-vs-30-min
 *  disagreement in favour of 30 minutes: two checks an hour, inside the 1-hour CoP response window). */
export const ONCALL_COVERAGE_GAP_WATCHDOG_INTERVAL_MINUTES = 30;

/** §2.4 / §4.8 — how far ahead the watchdog walks looking for an uncovered `clinical_rn` window. */
export const ONCALL_COVERAGE_LOOKAHEAD_HOURS = 24;

// ── §4.4 / §8.6 the two ADVISORY M32 seams M19 consumes (D11, D12) ───────────────────────────────────
//
// M32 (AI Platform) is a placeholder module, so both contracts are declared HERE — the same shape the
// corpus uses whenever a consumer needs a forward seam its owner has not landed yet (M18's
// `EvvBracketResolver` is leaf-typed in `./encounter`, M8's file, for exactly this reason). When M32
// lands it registers its real implementation against these names; nothing about the registry entry or
// M19's call sites changes. Declaring them ANYWHERE else would make them a second, un-registerable
// interface — the M15/M17 `VolunteerComplianceProvider` lesson.
//
// FAIL POSTURE — DELIBERATELY UNLIKE EVERY OTHER SEAM ON THE PLATFORM. Both of these are ADVISORY:
// architecture §17 and D11/D12 make them incapable of gating anything, and §8.6 is explicit that with
// M32 deny-stubbed "the triage panel renders with the AI block visibly disabled — no silent fallback or
// guess". So the deny-stub must NOT throw: a thrown error inside the intake path would take down the
// 2 a.m. call-open flow on behalf of a surface that decides nothing. It answers `unavailable` instead —
// a VALUE, discriminated from a real "the model has no suggestion" answer, so the UI can render the
// disabled AI block and `m19_ai_block_disabled_total` can count it. A bare `null` would collapse those
// two into one (the M19-T05 `medication-context` finding, and the same reason `OnCallRosterRead` is a
// union rather than an array).

/** Why an AI advisory is absent. `provider_unregistered` is the pre-M32 default; `tenant_opted_out` is
 *  the §8.6 `tenant_oncall_policy.ai_*_enabled` flag; `provider_error` is a live M32 that failed. */
export type TriageAiUnavailableReason =
  | "provider_unregistered"
  | "tenant_opted_out"
  | "provider_error";

/** §8.6 — the PHI-MINIMIZED input M19 sends M32 for a protocol suggestion. Chief-complaint free text is
 *  the one PHI-bearing field and it is what the model exists to read; no full chart dump crosses (AI
 *  Governance §2.1.4). The candidate keys are the tenant's resolvable catalog, so the model can only
 *  ever name a protocol that exists in this org. */
export interface TriageProtocolSuggestionInput {
  readonly triageCallId: TriageCallId;
  readonly patientId: PatientId | null;
  readonly chiefComplaintText: string;
  /** The protocol catalog keys resolvable for this tenant right now (platform floor + tenant rows). */
  readonly candidateProtocolKeys: readonly string[];
}

/** §8.6 / D12 — one suggestion. `confidenceScore` and `confidence` are BOTH carried on purpose: the
 *  D12 governance floor is a NUMBER (0.75) and `triage_call.suggested_protocol_confidence` is a
 *  three-value enum. Storing only the band would make the floor comparison unrepresentable; sending only
 *  the score would not fit the column. The `modelVersionTag` has no column at all (§3.3 has none) — it
 *  rides the `triage.ai.suggestion_recorded` AI-governance audit event, which is where §8.7.2 puts it. */
export interface TriageProtocolSuggestion {
  readonly suggestedProtocolId: TriageProtocolId;
  readonly suggestedProtocolKey: string;
  /** 0..1. Compared against {@link M19_AI_CONFIDENCE_FLOOR}; never rounded before the comparison. */
  readonly confidenceScore: number;
  readonly confidence: TriageAiConfidence;
  readonly modelVersionTag: string;
  readonly reasoning: string | null;
}

/** The three answers a suggestion request can have — see the fail-posture note above. */
export type TriageProtocolSuggestionResult =
  | { readonly kind: "suggestion"; readonly suggestion: TriageProtocolSuggestion }
  /** The model ran and declined to name a protocol — a real answer, and NOT the same as `unavailable`. */
  | { readonly kind: "no_suggestion"; readonly modelVersionTag: string }
  | { readonly kind: "unavailable"; readonly reason: TriageAiUnavailableReason };

/** §8.6 / D11 — the intake advisory. Recorded on `triage_call.hospitalization_risk_band` for audit and
 *  metrics; gates nothing, alters no disposition option, and is excluded from {@link PortalTriageSummary}. */
export interface TriageHospitalizationRiskAdvisory {
  /** 0..1. The BAND is what M19 stores; the score is carried for the AI-governance audit event. */
  readonly riskScore: number;
  readonly riskBand: TriageRiskBand;
  readonly timeWindowDays: number;
  readonly modelVersionTag: string;
  readonly contributingFactors: readonly string[];
}

/** The two answers a risk request can have. */
export type TriageHospitalizationRiskResult =
  | { readonly kind: "advisory"; readonly advisory: TriageHospitalizationRiskAdvisory }
  | { readonly kind: "unavailable"; readonly reason: TriageAiUnavailableReason };

/** §4.4 / §8.6 / D12 — M32's protocol-suggestion surface. ADVISORY: the clinician must explicitly select
 *  or override; nothing M32 returns may move a `triage_call` row on its own. */
export interface ProtocolSuggestionProvider {
  suggestProtocol(
    orgId: OrgId,
    input: TriageProtocolSuggestionInput,
  ): Promise<TriageProtocolSuggestionResult>;
}

/** §4.4 / §8.6 / D11 — M32's 30-day hospitalization-risk surface, read once at intake. ADVISORY. */
export interface HospitalizationRiskProvider {
  hospitalizationRiskForPatient(
    orgId: OrgId,
    patientId: PatientId,
    asOfIso: IsoInstant,
  ): Promise<TriageHospitalizationRiskResult>;
}

/** D12 / §8.6 — the AI-governance confidence floor. Below it a suggestion is still SHOWN (de-emphasized)
 *  and an override needs no reason; at or above it an override requires a reason ≥ 10 chars. Tenants may
 *  configure ABOVE the floor only. */
export const M19_AI_CONFIDENCE_FLOOR = 0.75;

/** D12 — the minimum length of the override reason required at or above {@link M19_AI_CONFIDENCE_FLOOR}. */
export const M19_AI_OVERRIDE_REASON_MIN_CHARS = 10;
