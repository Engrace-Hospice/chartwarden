// apps/backend/src/modules/41-billing-commercial/routes/commercial-typebox.ts — M41 request/response schemas (issue #722).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import for a Drizzle one.
// Org / actor / membership binding is ALWAYS server-side (request.context): no body or query carries an org id or an acting
// membership id. Responses carry ids, dates, codes, money and rule messages only - never a member id, MBI or authorization number.
import {
  COMMERCIAL_AUTHORIZATION_STATUS_VALUES,
  COMMERCIAL_HOSPICE_LEVEL_OF_CARE_VALUES,
  COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH,
} from "@chartwarden/types";
import { type Static, Type } from "@sinclair/typebox";

// FormatRegistry entries (uuid, date) are registered by the shared M23 `parse` helper module imported by the routes.
const uuid = () => Type.String({ format: "uuid" });
const isoDate = () => Type.String({ format: "date" });
const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

export const IdParamsSchema = Type.Object({ id: uuid() }, { additionalProperties: false });
export const OverrideParamsSchema = Type.Object(
  { id: uuid(), resultId: uuid() },
  { additionalProperties: false },
);

export const AssembleCommercialClaimBodySchema = Type.Object(
  {
    providerEntityId: uuid(),
    patientId: uuid(),
    serviceFrom: isoDate(),
    serviceTo: isoDate(),
    planId: Type.Optional(uuid()),
    clearinghouseKey: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,39}$" })),
  },
  { additionalProperties: false },
);

export const OverrideBodySchema = Type.Object(
  { reason: Type.String({ minLength: COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH, maxLength: 2000 }) },
  { additionalProperties: false },
);

export const RecordAuthorizationBodySchema = Type.Object(
  {
    providerEntityId: uuid(),
    patientId: uuid(),
    planId: uuid(),
    authorizationNumber: Type.String({ pattern: "^[A-Za-z0-9._-]{1,50}$" }),
    levelOfCare: Type.Optional(
      Type.Union([lit(COMMERCIAL_HOSPICE_LEVEL_OF_CARE_VALUES), Type.Null()]),
    ),
    obtainedOn: isoDate(),
    effectiveFrom: isoDate(),
    effectiveTo: Type.Optional(Type.Union([isoDate(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const SetAuthorizationStatusBodySchema = Type.Object(
  { status: lit(COMMERCIAL_AUTHORIZATION_STATUS_VALUES.filter((s) => s !== "approved")) },
  { additionalProperties: false },
);

export const AuthorizationListQuerySchema = Type.Object(
  { providerEntityId: uuid(), patientId: uuid() },
  { additionalProperties: false },
);

// ── responses ────────────────────────────────────────────────────────────────────────────────────────────────────

export const ValidationResultViewSchema = Type.Object({
  id: Type.String(),
  ruleKey: Type.String(),
  severity: Type.String(),
  outcome: Type.String(),
  overridable: Type.Boolean(),
  overridden: Type.Boolean(),
  blocking: Type.Boolean(),
  message: Type.String(),
});

export const ValidationRunViewSchema = Type.Object({
  runId: Type.String(),
  outcome: Type.String(),
  results: Type.Array(ValidationResultViewSchema),
});

export const AssembleCommercialClaimResponseSchema = Type.Object({
  claimId: Type.String(),
  state: Type.String(),
  tob: Type.String(),
  totalChargeCents: Type.Integer(),
  expectedPaymentCents: Type.Union([Type.Integer(), Type.Null()]),
  lineCount: Type.Integer(),
  secondaryPayerKind: Type.Union([Type.String(), Type.Null()]),
  validation: ValidationRunViewSchema,
});

export const CommercialClaimLineViewSchema = Type.Object({
  lineNumber: Type.Integer(),
  levelOfCare: Type.String(),
  revenueCode: Type.String(),
  hcpcsCode: Type.Union([Type.String(), Type.Null()]),
  serviceFrom: Type.String(),
  serviceTo: Type.String(),
  units: Type.Integer(),
  unitRateCents: Type.Union([Type.Integer(), Type.Null()]),
  lineChargeCents: Type.Integer(),
});

export const CommercialClaimViewSchema = Type.Object({
  claim: Type.Object({
    id: Type.String(),
    state: Type.String(),
    patientId: Type.String(),
    providerEntityId: Type.String(),
    planId: Type.String(),
    tob: Type.String(),
    serviceFrom: Type.String(),
    serviceTo: Type.String(),
    claimFilingIndicator: Type.String(),
    secondaryPayerKind: Type.Union([Type.String(), Type.Null()]),
    totalChargeCents: Type.Integer(),
    expectedPaymentCents: Type.Union([Type.Integer(), Type.Null()]),
    readyAt: Type.Union([Type.String(), Type.Null()]),
  }),
  lines: Type.Array(CommercialClaimLineViewSchema),
  validation: Type.Union([ValidationRunViewSchema, Type.Null()]),
});

export const ReadyResponseSchema = Type.Object({
  claimId: Type.String(),
  state: Type.String(),
  validation: ValidationRunViewSchema,
});

export const VoidResponseSchema = Type.Object({ claimId: Type.String(), state: Type.String() });

export const OverrideResponseSchema = Type.Object({
  overrideId: Type.String(),
  auditEventId: Type.String(),
  ruleKey: Type.String(),
});

export const AuthorizationViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  planId: Type.String(),
  levelOfCare: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  obtainedOn: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
});

export const AuthorizationListResponseSchema = Type.Object({
  items: Type.Array(AuthorizationViewSchema),
});

export type AssembleCommercialClaimBody = Static<typeof AssembleCommercialClaimBodySchema>;
export type RecordAuthorizationBody = Static<typeof RecordAuthorizationBodySchema>;
