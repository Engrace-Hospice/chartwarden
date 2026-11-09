# Security and financial isolation

- M25 first authorizes the staged ERA under the authenticated organization and provider scope.
- M23 owns the shared Claim.MD submission-evidence projection; M41 validates its own commercial attempt and correction lineage through an owner-exported reader. M25 receives only bounded facts.
- No account-wide inbox, ciphertext, TIN, member ID, raw X12 or credentials are returned by candidate APIs.
- Candidate selection is revalidated server-side and cannot override a hard conflict.
- Matching permission remains separate from `remittance.read` and any posting permission.
- The review API and manual decision have no calls to `receiveAdvice`, `postAdvice`, financial event publishers, allocation or ledger services.
- `postingAuthorized` remains false.

No live Claim.MD request, worker activation, production migration, allocation or financial posting was performed.
