// M23 — binds the claim's wage-index value codes (61 / G8) to data: the patient's / facility's ZIP comes in through
// injected ports (M23 imports neither M5 nor M40 — the F-121/F-213 posture), the ZIP -> county -> CBSA geography is
// M23's own platform reference data (migration 1058, SELECT-only for tenants), and the pure resolver in
// `@wardenx/billing` decides. Nothing is guessed: a missing ZIP or an unplaceable one is reported as unresolved and
// the `cbsa_value_codes_present` rule blocks the claim.
import {
  type HospiceAreaLookup,
  type HospiceAreaResolution,
  type ValueCodeAreas,
  hospiceFiscalYearStartingOf,
  type repositories,
  resolveHospiceArea,
} from "@wardenx/billing";
import { schema } from "@wardenx/db";
import { and, eq } from "drizzle-orm";
import type { DateRange, HospiceCbsaReader } from "./claim-assembly-types";

type Db = repositories.BillingDb;

/** The two address facts the value codes need; both are plain ZIP/postal strings or `null` (none recorded). */
export interface ClaimZipPorts {
  /** The patient's residence postal code on `asOf` (M5 `residenceAt`). */
  residencePostalCode(orgId: string, patientId: string, asOf: string): Promise<string | null>;
  /** The postal code of the latest facility the patient resided in over `range` (M5 spans + M40 facility). */
  inpatientFacilityPostalCode(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<string | null>;
}

async function lookupFor(db: Db, zip5: string, fiscalYearStarting: number) {
  const [zipRow] = await db
    .select({ countyFips: schema.hospiceZipCounty.countyFips })
    .from(schema.hospiceZipCounty)
    .where(eq(schema.hospiceZipCounty.zip5, zip5))
    .limit(1);
  const [areaRow] = zipRow
    ? await db
        .select({
          cbsaCode: schema.hospiceCbsaCounty.cbsaCode,
          areaKind: schema.hospiceCbsaCounty.areaKind,
        })
        .from(schema.hospiceCbsaCounty)
        .where(
          and(
            eq(schema.hospiceCbsaCounty.fiscalYearStarting, fiscalYearStarting),
            eq(schema.hospiceCbsaCounty.countyFips, zipRow.countyFips),
          ),
        )
        .limit(1)
    : [];
  const lookup: HospiceAreaLookup = {
    countyForZip: () => zipRow?.countyFips,
    areaForCounty: () => areaRow,
  };
  return lookup;
}

async function resolveZip(
  db: Db,
  postalCode: string | null,
  fiscalYearStarting: number,
): Promise<HospiceAreaResolution | null> {
  if (postalCode === null || postalCode.trim() === "") return null;
  const zip5 = postalCode.trim().slice(0, 5);
  const lookup = await lookupFor(db, zip5, fiscalYearStarting);
  return resolveHospiceArea(postalCode, fiscalYearStarting, lookup);
}

/** CMS: the CBSA is that of the residence at the END of the billing period, in the period's fiscal year. */
export function buildHospiceCbsaReader(db: Db, zips: ClaimZipPorts): HospiceCbsaReader {
  return {
    async areasFor(orgId, patientId, range): Promise<ValueCodeAreas> {
      const fiscalYearStarting = hospiceFiscalYearStartingOf(range.to);
      const [residence, facility] = await Promise.all([
        zips.residencePostalCode(orgId, patientId, range.to),
        zips.inpatientFacilityPostalCode(orgId, patientId, range),
      ]);
      return {
        residence: await resolveZip(db, residence, fiscalYearStarting),
        facility: await resolveZip(db, facility, fiscalYearStarting),
      };
    },
  };
}
