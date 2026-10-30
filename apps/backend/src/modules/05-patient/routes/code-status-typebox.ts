// apps/backend/src/modules/05-patient/routes/code-status-typebox.ts — the TypeBox contract of the M5 patient
// code-status routes (ADR-0104). `not_recorded` is deliberately not a value: it is no active entry.
import { PATIENT_CODE_STATUSES } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";

export const CodeStatusParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  entryId: Type.String({ format: "uuid" }),
});

const CodeStatusValue = Type.Union(PATIENT_CODE_STATUSES.map((v) => Type.Literal(v)));

export const CodeStatusViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  codeStatus: CodeStatusValue,
  reason: Type.String(),
  sourceDocumentId: Type.Union([Type.String(), Type.Null()]),
  recordedByMembershipId: Type.String(),
  recordedAt: Type.String({ format: "date-time" }),
  enteredInErrorAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});

export const CodeStatusListResponseSchema = Type.Object({
  current: Type.Union([CodeStatusViewSchema, Type.Null()]),
  history: Type.Array(CodeStatusViewSchema),
});

export const SetCodeStatusBodySchema = Type.Object({
  codeStatus: CodeStatusValue,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  /** The M22 directive document this decision rests on (validated: same patient, a code-status directive). */
  sourceDocumentId: Type.Optional(Type.String({ format: "uuid" })),
});

export const EnteredInErrorCodeStatusBodySchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
