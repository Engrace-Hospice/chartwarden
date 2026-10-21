// apps/backend/src/modules/33-reporting/jobs/lag-probe-state.ts — the Valkey-backed adapter for the
// `report.lag_probe` singleton's mutable state (§2.4 / D14). The probe is platform-scoped and org-agnostic
// (one hysteresis state + one degraded-tile advisory flag for the whole deployment), so a single JSON key +
// a single boolean key on the SAME Valkey connection the M33 BullMQ workers already use is the right shape —
// no new infra, no DB table (the state is disposable: a lost/reset key just re-arms the hysteresis at
// `consecutiveOver=0`, which self-corrects within a couple of 30s ticks).
import type { LagProbeState, LagProbeStatePort, ReplicaLagAdvisoryPort } from "@chartwarden/reporting";
import type Redis from "ioredis";

const STATE_KEY = "m33:lag_probe:state";
const ADVISORY_KEY = "m33:lag_probe:advisory";

const INITIAL_STATE: LagProbeState = {
  breached: false,
  consecutiveOver: 0,
  consecutiveUnder: 0,
  breachStartedAt: null,
};

/** Load/save the probe's two-consecutive-probe hysteresis state as one JSON blob (§2.4). A missing/corrupt
 *  key reads back the initial (un-breached) state — the probe re-establishes hysteresis from a clean slate
 *  rather than throwing, since losing this state is never unsafe (worst case: one extra probe cycle before
 *  a real breach is confirmed). */
export function createRedisLagProbeStatePort(redis: Redis): LagProbeStatePort {
  return {
    async load() {
      const raw = await redis.get(STATE_KEY);
      if (!raw) return INITIAL_STATE;
      try {
        return JSON.parse(raw) as LagProbeState;
      } catch {
        return INITIAL_STATE;
      }
    },
    async save(state) {
      await redis.set(STATE_KEY, JSON.stringify(state));
    },
  };
}

/** Stamp the degraded-tile advisory flag (D14 — the tile "Data as of" badge flips to the warning state
 *  while set). A plain `"1"`/`"0"` string, not an expiring key: the flag's lifecycle is owned entirely by
 *  the probe's explicit set/clear calls, not by a TTL. */
export function createRedisLagProbeAdvisoryPort(redis: Redis): ReplicaLagAdvisoryPort {
  return {
    async setAdvisory(active) {
      await redis.set(ADVISORY_KEY, active ? "1" : "0");
    },
  };
}
