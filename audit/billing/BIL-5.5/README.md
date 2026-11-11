# BIL-5.5 — Controlled Recovery Readiness

Implemented platform-only central observability, exact-source recovery preflight, and a nonmutating dry-run for Claim.MD ERA capture, ownership resolution, and M25 delivery. No recovery execution, cursor reset, external replay, quarantine release, or financial operation was added.

The required Fastify → durable reader → private PostgreSQL test uses the provisioned `chartwarden_platform_login`; direct `chartwarden_app` access to the central inbox is denied.

See [RECOVERY_CAPABILITY_MATRIX.md](./RECOVERY_CAPABILITY_MATRIX.md) and [POSTGRESQL_HTTP_AND_RLS_TESTS.md](./POSTGRESQL_HTTP_AND_RLS_TESTS.md).
