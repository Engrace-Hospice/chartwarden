# M25 staging contract

## Boundary

`createClaimMdEraDeliveryService` in `apps/backend/src/modules/25-remittance/ingest/claimmd-era-delivery.ts` consumes a central captured ERA and a current verified ownership decision. It parses transaction sets through `parseX12835AllSets`, then calls M25-owned `stageVerifiedClaimMdEra` (`claimmd-era-stage.ts`). The tenant stage row is created under `withOrgContext`; M1 provider and location owner readers validate the provider belongs to the verified organization and the optional location belongs to that provider.

The row records Claim.MD account/environment/ERA, source and per-file digests, resolution ID/version, transaction controls, stable component idempotency key, encrypted normalized transaction-set/claim outcome details, and safe state/reason. Raw 835 remains in the central encrypted inbox; tenant staging does not copy the raw document. The stage table remains owned by M25.

## State interpretation

- `held` / `DELIVERY_PREPARED`: durable stage exists but central delivery receipt/finalization is incomplete; not review-eligible.
- `staged`: delivery receipt is committed and stage is eligible for future authorized review; it does not mean paid/settled.
- `possible_duplicate`: review hold; not independently postable.
- `held` with an exact-duplicate reason: duplicate reference only; not independently postable.

Unmatched claim outcomes are retained in encrypted details with `claimId: null`; no WardenX claim ID is invented. Component conflict/ambiguity or parse/source verification failures hold the delivery. Mixed ownership remains governed by the BIL-1.4.1A verified decision and cannot be split by this service.

## Non-posting contract

The service has no `receiveAdvice`, `postAdvice`, outbox publisher, ledger, AR, claim-closure, or patient-balance port. No `remittance_advice` financial intake record is created by the new path. M25 posting behavior for existing sources is unchanged.

## State scope

The implementation is a staging persistence boundary, not a new remittance engine. Current UI/review consumption of these protected details is not proven by this change and must be established before controlled staging is presented to billing staff.
