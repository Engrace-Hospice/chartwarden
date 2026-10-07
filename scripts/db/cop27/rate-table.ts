/**
 * COP27 API seed — the FY2027 hospice rate table for the provider entity.
 *
 * Values come from the API's own CMS national reference (`GET /billing/rate-tables/national-reference`, the
 * corrected 2026-09-30 rates in packages/billing/src/rate-table/national-rates.ts) — HQRP-compliant set —
 * with the CMS labor shares (RHC 66.00%, CHC 66.00%, IRC 54.00%, GIP 64.00%). Skipped when the provider
 * entity already has any FY2027 table (rate tables may not overlap, and an existing one is never touched).
 */
import type { SeedContext } from "./context";
import { must } from "./http";
import type { ScenarioRun } from "./run";

const FY2027_STARTING = 2026;

interface RateSet {
  rhcDays1to60PerDiemCents: number;
  rhcDays61PlusPerDiemCents: number;
  chcPerDiemCents: number;
  chcHourlyRateCents: number;
  ircPerDiemCents: number;
  gipPerDiemCents: number;
}

interface RateTableRow extends RateSet {
  rateTableId: string;
  fiscalYearStarting: number;
  hqrpCompliant: boolean | null;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export async function ensureRateTable(run: ScenarioRun, ctx: SeedContext): Promise<void> {
  const pe = ctx.providerEntity;
  if (!pe) run.stop("FY2027 rate table", "the organization has no active provider entity");
  await run.ensure(
    "FY2027 rate table (HQRP-compliant national rates)",
    async () => {
      const r = await must<{ rateTables: RateTableRow[] }>(
        "list rate tables",
        ctx.admin.client.GET("/api/v1/billing/rate-tables", {
          params: { query: { providerEntityId: pe.id, includeSuperseded: true } },
        }),
      );
      return r.rateTables.find((t) => t.fiscalYearStarting === FY2027_STARTING) ?? null;
    },
    async () => {
      const ref = await must<{ reference: { hqrpCompliant: RateSet } | null }>(
        "read national reference",
        ctx.admin.client.GET("/api/v1/billing/rate-tables/national-reference", {
          params: { query: { providerEntityId: pe.id, fiscalYearStarting: FY2027_STARTING } },
        }),
      );
      if (!ref.reference) throw new Error("the API has no FY2027 national reference");
      const rates = ref.reference.hqrpCompliant;
      return must<RateTableRow>(
        "create rate table",
        ctx.admin.client.POST("/api/v1/billing/rate-tables", {
          params: { header: { "Idempotency-Key": `demo-cop27-rate-table-${pe.id}-fy2027` } },
          body: {
            providerEntityId: pe.id,
            fiscalYearStarting: FY2027_STARTING,
            effectiveFrom: "2026-10-01",
            effectiveTo: "2027-09-30",
            rhcDays1to60PerDiemCents: rates.rhcDays1to60PerDiemCents,
            rhcDays61PlusPerDiemCents: rates.rhcDays61PlusPerDiemCents,
            chcPerDiemCents: rates.chcPerDiemCents,
            chcHourlyRateCents: rates.chcHourlyRateCents,
            ircPerDiemCents: rates.ircPerDiemCents,
            gipPerDiemCents: rates.gipPerDiemCents,
            laborShareRhc: "0.6600",
            laborShareChc: "0.6600",
            laborShareIrc: "0.5400",
            laborShareGip: "0.6400",
            hqrpCompliant: true,
            entryReason:
              "DEMO DATA — FY2027 CMS national rates (CMS-1851-F as corrected by CMS-1851-CN, 2026-09-30), HQRP-compliant.",
          },
        }),
      );
    },
    (t) =>
      `table ${t.rateTableId} hqrp=${t.hqrpCompliant} RHC ${dollars(t.rhcDays1to60PerDiemCents)}/${dollars(t.rhcDays61PlusPerDiemCents)} GIP ${dollars(t.gipPerDiemCents)}`,
  );
}
