# Recovery rehearsal

The disposable PostgreSQL rehearsal seeds a durable response cursor and an ERA capture in `retryable_failure` after the retry threshold. The real central endpoint reads both. Preflight reports capture simulation eligibility; concurrent dry-runs leave all processing fields unchanged.

Environment mismatch is rejected. Tenant-role direct SQL is denied. No external transmission or local recovery execution was attempted.
