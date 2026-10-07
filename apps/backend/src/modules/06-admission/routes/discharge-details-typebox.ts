// apps/backend/src/modules/06-admission/routes/discharge-details-typebox.ts — the wire schemas of the
// after-the-fact discharge-details routes (place of death on a death discharge, receiving care setting on a
// transfer-out). Field descriptions are written for integrators: they name the values and the claim effect.
import { type Static, Type } from "@sinclair/typebox";
import { DETAIL_CORRECTION_REASON_MAX, DETAIL_CORRECTION_REASON_MIN } from "../discharge";
import { Version } from "./admission-typebox";

const CorrectionReason = () =>
  Type.Optional(
    Type.String({
      minLength: DETAIL_CORRECTION_REASON_MIN,
      maxLength: DETAIL_CORRECTION_REASON_MAX,
      description: `Required only when a DIFFERENT value is already recorded (a correction): why it is being changed, ${DETAIL_CORRECTION_REASON_MIN}–${DETAIL_CORRECTION_REASON_MAX} characters. Stored beside the value and captured by the audit trail. Ignored when the value was never recorded.`,
    }),
  );

const IfVersion = () => Version();

export const PlaceOfDeathValueSchema = Type.Union(
  [Type.Literal("home"), Type.Literal("facility"), Type.Literal("unknown")],
  {
    description:
      'Where the patient died: "home" (claim patient status 40, expired at home), "facility" (41, expired ' +
      'in a medical facility) or "unknown" (42, expired, place unknown) — CMS Pub. 100-04 Ch. 11 §30.3.',
  },
);

export const ReceivingCareSettingValueSchema = Type.Union(
  [Type.Literal("home"), Type.Literal("facility")],
  {
    description:
      'Where the RECEIVING hospice cares for the patient: "home" (claim patient status 50, discharged to ' +
      'hospice, home) or "facility" (51, discharged to hospice, medical facility) — CMS Pub. 100-04 Ch. 11 §30.3.',
  },
);

/** POST /api/v1/discharges/:id/place-of-death */
export const PlaceOfDeathRecordSchema = Type.Object({
  placeOfDeath: PlaceOfDeathValueSchema,
  ifVersion: IfVersion(),
  correctionReason: CorrectionReason(),
});
export type PlaceOfDeathRecordBody = Static<typeof PlaceOfDeathRecordSchema>;

/** POST /api/v1/transfers/:id/receiving-care-setting */
export const ReceivingCareSettingRecordSchema = Type.Object({
  receivingCareSetting: ReceivingCareSettingValueSchema,
  ifVersion: IfVersion(),
  correctionReason: CorrectionReason(),
});
export type ReceivingCareSettingRecordBody = Static<typeof ReceivingCareSettingRecordSchema>;

const Nullable = <T extends ReturnType<typeof Type.String>>(s: T) => Type.Union([s, Type.Null()]);

/** The result of either record route. `changed: false` = the same value was already recorded (no-op). */
export const DischargeDetailRecordResultSchema = Type.Object({
  id: Type.String({ description: "The discharge_event or transfer_event id." }),
  admissionId: Type.String(),
  detail: Type.Union([Type.Literal("place_of_death"), Type.Literal("receiving_care_setting")]),
  value: Type.String(),
  previousValue: Nullable(Type.String()),
  changed: Type.Boolean(),
  version: Type.Integer({ minimum: 0 }),
  claimPatientStatus: Type.String({
    description: "The claim patient discharge status this value sets (40/41/42 or 50/51).",
  }),
});

/** GET /api/v1/admissions/:id/discharge-details */
export const DischargeDetailsViewSchema = Type.Object({
  admissionId: Type.String(),
  patientId: Type.String(),
  admissionState: Type.String(),
  discharge: Type.Union([
    Type.Object({
      dischargeEventId: Type.String(),
      reason: Type.String(),
      status: Type.String(),
      effectiveDate: Type.String({ format: "date" }),
      placeOfDeath: Type.Union([PlaceOfDeathValueSchema, Type.Null()]),
      placeOfDeathCorrectionReason: Nullable(Type.String()),
      version: Type.Integer({ minimum: 0 }),
    }),
    Type.Null(),
  ]),
  transferOut: Type.Union([
    Type.Object({
      transferEventId: Type.String(),
      effectiveDate: Type.String({ format: "date" }),
      receivingHospiceName: Nullable(Type.String()),
      receivingCareSetting: Type.Union([ReceivingCareSettingValueSchema, Type.Null()]),
      receivingCareSettingCorrectionReason: Nullable(Type.String()),
      version: Type.Integer({ minimum: 0 }),
    }),
    Type.Null(),
  ]),
  missing: Type.Union(
    [Type.Literal("place_of_death"), Type.Literal("receiving_care_setting"), Type.Null()],
    {
      description:
        "The claim-relevant detail the stay-ending event lacks (the final Medicare claim is blocked until it is " +
        "recorded), or null.",
    },
  ),
});
export type DischargeDetailsViewBody = Static<typeof DischargeDetailsViewSchema>;
