// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/typebox.ts — request and response contracts of the
// tenant clearinghouse routes (`/api/v1/tenant/clearinghouse`, and the platform copy under
// `/api/v1/platform/tenants/:orgSlug/clearinghouse`). Named `*-typebox` so the table-ownership heuristic never reads it as a
// Drizzle import. The credential (`secret`) exists only in a request; no response schema has a field for it.
import { type Static, type TSchema, Type } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const Iso = Type.String({ format: "date-time" });

export const ClearinghouseVendorSchema = Type.Union([
  Type.Literal("stedi"),
  Type.Literal("claimmd"),
  Type.Literal("outside"),
]);
export const ClearinghouseModeSchema = Type.Union([
  Type.Literal("test"),
  Type.Literal("production"),
]);

export const PutClearinghouseBodySchema = Type.Object(
  {
    vendor: ClearinghouseVendorSchema,
    mode: Type.Optional(ClearinghouseModeSchema),
    secret: Type.Optional(
      Type.String({
        minLength: 8,
        maxLength: 512,
        description:
          "The vendor credential (the Stedi API key, or the Claim.MD account key). Write-only: it is sealed under the tenant's own key and never returned. Required with a first choice and whenever vendor or mode changes; omit it to keep the stored one.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type PutClearinghouseBody = Static<typeof PutClearinghouseBodySchema>;

export const VerifyClearinghouseBodySchema = Type.Object(
  {
    evidenceNote: Type.Optional(
      Type.String({
        maxLength: 2000,
        description:
          "Required where the vendor has no safe connection test (Stedi): what was checked and by whom (8-500 characters after whitespace is collapsed; no patient information). Ignored where a connection test runs (Claim.MD).",
      }),
    ),
    confirmNoPatientInformation: Type.Optional(
      Type.Boolean({
        description:
          "Required, and must be true, with an evidence note: the person confirms the note names no patient information. Ignored where a connection test runs (Claim.MD).",
      }),
    ),
  },
  { additionalProperties: false },
);
export type VerifyClearinghouseBody = Static<typeof VerifyClearinghouseBodySchema>;

/** The tenant records the BAA it holds with its own vendor account (owner decision D2). No patient information. */
export const RecordBaaBodySchema = Type.Object(
  {
    heldBy: Type.Literal("tenant", {
      description: "Who holds the vendor BAA: the tenant itself (the account is the tenant's own).",
    }),
    effectiveDate: Type.String({
      format: "date",
      description: "The BAA's effective date (YYYY-MM-DD), not in the future.",
    }),
    documentRef: Type.String({
      minLength: 3,
      maxLength: 400,
      description:
        "Where the signed BAA is kept (3-200 characters after whitespace is collapsed): a title, contract folder or document id. Never patient information.",
    }),
  },
  { additionalProperties: false },
);
export type RecordBaaBody = Static<typeof RecordBaaBodySchema>;

export const ClearinghouseConfigViewSchema = Type.Object({
  vendor: Nullable(
    Type.Union([
      Type.Literal("stedi"),
      Type.Literal("claimmd"),
      Type.Literal("outside"),
      Type.Literal("direct_mac"),
      Type.Literal("in_memory"),
    ]),
  ),
  mode: Nullable(ClearinghouseModeSchema),
  status: Nullable(
    Type.Union([Type.Literal("draft"), Type.Literal("verified"), Type.Literal("active")]),
  ),
  source: Type.Union([Type.Literal("tenant"), Type.Literal("platform_env"), Type.Literal("none")]),
  hasSecret: Type.Boolean(),
  verifiableBy: Type.Union([
    Type.Literal("connection_test"),
    Type.Literal("attestation"),
    Type.Null(),
  ]),
  verification: Type.Union([
    Type.Object({
      kind: Type.Union([Type.Literal("connection_test"), Type.Literal("attested")]),
      evidence: Nullable(Type.String()),
      verifiedAt: Iso,
    }),
    Type.Null(),
  ]),
  lastTest: Type.Union([
    Type.Object({
      outcome: Type.Union([
        Type.Literal("ok"),
        Type.Literal("credential_rejected"),
        Type.Literal("unreachable"),
      ]),
      at: Iso,
    }),
    Type.Null(),
  ]),
  baaRequired: Type.Boolean({
    description:
      "True for a tenant-held vendor account: it needs a recorded BAA, verified by a platform operator, before it may go active.",
  }),
  baa: Type.Union([
    Type.Object({
      heldBy: Type.Literal("tenant"),
      effectiveDate: Type.String({ format: "date" }),
      documentRef: Type.String(),
      recordedAt: Iso,
      verified: Type.Union([Type.Object({ at: Iso }), Type.Null()]),
    }),
    Type.Null(),
  ]),
  activatedAt: Type.Union([Iso, Type.Null()]),
  version: Nullable(Type.Integer()),
  updatedAt: Type.Union([Iso, Type.Null()]),
});

export const VerifyClearinghouseResponseSchema = Type.Object({
  config: ClearinghouseConfigViewSchema,
  test: Type.Union([
    Type.Object({
      outcome: Type.Union([
        Type.Literal("ok"),
        Type.Literal("credential_rejected"),
        Type.Literal("unreachable"),
      ]),
    }),
    Type.Null(),
  ]),
});
