# Integrated response certification

**Status: BLOCKED — no integrated certification was executed.**

Relevant source chain:

1. `claimmd-capture/service.ts` claims an account/environment stream and commits encrypted pages through `claimmd-capture/store.ts`.
2. `claimmd-identity/candidate-provider.ts` queries immutable submission evidence and owner-exported M1/M41 readers under a supplied snapshot.
3. `claimmd-identity/service.ts` resolves and persists a versioned result.
4. `claimmd-ack/service.ts` interprets only approved representations and applies M23/M41 owner adapters with a tenant transaction and application ledger.

The existing live test `apps/backend/__tests__/m23-claimmd-response-inbox.live.test.ts` passed 3/3. It checks central inbox denial for `chartwarden_app`, RLS FORCE, a two-connection concurrent lease winner, and evidence/receipt SQL. It does **not** create two tenants' source claims or run capture → actual DB candidate adapter → resolution → dispatcher.

Required scenarios (same PCN cross-tenant, shared TIN/different NPI, historical attempts, ambiguous and conflicting evidence, unsupported status, stale resolution, duplicate dispatch, no regression) remain pending. No claim status/application ledger result is claimed by this phase. See `PHASE_1_2_HANDOFF.md`.
