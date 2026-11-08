# M23 and M41 owner adapters

## Medicare M23

`claimmd-ack/medicare-adapter.ts` reads M23 `claim_submission` and `claim` in the caller's tenant transaction. It requires the exact submission ID, organization, provider, claim, `claim_837i` kind, PCN, evidence attempt key and `submitted` outcome. The claim must still point to that submission through `latest_submission_id`. The M23 reducer gained a distinct `claimmd_receipt_accepted` event for `submitted → ack_pending` in `packages/billing/src/machines/claim.ts`; no `ack_999` row or event is created. Rejected-like and payer-like Claim.MD statuses do not mutate M23. NOE, NOTR and transfer notice rules are untouched.

## Commercial M41

`services/claimmd-ack-adapter.ts` owns all M41 table access. It verifies the exact sent submission, attempt count, provider, location, payer route and PCN, and refuses an older submission when another submission is latest. It reuses `transitionForAck` for the clearinghouse acceptance edge `submitted → ack_pending`, records a normalized `commercial_acknowledgment`, state history and the existing M41 outbox event in the same transaction. It does not settle an in-doubt upload from a normalized response. Rejection and payer acceptance paths remain held/informational pending vendor semantics.

Both adapters reject stale or terminal claim states. A response to an older attempt cannot move a newer claim. M23's existing X12 999/277CA and M41's other-vendor acknowledgment paths remain available for their respective sources.
