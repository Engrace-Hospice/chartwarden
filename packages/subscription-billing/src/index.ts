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
// No Drizzle schema (T02), no Stripe SDK (T04), no seams registration (T05), no Fastify routes (T06) yet.

// §3.3 enum value tuples (pgEnum seeds + §2 domain iteration source of truth).
export * from "./enums";
// §2 pure lifecycle/validation kernels + §3.5/§3.6 table catalogs.
export * from "./domain";
