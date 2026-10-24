// apps/backend/src/modules/16-bereavement/routes/m16-typebox.ts — M16 (§4.2) request schemas.
//
// TypeBox request bodies, path params and list queries for the §4.1 Bereavement routes. The OpenAPI
// enrichment registry layers these onto the auto-discovered routes so the generated client types the
// surface the M16-T07 web screens call (the M15 `m15-typebox` / M24 `m24-typebox` precedent). Named
// `m16-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one.
//
// The string-literal unions MIRROR the frozen `@chartwarden/db` pgEnum value lists
// (packages/db/src/enums.ts, M16-T01) — the schema wins on conflict. Org / actor / membership binding is
// server-side (`request.context`): no body or query carries an org id or an acting membership id, which is
// the §6.1 spoofing control at the boundary.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@chartwarden/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set("email", (v) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
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
 * Validate a request BODY at the route boundary — a malformed request is rejected BEFORE it reaches a
 * service. Deliberately does NOT run `Value.Convert`: a JSON body already carries real types, and coercing
 * would silently repair genuinely wrong input. Queries are the only place coercion is legitimate — use
 * `parseQuery`.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/** Validate a request QUERY, converting the declared scalars first (`?limit=25` arrives as "25"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const UuidN = Type.Union([Type.String({ format: "uuid" }), Type.Null()]);
const Instant = Type.String({ format: "date-time" });
const LocalDate = Type.String({ minLength: 10, maxLength: 10 });

// ── enum mirrors (`packages/db/src/enums.ts` is the source of truth) ─────────────────────────────────

/** `bereavement_plan_status` (§3.2). */
export const PlanStatus = Type.Union([
  Type.Literal("eligible"),
  Type.Literal("initiating"),
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("closed_completed"),
  Type.Literal("closed_declined"),
  Type.Literal("closed_early"),
  Type.Literal("closed_legal_hold_extended"),
]);

/** `bereaved_contact_status` (§3.2). */
export const ContactStatus = Type.Union([
  Type.Literal("proposed"),
  Type.Literal("active"),
  Type.Literal("opted_out"),
  Type.Literal("deceased"),
  Type.Literal("unreachable"),
  Type.Literal("ineligible_post_review"),
]);

/** `bereaved_contact_relationship` (§3.2 / §4.2). M38 owns the authoritative value set. */
export const RelationshipCode = Type.Union([
  Type.Literal("spouse"),
  Type.Literal("domestic_partner"),
  Type.Literal("parent"),
  Type.Literal("child"),
  Type.Literal("sibling"),
  Type.Literal("grandparent"),
  Type.Literal("grandchild"),
  Type.Literal("aunt_uncle"),
  Type.Literal("cousin"),
  Type.Literal("in_law"),
  Type.Literal("friend"),
  Type.Literal("neighbor"),
  Type.Literal("clergy"),
  Type.Literal("colleague"),
  Type.Literal("caregiver_non_family"),
  Type.Literal("other"),
]);

/** `bereavement_outreach_kind` (§3.2). */
export const OutreachKind = Type.Union([
  Type.Literal("phone_call"),
  Type.Literal("in_person_visit"),
  Type.Literal("sympathy_card"),
  Type.Literal("sympathy_letter"),
  Type.Literal("anniversary_letter"),
  Type.Literal("email"),
  Type.Literal("portal_message"),
  Type.Literal("group_support_invitation"),
  Type.Literal("external_referral"),
]);

/** The eight NON-encounter kinds §4.2's `CompleteOutreachBody` enumerates (D15's other branch). */
export const NonEncounterOutreachKind = Type.Union([
  Type.Literal("phone_call"),
  Type.Literal("sympathy_card"),
  Type.Literal("sympathy_letter"),
  Type.Literal("anniversary_letter"),
  Type.Literal("email"),
  Type.Literal("portal_message"),
  Type.Literal("group_support_invitation"),
  Type.Literal("external_referral"),
]);

/** `bereavement_outreach_status` (§3.2). */
export const OutreachStatus = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("declined"),
  Type.Literal("no_response"),
  Type.Literal("missed"),
  Type.Literal("cancelled"),
]);

/** `bereavement_contact_log_outcome` (§3.2). */
export const ContactLogOutcome = Type.Union([
  Type.Literal("engaged"),
  Type.Literal("brief_acknowledgement"),
  Type.Literal("declined"),
  Type.Literal("no_response"),
  Type.Literal("voicemail_left"),
  Type.Literal("wrong_number"),
  Type.Literal("returned_undeliverable"),
  Type.Literal("requested_followup"),
  Type.Literal("requested_no_further_contact"),
  Type.Literal("crisis_referral"),
]);

/** `bereavement_risk_tier` (§3.2). */
export const RiskTier = Type.Union([
  Type.Literal("low"),
  Type.Literal("moderate"),
  Type.Literal("high"),
  Type.Literal("complicated"),
]);

/** `bereavement_plan_pause_kind` (§3.2). */
export const PauseKind = Type.Union([
  Type.Literal("operational"),
  Type.Literal("family_request"),
  Type.Literal("counselor_unavailable_temp"),
]);

/** The FIVE §4.2 `CloseEarlyBody` reasons — the D7 cosign-required subset of the closure enum. The four
 *  system-driven reasons (13-month completion, all-declined, the two patient opt-outs) are cascades that no
 *  route may request, which is why they are absent here rather than merely discouraged. */
export const EarlyCloseReason = Type.Union([
  Type.Literal("tenant_offboarding"),
  Type.Literal("all_bereaved_deceased"),
  Type.Literal("geographic_relocation"),
  Type.Literal("family_legal_action"),
  Type.Literal("other_early"),
]);

/** `bereavement_opt_out_kind` (§3.2 / §4.2). */
export const OptOutKind = Type.Union([
  Type.Literal("full"),
  Type.Literal("channel_specific"),
  Type.Literal("pause_temporarily"),
]);

/** §4.2 `OptOutBody.sourceKind` — the counselor / portal / written-request provenance. The fourth enum
 *  value, `m39_revocation_cascade`, is deliberately NOT accepted from the wire: it is the §2.6 consumer's
 *  own attribution, and letting a client claim it would forge M39 as the source of a decision. */
export const OptOutSourceKind = Type.Union([
  Type.Literal("counselor_recorded"),
  Type.Literal("portal_self_service"),
  Type.Literal("written_request_uploaded"),
]);

/** The tri-state a §4.2 `RiskFactorsInput` factor carries (D17 — `unknown` is a real answer). */
const TriState = Type.Union([Type.Boolean(), Type.Literal("unknown")]);

// ── path params ─────────────────────────────────────────────────────────────────────────────────────

export const PlanParams = Type.Object({ planId: Uuid });
export const ContactParams = Type.Object({ contactId: Uuid });
export const OutreachParams = Type.Object({ outreachId: Uuid });

// ── list queries (cursor pagination; `offset` is refused by the preHandler) ──────────────────────────

/** Route 1 — the counselor caseload by default; a supervisor may widen with the filters. */
export const PlanListQuerySchema = Type.Object({
  patientId: Type.Optional(Uuid),
  admissionId: Type.Optional(Uuid),
  status: Type.Optional(PlanStatus),
  counselorUserId: Type.Optional(Uuid),
  riskTier: Type.Optional(RiskTier),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/** Route 19 — the §4.6 `OutreachFilters` set, as a query. */
export const OutreachListQuerySchema = Type.Object({
  contactId: Type.Optional(Uuid),
  status: Type.Optional(OutreachStatus),
  kind: Type.Optional(OutreachKind),
  dueFrom: Type.Optional(Instant),
  dueTo: Type.Optional(Instant),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

/** Route 29 — per-contact + plan-level score history (the append-only ledger, newest first). */
export const RiskScoreListQuerySchema = Type.Object({
  contactId: Type.Optional(Uuid),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/** Route 30 — "own caseload + due in N days". */
export const CounselorDashboardQuerySchema = Type.Object({
  dueWithinDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

/** Route 31 — full-tenant rollups, optionally narrowed to one CCN / location. */
export const SupervisorDashboardQuerySchema = Type.Object({
  providerEntityId: Type.Optional(Uuid),
  locationId: Type.Optional(Uuid),
});

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────

/** Route 3 — §4.2 verbatim. The counselor's DISCIPLINE is resolved server-side, never sent. */
export const AssignCounselorBody = Type.Object({
  counselorUserId: Uuid,
  effectiveAt: Type.Optional(Instant),
});

/** Route 4 — the volunteer counterpart; the 418.78 gates resolve through M15's seam, never the body. */
export const AssignVolunteerBody = Type.Object({
  volunteerUserId: Uuid,
  effectiveAt: Type.Optional(Instant),
});

/** One counselor-supplied roster addition inside {@link SeedRosterAndScheduleBody} (§4.2 verbatim). */
export const AdditionalContactBody = Type.Object({
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  relationshipCode: RelationshipCode,
  email: Type.Optional(Type.String({ format: "email" })),
  phone: Type.Optional(Type.String({ minLength: 7, maxLength: 30 })),
  mailingAddress: Type.Optional(Type.String({ maxLength: 500 })),
  preferredLanguageIso639: Type.Optional(Type.String({ minLength: 2, maxLength: 8 })),
  consentRecordId: Type.Optional(Uuid),
  outreachPreferences: Type.Optional(
    Type.Object({ allowedKinds: Type.Array(OutreachKind, { maxItems: 9 }) }),
  ),
});

/** Route 5 — §4.2 verbatim. */
export const SeedRosterAndScheduleBody = Type.Object({
  seedFromCaregivers: Type.Optional(Type.Boolean()),
  additionalContacts: Type.Optional(Type.Array(AdditionalContactBody, { maxItems: 64 })),
});

/** Route 6 — §2.2 requires a recorded reason; a pause without one is a lapse, not a pause. */
export const PausePlanBody = Type.Object({
  pauseKind: PauseKind,
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});

/** Route 7 — resuming carries no body beyond the `If-Match` version. */
export const ResumePlanBody = Type.Object({});

/** Route 8 — §4.2 verbatim; the cosign arrives on route 9, not here. */
export const CloseEarlyBody = Type.Object({
  reason: EarlyCloseReason,
  narrative: Type.String({ minLength: 40, maxLength: 2000 }),
});

/** Route 9 — the D7 supervisor cosign. The COSIGNER is the server-assembled acting membership. */
export const CosignCloseBody = Type.Object({
  attestation: Type.Optional(Type.String({ maxLength: 2000 })),
});

/** Route 11 — add one bereaved contact to an open plan. */
export const CreateContactBody = AdditionalContactBody;

/** Route 12 — preferences / channels only. `relationship_code` and `display_name` are corrections of
 *  record, not preference edits, so they ride the same body but the service audits them separately. */
export const UpdateContactBody = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  email: Type.Optional(Type.Union([Type.String({ format: "email" }), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String({ minLength: 7, maxLength: 30 }), Type.Null()])),
  mailingAddress: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  preferredLanguageIso639: Type.Optional(Type.String({ minLength: 2, maxLength: 8 })),
  outreachPreferences: Type.Optional(
    Type.Object({ allowedKinds: Type.Array(OutreachKind, { maxItems: 9 }) }),
  ),
  volunteerVisibleOnly: Type.Optional(Type.Boolean()),
});

/** Route 13 — proposed → active. The M39 consent verdict is resolved server-side (D6 fail-CLOSED). */
export const ConfirmContactBody = Type.Object({
  consentRecordId: Type.Optional(Uuid),
});

/** Route 14 — §4.2 verbatim. */
export const OptOutBody = Type.Object({
  optOutKind: OptOutKind,
  channelKinds: Type.Optional(Type.Array(OutreachKind, { maxItems: 9 })),
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
  sourceKind: OptOutSourceKind,
});

/** Route 15 — undo an opt-out. A COUNSELOR rescind is not bound by the D9 90-day window, but must say why. */
export const RescindOptOutBody = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

/** Route 16 — §2.3 requires a VERIFIED death: a date and where it came from, both captured. */
export const MarkDeceasedBody = Type.Object({
  deceasedAt: Instant,
  deathSource: Type.String({ minLength: 1, maxLength: 200 }),
});

/** Route 17 — the manual accept of the 3-strikes proposal. */
export const MarkUnreachableBody = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});

/** Route 34 — the counselor's "keep trying" dismissal of the unreachable proposal. */
export const DismissUnreachableProposalBody = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});

/** Route 18 — §7.7. The M40 external resource is REQUIRED: "referred to external services" with nowhere
 *  named is a dead end for someone in crisis. */
export const FlagComplicatedGriefBody = Type.Object({
  externalResourceId: Uuid,
  pg13Score: Type.Optional(Type.Integer({ minimum: 0, maximum: 52 })),
  ipgrScore: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
  note: Type.Optional(Type.String({ maxLength: 4000 })),
});

/** Route 20 — scheduled → in_progress. */
export const StartOutreachBody = Type.Object({});

/** Route 21 — §4.2's discriminated union. The in-person branch REQUIRES the M8 encounter (D15); every
 *  other kind must NOT carry one, and the DB CHECK pair on `bereavement_contact_log` agrees. */
export const CompleteOutreachBody = Type.Union([
  Type.Object({
    kind: Type.Literal("in_person_visit"),
    sourceEncounterId: Uuid,
    outcome: ContactLogOutcome,
    contactResponded: Type.Boolean(),
    notes: Type.Optional(Type.String({ maxLength: 8000 })),
  }),
  Type.Object({
    kind: NonEncounterOutreachKind,
    outcome: ContactLogOutcome,
    contactResponded: Type.Boolean(),
    artifactDocumentId: Type.Optional(Uuid),
    notes: Type.Optional(Type.String({ maxLength: 8000 })),
  }),
]);

/** Routes 22 / 23 — the two fixed-outcome completions (§2.4 `contactDeclined` / `noResponseAfterRetries`). */
export const OutreachOutcomeBody = Type.Object({
  notes: Type.Optional(Type.String({ maxLength: 8000 })),
});

/** Route 24 — cancelling a scheduled touchpoint must record why (§2.4). */
export const CancelOutreachBody = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});

/** Route 25 — missed → in_progress inside the 7-day late grace. */
export const LateAttemptBody = Type.Object({});

/** Route 26 — an ad-hoc contact-log row for a touchpoint that had no scheduled outreach. */
export const LogDirectContactBody = Type.Object({
  kind: NonEncounterOutreachKind,
  outcome: ContactLogOutcome,
  contactAt: Instant,
  contactResponded: Type.Boolean(),
  artifactDocumentId: Type.Optional(UuidN),
  notes: Type.Optional(Type.String({ maxLength: 8000 })),
});

/** Route 27 — regenerate the FORWARD schedule (never backdated obligations). */
export const RegenerateScheduleBody = Type.Object({
  contactId: Type.Optional(Uuid),
  fromAt: Type.Optional(Instant),
});

/** Route 28 — §4.2 `RiskFactorsInput` verbatim, plus the D8 override fields §7.3 requires. */
export const RecomputeRiskBody = Type.Object({
  bereavedContactId: Type.Optional(Uuid),
  factors: Type.Optional(
    Type.Object({
      ambivalent_relationship: TriState,
      sudden_unexpected_death: TriState,
      prior_unresolved_loss: TriState,
      preexisting_mental_health: TriState,
      social_isolation: TriState,
      financial_strain: TriState,
      primary_caregiver_role: TriState,
      active_substance_use: TriState,
      pg13_score: Type.Optional(Type.Number()),
      ipgr_score: Type.Optional(Type.Number()),
      notes: Type.Optional(Type.String({ maxLength: 8000 })),
    }),
  ),
  requestAugmentation: Type.Optional(Type.Boolean()),
  /** §7.3 — a counselor override needs BOTH the tier it lands on and a ≥40-char documented reason. */
  overrideTier: Type.Optional(RiskTier),
  overrideReason: Type.Optional(Type.String({ maxLength: 4000 })),
});

/** Route 32 — log a referral to an M40 external grief resource without ending the program (contrast
 *  route 18, which does end it for that survivor). */
export const ReferExternalBody = Type.Object({
  externalResourceId: Uuid,
  contactAt: Type.Optional(Instant),
  notes: Type.Optional(Type.String({ maxLength: 8000 })),
});

/** Route 33 — the D18-gated counselor first contact (§4.3.2). */
export const InitiateContactBody = Type.Object({
  contactId: Uuid,
  kind: Type.Optional(OutreachKind),
});

export type PlanListQuery = Static<typeof PlanListQuerySchema>;
export type OutreachListQuery = Static<typeof OutreachListQuerySchema>;
export type RiskScoreListQuery = Static<typeof RiskScoreListQuerySchema>;
export type CounselorDashboardQuery = Static<typeof CounselorDashboardQuerySchema>;
export type SupervisorDashboardQuery = Static<typeof SupervisorDashboardQuerySchema>;
export type LocalDateString = Static<typeof LocalDate>;

// ── §4.1 RESPONSE DTOs (F0 enrichment) ────────────────────────────────────────────────────────────────
// The §4.1 GET + write routes returned the typed §4.6 view shapes but published NO response contract, so
// the generated client typed every body as `never`. These DTOs mirror the read/write service views 1:1 and
// are pinned to them by the compile-time `Conforms` aliases below: a view field added or renamed breaks
// `bun run build` rather than silently drifting from the client. Enums are literal unions (the wire-enum-as-
// string rule); every branded id (`type X = string`) is a plain `Type.String()`. Ids that the service leaves
// `null` are `Nullable(...)`; the D10/§7.13-withheld risk fields are `Type.Optional(...)` — ABSENT means
// "not disclosed", never "no value".
const Str = Type.String();
const Int = Type.Integer();
const Bool = Type.Boolean();
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

/** `bereavement_plan_closure_reason` — the FULL nine-value enum (contrast `EarlyCloseReason`, the D7 subset). */
const ClosureReason = Type.Union([
  Type.Literal("thirteen_month_completion"),
  Type.Literal("all_contacts_declined"),
  Type.Literal("patient_opt_out_pre_death"),
  Type.Literal("patient_opt_out_post_creation"),
  Type.Literal("tenant_offboarding"),
  Type.Literal("all_bereaved_deceased"),
  Type.Literal("geographic_relocation"),
  Type.Literal("family_legal_action"),
  Type.Literal("other_early"),
]);

/** `bereavement_risk_score_kind`. */
const RiskScoreKind = Type.Union([
  Type.Literal("rule_deterministic"),
  Type.Literal("llm_augmented"),
]);

/** `bereavement_data_completeness`. */
const DataCompleteness = Type.Union([
  Type.Literal("complete"),
  Type.Literal("partial"),
  Type.Literal("minimal"),
]);

/** `bereavement_confidence_band`. */
const ConfidenceBand = Type.Union([
  Type.Literal("HIGH"),
  Type.Literal("MEDIUM"),
  Type.Literal("LOW"),
]);

/** `bereavement_anniversary_mark`. */
const AnniversaryMark = Type.Union([
  Type.Literal("one_month"),
  Type.Literal("three_month"),
  Type.Literal("six_month"),
  Type.Literal("nine_month_high_risk_only"),
  Type.Literal("anniversary"),
]);

/** §7.13 — the two confidentiality categories a read can withhold (`disclosure.ts`). */
const RedactedCategory = Type.Union([Type.Literal("sud"), Type.Literal("clinical_risk")]);

/** The 15 §2.6 side-effect kinds a transition can declare (`lifecycle/effects.ts`). */
const EffectKind = Type.Union([
  Type.Literal("audit"),
  Type.Literal("outbox"),
  Type.Literal("alert"),
  Type.Literal("set_timestamp"),
  Type.Literal("set_assignment"),
  Type.Literal("insert_closure"),
  Type.Literal("insert_opt_out"),
  Type.Literal("rescind_opt_out"),
  Type.Literal("cancel_future_outreach"),
  Type.Literal("regenerate_schedule"),
  Type.Literal("generate_schedule"),
  Type.Literal("seed_anniversary_reminders"),
  Type.Literal("recompute_risk"),
  Type.Literal("set_external_source_metadata"),
  Type.Literal("log_external_referral"),
]);

/** §7.11 closeout counts (`M16OutreachStats`). */
const OutreachStatsSchema = Type.Object({
  completedCount: Int,
  missedCount: Int,
  contactsActiveCount: Int,
  contactsOptedOutCount: Int,
});

/** D16 external-source provenance (`BereavementExternalSourceMetadata`). */
const ExternalSourceSchema = Type.Object({
  sourceProposalId: Str,
  sourceMessageId: Str,
  sourceFacilityMdmId: Str,
  sourceFacilityName: Str,
  ackReceivedAt: Str,
  cosignStatus: Type.Union([Type.Literal("pending"), Type.Literal("cosigned")]),
  cosignedAt: Type.Optional(Str),
  medicalDirectorMembershipId: Type.Optional(Str),
});

const TierDistributionSchema = Type.Object({
  low: Int,
  moderate: Int,
  high: Int,
  complicated: Int,
});

/** Route 1 — one plan-worklist row. */
export const BereavementPlanListItemResponseSchema = Type.Object({
  planId: Str,
  patientId: Str,
  admissionId: Str,
  status: PlanStatus,
  deathDate: Str,
  windowEndsAt: Str,
  assignedCounselorUserId: Nullable(Str),
  assignedVolunteerUserId: Nullable(Str),
  currentRiskTier: Type.Optional(Nullable(RiskTier)),
  contactsActiveCount: Int,
  nextOutreachDueAt: Nullable(Str),
  overdueOutreachCount: Int,
  externalSourceCosignPending: Bool,
  version: Int,
  updatedAt: Str,
});

/** One survivor row on the plan detail / roster. */
export const BereavedContactRowViewResponseSchema = Type.Object({
  contactId: Str,
  planId: Str,
  status: ContactStatus,
  displayName: Str,
  relationshipCode: RelationshipCode,
  preferredLanguageIso639: Str,
  portalAccountId: Nullable(Str),
  consentRecordId: Nullable(Str),
  allowedOutreachKinds: Type.Array(OutreachKind),
  volunteerVisibleOnly: Bool,
  confirmedAt: Nullable(Str),
  optedOutAt: Nullable(Str),
  unreachableAt: Nullable(Str),
  unreachableProposed: Bool,
  unreachableProposedAt: Nullable(Str),
  deceasedAt: Nullable(Str),
  mayRescindOptOut: Bool,
  currentRiskTier: Type.Optional(Nullable(RiskTier)),
  version: Int,
});

/** Route 2 — the plan header with its rolled-up roster + risk. */
export const BereavementPlanDetailResponseSchema = Type.Object({
  planId: Str,
  patientId: Str,
  admissionId: Str,
  providerEntityId: Str,
  locationId: Nullable(Str),
  status: PlanStatus,
  deathDate: Str,
  deathTime: Nullable(Str),
  windowEndsAt: Str,
  openedAt: Nullable(Str),
  pausedAt: Nullable(Str),
  pauseKind: Nullable(PauseKind),
  closedAt: Nullable(Str),
  assignedCounselorUserId: Nullable(Str),
  assignedCounselorAssignedAt: Nullable(Str),
  assignedVolunteerUserId: Nullable(Str),
  assignedVolunteerAssignedAt: Nullable(Str),
  externalSource: Nullable(ExternalSourceSchema),
  firstContactAllowed: Bool,
  firstContactGateReason: Nullable(Str),
  contacts: Type.Array(BereavedContactRowViewResponseSchema),
  stats: OutreachStatsSchema,
  currentRiskTier: Type.Optional(Nullable(RiskTier)),
  currentRiskComputedAt: Type.Optional(Nullable(Str)),
  legalHoldId: Nullable(Str),
  earlyCloseRequest: Type.Optional(
    Nullable(Type.Object({ reason: ClosureReason, requestedAt: Str, requestedByUserId: Str })),
  ),
  version: Int,
  updatedAt: Str,
  redactedCategories: Type.Array(RedactedCategory),
});

/** Route 10 — the §3.3.7 closure record. */
export const BereavementClosureViewResponseSchema = Type.Object({
  closureId: Str,
  planId: Str,
  reason: ClosureReason,
  closeKind: Str,
  closedAt: Str,
  closedByUserId: Nullable(Str),
  cosignedByUserId: Nullable(Str),
  cosignedAt: Nullable(Str),
  stats: OutreachStatsSchema,
  bereavementSummaryDocumentId: Nullable(Str),
});

/** Routes 19 / 20–25 / 33 — one scheduled or historical touchpoint. */
export const BereavementOutreachRowViewResponseSchema = Type.Object({
  outreachId: Str,
  planId: Str,
  contactId: Str,
  kind: OutreachKind,
  status: OutreachStatus,
  anniversaryMark: Nullable(AnniversaryMark),
  dueAt: Str,
  lateGraceUntil: Str,
  startedAt: Nullable(Str),
  completedAt: Nullable(Str),
  cancelledAt: Nullable(Str),
  assigneeUserId: Nullable(Str),
  renderedDocumentId: Nullable(Str),
  sourceEncounterId: Nullable(Str),
  version: Int,
});

/** Routes 28 / 29 — one immutable row of the append-only score ledger. */
export const BereavementRiskScoreViewResponseSchema = Type.Object({
  scoreId: Str,
  planId: Str,
  contactId: Nullable(Str),
  scoreKind: RiskScoreKind,
  assessedAt: Str,
  assessedByUserId: Nullable(Str),
  tier: RiskTier,
  deterministicTier: RiskTier,
  ruleScore: Type.Number(),
  dataCompleteness: DataCompleteness,
  confidenceBand: ConfidenceBand,
  factors: Type.Optional(Type.Record(Str, Type.Union([Bool, Type.Literal("unknown")]))),
  pg13Score: Nullable(Type.Number()),
  ipgrScore: Nullable(Type.Number()),
  evidenceDegraded: Bool,
  redactedCategories: Type.Array(RedactedCategory),
});

/** Routes 26 / 32 — the contact-log row an ad-hoc / referral write lands on. */
export const BereavementContactLogViewResponseSchema = Type.Object({
  contactLogId: Str,
  planId: Str,
  contactId: Str,
  outreachId: Str,
  kind: Str,
  outcome: Str,
  contactAt: Str,
  artifactDocumentId: Nullable(Str),
});

/** Route 27 — what the regeneration materialized (never a bare 204). */
export const ScheduleRegenerationViewResponseSchema = Type.Object({
  planId: Str,
  cancelledCount: Int,
  generatedCount: Int,
  outreach: Type.Array(BereavementOutreachRowViewResponseSchema),
});

/** Route 5 — the opened plan plus what opening it produced. */
export const PlanActivationViewResponseSchema = Type.Object({
  plan: BereavementPlanDetailResponseSchema,
  contactsSeededCount: Int,
  outreachScheduledCount: Int,
  anniversaryRemindersCount: Int,
  effects: Type.Array(EffectKind),
});

/** Route 30 — the counselor's own caseload + what is coming due. */
export const CounselorDashboardViewResponseSchema = Type.Object({
  counselorUserId: Str,
  caseloadCount: Int,
  dueWithinDays: Int,
  dueSoon: Type.Array(BereavementOutreachRowViewResponseSchema),
  overdue: Type.Array(BereavementOutreachRowViewResponseSchema),
  tierDistribution: TierDistributionSchema,
  externalSourceCosignPendingCount: Int,
});

/** Route 31 — the full-tenant rollups (COUNTS, never rates). */
export const SupervisorDashboardViewResponseSchema = Type.Object({
  planCountsByStatus: Type.Object({
    eligible: Int,
    initiating: Int,
    active: Int,
    paused: Int,
    closed_completed: Int,
    closed_declined: Int,
    closed_early: Int,
    closed_legal_hold_extended: Int,
  }),
  outreachCountsByStatus: Type.Object({
    scheduled: Int,
    in_progress: Int,
    completed: Int,
    declined: Int,
    no_response: Int,
    missed: Int,
    cancelled: Int,
  }),
  copCounts: Type.Object({ numerator: Int, denominator: Int }),
  tierDistribution: TierDistributionSchema,
  closureCountsByReason: Type.Object({
    thirteen_month_completion: Int,
    all_contacts_declined: Int,
    patient_opt_out_pre_death: Int,
    patient_opt_out_post_creation: Int,
    tenant_offboarding: Int,
    all_bereaved_deceased: Int,
    geographic_relocation: Int,
    family_legal_action: Int,
    other_early: Int,
  }),
  unassignedPlanCount: Int,
  externalSourceCosignPendingCount: Int,
});

/** The §2.5 cursor page envelope (`concurrency.ts` `CursorPage<T>`). */
const pageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    data: Type.Array(item),
    next_cursor: Nullable(Str),
    has_more: Bool,
    total_count: Type.Optional(Int),
  });

/** Route 1 — `CursorPage<BereavementPlanListItem>`. */
export const BereavementPlanPageResponseSchema = pageOf(BereavementPlanListItemResponseSchema);
/** Route 19 — `CursorPage<BereavementOutreachRowView>`. */
export const BereavementOutreachPageResponseSchema = pageOf(
  BereavementOutreachRowViewResponseSchema,
);
/** Route 29 — `CursorPage<BereavementRiskScoreView>`. */
export const BereavementRiskScorePageResponseSchema = pageOf(
  BereavementRiskScoreViewResponseSchema,
);
