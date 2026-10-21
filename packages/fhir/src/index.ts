// @chartwarden/fhir — FHIR Gateway domain core (M28).
//
// M28-T01 ships the §2 domain: the three §2.2 state machines (client onboarding, bulk export, inbound
// proposal) as pure functions, the §2.3 SMART scope set + subset matcher, and the §2.3 rate-limit /
// CIDR validation. The type-level surface (enum mirrors, table descriptors, disclosure envelope, the
// W-FHIR-07 forward-seam vocabulary) lives in `@chartwarden/types` `fhir.ts` so consumers reach it without a
// dependsOn edge.
//
// M28-T03 adds the CLIENT-LIFECYCLE cores over T01's FSMs: the two Phase-1 auth paths (SMART Backend
// Services client-assertion verification + the API-key alternative, D2), the `fhir_client_session`
// mint/verify decision (§2.2), the deterministic + HMAC-signed `CapabilityStatement` generation
// (W-FHIR-09/D11), and the tier-based rate-limit ceiling decision (W-FHIR-08/D16). Every piece is a PURE
// core with `nowMs`/keys INJECTED (the M13 witness-token / M12 webhook-verify idiom) — the routes (T08)
// own the JWKS fetch, the Valkey counting, the tenant-DEK decrypt, and the snapshot persistence.
//
// M28-T04 adds the read-only US Core R4 PROJECTION layer over this base: the `FhirMapper` /
// `FhirSearchTranslator` contracts (§4.5 D6), the single-entity mappers (Patient/Encounter/Condition/
// Goal/CarePlan + MedicationRequest/MedicationStatement) and the multi-source `DiagnosticReport`
// projector with its child-Observation + D20 SUD-redaction pieces (§4.11), and the `?patient=:id` search
// (W-FHIR-14). Every projection is PURE with its reader deps INJECTED — the routes (T08) supply the real
// seam adapters; T06 the published/consumed seam bind, T07 the bulk-export/inbound workers + HMAC-signed
// cursor.
//
// M28-T05 adds the two egress-boundary enforcers, both PURE with their cross-module port INJECTED (no
// `@chartwarden/consent`/`@chartwarden/ai-platform` import, no `dependsOn` edge ahead of the T06 seam bind): the
// 42 CFR Part 2 SUD egress consent gate (`egress/consent-gate`, §8.2/D3/W-FHIR-03) that consults M39's
// `evaluateForDisclosure` per resource to include/redact/filter and folds an `OperationOutcome` warning
// into the Bundle; and the D14 AI-prohibited-zone boot validator (`ai-block`, §8.6/W-FHIR-11) that
// refuses M28 boot if any active M32 prompt targets a FHIR output-entity zone.
//
// M28-T07 adds the async-pipeline decision cores over T01's FSMs, plus the §4.10 outbox catalog — all
// PURE with time/keys INJECTED (the T08 workers/routes own the MinIO/BullMQ/Drizzle IO): the bulk-export
// worker+sweeper core (`lifecycle/bulk-export-plan`, §D4/W-FHIR-04 — object keying, deterministic NDJSON
// + sha256, the 24h `expires_at` completion math, the sweeper expiry predicate); the inbound proposal
// stage→accept/reject/expiry core (`lifecycle/inbound-plan`, §D8/W-FHIR-05/06 — owner-module resolution,
// `payload_sha256`, the D8 owner-match + ≥40-char-rationale + FSM guards, the SLA-breach expiry + M36
// overdue alert + payload-erase schedule); and the HMAC-signed opaque cursor (`r4/search/signed-cursor`,
// §D13/W-FHIR-10) that makes a `Bundle.link` `next` token unforgeable and non-replayable cross-tenant.

export * from "./lifecycle";
export * from "./auth/scopes";
export * from "./auth/backend-services";
export * from "./auth/api-key";
export * from "./auth/session";
export * from "./capability/statement";
export * from "./rate-limit/sliding-window";
export * from "./domain/validation";
export * from "./interfaces/mapper";
export * from "./interfaces/search-translator";
export * from "./r4";
export * from "./egress/consent-gate";
export * from "./ai-block";
export * from "./outbox-events";
