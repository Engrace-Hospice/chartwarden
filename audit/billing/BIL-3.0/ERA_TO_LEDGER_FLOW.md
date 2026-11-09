# ERA to Ledger: Current Flow and Boundaries

## Claim.MD staged path

`/services/eralist/` discovery → protected account-wide inbox → `/services/era835/` / `/services/eradata/` capture → X12 835 parsing → verified tenant/provider ownership resolution → recoverable delivery receipt → encrypted M25 stage → tenant-scoped GET review.

Relevant source: `apps/backend/src/modules/25-remittance/ingest/claimmd-era-capture.ts`, `claimmd-era-delivery.ts`, `claimmd-era-stage.ts`, `claimmd-era-review.ts`; route registration is `routes/claimmd-era-review.routes.ts` mounted from `routes/mount.ts` and composed in `apps/backend/src/index.ts`.

The review consumer reads only `claimmd_era_m25_stage` through organization/provider predicates and `withOrgContext`. The new detail read decrypts a selected tenant stage using stage-scoped authenticated encryption. The list is bounded and returns payer/payee/payment summary, claim count, identity exception count and stage state; it omits claim lines and trace. It does not query the central inbox.

## Existing manual/SFTP intake and posting path

`M25IngestService.receiveAdvice` validates the envelope, file digest, parsed transaction sets and payee before inserting tenant-owned advice rows. `queueEnvelope` emits `m25.edi.835_received` in the same transaction. The live `m25.parse-and-post` consumer in `outbox-consumers/live-binding.ts` calls `postAdvice`.

`postAdvice` reads staged source and parses again, then uses a transaction/row lock and a cross-source identity guard before `postClaim` and adjustment operations. Consequences include remittance line state, claim/payment status events, denial cases, patient responsibility ledger entries and other financial records depending on matching and classification. `receiveAdvice` is therefore not a harmless staging operation.

## Side-effect boundary

The BIL-1 Claim.MD delivery service explicitly has no `receiveAdvice`, `postAdvice`, outbox publisher, ledger, AR or balance port. BIL-3.0's UI only issues GET calls. It does not emit `m25.edi.835_received`, create `remittance_advice`, invoke the legacy consumer, or alter M25 posting flags.

## External semantics used

CMS states that an ERA may report multiple claims and adjustments at claim, line, or provider level. That supports showing a multi-claim and PLB-aware review, but this phase does not introduce accounting rules or equate an ERA with bank cash. See [CMS Health Care Payment and Remittance Advice](https://www.cms.gov/medicare/coding-billing/electronic-billing/health-care-payment-remittance-advice) (page last modified 2024-09-10) and [CMS EFT/ERA Operating Rules](https://www.cms.gov/priorities/key-initiatives/burden-reduction/administrative-simplification/operating-rules/eft-remittance-advice) (accessed 2026-11-08). No proprietary X12 implementation-guide text is copied.
