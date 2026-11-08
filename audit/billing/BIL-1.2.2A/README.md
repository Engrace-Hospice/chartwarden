# BIL-1.2.2A — Immutable Claim.MD Submission Evidence

## Verdict

**NO-GO for production Claim.MD submission. CONDITIONAL GO to begin BIL-1.2.2B in an isolated, non-production branch.** M23 and M41 now reserve evidence for Claim.MD claim sends before the transport call, bind the final X12 digest and identity facts, encrypt TIN, and append the upload receipt identifiers after a positive receipt. Focused tests and the affected TypeScript build pass. This does not certify database migration/RLS behavior, deployed account configuration, Claim.MD response semantics, or M23 regulatory notice submission. The database live suite and external API were intentionally not run.

## Scope

This change adds immutable outbound evidence for Claim.MD M23/M41 claim submissions only. It does not implement the BIL-1.2.2B candidate adapter/resolver, account response poller, acknowledgment normalization, ERA ingestion/posting, portal enrollment automation, or production activation. Existing uncommitted BIL-1.1/1.2/1.2.1 work was present in the shared tree and was preserved; the working tree is not a clean baseline.

## Evidence

- Parser, digest, transaction identity extraction: `packages/x12-837-client/src/clearinghouse/submission-evidence.ts`.
- AES-GCM TIN envelope with evidence-bound AAD: `apps/backend/src/modules/23-billing-medicare/claimmd-evidence/cipher.ts`.
- Evidence/receipt schema and migration: `packages/db/src/schema/billing/claimmd-submission-evidence.ts`, `packages/db/migrations/1352_m23_claimmd_submission_evidence.sql`.
- M23 and M41 pre-send reservation: `apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts`, `apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.ts`.
- Backend binding and stable account reference: `apps/backend/src/index.ts`, `apps/backend/src/bootstrap/env.ts`, `apps/backend/src/modules/23-billing-medicare/clearinghouse-binding.ts`.

## What this establishes

The caller persists parsed identity and the SHA-256 of the exact outgoing X12 string before invoking Claim.MD. The TIN is stored as a versioned encrypted envelope; the parsed representation is transient. Evidence and receipt rows have tenant RLS and append-only enforcement in migration source. Claim.MD upload response fields (`fileid`, `batchid`, `claimid`, `claimmd_id`, `remote_claimid`, `pcn`) are retained with their original field name when returned. Generic/replayed receipts are recorded as opaque rather than misrepresented as a vendor field.

The upload boundary fails closed when evidence wiring, final X12 identity, one-claim-per-send, environment alignment, or required M23 attempt metadata is absent. Other clearinghouse vendors are not gated by the Claim.MD evidence port.

## Limitations and blockers

- No migration was applied and no isolated NOBYPASSRLS live test ran. RLS and trigger behavior are source-reviewed, not runtime-certified.
- No test or production Claim.MD credentials were inspected or used. `CLAIMMD_ACCOUNT_REFERENCE` is a stable, non-secret configuration label; whether deployment wires it correctly is unknown.
- M23 NOE/NOTR/transfer notice send callers currently lack the evidence metadata path and therefore fail closed before Claim.MD HTTP. This slice is not full M23 Claim.MD regulatory coverage.
- Attempt storage in the transport remains separate from immutable evidence. Evidence is the durable pre-send identity record; receipt observation follows positive transport result. Crash reconciliation / replay evidence enrichment needs BIL-1.2.2B.
- Vendor semantics for each receipt field and institutional hospice transaction readiness require confirmation from Claim.MD and payer enrollment records.

## Verification performed

- `bunx vitest run packages/x12-837-client/src/clearinghouse/submission-evidence.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-evidence/cipher.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.test.ts` — 4 files, 26 tests passed.
- `bunx tsc -b ./apps/backend ./packages/x12-837-client ./packages/db` — passed.
- Earlier in this task sequence: `bun run arch:ddl`, `bun run arch:migration-compat`, `bun run arch:migration-numbering`, `bun run arch:manifest-mirror`, `bun run arch:tenancy`, `bun run arch:tables` passed; rerun after final changes before merge.
- Not run: test suite broadly, DB live suite, migration application, API/network request, deploy, production rollout.

## Next safe implementation PR

BIL-1.2.2B should build the candidate adapter and resolver on top of this evidence schema, with account-scoped durable response capture and tenant-safe identity resolution. Keep resolver/production activation disabled until private-DB RLS/live evidence tests pass, response correlation is demonstrated against Claim.MD test-account fixtures, and M23/M41 coexistence is proven. Include M23 notice evidence coverage before enabling those transaction types.
