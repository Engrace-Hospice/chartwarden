// apps/backend/src/modules/19-oncall/routes/m19-typebox.ts — M19-T07 (§4.2) request schemas.
//
// TypeBox request bodies, path params and list queries for the §4.1 On-Call Triage routes. Named
// `m19-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one — the M21-T01 gotcha, where even the WORD "alerts" in a comment tripped `arch:tables`.
//
// The string-literal unions MIRROR the frozen `@wardenx/types` enum unions (`packages/types/src/oncall.ts`,
// M19-T01), which themselves mirror the `@wardenx/db` pgEnums. The DB wins on conflict, and where §4.2's
// own sketch disagrees with either, the sketch loses. Three places where it does, recorded rather than
// silently reconciled:
//
//   1. §4.2's `SelectDispositionRequest` union spells payload fields the §3.2 `TriageDispositionData` union
//      does not have (`educationNotesText` vs `educationSummary`, `authorizationNotes` vs
//      `instructionsGiven`, `caregiverElectionText` vs `electionText`, `targetKind`/`verbalAttestation`/
//      `orderPayload` on the verbal-order arm). `TriageDispositionData` is ALREADY PUBLISHED and already
//      the shape `triage_call.disposition_data` holds and `lifecycle/disposition.ts` validates; a route
//      schema that accepted §4.2's spelling would have to translate at the boundary and would put a second,
//      drifting copy of the contract in the request layer. The published union wins.
//   2. §4.2's verbal-order arm carries an `orderPayload` "forwarded to M11/M12". M19 forwards no order
//      payload: M11 published a signature PRIMITIVE over an EXISTING target (M19-T05's finding), so the
//      arm here names the order it attests to and nothing more.
//   3. §4.2's `RecordAnswerRequest` has three optional value columns and no discriminator. That admits the
//      all-null row §3.3's `num_nonnulls(...) = 1` CHECK exists to forbid — the cheapest way to walk a
//      red-flag question past `completeProtocol`. The schema below is a DISCRIMINATED union, so "exactly
//      one value" is a 422 at the boundary rather than a constraint violation from the driver.
//
// NOTHING HERE ACCEPTS AN ORG, AN ACTING MEMBERSHIP OR A VENDOR IDENTITY. All three are server-side
// (`routes/actor.ts`), which is what makes §8.3.1's spoofing controls structural. `red_flag_hit` is
// likewise absent from every request body: D5 makes it the SERVER's evaluation, and a client that could
// assert it could assert its absence.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type { PortalTriageSummary } from "@wardenx/types";
import type { CursorPage } from "./concurrency";
import type {
  CurrentOnCallView,
  EscalationInboxItem,
  OnCallShiftView,
  OncallPolicyView,
  PaperReentryWorklistView,
  TriageAnswerView,
  TriageCallDetail,
  TriageCallListItem,
  TriageEscalationView,
  TriageProtocolQuestionView,
  TriageProtocolView,
  TriageStateHistoryView,
  TriageTranscriptView,
  VendorBindingView,
  VendorTriageCallView,
} from "./read-service";
import type { AnswerWriteResult, OpenTriageCallResult } from "./write-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}

/**
 * Validate a request BODY at the route boundary. Deliberately does NOT run `Value.Convert`: a JSON body
 * already carries real types, and coercing would silently repair genuinely wrong input — on this module
 * that would mean accepting `"7"` for a 0-10 pain scale whose D5 red-flag predicate compares numerically.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/** Validate a request QUERY, converting the declared scalars first (`?limit=25` arrives as "25"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const UuidOpt = Type.Optional(Type.String({ format: "uuid" }));
const Instant = Type.String({ format: "date-time" });
const InstantOpt = Type.Optional(Type.String({ format: "date-time" }));
const LocalDate = Type.String({ format: "date" });
/** §3.6-denylisted free text. The cap is the column's practical maximum, not a validation opinion. */
const FreeText = (min: number, max: number) => Type.String({ minLength: min, maxLength: max });

// ── §3.2 enum mirrors (`packages/types/src/oncall.ts` is the source of truth) ────────────────────────

/** `m19_triage_call_inbound_channel`. */
export const InboundChannel = Type.Union([
  Type.Literal("phone"),
  Type.Literal("sms"),
  Type.Literal("email"),
  Type.Literal("portal_message"),
  Type.Literal("inbound_visit_failure"),
  Type.Literal("inbound_evv_anomaly"),
  Type.Literal("inbound_alert_failure"),
]);

/** `m19_triage_call_caller_kind`. */
export const CallerKind = Type.Union([
  Type.Literal("patient"),
  Type.Literal("caregiver"),
  Type.Literal("external_clinician"),
  Type.Literal("portal_session"),
  Type.Literal("system_inbound"),
  Type.Literal("bereaved_family"),
]);

/**
 * `m19_triage_call_source` MINUS the machine-only values.
 *
 * A ROUTE may declare `manual` and nothing else. The four D10 values are written by their consumers and
 * `paper_origin` is written by the §2.7 re-entry route, which carries its own permission and step-up — so a
 * caller who could name `no_show` here could mint a row that LOOKS like M17 detected a missed visit, and a
 * caller who could name `paper_origin` would bypass `triage.paper_reentry` entirely (§8.3.2's back-dating
 * threat). The narrow union is the control.
 */
export const OpenableSource = Type.Union([Type.Literal("manual")]);

/** `m19_triage_escalation_tier`. */
export const EscalationTier = Type.Union([
  Type.Literal("tier_1_rn_supervisor"),
  Type.Literal("tier_2_clinical_manager"),
  Type.Literal("tier_3_medical_director"),
  Type.Literal("tier_4_compliance_officer"),
  Type.Literal("tier_5_external"),
]);

/** `m19_oncall_shift_discipline`. */
export const ShiftDiscipline = Type.Union([
  Type.Literal("clinical_rn"),
  Type.Literal("clinical_lpn"),
  Type.Literal("medical_director"),
  Type.Literal("msw"),
  Type.Literal("chaplain"),
  Type.Literal("external"),
]);

/** `m19_triage_call_state` (list filter only — no route sets a state directly). */
export const TriageCallState = Type.Union([
  Type.Literal("open"),
  Type.Literal("protocol_in_progress"),
  Type.Literal("awaiting_callback"),
  Type.Literal("disposition_pending"),
  Type.Literal("documented_pending_encounter"),
  Type.Literal("escalated_unresolved"),
  Type.Literal("documented"),
  Type.Literal("closed"),
  Type.Literal("abandoned"),
]);

/** `m19_oncall_model` (D3). */
export const OncallModel = Type.Union([
  Type.Literal("direct"),
  Type.Literal("hybrid"),
  Type.Literal("centralized"),
]);

// ── path params ─────────────────────────────────────────────────────────────────────────────────────

export const TriageCallIdParams = Type.Object({ triageCallId: Uuid });
export const AnswerCorrectionParams = Type.Object({ triageCallId: Uuid, answerId: Uuid });
export const EscalationIdParams = Type.Object({ escalationId: Uuid });
export const ShiftIdParams = Type.Object({ shiftId: Uuid });
export const ProtocolIdParams = Type.Object({ protocolId: Uuid });
export const ProtocolQuestionIdParams = Type.Object({ questionId: Uuid });
export const VendorIdParams = Type.Object({ vendorId: Uuid });

// ── §4.1 row 1 — open a call ────────────────────────────────────────────────────────────────────────

/**
 * §4.2's `OpenTriageCallRequest`.
 *
 * `sourceOutboxEventId` is DROPPED from §4.2's sketch: it is the §2.6 redelivery key the D10 consumers set,
 * and a caller who could supply one could either collide with a real event id (silently suppressing the
 * consumer's own call through the UNIQUE index) or mint a call that claims a provenance it does not have.
 *
 * `onCallShiftId` is likewise absent though the column is NOT NULL: the server resolves the covering shift
 * (`resolveCoveringShift`), because letting a caller name the shift lets them attribute their call to
 * someone else's coverage window — which is the CoP 418.100(c)(2) record.
 */
export const OpenTriageCallBody = Type.Object(
  {
    providerEntityId: Uuid,
    inboundChannel: InboundChannel,
    callerKind: CallerKind,
    callerDisplayName: Type.Optional(Type.String({ maxLength: 200 })),
    /** §3.6-denylisted. E.164 so the callback the §4.8 SLA detector chases is dialable. */
    callerPhoneE164: Type.Optional(Type.String({ pattern: "^\\+[1-9]\\d{1,14}$" })),
    callerRelationshipLabel: Type.Optional(Type.String({ maxLength: 64 })),
    patientId: UuidOpt,
    admissionId: UuidOpt,
    callerCaregiverId: UuidOpt,
    source: Type.Optional(OpenableSource),
    /** §3.6-denylisted — the caller's own words about why they rang. */
    chiefComplaintText: Type.Optional(Type.String({ maxLength: 1000 })),
    chiefComplaintSnomed: Type.Optional(Type.String({ pattern: "^[0-9]{6,18}$" })),
    /** §3.6-denylisted + per-tenant DEK envelope (D14). The server encrypts before persist. */
    callerQuote: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  { additionalProperties: false },
);

/** §4.1 row 4 — resolve the caller to a served person. */
export const IdentifyPatientBody = Type.Object(
  {
    patientId: Uuid,
    admissionId: Uuid,
    /** Resolved from the admission when known; the §3.3 column is nullable until the caller is matched. */
    locationId: UuidOpt,
    callerCaregiverId: UuidOpt,
  },
  { additionalProperties: false },
);

// ── §4.1 rows 5-8 — the protocol walk ───────────────────────────────────────────────────────────────

/**
 * §4.2's `ApplyProtocolRequest`, plus the D12 governance fields §8.6 requires and §4.2 omits.
 *
 * `aiOverrideReason` is OPTIONAL in the schema and CONDITIONALLY REQUIRED in the handler, because the
 * condition is a fact the schema cannot see: §8.6 requires a reason (≥10 chars) only when the overridden
 * suggestion's confidence was AT OR ABOVE the 0.75 governance floor, and that confidence lives on the
 * `triage_call` row. Making it unconditionally required would demand a justification for ignoring a
 * low-confidence guess, which is how a governance field becomes a field everyone types "n/a" into.
 */
export const ApplyProtocolBody = Type.Object(
  {
    triageProtocolId: Uuid,
    aiOverrideReason: Type.Optional(Type.String({ minLength: 10, maxLength: 1000 })),
  },
  { additionalProperties: false },
);

/**
 * §4.2's `RecordAnswerRequest`, as a DISCRIMINATED union (see header note 3). Exactly one typed value, as a
 * type fact before it is a `num_nonnulls` CHECK.
 */
export const RecordAnswerBody = Type.Object(
  {
    triageProtocolQuestionId: Uuid,
    value: Type.Union([
      Type.Object(
        { kind: Type.Literal("text"), value: Type.String({ minLength: 1, maxLength: 2000 }) },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal("int"), value: Type.Integer() },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal("bool"), value: Type.Boolean() },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

/** §4.1 row 7 — append a correction (§2.2.3 amend-by-append). The target answer is the path param. */
export const CorrectAnswerBody = Type.Object(
  {
    triageProtocolQuestionId: Uuid,
    value: RecordAnswerBody.properties.value,
    /** Why the original was wrong. The §5 stepper shows it beside both rows. */
    correctionReason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false },
);

/** §4.1 row 9 — park the call on a callback. §4.1's Notes: the reason is ≥ 20 chars. */
export const AwaitingCallbackBody = Type.Object(
  {
    reason: FreeText(20, 1000),
    /** The §4.8 SLA detector's target; defaults to the tenant policy's per-severity minutes when absent. */
    callbackTargetAt: InstantOpt,
  },
  { additionalProperties: false },
);

// ── §4.1 row 11 — the disposition (D6) ──────────────────────────────────────────────────────────────
//
// Mirrors the PUBLISHED `TriageDispositionData` union (header note 1), arm for arm. The two arms that are
// NOT selectable here (`escalated_unresolved`, `abandoned`) are absent by construction: each is reached by
// its own route, which carries the permission the plain disposition route does not.

const CaregiverEducationData = Type.Object(
  {
    disposition: Type.Literal("caregiver_education_only"),
    educationSummary: FreeText(30, 4000),
    followUpCallAt: Type.Union([Instant, Type.Null()]),
  },
  { additionalProperties: false },
);

const PrnAuthorizedData = Type.Object(
  {
    disposition: Type.Literal("prn_intervention_authorized"),
    orderRecordId: Type.Union([Uuid, Type.Null()]),
    medicationOrderId: Type.Union([Uuid, Type.Null()]),
    instructionsGiven: FreeText(20, 1000),
  },
  { additionalProperties: false },
);

const VerbalOrderData = Type.Object(
  {
    disposition: Type.Literal("verbal_order_recorded"),
    /** D9 — the id M11's `OrderSignatureProvider` returned. M19 mints no order (header note 2). */
    orderRecordId: Uuid,
    attendingPhysicianId: Type.Union([Uuid, Type.Null()]),
  },
  { additionalProperties: false },
);

const VisitDispatchedData = Type.Object(
  {
    disposition: Type.Literal("visit_dispatched_now"),
    requestedDiscipline: FreeText(2, 64),
    requestedArrivalBy: Instant,
    reason: FreeText(30, 1000),
  },
  { additionalProperties: false },
);

const VisitFirstLightData = Type.Object(
  {
    disposition: Type.Literal("visit_scheduled_first_light"),
    requestedDiscipline: FreeText(2, 64),
    proposedForDate: LocalDate,
    reason: FreeText(30, 1000),
  },
  { additionalProperties: false },
);

const GipProposedData = Type.Object(
  {
    disposition: Type.Literal("gip_admission_proposed"),
    gipCriteriaSummary: FreeText(60, 2000),
    preferredFacility: Type.Union([Uuid, Type.Null()]),
  },
  { additionalProperties: false },
);

const EdTransferData = Type.Object(
  {
    disposition: Type.Literal("ed_transfer_acknowledged"),
    /** CMS 418.52 — the family's election against clinical recommendation, verbatim. */
    electionText: FreeText(60, 2000),
    transportArrangedBy: Type.Union([
      Type.Literal("family"),
      Type.Literal("ems"),
      Type.Literal("facility"),
      Type.Literal("unknown"),
    ]),
  },
  { additionalProperties: false },
);

const PronouncementData = Type.Object(
  {
    disposition: Type.Literal("pronouncement_scheduled"),
    pronouncingDiscipline: FreeText(2, 64),
    expectedArrivalBy: Type.Union([Instant, Type.Null()]),
  },
  { additionalProperties: false },
);

/** §4.2's `SelectDispositionRequest`, over the published payload union. */
export const SelectDispositionBody = Type.Object(
  {
    dispositionData: Type.Union([
      CaregiverEducationData,
      PrnAuthorizedData,
      VerbalOrderData,
      VisitDispatchedData,
      VisitFirstLightData,
      GipProposedData,
      EdTransferData,
      PronouncementData,
    ]),
  },
  { additionalProperties: false },
);

/** §4.1 row 12 — invoke M8's `EncounterCreator` for this call (D8). */
export const DocumentCallBody = Type.Object(
  { narrativeSummary: Type.Optional(FreeText(1, 4000)) },
  { additionalProperties: false },
);

/** §4.1 row 13 — the caller disconnected. */
export const AbandonCallBody = Type.Object(
  {
    reason: FreeText(1, 1000),
    callbackAttempts: Type.Integer({ minimum: 0, maximum: 50 }),
  },
  { additionalProperties: false },
);

// ── §4.1 rows 15-18 — escalations ───────────────────────────────────────────────────────────────────

/** §4.2's `EscalateRequest`. Recipient coherence (§3.3's CHECK) is re-asserted in the write service. */
export const EscalateBody = Type.Object(
  {
    tier: EscalationTier,
    reason: FreeText(30, 2000),
    escalatedToMembershipId: UuidOpt,
    escalatedToExternalActorId: UuidOpt,
    /** §2.2.1 — set when the escalation also hands the CALL off (`disposition_pending →
     *  escalated_unresolved`), rather than merely recording a rung on a call that keeps running. */
    handOffCall: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** §4.1 row 17 — acknowledge. No body fields: the actor and the instant are both server-side. */
export const AcknowledgeEscalationBody = Type.Object({}, { additionalProperties: false });

/** §4.1 row 18 — resolve. §4.1's Notes: the resolution text is ≥ 30 chars. */
export const ResolveEscalationBody = Type.Object(
  { resolution: FreeText(30, 4000) },
  { additionalProperties: false },
);

// ── §4.1 rows 20-23 — shifts ────────────────────────────────────────────────────────────────────────

/**
 * §4.1 row 20 — manual shift create (Hybrid / Centralized, and a Direct-model backfill).
 *
 * `policySnapshot` is NOT a body field: D7 pins it from `tenant_oncall_policy` at the `scheduled → active`
 * transition, and a caller-supplied snapshot is a caller-supplied answer to "which escalation ladder was in
 * effect that night" — the one question the column exists to answer honestly.
 */
export const CreateShiftBody = Type.Object(
  {
    providerEntityId: Uuid,
    shiftStartsAt: Instant,
    shiftEndsAt: Instant,
    discipline: ShiftDiscipline,
    primaryOnCallMembershipId: UuidOpt,
    backupMembershipId: UuidOpt,
    externalActorId: UuidOpt,
    externalActorLabel: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

/** §4.1 row 21 — cancel with a reason (§3.6-denylisted free text). */
export const CancelShiftBody = Type.Object(
  { reason: FreeText(1, 1000) },
  { additionalProperties: false },
);

/** §4.1 rows 22-23 — manual open / close (the cron normally does both). */
export const ShiftTransitionBody = Type.Object({}, { additionalProperties: false });

// ── §4.1 rows 25-26 — tenant policy ─────────────────────────────────────────────────────────────────

/**
 * §4.1 row 26 — the policy PATCH.
 *
 * Every field is optional (it is a PATCH) and `model` is validated in the handler against the D3 feature
 * flag: `hybrid` / `centralized` are structurally complete and flagged OFF in Phase 1, and a PATCH that
 * selects one on a deployment where the flag is off is REFUSED (`ONCALL_MODEL_NOT_ENABLED`) rather than
 * accepted-and-ignored, which would leave the tenant believing a vendor was answering their nights.
 *
 * §4.1's "tighten-only on locked tiers" is a cross-field rule over the escalation ladder that TypeBox
 * cannot state; it lives in the write service beside the row it compares against.
 */
export const PatchOncallPolicyBody = Type.Object(
  {
    model: Type.Optional(OncallModel),
    escalationTiers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    callbackSlaPerSeverity: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    stateOverrides: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    externalTriageVendorId: Type.Optional(Type.Union([Uuid, Type.Null()])),
    /** §2.7 D-D — the agency's OWN published after-hours number, surfaced when M36 delivery is degraded. */
    emergencyContactE164: Type.Optional(
      Type.Union([Type.String({ pattern: "^\\+[1-9]\\d{1,14}$" }), Type.Null()]),
    ),
    aiProtocolSuggestionEnabled: Type.Optional(Type.Boolean()),
    aiHospitalizationRiskEnabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** The `?providerEntityId=` selector both policy routes take (the row is per (org, PE)). */
export const PolicyQuery = Type.Object(
  { providerEntityId: Uuid },
  { additionalProperties: false },
);

// ── §4.1 rows 29-32 — the protocol catalog ──────────────────────────────────────────────────────────

const RedFlagMatch = Type.Union([
  Type.Object(
    { kind: Type.Literal("bool_is"), value: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("int_at_least"), threshold: Type.Integer() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("int_at_most"), threshold: Type.Integer() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("enum_in"), values: Type.Array(Type.String(), { minItems: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("text_any") }, { additionalProperties: false }),
]);

const AnswerType = Type.Union([
  Type.Literal("boolean"),
  Type.Literal("integer"),
  Type.Literal("scale_0_10"),
  Type.Literal("free_text"),
  Type.Literal("enum"),
]);

/**
 * §4.1 row 31 — a protocol question.
 *
 * `isSystemLocked` is absent: a tenant cannot mint a platform-floor row (§3.3's CHECK pair makes a locked
 * row org-less, and migration 0108's policies make it unwritable). Accepting the field and ignoring it
 * would be worse than refusing it — the DON would believe they had authored a protected question.
 */
export const ProtocolQuestionBody = Type.Object(
  {
    questionOrder: Type.Integer({ minimum: 1, maximum: 500 }),
    prompt: FreeText(3, 500),
    answerType: AnswerType,
    answerEnumValues: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
    required: Type.Optional(Type.Boolean()),
    isRedFlagQuestion: Type.Optional(Type.Boolean()),
    redFlagMatch: Type.Optional(Type.Union([RedFlagMatch, Type.Null()])),
  },
  { additionalProperties: false },
);

/** §4.1 row 29 — author a TENANT-CUSTOM protocol. `isSystemLocked` is absent for the same reason. */
export const CreateProtocolBody = Type.Object(
  {
    key: Type.String({ minLength: 2, maxLength: 120, pattern: "^[a-z0-9_]+$" }),
    chiefComplaintLabel: FreeText(3, 200),
    /** M38-validated SNOMED finding/symptom code. */
    snomedCode: Type.String({ pattern: "^[0-9]{6,18}$" }),
    disciplineRequired: ShiftDiscipline,
    requiresMandatoryEscalation: Type.Optional(Type.Boolean()),
    mandatoryEscalationTier: Type.Optional(Type.Union([EscalationTier, Type.Null()])),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
    effectiveFrom: Type.Optional(Instant),
    effectiveTo: Type.Optional(Type.Union([Instant, Type.Null()])),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
    questions: Type.Optional(Type.Array(ProtocolQuestionBody, { maxItems: 200 })),
  },
  { additionalProperties: false },
);

/** §4.1 row 30 — edit a TENANT protocol (system-locked rows are rejected in the handler). */
export const PatchProtocolBody = Type.Object(
  {
    chiefComplaintLabel: Type.Optional(FreeText(3, 200)),
    snomedCode: Type.Optional(Type.String({ pattern: "^[0-9]{6,18}$" })),
    disciplineRequired: Type.Optional(ShiftDiscipline),
    requiresMandatoryEscalation: Type.Optional(Type.Boolean()),
    mandatoryEscalationTier: Type.Optional(Type.Union([EscalationTier, Type.Null()])),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
    effectiveTo: Type.Optional(Type.Union([Instant, Type.Null()])),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  },
  { additionalProperties: false },
);

/** §4.1 row 32 — edit one question (system-locked questions are rejected in the handler). */
export const PatchProtocolQuestionBody = Type.Partial(ProtocolQuestionBody);

// ── §4.1 rows 34-35 — external vendor bindings ──────────────────────────────────────────────────────

/**
 * §4.1 row 34 — create a vendor binding.
 *
 * `baaInEffect` is REQUIRED and required to be `true`-able only through an explicit attestation field: §8.5
 * makes the BAA a precondition for enabling an adapter at runtime, and a binding created with the flag
 * defaulted to false is a binding that silently cannot carry calls. There is deliberately NO secret /
 * apiKey / token field — ADR-0026 puts vendor credentials in the platform secret store, and the ABSENCE of
 * the column and of this field is the control (see the §3.3 table header).
 */
export const CreateVendorBindingBody = Type.Object(
  {
    /** M40 canonical vendor entity — validated through M40's reader at write. */
    mdmVendorId: Uuid,
    name: FreeText(2, 200),
    /** §8.5 — selects the `@wardenx/triage-vendors` adapter. */
    adapterKey: Type.String({ minLength: 2, maxLength: 200 }),
    rnCoverageAttested: Type.Boolean(),
    baaInEffect: Type.Boolean(),
    /** NULL means "no stated expiry", not "unknown" (the §3.3 header). */
    baaExpiresOn: Type.Optional(Type.Union([LocalDate, Type.Null()])),
    /** §7.10 — the D13 minimization profile every outbound handoff is filtered through. */
    defaultMinimizationPolicy: Type.Object(
      {
        profile: Type.Union([
          Type.Literal("hybrid_phi_min"),
          Type.Literal("centralized_phi_min"),
        ]),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: false },
);

/** §4.1 row 35 — "BAA renewal updates only" (§4.1's own Notes). The narrow surface IS the rule. */
export const PatchVendorBindingBody = Type.Object(
  {
    rnCoverageAttested: Type.Optional(Type.Boolean()),
    baaInEffect: Type.Optional(Type.Boolean()),
    baaExpiresOn: Type.Optional(Type.Union([LocalDate, Type.Null()])),
  },
  { additionalProperties: false },
);

// ── §2.7 BCP paper re-entry ─────────────────────────────────────────────────────────────────────────

/**
 * The §2.7 step-3 paper-origin re-entry. Not in §4.1's table — §4.6 adds the `triage.paper_reentry`
 * permission with no route to spend it on, and a permission nobody can exercise is a permission that will
 * be granted and forgotten. The route is `POST /api/v1/triage-calls/paper-reentry`.
 *
 * `paperOriginalOpenedAt` is the ORIGINAL call time and is range-checked against the worklist row's outage
 * window (§8.3.2's back-dating threat); `worklistId` names the row this re-entry closes.
 */
export const PaperReentryBody = Type.Object(
  {
    worklistId: Uuid,
    providerEntityId: Uuid,
    paperOriginalOpenedAt: Instant,
    inboundChannel: InboundChannel,
    callerKind: CallerKind,
    patientId: UuidOpt,
    admissionId: UuidOpt,
    chiefComplaintText: Type.Optional(Type.String({ maxLength: 1000 })),
    callerDisplayName: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

// ── list queries (§4.1.1 cursor pagination) ─────────────────────────────────────────────────────────

const CursorFields = {
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

/** §4.1 row 2 — the supervisor board / caseload list. */
export const ListTriageCallsQuery = Type.Object(
  {
    ...CursorFields,
    state: Type.Optional(TriageCallState),
    /** The §3.4 "all open cases right now" board — the six non-terminal states in one filter. */
    openOnly: Type.Optional(Type.Boolean()),
    providerEntityId: UuidOpt,
    patientId: UuidOpt,
    openedFrom: InstantOpt,
    openedTo: InstantOpt,
  },
  { additionalProperties: false },
);

/** §4.1 row 16 — the escalation inbox. */
export const ListEscalationsQuery = Type.Object(
  {
    ...CursorFields,
    tier: Type.Optional(EscalationTier),
    /** Default true — an inbox shows what is outstanding. */
    openOnly: Type.Optional(Type.Boolean()),
    triageCallId: UuidOpt,
  },
  { additionalProperties: false },
);

/** §4.1 row 19 — the shift schedule. */
export const ListShiftsQuery = Type.Object(
  {
    ...CursorFields,
    providerEntityId: UuidOpt,
    discipline: Type.Optional(ShiftDiscipline),
    from: InstantOpt,
    to: InstantOpt,
  },
  { additionalProperties: false },
);

/** §4.1 row 24 — who is on call NOW. */
export const CurrentOnCallQuery = Type.Object(
  { providerEntityId: UuidOpt, asOf: InstantOpt },
  { additionalProperties: false },
);

/** §4.1 row 27 — the protocol catalog (platform floor + this tenant's rows). */
export const ListProtocolsQuery = Type.Object(
  {
    ...CursorFields,
    /** Default true — a retired protocol is catalog history, not a thing to apply at 2 a.m. */
    effectiveOnly: Type.Optional(Type.Boolean()),
    disciplineRequired: Type.Optional(ShiftDiscipline),
    search: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);

/** §4.1 row 36 — the portal's lay-language recent-activity list. */
export const PortalRecentQuery = Type.Object(
  { ...CursorFields, sinceDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })) },
  { additionalProperties: false },
);

export type OpenTriageCallInput = Static<typeof OpenTriageCallBody>;
export type SelectDispositionInput = Static<typeof SelectDispositionBody>;
export type RecordAnswerInput = Static<typeof RecordAnswerBody>;
export type EscalateInput = Static<typeof EscalateBody>;
export type CreateShiftInput = Static<typeof CreateShiftBody>;
export type PatchOncallPolicyInput = Static<typeof PatchOncallPolicyBody>;
export type CreateProtocolInput = Static<typeof CreateProtocolBody>;
export type CreateVendorBindingInput = Static<typeof CreateVendorBindingBody>;
export type PaperReentryInput = Static<typeof PaperReentryBody>;

// ── §4.2 RESPONSE DTOs (F0 enrichment) ────────────────────────────────────────────────────────────────
//
// The §4.1 read + write routes returned the typed view interfaces of `read-service`/`write-service` but
// published NO response contract, so `client:gen` typed every body `never`. These schemas mirror those
// views 1:1 and are pinned to them by the compile-time `Conforms` aliases at the foot of this section, so a
// view field added or renamed breaks `bun run build` rather than drifting silently from the generated
// client. Nullable view fields are `Union([_, Null])` (a REQUIRED, nullable property), never `Optional`, so
// the pin sees the same shape the service returns. The two deeply nested unions a triage-call detail
// carries — `dispositionData` (`TriageDispositionData`, an eight-arm payload union) and `medicationContext`
// (`TriageMedicationContext`, the D15 M12 slice pair) — are published as open schemas (`Type.Any`) rather
// than re-mirrored here, because a second hand-kept copy of either is exactly the drift these pins exist to
// stop; the same for the discriminated `OnCallActor` and `TriageRedFlagMatch` unions.

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const NullStr = Type.Union([Type.String(), Type.Null()]);
const Int = Type.Integer();

// enum mirrors not already declared above (`packages/types/src/oncall.ts` is the source of truth)
const TriageDispositionEnum = Type.Union([
  Type.Literal("caregiver_education_only"),
  Type.Literal("prn_intervention_authorized"),
  Type.Literal("verbal_order_recorded"),
  Type.Literal("visit_dispatched_now"),
  Type.Literal("visit_scheduled_first_light"),
  Type.Literal("gip_admission_proposed"),
  Type.Literal("ed_transfer_acknowledged"),
  Type.Literal("pronouncement_scheduled"),
  Type.Literal("escalated_unresolved"),
  Type.Literal("abandoned"),
]);
const SelectableDispositionEnum = Type.Union([
  Type.Literal("caregiver_education_only"),
  Type.Literal("prn_intervention_authorized"),
  Type.Literal("verbal_order_recorded"),
  Type.Literal("visit_dispatched_now"),
  Type.Literal("visit_scheduled_first_light"),
  Type.Literal("gip_admission_proposed"),
  Type.Literal("ed_transfer_acknowledged"),
  Type.Literal("pronouncement_scheduled"),
]);
const TriageCallSourceEnum = Type.Union([
  Type.Literal("manual"),
  Type.Literal("no_show"),
  Type.Literal("late_checkout"),
  Type.Literal("geofence_anomaly"),
  Type.Literal("m36_delivery_failure"),
  Type.Literal("paper_origin"),
]);
const EscalationStateEnum = Type.Union([
  Type.Literal("open"),
  Type.Literal("acknowledged"),
  Type.Literal("resolved"),
]);
const EscalationTriggerEnum = Type.Union([
  Type.Literal("manual"),
  Type.Literal("red_flag_question"),
  Type.Literal("mandatory_protocol"),
  Type.Literal("sla_breach"),
]);
const AnswerTypeEnum = Type.Union([
  Type.Literal("boolean"),
  Type.Literal("integer"),
  Type.Literal("scale_0_10"),
  Type.Literal("free_text"),
  Type.Literal("enum"),
]);
const AiConfidenceEnum = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
const RiskBandEnum = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
const ShiftStatusEnum = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);
const RedactedCategoryEnum = Type.Union([
  Type.Literal("sud"),
  Type.Literal("ai_advisory"),
  Type.Literal("caller_free_text"),
]);

/** `CursorPage<T>` (concurrency.ts) — `{ data, next_cursor, has_more }`, NOT `{ items, nextCursor }`. */
const Page = <T extends TSchema>(item: T) =>
  Type.Object({
    data: Type.Array(item),
    next_cursor: NullStr,
    has_more: Type.Boolean(),
  });

// ── triage-call sub-views ─────────────────────────────────────────────────────────────────────────────

export const TriageAnswerViewResponse = Type.Object({
  id: Type.String(),
  questionId: Type.String(),
  questionOrder: Int,
  prompt: Type.String(),
  answerType: AnswerTypeEnum,
  valueText: NullStr,
  valueInt: Nullable(Type.Integer()),
  valueBool: Nullable(Type.Boolean()),
  redFlagHit: Type.Boolean(),
  correctionOfAnswerId: NullStr,
  answeredAt: Type.String(),
  answeredByMembershipId: Type.String(),
});

export const TriageEscalationViewResponse = Type.Object({
  id: Type.String(),
  tier: EscalationTier,
  triggerKind: EscalationTriggerEnum,
  state: EscalationStateEnum,
  mandatory: Type.Boolean(),
  escalatedToMembershipId: NullStr,
  escalatedToExternalActorId: NullStr,
  escalatedAt: Type.String(),
  acknowledgedAt: NullStr,
  resolvedAt: NullStr,
  resolvedByMembershipId: NullStr,
});

export const TriageStateHistoryViewResponse = Type.Object({
  id: Type.String(),
  fromState: Nullable(TriageCallState),
  toState: TriageCallState,
  transitionedAt: Type.String(),
  actorMembershipId: NullStr,
  systemActor: Type.Boolean(),
});

const triageCallListItemProps = {
  id: Type.String(),
  providerEntityId: Type.String(),
  patientId: NullStr,
  state: TriageCallState,
  disposition: Nullable(TriageDispositionEnum),
  callerKind: CallerKind,
  inboundChannel: InboundChannel,
  source: TriageCallSourceEnum,
  chiefComplaintSnomed: NullStr,
  openedAt: Type.String(),
  firstResponseAt: NullStr,
  closedAt: NullStr,
  protocolLabel: NullStr,
  openEscalationCount: Int,
  redFlagAnswerCount: Int,
  version: Int,
};

/** §4.1 row 2 — one supervisor-board / caseload row. */
export const TriageCallListItemResponse = Type.Object(triageCallListItemProps);

/** §4.1 row 3 — the full staff projection of one call. */
export const TriageCallDetailResponse = Type.Object({
  ...triageCallListItemProps,
  locationId: NullStr,
  admissionId: NullStr,
  callerDisplayName: NullStr,
  callerPhoneE164: NullStr,
  callerRelationshipLabel: NullStr,
  callerCaregiverId: NullStr,
  chiefComplaintText: NullStr,
  onCallShiftId: Type.String(),
  selectedProtocolId: NullStr,
  selectedProtocolVersion: NullStr,
  suggestedProtocolId: NullStr,
  suggestedProtocolConfidence: Nullable(AiConfidenceEnum),
  hospitalizationRiskBand: Nullable(RiskBandEnum),
  /** `TriageDispositionData | null` — the published eight-arm payload union (see section header). */
  dispositionData: Type.Any(),
  linkedEncounterId: NullStr,
  linkedVerbalOrderIds: Type.Array(Type.String()),
  linkedVisitProposalId: NullStr,
  paperOriginFlag: Type.Boolean(),
  paperOriginalOpenedAt: NullStr,
  documentedAt: NullStr,
  answers: Type.Array(TriageAnswerViewResponse),
  escalations: Type.Array(TriageEscalationViewResponse),
  stateHistory: Type.Array(TriageStateHistoryViewResponse),
  nextQuestionId: NullStr,
  permittedDispositions: Type.Array(SelectableDispositionEnum),
  /** `TriageMedicationContext | null` — the D15 M12 slice pair (see section header). */
  medicationContext: Type.Any(),
  redactedCategories: Type.Array(RedactedCategoryEnum),
  dispositionBlockedByMandatoryEscalation: Type.Boolean(),
});

/** §7.5 / D13 — the PHI-minimized external-vendor projection (a different TYPE, not a filtered one). */
export const VendorTriageCallViewResponse = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  state: TriageCallState,
  callerKind: CallerKind,
  inboundChannel: InboundChannel,
  chiefComplaintSnomed: NullStr,
  openedAt: Type.String(),
  onCallShiftId: Type.String(),
  selectedProtocolId: NullStr,
  selectedProtocolVersion: NullStr,
  answers: Type.Array(TriageAnswerViewResponse),
  escalations: Type.Array(TriageEscalationViewResponse),
  nextQuestionId: NullStr,
  permittedDispositions: Type.Array(SelectableDispositionEnum),
  version: Int,
});

/** §4.1 row 3 — `getTriageCall` returns the staff OR the vendor projection by session class. */
export const TriageCallResponse = Type.Union([
  TriageCallDetailResponse,
  VendorTriageCallViewResponse,
]);

/** §4.1 row 14 — the step-up, per-access-audited transcript read. */
export const TriageTranscriptResponse = Type.Object({
  triageCallId: Type.String(),
  transcript: NullStr,
  callerQuote: NullStr,
  decryptedAt: Type.String(),
});

/** §4.1 row 16 — one escalation-inbox row (a `TriageEscalationView` plus its call context). */
export const EscalationInboxItemResponse = Type.Object({
  id: Type.String(),
  tier: EscalationTier,
  triggerKind: EscalationTriggerEnum,
  state: EscalationStateEnum,
  mandatory: Type.Boolean(),
  escalatedToMembershipId: NullStr,
  escalatedToExternalActorId: NullStr,
  escalatedAt: Type.String(),
  acknowledgedAt: NullStr,
  resolvedAt: NullStr,
  resolvedByMembershipId: NullStr,
  triageCallId: Type.String(),
  providerEntityId: Type.String(),
  patientId: NullStr,
  callState: TriageCallState,
  minutesOpen: Int,
  version: Int,
});

/** §4.1 rows 19-23 — one `on_call_shift` row. */
export const OnCallShiftViewResponse = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  shiftStartsAt: Type.String(),
  shiftEndsAt: Type.String(),
  discipline: ShiftDiscipline,
  status: ShiftStatusEnum,
  primaryOnCallMembershipId: NullStr,
  backupMembershipId: NullStr,
  externalActorId: NullStr,
  externalActorLabel: NullStr,
  openedAt: NullStr,
  closedAt: NullStr,
  m17VisitAssignmentRef: NullStr,
  cancellationReason: NullStr,
  version: Int,
});

/** §4.1 row 24 — who is on call NOW, per ProviderEntity. `actors` is the discriminated `OnCallActor[]`. */
export const CurrentOnCallResponse = Type.Object({
  asOf: Type.String(),
  perProviderEntity: Type.Array(
    Type.Object({
      providerEntityId: Type.String(),
      actors: Type.Array(Type.Any()),
      rnCoverageGap: Type.Boolean(),
    }),
  ),
});

/** §4.1 rows 25-26 — the tenant policy row. The three ladder objects are opaque `unknown` (§3.2). */
export const OncallPolicyResponse = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  model: OncallModel,
  escalationTiers: Type.Unknown(),
  callbackSlaPerSeverity: Type.Unknown(),
  stateOverrides: Type.Unknown(),
  externalTriageVendorId: NullStr,
  emergencyContactE164: NullStr,
  aiProtocolSuggestionEnabled: Type.Boolean(),
  aiHospitalizationRiskEnabled: Type.Boolean(),
  version: Int,
});

/** §4.1 rows 27-32 — one catalog question. `redFlagMatch` is the closed `TriageRedFlagMatch` union. */
export const TriageProtocolQuestionViewResponse = Type.Object({
  id: Type.String(),
  questionOrder: Int,
  prompt: Type.String(),
  answerType: AnswerTypeEnum,
  answerEnumValues: Type.Union([Type.Array(Type.String()), Type.Null()]),
  required: Type.Boolean(),
  isRedFlagQuestion: Type.Boolean(),
  redFlagMatch: Type.Any(),
  isSystemLocked: Type.Boolean(),
});

/** §4.1 rows 27-32 — one protocol. `organizationId === null` is the platform floor. */
export const TriageProtocolViewResponse = Type.Object({
  id: Type.String(),
  organizationId: NullStr,
  key: Type.String(),
  chiefComplaintLabel: Type.String(),
  snomedCode: Type.String(),
  disciplineRequired: Type.String(),
  isSystemLocked: Type.Boolean(),
  requiresMandatoryEscalation: Type.Boolean(),
  mandatoryEscalationTier: Nullable(EscalationTier),
  version: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: NullStr,
  sortOrder: Int,
  questions: Type.Array(TriageProtocolQuestionViewResponse),
});

/** §4.1 rows 33-35 — one vendor binding. NO secret is ever projected (ADR-0026). */
export const VendorBindingViewResponse = Type.Object({
  id: Type.String(),
  mdmVendorId: Type.String(),
  name: Type.String(),
  adapterKey: Type.String(),
  rnCoverageAttested: Type.Boolean(),
  baaInEffect: Type.Boolean(),
  baaExpiresOn: NullStr,
  minimizationProfile: Type.String(),
  adapterRegistered: Type.Boolean(),
});

/** §2.7 — one outstanding paper-re-entry worklist row (the DON's BCP list). */
export const PaperReentryWorklistViewResponse = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  outageWindowId: Type.String(),
  shiftId: NullStr,
  shiftStartsAt: Type.String(),
  shiftEndsAt: Type.String(),
  assignedToMembershipId: NullStr,
  reenteredAt: NullStr,
  linkedTriageCallId: NullStr,
  expiresAt: Type.String(),
});

/** §4.1 row 36 — the M31 portal's lay-language care-log entry (D11/D13 scrubbed by construction). */
export const PortalTriageSummaryResponse = Type.Object({
  triageCallId: Type.String(),
  occurredAt: Type.String(),
  callerRelationshipLabel: NullStr,
  callerKind: CallerKind,
  dispositionSummaryLay: Type.String(),
  visitDispatched: Type.Boolean(),
  visitScheduledFirstLight: Type.Boolean(),
});

// ── write results ───────────────────────────────────────────────────────────────────────────────────

/** §4.2 open response — the created call plus what the D11/D12 advisories had to say. */
export const OpenTriageCallResultResponse = Type.Object({
  triageCallId: Type.String(),
  state: Type.Literal("open"),
  onCallShiftId: Type.String(),
  version: Int,
  suggestedProtocolId: NullStr,
  suggestedProtocolConfidence: NullStr,
  hospitalizationRiskBand: NullStr,
  aiBlockDisabled: Type.Boolean(),
});

/** §7.1 / §7.2 answer response — the D5 verdict the panel's sticky banner keys off. */
export const AnswerWriteResultResponse = Type.Object({
  answerId: Type.String(),
  redFlagHit: Type.Boolean(),
  mandatoryEscalationTriggered: Type.Boolean(),
  escalationId: NullStr,
  tier: Nullable(EscalationTier),
  nextQuestionId: NullStr,
  version: Int,
});

// ── page envelopes (cursor-paginated list routes) ─────────────────────────────────────────────────────

export const TriageCallListPageResponse = Page(TriageCallListItemResponse);
export const EscalationInboxPageResponse = Page(EscalationInboxItemResponse);
export const OnCallShiftPageResponse = Page(OnCallShiftViewResponse);
export const TriageProtocolPageResponse = Page(TriageProtocolViewResponse);
export const PortalRecentPageResponse = Page(PortalTriageSummaryResponse);

/** Bare-array list responses (no cursor envelope). */
export const VendorBindingListResponse = Type.Array(VendorBindingViewResponse);
export const PaperReentryWorklistResponse = Type.Array(PaperReentryWorklistViewResponse);

// ── compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service
//    returns). A view field added or renamed without a matching schema edit fails `bun run build` here.
type Conforms<T extends V, V> = T;
type _AnswerView = Conforms<Static<typeof TriageAnswerViewResponse>, TriageAnswerView>;
type _EscalationView = Conforms<Static<typeof TriageEscalationViewResponse>, TriageEscalationView>;
type _StateHistory = Conforms<Static<typeof TriageStateHistoryViewResponse>, TriageStateHistoryView>;
type _ListItem = Conforms<Static<typeof TriageCallListItemResponse>, TriageCallListItem>;
type _Detail = Conforms<Static<typeof TriageCallDetailResponse>, TriageCallDetail>;
type _Vendor = Conforms<Static<typeof VendorTriageCallViewResponse>, VendorTriageCallView>;
type _CallUnion = Conforms<Static<typeof TriageCallResponse>, TriageCallDetail | VendorTriageCallView>;
type _Transcript = Conforms<Static<typeof TriageTranscriptResponse>, TriageTranscriptView>;
type _Inbox = Conforms<Static<typeof EscalationInboxItemResponse>, EscalationInboxItem>;
type _Shift = Conforms<Static<typeof OnCallShiftViewResponse>, OnCallShiftView>;
type _Current = Conforms<Static<typeof CurrentOnCallResponse>, CurrentOnCallView>;
type _Policy = Conforms<Static<typeof OncallPolicyResponse>, OncallPolicyView>;
type _Question = Conforms<
  Static<typeof TriageProtocolQuestionViewResponse>,
  TriageProtocolQuestionView
>;
type _Protocol = Conforms<Static<typeof TriageProtocolViewResponse>, TriageProtocolView>;
type _VendorBinding = Conforms<Static<typeof VendorBindingViewResponse>, VendorBindingView>;
type _Worklist = Conforms<Static<typeof PaperReentryWorklistViewResponse>, PaperReentryWorklistView>;
type _Portal = Conforms<Static<typeof PortalTriageSummaryResponse>, PortalTriageSummary>;
type _OpenResult = Conforms<Static<typeof OpenTriageCallResultResponse>, OpenTriageCallResult>;
type _AnswerResult = Conforms<Static<typeof AnswerWriteResultResponse>, AnswerWriteResult>;
type _CallPage = Conforms<Static<typeof TriageCallListPageResponse>, CursorPage<TriageCallListItem>>;
type _EscPage = Conforms<Static<typeof EscalationInboxPageResponse>, CursorPage<EscalationInboxItem>>;
type _ShiftPage = Conforms<Static<typeof OnCallShiftPageResponse>, CursorPage<OnCallShiftView>>;
type _ProtoPage = Conforms<Static<typeof TriageProtocolPageResponse>, CursorPage<TriageProtocolView>>;
type _PortalPage = Conforms<Static<typeof PortalRecentPageResponse>, CursorPage<PortalTriageSummary>>;
type _VendorList = Conforms<Static<typeof VendorBindingListResponse>, readonly VendorBindingView[]>;
type _WorklistList = Conforms<
  Static<typeof PaperReentryWorklistResponse>,
  readonly PaperReentryWorklistView[]
>;
