// apps/backend/src/modules/05-patient/routes/wristband-typebox.ts -- the TypeBox contract of the M5 patient
// wristband routes (GAP-020). Issuing returns the RAW printable payload exactly once; nothing else ever does.
import { Type } from "@sinclair/typebox";
import { WRISTBAND_ISSUE_REASONS, WRISTBAND_OPERATOR_VOID_REASONS } from "@wardenx/types";

/** A string-literal union typed as `T` (TypeBox cannot infer a union from a runtime array). */
const literals = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>(Type.Union(values.map((v) => Type.Literal(v))));

export const PatientIdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });

export const WristbandParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  generation: Type.Integer({ minimum: 1 }),
});

export const IssueWristbandBodySchema = Type.Object({
  reason: literals(WRISTBAND_ISSUE_REASONS),
  /**
   * The generation the caller saw as active (null = none yet). A stale value is a 409, which is what stops a
   * double-click or two nurses minting two live bands: this route cannot use an Idempotency-Key (it returns a
   * one-time secret), so this precondition is its double-submit protection.
   */
  expectedCurrentGeneration: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});

export const VoidWristbandBodySchema = Type.Object({
  reason: literals(WRISTBAND_OPERATOR_VOID_REASONS),
});

export const IssuedWristbandSchema = Type.Object({
  generation: Type.Integer(),
  /** The RAW payload (`WXB1.<base32>.<crc>`). Shown once; closing the print dialog requires a reprint. */
  payload: Type.String(),
  issuedAt: Type.String({ format: "date-time" }),
  label: Type.Object({ name: Type.String(), mrn: Type.String(), dob: Type.String() }),
});

export const WristbandStatusSchema = Type.Object({
  state: Type.Union([Type.Literal("none"), Type.Literal("active")]),
  generation: Type.Union([Type.Integer(), Type.Null()]),
  issuedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  /** True once any generation exists (voided included). Decides first_issue vs a reprint reason. */
  everIssued: Type.Boolean(),
});
