# Release blockers

1. **P1 — Audited recovery absent.** No privileged, idempotent operator requeue for exhausted capture/resolution/delivery; implement audited action history and fenced retries.
2. **P1 — Financial guard lacks PostgreSQL proof.** Exact duplicate hold is source-implemented, but concurrent cross-source insert/post races and valid distinct payments need private disposable PostgreSQL tests.
3. **P1 — Operational visibility incomplete.** Required backlogs/age/lease/readiness metrics and alert thresholds are absent.
4. **P1 — Notice evidence incompatibility.** NOE/NOTR/transfer Claim.MD remains blocked by claim-only evidence requirements; fail-closed behavior is preserved.
5. **P1 — Runtime certification absent.** Keyring, service-role grants, prebootstrapped streams, leases and shared rate limiting have not been certified in a private environment.
6. **P2 — Review route runtime authorization pending.** Source enforces `remittance.read` and scope; route/DB integration tests are pending.

Migration ordering: migration 1358 remains `compat: contract` and must follow its documented release sequencing/contract window. Migration 1359 is additive (`compat: expand`), but cannot reverse a prior 1358 deployment; rollback of 1359 requires a forward migration and any migration touching the enum must account for PostgreSQL's non-removable enum label. No migration was executed.

No production or controlled activation is authorized by this change.
