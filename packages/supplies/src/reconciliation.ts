// @chartwarden/supplies — the §2.6 / D8 controlled-substance return reconciliation math.
//
// This is the service-layer half of the "compute at the DB AND re-compute in the service" rule in §2.10:
// the `m21_compute_return_discrepancy()` BEFORE trigger owns the persisted values, and this function is
// what the reconciliation route computes to show the reconciler what they are about to sign. The two must
// agree exactly — hence Decimal, not float.
//
// SPEC READ (§3.0): D8's prose sketches a formula with an `expected_consumed_if_known` term. §3.1's trigger
// does not use one, and §3.1 is normative. The rule implemented here is §2.6's:
//     unaccounted = dispatched − returned − disposedAtHome
//     pct         = |unaccounted| / dispatched          (0 when dispatched is 0)
//     flagged     = isControlled AND pct >= 0.05
// A non-controlled line is never flagged at any shortfall: gloves get used.

import type { ControlledSubstanceSchedule } from "@chartwarden/types";
import { Decimal } from "decimal.js";

import { CONTROLLED_DISCREPANCY_THRESHOLD_PCT } from "./policy";

/** One line's inputs. Quantities are decimal STRINGS — they arrive from a `numeric` column and a 0.1 mL
 *  that round-trips through a JS float is not the number the DEA log recorded. */
export interface ReturnLineInput {
  readonly dispatchedQuantity: string;
  readonly quantityReturned: string;
  readonly quantityDisposedAtHome: string;
  readonly isControlledSubstance: boolean;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule | null;
}

export interface ReturnLineComputation {
  readonly quantityUnaccounted: string;
  /** Rounded to 6 decimal places — enough for any real kit quantity, and a fixed scale so the service and
   *  the trigger cannot disagree on the last digit. */
  readonly discrepancyPct: number;
  readonly discrepancyFlagged: boolean;
}

const PCT_SCALE = 6;

/** D8 — compute one reconciled line. */
export function computeReturnLine(line: ReturnLineInput): ReturnLineComputation {
  const dispatched = new Decimal(line.dispatchedQuantity);
  const returned = new Decimal(line.quantityReturned);
  const disposed = new Decimal(line.quantityDisposedAtHome);

  const unaccounted = dispatched.minus(returned).minus(disposed);

  // A zero dispatched quantity cannot happen through the schema (`exclusiveMinimum: 0`), but a divide-by-
  // zero here would be a 500 on a reconciliation screen. Zero dispatched means zero discrepancy.
  const pct = dispatched.isZero()
    ? new Decimal(0)
    : unaccounted.abs().dividedBy(dispatched).toDecimalPlaces(PCT_SCALE);

  return {
    quantityUnaccounted: unaccounted.toString(),
    discrepancyPct: pct.toNumber(),
    discrepancyFlagged:
      line.isControlledSubstance && pct.greaterThanOrEqualTo(CONTROLLED_DISCREPANCY_THRESHOLD_PCT),
  };
}

/**
 * §2.10 — a returned line may not account for more than went out. An over-return is a data-entry error or
 * a mixed-up kit, and either way the reconciler must resolve it before signing; letting it through would
 * write a NEGATIVE unaccounted quantity into the perpetual log.
 */
export function isReturnLineCoherent(line: ReturnLineInput): boolean {
  const dispatched = new Decimal(line.dispatchedQuantity);
  const accounted = new Decimal(line.quantityReturned).plus(line.quantityDisposedAtHome);
  return accounted.lessThanOrEqualTo(dispatched);
}

export interface ReturnReconciliationSummary {
  readonly lines: readonly ReturnLineComputation[];
  readonly discrepancyDetected: boolean;
  readonly flaggedLineCount: number;
}

/** Reconcile a whole return. `discrepancyDetected` drives the dispatch's terminal status
 *  (`reconciled` vs `reconciled_with_discrepancy`) and whether the D8 survey event fires. */
export function computeReturnReconciliation(
  lines: readonly ReturnLineInput[],
): ReturnReconciliationSummary {
  const computed = lines.map(computeReturnLine);
  const flaggedLineCount = computed.filter((l) => l.discrepancyFlagged).length;
  return { lines: computed, discrepancyDetected: flaggedLineCount > 0, flaggedLineCount };
}

/**
 * §2.6 — the witness-distinctness rule, mirroring the §3.1.10 CHECK.
 *
 * `dispose_at_home_by_witnessed_destruction` is the ONLY disposal method with no downstream custodian to
 * corroborate the count: nothing physically arrives anywhere afterwards. So it is the only one requiring a
 * witness, and that witness must differ from BOTH the retriever and the reconciler — a person cannot
 * corroborate their own count.
 */
export function isDisposalWitnessValid(input: {
  readonly disposalMethod:
    | "take_back_by_supply_team"
    | "dispose_at_home_by_witnessed_destruction"
    | "transferred_to_disposing_pharmacy";
  readonly disposalWitnessMembershipId: string | null;
  readonly assignedRetrievingMembershipId: string | null;
  readonly reconciledByMembershipId: string | null;
}): boolean {
  if (input.disposalMethod === "dispose_at_home_by_witnessed_destruction") {
    if (input.disposalWitnessMembershipId === null) return false;
  }
  if (input.disposalWitnessMembershipId === null) return true;
  return (
    input.disposalWitnessMembershipId !== input.reconciledByMembershipId &&
    input.disposalWitnessMembershipId !== input.assignedRetrievingMembershipId
  );
}
