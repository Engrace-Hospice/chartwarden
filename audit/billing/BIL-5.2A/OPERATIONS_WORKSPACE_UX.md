# Operations workspace UX

The existing page now presents M23/M41 unresolved transport outcomes as “Submission outcome in doubt”. Copy says the claim may have reached the payer and directs staff to check submission history; no retry action is offered. Amounts retain their existing semantics (claim charge versus ERA payment). Per-source counts explicitly describe loaded rows, and continuation failures retain a retryable cursor.

The desktop table remains; at widths up to 720px it is replaced with source/status-aware work-item cards. M25 stage navigation and existing claim destinations are unchanged. Recent activity is not added because no common durable, tenant-scoped event feed exists.
