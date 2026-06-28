// @wardenx/cost-report — Worksheet S-4 (Hospice Statistical Data — Supplemental) TypeBox schema
// (CMS-1984-14, §1.1). S-4 carries the supplemental hospice statistics that the per-diem and apportionment
// math reference but that do not belong on S-3 Parts I–IV: unduplicated census counts, FTE derivation
// (employed vs contracted), continuous-home-care hours, and the contracted-inpatient day breakdown. Days /
// hours / counts are integers or fractional hours; no money on this worksheet; no PHI — aggregate
// statistics only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet S-4 — supplemental hospice statistical data. */
export const WorksheetS4 = Type.Object(
  {
    /** Unduplicated beneficiary census by program (head-counts, not days). */
    unduplicatedCensus: Type.Object({
      medicare: Type.Integer({ default: 0 }),
      medicaid: Type.Integer({ default: 0 }),
      other: Type.Integer({ default: 0 }),
      total: Type.Integer({ default: 0 }),
    }),
    /** FTE derivation — employed vs contracted, cross-checked against S-3 Part II paid hours. */
    fullTimeEquivalents: Type.Object({
      employedFte: Type.Number({ default: 0 }),
      contractedFte: Type.Number({ default: 0 }),
      totalFte: Type.Number({ default: 0 }),
    }),
    /** Continuous home care is billed in hours; the day-vs-hour conversion lives in the apportionment math. */
    continuousHomeCareHours: Type.Number({ default: 0 }),
    /** Inpatient days delivered under contract vs in a provider-operated IPU (drives the IPU cap on B-1). */
    contractedInpatientDays: Type.Object({
      gipContracted: Type.Integer({ default: 0 }),
      gipProviderOperated: Type.Integer({ default: 0 }),
      ircContracted: Type.Integer({ default: 0 }),
      ircProviderOperated: Type.Integer({ default: 0 }),
    }),
    // TODO(CMS-fixture): the exact S-4 line ordering + any additional supplemental statistic columns
    // require a CMS-published CMS-1984-14 S-4 worksheet image to confirm penny/line conformance; the field
    // set above is the deterministic, internally-tied-out superset M27 computes against until then.
  },
  { additionalProperties: false },
);

export type WorksheetS4Data = Static<typeof WorksheetS4>;
