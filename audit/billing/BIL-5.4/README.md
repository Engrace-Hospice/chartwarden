# BIL-5.4 — Clearinghouse Operations & Observability

Implemented two read-only boundaries:

- tenant `GET /api/v1/remittance/claimmd-operational-health`, scoped by authenticated organization and server-issued provider scope;
- platform `GET /api/v1/ops/claimmd/observability`, guarded by the existing platform billing permission, platform ABAC, and platform-role check.

The tenant response contains only M25 stages already attributed to that tenant/provider. The platform response reuses audited durable Claim.MD readers and excludes account references, cursor tokens, payloads, credentials, and tenant details. No worker, replay, posting, or transport path was activated.

Runtime RLS was verified with the restricted application role on a disposable PostgreSQL container. The central HTTP authorization contract was tested with real Fastify guards and deterministic reader doubles; an end-to-end central platform-database HTTP suite remains outstanding.
