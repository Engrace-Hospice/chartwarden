// @wardenx/cost-report — M27 Cost Report package entrypoint (public barrel).
//
// M27 owns the regulatory financial record of the hospice provider: the CMS-1984-14 cost report per
// (ProviderEntity, fiscal-year-end) — worksheets, cost-center mapping, trial-balance/wage imports,
// patient-day reconciliation, the validation rule library, ECR/PI generation, snapshot-on-submit
// lockdown, and the filing-deadline compliance engine. The Drizzle schema for all 14 owned tables lives
// in the central barrel (packages/db/src/schema/cost-report) per repo convention; this package holds the
// seven published seam interfaces, the permission/ABAC catalogs, the seam-registration ports + forward-
// seam deny-stubs, and the destruction eraseFn contract.
//
// P1 scope: CONTRACTS + REGISTRATION SCAFFOLD ONLY — no Fastify, no DB queries, no BullMQ. The pure
// domain (21 worksheet TypeBox schemas, the decimal.js allocation/apportionment/settlement math, the
// ECR fixed-field writer, the 28-rule validation engine), the Drizzle repositories/services, the routes,
// and the 8 BullMQ workers land in P2/P3. No PHI on any surface (D18).

// §2.1 / §4.3 canonical shared DOMAIN VALUE TYPES (id aliases + pgEnum-mirroring unions).
export * from "./contracts";
// §4.3 the seven published seam interfaces + the published-name tuple.
export * from "./seams";
// §4.6 permission-key catalog (`M27_PERMISSIONS`) the backend projects into M3 in a later phase.
export * from "./permissions";
// §4.7 ABAC predicate-NAME catalog (`M27_ABAC_PREDICATES`).
export * from "./abac";
// §4.3 / §4.4 boot-time seam registration ports + the forward-seam deny-stub factory (M23/M26).
export * from "./seam-registration";
// §3.7 the destruction eraseFn contract + the survey-evidence destruction gate.
export * from "./eraser";

// Re-export the adapter client factories M27 owns (D6) so downstream wiring imports from the package root.
export { xeroClientFactory } from "@wardenx/xero-client";
export { gustoClientFactory } from "@wardenx/gusto-client";
