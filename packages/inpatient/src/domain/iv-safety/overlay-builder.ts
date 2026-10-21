// @chartwarden/inpatient — M37-T05, §2.6 D7. Builds the `ipu_iv_safety_overlay` row from a signed
// `medication_iv_continuous` M11 order, and evaluates M13's pre-administration gate against it. This is the
// core that CLOSES the M13 (Wave-E) IV-pump-overlay deferral: M13's pre-administration gate consults the
// overlay via the `IpuIvSafetyOverlayProvider.getOverlayForOrder(orderId)` seam (bound in M37-T10) before
// letting an `iv_continuous_start` / `iv_continuous_rate_change` administration reach `committed`. Pure &
// IO-free — the M11 `order.signed` consumer (M37-T10) injects the order facts.
import { type M37ErrorCode, M37_ERROR_STATUS } from "../../errors";
import type { IvRateUnit } from "../gip-criteria/schema";
import {
  DEFAULT_TITRATION_WINDOW,
  isSeededMedication,
  resolveTitrationWindow,
} from "./titration-window-catalog";

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

/** The prescriber's own titration bounds on the M12 order (`sigStructured.ivContinuousPolicy`). */
export interface IvOrderPolicy {
  readonly minRate: number;
  readonly maxRate: number;
  readonly rateUnit?: string;
}

/** The order facts the `order.signed` consumer injects. */
export interface IvOrderFacts {
  readonly medicationDisplayName: string;
  /** M12 `iv_continuous_max_duration_hours` if present, else the platform floor applies. */
  readonly m12MaxDurationHours?: number;
  /**
   * The prescriber's bounds, used ONLY for a medication the platform catalog does not seed: an unseeded drug
   * would otherwise get an unbounded window (the catalog default), so the order's own stated bounds are the
   * most conservative bound the platform has. A seeded drug keeps the catalog window.
   */
  readonly orderPolicy?: IvOrderPolicy;
}

/** Spellings a clinician or pump interface uses, after {@link normalizeIvRateUnit}'s punctuation folding. */
const RATE_UNIT_ALIASES: Readonly<Record<string, IvRateUnit>> = {
  mg_per_hour: "mg_per_hour",
  mg_hour: "mg_per_hour",
  mg_hr: "mg_per_hour",
  mg_h: "mg_per_hour",
  mcg_per_kg_per_min: "mcg_per_kg_per_min",
  mcg_kg_min: "mcg_per_kg_per_min",
  mcg_kg_minute: "mcg_per_kg_per_min",
  units_per_hour: "units_per_hour",
  units_hour: "units_per_hour",
  units_hr: "units_per_hour",
  u_hr: "units_per_hour",
  ml_per_hour: "ml_per_hour",
  ml_hour: "ml_per_hour",
  ml_hr: "ml_per_hour",
  ml_h: "ml_per_hour",
};

/**
 * Canonicalize a clinician-entered rate unit (`mg/hr`, `mg / hour`, `MG_PER_HOUR`) to an {@link IvRateUnit},
 * or `null` when it is not one the overlay knows. A unit that cannot be recognized must never be compared
 * numerically against an overlay window, so callers treat `null` as a mismatch.
 */
export function normalizeIvRateUnit(raw: string | null | undefined): IvRateUnit | null {
  if (typeof raw !== "string") return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return RATE_UNIT_ALIASES[key] ?? null;
}

/**
 * §2.6 — build the IV-safety overlay for a signed IV-continuous order. Sedation-class drips get
 * `dual_witness_required=true` and the q-1h bedside cadence; the max continuous duration comes from M12 when
 * available, else the 168h floor.
 */
export function buildIvSafetyOverlay(order: IvOrderFacts): IvSafetyOverlayFields {
  const catalogWindow = resolveTitrationWindow(order.medicationDisplayName);
  const policy = order.orderPolicy;
  const useOrderBounds =
    policy !== undefined &&
    !isSeededMedication(order.medicationDisplayName) &&
    Number.isFinite(policy.minRate) &&
    Number.isFinite(policy.maxRate) &&
    policy.minRate <= policy.maxRate;
  const window = useOrderBounds
    ? {
        ...catalogWindow,
        minRate: policy.minRate,
        maxRate: policy.maxRate,
        rateUnit: normalizeIvRateUnit(policy.rateUnit) ?? DEFAULT_TITRATION_WINDOW.rateUnit,
      }
    : catalogWindow;
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
  /**
   * The proposed infusion rate (for an `iv_continuous_start` / `iv_continuous_rate_change`). `null` = the
   * administration named no usable rate, which the gate refuses: a rate nobody stated is not in any window.
   */
  readonly proposedRate: number | null;
  /** The unit the rate was entered in, when the administration carries one; a mismatch is refused. */
  readonly proposedRateUnit?: string | null;
  /** Whether a dual-witness HMAC token is attached to the administration. */
  readonly witnessTokenPresent: boolean;
  /** Hours the infusion has been running continuously. */
  readonly hoursSinceContinuousStart: number;
  /** Minutes since the last bedside observation / rate-change event. */
  readonly minutesSinceLastBedsideCheck: number;
  /** A rate change (titration) is exempt from the overdue-bedside-check refusal; see the M37 spec changelog. */
  readonly isTitration?: boolean;
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
 * max continuous duration not exceeded → bedside check not overdue (a titration is exempt from the last). Returns the first failing 412 code, or
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

  if (event.proposedRate === null || !Number.isFinite(event.proposedRate)) {
    return deny("IV_RATE_OUTSIDE_TITRATION_WINDOW");
  }
  if (
    event.proposedRateUnit != null &&
    normalizeIvRateUnit(event.proposedRateUnit) !== overlay.rateUnit
  ) {
    return deny("IV_RATE_OUTSIDE_TITRATION_WINDOW");
  }
  if (
    event.proposedRate < overlay.titrationMinRate ||
    event.proposedRate > overlay.titrationMaxRate
  ) {
    return deny("IV_RATE_OUTSIDE_TITRATION_WINDOW");
  }
  if (overlay.dualWitnessRequired && !event.witnessTokenPresent) {
    return deny("IV_DUAL_WITNESS_REQUIRED");
  }
  if (event.hoursSinceContinuousStart > overlay.maxContinuousDurationHours) {
    return deny("IV_MAX_CONTINUOUS_DURATION_REACHED");
  }
  if (
    !event.isTitration &&
    event.minutesSinceLastBedsideCheck > overlay.bedsideCheckIntervalMinutes
  ) {
    return deny("IV_BEDSIDE_CHECK_OVERDUE");
  }
  return { allowed: true };
}

/** §4.8 — the `iv-bedside-check-watchdog` cadence (every 5 minutes). */
export const IV_BEDSIDE_WATCHDOG_TICK_MINUTES = 5;

export interface IvBedsideReminderPlan {
  /** The check is overdue (the same strict `>` the pre-administration gate uses). */
  readonly overdue: boolean;
  /** How many whole check intervals have elapsed without a check. */
  readonly missedIntervals: number;
  readonly minutesOverdue: number;
  /** This tick is the one that crosses an interval boundary: notify now, not on every tick. */
  readonly notify: boolean;
}

/**
 * §2.6 — decide whether this watchdog tick owes a bedside-check-overdue notification. The cron runs every
 * {@link IV_BEDSIDE_WATCHDOG_TICK_MINUTES} minutes, so notifying on every tick of an overdue overlay would raise
 * ~12 notifications an hour for one lapse. Instead the notification fires on the single tick that first crosses the interval
 * and again each further whole interval (a recurring reminder), i.e. when the minutes past the latest
 * interval boundary fall in `(0, tick]` — a half-open window each 5-minute tick lands in exactly once.
 */
export function planBedsideCheckReminder(input: {
  readonly intervalMinutes: number;
  readonly minutesSinceLastCheck: number;
}): IvBedsideReminderPlan {
  const { intervalMinutes, minutesSinceLastCheck } = input;
  const overdue = minutesSinceLastCheck > intervalMinutes;
  if (!overdue || intervalMinutes <= 0) {
    return { overdue: false, missedIntervals: 0, minutesOverdue: 0, notify: false };
  }
  const missedIntervals = Math.floor(minutesSinceLastCheck / intervalMinutes);
  const phase = minutesSinceLastCheck - missedIntervals * intervalMinutes;
  return {
    overdue,
    missedIntervals,
    minutesOverdue: minutesSinceLastCheck - intervalMinutes,
    notify: phase > 0 && phase <= IV_BEDSIDE_WATCHDOG_TICK_MINUTES,
  };
}

const IV_CONTINUOUS_ROUTES: ReadonlySet<string> = new Set([
  "iv_continuous",
  "continuous_iv",
  "intravenous_continuous",
  "continuous_intravenous",
]);

/**
 * §2.6 — is this M12 medication order a continuous IV infusion? M12's spec names the route
 * `administration_route='iv_continuous'` (M12 §forward-seam); an order that states `ivContinuousPolicy`
 * titration bounds is by definition an infusion order whatever its route spelling. A plain `intravenous`
 * push or scheduled IV dose is NOT continuous and gets no overlay.
 */
export function isIvContinuousOrder(order: {
  readonly route: string;
  readonly hasIvContinuousPolicy: boolean;
}): boolean {
  if (order.hasIvContinuousPolicy) return true;
  const key = order.route
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return IV_CONTINUOUS_ROUTES.has(key);
}
