# Downstream and financial status

No events or consumers changed. BIL-4.2's `m25.remittance.claim_partial_paid` remains the event for the supported OA partial case; M41 remains `partially_paid`, and M26 receives actual payer-paid cents only. CO/PR/PI plans are blocked before M25 advice or outbox effects are created, so they cannot trigger full-paid or partial-paid transitions.

M25 commit/outbox delivery and downstream consumer processing remain separate. A payer adjustment is not evidence of cash settlement or a committed write-off.
