// @chartwarden/evv-aggregators — Module 18 per-state EVV-aggregator adapter package (the §25.14 adapter-mandate
// boundary). This is the ONLY place a state-EVV-aggregator vendor's endpoint, credentials, and payload shape
// may live; dependency-cruiser forbids any other module from importing a vendor SDK or hitting a vendor URL.
//
// M18-T01 landed the §4.5 D1 `EvvAggregatorAdapter` interface + `AggregatorCredentials` shape (the layout).
// M18-T06 lands the Phase-1 `SandataAdapter`, the `OpenModelAdapter` (no-aggregator open-model path), the
// per-state `StateAggregatorRegistry` selector (reads M40 master data), the credential-store port, and the
// `event_pair_hash` idempotency primitive. HHAeXchange / Tellus / CareBridge ship as Phase-2 interface-
// conformance scaffolding (not registered by default).
export * from "./interface";
export * from "./credentials";
export * from "./event-pair-hash";
export * from "./registry";
export {
  type Clock,
  type SandataSubmissionBody,
  type SandataTransport,
  SandataAdapter,
  createDenySandataTransport,
  createSandataSandboxTransport,
} from "./adapters/sandata-adapter";
export {
  type FetchLike,
  type HttpSandataTransportOptions,
  createHttpSandataTransport,
} from "./adapters/sandata-http-transport";
export { type OpenModelSubmissionBody, OpenModelAdapter } from "./open-model";
export {
  CareBridgeAdapter,
  HhaeXchangeAdapter,
  TellusAdapter,
} from "./adapters/phase2-scaffolding";
