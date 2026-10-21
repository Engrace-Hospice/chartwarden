// @chartwarden/telehealth-client — Module 31 telehealth vendor-adapter package (M31 §4.5 D1).
//
// M31-T01 landed the type-only `TelehealthProvider` contract (the layout). M31-T05 lands the live Daily.co
// adapter (the enabled default), the Twilio + native-WebRTC scaffold swap-paths behind the same interface, the
// PHI-free degraded-error envelope, and the pure circuit breaker (§25.14). PHI boundary (D1): the vendor sees
// ONLY an opaque room name + an opaque participant kind — never a name / MRN / condition / recording bytes.
export * from "./provider";
export * from "./errors";
export * from "./circuit-breaker";
export * from "./daily-co-adapter";
export * from "./scaffold-adapters";
