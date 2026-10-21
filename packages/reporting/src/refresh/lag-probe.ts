// @chartwarden/reporting · refresh — the `report.lag_probe` SINGLETON worker (M33 §2.4 / §4.8 / D14).
//
// Every 30s (singleton, concurrency 1) the probe samples the worst replica replay lag from
// `pg_stat_replication` and derives the `data_freshness_seconds` the dashboard tiles surface in their
// "Data as of HH:MM" badge. A two-consecutive-probe HYSTERESIS gates the transitions (so a single noisy
// sample never flaps the banner): lag > 600s (10 min) for two probes in a row → `m33.lag.exceeded` (M36 warn
// + the degraded-tile advisory); lag < 600s for two probes in a row → `m33.lag.recovered` (M36 info + banner
// auto-dismiss). The advisory is INFORMATIONAL, never blocking — tiles keep rendering from the last refreshed
// snapshot, lag-adjusted (§2.4 fail-closed posture).
//
// PURE: {@link decideLagTransition} is the total hysteresis core (sample + prior state → transition + next
// state); {@link runLagProbe} is the thin port-injected orchestrator (sample → decide → persist → emit).
import type {
  LagOutboxPort,
  LagProbeState,
  LagProbeStatePort,
  ReplicaLagAdvisoryPort,
  ReplicationLagPort,
} from "./ports";

/** D14 / §4.8: the freshness SLO threshold — replica lag over 10 minutes flips tiles to the warning state. */
export const REPLICA_LAG_THRESHOLD_SECONDS = 600 as const;

/** The freshly-armed probe state (no breach, no streak). The boot binds {@link LagProbeStatePort} to return
 *  this when no prior state exists. */
export const INITIAL_LAG_PROBE_STATE: LagProbeState = Object.freeze({
  breached: false,
  consecutiveOver: 0,
  consecutiveUnder: 0,
  breachStartedAt: null,
});

/** `data_freshness_seconds` derived from the sampled replay lag (D14 — the tile badge value). The freshness a
 *  tile reports is exactly the replica lag at compute time; pinned non-negative for a clock-skew sample. */
export function computeFreshnessSeconds(replayLagSeconds: number): number {
  return Math.max(0, replayLagSeconds);
}

/** The transition a probe produced (under the two-consecutive-probe hysteresis), or `none`. */
export type LagTransition = "exceeded" | "recovered" | "none";

/** The pure decision: the transition, the next persisted state, and (on `recovered`) how long the breach held. */
export interface LagTransitionDecision {
  readonly transition: LagTransition;
  readonly next: LagProbeState;
  /** Seconds the confirmed breach held (set only on `recovered`; null otherwise). */
  readonly durationDownSeconds: number | null;
}

/**
 * Decide the lag transition for one probe sample (PURE, total). Hysteresis (§2.4): a transition fires only
 * after TWO consecutive probes on the same side of the threshold, so a single outlier never flaps the banner.
 *   - over threshold:  bump `consecutiveOver`, zero `consecutiveUnder`; if not breached and the streak ≥2 →
 *                      `exceeded` (record `breachStartedAt`).
 *   - at/under threshold: bump `consecutiveUnder`, zero `consecutiveOver`; if breached and the streak ≥2 →
 *                      `recovered` (compute `durationDownSeconds` from `breachStartedAt`, clear it).
 * The `>` comparison means exactly-at-threshold counts as UNDER (recovery-favouring) — the SLO is "lag ≤ 600s".
 */
export function decideLagTransition(input: {
  readonly lagSeconds: number;
  readonly thresholdSeconds: number;
  readonly prior: LagProbeState;
  readonly now: Date;
}): LagTransitionDecision {
  const { lagSeconds, thresholdSeconds, prior, now } = input;

  if (lagSeconds > thresholdSeconds) {
    const consecutiveOver = prior.consecutiveOver + 1;
    const crossed = !prior.breached && consecutiveOver >= 2;
    return {
      transition: crossed ? "exceeded" : "none",
      next: {
        breached: prior.breached || crossed,
        consecutiveOver,
        consecutiveUnder: 0,
        breachStartedAt: crossed ? now.toISOString() : prior.breachStartedAt,
      },
      durationDownSeconds: null,
    };
  }

  const consecutiveUnder = prior.consecutiveUnder + 1;
  const recovered = prior.breached && consecutiveUnder >= 2;
  const durationDownSeconds =
    recovered && prior.breachStartedAt !== null
      ? Math.max(0, Math.round((now.getTime() - Date.parse(prior.breachStartedAt)) / 1000))
      : null;
  return {
    transition: recovered ? "recovered" : "none",
    next: {
      breached: prior.breached && !recovered,
      consecutiveOver: 0,
      consecutiveUnder,
      breachStartedAt: recovered ? null : prior.breachStartedAt,
    },
    durationDownSeconds,
  };
}

/** The ports the probe composes over: sample lag + load/save its hysteresis state + stamp the advisory + emit. */
export interface LagProbePorts {
  readonly replication: ReplicationLagPort;
  readonly state: LagProbeStatePort;
  readonly advisory: ReplicaLagAdvisoryPort;
  readonly outbox: LagOutboxPort;
  /** Override the D14 threshold (default {@link REPLICA_LAG_THRESHOLD_SECONDS}). */
  readonly thresholdSeconds?: number;
  now(): Date;
}

/** What one probe tick reported (telemetry for the singleton's logs / metrics). */
export interface LagProbeReport {
  readonly lagSeconds: number;
  readonly freshnessSeconds: number;
  readonly transition: LagTransition;
}

/**
 * Run one `report.lag_probe` tick (§2.4): sample the replica lag, {@link decideLagTransition} against the
 * persisted hysteresis state, save the next state, and on a CONFIRMED transition stamp the degraded-tile
 * advisory + emit the §4.9 event (`exceeded` → advisory on + M36 warn; `recovered` → advisory off + M36 info).
 * A `none` transition only persists the updated streak — no event, no advisory change.
 */
export async function runLagProbe(ports: LagProbePorts): Promise<LagProbeReport> {
  const thresholdSeconds = ports.thresholdSeconds ?? REPLICA_LAG_THRESHOLD_SECONDS;
  const lagSeconds = await ports.replication.sampleMaxReplayLagSeconds();
  const prior = await ports.state.load();
  const now = ports.now();
  const decision = decideLagTransition({ lagSeconds, thresholdSeconds, prior, now });

  await ports.state.save(decision.next);

  if (decision.transition === "exceeded") {
    await ports.advisory.setAdvisory(true);
    await ports.outbox.emitLagExceeded({
      lagSeconds,
      threshold: thresholdSeconds,
      sampledAt: now.toISOString(),
    });
  } else if (decision.transition === "recovered") {
    await ports.advisory.setAdvisory(false);
    await ports.outbox.emitLagRecovered({
      lagSeconds,
      durationDownSeconds: decision.durationDownSeconds ?? 0,
      recoveredAt: now.toISOString(),
    });
  }

  return {
    lagSeconds,
    freshnessSeconds: computeFreshnessSeconds(lagSeconds),
    transition: decision.transition,
  };
}
