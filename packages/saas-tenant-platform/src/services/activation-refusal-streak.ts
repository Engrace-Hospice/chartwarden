// Consecutive-daily-refusal counter for the onboarding sweep's automatic `onboarding -> active`.
//
// A daily cron worker is stateless, so the streak lives in `tenant_account.metadata` (an existing jsonb column;
// tenant_account is SELECT-only for tenant roles, so only the platform credential can write it). Only the
// lifecycle guard's own code is ever recorded as the reason - never tenant-written status. Pure reducer; the
// platform service persists the result inside the same locked transaction as the guard evaluation.

/** Consecutive daily refusals (same reason) before an operator alert is raised. */
export const ACTIVATION_REFUSAL_ALERT_THRESHOLD = 3;

export const ACTIVATION_REFUSAL_METADATA_KEY = "onboardingActivationRefusal";

export interface ActivationRefusalState {
  readonly reason: string;
  readonly days: number;
  /** UTC calendar day (YYYY-MM-DD) of the most recent counted refusal. */
  readonly lastDay: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function readState(stored: unknown): ActivationRefusalState | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { reason, days, lastDay } = stored as Record<string, unknown>;
  if (typeof reason !== "string" || reason.length === 0) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) return null;
  if (typeof lastDay !== "string" || !ISO_DAY.test(lastDay)) return null;
  return { reason, days, lastDay };
}

function isNextDay(prevDay: string, day: string): boolean {
  return Date.parse(`${day}T00:00:00Z`) - Date.parse(`${prevDay}T00:00:00Z`) === DAY_MS;
}

/**
 * Fold today's refusal into the stored streak. `advanced` is false for a same-day retry (no double count, so no
 * second alert); a changed reason or a skipped day restarts the streak at 1.
 */
export function nextActivationRefusal(
  stored: unknown,
  reason: string,
  day: string,
): { readonly state: ActivationRefusalState; readonly advanced: boolean } {
  const prev = readState(stored);
  if (prev && prev.reason === reason && prev.lastDay === day) {
    return { state: prev, advanced: false };
  }
  const continues = prev !== null && prev.reason === reason && isNextDay(prev.lastDay, day);
  return { state: { reason, days: continues ? prev.days + 1 : 1, lastDay: day }, advanced: true };
}

export function readActivationRefusal(
  metadata: Record<string, unknown>,
): ActivationRefusalState | null {
  return readState(metadata[ACTIVATION_REFUSAL_METADATA_KEY]);
}

export function withActivationRefusal(
  metadata: Record<string, unknown>,
  state: ActivationRefusalState,
): Record<string, unknown> {
  return { ...metadata, [ACTIVATION_REFUSAL_METADATA_KEY]: state };
}

export function withoutActivationRefusal(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { [ACTIVATION_REFUSAL_METADATA_KEY]: _dropped, ...rest } = metadata;
  return rest;
}
