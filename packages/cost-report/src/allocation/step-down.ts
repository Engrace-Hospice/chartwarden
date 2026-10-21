// @chartwarden/cost-report — M27 Worksheet A → B STEP-DOWN cost allocation (§1.1, §3.1 `allocation/`, D8).
// The first hop of the CMS-1984-14 propagation chain (A → B → C → D → E-1): the net expenses of the
// general-service / overhead (non-revenue) cost centers from Worksheet A are stepped down onto the
// direct (revenue-producing) cost centers by a per-center STATISTICAL BASIS (square footage, FTEs,
// accumulated cost, etc.), producing the fully-allocated Worksheet B cost per direct center. The method
// is the NON-RECIPROCAL step-down: overhead centers are closed one at a time in a fixed allocation
// order; once a center is stepped out it receives nothing further; each center allocates to every
// not-yet-closed center below it (including downstream overhead centers). Total cost is CONSERVED — the
// sum of fully-allocated direct-center cost equals the sum of every center's Worksheet A direct cost, to
// the cent — because each split is penny-true (`allocateProportional`, largest-remainder).
//
// PURE DOMAIN, deterministic total function over an already-fetched input: no Fastify, no Drizzle/DB, no
// BullMQ, no `@chartwarden/db`, no `getSeam`. All money is INTEGER CENTS at the boundary; the only fractional
// arithmetic is inside the money kernel. No PHI — aggregate financial/statistical only (D18).
import { allocateProportional, sumCents } from "../domain/money";
import type { Cents } from "../domain/money";

/**
 * One Worksheet A cost center entering the step-down. `directCostCents` is the center's net expense
 * after reclassifications (A-6) and adjustments (A-8) — i.e. the Worksheet A column the step-down starts
 * from. `isOverhead` marks a general-service / non-revenue center that allocates out (steps down) and
 * ends at zero; a direct center accumulates allocations and keeps its total.
 */
export interface StepDownCostCenter {
  readonly code: string;
  readonly name: string;
  readonly directCostCents: Cents;
  readonly isOverhead: boolean;
}

/**
 * The statistical basis an overhead center allocates by: a non-negative statistic value per RECEIVING
 * center code. A receiving center absent from this list (or with statistic 0) gets weight 0. If every
 * receiving statistic is 0 the money kernel falls back to an equal split so the cost is still
 * distributed exactly rather than discarded. TODO(CMS-fixture): the exact statistic each overhead center
 * uses (and any CMS-prescribed accumulated-cost basis) is pinned by the CMS-1984-14 Worksheet B-1 column
 * map — verify against a CMS-published example report before treating a basis choice as conformant.
 */
export interface StatisticalBasis {
  readonly allocatingCenterCode: string;
  readonly weights: ReadonlyArray<{
    readonly receivingCenterCode: string;
    readonly statisticValue: number;
  }>;
}

/**
 * The fully-fetched step-down input. `costCenters` is in ALLOCATION ORDER — overhead centers step down
 * in the order they appear (the §B-1 order of allocation); this ordering is the deterministic spine of
 * the whole computation. `statisticalBases` carries one basis per overhead center.
 */
export interface StepDownAllocateInput {
  readonly costCenters: readonly StepDownCostCenter[];
  readonly statisticalBases: readonly StatisticalBasis[];
}

/** One overhead center's step: the amount it stepped out and where each cent landed. */
export interface StepDownStepDetail {
  readonly allocatingCenterCode: string;
  readonly amountAllocatedCents: Cents;
  readonly allocations: ReadonlyArray<{
    readonly receivingCenterCode: string;
    readonly amountCents: Cents;
  }>;
}

/** A Worksheet B row: a center's direct cost, total overhead received, and final allocated cost. */
export interface WorksheetBAllocatedCenter {
  readonly code: string;
  readonly name: string;
  readonly isOverhead: boolean;
  readonly directCostCents: Cents;
  /** Total overhead stepped INTO this center across the whole run. */
  readonly allocatedInCents: Cents;
  /** Final fully-allocated cost: direct + allocatedIn for a direct center; 0 for a stepped-out overhead center. */
  readonly totalCostCents: Cents;
}

/** The Worksheet B result plus the per-step audit trail and the cent-level tie-out. */
export interface StepDownAllocateResult {
  readonly centers: readonly WorksheetBAllocatedCenter[];
  readonly steps: readonly StepDownStepDetail[];
  /** Σ direct cost across every center (the conserved total). */
  readonly totalDirectCostCents: Cents;
  /** Σ final allocated cost across the direct centers (must equal `totalDirectCostCents`). */
  readonly totalAllocatedToDirectCents: Cents;
  /** True iff the direct-center totals tie to the conserved total to the cent (the step-down invariant). */
  readonly tiesOut: boolean;
}

/**
 * Step down the Worksheet A overhead-center costs onto the direct centers, producing Worksheet B. Each
 * overhead center, in `costCenters` order, allocates its ACCUMULATED cost (its own direct cost plus
 * whatever earlier overhead centers stepped into it) across every not-yet-closed center other than
 * itself, weighted by its statistical basis; the splits are penny-true so the total is conserved exactly.
 * Deterministic: the result depends only on the input ordering and values, never on map iteration order.
 */
export function stepDownAllocate(input: StepDownAllocateInput): StepDownAllocateResult {
  const { costCenters, statisticalBases } = input;

  // Accumulated cost per center, seeded with Worksheet A direct cost. Mutated as overhead steps down.
  const accumulated = new Map<string, Cents>();
  const allocatedIn = new Map<string, Cents>();
  for (const c of costCenters) {
    accumulated.set(c.code, c.directCostCents);
    allocatedIn.set(c.code, 0);
  }

  const basisByCenter = new Map<string, StatisticalBasis>();
  for (const b of statisticalBases) basisByCenter.set(b.allocatingCenterCode, b);

  const closed = new Set<string>();
  const steps: StepDownStepDetail[] = [];

  for (const allocator of costCenters) {
    if (!allocator.isOverhead) continue;

    const amountToAllocate = accumulated.get(allocator.code) ?? 0;

    // Receiving centers: every not-yet-closed center except the allocator itself, in input order.
    const receivers = costCenters.filter((c) => c.code !== allocator.code && !closed.has(c.code));

    const statLookup = new Map<string, number>();
    const basis = basisByCenter.get(allocator.code);
    if (basis) {
      for (const w of basis.weights) statLookup.set(w.receivingCenterCode, w.statisticValue);
    }
    const weights = receivers.map((r) => statLookup.get(r.code) ?? 0);

    const parts = allocateProportional(amountToAllocate, weights);

    const allocations: Array<{ receivingCenterCode: string; amountCents: Cents }> = [];
    for (let i = 0; i < receivers.length; i++) {
      const receiver = receivers[i]!;
      const part = parts[i]!;
      accumulated.set(receiver.code, (accumulated.get(receiver.code) ?? 0) + part);
      allocatedIn.set(receiver.code, (allocatedIn.get(receiver.code) ?? 0) + part);
      allocations.push({ receivingCenterCode: receiver.code, amountCents: part });
    }

    // The allocator is fully stepped out: its accumulated cost is now zero and it is closed to receipts.
    accumulated.set(allocator.code, 0);
    closed.add(allocator.code);
    steps.push({
      allocatingCenterCode: allocator.code,
      amountAllocatedCents: amountToAllocate,
      allocations,
    });
  }

  const centers: WorksheetBAllocatedCenter[] = costCenters.map((c) => ({
    code: c.code,
    name: c.name,
    isOverhead: c.isOverhead,
    directCostCents: c.directCostCents,
    allocatedInCents: allocatedIn.get(c.code) ?? 0,
    totalCostCents: accumulated.get(c.code) ?? 0,
  }));

  const totalDirectCostCents = sumCents(costCenters.map((c) => c.directCostCents));
  const totalAllocatedToDirectCents = sumCents(
    centers.filter((c) => !c.isOverhead).map((c) => c.totalCostCents),
  );

  return {
    centers,
    steps,
    totalDirectCostCents,
    totalAllocatedToDirectCents,
    tiesOut: totalDirectCostCents === totalAllocatedToDirectCents,
  };
}
