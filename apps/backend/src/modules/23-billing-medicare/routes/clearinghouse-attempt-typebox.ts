// apps/backend/src/modules/23-billing-medicare/routes/clearinghouse-attempt-typebox.ts — request / response shapes of
// the clearinghouse attempt resolution route. Named `*-typebox` for the same table-ownership-heuristic reason as
// `billing-typebox.ts`. The OpenAPI enrichment reuses the SAME exports. No PHI: keys and control numbers are ours,
// the vendor id is opaque.
import { type Static, Type } from "@sinclair/typebox";

const USAGE = Type.Union([Type.Literal("test"), Type.Literal("production")]);

export const ResolveStaleAttemptBodySchema = Type.Union([
  Type.Object({
    providerEntityId: Type.String({ format: "uuid" }),
    usage: USAGE,
    idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9_.:-]{1,128}$" }),
    outcome: Type.Literal("sent"),
    clearinghouseSubmissionId: Type.String({ minLength: 1, maxLength: 200 }),
  }),
  Type.Object({
    providerEntityId: Type.String({ format: "uuid" }),
    usage: USAGE,
    idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9_.:-]{1,128}$" }),
    outcome: Type.Literal("released"),
  }),
]);
export type ResolveStaleAttemptBody = Static<typeof ResolveStaleAttemptBodySchema>;

export const ResolvedAttemptSchema = Type.Object({
  idempotencyKey: Type.String(),
  controlNumber: Type.String(),
  status: Type.Union([Type.Literal("sent"), Type.Literal("released")]),
  clearinghouseSubmissionId: Type.Union([Type.String(), Type.Null()]),
});
