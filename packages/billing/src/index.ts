// @wardenx/billing — M23 Billing (Medicare) package entrypoint (public barrel).
//
// M23 owns the Medicare-FFS hospice billing record: claim assembly from clinical artifacts, the §11.A
// pre-submission validation rule registry (platform-floor `regulatory_required` protection), the
// outbox-only MAC submission posture (837I / NOE / NOTR via the X12 sidecar in @wardenx/x12-837-client),
// 999/277CA acknowledgment ingestion, the HIPPS + SIA calculators, HETS eligibility, the sequestration
// + wage-index reference data, and the per-PE MAC submitter credentials. The Drizzle schema for all 17
// owned tables lives in the central barrel (packages/db/src/schema/billing) per repo convention; this
// package holds the five published seam interfaces, the permissions/ABAC catalogs, the outbox-event
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
// §4.6 the permissions-key catalog (`M23_PERMISSIONS`) the backend projects into M3 in a later phase.
export * from "./permissions";
// §4.7 ABAC predicate-NAME catalog (`M23_ABAC_PREDICATES`).
export * from "./abac";
// §4.3 / §4.4 boot-time seam registration ports + the forward-seam deny-stub factories (M26 / M5).
export * from "./seam-registration";
// §4.10 the `m23.*` outbox-event catalog (TypeBox payloads) the backend events-by-m23.ts mirrors.
export * from "./events";
// §3.7 the destruction eraseFn contract (retention class `billing_record`) + the cascade order.
export * from "./eraser";

// ── P2 pure domain (M23 Phase-2) ──────────────────────────────────────────────────────────────────────
// D6 / D7 / D11 the penny-exact money/rate kernel (per-diem, line-charge, wage-index, sequestration).
export * from "./domain";
// D4 / §2.6 the deterministic claim_control_number derivation + parse/validate.
export * from "./control-number";
// §4.5 / §11.A / D1 the validation rule MODEL (Rule, ValidationContext, RuleResult + constructors).
export * from "./rules";
// §2.2 the `claim` lifecycle reducer (the exemplar the noe/notr machines mirror).
export * from "./machines/claim";
// §2.2 the `noe_record` + `notr_record` fast-path reducers (D3). Namespaced because each mirrors the
// exemplar's bare `reduce` / `canTransition` / `isTerminal` exports — flat `export *` would collide with
// the `claim` machine's same-named functions. Consume as `noeMachine.reduce(...)` / `notrMachine.reduce(...)`.
export * as noeMachine from "./machines/noe";
export * as notrMachine from "./machines/notr";
export * as transferNoticeMachine from "./machines/transfer-notice";
export * from "./transfer-notice";
// D7 the pure HIPPS calculator (LOC-segment → per-diem, days-1-7 vs days-8+, wage-index snapshot).
export * from "./hipps";
// D6 the pure SIA (Service Intensity Add-on) calculator (last-7-days-of-life RN/MSW care pricing).
export * from "./sia";
// F-210 the tenant-entered hospice rate table's pure validation / overlap / lookup rules.
export * from "./rate-table";
// F-211 the tenant-entered wage index's pure validation + tenant-then-authoritative-platform precedence.
export * from "./wage-index";
// D11 the pure sequestration applier (active-policy-or-platform-default percentage over money.ts).
export * from "./sequestration";
// D4 / D14 the pure Type-of-Bill derivation (811/812/813/814/817/818 from admission + claim cadence).
export * from "./tob";
// CMS Pub. 100-04 Ch. 11 §30.3 the pure discharge claim codes (patient status, condition 52/H2, occurrence 42/55).
export * from "./claim-codes";
// §4.1 / §4.2 the TypeBox route request/response SHAPE contracts (one module per route group).
// Routed via the `./route-contracts` hop (see that file) so the barrel carries no schema-path import
// literal alongside its catalog re-exports — avoids a crude arch:tables false positive.
export * from "./route-contracts";

// ── P3 surfaces land here (M23 Phase 3) ───────────────────────────────────────────────────────────────
// §3.3 the Drizzle repositories (data ports over the 17 M23-owned tables) + the repo KERNEL conventions
// (BillingDb handle, enum codecs, keyset cursor helpers, §2.5 If-Match `VersionedUpdateResult`). Namespaced
// because the cursor codec exports (`encodeCursor`/`decodeCursor`/`paginate`-family) and DTO record types
// could collide with the route-contract / schema barrels above. Consume as `repositories.ClaimRepository`.
export * as repositories from "./repositories";
// §3.3 repository KERNEL re-exported at the package ROOT (the cursor codec + the enum case/value codecs +
// the §2.5 If-Match shape + the reconstructed `BillingDb` handle) so the apps/backend route/service layers
// share ONE opaque cursor and ONE enum-case home without reaching through the `repositories` namespace.
// SELECTIVE (not `export *`) so it never collides with the DTO-record / route-contract / schema barrels
// above (the namespaced re-export keeps those record types — `ClaimRecord` etc. — behind `repositories.`).
export {
  type BilledDaysAggregate,
  type BilledDaysByLevel,
  type ClaimLineRollup,
  type ClaimMatchCandidateRow,
  type BillingDb,
  type CursorKeyset,
  type CursorPage,
  type EnumCodec,
  type VersionedUpdateResult,
  buildCursorPage,
  claimStateCodec,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  eligibilityOutcomeCodec,
  encodeCursor,
  keysetBefore,
  levelOfCareCodec,
  MAX_PAGE_SIZE,
  noticeStateCodec,
  pageSizeOf,
  versionConflict,
  versionOk,
} from "./repositories";
