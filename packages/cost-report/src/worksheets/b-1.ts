// ⚠️ CMS-DIVERGENCE (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md): on the REAL Form CMS-1984-14, Worksheet
// B-1 is "Cost Allocation – Statistical Basis" (§4320) — the per-center step-down statistics + the 6-decimal
// unit-cost multiplier (A&G on accumulated cost), NOT cap calculations. The cap math belongs in M26 cap
// management (the MAC cap-determination process is not a CMS-1984-14 worksheet). Pending realignment (ledger).
// @wardenx/cost-report — Worksheet B-1 (Cap Calculations) TypeBox schema (CMS-1984-14, §1.1). B-1 holds
// the two Medicare hospice cap calculations: (1) the AGGREGATE cap per beneficiary — total Medicare
// payments compared to (cap amount × number of beneficiaries) for the CAP YEAR (Nov 1 – Oct 31, which is
// INDEPENDENT of the fiscal year), and (2) the INPATIENT (IPU) cap — GIP + IRC days limited to 20% of total
// Medicare hospice days. Cap-year accrual inputs come from the M26 `CapAccrualReader` / `CapPeriodReader`
// (forward-seam deny-stub at M27 lock — cap rules SKIP with `cap_provider_unbound` until M26 lands). Money
// is INTEGER CENTS; no PHI — aggregate cap accruals only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet B-1 — aggregate-cap + inpatient-cap calculations. */
export const WorksheetB1 = Type.Object(
  {
    /** True until M26 wires live — when set, the aggregate/IPU cap rules are skipped, not failed. */
    capProviderUnbound: Type.Boolean({ default: true }),
    /** The cap year (Nov 1 – Oct 31) the accruals are bucketed by — distinct from the fiscal year. */
    capYearBeginDate: Type.Optional(Type.String({ format: "date" })),
    capYearEndDate: Type.Optional(Type.String({ format: "date" })),
    aggregateCap: Type.Object({
      /** Statutory per-beneficiary cap amount for the cap year (cents). */
      capAmountPerBeneficiaryCents: Type.Integer({ default: 0 }),
      /** Proportional/streamlined beneficiary count (fractional — a beneficiary spanning years is apportioned). */
      numberOfBeneficiaries: Type.Number({ default: 0 }),
      /** capAmountPerBeneficiaryCents × numberOfBeneficiaries, rounded to whole cents (HALF_UP, D8). */
      aggregateCapCents: Type.Integer({ default: 0 }),
      totalMedicarePaymentsCents: Type.Integer({ default: 0 }),
      /** Positive = overpayment owed back to Medicare (payments exceeded the cap). */
      capOverpaymentCents: Type.Integer({ default: 0 }),
    }),
    inpatientCap: Type.Object({
      totalMedicareHospiceDays: Type.Integer({ default: 0 }),
      inpatientDaysGipPlusIrc: Type.Integer({ default: 0 }),
      /** Statutory inpatient limit = 20% of total Medicare hospice days. */
      inpatientLimitDays: Type.Integer({ default: 0 }),
      daysOverLimit: Type.Integer({ default: 0 }),
      inpatientCapOverpaymentCents: Type.Integer({ default: 0 }),
    }),
  },
  { additionalProperties: false },
);

export type WorksheetB1Data = Static<typeof WorksheetB1>;
