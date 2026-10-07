// apps/backend/src/modules/06-admission/routes/readmission-typebox.ts — the wire schemas of the benefit-period plan a
// NEW admission is created against (readmission workflow):
//
//   GET /api/v1/admissions/:id/readmission-context      the plan for readmitting a live-discharged admission
//   GET /api/v1/patients/:patientId/benefit-period-plan  the same plan for any new admission of the patient
//
// Both return a `BenefitPeriodPlan`: our own history's suggested benefit period, the requirements of the chosen
// period, the two-tier RHC carry-over and whether the prior election is closed out (NOTR / final claim) so a new NOE
// can be filed. Patient demographics are NOT carried (M5 owns them).
import { type Static, Type } from "@sinclair/typebox";

export const BenefitPeriodPlanQuerySchema = Type.Object({
  sequence: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      description: "Compute the requirements for this benefit period instead of the suggested one.",
    }),
  ),
  startDate: Type.Optional(
    Type.String({
      format: "date",
      description: "The planned admission / election date (default: today, org-local).",
    }),
  ),
});
export type BenefitPeriodPlanQuery = Static<typeof BenefitPeriodPlanQuerySchema>;

const NullableString = (opts: Parameters<typeof Type.String>[0] = {}) =>
  Type.Union([Type.String(opts), Type.Null()]);
const NullableInt = () => Type.Union([Type.Integer(), Type.Null()]);
const NullableBool = () => Type.Union([Type.Boolean(), Type.Null()]);

const END_KINDS = ["live_discharge", "revocation", "transfer_out", "death", "unknown"] as const;
const BASES = [
  "no_history",
  "next_after_live_discharge",
  "next_after_revocation",
  "same_after_transfer",
  "next_after_unknown_end",
] as const;
export const READMISSION_BLOCKERS = [
  "NOT_ENDED",
  "ENDED_BY_DEATH",
  "OPEN_ADMISSION_EXISTS",
  "NEWER_ADMISSION_EXISTS",
] as const;
export type ReadmissionBlocker = (typeof READMISSION_BLOCKERS)[number];

export const BenefitPeriodPlanSchema = Type.Object({
  patientId: Type.String(),
  /** The admission being readmitted from (readmission-context), else the latest earlier stay (patient plan). */
  previous: Type.Union([
    Type.Object({
      admissionId: Type.String(),
      admissionState: Type.String(),
      startedOn: NullableString({ format: "date" }),
      endedOn: NullableString({ format: "date" }),
      endKind: Type.Union(END_KINDS.map((k) => Type.Literal(k))),
      dischargeType: NullableString(),
      transfer: Type.Boolean({
        description: "Ended by a transfer to another hospice (status 50/51).",
      }),
      lastSequence: NullableInt(),
      daysSinceDischarge: NullableInt(),
    }),
    Type.Null(),
  ]),
  readmission: Type.Object({
    eligible: Type.Boolean(),
    blockers: Type.Array(Type.Union(READMISSION_BLOCKERS.map((b) => Type.Literal(b)))),
  }),
  priorElectionClosure: Type.Union([
    Type.Object({
      admissionId: Type.String(),
      status: Type.Union([
        Type.Literal("filed"),
        Type.Literal("not_filed"),
        Type.Literal("unknown"),
      ]),
      notrFiled: NullableBool(),
      finalClaimFiled: NullableBool(),
    }),
    Type.Null(),
  ]),
  noeBlocked: Type.Boolean({
    description:
      "True while the prior election has no NOTR (8xB) or final claim on file — Medicare rejects a new NOE (8xA) " +
      "until it does (Claims Processing Manual ch. 11 §20.1.6). The admission itself is not blocked.",
  }),
  suggestion: Type.Object({
    suggestedSequence: Type.Integer({ minimum: 1 }),
    basis: Type.Union(BASES.map((b) => Type.Literal(b))),
    fromAdmissionId: NullableString(),
    lastKnownSequence: NullableInt(),
  }),
  requirements: Type.Object({
    sequence: Type.Integer({ minimum: 1 }),
    periodKind: Type.Union([Type.Literal("ninety_day"), Type.Literal("sixty_day")]),
    lengthDays: Type.Integer(),
    startDate: Type.String({ format: "date" }),
    endDate: Type.String({ format: "date" }),
    certification: Type.Object({
      hospicePhysician: Type.Literal(true),
      attendingIfDesignated: Type.Boolean(),
    }),
    faceToFace: Type.Object({
      required: Type.Boolean(),
      windowStart: NullableString({ format: "date" }),
      windowEnd: NullableString({ format: "date" }),
      exceptionWindowEnd: NullableString({ format: "date" }),
    }),
    electionStatementRequired: Type.Literal(true),
    noeDueBy: Type.String({ format: "date" }),
    initialAssessmentDueBy: Type.String({ format: "date" }),
    comprehensiveAssessmentDueBy: Type.String({ format: "date" }),
    hopeAdmissionA0220: Type.String({ format: "date" }),
  }),
  rhc: Type.Object({
    applies: Type.Boolean(),
    daysSinceDischarge: NullableInt(),
    priorHospiceDays: Type.Integer({ minimum: 0 }),
    startsAtDay: Type.Integer({ minimum: 1 }),
    highRateDaysRemaining: Type.Integer({ minimum: 0 }),
  }),
});
export type BenefitPeriodPlan = Static<typeof BenefitPeriodPlanSchema>;
