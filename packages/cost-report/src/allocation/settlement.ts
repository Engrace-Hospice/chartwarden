// @wardenx/cost-report — M27 Worksheet E-1 SETTLEMENT (§1.1, §4.4 M26 cap readers, D8, D13).
// The final hop of the propagation chain (A → B → C → D → E-1): the Medicare allowable cost from
// Worksheet D is reconciled against interim payments to a settlement balance — the amount due to, or
// owed back by, the provider. The settlement layers the statutory adjustments in order: the Service
// Intensity Add-on (SIA) credit, the sequestration payment reduction, the aggregate-cap overage
// liability (42 CFR §418.308), and the inpatient-cap adjustment (42 CFR §418.309). Every line is whole
// cents; the only fractional step (the sequestration rate) runs through the money kernel and rounds to
// the cent half-up.
//
// CAP INPUTS ARE OPTIONAL FORWARD SEAMS. The aggregate-cap and inpatient-cap inputs are produced by
// M26's `CapAccrualReader` / `CapPeriodReader`, which are forward-seam deny-stubs at M27 lock (D13).
// When an input is ABSENT this function does NOT fabricate a cap number — it omits the cap line and sets
// `capPositionPending: true`. The cap lines appear only once M26 delivers real accruals.
//
// PURE DOMAIN, deterministic total function over an already-fetched input: no Fastify, no Drizzle/DB, no
// BullMQ, no `@wardenx/db`, no `getSeam`. Money is INTEGER CENTS at the boundary. No PHI — aggregate
// financial/statistical only (D18).
import { fromDecimal, toDecimal } from "../domain/money";
import type { Cents } from "../domain/money";

/**
 * Aggregate-cap inputs from M26 (`CapAccrualReader` / `CapPeriodReader`), cap-year aligned. The overage
 * (the amount Medicare payments exceed the aggregate cap) is a liability the provider owes back.
 */
export interface AggregateCapInput {
  readonly capYear: number;
  readonly medicareBeneficiaryCount: number;
  /** Per-beneficiary cap × beneficiary count, computed by M26 — NOT fabricated here. */
  readonly aggregateCapAmountCents: Cents;
  /** Medicare payments counted against the cap for the cap year (from M26). */
  readonly totalMedicarePaymentsCents: Cents;
}

/**
 * Inpatient-cap inputs from M26 (42 CFR §418.309): inpatient days (GIP + IRC) may not exceed a statutory
 * percentage of total Medicare days. The percentage is passed in (NOT hardcoded) so a regulatory change
 * is a data change. `inpatientLimitCents`, when present, is the M26-computed payment ceiling for
 * inpatient days; absent it, the exact payment reduction is not computed here (see the TODO below).
 */
export interface InpatientCapInput {
  readonly capYear: number;
  readonly totalMedicareDays: number;
  readonly inpatientDays: number;
  /** Statutory inpatient-day percentage (e.g. 20). Passed in, never hardcoded. */
  readonly inpatientCapPercent: number;
  readonly inpatientPaymentsCents: Cents;
  /** Optional M26-computed inpatient payment ceiling. */
  readonly inpatientLimitCents?: Cents;
}

/** The fully-fetched Worksheet E-1 input. Cap inputs are optional forward seams (M26 deny-stubs). */
export interface SettlementInput {
  /** Total Medicare allowable cost from Worksheet D. */
  readonly medicareAllowableCostCents: Cents;
  /** Interim payments already received from Medicare for the fiscal year. */
  readonly interimPaymentsCents: Cents;
  /** Service Intensity Add-on credit (last-7-days skilled RHC visits). */
  readonly siaAddOnCents?: Cents;
  /**
   * Sequestration payment-reduction rate in MICRO-units (parts per 1,000,000): 20000 = 2.0000%. Passed
   * in, never hardcoded — the rate and its sunset are statutory and change over time.
   */
  readonly sequestrationRateMicros?: number;
  readonly aggregateCap?: AggregateCapInput;
  readonly inpatientCap?: InpatientCapInput;
}

/** One settlement line. `amountCents` is SIGNED: positive increases the balance due to the provider. */
export interface SettlementLine {
  readonly code: string;
  readonly label: string;
  readonly amountCents: Cents;
}

/** Resolved inpatient-cap position (only present when the inpatient-cap input is supplied). */
export interface InpatientCapPosition {
  readonly capYear: number;
  readonly capDays: number;
  readonly excessDays: number;
  readonly exceeded: boolean;
  readonly reductionCents: Cents;
}

/** Resolved aggregate-cap position (only present when the aggregate-cap input is supplied). */
export interface AggregateCapPosition {
  readonly capYear: number;
  readonly overageCents: Cents;
}

/** The Worksheet E-1 settlement result: ordered lines plus the named settlement totals. */
export interface SettlementResult {
  readonly lines: readonly SettlementLine[];
  readonly siaAddOnCents: Cents;
  readonly sequestrationReductionCents: Cents;
  readonly aggregateCap: AggregateCapPosition | null;
  readonly inpatientCap: InpatientCapPosition | null;
  /** True iff either cap input was absent (M26 deny-stub): the cap lines were skipped, NOT fabricated. */
  readonly capPositionPending: boolean;
  /** Net reimbursable Medicare cost after SIA, sequestration, and any cap adjustments. */
  readonly netReimbursableCostCents: Cents;
  /** Net reimbursable − interim payments. Positive = Medicare owes the provider; negative = provider owes. */
  readonly balanceDueToProviderCents: Cents;
}

/**
 * Compute the Worksheet E-1 settlement deterministically. Lines are emitted in fixed order; the cap
 * lines are included ONLY when their M26 input is present (otherwise `capPositionPending` is set and the
 * cap math is skipped, never fabricated). Sequestration is the rate (micros) applied to the
 * post-SIA Medicare payment and rounded to the cent half-up by the money kernel.
 *
 * CMS-CERT (see audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md): sequestration is correctly a per-FY INPUT,
 * not a constant — 2% under the Budget Control Act of 2011, but SUSPENDED 2020-05-01→2022-03-31 (CARES Act),
 * 1% 2022-04-01→06-30, 2% thereafter; a report spanning that window must pass its period's rate. The exact
 * sequestration BASE line + rounding granularity, and the inpatient-cap payment-REDUCTION formula when
 * `inpatientLimitCents` is absent, are PENDING confirmation against CMS Pub 15-2 Ch.43 (Form CMS-1984-14,
 * transmittal R8P243/R5P247) — the math ties out internally to the cent against its own inputs today.
 */
export function computeSettlement(input: SettlementInput): SettlementResult {
  const siaAddOnCents = input.siaAddOnCents ?? 0;

  // Sequestration applies to the post-SIA Medicare payment. Rate is micro-units; round half-up to cents.
  const preSequestrationCents = input.medicareAllowableCostCents + siaAddOnCents;
  const sequestrationReductionCents =
    input.sequestrationRateMicros && input.sequestrationRateMicros > 0
      ? fromDecimal(toDecimal(preSequestrationCents).times(input.sequestrationRateMicros).div(1_000_000))
      : 0;

  const lines: SettlementLine[] = [
    { code: "E1.01", label: "Total Medicare allowable cost (Worksheet D)", amountCents: input.medicareAllowableCostCents },
    { code: "E1.02", label: "Service Intensity Add-on (SIA)", amountCents: siaAddOnCents },
    { code: "E1.03", label: "Sequestration payment reduction", amountCents: -sequestrationReductionCents },
  ];

  let netReimbursableCostCents = input.medicareAllowableCostCents + siaAddOnCents - sequestrationReductionCents;

  // Aggregate cap (42 CFR §418.308): overage is a liability owed back to Medicare.
  let aggregateCap: AggregateCapPosition | null = null;
  if (input.aggregateCap) {
    const overageCents = Math.max(
      0,
      input.aggregateCap.totalMedicarePaymentsCents - input.aggregateCap.aggregateCapAmountCents,
    );
    aggregateCap = { capYear: input.aggregateCap.capYear, overageCents };
    lines.push({ code: "E1.04", label: "Aggregate-cap overage (42 CFR §418.308)", amountCents: -overageCents });
    netReimbursableCostCents -= overageCents;
  }

  // Inpatient cap (42 CFR §418.309): inpatient days capped at a statutory % of total Medicare days.
  let inpatientCap: InpatientCapPosition | null = null;
  if (input.inpatientCap) {
    const ic = input.inpatientCap;
    const capDays = Math.floor((ic.totalMedicareDays * ic.inpatientCapPercent) / 100);
    const excessDays = Math.max(0, ic.inpatientDays - capDays);
    // Only compute a reduction when M26 supplied the payment ceiling; never fabricate one otherwise.
    const reductionCents =
      ic.inpatientLimitCents !== undefined ? Math.max(0, ic.inpatientPaymentsCents - ic.inpatientLimitCents) : 0;
    inpatientCap = { capYear: ic.capYear, capDays, excessDays, exceeded: excessDays > 0, reductionCents };
    lines.push({ code: "E1.05", label: "Inpatient-cap adjustment (42 CFR §418.309)", amountCents: -reductionCents });
    netReimbursableCostCents -= reductionCents;
  }

  const capPositionPending = input.aggregateCap === undefined || input.inpatientCap === undefined;

  lines.push({ code: "E1.06", label: "Net reimbursable Medicare cost", amountCents: netReimbursableCostCents });
  lines.push({ code: "E1.07", label: "Interim payments received", amountCents: -input.interimPaymentsCents });

  const balanceDueToProviderCents = netReimbursableCostCents - input.interimPaymentsCents;
  lines.push({
    code: "E1.08",
    label: "Balance due to / (from) provider",
    amountCents: balanceDueToProviderCents,
  });

  return {
    lines,
    siaAddOnCents,
    sequestrationReductionCents,
    aggregateCap,
    inpatientCap,
    capPositionPending,
    netReimbursableCostCents,
    balanceDueToProviderCents,
  };
}
