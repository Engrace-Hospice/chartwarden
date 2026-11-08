# Tenant isolation and trust boundaries

- The BIL-1.1 raw page, event metadata, BIL-1.2 resolution row, and resolution history have no tenant-facing grants. Migration 1351 FORCEs RLS and grants the new records to the narrow `claimmd_capture` role only. The tenant `chartwarden_app` receives no SELECT path.
- The internal store decrypts the original page using its injected cipher and reads only the selected event's parent/message indexes. TIN is compared in memory; it is not copied to the result or evidence history. Evidence summaries contain strategy/module/submission references only.
- Vendor data cannot nominate a WardenX organization, provider entity, or claim. Those IDs come only from the trusted candidate source. Candidates must be scoped to the stored account reference and test/production usage, and the submission route must be proven as Claim.MD.
- A mismatch in any supplied provider/payer/claim evidence cannot be overridden by a PCN or external ID. The resolver preserves `conflict` or `needs_review`.
- The worker API checks an explicit `enabled` boolean; `CLAIMMD_IDENTITY_RESOLUTION_ENABLED` is absent/invalid false. There is no boot registration in this change.

## Certification limits

Migration policy source is not runtime RLS proof. No live PostgreSQL test was run for migration 1351, role grants, candidate-source cross-tenant isolation, or concurrent resolver writes. The BIL-1.1 live suite only covers inbox role denial and capture lease behavior; it does not cover these new resolution tables. Add live probes before binding the service. The BIL-1.1 `withPlatformContext` job ID is not registered at boot and no cross-tenant candidate adapter currently exists.
