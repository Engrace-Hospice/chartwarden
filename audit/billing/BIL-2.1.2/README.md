# BIL-2.1.2 — Reviewed 837I Preview Integrity

## Result

Implemented the source-level preview confirmation chain for interactive M23 837I submissions: keyed canonical business-input fingerprints, a short-lived encrypted confirmation token, submit-time re-render/compare, durable fingerprint on `claim_submission`, outbox propagation, and worker revalidation before transport. The enabled Claim.MD and legacy MAC worker compositions use the same authoritative loader renderer used by preparation. A mismatch terminalizes the original queued attempt as `held_stale_source`; it does not enqueue a retry or send another claim.

The token contains no plaintext PHI and is encrypted with AES-256-GCM using an HKDF-derived key. The source fingerprint uses HMAC-SHA-256 over mapped 837I business data and server binding fields. The actual final outbound byte digest remains generated and stored by the existing BIL-1 send-time evidence boundary.

## Boundaries

- No real Claim.MD requests, submissions, workers, or migrations were run.
- The new migration is marked `compat: contract` because it adds a check constraint and changes append-only terminalization; deployment order requires an operator-reviewed migration step.
- PostgreSQL execution, concurrency, and RLS certification remain for BIL-2 cumulative validation.
- A worker composition missing the authoritative 837I loader/context cannot validate a new reviewed attempt and fails closed. Historical legacy attempts without a fingerprint retain the legacy fallback; Claim.MD attempts require a fingerprint.
- The worker framework still wraps the processor in `withOrgContext`; the pre-existing Claim.MD upload call therefore runs before that transaction scope exits. This phase did not redesign the worker transaction boundary; confirm/resolve it during BIL-2 cumulative concurrency review before activation.

See [fingerprint/token design](FINGERPRINT_AND_TOKEN_DESIGN.md), [worker guard](OUTBOX_AND_WORKER_REVALIDATION.md), [tests](TEST_RESULTS.md), and [readiness](NEXT_PHASE_READINESS.md).
