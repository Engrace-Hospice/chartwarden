# Incident and recovery runbook

1. Confirm the affected Claim.MD account/environment outside tenant UI.
2. Inspect central aggregate health; do not copy cursor values into tickets.
3. Identify one exact durable ERA inbox UUID from authorized operational evidence.
4. Run preflight for the affected stage.
5. If blocked by an active lease, ownership conflict, digest/version mismatch, or unsupported financial state, stop and escalate.
6. Run dry-run and record its timestamp and blocker codes. Treat it as stale immediately after source state changes.
7. Do not reset cursors, replay vendor requests, release quarantine, resubmit claims, or alter financial records through this workflow.
8. Any future execution requires a separately reviewed contract with step-up, fencing, idempotency, atomic audit, and rollback tests.

Database restore and vendor disaster recovery remain operator procedures outside this UI. Never restore production data into an unapproved environment.
