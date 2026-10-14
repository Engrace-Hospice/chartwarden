// ADR-0058 review F1 - the rare-term existence timing oracle.
//
// The candidate scan counts hidden candidates before the authority filter, so without a floor a caller can tell "no message
// contains X" (instant) from "some channel I cannot read contains X" (an authority call per channel). Every response of the
// search route is therefore held to a minimum duration of FLOOR + a per-request random jitter, on EVERY outcome after the
// gates: results, empty, refine, and errors. The floor never shortens a slower request.
//
// SIZING: the floor sits above the one-round worst case (one prefilter statement, one authority call over <= 50 channels, one
// re-select, the page transaction). A request that needs more rounds (up to MAX_PAGES_PER_QUERY) takes longer than the floor
// and is inherently distinguishable; that residual (hidden volume above 500 candidates or 50 channels) is recorded in
// ADR-0058 and is bounded by the per-route rate limit.
export const SEARCH_RESPONSE_FLOOR_MS = 1500;
export const SEARCH_RESPONSE_JITTER_MS = 500;

/** Tests only (ignored when NODE_ENV is production): shrink the floor so route suites stay fast. */
export const FLOOR_ENV = "WARDENX_GLOBAL_SEARCH_FLOOR_MS";
export const JITTER_ENV = "WARDENX_GLOBAL_SEARCH_JITTER_MS";

export interface ResponseFloorConfig {
  readonly floorMs: number;
  readonly jitterMs: number;
}

export interface FloorClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

const realClock: FloorClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

function envMs(name: string, fallback: number): number {
  if (process.env.NODE_ENV === "production") return fallback;
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function responseFloorFromEnv(): ResponseFloorConfig {
  return {
    floorMs: envMs(FLOOR_ENV, SEARCH_RESPONSE_FLOOR_MS),
    jitterMs: envMs(JITTER_ENV, SEARCH_RESPONSE_JITTER_MS),
  };
}

/** Runs `work`, then waits out the rest of floor + jitter whether it returned or threw; the outcome is passed through. */
export async function withResponseFloor<T>(
  work: () => Promise<T>,
  config: ResponseFloorConfig,
  clock: FloorClock = realClock,
): Promise<T> {
  const started = clock.now();
  const target = config.floorMs + clock.random() * config.jitterMs;
  const settle = async (): Promise<void> => {
    const remaining = target - (clock.now() - started);
    if (remaining > 0) await clock.sleep(remaining);
  };
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await settle();
    throw error;
  }
  await settle();
  return result;
}
