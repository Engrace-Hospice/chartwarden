# Security and RLS

## Source guarantees versus runtime proof

BIL-1.1 inbox migration creates a `NOLOGIN`, `NOBYPASSRLS` `claimmd_capture` role and FORCE RLS policies for inbox stream/batch/event tables (`packages/db/migrations/1350_m23_claimmd_response_inbox.sql`). BIL-1.2 adds restricted resolution/history access in migration 1351. This is source evidence only; migrations were not applied in an isolated database during this phase.

The resolution store performs cross-tenant reads using `withPlatformContext` and the capture job ID (`apps/backend/src/modules/23-billing-medicare/claimmd-identity/store.ts:33-39`). The necessary job registration is absent. The backend guide requires private PostgreSQL live tests as a real NOBYPASSRLS app role and explicitly prohibits live suites against shared Docker because roles are cluster-global; the available `os-postgres-1` is therefore not used.

## Identity protection

M2's Tax ID encryption is tenant/provider-row bound (`apps/backend/src/modules/02-identity/tax-id-cipher.ts:47-50`). A submission evidence design needs an approved submission-bound envelope and narrowly scoped access; plaintext TIN cannot appear in logs, history, or tenant APIs. The BIL-1.2 event extractor temporarily reads vendor-supplied provider fields from decrypted inbox pages; those values must not be copied into tenant-facing responses.

## Not yet demonstrated

- Cross-tenant candidate query denial under actual app roles.
- Capture-role grants and denial on unrelated schemas.
- Immutable evidence update/delete protection.
- Concurrent lease and stale-worker fencing on PostgreSQL.
- Insert/update races and rollback behavior.
- Tenant authorization against mismatched provider, claim, ERA, or URL IDs.

These must be covered using a private, disposable PostgreSQL cluster and synthetic data before any runtime activation.
