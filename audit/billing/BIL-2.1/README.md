# BIL-2.1 — M23 Claim Preparation, Validation & Verified Payer Route

## Result

Implemented a scoped, effective-dated Claim.MD payer-route resolver; blocked the MAC-jurisdiction and global-override fallbacks for Claim.MD; added an authorized read-only claim preparation projection; and surfaced route/readiness in the M23 claim editor. Existing M23 assembly, validation, payload generation, immutable evidence and MAC-direct behavior remain the source paths.

The route table does not exist in the current schema. `CLAIMMD_M23_PAYER_ROUTES` is therefore platform-owned deployment configuration, not tenant-editable payer setup. Entries must be explicitly verified and must refer to an active M40 X12 payer record; no MAC value is backfilled. No live API, migration, worker activation or claim transmission was performed.

## Important limitation

The preparation endpoint returns route state, claim version and readiness; claim details and lines remain on their existing authorized endpoints. It intentionally returns no raw X12. A payload digest is not yet produced by this read path (`payloadDigest: null`); the exact final bytes and immutable digest are still captured at the existing worker send boundary. Thus this establishes a safe structured preflight but does **not** certify byte-identical preview-to-send. See [CLAIM_PREVIEW_CONTRACT.md](./CLAIM_PREVIEW_CONTRACT.md).

## Source changes

- `jobs/clearinghouse-context.ts`: explicit route matching on organization, provider entity, MAC, Claim.MD account reference, account usage and effective interval.
- `jobs/m23-jobs.ts`: Claim.MD launch requires scoped route configuration; the global payer override is refused for Claim.MD.
- `routes/claims.routes.ts`: guarded `GET /api/v1/billing/claims/:id/preparation`; the existing submit route refuses an unverified Claim.MD route before queueing.
- `apps/backend/src/index.ts`: binds route readiness to the same context resolver used by workers.
- `apps/web/.../claim-editor.tsx`: shows route state, claim version, validation/readiness and prevents submit when the read projection is unavailable or blocked.

## Verification

See [TEST_RESULTS.md](./TEST_RESULTS.md). Runtime Claim.MD/MAC route certification remains external and is not inferred from source tests.
