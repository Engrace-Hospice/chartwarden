# Financial source-of-truth matrix

| Measure | Owner/source | Date and scope | Reporting treatment |
|---|---|---|---|
| Medicare claim lifecycle and submitted attempt | M23 claim and immutable submission evidence | M23 source dates; org/provider plus M23 access rules | Existing operational worklists only; no consolidated financial aggregate in this increment. |
| Medicaid claim state | M24-owned claim/feedback contracts | M24 source semantics | Existing operational visibility only; no unsupported transmission or financial inference. |
| Commercial lifecycle and historical submitted evidence | M41 owner readers; caseload authorization applies | Attempt/source-specific; mutable current charges are not historical evidence | Existing operational views; not added to the M25 aggregate. |
| Payer-reported ERA payment | M25 persisted BPR and CLP fields | `remittance_advice.received_at`, UTC; authenticated org and authorized provider | Separate BPR ERA total (includes source PLB context) and CLP claim-payment sum. |
| M25 posted claim payment | M25 persisted remittance line/posting state | Same receipt-date window for this summary | CLP amount included only for fully `posted` advice; partial advice is counted separately and not represented as complete posted total. |
| CAS adjustments | M25 persisted adjustment group/amount | ERA receipt-date scope | Reported totals by CO/CR/OA/PI/PR; not represented as authorized write-off or patient billing. |
| PLB | M25 advice-level provider adjustment | ERA receipt-date scope | Signed provider-level amount shown separately; never allocated to a claim. |
| Payer/patient receivable, write-off, bank settlement | No canonical authoritative ledger contract found | Not available | Unavailable; no billed-minus-paid derivation. |
| M26 CAP accrual | M26 | Accrual domain, not payer-cash/AR | Excluded from payment and A/R metrics. |

Money is returned as integer-cent strings. Counts are exact for the filtered M25 advice relation and its scoped aggregates, not for all Revenue Cycle claims or central Claim.MD stages.
