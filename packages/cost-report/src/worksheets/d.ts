// ⚠️ CMS-DIVERGENCE (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md): Form CMS-1984-14 has NO Worksheet D. The
// per-(program × level-of-care) apportionment modeled here is actually the real Worksheet C ("Calculation of
// Per Diem Cost", §4330), sourcing days from Worksheet S-1 (unduplicated days). Pending realignment (ledger).
// @wardenx/cost-report — Worksheet D (Apportionment of Cost to Programs) TypeBox schema (CMS-1984-14, §4.2
// / §1.1). D is a DERIVED worksheet: it apportions the fully-allocated hospice cost (Worksheet B) across
// the payer programs (Medicare / Medicaid / other) and across the four levels of care (RHC / CHC / IRC /
// GIP) by the program patient-day mix from Worksheet S-3 Part I. The day-weighted apportionment uses the
// penny-true `allocateProportional` allocator (D8) so the per-program costs sum EXACTLY to the total with
// zero drift. All money is INTEGER CENTS; days are integers. No PHI — aggregate day/cost mix only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Per-level-of-care apportioned cost for one program. */
const LevelOfCareApportionment = Type.Object({
  rhcCostCents: Type.Integer({ default: 0 }),
  chcCostCents: Type.Integer({ default: 0 }),
  ircCostCents: Type.Integer({ default: 0 }),
  gipCostCents: Type.Integer({ default: 0 }),
  totalCostCents: Type.Integer({ default: 0 }),
  totalDays: Type.Integer({ default: 0 }),
});

/** Worksheet D — apportionment of cost to programs. */
export const WorksheetD = Type.Object(
  {
    medicare: LevelOfCareApportionment,
    medicaid: LevelOfCareApportionment,
    other: LevelOfCareApportionment,
    /** Sum across all programs — must equal Worksheet B total fully-allocated cost (apportionment tie). */
    grandTotalApportionedCostCents: Type.Integer({ default: 0 }),
    tiesToWorksheetBTotal: Type.Boolean({ default: false }),
    apportionmentPreservesTotalExactly: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetDData = Static<typeof WorksheetD>;
