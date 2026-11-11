# Balance and AR integrity

The plan reports billed charge, payer payment, payer-reported patient responsibility, source CAS entries, and unresolved amount separately. For the supported partial case, `unresolved = charge - payer payment`; the single OA amount must equal that difference and is persisted through existing M25 adjustment logic as flagged for review.

No patient receivable, patient invoice, write-off, or new payer receivable is created. The payment effect is the actual payer payment only. This preserves the M25 ledger boundary and avoids converting a balanced 835 into an unsupported accounting instruction. Monetary eligibility and comparison use the repository's decimal-to-cents conversion.
