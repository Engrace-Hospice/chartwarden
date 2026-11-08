# Release blockers

## P0 — Do not activate or create a release PR

- The capture repository/worker is implemented but has no private-PostgreSQL test for transactional page commit, lease expiry/fencing, two-worker races, retry states, role grants, or cross-role isolation. Add and run the suite on a dedicated NOBYPASSRLS cluster.
- No parsed 835 payee/transaction-set resolver or M1 owner-reader integration. Connect parsed original evidence to historical provider/claim sources and prove mixed-tenant fail-closed behavior.
- The M25 staging boundary exists but is not wired to parsed 835 data or the capture delivery worker; its proof adapters have no production bindings and it has no DB test. Wire parser + M1/source proof adapters and prove it does not emit posting outbox events or mutate payment/AR state.
- The capture flag and legacy Claim.MD cutover are wired; delivery intentionally fails startup because safe M25 staging is absent. Keep it disabled until the owner service exists and required credentials/keyring/rate budget/roles are validated in a controlled environment.
- Independent code/security review and private PostgreSQL verification remain required before PR review or activation.

## P1 — controlled-test blockers

- No isolated PostgreSQL role/RLS test for central inbox inaccessible to `chartwarden_app` and tenant staging isolation.
- No synthetic Claim.MD account certification for pagination races, empty lists, API/SFTP coexistence, 835/eradata parity, rate limiting, or vendor throttling.
- No proof that account-wide requests share the deployed distributed rate limiter across workers, or that production and test credentials are configured separately.

## P1 — financial safety

- Staging duplicate checks against existing M25 advice are implemented in the unbound stage service, but have no DB tests and do not cover SFTP/manual imports. Exact duplicates must be suppressed; trace/amount similarities must be held, not merged.
- No comparison of parsed 835 and structured API details, and no tested PLB/recoupment/reversal preservation.

No activation is authorized by this implementation. Automatic financial posting remains explicitly prohibited.
