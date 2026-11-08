# Fingerprint and confirmation token

`claim-837i-loader.ts` fingerprints the final mapped `Claim837iInput` after the production mapper has assembled it. Canonical JSON sorts object keys, preserves business array order, omits undefined values consistently, serializes dates as ISO strings, and leaves cents as integers. It excludes the send-time envelope and generated claim control number. Its schema/renderer version is explicit and must be bumped when mapping semantics change.

The HMAC input includes the mapped subscriber (including the transient MBI), provider parties (including the billing identity used by the renderer), claim lines/diagnoses/admission facts, and binding fields: organization, claim, provider, claim version, patient payer, account reference, test/production usage, payer, billing NPI, and verified route fingerprint. The HMAC result is not reversible and never enters logs.

Preparation issues a 10-minute AES-256-GCM token, encrypted with a key derived by HKDF from `CLAIM_PREVIEW_INTEGRITY_KEY`. It is bound to organization, claim, provider, actor, claim version, source fingerprint, route fingerprint, account reference, usage, issue/expiry, and token version. Submit re-authenticates and rechecks all scope and freshness fields. Missing/short key means no actionable confirmation; production Claim.MD config validates the key is at least 32 characters.

The preview digest is not the transmitted-byte digest. Final X12 bytes and their digest continue to be captured at the existing immutable send-evidence boundary.
