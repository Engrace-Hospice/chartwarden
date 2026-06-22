// @wardenx/dosespot — Module 12 (DoseSpot Integration) feature package.
//
// M12-T01 lands the domain layout + metadata: the §2.1 Medication-Class catalog (`classes/catalog.ts`).
// The cross-module enum/seam/outbox/alert CONTRACTS live in the leaf `@wardenx/types` (`dosespot.ts`) so
// downstream consumers (M13/M14/M28/M31/M33) import them with no `dependsOn` edge.
//
// M12-T03 lands the pure medication-order-lifecycle domain (`lifecycle/`): the §2.2 D2 state machine
// (extending M11's order machine with the DoseSpot transmission outcomes + the EPCS controlled-substance
// branch) and the §2.3 verbal-medication-order workflow that *consumes* M11's `OrderSignatureProvider`
// primitive (D3 — M12 ships no parallel timer). It lives HERE (the M12 feature package, the M11
// `@wardenx/orders` precedent) rather than the `@wardenx/domain` leaf because it reads the local
// `MED_CLASS_CATALOG`. IO-free, `@wardenx/types`-only.
//
// M12-T04 lands the pure refill-inbox workflow domain (`refill/`): the §2.7 D9 refill-request state machine
// (pending → approved | denied | expired; approve mints a NEW `medication_order` with `derived_from_refill_id`
// and reuses the `lifecycle/` sign path), the controlled-substance refill-rule matrix (Schedule II
// non-refillable; III/IV/V ≤5; tenant tighten-only), and the 48h/72h SLA clock. IO-free, `@wardenx/types`-only.
//
// M12-T05 lands the pure EPCS architecture domain (`epcs/`): the `dosespot.epcs` platform flag + the
// per-tenant certification gate (§2.4 D18 / §1311.300), the IAL2 identity-proofing status tracker + expiry
// alerts (§1311.115), the DEA schedule-authorization check (§1311.120), and the 60-second 2FA
// signing-session submachine (§1311.116) that brackets the lifecycle's `epcs_identity_pending` branch. The
// whole surface is a DENY-STUB behind the OFF `dosespot.epcs` flag in Phase 1 (production §1311.300
// certification is gated by ADR-006); no Phase-1 route transmits a controlled-substance Rx through it.
// IO-free, `@wardenx/types`-only.
//
// M12-T06 lands the DoseSpot adapter boundary + the webhook security envelope + the transmission/patient-sync
// domains. `client/` is the ONLY package allowed to talk to DoseSpot (D5): the typed `DoseSpotClient`
// contract, the per-tenant circuit breaker (§2.5), the typed `DegradedError`/`RetryableError` (INT-009), the
// per-call backoff schedule (§4.10), and the Phase-1 deny-stub (`createUnboundDoseSpotClient`). `webhook/` is
// the §7.4 D7 inbound-webhook security core (HMAC-SHA256 constant-time verify + 5-min replay window + dedup
// key + body digest). `transmission/` is the D8 NewRx idempotency key + the `medication_order_transmission`
// enqueue / success / failure planners (§4.10 retry-exhaustion → M36 alert). `patient-sync/` is the §2.6 D4
// M5 → DoseSpot upsert planner. All IO-free, `@wardenx/types`-only; the live HTTP transport + the service /
// worker / subscriber wiring bind at boot (M12-T08).
//
// Later tasks add: the per-class TypeBox `data` schemas + cross-field validators (`classes/<class>/`); the
// `MedicationOrderProvider`/`RefillInboxProvider` seam impls (`seams.ts`, M12-T07); the typed M36 alert
// builders (`alerts.ts`) + `m12.*` outbox payload assemblers (`outbox.ts`) (M12-T08).

export * from "./classes/catalog";
export * from "./lifecycle";
export * from "./refill";
export * from "./epcs";
export * from "./client";
export * from "./webhook";
export * from "./transmission";
export * from "./patient-sync";
