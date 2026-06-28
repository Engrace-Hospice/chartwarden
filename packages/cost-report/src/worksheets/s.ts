// @wardenx/cost-report — Worksheet S (Certification & Settlement Summary) TypeBox schema (CMS-1984-14,
// §4.2 / §1.1). Worksheet S is the cover/certification page: it names the provider + fiscal year, carries
// the officer attestation statement captured verbatim at submit (D14), and summarizes the top-line cost-
// report total that must tie to Worksheet A's grand total (cross-worksheet tie). All money is INTEGER
// CENTS at the boundary; no PHI — aggregate financial/identification data only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet S — certification statement + settlement summary. */
export const WorksheetS = Type.Object(
  {
    providerCcn: Type.String({ description: "CMS Certification Number (6-digit)" }),
    providerName: Type.String(),
    fiscalYearBeginDate: Type.String({ description: "YYYY-MM-DD", default: "" }),
    fiscalYearEndDate: Type.String({ description: "YYYY-MM-DD", default: "" }),
    reportType: Type.Union(
      [Type.Literal("as_filed"), Type.Literal("amended"), Type.Literal("reopened")],
      { default: "as_filed" },
    ),
    /** The verbatim 18 U.S.C. § 1001 attestation captured at submit (D14); empty until certified. */
    certification: Type.Object({
      certifyingOfficerName: Type.String({ default: "" }),
      certifyingOfficerTitle: Type.String({ default: "" }),
      attestationStatement: Type.String({ default: "" }),
      signedDate: Type.Optional(Type.String({ format: "date" })),
    }),
    /** Electronically prepared (ECR) vs hand-keyed flag. */
    electronicallyPrepared: Type.Boolean({ default: true }),
    /** Top-line settlement summary — cents. Positive = due to provider, negative = due to program. */
    medicareBalanceDueProviderCents: Type.Integer({ default: 0 }),
    medicaidBalanceDueProviderCents: Type.Integer({ default: 0 }),
    /** Cross-worksheet tie: must equal Worksheet A `grandTotalCostsCents`. */
    totalCostReportCostsCents: Type.Integer({ default: 0 }),
    tiesToWorksheetAGrandTotal: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetSData = Static<typeof WorksheetS>;
