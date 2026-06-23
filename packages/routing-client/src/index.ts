// @wardenx/routing-client — Module 17 OSRM routing adapter (the §25.14 adapter-mandate boundary).
//
// M17-T01 landed the §4.10 D1 `RoutingProvider` interface + degraded-mode types (the layout). M17-T07 lands
// the OSRM adapter impl, the disabled-by-default Mapbox swap-path, the coord-hash Valkey cache, the
// degraded-error envelope, and the pure circuit breaker. Route optimisation stays behind
// `scheduling.route_optimization` (OFF; OSRM degraded mode is the Phase-1 path per §7.9). PHI boundary (D9 /
// §7.10): coords only ever leave the backend, and the cache key is a coord hash — no address/name/MRN.
export * from "./interface";
export * from "./errors";
export * from "./circuit-breaker";
export * from "./cache";
export * from "./osrm-adapter";
export * from "./mapbox-adapter";
