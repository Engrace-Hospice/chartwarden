// apps/backend/src/modules/05-patient/routes/allergy-typebox.ts — the TypeBox contract of the M5 allergy-list
// routes (F-238). The list is read by every chart surface that shows allergies — including the prescriber's
// — and an UNVERIFIED row is returned (and must be drawn) with its status, never filtered out.
import { Type } from "@sinclair/typebox";

export const AllergyParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  allergyId: Type.String({ format: "uuid" }),
});

const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);
const Severity = Type.Union([
  Type.Literal("mild"),
  Type.Literal("moderate"),
  Type.Literal("severe"),
  Type.Literal("unknown"),
]);

export const PatientAllergyViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  /** The allergy as recorded — for a DocLens row, the referral-fax line verbatim. */
  allergenText: Type.String(),
  reaction: Nullable(Type.String()),
  severity: Type.Union([Severity, Type.Null()]),
  verificationStatus: Type.Union([
    Type.Literal("unverified"),
    Type.Literal("verified"),
    Type.Literal("entered_in_error"),
  ]),
  source: Type.Union([Type.Literal("intake_extraction"), Type.Literal("clinician_entry")]),
  sourceDocumentId: Nullable(Type.String()),
  sourcePage: Type.Union([Type.Integer(), Type.Null()]),
  reportedByMembershipId: Type.String(),
  reportedAt: Type.String({ format: "date-time" }),
  verifiedByMembershipId: Nullable(Type.String()),
  verifiedAt: Nullable(Type.String({ format: "date-time" })),
  enteredInErrorAt: Nullable(Type.String({ format: "date-time" })),
});

export const PatientAllergyListResponseSchema = Type.Object({
  allergies: Type.Array(PatientAllergyViewSchema),
});

/** Verify: the clinician confirms the allergy; may record the reaction / severity they confirmed. */
export const VerifyAllergyBodySchema = Type.Object({
  reaction: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  severity: Type.Optional(Severity),
});

/** Entered-in-error: the clinician retires a wrong entry; the reason is required (survey trail). */
export const EnteredInErrorAllergyBodySchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
