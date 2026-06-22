// @wardenx/routing-client — Module 17 OSRM routing adapter (the §25.14 adapter-mandate boundary).
//
// M17-T01 lands the §4.10 D1 `RoutingProvider` interface + degraded-mode types (the layout). The OSRM
// adapter impl, the Mapbox swap-path adapter, the coord-hash cache, and the circuit-breaker wiring land in
// M17-T07 (route optimization stays behind `scheduling.route_optimization`, OFF; OSRM degraded mode is the
// Phase-1 path per §7.9).
export * from "./interface";
