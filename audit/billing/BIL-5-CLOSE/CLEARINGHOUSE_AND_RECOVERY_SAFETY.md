# Clearinghouse and recovery safety

Tenant health and platform observability use durable source readers. Recovery preflight and dry-run require an exact inbox UUID, server-owned account/environment, source state, digest, attribution, lease and prior-attempt evidence.

Dry-run is read-only with respect to processing and finance. Cursor reset, external replay, forced attribution, quarantine release, resubmission and recovery execution remain disabled. Worker heartbeat and request-budget metrics remain unavailable rather than fabricated.
