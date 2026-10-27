// apps/backend/src/modules/06-admission/routes/discharge-worklist-typebox.ts — the wire schemas of the end-of-episode
// worklist (`GET /api/v1/discharges/worklist`), the read behind the web "Discharge / transfer" hub. One bucket per
// call, cursor-paginated like the admission census. Patient demographics are NOT carried (M5 owns them; the hub
// resolves names for the rows it shows) — EXCEPT the `recently_discharged` rows, which carry the name and MRN read
// through M5's org-scoped PatientIntakeResolver seam: a readmission candidate's caseload assignment has ended, so the
// caller usually cannot open the chart, yet must know WHOM they are readmitting.
import { type Static, Type } from "@sinclair/typebox";

export const DISCHARGE_WORKLIST_BUCKETS = [
  "ready",
  "needs_details",
  "awaiting_cosign",
  "recently_discharged",
  // Milestone 10a — open BFCC-QIO expedited reviews, and active NOMNC records with no appeal-request deadline typed.
  "qio_review_open",
  "nomnc_no_deadline",
] as const;

/** The "recently discharged" look-back (days since the discharge was recorded). */
export const RECENTLY_DISCHARGED_DAYS = 90;
export type DischargeWorklistBucket = (typeof DISCHARGE_WORKLIST_BUCKETS)[number];

export const DischargeWorklistQuerySchema = Type.Object({
  bucket: Type.Union(
    DISCHARGE_WORKLIST_BUCKETS.map((b) => Type.Literal(b)),
    {
      description:
        '"ready": active / on-hold admissions with no discharge on file (a discharge, transfer-out, revocation or ' +
        'death can be recorded). "needs_details": discharged / bereavement admissions whose stay-ending record lacks ' +
        'the place of death or the receiving care setting the final claim needs. "awaiting_cosign": for-cause ' +
        "discharges waiting for the medical director's cosign (requires discharge.cosign_for_cause). " +
        '"recently_discharged": live discharges, revocations and transfers-out of the last 90 days (never deaths) ' +
        "whose patient has no later admission — the readmission candidates. " +
        '"qio_review_open": admissions with an open QIO expedited review, soonest typed deadline first (requires nomnc.read). ' +
        '"nomnc_no_deadline": active NOMNC records with no appeal-request deadline typed yet (requires nomnc.read).',
    },
  ),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export type DischargeWorklistQuery = Static<typeof DischargeWorklistQuerySchema>;

const Nullable = <T extends ReturnType<typeof Type.String>>(s: T) => Type.Union([s, Type.Null()]);

export const DischargeWorklistItemSchema = Type.Object({
  admissionId: Type.String(),
  patientId: Type.String(),
  admissionState: Type.String(),
  admissionAt: Nullable(Type.String({ format: "date-time" })),
  dischargedAt: Nullable(Type.String({ format: "date-time" })),
  missing: Type.Union(
    [Type.Literal("place_of_death"), Type.Literal("receiving_care_setting"), Type.Null()],
    { description: "needs_details only: the claim detail the stay-ending record lacks." },
  ),
  dischargeEventId: Nullable(Type.String()),
  transferEventId: Nullable(Type.String()),
  dischargeType: Nullable(Type.String()),
  effectiveDate: Nullable(
    Type.String({
      format: "date",
      description: "The discharge / transfer effective date (needs_details, awaiting_cosign).",
    }),
  ),
  nextDeadlineAt: Type.Optional(
    Nullable(
      Type.String({
        format: "date-time",
        description:
          "qio_review_open only: the soonest unsatisfied typed deadline; null = none typed.",
      }),
    ),
  ),
  noticeDeliveredAt: Type.Optional(
    Nullable(
      Type.String({
        format: "date-time",
        description: "nomnc_no_deadline only: when the notice was delivered, as typed.",
      }),
    ),
  ),
  patient: Type.Optional(
    Type.Union(
      [
        Type.Object({
          firstName: Type.String(),
          lastName: Type.String(),
          mrn: Type.String(),
        }),
        Type.Null(),
      ],
      {
        description:
          "recently_discharged only: the patient's name and MRN (M5's org-scoped read); null when M5 cannot resolve it.",
      },
    ),
  ),
});
export type DischargeWorklistItem = Static<typeof DischargeWorklistItemSchema>;

export const DischargeWorklistResponseSchema = Type.Object({
  items: Type.Array(DischargeWorklistItemSchema),
  nextCursor: Nullable(Type.String()),
});
export type DischargeWorklistPage = Static<typeof DischargeWorklistResponseSchema>;
