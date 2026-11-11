// apps/backend/src/modules/23-billing-medicare/routes/npi-verification-typebox.ts — request/response shapes for the
// platform NPI-verification admin routes (ADR-0053 amendment precondition 2). Named `*-typebox` like its siblings.
import { type Static, Type } from "@sinclair/typebox";

export const NpiVerificationParamsSchema = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
});

export const VerifyNpiBodySchema = Type.Object({
  npi: Type.String({ pattern: "^[0-9]{10}$", description: "The NPI the operator checked." }),
  evidence: Type.String({
    minLength: 3,
    maxLength: 500,
    pattern: "\\S", // not whitespace-only: the service trims, and the DB CHECK refuses ''
    description: "How ownership was confirmed (for the audit record; no patient information).",
  }),
});
export type VerifyNpiBody = Static<typeof VerifyNpiBodySchema>;

const nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

export const NpiVerificationViewSchema = Type.Object({
  providerEntityId: Type.String(),
  organizationId: Type.String(),
  organizationName: Type.String(),
  legalName: Type.String(),
  npi: Type.String(),
  state: Type.Union([
    Type.Literal("verified"),
    Type.Literal("unverified"),
    Type.Literal("revoked"),
  ]),
  verificationId: nullable(Type.String()),
  evidence: nullable(Type.String()),
  verifiedAt: nullable(Type.String()),
  verifiedByMembershipId: nullable(Type.String()),
  revokedAt: nullable(Type.String()),
  revokedByMembershipId: nullable(Type.String()),
});

export const NpiVerificationListSchema = Type.Array(NpiVerificationViewSchema);
