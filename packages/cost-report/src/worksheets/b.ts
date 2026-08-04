// @wardenx/cost-report — Worksheet B (Cost Allocation — Step-Down) TypeBox schema (Form CMS-1984-14, Pub 15-2
// §4320). B is a DERIVED worksheet: the step-down allocates the general-service (overhead) cost centers across
// the four direct level-of-care centers (CHC/RHC/IRC/GIP, lines 50–53) using the statistical basis recorded on
// Worksheet B-1, producing a fully-allocated cost per center. The math is the deterministic `decimal.js`
// largest-remainder allocator (D8) — the allocated parts sum EXACTLY to the pool (col. 18 line 101 = col. 0
// line 101). This schema is the persisted RESULT; the per-receiving statistical weights live on Worksheet B-1
// (§4320), not here. B col. 18 (lines 50–53) transfers to Worksheet C. All money is INTEGER CENTS; no PHI (D18).
//
// CMS-CERT: certified against the form + Ch.43 §4320 (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md).
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { type Static, Type } from "@sinclair/typebox";

/** One step-down pass: a general-service cost center and the total pool it allocated (the result; the basis
 *  that drove it is recorded on Worksheet B-1). */
const AllocationStatColumn = Type.Object({
  generalServiceCostCenterCode: Type.String(),
  /** The statistical basis label used (mirrors the Worksheet B-1 column), for presentation. */
  allocationBasis: Type.String(),
  poolAmountCents: Type.Integer({
    description: "DERIVED: total overhead pool allocated this pass",
  }),
});

/** A direct cost center's fully-allocated result after the full step-down. */
const SteppedDownCostCenter = Type.Object({
  code: Type.String(),
  name: Type.String(),
  directCostCents: Type.Integer({
    description: "cost from Worksheet A after A-1/A-6 net adjustments",
  }),
  allocatedOverheadCents: Type.Integer({
    description: "sum of all overhead allocated into this center",
  }),
  fullyAllocatedCostCents: Type.Integer({
    description: "directCostCents + allocatedOverheadCents",
  }),
});

/** Worksheet B — cost allocation step-down result. */
export const WorksheetB = Type.Object(
  {
    allocationColumns: Type.Array(AllocationStatColumn, { default: [] }),
    costCenters: Type.Array(SteppedDownCostCenter, { default: [] }),
    /** Sum of fully-allocated direct-center costs — must equal Worksheet A grand total (no cost lost/created). */
    totalFullyAllocatedCostCents: Type.Integer({ default: 0 }),
    tiesToWorksheetAGrandTotal: Type.Boolean({ default: false }),
    /** Penny-drift guard: the step-down preserves the total exactly (largest-remainder allocator, D8). */
    stepDownPreservesTotalExactly: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetBData = Static<typeof WorksheetB>;
