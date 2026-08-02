// @wardenx/fhir — FHIR Gateway domain core (M28).
//
// M28-T01 ships the §2 domain: the three §2.2 state machines (client onboarding, bulk export, inbound
// proposal) as pure functions, the §2.3 SMART scope set + subset matcher, and the §2.3 rate-limit /
// CIDR validation. The type-level surface (enum mirrors, table descriptors, disclosure envelope, the
// W-FHIR-07 forward-seam vocabulary) lives in `@wardenx/types` `fhir.ts` so consumers reach it without a
// dependsOn edge.
//
// Later M28 tasks add over this base: the auth flows (T03), the `FhirMapper`/`FhirSearchTranslator`
// projections (T04), the SUD/AI-boundary enforcement (T05), the published/consumed seams (T06), and the
// bulk-export/inbound workers (T07). Each extends the vocabulary this file re-exports.

export * from "./lifecycle";
export * from "./auth/scopes";
export * from "./domain/validation";
