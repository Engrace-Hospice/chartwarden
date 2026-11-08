# Security and migration notes

- Migration: `packages/db/migrations/1352_m23_claimmd_submission_evidence.sql` (`compat: expand`), journaled as ordinal 1352. Additive tables only; no application migration was applied.
- Schema mirror: `packages/db/src/schema/billing/claimmd-submission-evidence.ts` and billing barrel export.
- Ownership: M23 owns evidence tables; M41 uses the typed evidence port and does not import M23 table schema. Both module manifest mirrors were updated.
- RLS: both tables ENABLE and FORCE RLS with tenant `app.org_id` policies. Composite receipt FK binds evidence, org, account reference and usage. Source permissions limit app role to SELECT/INSERT.
- Immutability: database triggers reject evidence UPDATE/DELETE and receipt UPDATE/DELETE. Receipt dedupe is unique and insert uses conflict-do-nothing.
- TIN: AES-256-GCM envelope using tenant DEK provider and evidence-specific AAD; ciphertext is scrubbed in audit trigger JSON. Key version is carried by cipher envelope for rotation.
- Configuration: `CLAIMMD_ACCOUNT_REFERENCE` is a stable non-secret label and required when the configured vendor is Claim.MD. It is separate from the AccountKey; no secret values are included here.
- Boot: `apps/backend/src/index.ts` constructs and injects evidence store only when Claim.MD binding and DB are available. The source wiring does not prove deployment secrets, environment selection, or key-provider health.

## Certification gap

The live tenant-scope test was added to `apps/backend/__tests__/m23-claimmd-response-inbox.live.test.ts` but was not executed. Follow AGENTS.md: use a private fresh PostgreSQL container/database and real NOBYPASSRLS `chartwarden_app`; never use the shared Docker cluster. Confirm audit triggers, denied update/delete, cross-tenant reads, and receipt composite FK with the live app role before migration rollout.
