// @wardenx/cost-report — Worksheet S-1 (Provider Identification / General Information) TypeBox schema
// (CMS-1984-14, §4.2 / §1.1). S-1 carries the provider-level demographic + enrollment facts that anchor
// the report: CCN, NPI, Tax ID, MAC jurisdiction, certification dates, fiscal-year configuration, and the
// CBSA/wage-index locality — most of these flow from M40 `ProviderEntityReader`. No money here (it is
// identification data); no PHI — provider-entity attributes only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet S-1 — provider identification & general information. */
export const WorksheetS1 = Type.Object(
  {
    providerCcn: Type.String(),
    providerLegalName: Type.String(),
    doingBusinessAsName: Type.Optional(Type.String()),
    npi: Type.String({ description: "10-digit National Provider Identifier" }),
    taxIdentificationNumber: Type.String(),
    macJurisdiction: Type.String({ description: "e.g. NGS-J6" }),
    /** Practice/service address. No patient address — provider only. */
    streetAddress: Type.String({ default: "" }),
    city: Type.String({ default: "" }),
    state: Type.String({ default: "" }),
    zipCode: Type.String({ default: "" }),
    countyCode: Type.Optional(Type.String()),
    /** CMS-assigned wage-index locality for the per-diem cost calculations. */
    cbsaCode: Type.Optional(Type.String()),
    ruralUrbanIndicator: Type.Union(
      [Type.Literal("urban"), Type.Literal("rural"), Type.Literal("unknown")],
      { default: "unknown" },
    ),
    providerType: Type.Union(
      [
        Type.Literal("freestanding_hospice"),
        Type.Literal("hospital_based_hospice"),
        Type.Literal("home_health_based_hospice"),
        Type.Literal("snf_based_hospice"),
      ],
      { default: "freestanding_hospice" },
    ),
    medicareCertificationDate: Type.Optional(Type.String({ format: "date" })),
    medicaidCertificationDate: Type.Optional(Type.String({ format: "date" })),
    fiscalYearBeginDate: Type.String({ description: "YYYY-MM-DD", default: "" }),
    fiscalYearEndDate: Type.String({ description: "YYYY-MM-DD", default: "" }),
    /** 5-month statutory filing deadline (42 CFR §413.24(f)); extension date when the MAC grants one. */
    filingDeadlineDate: Type.Optional(Type.String({ format: "date" })),
    deadlineExtensionUntilDate: Type.Optional(Type.String({ format: "date" })),
  },
  { additionalProperties: false },
);

export type WorksheetS1Data = Static<typeof WorksheetS1>;
