// @wardenx/cost-report — Worksheet A-8 (Adjustments for Related-Party / Owner Compensation) TypeBox schema
// (CMS-1984-14, §1.1). A-8 discloses transactions with related organizations (per the S-2 listing) and
// owner/officer compensation, then adjusts the cost base to the LOWER of cost or market for related-party
// dealings per the CMS related-party principle. The medical-director compensation line cross-references the
// M40 `external_physician` reader. Related parties are BUSINESS entities — no PHI (D18). Money is INTEGER
// CENTS (signed; a negative adjustment reduces allowable cost).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { type Static, Type } from "@sinclair/typebox";

/** One related-party transaction disclosure + its cost adjustment. */
const RelatedPartyTransaction = Type.Object({
  relatedPartyName: Type.String(),
  relationshipType: Type.Union([
    Type.Literal("common_ownership"),
    Type.Literal("control"),
    Type.Literal("owner_compensation"),
    Type.Literal("home_office"),
    Type.Literal("other"),
  ]),
  /** When the related party is a physician (e.g. medical director), the M40 reader id. */
  externalPhysicianId: Type.Optional(Type.String()),
  serviceDescription: Type.String(),
  amountPaidCents: Type.Integer({ description: "amount the provider paid the related party" }),
  allowableCostCents: Type.Integer({ description: "lower-of-cost-or-market allowable amount" }),
  /** Signed adjustment = allowableCostCents − amountPaidCents (negative reduces allowable cost). */
  adjustmentCents: Type.Integer(),
});

/** Worksheet A-8 — related-party / owner-compensation adjustments. */
export const WorksheetA8 = Type.Object(
  {
    relatedPartyTransactions: Type.Array(RelatedPartyTransaction, { default: [] }),
    totalRelatedPartyAdjustmentCents: Type.Integer({ default: 0 }),
    medicalDirectorIsRelatedParty: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetA8Data = Static<typeof WorksheetA8>;
