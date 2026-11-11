# Recovery capability matrix

| Operation | BIL-5.5 status | Boundary |
|---|---|---|
| Read central durable health | Supported | Platform-only aggregate read |
| Assess exact persisted ERA source | Supported | Server-bound account/environment and inbox UUID |
| Simulate capture/ownership/delivery eligibility | Supported | Read-only repeatable-read transaction |
| Existing local ERA recovery | Pre-existing, not exposed by this phase | Separate step-up protected route |
| Re-fetch from Claim.MD | Unsupported | No vendor call |
| Reset polling cursor | Unsupported | No endpoint or UI control |
| Release unattributed quarantine | Unsupported | Tenant attribution cannot be claimed |
| Resubmit claim to payer | Unsupported | Submission uncertainty is not failure |
| Replay/reverse financial posting | Unsupported | Financial state is not evaluated or mutated |

The BIL-5.5 operator screen intentionally offers preflight and dry-run only.
