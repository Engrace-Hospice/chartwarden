/**
 * ChartWarden — seed the tenant wage index (`tenant_wage_index`, F-211) for a provider CCN from the CMS hospice
 * geography, instead of keying it by hand. PARAMETERISED: the CCN and the provider's ZIP are inputs — there is no
 * production default. The provider ZIP is placed in its CBSA / rural area by the SAME resolver the claim's value
 * code 61 uses (migration 1058 tables), and the published index for that area is taken from
 * `hospice_cbsa_wage_index`. The entry goes in through the real route (`POST /api/v1/billing/wage-indexes`), so
 * validation, the audit trail and the supersede rules apply.
 *
 *   bun run db:seed:wage-index -- --ccn 381588 --zip 97801 [--fy 2025,2026]
 *
 * Demo fixture: CCN 381588, Pendleton, Oregon, ZIP 97801 (Umatilla County). Re-running is safe: a live entry that
 * already exists for the CCN and fiscal year answers 409 and is reported as already seeded.
 *
 * Prereqs: backend running (bun run dev:backend), DB migrated, `db:seed:org-admin` run.
 */
import { type HospiceAreaLookup, resolveHospiceArea, wageIndexSeedBody } from "@chartwarden/billing";
import { Client } from "pg";
import { type WxSession, signIn } from "./lib/api-session";
import { stepUpSession } from "./lib/step-up";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
/** The two federal fiscal years around today (claims straddle the Oct 1 boundary). */
const defaultFiscalYears = (now = new Date()): number[] => {
  const fy = now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return [fy - 1, fy];
};

async function lookupFor(db: Client, zip5: string, fy: number): Promise<HospiceAreaLookup> {
  const county = (
    await db.query("SELECT county_fips FROM hospice_zip_county WHERE zip5 = $1", [zip5])
  ).rows[0]?.county_fips as string | undefined;
  const area = county
    ? (
        await db.query(
          `SELECT c.cbsa_code, c.area_kind, w.wage_index::text AS wage_index
             FROM hospice_cbsa_county c
             LEFT JOIN hospice_cbsa_wage_index w
               ON w.fiscal_year_starting = c.fiscal_year_starting AND w.cbsa_code = c.cbsa_code
            WHERE c.fiscal_year_starting = $1 AND c.county_fips = $2`,
          [fy, county],
        )
      ).rows[0]
    : undefined;
  return {
    countyForZip: () => county,
    areaForCounty: () =>
      area && {
        cbsaCode: area.cbsa_code,
        areaKind: area.area_kind,
        wageIndex: area.wage_index,
      },
  };
}

export async function seedWageIndex(
  session: WxSession,
  opts: { ccn: string; zip: string; fiscalYears: readonly number[] },
): Promise<string[]> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const report: string[] = [];
  try {
    for (const fy of opts.fiscalYears) {
      const zip5 = opts.zip.trim().slice(0, 5);
      const area = resolveHospiceArea(zip5, fy, await lookupFor(db, zip5, fy));
      const body = wageIndexSeedBody({
        ccn: opts.ccn,
        providerPostalCode: zip5,
        fiscalYearStarting: fy,
        area,
      });
      await stepUpSession(session.userId);
      const res = await session.client.POST("/api/v1/billing/wage-indexes", {
        params: { header: { "Idempotency-Key": crypto.randomUUID() } },
        body,
      });
      if (res.response.status === 409) {
        report.push(`FY start ${fy}: already seeded (${body.cbsaCode} = ${body.factorDecimal})`);
      } else if (res.error) {
        throw new Error(`wage index FY start ${fy} failed: ${JSON.stringify(res.error)}`);
      } else {
        report.push(`FY start ${fy}: ${body.cbsaCode} = ${body.factorDecimal}`);
      }
    }
  } finally {
    await db.end();
  }
  return report;
}

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const ccn = argOf("ccn");
  const zip = argOf("zip");
  if (!ccn || !zip) {
    console.error(
      "usage: bun run db:seed:wage-index -- --ccn <6-char CCN> --zip <provider ZIP> [--fy 2025,2026]",
    );
    process.exit(1);
  }
  const fiscalYears = argOf("fy")?.split(",").map(Number) ?? defaultFiscalYears();
  const session = await signIn("orgadmin@chartwarden.local");
  for (const line of await seedWageIndex(session, { ccn, zip, fiscalYears })) console.log(line);
}
