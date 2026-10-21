// apps/backend/src/modules/23-billing-medicare/routes/sequestration-policy-typebox.ts — M23 sequestration-policy
// request/response TypeBox shapes (F-212). Named `*-typebox` for the same table-ownership-heuristic reason as
// `billing-typebox.ts`. `percentage` is a decimal STRING on the wire (D11, never a float); the plausibility band and the
// effective window are validated by `validateSequestrationPolicyEntry` (@chartwarden/billing) so the error names every problem.
// Org / actor / membership binding is server-side — no body field carries an org id or the entering membership.
import { type Static, Type } from "@sinclair/typebox";
import { parse } from "./billing-typebox";

const uuid = () => Type.String({ format: "uuid" });
const isoDate = () => Type.String({ format: "date" });

const PolicyFields = {
  /** Decimal string in [0, 2], e.g. "2.00". Anything other than exactly 2 requires `setReason`. */
  percentage: Type.String({ pattern: "^\\d+(\\.\\d+)?$", maxLength: 12 }),
  effectiveFrom: isoDate(),
  /** Omitted = open-ended (the current schedule; entering a later open-ended row closes it automatically). */
  effectiveTo: Type.Optional(isoDate()),
  setReason: Type.Optional(Type.String({ maxLength: 2000 })),
};

export const CreateSequestrationPolicyBodySchema = Type.Object({
  providerEntityId: uuid(),
  ...PolicyFields,
});
export type CreateSequestrationPolicyBody = Static<typeof CreateSequestrationPolicyBodySchema>;

export const SupersedeSequestrationPolicyBodySchema = Type.Object({
  /** Scopes the row for the §4.7 provider-entity check; must match the row being superseded. */
  providerEntityId: uuid(),
  ...PolicyFields,
});
export type SupersedeSequestrationPolicyBody = Static<
  typeof SupersedeSequestrationPolicyBodySchema
>;

export const SequestrationPolicyIdParamsSchema = Type.Object({ id: uuid() });
export const SequestrationPolicyListQuerySchema = Type.Object({
  providerEntityId: uuid(),
  includeSuperseded: Type.Optional(Type.Boolean()),
});
export const SequestrationPolicyGetQuerySchema = Type.Object({ providerEntityId: uuid() });
export const SequestrationPolicyEffectiveQuerySchema = Type.Object({
  providerEntityId: uuid(),
  onDate: isoDate(),
});

export const SequestrationPolicyViewSchema = Type.Object({
  policyId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  percentage: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  setByMembershipId: Type.String(),
  setReason: Type.Union([Type.String(), Type.Null()]),
  supersededAt: Type.Union([Type.String(), Type.Null()]),
  supersededById: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type SequestrationPolicyView = Static<typeof SequestrationPolicyViewSchema>;

export const SequestrationPolicyListResponseSchema = Type.Object({
  policies: Type.Array(SequestrationPolicyViewSchema),
});
export const SequestrationPolicyNullableResponseSchema = Type.Union([
  SequestrationPolicyViewSchema,
  Type.Null(),
]);

export { parse };
