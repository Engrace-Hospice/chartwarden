# Multi-tenant security

The worker is gated by `CLAIMMD_ERA_OWNERSHIP_RESOLUTION_ENABLED`, which is enabled only by the exact string `true`; default is false. It is rejected on API role and runs under the registered platform job ID with audited `withPlatformContext` and repeatable-read isolation. The M1 and M23 readers are owner-exported; the M41 reader is injected by the composition root. No new tenant route exists.

The captured X12 and resolution detail stay encrypted under separate Claim.MD payload-cipher purposes. Plaintext X12/TIN is not logged. The central resolution/history tables have FORCE RLS and are accessible only to `claimmd_capture`; tenant `chartwarden_app` has no grants. There is no endpoint exposing an unresolved inbox or resolution summary. Resolution owner columns are populated only for verified payee ownership and are still inaccessible to tenant roles.

A mixed or unresolved payee, contradictory TIN, same-PCN cross-tenant evidence, invalid M1 provider ownership, truncated candidate query or corrupt source does not choose an organization. Existing verified ownership cannot be reassigned by reprocessing: a changed/invalidated owner is persisted as `conflict` with no owner columns and remains sticky for operator resolution. No SQL/RLS runtime test was run; see blockers.
