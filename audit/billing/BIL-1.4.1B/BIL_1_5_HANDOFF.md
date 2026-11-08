# BIL-1.5 handoff

BIL-1.5 should perform cumulative integration hardening rather than assume the BIL-1.4.1B unit path is runtime-certified.

1. Run complete build, typecheck, full non-live tests, and architecture fitness against the integrated BIL-1 branch.
2. Use a private `pgvector/pgvector:pg18` PostgreSQL instance and real NOBYPASSRLS application role. Exercise migration 1358, RLS, tenant A/B isolation, stage/ledger atomic recovery, concurrent duplicate workers, advisory lock contention, and stale resolution races.
3. Prove no `m25.edi.835_received`, `receiveAdvice`, `postAdvice`, ledger/AR/patient-balance mutation from Claim.MD staging, including an instrumented real DB/outbox assertion.
4. Test synthetic 2-tenant/multi-location/provider fixtures and all captured 835 edge cases; verify encrypted unmatched details, PLB/reversal/negative handling, and no fabricated claim IDs.
5. Establish the M25 review/matching consumer and audited bounded requeue workflow, or keep delivery disabled.
6. Test legacy Claim.MD worker quiescence and API/SFTP/manual duplicate scenarios before staged account activation. Preserve cursor state.
7. Only after those gates, run approved Claim.MD test-account certification with synthetic identifiers and no real claim upload; production activation remains a separate release decision.

No BIL-1.5 work is started by this handoff. Cumulative validation includes all deferred checks above.
