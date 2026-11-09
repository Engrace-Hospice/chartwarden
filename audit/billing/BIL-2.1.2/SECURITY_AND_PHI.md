# Security and PHI

- Token AEAD is AES-256-GCM; per-token nonce is random, AAD and HKDF info are domain separated.
- Fingerprint is keyed HMAC over the final mapped business input; raw MBI/TIN and payload never enter token or stored attempt metadata.
- Token binds organization, claim, provider and authenticated actor; submit still runs route permissions, provider/caseload ABAC and step-up guards.
- Preparation returns only the structured safe summary and field/reason validation gaps. It does not return the fingerprint.
- MBI remains purpose-audited under the existing preview disclosure purpose; submit re-render repeats that audit. Worker continues the submission-purpose read.
- RLS/table ownership were not weakened. Migration adds metadata only to the existing M23-owned `claim_submission` table.
- Do not log the token, source fingerprint, mapped input, MBI, TIN or X12.

`CLAIM_PREVIEW_INTEGRITY_KEY` must be a stable random secret (32+ characters), provisioned consistently to API and worker processes. Rotation while jobs are queued intentionally causes fingerprint mismatch and a safe hold; rotate only with an operational drain/review plan.
