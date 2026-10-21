// apps/backend/src/modules/29-external-interfaces/listener — listener-down detection (M29-T03, §4.11.5 /
// D17). PURE. The per-feed circuit breaker the 30s health probe (§4.11.1 step 4) advances each tick.
//
// STATES (§4.11.5):
//   · CLOSED   (healthy): a frame was received within the down-threshold window (default 5min) OR the feed
//                         is inside its `expectedQuietWindow`.
//   · OPEN     (alert):   no frames in the window AND the TCP-connect or TLS-handshake probe FAILS. Emits
//                         `m29.external_feed.listener_down` → M36 dispatches a CRITICAL operator-on-call alert.
//   · HALF_OPEN(recovery):TCP probe succeeds again after being OPEN; the NEXT received frame closes the
//                         breaker and emits `m29.external_feed.listener_recovered`.
//
// The 5min default is a PLATFORM FLOOR: a tenant may TIGHTEN to as low as 1min via
// `external_feed.config.listenerDownThresholdMs` but may not loosen above 5min (§4.11.5). The threshold is
// passed IN already-resolved (the write-time / boot-time floor check lives at the config edge, not here) —
// this module is the pure transition, `nowMs` INJECTED (never a clock).
import { XI_LISTENER_DOWN_ALERT_MINUTES } from "@chartwarden/types";

/** The §4.11.5 circuit-breaker states. */
export type ListenerCircuitState = "closed" | "open" | "half_open";

/** The platform-floor listener-down threshold (5 minutes) as milliseconds — the default `thresholdMs`. */
export const LISTENER_DOWN_THRESHOLD_FLOOR_MS = XI_LISTENER_DOWN_ALERT_MINUTES * 60 * 1000;

/** The result of a single health-probe tick's TCP-connect + TLS-handshake against the listener. */
export interface ListenerProbeResult {
  /** True when the TCP connect succeeded this tick. */
  readonly tcpOk: boolean;
  /** True when the TLS handshake succeeded this tick (undefined/false for a `mllp_plain` test feed). */
  readonly tlsOk: boolean;
}

export interface ListenerCircuitInput {
  /** The breaker state at the last tick. */
  readonly current: ListenerCircuitState;
  /** Epoch-ms of the last frame received on this feed, or `null` if none ever. */
  readonly lastFrameAtMs: number | null;
  /** This tick's probe result. */
  readonly probe: ListenerProbeResult;
  /** The resolved down-threshold (ms). A tenant tighten never below this is enforced at the config edge. */
  readonly thresholdMs: number;
  /** True when NOW is inside the feed's declared quiet window (no traffic expected — never trips OPEN). */
  readonly inQuietWindow: boolean;
  /** The decision clock (epoch ms), INJECTED. */
  readonly nowMs: number;
}

/** A transition the health probe applies + the outbox event it emits (null when the state is unchanged). */
export interface ListenerCircuitDecision {
  readonly state: ListenerCircuitState;
  readonly transitioned: boolean;
  /** The §4.11.5 outbox event to emit on a transition, or null. */
  readonly emit: "m29.external_feed.listener_down" | "m29.external_feed.listener_recovered" | null;
}

/** True when the last frame is older than the threshold (or none ever received). */
function isSilent(input: ListenerCircuitInput): boolean {
  if (input.lastFrameAtMs === null) return true;
  return input.nowMs - input.lastFrameAtMs >= input.thresholdMs;
}

/**
 * The PURE §4.11.5 breaker transition for one probe tick. Fails toward ALERTING: a probe that cannot reach
 * the listener while the feed is silent (and not in a quiet window) trips OPEN, because a silent-but-healthy
 * feed is indistinguishable from a down one WITHOUT the probe — the probe is what resolves the ambiguity.
 */
export function evaluateListenerCircuit(input: ListenerCircuitInput): ListenerCircuitDecision {
  // A frame received within the window always closes the breaker (and recovers from OPEN/HALF_OPEN).
  const recentFrame = !isSilent(input);

  if (recentFrame) {
    const transitioned = input.current !== "closed";
    return {
      state: "closed",
      transitioned,
      emit: transitioned ? "m29.external_feed.listener_recovered" : null,
    };
  }

  // Silent. If inside a declared quiet window, silence is expected — hold CLOSED, never alert.
  if (input.inQuietWindow) {
    return { state: "closed", transitioned: input.current !== "closed", emit: null };
  }

  // Silent + not quiet: the probe decides. Unreachable → OPEN; reachable → HALF_OPEN (awaiting a frame).
  const probeUp = input.probe.tcpOk && input.probe.tlsOk;
  if (!probeUp) {
    const transitioned = input.current !== "open";
    return {
      state: "open",
      transitioned,
      emit: transitioned ? "m29.external_feed.listener_down" : null,
    };
  }
  // Probe reachable but still silent: HALF_OPEN — recovery pending the next real frame (no event yet).
  return { state: "half_open", transitioned: input.current !== "half_open", emit: null };
}
