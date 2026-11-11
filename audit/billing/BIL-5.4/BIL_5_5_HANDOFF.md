# BIL-5.5 handoff

Recommended next implementation: **BIL-5.5 — Authorized Recovery Readiness, Durable Replay Evidence & Operator Runbooks**.

Keep recovery separate from tenant Billing Operations. Before adding any mutation, bind it to immutable source identity, platform-only authorization, fresh step-up, lease fencing, idempotency, durable audit evidence, and explicit account/environment scope. Add the central HTTP/PostgreSQL proof first. Do not add tenant replay, cursor reset, quarantine release, or financial posting.
