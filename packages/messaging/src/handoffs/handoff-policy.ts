// M36 WP 3.5 - the tenant handoff policy: how long an offer stays open. Tighten-only: the platform value is also the
// ceiling, a tenant may only SHORTEN it. `effectiveHandoffMinutes` re-applies the bounds on EVERY read, so a stored value
// written under an older ceiling, or edited in the database, can never loosen the current one. PROVISIONAL numbers.
import {
  HANDOFF_EXPIRY_MIN_MINUTES,
  HANDOFF_EXPIRY_PLATFORM_MINUTES,
  type HandoffPolicyView,
  ChartWardenError,
} from "@wardenx/types";

/** The minutes in force: the platform ceiling, tightened by the stored row (when there is one). */
export function effectiveHandoffMinutes(stored: number | null): number {
  if (stored === null || !Number.isFinite(stored)) return HANDOFF_EXPIRY_PLATFORM_MINUTES;
  return Math.min(
    HANDOFF_EXPIRY_PLATFORM_MINUTES,
    Math.max(HANDOFF_EXPIRY_MIN_MINUTES, Math.floor(stored)),
  );
}

/** Validate a policy write: a whole number of minutes in [15, 240]. Anything else is 422 HANDOFF_POLICY_INVALID. */
export function prepareHandoffPolicy(minutes: unknown): number {
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < HANDOFF_EXPIRY_MIN_MINUTES ||
    minutes > HANDOFF_EXPIRY_PLATFORM_MINUTES
  ) {
    throw new ChartWardenError(
      "HANDOFF_POLICY_INVALID",
      "handoff expiry must be a whole number of minutes within the allowed range",
      422,
    );
  }
  return minutes;
}

export function handoffPolicyView(stored: number | null): HandoffPolicyView {
  return {
    expiry_minutes: effectiveHandoffMinutes(stored),
    platform_max_minutes: HANDOFF_EXPIRY_PLATFORM_MINUTES,
    customised: stored !== null,
  };
}
