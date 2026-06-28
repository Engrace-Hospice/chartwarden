// @wardenx/cost-report — Worksheet H (Supplemental Schedules & Supporting-Document Cross-Reference) TypeBox
// schema (CMS-1984-14, §1.1). H is the supplemental/supporting schedule that anchors the supporting-document
// bundle the surveyor expects: the bad-debt summary (the per-period rollup of the `bad_debt_record` log),
// and the cross-reference list of supporting documents (organization chart, home-office agreement, time
// studies, related-party disclosures) that flow through M22 as `document_id` back-references. M27 holds the
// back-reference ids only — M22 owns the files (D11). Money is INTEGER CENTS; no PHI — aggregate bad-debt
// totals + document ids only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** One supporting-document cross-reference (the M22 document id back-reference; M27 stores no file bytes). */
const SupportingDocumentRef = Type.Object({
  documentType: Type.Union([
    Type.Literal("organization_chart"),
    Type.Literal("home_office_cost_allocation_agreement"),
    Type.Literal("time_study"),
    Type.Literal("related_party_disclosure"),
    Type.Literal("bad_debt_supporting"),
    Type.Literal("other"),
  ]),
  documentId: Type.String({ description: "M22 document_id back-reference" }),
  description: Type.Optional(Type.String()),
});

/** Worksheet H — supplemental schedules + supporting-document cross-reference. */
export const WorksheetH = Type.Object(
  {
    /** Bad-debt summary — opt-in per cost report; gated on the allowability rules when claimed. */
    badDebtClaimed: Type.Boolean({ default: false }),
    badDebtSummary: Type.Object({
      deductibleBadDebtCents: Type.Integer({ default: 0 }),
      coinsuranceBadDebtCents: Type.Integer({ default: 0 }),
      totalBadDebtCents: Type.Integer({ default: 0 }),
      reimbursableBadDebtCents: Type.Integer({ default: 0, description: "allowable portion per CMS rules" }),
      entriesCount: Type.Integer({ default: 0 }),
    }),
    supportingDocuments: Type.Array(SupportingDocumentRef, { default: [] }),
    // TODO(CMS-fixture): the CMS-1984-14 hospice form set's exact supplemental-schedule ("H") line layout
    // requires a CMS-published worksheet image to confirm conformance; the bad-debt rollup + document
    // cross-reference above is the internally-tied-out, deterministic superset M27 maintains until then.
  },
  { additionalProperties: false },
);

export type WorksheetHData = Static<typeof WorksheetH>;
