# Remaining blockers

- Recovery execution was deliberately not implemented. Preflight/dry-run do not authorize it.
- Existing financial effects are reported as not evaluated; any recovery that could produce financial effects must remain blocked behind the controlled M25 posting domain.
- No durable request-budget or worker-heartbeat source exists.
- No live vendor replay, cursor reset, quarantine release, claim resubmission, or production activation was certified.
- Production IdP and operational disaster-recovery certification remain deployment work.
