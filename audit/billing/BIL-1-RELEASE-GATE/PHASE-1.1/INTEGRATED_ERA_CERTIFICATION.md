# Integrated ERA certification

**Status: BLOCKED — no integrated two-tenant ERA test was executed.**

Relevant source is present in `apps/backend/src/modules/25-remittance/ingest/claimmd-era-{capture,store,resolution,delivery,stage}.ts`; review is registered under `apps/backend/src/modules/25-remittance/routes/claimmd-era-review.routes.ts`. Delivery stages encrypted tenant-scoped review records and has no posting-capable service port. Those source facts do not prove database end-to-end behavior.

`packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts` passed 16/16 on the isolated PG18 instance, but it is generic M25 RLS coverage. No synthetic X12 835 Claim.MD account discovery/download, real resolver/evidence reader, tenant stage delivery, route review or persisted no-payment/no-AR assertion ran in Phase 1.1.

All requested mixed payee, multi-claim/transaction, PLB, reversal, duplicate source, stale ownership, duplicate stage, tenant review and requeue scenarios remain unverified in one integrated database scenario. Do not enable ERA capture or M25 stage delivery based on the RLS result alone.
