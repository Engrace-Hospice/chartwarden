// @wardenx/inpatient — M37-T05, §2.6 D7. Builds the `ipu_iv_safety_overlay` row from a signed
// `medication_iv_continuous` M11 order, and evaluates M13's pre-administration gate against it. This is the
// core that CLOSES the M13 (Wave-E) IV-pump-overlay deferral: M13's pre-administration gate consults the
// overlay via the `IpuIvSafetyOverlayProvider.getOverlayForOrder(orderId)` seam (bound in M37-T10) before
// letting an `iv_continuous_start` / `iv_continuous_rate_change` administration reach `committed`. Pure &
// IO-free — the M11 `order.signed` consumer (M37-T10) injects the order facts.
import { M37_ERROR_STATUS, type M37ErrorCode } from "../../errors";
import { type IvRateUnit } from "../gip-criteria/schema";
import { resolveTitrationWindow } from "./titration-window-catalog";

/** §2.6 platform-floor max continuous infusion duration (hours) when M12 supplies no per-med value. */
export const IV_MAX_CONTINUOUS_DURATION_FLOOR_HOURS = 168;
/** §2.6 — bedside-check cadence: q-1h for sedation-class, q-2h otherwise (platform floor; tenant tighten-only). */
export const IV_BEDSIDE_CHECK_SEDATION_MINUTES = 60;
export const IV_BEDSIDE_CHECK_NON_SEDATION_MINUTES = 120;

/** The computed overlay fields (mirror the ipu_iv_safety_overlay row the T11 service persists). */
export interface IvSafetyOverlayFields {
  readonly titrationMinRate: number;
  readonly titrationMaxRate: number;
  readonly rateUnit: IvRateUnit;
  readonly dualWitnessRequired: boolean;
  readonly maxContinuousDurationHours: number;
  readonly bedsideCheckIntervalMinutes: number;
  readonly isSedationClass: boolean;
}

/** The order facts the M11 `order.signed` consumer injects. */
export interface IvOrderFacts {
  readonly medicationDisplayName: string;
  /** M12 `iv_continuous_max_duration_hours` if present, else the platform floor applies. */
  readonly m12MaxDurationHours?: number;
}

/**
 * §2.6 — build the IV-safety overlay for a signed IV-continuous order. Sedation-class drips get
 * `dual_witness_required=true` and the q-1h bedside cadence; the max continuous duration comes from M12 when
 * available, else the 168h floor.
 */
export function buildIvSafetyOverlay(order: IvOrderFacts): IvSafetyOverlayFields {
  const window = resolveTitrationWindow(order.medicationDisplayName);
  return {
    titrationMinRate: window.minRate,
    titrationMaxRate: window.maxRate,
    rateUnit: window.rateUnit,
    dualWitnessRequired: window.isSedationClass,
    maxContinuousDurationHours: order.m12MaxDurationHours ?? IV_MAX_CONTINUOUS_DURATION_FLOOR_HOURS,
    bedsideCheckIntervalMinutes: window.isSedationClass
      ? IV_BEDSIDE_CHECK_SEDATION_MINUTES
      : IV_BEDSIDE_CHECK_NON_SEDATION_MINUTES,
    isSedationClass: window.isSedationClass,
  };
}

/** The administration event M13's pre-administration gate presents to the overlay. */
export interface IvAdministrationEvent {
  /** The proposed infusion rate (for an `iv_continuous_start` / `iv_continuous_rate_change`). */
  readonly proposedRate: number;
  /** Whether a dual-witness HMAC token is attached to the administration. */
  readonly witnessTokenPresent: boolean;
  /** Hours the infusion has been running continuously. */
  readonly hoursSinceContinuousStart: number;
  /** Minutes since the last bedside observation / rate-change event. */
  readonly minutesSinceLastBedsideCheck: number;
}

/** The gate verdict — allowed, or the precise §2.6 412 code M13 surfaces. */
export interface IvGateVerdict {
  readonly allowed: boolean;
  readonly code?: M37ErrorCode;
  readonly statusCode?: number;
}

/**
 * §2.6 — M13's pre-administration gate: may an `iv_continuous_start` / `iv_continuous_rate_change` reach
 * `committed`? Checks, in order: rate within titration window → dual-witness present for sedation drips →
 * max continuous duration not exceeded → bedside check not overdue. Returns the first failing 412 code, or
 * `{ allowed: true }`. M13 consumes this through the `IpuIvSafetyOverlayProvider` seam.
 */
export function evaluateIvPreAdministration(
  overlay: IvSafetyOverlayFields,
  event: IvAdministrationEvent,
): IvGateVerdict {
  const deny = (code: M37ErrorCode): IvGateVerdict => ({
    allowed: false,
    code,
    statusCode: M37_ERROR_STATUS[code],
  });

  if (event.proposedRate < overlay.titrationMinRate || event.proposedRate > overlay.titrationMaxRate) {
    return deny("IV_RATE_OUTSIDE_TITRATION_WINDOW");
  }
  if (overlay.dualWitnessRequired && !event.witnessTokenPresent) {
    return deny("IV_DUAL_WITNESS_REQUIRED");
  }
  if (event.hoursSinceContinuousStart > overlay.maxContinuousDurationHours) {
    return deny("IV_MAX_CONTINUOUS_DURATION_REACHED");
  }
  if (event.minutesSinceLastBedsideCheck > overlay.bedsideCheckIntervalMinutes) {
    return deny("IV_BEDSIDE_CHECK_OVERDUE");
  }
  return { allowed: true };
}
