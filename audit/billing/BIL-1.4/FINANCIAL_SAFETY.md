# Financial safety

No payment or adjustment posting code was added. The new duplicate helper uses digests and control numbers for exact duplicate classification; payment trace plus integer minor units yields a review hold, never an automatic merge. This is a decision helper only: no cross-source lookup against M25, SFTP, or manual imports is wired.

The original 835 remains the required source of truth. The M25 parser, rather than ad hoc string splitting, must be used in the capture/resolution service. PLB, CAS, CARC/RARC, recoupments, reversals, zero-pay and partial payments require existing M25 parsing/reconciliation rules. New code does not authorize financial reconciliation or posting. Any unsupported or unbalanced content must remain reviewable with encrypted source evidence.

`receiveAdvice` must not be used as an interim stage API: its `m25.edi.835_received` consumer calls `postAdvice` and creates financial ledger/outbox effects. BIL-1.4's future staging operation must stay isolated until a separately authorized financial action.
