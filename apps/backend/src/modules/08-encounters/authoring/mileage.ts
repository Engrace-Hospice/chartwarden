// apps/backend/src/modules/08-encounters/authoring/mileage.ts — M8-T10 (§2.2 D10, §3.3 `mileage`).
//
// Pure per-encounter mileage authoring (D10): M8 stores the AUTHORITATIVE number that payroll/AP (M27 +
// tenant integration) reads — never M17's proposal. The source is one of odometer (computed end−start),
// route_calc (M17's proposed figure accepted as-is), or manual_override (a clinician-entered figure that
// demands a documented reason ≥ 20 chars — the `mileage_override_reason_required` DB CHECK mirrored as a
// guard). No IO: the service supplies the input, persists the (0..1-per-encounter) row, and runs the
// returned §2.8 effects inside the encounter's optimistic-locked transaction.
import type { EncounterSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";

/** Minimum free-text length for the D10 manual-override reason (also a DB CHECK). */
export const MILEAGE_OVERRIDE_REASON_MIN = 20;

/** Where the authoritative `miles_driven` came from (mirrors `miles_driven_source`, §2.2 D10). */
export type MilesDrivenSource = "odometer" | "route_calc" | "manual_override";

/** The clinician-supplied mileage payload (D10; numerics-as-text preserve precision). */
export interface MileageInput {
  readonly odometerStart?: number | null;
  readonly odometerEnd?: number | null;
  /** Required for `route_calc` / `manual_override`; for `odometer` it is computed from the readings. */
  readonly milesDriven?: string | null;
  readonly source: MilesDrivenSource;
  readonly manualOverrideReason?: string | null;
  /** M17's route-optimization proposal, if any (stored for audit; never the authoritative number). */
  readonly routeProposedMiles?: string | null;
}

/** The resolved mileage facts + the §2.8 effects a capture declares (the service executes them). */
export interface MileageCapturePlan {
  readonly milesDriven: string;
  readonly source: MilesDrivenSource;
  /** §2.8: audit the row + publish `m8.mileage.captured` in the same tx. */
  readonly effects: readonly EncounterSideEffect[];
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isText = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** §3.3 `mileage_*` CHECK envelopes mirrored as guards (precise 422 before the write). */
export function validateMileage(input: MileageInput): void {
  if (isNum(input.odometerStart) && isNum(input.odometerEnd)) {
    require_(
      input.odometerEnd >= input.odometerStart,
      "MILEAGE_ODOMETER_ORDER",
      "odometer_end must be ≥ odometer_start",
    );
  }
  if (input.source === "manual_override") {
    require_(
      (input.manualOverrideReason?.trim().length ?? 0) >= MILEAGE_OVERRIDE_REASON_MIN,
      "MILEAGE_OVERRIDE_REASON_REQUIRED",
      `a manual mileage override requires a reason ≥ ${MILEAGE_OVERRIDE_REASON_MIN} characters`,
    );
  }
}

/** Resolve the authoritative `miles_driven` for the declared source (D10). */
export function resolveMiles(input: MileageInput): string {
  if (input.source === "odometer" && isNum(input.odometerStart) && isNum(input.odometerEnd)) {
    return String(input.odometerEnd - input.odometerStart);
  }
  if (isText(input.milesDriven)) return input.milesDriven.trim();
  // Odometer source without a complete pair, or a missing explicit figure → 0 (a documented zero-mile visit).
  return "0";
}

/** Validate + resolve a mileage capture (§2.2 D10). Throws the §2.7 code on an order/reason violation. */
export function planMileageCapture(input: MileageInput): MileageCapturePlan {
  validateMileage(input);
  return {
    milesDriven: resolveMiles(input),
    source: input.source,
    effects: [{ kind: "audit" }, { kind: "outbox", event: "m8.mileage.captured" }],
  };
}
