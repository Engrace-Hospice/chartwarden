// @chartwarden/billing — sequestration-policy schemas: route #32 `GET /sequestration-policy` (effective-dated
// timeline) and route #33 `POST /sequestration-policy` (forward-date a new policy row) — §4.1.
//
// `percentage` is a decimal STRING (D11; never a float — `applySequestration` in domain/money.ts consumes
// it verbatim). The DB CHECK forbids a non-forward-dated active row except the seeded baseline.
import { type Static, Type } from "@sinclair/typebox";
import { DecimalString, IsoDateSchema, IsoDateTimeSchema, Uuid } from "./common";

// ── route #33: forward-date a new policy ────────────────────────────────────────────────────────────────
export const SequestrationPolicyCreateRequest = Type.Object({
  providerEntityId: Uuid,
  /** Decimal string, e.g. "2.00" (the Medicare 2% sequestration). */
  percentage: DecimalString,
  /** Must be strictly forward-dated (DB CHECK `effective_from > CURRENT_DATE`) unless closing a row. */
  effectiveFrom: IsoDateSchema,
  setReason: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type SequestrationPolicyCreateRequest = Static<typeof SequestrationPolicyCreateRequest>;

export const SequestrationPolicyView = Type.Object({
  id: Uuid,
  providerEntityId: Uuid,
  percentage: DecimalString,
  effectiveFrom: IsoDateSchema,
  effectiveTo: Type.Union([IsoDateSchema, Type.Null()]),
  setByMembershipId: Uuid,
  setReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoDateTimeSchema,
});
export type SequestrationPolicyView = Static<typeof SequestrationPolicyView>;

export const SequestrationPolicyCreateResponse = SequestrationPolicyView;
export type SequestrationPolicyCreateResponse = Static<typeof SequestrationPolicyCreateResponse>;

// ── route #32: the effective-dated timeline ─────────────────────────────────────────────────────────────
export const SequestrationPolicyListQuery = Type.Object({
  providerEntityId: Type.Optional(Uuid),
});
export type SequestrationPolicyListQuery = Static<typeof SequestrationPolicyListQuery>;

export const SequestrationPolicyListResponse = Type.Object({
  policies: Type.Array(SequestrationPolicyView),
});
export type SequestrationPolicyListResponse = Static<typeof SequestrationPolicyListResponse>;

// Errors (per §4.2 patterns):
//   422 NON_FORWARD_DATED — effectiveFrom is not strictly in the future (DB CHECK)
