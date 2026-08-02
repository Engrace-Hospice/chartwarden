// @wardenx/subscription-billing — M35 Subscription Billing (Stripe) package entrypoint (public barrel).
//
// M35 owns the platform's monetization surface: the platform-shared plan catalog + meters, per-tenant
// subscriptions and their D7 status machine, Stripe-mirrored invoices/lines/payment-methods, PHI-free
// usage metering with HMAC-pseudonymized patient/user active-period counting, the D16 four-stage refund
// workflow, promo codes, monthly MRR/ARR snapshots, the dunning ladder, and the outbox-only Stripe
// dispatcher. Per ADR-0025 the M34↔M35 seam is bidirectional-but-edge-free; the cross-module wire
// contracts (enum mirrors, seam interfaces, outbox taxonomy, alert rules) live in the leaf `@wardenx/types`.
//
// M35-T01 scope: the §3.3 enum VALUE tuples (runtime source of truth, `satisfies`-pinned to the leaf
// unions) + the pure §2 domain kernels (the subscription / dunning / refund / invoice transition graphs,
// the §2.3 penny-exact validation predicates, and the §3.5 table-scope + §3.6 audit-posture catalogs).
//
// M35-T03 scope (adds `./pseudonym` + `./service`): the §2 lifecycle SERVICE cores over injected store
// ports — the §2.2 D7 subscription status graph, the §2.2 Stripe-driven invoice mirror, the §D5/D6 usage-
// metering + HMAC-pseudonymized active-period counters, the §D18 MRR/ARR monthly-snapshot computation,
// and the §3.7/M35-F06 platform-retention copy-then-delete transfer. Every core is PURE (M28-T03 idiom):
// the ports abstract the Drizzle stores + §2.5 row locks the routes/workers own; each mutation returns its
// §2.4 outbox intents for the caller to publish.
//
// M35-T04 scope (adds `./stripe`): the §4.13 outbox-only Stripe dispatcher + the §4.14 HMAC webhook
// ingestion core, both PURE over injected ports. The `stripe` SDK is NOT imported anywhere in the tree —
// the SDK-free typed client (`@wardenx/xero-client` idiom) routes every call through an injected transport
// (fail-closed by default), keeping the whole package inside the VENDOR_ADAPTERS boundary. Includes the
// §8.7 audit-envelope redactor, the §4.13/§4.16 deterministic idempotency-key derivation, and the D15
// envelope-encryption seam for `stripe_webhook_event`.
//
// M35-T05 scope (adds `./service/dunning-service`): the §4.15 D7 dunning STATE MACHINE over the injected
// {@link DunningStore} — `payment_failed → day_1`, the time-based ladder advance (`tick`), successful-
// payment `resolve`, and the admin `skip_stage`/`reset` overrides — returning the `m35.dunning.*` outbox
// intents + the `suspend`/`cancel` side-effect signal the T06 caller drives onto the subscription. The
// §4.5 six PUBLISHED seams + the §4.6 three forward-seam CONSUMER VIEWS are bound into the M1 SeamRegistry
// this task too (leaf interfaces in `@wardenx/types`, deny-stubs in the bootstrap; M34↔M35 no-edge per
// ADR-0025). Still deferred: the Fastify routes + the live transport/store/mirror wiring + eraser (T06).

// §3.3 enum value tuples (pgEnum seeds + §2 domain iteration source of truth).
export * from "./enums";
// §2 pure lifecycle/validation kernels + §3.5/§3.6 table catalogs.
export * from "./domain";
// §D6 HMAC pseudonym computation (M35-T03).
export * from "./pseudonym/hasher";
// §2 pure lifecycle SERVICES over injected ports (M35-T03).
export * from "./service";
// §4.13/§4.14/§8.7 outbox-only Stripe adapter — SDK-free client, redactor, idempotency, HMAC webhook
// verifier, dispatcher, webhook ingestion core (M35-T04). All pure over injected ports.
export * from "./stripe";
