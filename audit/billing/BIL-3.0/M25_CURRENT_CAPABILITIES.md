# M25 Current Capabilities

Statuses distinguish implementation evidence from runtime certification. “Verified” below means source and focused tests were reviewed; no BIL-3.0 live PostgreSQL/RLS certification was run.

| Capability | Assessment | Evidence / current limit |
|---|---|---|
| ERA discovery/capture | IMPLEMENTED BUT INCOMPLETE | Account-scoped Claim.MD discovery/capture and retry/cursor workers exist under `apps/backend/src/modules/25-remittance/ingest/claimmd-era-*`; feature flags remain disabled by default and vendor/runtime activation is not certified. |
| Raw 835 storage | IMPLEMENTED AND VERIFIED (source/tests) | Original raw source remains encrypted in the protected central inbox; tenant M25 stage stores encrypted normalized details, not raw X12. See `claimmd-era-store.ts`, `claimmd-era-stage.ts`, and BIL-1.4.1B staging contract. |
| X12 parsing | IMPLEMENTED AND VERIFIED (focused tests) | `claimmd-era-delivery.ts` uses `parseX12835AllSets`; it stages parsed transaction sets and their claims, service lines, CAS adjustments, remarks and provider adjustments. |
| Tenant attribution | IMPLEMENTED BUT INCOMPLETE | Verified provider/organization ownership and ambiguous/conflicting holds exist; live RLS certification is deferred. Mixed ownership is not split by tenant. |
| ERA duplicate detection | IMPLEMENTED BUT INCOMPLETE | BIL-1 staging detects exact/possible cross-source duplicates. Existing M25 posting serializes supported exact identities, but global PostgreSQL concurrency certification is not part of this phase. |
| Nonposting stage | IMPLEMENTED AND VERIFIED (source/tests) | `stageVerifiedClaimMdEra` persists a tenant row in `held`, then only finalizes as `staged` after delivery receipt. It has no posting-capable dependency. |
| Tenant review | IMPLEMENTED (this phase) | GET routes were already scoped; this phase adds aggregate list contract and web review/detail UI. No financial action is exposed. |
| Claim identity correlation | IMPLEMENTED BUT INCOMPLETE | Resolver correlates 835 claim control numbers against immutable M23/M41 submission evidence; `verified`, `ambiguous`, `conflict`, and `unmatched` are identity outcomes, not financial allocations. Service-line allocation is NOT IMPLEMENTED. |
| Manual reconciliation | IMPLEMENTED BUT INCOMPLETE | Existing `/api/v1/remittance/lines/:id/manual-match` applies to existing M25 remittance lines. It does not consume Claim.MD staged records. |
| Adjustment classification | IMPLEMENTED BUT INCOMPLETE | Legacy posting handles CAS/CARC/RARC and denial/PR-ledger effects; some unmapped/uncertain adjustments are held for review. New stage review displays adjustment data only. |
| Provider-level PLB | IMPLEMENTED BUT INCOMPLETE | Existing intake stores a PLB total; new stage review displays parsed provider-level adjustments. Full allocation/reconciliation of PLB against accounting remains open. |
| Payment allocation/posting | IMPLEMENTED BUT INCOMPLETE | Legacy `postAdvice` creates matched/unmatched financial consequences in a transaction. It must not be used as a staging read path. BIL-3.0 adds no staged posting. |
| Reversals/recoupments | IMPLEMENTED BUT INCOMPLETE | Existing posting domain recognizes CLP reversal/recoupment outcomes and emits domain events; staged Claim.MD review does not apply them. |
| Financial history | IMPLEMENTED BUT INCOMPLETE | Legacy advice/line and financial event history exists. Tenant-visible immutable Claim.MD stage processing history is not exposed by the current review contract. |
| Recovery | IMPLEMENTED BUT INCOMPLETE | Capture, ownership and delivery retry/recovery foundations exist; operational certification and durable review history remain separate work. |
| Cross-tenant protection | IMPLEMENTED BUT INCOMPLETE | Review read uses `withOrgContext`, organization equality, provider scope and no central-inbox query; focused route tests pass. Actual NOBYPASSRLS database validation is deferred. |
