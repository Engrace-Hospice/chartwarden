// @wardenx/evv-aggregators — Module 18 per-state EVV-aggregator adapter package (the §25.14 adapter-mandate
// boundary). This is the ONLY place a state-EVV-aggregator vendor's endpoint, credentials, and payload shape
// may live; dependency-cruiser forbids any other module from importing a vendor SDK or hitting a vendor URL.
//
// M18-T01 landed the §4.5 D1 `EvvAggregatorAdapter` interface + `AggregatorCredentials` shape (the layout).
// M18-T06 lands the Phase-1 `SandataAdapter`, the `OpenModelAdapter` (no-aggregator open-model path), the
// per-state `StateAggregatorRegistry` selector (reads M40 master data), the circuit-breaker integration, and
// the degraded-error envelope. HHAeXchange / Tellus / CareBridge adapters are Phase-2 candidates.
export * from "./interface";
