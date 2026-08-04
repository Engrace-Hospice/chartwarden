// apps/backend/src/modules/31-portal/telehealth/fallback.ts — M31-T05 (§7.3 D14 Tier-3 degraded mode).
//
// The D14 audio-only-fallback decision as a PURE planner. The route/session layer (M31-T07) feeds it the live
// facts — how many video-connect attempts failed, and (if the vendor circuit is open) when it opened — and the
// planner returns ONE of three plans:
//   • continue              — below the attempt floor; keep trying video.
//   • offer_audio_only      — the §7.3 affordance surfaces ("Switch to audio only"); the room stays, the
//                             CLIENT disables its video tracks, the row records `audio_only_fallback_active`.
//   • reschedule_in_person  — the breaker has been open past the 5-minute ceiling (D14): the visit is
//                             rescheduled to in-person via M17.
//
// Critical invariant (§7.3): NONE of these blocks the chart-writing path — the plan is advisory routing only.
// No clock is captured: the caller passes `nowMs` (and `breakerOpenedAtMs`), so every plan is reproducible.

/** §6.4 platform floor: audio-only offered after 2 failed connect attempts; tenants may TIGHTEN to 1. */
export const AUDIO_ONLY_ATTEMPT_FLOOR = 2;

/** D14 — the breaker-open ceiling past which the visit reschedules to in-person (5 minutes). */
export const BREAKER_OPEN_RESCHEDULE_MS = 5 * 60_000;

/** The three Tier-3 plans (§7.3). */
export type AudioOnlyFallbackPlan = "continue" | "offer_audio_only" | "reschedule_in_person";

/** The facts the fallback decision reads. */
export interface AudioOnlyFallbackInput {
  /** How many video-connect attempts have failed for this participant so far (§7.3 — 2 is the platform floor). */
  readonly failedConnectAttempts: number;
  /** ISO-ms of when the vendor circuit opened, or null if the circuit is closed / half-open. */
  readonly breakerOpenedAtMs: number | null;
  /** Now, as epoch ms — injected for determinism. */
  readonly nowMs: number;
  /**
   * Tenant-tightened attempt threshold (§6.4 "tighten to 1"). Clamped to [1, platform floor]: a tenant may
   * lower it to offer audio-only sooner, never raise it above the platform floor.
   */
  readonly tenantAttemptThreshold?: number;
}

/** The resolved plan + the effective threshold used (for the audit/telemetry line). */
export interface AudioOnlyFallbackDecision {
  readonly plan: AudioOnlyFallbackPlan;
  readonly effectiveAttemptThreshold: number;
}

/** §6.4 — resolve the effective attempt threshold: tenant may tighten to a floor of 1, never above the platform floor. */
export function resolveAttemptThreshold(tenant?: number): number {
  if (tenant === undefined || !Number.isFinite(tenant)) return AUDIO_ONLY_ATTEMPT_FLOOR;
  return Math.min(Math.max(Math.floor(tenant), 1), AUDIO_ONLY_ATTEMPT_FLOOR);
}

/**
 * §7.3 / D14 — the Tier-3 decision. A breaker open past the 5-minute ceiling reschedules to in-person first
 * (the strongest signal — the vendor is out, not just this participant's network). Otherwise, once the failed
 * attempts reach the effective threshold, offer audio-only. Below the threshold, keep trying video. PURE.
 */
export function evaluateAudioOnlyFallback(
  input: AudioOnlyFallbackInput,
): AudioOnlyFallbackDecision {
  const threshold = resolveAttemptThreshold(input.tenantAttemptThreshold);
  if (
    input.breakerOpenedAtMs !== null &&
    input.nowMs - input.breakerOpenedAtMs >= BREAKER_OPEN_RESCHEDULE_MS
  ) {
    return { plan: "reschedule_in_person", effectiveAttemptThreshold: threshold };
  }
  if (input.failedConnectAttempts >= threshold) {
    return { plan: "offer_audio_only", effectiveAttemptThreshold: threshold };
  }
  return { plan: "continue", effectiveAttemptThreshold: threshold };
}
