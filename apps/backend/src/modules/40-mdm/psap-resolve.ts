// apps/backend/src/modules/40-mdm/psap-resolve.ts - GAP-032: the PURE resolution rule of the tenant-curated PSAP
// catalog (no IO, unit-tested). Given the org's ACTIVE jurisdiction rows and where an SOS is, which row covers it?
//
// Deterministic order, most to least specific:
//   1. `point_in_polygon`  the SOS has a usable point and one or more drawn polygons contain it - the SMALLEST
//                          bounding box wins (a county inside a state), then the lowest id;
//   2. `location_default`  a row attached to the alert's location (no polygon);
//   3. `org_default`       the org's single default row;
//   else `none`.
// `stale` = past `verify_every_days` since `verified_at`: still returned (a labelled old number beats none),
// flagged so the UI says "verify by voice". This function never invents a number: it only picks among rows.
import { pointInRings, ringsBoundingArea } from "@wardenx/shared/geo";
import type {
  PsapJurisdictionSummary,
  PsapResolution,
  PsapResolutionConfidence,
  SafetyPolygonRings,
} from "@wardenx/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface JurisdictionRowFacts {
  readonly id: string;
  readonly name: string;
  readonly psapName: string;
  readonly psapPhone: string;
  readonly secondaryPhone: string | null;
  readonly polygon: SafetyPolygonRings | null;
  readonly appliesToLocationId: string | null;
  readonly isOrgDefault: boolean;
  readonly verifiedAt: Date;
  readonly verifyEveryDays: number;
}

export function isStale(row: JurisdictionRowFacts, now: Date): boolean {
  return now.getTime() - row.verifiedAt.getTime() > row.verifyEveryDays * MS_PER_DAY;
}

const byId = (a: JurisdictionRowFacts, b: JurisdictionRowFacts): number => a.id.localeCompare(b.id);

export function resolveJurisdiction(
  rows: readonly JurisdictionRowFacts[],
  input: {
    readonly point: { readonly latitude: number; readonly longitude: number } | null;
    readonly locationId: string | null;
  },
  now: Date,
): PsapResolution {
  const resolved = (
    row: JurisdictionRowFacts,
    confidence: PsapResolutionConfidence,
  ): PsapResolution => ({
    kind: "resolved",
    jurisdictionId: row.id,
    confidence,
    stale: isStale(row, now),
  });

  if (input.point !== null) {
    const point = input.point;
    const containing = rows
      .filter((r) => r.polygon !== null && pointInRings(r.polygon, point))
      .sort(
        (a, b) =>
          ringsBoundingArea(a.polygon as SafetyPolygonRings) -
            ringsBoundingArea(b.polygon as SafetyPolygonRings) || byId(a, b),
      );
    if (containing[0]) return resolved(containing[0], "point_in_polygon");
  }

  if (input.locationId !== null) {
    const atLocation = rows
      .filter((r) => r.polygon === null && r.appliesToLocationId === input.locationId)
      .sort(byId);
    if (atLocation[0]) return resolved(atLocation[0], "location_default");
  }

  const orgDefault = rows.filter((r) => r.isOrgDefault).sort(byId)[0];
  return orgDefault ? resolved(orgDefault, "org_default") : { kind: "none" };
}

export function summarize(row: JurisdictionRowFacts, now: Date): PsapJurisdictionSummary {
  return {
    jurisdictionId: row.id,
    name: row.name,
    psapName: row.psapName,
    phone: row.psapPhone,
    secondaryPhone: row.secondaryPhone,
    verifiedAt: row.verifiedAt.toISOString() as PsapJurisdictionSummary["verifiedAt"],
    stale: isStale(row, now),
  };
}
