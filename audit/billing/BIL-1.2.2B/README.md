# BIL-1.2.2B — Candidate adapter and resolver runtime

## Summary and verdict

**Implementation: partial, disabled by default. BIL-1.3 development: CONDITIONAL GO. Controlled-test resolver activation: NO. Production activation: NO.** This slice adds a database-backed M23/M41 candidate provider, uses only immutable BIL-1.2.2A evidence, correlates explicit Claim.MD fields without namespace coercion, fences resolution writes by lease token/version, provides bounded retries and internal audited requeue, and composes a resolver worker behind the existing explicit flag. It does not dispatch acknowledgments, mutate billing claims, process ERA, post money, or activate Claim.MD production traffic.

## Implemented

- Candidate query adapter: [`candidate-provider.ts`](../../../apps/backend/src/modules/23-billing-medicare/claimmd-identity/candidate-provider.ts).
- Existing matcher strengthened for exact receipt namespaces, conflicting identifiers, historical NPI/TIN/payer/PCN checks, file-only refusal, and bounded-search ambiguity: `claimmd-identity/resolve.ts`.
- Existing resolver store now decrypts the captured BIL-1.1 page, persists evidence references/location, filters account/environment, enforces lease-token writes and bounded retry, and has a constrained audited requeue method: `claimmd-identity/store.ts`.
- Explicit worker composition and scheduler in `apps/backend/src/index.ts`; the worker only runs when `CLAIMMD_IDENTITY_RESOLUTION_ENABLED=true` and all configuration/schema prerequisites pass.
- Upload-list reconciliation preserves `inboundid` as its source field and returns it as a receipt observation; absent/oversized IDs now remain unresolved.
- Migration 1353 grants the existing non-login `claimmd_capture` role specific read access to evidence, source associations and location/provider ownership, adds resolution location columns and a receipt lookup index, and expands the allowed resolution reason codes. It introduces no new inbox or evidence tables. It is marked `compat: contract` because the repository migration checker treats replacing the reason-code constraint as contracting; deployment must follow that gate's rollback behavior.

## Scope limits

M23 NOE/NOTR/transfer notice Claim.MD sends remain fail-closed because their callers do not provide immutable evidence metadata. M24 state-direct work is unchanged; there is no evidence path that would make it a Claim.MD candidate. BIL-1.1 capture remains a separate inactive foundation; this worker consumes already captured events and does not advance its cursor or implement a new network poller.

The prompt-required `audit/billing/BIL-0/` and `audit/billing/BIL-1.1/` documents are absent in this checkout. BIL-1.2, BIL-1.2.1 and BIL-1.2.2A docs exist and were reviewed. This documentation gap does not change adapter authority but limits end-to-end historical certification.

## Runtime guarantees and limitations

The resolver is a privileged internal worker using the audited platform DB context, but does not expose central inbox/candidate results through tenant routes. Candidate queries require the configured account reference/environment and at least one PCN or exact stored vendor field. Queries cap at 100; overflow returns ambiguous. Decrypted TIN exists only in the bounded candidate loop and is compared in memory. Key failures retry safely and eventually move the event to review; no current provider profile fallback exists.

Worker readiness checks the stable account/environment, inbox keyring configuration, M34 tenant key-provider seam, platform DB, prebootstrapped response stream, and schema/column privileges before starting. The per-tenant DEK is verified when a candidate is decrypted; actual key availability for every tenant is not probed during startup.

## Next safe phase

BIL-1.3 may be developed behind the inactive boundary for identity-resolved events. It must preserve response origin, require resolution evidence, and keep business-state application separately gated. Controlled activation requires private PostgreSQL/RLS validation, synthetic captured-event integration tests, key configuration, and BIL-1.1 capture/runtime ownership clarified. Production remains blocked.
