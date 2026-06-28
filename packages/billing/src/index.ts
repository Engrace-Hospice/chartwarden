// @wardenx/billing — M23 Billing (Medicare) package entrypoint (public barrel).
//
// M23 owns the Medicare-FFS hospice billing record: claim assembly from clinical artifacts, the §11.A
// pre-submission validation rule registry (platform-floor `regulatory_required` protection), the
// outbox-only MAC submission posture (837I / NOE / NOTR via the X12 sidecar in @wardenx/x12-837-client),
// 999/277CA acknowledgment ingestion, the HIPPS + SIA calculators, HETS eligibility, the sequestration
// + wage-index reference data, and the per-PE MAC submitter credentials. The Drizzle schema for all 17
// owned tables lives in the central barrel (packages/db/src/schema/billing) per repo convention; this
// package holds the five published seam interfaces, the permission/ABAC catalogs, the outbox-event
// catalog, the seam-registration ports + forward-seam deny-stubs (M26/M5), and the destruction eraseFn.
//
// P1 scope: CONTRACTS + REGISTRATION SCAFFOLD ONLY — no Fastify, no DB queries, no BullMQ. The pure
// domain (the validation rule registry + executor, the decimal.js HIPPS/SIA/per-diem math, the X12
// assembly payloads), the Drizzle repositories/services, the routes, and the BullMQ workers land in
// P2/P3. NO PHI and NEVER the MBI digit on any surface (D13 / §3.6 / §8.7).

// §2.1 / §4.3 canonical shared DOMAIN VALUE TYPES (id aliases, pgEnum-mirroring unions, seam DTOs).
export * from "./contracts";
// §4.3 the five published seam interfaces + the consumed forward-seam interfaces + the published-name tuple.
export * from "./seams";
// §4.6 permission-key catalog (`M23_PERMISSIONS`) the backend projects into M3 in a later phase.
export * from "./permissions";
// §4.7 ABAC predicate-NAME catalog (`M23_ABAC_PREDICATES`).
export * from "./abac";
// §4.3 / §4.4 boot-time seam registration ports + the forward-seam deny-stub factories (M26 / M5).
export * from "./seam-registration";
// §4.10 the `m23.*` outbox-event catalog (TypeBox payloads) the backend events-by-m23.ts mirrors.
export * from "./events";
// §3.7 the destruction eraseFn contract (retention class `billing_record`) + the cascade order.
export * from "./eraser";

// ── P2/P3 surfaces land here (M23 Phase 2/3) ──────────────────────────────────────────────────────────
// §4.5 / §11.A the validation rule registry (types + the 17 default rules + the DSL executor).      TODO(P2)
// D6 / D7 the SIA + HIPPS pure calculators (packages/billing/src/sia, /hipps).                       TODO(P2)
// §3.3 the Drizzle repositories (data ports over the 17 M23-owned tables).                           TODO(P3)
