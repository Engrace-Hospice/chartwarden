// M23 — binds the claim's wage-index value codes (61 / G8) to data: the patient's / facility's ZIP comes in through
// injected ports (M23 imports neither M5 nor M40 — the F-121/F-213 posture), the ZIP -> county -> CBSA geography is
// M23's own platform reference data (migration 1058, SELECT-only for tenants), and the pure resolver in
// `@wardenx/billing` decides. Nothing is guessed: a missing ZIP or an unplaceable one is reported as unresolved and
// the `cbsa_value_codes_present` rule blocks the claim.
import {
  type FacilitySpan,
  type HospiceAreaLookup,
  type HospiceAreaResolution,
  type ValueCodeAreas,
  facilityPostalCodeForInpatientDates,
  hospiceFiscalYearStartingOf,
  type repositories,
  resolveHospiceArea,
} from "@wardenx/billing";
import { schema } from "@wardenx/db";
import { and, eq } from "drizzle-orm";
import type { DateRange, HospiceCbsaReader, InpatientStay } from "./claim-assembly-types";

type Db = repositories.BillingDb;

/** The two address facts the value codes need. */
export interface ClaimZipPorts {
  /** The patient's residence postal code on `asOf` (M5 `residenceAt`); `null` = none recorded. */
  residencePostalCode(orgId: string, patientId: string, asOf: string): Promise<string | null>;
  /** The patient's facility residence spans over `range` with each facility's postal code (M5 spans + M40 address). */
  facilitySpans(
    orgId: string,
    patientId: string,
    range: DateRange,
    stays: readonly InpatientStay[],
  ): Promise<readonly FacilitySpan[]>;
}

/**
 * The facility spans G8 is read from. M37's `ipu_admission` is the system of record for an inpatient stay: where it
 * knows the facility for a stay's level-of-care period, that facility (a span covering exactly that stay) is used
 * and M5's residence spans are NOT consulted for it (a nursing-home resident's open M5 span would otherwise contradict
 * the hospital GIP stay). M5 spans only stand in for stays M37 has no record of.
 */
export function composeFacilitySpans(
  stays: readonly InpatientStay[],
  m37PostalByPeriod: ReadonlyMap<string, string | null>,
  m5Spans: readonly FacilitySpan[],
): FacilitySpan[] {
  const fromM37 = stays.flatMap((stay) =>
    m37PostalByPeriod.has(stay.levelOfCarePeriodId)
      ? [
          {
            effectiveFrom: stay.from,
            effectiveTo: stay.to,
            postalCode: m37PostalByPeriod.get(stay.levelOfCarePeriodId) ?? null,
          },
        ]
      : [],
  );
  const unknownToM37 = stays.filter((s) => !m37PostalByPeriod.has(s.levelOfCarePeriodId));
  // An M5 span stands in only for the stays M37 does not know: clip it to each of them (intersect), so an open-ended
  // nursing-home span cannot also speak for a later stay M37 knows and contradict it.
  const clipped = m5Spans.flatMap((span) =>
    unknownToM37.flatMap((stay) => {
      const from = span.effectiveFrom > stay.from ? span.effectiveFrom : stay.from;
      const to =
        span.effectiveTo !== null && span.effectiveTo < stay.to ? span.effectiveTo : stay.to;
      return from <= to
        ? [{ effectiveFrom: from, effectiveTo: to, postalCode: span.postalCode }]
        : [];
    }),
  );
  return [...fromM37, ...clipped];
}

/** M5 residence spans (structural: kind + facility + window) joined with M40 facility postal codes. */
export function toFacilitySpans(
  spans: readonly {
    readonly kind: string;
    readonly facilityId: string | null;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[],
  postalByFacility: ReadonlyMap<string, string>,
): FacilitySpan[] {
  return spans.flatMap((s) =>
    s.kind === "facility" && s.facilityId
      ? [
          {
            effectiveFrom: s.effectiveFrom,
            effectiveTo: s.effectiveTo,
            postalCode: postalByFacility.get(s.facilityId) ?? null,
          },
        ]
      : [],
  );
}

async function lookupFor(db: Db, zip5: string, fiscalYearStarting: number) {
  const [zipRow] = await db
    .select({ countyFips: schema.hospiceZipCounty.countyFips })
    .from(schema.hospiceZipCounty)
    .where(eq(schema.hospiceZipCounty.zip5, zip5))
    .limit(1);
  // A ZIP with no ZCTA (PO box) falls back to its 3-digit prefix, which exists only where unanimous.
  const [zip3Row] = zipRow
    ? []
    : await db
        .select({
          cbsaCode: schema.hospiceZip3Area.cbsaCode,
          areaKind: schema.hospiceZip3Area.areaKind,
        })
        .from(schema.hospiceZip3Area)
        .where(
          and(
            eq(schema.hospiceZip3Area.fiscalYearStarting, fiscalYearStarting),
            eq(schema.hospiceZip3Area.zip3, zip5.slice(0, 3)),
          ),
        )
        .limit(1);
  const [countyRow] = zipRow
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
  const found = countyRow ?? zip3Row;
  const [indexRow] = found
    ? await db
        .select({ wageIndex: schema.hospiceCbsaWageIndex.wageIndex })
        .from(schema.hospiceCbsaWageIndex)
        .where(
          and(
            eq(schema.hospiceCbsaWageIndex.fiscalYearStarting, fiscalYearStarting),
            eq(schema.hospiceCbsaWageIndex.cbsaCode, found.cbsaCode),
          ),
        )
        .limit(1)
    : [];
  const withIndex = (a: typeof found) =>
    a ? { ...a, wageIndex: indexRow?.wageIndex ?? null } : undefined;
  const lookup: HospiceAreaLookup = {
    countyForZip: () => zipRow?.countyFips,
    areaForCounty: () => withIndex(countyRow),
    areaForZip3: () => withIndex(zip3Row),
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

/**
 * CMS: value code 61 is the CBSA of the residence at the END of the billing period, in that period's fiscal year;
 * G8 is the CBSA of the facility where the inpatient (0655/0656) care was delivered — the facility span overlapping
 * the inpatient level-of-care dates (see `facility-zip.ts`).
 */
export function buildHospiceCbsaReader(db: Db, zips: ClaimZipPorts): HospiceCbsaReader {
  return {
    async areasFor(orgId, patientId, range, stays): Promise<ValueCodeAreas> {
      const fiscalYearStarting = hospiceFiscalYearStartingOf(range.to);
      const residence = await zips.residencePostalCode(orgId, patientId, range.to);
      return {
        residence: await resolveZip(db, residence, fiscalYearStarting),
        facility: await resolveFacility(
          db,
          zips,
          orgId,
          patientId,
          range,
          stays,
          fiscalYearStarting,
        ),
      };
    },
    async wageIndexForArea(cbsaCode, fiscalYearStarting) {
      const [row] = await db
        .select({ wageIndex: schema.hospiceCbsaWageIndex.wageIndex })
        .from(schema.hospiceCbsaWageIndex)
        .where(
          and(
            eq(schema.hospiceCbsaWageIndex.fiscalYearStarting, fiscalYearStarting),
            eq(schema.hospiceCbsaWageIndex.cbsaCode, cbsaCode),
          ),
        )
        .limit(1);
      return row?.wageIndex ?? null;
    },
  };
}

async function resolveFacility(
  db: Db,
  zips: ClaimZipPorts,
  orgId: string,
  patientId: string,
  range: DateRange,
  stays: readonly InpatientStay[],
  fiscalYearStarting: number,
): Promise<HospiceAreaResolution | null> {
  if (stays.length === 0) return null; // no inpatient care on the claim: G8 is not needed
  const spans = await zips.facilitySpans(orgId, patientId, range, stays);
  const found = facilityPostalCodeForInpatientDates(stays, spans);
  if (found.status === "unresolved") return { status: "unresolved", reason: found.reason };
  return resolveZip(db, found.postalCode, fiscalYearStarting);
}
