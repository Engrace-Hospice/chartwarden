// apps/backend/src/modules/23-billing-medicare/routes/clearinghouse-attempt-typebox.ts — request / response shapes of
// the clearinghouse attempt resolution route. Named `*-typebox` for the same table-ownership-heuristic reason as
// `billing-typebox.ts`. The OpenAPI enrichment reuses the SAME exports. No PHI: keys and control numbers are ours,
// the vendor id is opaque.
import { type Static, Type } from "@sinclair/typebox";

const USAGE = Type.Union([Type.Literal("test"), Type.Literal("production")]);
const COMMON = {
  providerEntityId: Type.String({ format: "uuid" }),
  usage: USAGE,
  idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9_.:-]{1,128}$" }),
  // The operator's attestation that they checked the vendor's own records. It is a required literal so a request
  // cannot be sent by accident; the decision itself is audited with the operator's id.
  confirmedAtVendor: Type.Literal(true),
};

export const ResolveStaleAttemptBodySchema = Type.Union([
  Type.Object({
    ...COMMON,
    outcome: Type.Literal("sent"),
    clearinghouseSubmissionId: Type.String({ pattern: "^[A-Za-z0-9_.:-]{1,200}$" }),
  }),
  Type.Object({ ...COMMON, outcome: Type.Literal("not_filed") }),
]);
export type ResolveStaleAttemptBody = Static<typeof ResolveStaleAttemptBodySchema>;

export const ResolvedAttemptSchema = Type.Object({
  idempotencyKey: Type.String(),
  controlNumber: Type.String(),
  status: Type.Union([Type.Literal("sent"), Type.Literal("voided")]),
  clearinghouseSubmissionId: Type.Union([Type.String(), Type.Null()]),
});
