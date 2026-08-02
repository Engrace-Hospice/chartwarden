// @wardenx/fhir — FHIR Gateway domain core (M28).
//
// M28-T01 ships the §2 domain: the three §2.2 state machines (client onboarding, bulk export, inbound
// proposal) as pure functions, the §2.3 SMART scope set + subset matcher, and the §2.3 rate-limit /
// CIDR validation. The type-level surface (enum mirrors, table descriptors, disclosure envelope, the
// W-FHIR-07 forward-seam vocabulary) lives in `@wardenx/types` `fhir.ts` so consumers reach it without a
// dependsOn edge.
//
// M28-T03 adds the CLIENT-LIFECYCLE cores over T01's FSMs: the two Phase-1 auth paths (SMART Backend
// Services client-assertion verification + the API-key alternative, D2), the `fhir_client_session`
// mint/verify decision (§2.2), the deterministic + HMAC-signed `CapabilityStatement` generation
// (W-FHIR-09/D11), and the tier-based rate-limit ceiling decision (W-FHIR-08/D16). Every piece is a PURE
// core with `nowMs`/keys INJECTED (the M13 witness-token / M12 webhook-verify idiom) — the routes (T08)
// own the JWKS fetch, the Valkey counting, the tenant-DEK decrypt, and the snapshot persistence.
//
// Later M28 tasks add over this base: the `FhirMapper`/`FhirSearchTranslator` projections (T04), the
// SUD/AI-boundary enforcement (T05), the published/consumed seams (T06), and the bulk-export/inbound
// workers (T07). Each extends the vocabulary this file re-exports.

export * from "./lifecycle";
export * from "./auth/scopes";
export * from "./auth/backend-services";
export * from "./auth/api-key";
export * from "./auth/session";
export * from "./capability/statement";
export * from "./rate-limit/sliding-window";
export * from "./domain/validation";
