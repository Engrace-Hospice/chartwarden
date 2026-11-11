# Notes, audit, and concurrency

The server derives actor and author identities from the authenticated request. The note schema rejects unknown fields; the live test also confirms any attempted client author field cannot change the recorded author. Notes are trimmed, non-empty, and capped at 2,000 characters by API and database constraints.

Status changes validate the existing transition table and require a reason; resolving requires an allowed outcome and `billing.operations.resolve`. Closure and reopening are audited separately. Assignment and transition writes compare the submitted revision under an advisory transaction lock. Note and mutation retries use idempotency keys and request fingerprints.

The private PostgreSQL tests exercise retries, stale versions, competing assignments, concurrent notes, and competing transitions. History remains append-only under migration 1454's trigger and FORCE RLS.
