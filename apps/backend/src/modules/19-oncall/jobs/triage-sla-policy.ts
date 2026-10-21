// apps/backend/src/modules/19-oncall/jobs/triage-sla-policy.ts — the PURE threshold readers behind the four
// non-Tier-1 §4.8 crons. `tenant_oncall_policy` stores its SLA knobs as free-form `jsonb`
// (`callback_sla_per_severity`, `escalation_tiers`, `state_overrides`), and the spec fixes only the example
// shape of the first (`{clinical_urgent:30, clinical_routine:120, operational:240}` minutes). Each reader
// therefore accepts what a tenant plausibly wrote and falls back to a platform default for anything else —
// a malformed policy must tighten toward the default, never disable a page.
import type { TriageEscalationTier } from "@chartwarden/types";
import {
  TRIAGE_AWAITING_CALLBACK_GRACE_MINUTES,
  TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES,
  TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES,
} from "@chartwarden/types";

/** A mandatory (D7) escalation is held to the tightest tier default whatever the tenant ladder says — the
 *  tenant may not slow the page for a suicidal-ideation or code-blue handoff. */
export const MANDATORY_ESCALATION_SLA_CEILING_MINUTES = Math.min(
  ...Object.values(TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES),
);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A positive whole number of minutes, or null (a non-number, zero, negative, NaN or Infinity is unusable). */
function positiveMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const whole = Math.floor(value);
  return whole >= 1 ? whole : null;
}

/**
 * §4.8 `callback-sla.cron` — the callback target for a call. The call carries no severity column, so the
 * conservative reading is the TIGHTEST target the tenant defined (`clinical_urgent` when present, else the
 * smallest usable value), falling back to the platform floor. Paging a routine call a little early is a
 * nuisance; paging an urgent one late is the failure the cron exists to prevent.
 */
export function resolveCallbackSlaMinutes(callbackSlaPerSeverity: unknown): number {
  if (!isRecord(callbackSlaPerSeverity)) return TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES;
  const urgent = positiveMinutes(callbackSlaPerSeverity.clinical_urgent);
  if (urgent !== null) return urgent;
  const usable = Object.values(callbackSlaPerSeverity)
    .map(positiveMinutes)
    .filter((m): m is number => m !== null);
  return usable.length > 0 ? Math.min(...usable) : TRIAGE_CALLBACK_SLA_DEFAULT_MINUTES;
}

/**
 * §4.8 `awaiting-callback-timeout.cron` — how long a call may wait in `awaiting_callback`. The spec's
 * "tenant-configured grace (default 60 min)" has no column of its own, so a tenant sets it in
 * `state_overrides` (`awaitingCallbackGraceMinutes`), which is TIGHTEN-ONLY: a larger value is ignored.
 */
export function resolveAwaitingCallbackGraceMinutes(stateOverrides: unknown): number {
  if (!isRecord(stateOverrides)) return TRIAGE_AWAITING_CALLBACK_GRACE_MINUTES;
  const configured = positiveMinutes(
    stateOverrides.awaitingCallbackGraceMinutes ?? stateOverrides.awaiting_callback_grace_minutes,
  );
  return configured === null
    ? TRIAGE_AWAITING_CALLBACK_GRACE_MINUTES
    : Math.min(configured, TRIAGE_AWAITING_CALLBACK_GRACE_MINUTES);
}

/**
 * §4.8 `escalation-sla` — minutes a tier's escalation may stay unacknowledged: the tenant ladder's
 * `escalation_tiers[tier].slaMinutes` when usable, else the platform default for the tier; a mandatory (D7)
 * row is additionally capped at {@link MANDATORY_ESCALATION_SLA_CEILING_MINUTES}.
 */
export function resolveEscalationSlaMinutes(
  escalationTiers: unknown,
  tier: TriageEscalationTier,
  mandatory: boolean,
): number {
  const entry = isRecord(escalationTiers) ? escalationTiers[tier] : undefined;
  const configured = isRecord(entry)
    ? positiveMinutes(entry.slaMinutes ?? entry.sla_minutes)
    : null;
  const base = configured ?? TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES[tier];
  return mandatory ? Math.min(base, MANDATORY_ESCALATION_SLA_CEILING_MINUTES) : base;
}
