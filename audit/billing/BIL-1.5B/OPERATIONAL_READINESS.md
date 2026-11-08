# Operational readiness

The platform recovery route calls the real recovery service, requires `billing.rule_config.platform_admin`, `platform_billing_scope`, a platform-owned role and fresh step-up, and derives the actor from authenticated request context (`ops-claimmd-era-recovery.ts`). The service records recovery through the central store; no posting port is present. The registration fix makes its audited platform context executable when correctly configured.

The response/ERA metrics readers aggregate durable stream, event, resolution and delivery state without decrypting payloads. Dedicated read-only platform principals are registered independently from disabled capture workers (`operational-reader.ts`, `claimmd-era-store.ts`, `index.ts`). Financial metrics aggregate tenant-safe states. In-memory counters remain process-local. Not every historic guard/lease event has durable counters, so missing totals must not be reported as zero.

An enabled worker must pass schema, role, account/environment, keyring, cursor/bootstrap, lease and shared rate-limit checks. Disabled workers remain disabled when credentials are present. No live vendor call is needed for readiness. Pending integrated boot and scrape tests with a fully migrated private database and actual worker role.
