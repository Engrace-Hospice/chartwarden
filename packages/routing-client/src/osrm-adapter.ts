import { type RoutingCache, directionsCacheKey, matrixCacheKey } from "./cache";
// @wardenx/routing-client — the §4.10 D1 OSRM `RoutingProvider` (M17-T07). The ONLY place the routing
// endpoint is called (architecture §25.14 adapter mandate; dependency-cruiser §25.15 check #2 forbids any
// other module from reaching OSRM directly). Route optimisation stays behind `scheduling.route_optimization`
// (OFF in Phase 1); when the circuit is open OR OSRM errors, the adapter raises {@link RoutingDegradedError}
// so the worker takes the §7.9 degraded path (visits in scheduled order) — no patient-care path is blocked.
//
// PHI boundary (D9 / §7.10): the request URL carries ONLY `lng,lat` pairs — zero names, MRNs, addresses,
// visit purposes, or clinician ids ever leave the M17 backend. The cache key is a coord hash, not an address.
import {
  type BreakerSnapshot,
  INITIAL_BREAKER_SNAPSHOT,
  ROUTING_CIRCUIT_BREAKER_CONFIG,
  type RoutingCircuitBreakerConfig,
  applyOutcome,
  evaluateBreaker,
} from "./circuit-breaker";
import { RoutingDegradedError } from "./errors";
import type {
  RoutingCoord,
  RoutingDirectionsResult,
  RoutingMatrixResult,
  RoutingProvider,
} from "./interface";

const SECONDS_PER_MINUTE = 60;
const METERS_PER_MILE = 1609.344;

/** A `fetch`-shaped transport (the global `fetch` by default; injected in unit tests — no real network). */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Construction deps for {@link OsrmRoutingProvider} (clock + transport are injected so the adapter is testable). */
export interface OsrmRoutingProviderDeps {
  /** OSRM table/route base, e.g. `http://osrm.internal.wardenx:5000` — NEVER any PHI in the URL (D9). */
  readonly endpoint: string;
  readonly cache: RoutingCache;
  /** Wall-clock as an ISO instant — injected so the breaker transitions are deterministic in tests. */
  readonly now: () => string;
  readonly fetchImpl?: FetchLike;
  readonly config?: RoutingCircuitBreakerConfig;
  /** Correlation id for the degraded-error envelope (PHI-free; one per worker invocation). */
  readonly correlationId?: string;
}

interface OsrmMatrixBody {
  durations: (number | null)[][];
  distances: (number | null)[][];
}

interface OsrmRouteBody {
  routes: { geometry: string; duration: number; distance: number }[];
}

/** §4.10 — the OSRM-backed routing adapter. Holds the breaker snapshot in-process (Valkey-backed in prod). */
export class OsrmRoutingProvider implements RoutingProvider {
  private readonly endpoint: string;
  private readonly cache: RoutingCache;
  private readonly now: () => string;
  private readonly fetchImpl: FetchLike;
  private readonly config: RoutingCircuitBreakerConfig;
  private readonly correlationId: string;
  private breaker: BreakerSnapshot = INITIAL_BREAKER_SNAPSHOT;

  constructor(deps: OsrmRoutingProviderDeps) {
    this.endpoint = deps.endpoint.replace(/\/+$/, "");
    this.cache = deps.cache;
    this.now = deps.now;
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.config = deps.config ?? ROUTING_CIRCUIT_BREAKER_CONFIG;
    this.correlationId = deps.correlationId ?? "osrm";
  }

  async matrix(coords: ReadonlyArray<RoutingCoord>): Promise<RoutingMatrixResult> {
    const cacheKey = matrixCacheKey(coords);
    const cached = await this.cache.get(cacheKey);
    if (cached !== null) {
      const parsed = JSON.parse(cached) as Omit<RoutingMatrixResult, "cached">;
      return { ...parsed, cached: true };
    }

    const body = await this.call<OsrmMatrixBody>(
      "matrix",
      `${this.endpoint}/table/v1/driving/${coordPath(coords)}?annotations=duration,distance`,
    );
    const out = {
      durationsMin: body.durations.map((row) =>
        row.map((s) => (s == null ? null : s / SECONDS_PER_MINUTE)),
      ),
      distancesMi: body.distances.map((row) =>
        row.map((m) => (m == null ? null : m / METERS_PER_MILE)),
      ),
    };
    await this.cache.set(cacheKey, JSON.stringify(out), "EX", 86_400); // 24 h
    return { ...out, cached: false };
  }

  async directions(from: RoutingCoord, to: RoutingCoord): Promise<RoutingDirectionsResult> {
    const cacheKey = directionsCacheKey(from, to);
    const cached = await this.cache.get(cacheKey);
    if (cached !== null) {
      const parsed = JSON.parse(cached) as Omit<RoutingDirectionsResult, "cached">;
      return { ...parsed, cached: true };
    }

    const body = await this.call<OsrmRouteBody>(
      "directions",
      `${this.endpoint}/route/v1/driving/${coordPath([from, to])}?overview=full&geometries=polyline6`,
    );
    const route = body.routes[0];
    if (!route)
      throw this.degraded("directions", true, "OSRM returned no route for the coordinate pair.");
    const out = {
      polyline: route.geometry,
      driveMinutes: route.duration / SECONDS_PER_MINUTE,
      distanceMi: route.distance / METERS_PER_MILE,
    };
    await this.cache.set(cacheKey, JSON.stringify(out), "EX", 86_400);
    return { ...out, cached: false };
  }

  /** §7.9 — true while the circuit is closed/half-open (an attempt is permitted); false while open. */
  async healthy(): Promise<boolean> {
    return evaluateBreaker(this.breaker, this.now(), this.config).allowed;
  }

  /**
   * The breaker-guarded transport: fail fast with a degraded error while the circuit is open (§7.9), otherwise
   * `fetch` with the §4.10 3 s timeout and fold the outcome into the breaker. Any transport error is normalised
   * to {@link RoutingDegradedError} so a raw `fetch` rejection never reaches an M17 caller.
   */
  private async call<T>(operation: "matrix" | "directions", url: string): Promise<T> {
    const gate = evaluateBreaker(this.breaker, this.now(), this.config);
    if (!gate.allowed) {
      throw this.degraded(
        operation,
        true,
        "Routing engine is temporarily unavailable (circuit open).",
      );
    }
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.config.timeoutMs) });
      if (!res.ok) throw new Error(`osrm-${operation}-http-${res.status}`);
      const json = (await res.json()) as T;
      this.breaker = applyOutcome(this.breaker, "success", this.now(), this.config);
      return json;
    } catch (err) {
      if (err instanceof RoutingDegradedError) throw err;
      this.breaker = applyOutcome(this.breaker, "failure", this.now(), this.config);
      throw this.degraded(operation, true, "Routing engine request failed; using scheduled order.");
    }
  }

  private degraded(
    operation: "matrix" | "directions",
    retryable: boolean,
    message: string,
  ): RoutingDegradedError {
    return new RoutingDegradedError("osrm", operation, retryable, message, this.correlationId);
  }
}

/** Build the `lng,lat;lng,lat;…` path segment OSRM expects (lng-first; coords only — D9). */
function coordPath(coords: ReadonlyArray<RoutingCoord>): string {
  return coords.map((c) => `${c.lng},${c.lat}`).join(";");
}
