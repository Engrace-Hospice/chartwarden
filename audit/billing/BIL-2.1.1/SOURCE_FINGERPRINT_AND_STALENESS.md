# Source fingerprint and staleness

## Current enforcement

The preparation route returns `previewVersion` from the claim projection. Submit continues to require the existing `If-Match` claim version and checks the current scoped payer-route fingerprint before enqueue. The worker revalidates the Claim.MD route fingerprint before transport. These protect the claim row and payer route under their existing contracts.

## Gap

No preview token or fingerprint is currently bound across preview → submit → outbox → worker. A provider billing profile, coverage/MBI source, admission source, or other independently owned reader can change without changing `claim.version`. The worker renders from current reader data, so that situation can produce content that differs from the user's reviewed preview. The frontend's version comparison is only a UI check and cannot close this server-side gap.

Do not advertise a comprehensive stale-source guard. A follow-up must define a keyed opaque confirmation token over canonical renderer business input and route/account/environment, bind it to claim/org/actor and a short expiry, compare at submit, persist it with the immutable attempt, and recompute/compare before transport. Keep send-time immutable evidence and final transmitted-byte digest authoritative. The worker must hold a mismatch without creating another attempt or blindly resending.
