// @wardenx/routing-client — the §4.10 D1 `RoutingProvider` adapter interface (M17-T01).
//
// Per architecture §25.14 (the adapter mandate) this package is the ONLY place the routing endpoint lives;
// dependency-cruiser (architecture-fitness §25.15 check #2) forbids any other module from calling OSRM/
// Mapbox directly. M17-T01 ships the interface + degraded-mode error type (the layout); the locked-in
// Phase-1 `OsrmRoutingProvider`, the disabled `mapbox-adapter`, the coord-hash Valkey cache, and the
// circuit-breaker integration land in M17-T07 — route optimization stays behind `scheduling.route_
// optimization` (OFF), so the OSRM degraded path (§7.9) is the Phase-1 behaviour.
//
// PHI boundary (D9): NO PHI fields are permitted in any request — coordinates only. Geocoding is NOT in
// this interface; M5 owns geocoding and M17 reads geocoded coords.

/** A geographic coordinate pair. The only data ever sent to the routing endpoint (D9). */
export interface RoutingCoord {
  readonly lat: number;
  readonly lng: number;
}

/** The matrix-endpoint result: drive time + distance between every pair of input coordinates.
 * `durationsMin[i][j]` / `distancesMi[i][j]` may be `null` when the engine cannot route the pair. */
export interface RoutingMatrixResult {
  readonly durationsMin: (number | null)[][];
  readonly distancesMi: (number | null)[][];
  readonly cached: boolean;
}

/** The directions-endpoint result between two coords. */
export interface RoutingDirectionsResult {
  readonly polyline: string; // encoded polyline (OSRM polyline6 or polyline5; documented per impl)
  readonly driveMinutes: number;
  readonly distanceMi: number;
  readonly cached: boolean;
}

/** §4.10 D1 — the routing adapter every M17 route-optimization caller depends on. */
export interface RoutingProvider {
  /**
   * Matrix endpoint: drive time + distance between every pair of input coordinates.
   * NO PHI fields permitted in the request — coords only (D9).
   */
  matrix(coords: ReadonlyArray<RoutingCoord>): Promise<RoutingMatrixResult>;

  /** Directions endpoint: between two coords, return polyline + drive time + distance. */
  directions(from: RoutingCoord, to: RoutingCoord): Promise<RoutingDirectionsResult>;

  /** Health probe; returns true if the circuit-breaker is closed. */
  healthy(): Promise<boolean>;
}
