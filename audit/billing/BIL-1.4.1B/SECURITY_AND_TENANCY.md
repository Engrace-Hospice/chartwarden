# Security and tenancy

- Central inbox/resolution/delivery records are accessed by the registered audited platform job `m25-claimmd-era-delivery`; store methods use the platform-context wrapper. The application tenant role does not receive a central raw-document API.
- The source read reuses `readCapturedEra` integrity/decryption checks; delivery then verifies account reference, test/production usage, vendor, captured state, ERA ID, digest, current resolution, decision digest, and matching resolution-history row.
- M25 stage writes occur in `withOrgContext`. M1 owner readers confirm provider organization and optional location/provider association in the tenant operation. The stage table is tenant scoped; central tables use FORCE RLS and grant only the `claimmd_capture` privileged role required by the audited store.
- Tenant stage details are encrypted with the Claim.MD protected payload keyring. Operational summaries contain counts only; caught worker errors do not log payload/parser exception text.
- `CLAIMMD_ERA_M25_DELIVERY_ENABLED` activates only for exact `true`; it is independent of capture and resolution flags, and startup rejects API role. The worker is not activated by this implementation unless an operator explicitly enables that flag in a worker environment.

Relevant sources: `apps/backend/src/index.ts`, `apps/backend/src/modules/25-remittance/ingest/claimmd-era-store.ts`, `claimmd-era-stage.ts`, `claimmd-era-config.ts`, `packages/db/migrations/1358_m25_claimmd_era_delivery.sql`, and `packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts`.

The live RLS suite was not executed. Database privilege, cross-tenant, concurrent replay, and audit-event behavior remain runtime certification requirements. The planned suite asserts tenant role cannot select the central delivery ledger and the capture role can access it under its approved platform path.
