// @wardenx/billing — internal service-to-service seam HTTP endpoints (system_principal):
// route #39 `GET /api/v1/internal/billing/claim-day-projection` (ClaimDayProjectionProvider; M26/M27),
// route #40 `GET /api/v1/internal/billing/submissions` (ClaimSubmissionReader.acceptedSubmissionsInWindow;
// M25) — §4.1. Aggregate / id-keyed; no PHI. These mirror the published seam DTOs verbatim.
import { type Static, Type } from "@sinclair/typebox";
import { IsoDateSchema, IsoDateTimeSchema, LevelOfCareApi, Uuid } from "./common";

// ── route #39: claim-day projection ─────────────────────────────────────────────────────────────────────
/** The projection mode selects which seam method backs the response. */
export const ClaimDayProjectionQuery = Type.Object({
  organizationId: Uuid,
  mode: Type.Union([
    Type.Literal("patient_cap_year"), // daysForPatientInCapYear
    Type.Literal("org_cap_year"), // aggregateForOrgInCapYear
    Type.Literal("org_fiscal_year"), // aggregateForOrgInFiscalYear
    Type.Literal("loc_fiscal_year"), // daysAtLevelOfCareInFiscalYear
  ]),
  patientId: Type.Optional(Uuid),
  providerEntityId: Type.Optional(Uuid),
  /** Cap year = starting calendar year (Nov 1 – Oct 31); required for the cap-year modes. */
  capYear: Type.Optional(Type.Integer()),
  /** FY-end calendar date; required for the fiscal-year modes. */
  fyEnd: Type.Optional(IsoDateSchema),
});
export type ClaimDayProjectionQuery = Static<typeof ClaimDayProjectionQuery>;

/** Per-LOC day rollup (mirrors `DaysByLevelOfCareDto`). */
export const DaysByLevelOfCareView = Type.Object({
  routineHomeCareDays: Type.Integer({ minimum: 0 }),
  continuousHomeCareDays: Type.Integer({ minimum: 0 }),
  inpatientRespiteCareDays: Type.Integer({ minimum: 0 }),
  generalInpatientCareDays: Type.Integer({ minimum: 0 }),
  totalDays: Type.Integer({ minimum: 0 }),
});
export type DaysByLevelOfCareView = Static<typeof DaysByLevelOfCareView>;

/** Org-wide cap-year accrual (mirrors `OrgCapAccrualDto`). */
export const OrgCapAccrualView = Type.Object({
  providerEntityId: Uuid,
  capYear: Type.Integer(),
  totalDays: Type.Integer({ minimum: 0 }),
  inpatientDays: Type.Integer({ minimum: 0 }),
});
export type OrgCapAccrualView = Static<typeof OrgCapAccrualView>;

/** Org FY statistics (mirrors `OrgFyDaysDto`). */
export const OrgFyDaysView = Type.Object({
  providerEntityId: Uuid,
  fyEnd: IsoDateSchema,
  totalDays: Type.Integer({ minimum: 0 }),
  unduplicatedPatientCount: Type.Integer({ minimum: 0 }),
});
export type OrgFyDaysView = Static<typeof OrgFyDaysView>;

/** A union response — the populated branch matches the request `mode`. */
export const ClaimDayProjectionResponse = Type.Union([
  DaysByLevelOfCareView,
  OrgCapAccrualView,
  OrgFyDaysView,
]);
export type ClaimDayProjectionResponse = Static<typeof ClaimDayProjectionResponse>;

// ── route #40: accepted submissions in a window ─────────────────────────────────────────────────────────
export const AcceptedSubmissionsQuery = Type.Object({
  organizationId: Uuid,
  providerEntityId: Uuid,
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
});
export type AcceptedSubmissionsQuery = Static<typeof AcceptedSubmissionsQuery>;

/** One accepted submission (mirrors `AcceptedSubmissionDto`). */
export const AcceptedSubmissionView = Type.Object({
  submissionId: Uuid,
  claimId: Uuid,
  claimControlNumber: Type.String(),
  acceptedAt: IsoDateTimeSchema,
  payerClaimControlNumber: Type.Union([Type.String(), Type.Null()]),
});
export type AcceptedSubmissionView = Static<typeof AcceptedSubmissionView>;

export const AcceptedSubmissionsResponse = Type.Object({
  submissions: Type.Array(AcceptedSubmissionView),
});
export type AcceptedSubmissionsResponse = Static<typeof AcceptedSubmissionsResponse>;
