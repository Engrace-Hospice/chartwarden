# BIL-2.2 handoff

Reuse the preparation token contract and immutable `claim_submission.reviewed_source_fingerprint`; do not build a second preview ticket or submission ledger. Correction/replacement workflows must bind a new claim/attempt to a new review, while prior submission evidence remains immutable. Preserve `held_stale_source` as a terminal review-required outcome and expose it clearly in claim history.

Before enabling live Claim.MD submissions, complete PostgreSQL migration/RLS tests, worker retry/concurrency tests, and refactor the registered worker transaction so it does not span the external upload. Verify the standard legacy MAC composition binds the shared loader; an incomplete composition fails closed. Do not infer payer acceptance from upload receipt.
