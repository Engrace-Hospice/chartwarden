// apps/backend/src/modules/25-remittance — M25 Remittance & Denials. The pure revenue-cycle domain
// (Phase 2) is in ./domain; the X12 5010 835 sidecar adapter is @wardenx/x12-835-client. Phase 3 adds
// services (ingest/parse/post/match/classify/state), routes, workers, the eight reader seams, the M36
// recipient resolver, ABAC predicates, the destruction eraser, and boot wiring.
export * as domain from "./domain";
