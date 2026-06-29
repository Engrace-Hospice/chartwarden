// @wardenx/cost-report — Worksheet A-8-1 (Statement of Costs of Services from Related Organizations) TypeBox
// schema (Form CMS-1984-14, Pub 15-2 §4319). A-8-1 discloses costs of services/supplies/facilities the
// hospice obtained from organizations related by common ownership/control, so the cost report reflects the
// related party's COST (not the charged price) per 42 CFR 413.17. Feeds the Worksheet A-8 adjustment.
// Money is INTEGER CENTS; no PHI (D18).
//
// CMS-CERT: certified against the form + Ch.43 §4319 (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md).
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** One related-organization line: the related party, the service furnished, the cost to the related org, and
 *  the amount included in the hospice's allowable cost (the adjustment basis). */
const RelatedOrgEntry = Type.Object({
  relatedOrganizationName: Type.String(),
  serviceDescription: Type.String(),
  costToRelatedOrgCents: Type.Integer({ default: 0 }),
  amountInAllowableCostCents: Type.Integer({ default: 0 }),
});

/** Worksheet A-8-1 — statement of costs of services from related organizations. */
export const WorksheetA81 = Type.Object(
  {
    relatedOrganizations: Type.Array(RelatedOrgEntry, { default: [] }),
    hasRelatedOrganizations: Type.Boolean({ default: false }),
    totalAdjustmentCents: Type.Integer({ default: 0 }),
  },
  { additionalProperties: false },
);

export type WorksheetA81Data = Static<typeof WorksheetA81>;
