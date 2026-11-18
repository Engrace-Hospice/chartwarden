// @chartwarden/billing — read-side schemas: route #2 list, #3 detail, #10 lines, #11 state-history,
// #12 submissions, #13 acknowledgments (§4.1). All aggregate / id-keyed projections — NO MBI, no
// free-text PHI on any field (D13 / §3.6 / §8.7).
import { type Static, Type } from "@sinclair/typebox";
import {
  AcknowledgmentKindApi,
  CentsSchema,
  ClaimStateApi,
  ClaimTobApi,
  CursorPageQuery,
  IsoDateSchema,
  IsoDateTimeSchema,
  LevelOfCareApi,
  PageOf,
  SubmissionKindApi,
  SubmissionOutcomeApi,
  Uuid,
  ValidationRunOutcomeApi,
  ValidationRunTriggerApi,
} from "./common";

// ── route #2: GET /claims (list, cursor-paginated) ──────────────────────────────────────────────────────
/** The AR-age bucket filter (mirrors the M33 AR-aging buckets). */
export const ArAgeBucket = Type.Union([
  Type.Literal("0_30"),
  Type.Literal("31_60"),
  Type.Literal("61_90"),
  Type.Literal("90_plus"),
]);

export const ClaimListQuery = Type.Composite([
  CursorPageQuery,
  Type.Object({
    state: Type.Optional(ClaimStateApi),
    patientId: Type.Optional(Uuid),
    providerEntityId: Type.Optional(Uuid),
    tob: Type.Optional(ClaimTobApi),
    serviceFrom: Type.Optional(IsoDateSchema),
    serviceTo: Type.Optional(IsoDateSchema),
    arAgeBucket: Type.Optional(ArAgeBucket),
  }),
]);
export type ClaimListQuery = Static<typeof ClaimListQuery>;

/** One row in the claims list (the `ClaimSummaryDto` projection). */
export const ClaimSummaryView = Type.Object({
  claimId: Uuid,
  providerEntityId: Uuid,
  patientId: Uuid,
  admissionId: Uuid,
  tob: ClaimTobApi,
  state: ClaimStateApi,
  serviceFrom: IsoDateSchema,
  serviceTo: IsoDateSchema,
  claimControlNumber: Type.String(),
  totalChargeCents: CentsSchema,
  version: Type.Integer(),
  updatedAt: IsoDateTimeSchema,
});
export type ClaimSummaryView = Static<typeof ClaimSummaryView>;

export const ClaimListResponse = PageOf(ClaimSummaryView);
export type ClaimListResponse = Static<typeof ClaimListResponse>;

// ── sub-views ───────────────────────────────────────────────────────────────────────────────────────────
/** route #10: a single `claim_line` projection. */
export const ClaimLineView = Type.Object({
  claimLineId: Uuid,
  serviceDate: IsoDateSchema,
  revenueCode: Type.String(),
  qCode: Type.Union([Type.String(), Type.Null()]),
  levelOfCare: LevelOfCareApi,
  hcpcs: Type.Union([Type.String(), Type.Null()]),
  modifiers: Type.Array(Type.String()),
  unitCount: Type.Number(),
  unitRateCents: CentsSchema,
  lineChargeCents: CentsSchema,
  icdPointerPositions: Type.Array(Type.Integer()),
});
export type ClaimLineView = Static<typeof ClaimLineView>;

/** The HIPPS derivation projection embedded in claim detail. */
export const PerDiemClassView = Type.Object({
  perDiemClassCode: Type.String(),
  perDiemRateCents: CentsSchema,
  wageIndexFactorApplied: Type.String(),
  segments: Type.Array(
    Type.Object({
      levelOfCare: LevelOfCareApi,
      dateFrom: IsoDateSchema,
      dateTo: IsoDateSchema,
      ratePerDiemCents: CentsSchema,
    }),
  ),
});
export type PerDiemClassView = Static<typeof PerDiemClassView>;

const NullableInteger = Type.Union([Type.Integer(), Type.Null()]);

/** How a `sia_calculation` row was computed: legacy minutes, or the 15-minute units model. */
export const SiaBasisApi = Type.Union([Type.Literal("minutes_v1"), Type.Literal("units_v2")]);

/** One visit in the last-7-days window with the engine's verdict. `reason` is the exclusion code (null when counted). */
export const SiaVisitView = Type.Object({
  id: Uuid,
  date: IsoDateSchema,
  discipline: Type.String(),
  /** The documented minutes, exact (an EVV bracket has seconds, so this may be fractional); null when undocumented. */
  minutes: Type.Union([Type.Number(), Type.Null()]),
  /** Who supplied `minutes`: the M18 EVV bracket or the signing clinician (typed); null = none, unknown, or a revision
   *  written before this was recorded. */
  timeSource: Type.Union([Type.Literal("evv"), Type.Literal("clinician"), Type.Null()]),
  /** 15-minute units the visit is worth before the daily cap; null when it is not an eligible visit. */
  units: NullableInteger,
  /** Units actually payable after the 16-unit daily cap. */
  paidUnits: Type.Integer(),
  counted: Type.Boolean(),
  /** The engine's SiaExclusionReason code, e.g. `modality_unconfirmed`, `no_documented_time`, `over_daily_cap`. */
  reason: Type.Union([Type.String(), Type.Null()]),
});
export type SiaVisitView = Static<typeof SiaVisitView>;

/** The open-question parameters the row was computed under. */
export const SiaPolicyView = Type.Object({
  unitTieBreak: Type.String(),
  videoEligible: Type.Boolean(),
  visitDating: Type.String(),
  wageBasis: Type.String(),
});
export type SiaPolicyView = Static<typeof SiaPolicyView>;

/** Death fell in the first 7 days of a month: Medicare adjusts the PRIOR month's claim; not part of this claim's payment. */
export const SiaPriorClaimAdvisoryView = Type.Object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  units: Type.Integer(),
  /** The prior-month days' value; null when the death year's CHC rate was unavailable (not priced). */
  cents: Type.Union([CentsSchema, Type.Null()]),
});
export type SiaPriorClaimAdvisoryView = Static<typeof SiaPriorClaimAdvisoryView>;

/**
 * The SIA add-on projection embedded in claim detail (`pricing.sia`, 0..1): the claim's NEWEST `sia_calculation` revision. A legacy
 * `minutes_v1` row has `visits: []` and null unit totals, rate and policy; its price is `amountCents` and its minutes are kept.
 * ONE mapper (`siaViewOf`) builds this for every read site, and the claim detail types derive from it.
 */
export const SiaView = Type.Object({
  basis: SiaBasisApi,
  revision: Type.Integer(),
  windowStart: IsoDateSchema,
  /** The date of death (the window is `[death - 6, death]`). */
  windowEnd: IsoDateSchema,
  paidUnits: NullableInteger,
  eligibleUnits: NullableInteger,
  truncatedUnits: NullableInteger,
  /** The wage-adjusted CHC hourly rate the add-on was priced with: units x rate / 4. */
  chcHourlyRateCents: Type.Union([CentsSchema, Type.Null()]),
  wageIndexFiscalYear: NullableInteger,
  amountCents: CentsSchema,
  /** Documented minutes of the counted visits (clinical time, before rounding and the daily cap). */
  totalQualifyingMinutes: Type.Integer(),
  calculatedAt: IsoDateTimeSchema,
  policy: Type.Union([SiaPolicyView, Type.Null()]),
  visits: Type.Array(SiaVisitView),
  priorClaimAdvisory: Type.Union([SiaPriorClaimAdvisoryView, Type.Null()]),
});
export type SiaView = Static<typeof SiaView>;

/** route #12: a dispatch attempt (`claim_submission`). */
export const SubmissionView = Type.Object({
  submissionId: Uuid,
  kind: SubmissionKindApi,
  outcome: SubmissionOutcomeApi,
  controlNumber: Type.String(),
  payerControlNumber: Type.Union([Type.String(), Type.Null()]),
  attemptIndex: Type.Integer(),
  submittedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  createdAt: IsoDateTimeSchema,
});
export type SubmissionView = Static<typeof SubmissionView>;

/** route #13: a 999/277CA/835 acknowledgment (`claim_acknowledgment`). */
export const AcknowledgmentView = Type.Object({
  acknowledgmentId: Uuid,
  submissionId: Uuid,
  kind: AcknowledgmentKindApi,
  accepted: Type.Boolean(),
  /** PHI-free MAC status/reason codes (e.g. CSCC/CSC pairs); never free-text PHI. */
  statusCodes: Type.Array(Type.String()),
  receivedAt: IsoDateTimeSchema,
});
export type AcknowledgmentView = Static<typeof AcknowledgmentView>;

/** A latest-validation-run summary embedded in claim detail. */
export const ValidationRunSummaryView = Type.Object({
  validationRunId: Uuid,
  trigger: ValidationRunTriggerApi,
  outcome: ValidationRunOutcomeApi,
  errorCount: Type.Integer(),
  warnCount: Type.Integer(),
  overrideRequiredCount: Type.Integer(),
  ranAt: IsoDateTimeSchema,
});
export type ValidationRunSummaryView = Static<typeof ValidationRunSummaryView>;

// ── route #3: GET /claims/:id (detail) ──────────────────────────────────────────────────────────────────
// The detail body is the backend's `ClaimDetailView` (read-service.ts), published through the OpenAPI enrichment; its
// `pricing.sia` IS `SiaView` above. There is no second TypeBox copy of the whole detail here to drift from it.

// ── route #11: GET /claims/:id/state-history ────────────────────────────────────────────────────────────
export const StateHistoryEntryView = Type.Object({
  fromState: Type.Union([ClaimStateApi, Type.Null()]),
  toState: ClaimStateApi,
  event: Type.String(),
  actorMembershipId: Type.Union([Uuid, Type.Null()]),
  occurredAt: IsoDateTimeSchema,
  note: Type.Union([Type.String(), Type.Null()]),
});
export type StateHistoryEntryView = Static<typeof StateHistoryEntryView>;

export const ClaimStateHistoryResponse = Type.Object({
  claimId: Uuid,
  entries: Type.Array(StateHistoryEntryView),
});
export type ClaimStateHistoryResponse = Static<typeof ClaimStateHistoryResponse>;

// ── collection responses for #10 / #12 / #13 ────────────────────────────────────────────────────────────
export const ClaimLinesResponse = Type.Object({ claimId: Uuid, lines: Type.Array(ClaimLineView) });
export type ClaimLinesResponse = Static<typeof ClaimLinesResponse>;

export const ClaimSubmissionsResponse = Type.Object({
  claimId: Uuid,
  submissions: Type.Array(SubmissionView),
});
export type ClaimSubmissionsResponse = Static<typeof ClaimSubmissionsResponse>;

export const ClaimAcknowledgmentsResponse = Type.Object({
  claimId: Uuid,
  acknowledgments: Type.Array(AcknowledgmentView),
});
export type ClaimAcknowledgmentsResponse = Static<typeof ClaimAcknowledgmentsResponse>;
