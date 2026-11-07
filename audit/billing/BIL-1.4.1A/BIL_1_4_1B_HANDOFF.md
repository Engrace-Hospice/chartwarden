# BIL-1.4.1B handoff

Consume only central `claimmd_era_resolution` rows in `verified` state whose source inbox remains captured and whose account/environment and original digest still agree. Reopen the encrypted decision only through an audited M25 internal boundary. Require algorithm and resolution versions to match the staged source proof. A missing, stale, changed, conflict, or malformed resolution must hold.

Use claim-level outcomes independently from payee owner: a verified payee with an unmatched CLP must not create or guess a WardenX claim. Mixed payees already hold the entire source; do not split or clone the original 835. Preserve payment, PLB, CAS, reversal and unknown-segment provenance in the protected source. Implement cross-source duplicate checks and stage-only idempotency. Do not call `receiveAdvice`, `postAdvice`, emit `m25.edi.835_received`, or mutate financial records.

First tests should cover duplicate inbox delivery, stale resolution/version, same PCN across tenants, same provider across locations, mixed transaction sets, and no-post side effects. BIL-1.4.1A activation remains disabled pending live database/vendor certification.
