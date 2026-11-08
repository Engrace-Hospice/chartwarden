# Financial non-posting guarantees

`claimmd-era-delivery.ts` explicitly documents and structurally enforces a non-posting boundary: its service object exposes only `deliver` and `runOnce`; it has no posting-capable dependency. `claimmd-era-stage.ts` writes `claimmd_era_m25_stage`, not `remittance_advice`, and does not publish an event. It never calls M25 `receiveAdvice` or `postAdvice` (`service-drizzle.ts` contains those existing methods and their `m25.edi.835_received` behavior).

Consequently the new path has no code path to create applied payment records, post CAS/PLB adjustments, alter AR or patient balances, close claims, or initiate refunds/recoupments. Staging `staged` means review eligibility only. The focused delivery test asserts the exposed service has no `receiveAdvice` or `postAdvice` method and verifies the tenant row is finalized only after the central receipt. Source inspection is not runtime financial certification; DB integration tests are still required.

Protected normalized details retain parsed transaction-set content (including claim/line adjustments represented by the existing parser) encrypted in M25. Unsupported content remains in the central original protected artifact. Verify parser coverage for negative, reversal, PLB, zero-pay and unsupported segments during BIL-1.5 before opening a review/post workflow.
