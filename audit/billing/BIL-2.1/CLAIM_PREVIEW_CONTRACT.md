# Claim preparation projection

`GET /api/v1/billing/claims/:id/preparation` reuses the existing M23 claim detail read service and runs the same Claim.MD route context resolver used by the submission workers. Claim detail and lines remain on their existing read endpoints; the preparation response contains only route status, claim version, generated time, eligibility and digest availability. It is protected by `billing.claim.read` and the claim caseload/provider ABAC guard and is read-only.

The response includes route state/reason code only (never fingerprint), claim version, timestamp, null payload digest with status explicitly unavailable, and a conservative `submissionEligible` value. It omits payer identifiers, account references, NPI/TIN, MBI, secrets and raw 837 content. The UI does not calculate billing values independently: it displays existing server projections and line totals from the existing detail and line endpoints.

The current read services do not expose a renderer-safe preview without opening MBI under a preview-specific disclosure purpose. The endpoint therefore reports `payloadDigest: null` and `payloadDigestStatus: not_available_from_read_projection`; it does not claim byte equivalence. At send time, the existing M23 renderer builds the payload and BIL-1 reserves immutable Claim.MD evidence from the exact outbound X12 before the network call.

The editor reload path obtains the preparation projection alongside claim and lines. It binds readiness to the response's claim version. Any failure to load the projection blocks UI submission; the API submit gate and worker route check remain authoritative. A 412/validation error from existing submission concurrency checks continues to require a fresh read.

## Follow-up needed

To provide an exact digest before confirmation, create an audited preview-only MBI disclosure purpose and render through the same final mapper/renderer in a read-only transaction, then return only safe structured facts and SHA-256 of the exact representation. The browser must never receive MBI or raw X12. Add an atomic claim/source-version fingerprint and reject submit if it changed after preview. This is intentionally not misrepresented as completed here.
