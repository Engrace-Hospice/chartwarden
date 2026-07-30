// @wardenx/medicaid-adapters — M24 Billing — Medicaid pure-domain package entrypoint (public barrel).
//
// M24 owns the assembly, validation, submission, and acknowledgment of state Medicaid hospice claims —
// including the Room & Board per-diem flow — across a pluggable per-state adapter registry (ARCH §11.E /
// §13). This package is the PURE DOMAIN: the canonical value types, the deterministic state-namespaced
// control-number, the TOB derivation, the three lifecycle reducers (claim / rb_arrangement / rb_day), the
// Medicaid validation rule registry (the 13 platform-default rules + the pure runner, reusing the M23
// rule-result vocabulary), the `MedicaidAdapter` interface + the per-state registry, the Oregon reference
// adapter (real metadata + helpers; wire I/O deferred) and the WA/ID/CA/NV Phase-1 deny-stubs.
//
// PURE DOMAIN: no Fastify, Drizzle/DB, BullMQ, @wardenx/db, getSeam, clock. The state Medicaid Recipient ID
// digit is NEVER a field/return on any surface (D12 / §3.6). Adapter METHODS are the only async I/O surface
// (they do real work when implemented); the validation rules never call them.

// §2.1 / §4.6 canonical shared value types (id aliases, pgEnum-mirroring unions).
export * from "./contracts";
// §4.5 the adapter-facing trading-partner credential shape.
export * from "./credentials";
// structured adapter errors (deny-stub / not-wired / unsupported-state).
export * from "./errors";
// D4 / §2.6 the deterministic, state-namespaced medicaid_claim_control_number derivation + parse/validate.
export * from "./control-number";
// D13 the TOB derivation (811/812/813/814) + replacement/void (817/818) mapping.
export * from "./tob";
// §4.6 the validation rule MODEL + REGISTRY + runner + the 13 platform-default rules.
export * from "./rules";
// §4.5 the MedicaidAdapter interface + DTOs.
export * from "./interface";
// §4.5 the per-state adapter registry + the M40-catalog validation.
export * from "./registry";
// D14 the Oregon reference adapter (incl. the pure OHP Member ID validator).
export * from "./oregon";
// D14 the WA/ID/CA/NV Phase-1 deny-stub adapters + the shared factory.
export * from "./deny-stub";
export * from "./deny-stub-states";

// §2.2 the three lifecycle reducers. Namespaced because each mirrors the exemplar's bare
// reduce/canTransition/isTerminal exports — a flat `export *` would collide.
export * as medicaidClaimMachine from "./machines/claim";
export * as rbArrangementMachine from "./machines/rb-arrangement";
export * as rbDayMachine from "./machines/rb-day";
