// @wardenx/cost-report — Worksheet S-2 (Ownership & Organizational Structure) TypeBox schema
// (CMS-1984-14, §4.2 / §1.1). S-2 discloses ownership type, the chain home office (when the provider is
// part of a chain), and the related-organization listing that drives the Worksheet A-8 related-party
// adjustments. Owner / related-org identities here are BUSINESS entities, not patients — no PHI (D18).
// Money fields (e.g. home-office cost allocation) are INTEGER CENTS.
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { type Static, Type } from "@sinclair/typebox";

/** A single owner / officer / related-party disclosure row. */
const OwnerDisclosure = Type.Object({
  name: Type.String(),
  title: Type.Optional(Type.String()),
  relationshipType: Type.Union([
    Type.Literal("individual_owner"),
    Type.Literal("corporate_owner"),
    Type.Literal("officer_director"),
    Type.Literal("related_organization"),
    Type.Literal("chain_home_office"),
  ]),
  ownershipPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  /** When the related party is an external physician (e.g. medical director), the M40 reader id. */
  externalPhysicianId: Type.Optional(Type.String()),
});

/** Worksheet S-2 — ownership & organizational structure. */
export const WorksheetS2 = Type.Object(
  {
    ownershipType: Type.Union(
      [
        Type.Literal("voluntary_nonprofit"),
        Type.Literal("proprietary"),
        Type.Literal("governmental"),
      ],
      { default: "proprietary" },
    ),
    isChainAffiliated: Type.Boolean({ default: false }),
    chainHomeOfficeName: Type.Optional(Type.String()),
    chainHomeOfficeCcn: Type.Optional(Type.String()),
    /** Executed home-office cost-allocation agreement on file (M22 attachment), with allocated cents. */
    homeOfficeCostAllocationAgreementOnFile: Type.Boolean({ default: false }),
    homeOfficeAllocatedCostCents: Type.Integer({ default: 0 }),
    owners: Type.Array(OwnerDisclosure, { default: [] }),
    relatedOrganizations: Type.Array(OwnerDisclosure, { default: [] }),
    organizationChartDocumentOnFile: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetS2Data = Static<typeof WorksheetS2>;
