# End-to-end workflow

| Boundary | Evidence | Result |
|---|---|---|
| Synthetic ERA capture / envelope validation | M25 `claimmd-era-capture` and `claimmd-era-delivery` focused tests | Pass; external transport is mocked |
| Verified ownership and encrypted tenant stage | BIL-1/M25 capture and stage services; private M25 live suite uses a persisted encrypted stage | Pass for scoped stage path; no live Claim.MD capture |
| Historical claim identity | Private live test composes `readClaimMdEraCandidateEvidence` (M23) with `readM41HistoricalEraCandidates` against persisted M41 rows and immutable M23 evidence | Pass; real owner queries under `chartwarden_app` |
| Financial review and plan | `buildDrizzleClaimMdEraReviewService`, live PG test | Pass for one fully paid, zero-adjustment commercial claim |
| Approval and execution | Distinct synthetic approver/executor, live PG test | Pass; approval alone creates no M25 effects |
| M25 effects | Actual M25 transaction core | One remittance advice/line and associated transactional outbox events |
| Downstream effects | Existing M23/M24 and M26 consumer live suites | Pass separately; consumers are asynchronous, not part of the M25 commit |

The workflow does not establish bank settlement, general accounts-receivable reconciliation, or completion of asynchronous consumers from the initial M25 response alone.
