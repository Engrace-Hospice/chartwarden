# BIL-1.3 readiness

## NEXT-PHASE READINESS VERDICT

**Next phase:** BIL-1.3 — Claim.MD Acknowledgment Integration & Status Provenance

**Verdict:** **NO-GO**

### Evidence supporting the verdict

- BIL-1.2 provides a deterministic fail-closed matcher, encrypted-page event extraction, resolution/history persistence and a bounded worker facade.
- Existing focused offline suites passed: 5 files / 16 tests.
- Existing source migrations specify protected inbox/resolution RLS. Runtime PostgreSQL role and concurrency guarantees were not tested.

### Remaining blockers

- **P1 — immutable send evidence:** M23 and M41 lack durable at-send account/environment plus NPI/TIN/payer/claim-type/PCN/digest snapshots; current provider profile cannot substitute.
- **P1 — candidate routing:** no concrete M23/M41 adapter consuming verified historical evidence; M24 route eligibility remains unconfirmed.
- **P1 — runtime control:** resolver/capture stores reference an internal job ID but no runtime worker registration, scheduler, keyring composition, alerting or audited requeue is bound.
- **P1 — database security:** actual RLS, grants, immutability, concurrency and stale-worker behavior are not verified in private PostgreSQL.
- **P1 — vendor evidence:** receipt namespace/uniqueness and Claim.MD identifier semantics are not confirmed for deployed account workflow; no live or synthetic vendor transaction was performed.

### Allowed next actions

- BIL-1.3 acknowledgment/status dispatch must remain blocked because it could consume unverified or incorrectly scoped identity mappings.
- Resolver activation in test remains blocked pending immutable evidence and candidate/RLS validation. A disabled runtime shell may be implemented, but cannot process events.
- Production activation and production migration are prohibited by this readiness result.

### Required follow-up before the next prompt

An additional corrective PR is required. Exact scope/title: **“BIL-1.2.2 — Immutable Claim.MD Submission Evidence and Verified Candidate Routing”**. It must deliver evidence persistence before send for M23/M41, attempt-scoped receipt history, indexed candidate adapters, runtime wiring disabled by default, safe internal requeue, and private-PostgreSQL RLS/concurrency tests. Do not include BIL-1.3 acknowledgment application.

### Suggested next prompt

**“BIL-1.2.2 — Implement Immutable Claim.MD Submission Evidence and Verified M23/M41 Candidate Routing; keep resolver disabled and do not implement BIL-1.3.”**

### Three separate decisions

| Decision | Result | Basis |
|---|---|---|
| Ready to implement BIL-1.3 | **No** | Candidate routing lacks immutable source evidence. |
| Ready to activate resolver in controlled test | **No** | No concrete adapter/runtime and no private-Postgres validation. |
| Ready for production | **No** | All above plus vendor account/identifier semantics remain unverified. |
