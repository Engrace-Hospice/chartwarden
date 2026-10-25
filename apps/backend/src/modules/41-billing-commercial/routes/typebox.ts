// apps/backend/src/modules/41-billing-commercial/routes/typebox.ts - request and response schemas for the eligibility and enrollment routes.
//
// Request bodies are strict (additionalProperties: false): a body that carries a `memberId`, or any other field, is refused. The
// API takes a patient and a plan and resolves the member id server side from M5's coverage, so no member id is ever on the wire.
// No response schema has a member-id field.
import {
  COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES,
  COMMERCIAL_ELIGIBILITY_STALENESS_POLICY_VALUES,
  COMMERCIAL_ENROLLMENT_STATUS_VALUES,
  MAX_ELIGIBILITY_MAX_AGE_DAYS,
  ValidationError,
} from "@chartwarden/types";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const KEY_PATTERN = "^[a-z0-9][a-z0-9_-]{0,39}$";
const EVIDENCE_PATTERN = "^[A-Za-z0-9._:/#-]{1,200}$";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const Day = Type.String({ pattern: DAY_PATTERN });
const lit = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));

/** Validate and coerce like every other module's `parse`: a miss is the standard 422 envelope, never an ajv 400. */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}

export const IdParamsSchema = Type.Object({ id: Uuid }, { additionalProperties: false });

export const CheckEligibilityBodySchema = Type.Object(
  {
    providerEntityId: Uuid,
    locationId: Type.Optional(Uuid),
    patientId: Uuid,
    planId: Uuid,
    serviceDate: Day,
  },
  { additionalProperties: false },
);

export const PatientPlanQuerySchema = Type.Object(
  { patientId: Uuid, planId: Type.Optional(Uuid) },
  { additionalProperties: false },
);
export const LatestQuerySchema = Type.Object(
  { patientId: Uuid, planId: Uuid },
  { additionalProperties: false },
);

export const FreshnessResponseSchema = Type.Object({
  ruleId: Type.String(),
  status: Type.String(),
  severity: Type.String(),
  message: Type.String(),
  evidence: Type.Object({
    ageDays: Type.Union([Type.Integer(), Type.Null()]),
    maxAgeDays: Type.Integer(),
    policy: lit(COMMERCIAL_ELIGIBILITY_STALENESS_POLICY_VALUES),
    outcome: Type.Union([lit(COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES), Type.Null()]),
    checkedAt: Type.Union([Type.String(), Type.Null()]),
  }),
});

const CheckFields = {
  id: Type.String(),
  providerEntityId: Type.String(),
  patientId: Type.String(),
  planId: Type.String(),
  clearinghouseKey: Type.String(),
  serviceDate: Type.String(),
  outcome: lit(COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES),
  asOfDate: Type.String(),
  requestId: Type.String(),
  checkedAt: Type.String(),
};

export const EligibilityCheckResponseSchema = Type.Object({
  ...CheckFields,
  replayed: Type.Boolean(),
  freshness: FreshnessResponseSchema,
});

export const EligibilityListResponseSchema = Type.Object({
  items: Type.Array(Type.Object(CheckFields)),
});

export const LatestEligibilityResponseSchema = Type.Object({
  latest: Type.Union([EligibilityCheckResponseSchema, Type.Null()]),
  freshness: FreshnessResponseSchema,
});

export const EligibilityPolicyBodySchema = Type.Object(
  {
    policy: lit(COMMERCIAL_ELIGIBILITY_STALENESS_POLICY_VALUES),
    maxAgeDays: Type.Integer({ minimum: 1, maximum: MAX_ELIGIBILITY_MAX_AGE_DAYS }),
  },
  { additionalProperties: false },
);
export const EligibilityPolicyResponseSchema = Type.Object({
  id: Type.String(),
  payerId: Type.String(),
  eligibilityStalenessPolicy: lit(COMMERCIAL_ELIGIBILITY_STALENESS_POLICY_VALUES),
  eligibilityMaxAgeDays: Type.Integer(),
});

export const EnrollmentListQuerySchema = Type.Object(
  { providerEntityId: Uuid, payerId: Type.Optional(Uuid) },
  { additionalProperties: false },
);
export const CreateEnrollmentBodySchema = Type.Object(
  {
    providerEntityId: Uuid,
    payerId: Uuid,
    clearinghouseKey: Type.String({ pattern: KEY_PATTERN }),
    status: lit(COMMERCIAL_ENROLLMENT_STATUS_VALUES),
    effectiveFrom: Day,
    effectiveTo: Type.Optional(Type.Union([Day, Type.Null()])),
    evidenceRef: Type.Optional(
      Type.Union([Type.String({ pattern: EVIDENCE_PATTERN }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export const PatchEnrollmentBodySchema = Type.Object(
  {
    providerEntityId: Uuid,
    status: Type.Optional(lit(COMMERCIAL_ENROLLMENT_STATUS_VALUES)),
    effectiveTo: Type.Optional(Type.Union([Day, Type.Null()])),
    evidenceRef: Type.Optional(
      Type.Union([Type.String({ pattern: EVIDENCE_PATTERN }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export const EnrollmentResponseSchema = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  payerId: Type.String(),
  clearinghouseKey: Type.String(),
  status: lit(COMMERCIAL_ENROLLMENT_STATUS_VALUES),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  evidenceRef: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export const EnrollmentListResponseSchema = Type.Object({
  items: Type.Array(EnrollmentResponseSchema),
});
