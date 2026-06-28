// @wardenx/cost-report — Worksheet B (Cost Allocation — Step-Down) TypeBox schema (CMS-1984-14, §4.2 /
// §1.1). B is a DERIVED worksheet (DERIVED_WORKSHEET_CODES): the step-down allocates overhead/general-
// service cost centers across the direct (revenue-producing) cost centers by statistical bases, producing
// a fully-allocated cost per center. The step-down math lives in the deterministic `decimal.js`
// allocation functions (D8) — `allocateProportional` guarantees the allocated parts sum EXACTLY to the
// pool with zero penny drift. This schema is the persisted RESULT of that math. All money is INTEGER
// CENTS; no PHI (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** One allocation pass: a general-service cost center spread across receiving centers by a statistical basis. */
const AllocationStatColumn = Type.Object({
  generalServiceCostCenterCode: Type.String(),
  /** Statistical basis driving this column (square footage, FTEs, accumulated cost, etc.). */
  allocationBasis: Type.String(),
  poolAmountCents: Type.Integer({ description: "total overhead pool being allocated this pass" }),
});

/** A direct cost center's fully-allocated result after the full step-down. */
const SteppedDownCostCenter = Type.Object({
  code: Type.String(),
  name: Type.String(),
  directCostCents: Type.Integer({ description: "cost from Worksheet A after A-1/A-6 net adjustments" }),
  allocatedOverheadCents: Type.Integer({ description: "sum of all overhead allocated into this center" }),
  fullyAllocatedCostCents: Type.Integer({ description: "directCostCents + allocatedOverheadCents" }),
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
