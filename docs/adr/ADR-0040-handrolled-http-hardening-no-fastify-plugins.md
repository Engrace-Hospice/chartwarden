# ADR-0040 — HTTP hardening is hand-rolled in M1's bootstrap; no `@fastify/*` plugins

- **Status:** **Accepted** — ratifies the as-built state (2026-08-14, architecture-corpus
  remediation AR-06; see `audit/ARCHITECTURE_DOC_REMEDIATION_PLAN.md`).
- **Date:** 2026-08-14
- **Phase:** post-build divergence record (set at M1-T10, held through the full build).
- **Supersedes (wording):** every `@fastify/helmet` / `@fastify/cors` / `@fastify/rate-limit` /
  `@fastify/swagger` reference in `CHARTWARDEN_ARCHITECTURE_v0_11.md` and
  `CHARTWARDEN_SYSTEM_DESIGN_v0.3.md`.
- **Related:** [ADR-0032](ADR-0032-frontend-api-transport-and-client.md) (OpenAPI is emitted
  offline from TypeBox schemas — the reason no runtime swagger plugin exists).

## Context

The corpus describes the security/HTTP middleware surface as `@fastify/*` plugins. What was
actually built:

- **No `@fastify/*` package is installed.** M1's bootstrap
  (`apps/backend/src/bootstrap/plugins/security.ts`) states the intent in its header: M1 wires
  "the ONE security chain every module inherits (modules MUST NOT roll their own — SEC-064) …
  with NO new npm dependency."
- The hand-rolled chain covers: helmet-equivalent response headers (CSP/HSTS/X-Frame-Options),
  the explicit CORS allow-list, SD-055 rate-limit tiers (30/min unauthenticated by IP, 600/min
  authenticated by org/user) over an **injectable store** (in-memory default; Redis/Valkey
  cluster-wide when bound — WX-PR-017), the 10 MB body limit, CSRF double-submit for
  cookie-session mutations, and Postgres-backed idempotency.
- **OpenAPI is emitted offline** by `scripts/openapi/emit.ts` from the modules' TypeBox schemas
  (then ratcheted by `arch:openapi-coverage` and consumed by the generated typed client) — there
  is no runtime swagger route to serve. No multipart plugin, no SSE plugin (no consumer:
  ADR-0036).

## Decision

1. **The M1 bootstrap chain is the single HTTP-hardening surface**, hand-written, dependency-light,
   and owned like any other audited module code. Modules never add their own header/CORS/limit
   logic (SEC-064) and never add `@fastify/*` plugins locally.
2. **Swapping a hand-rolled piece for a maintained plugin is allowed but is an M1 decision** with
   two hard conditions, both already noted in-file: the emitted header set and tier values must be
   preserved exactly, and the change must not alter fail-open/fail-closed semantics (the rate
   limiter deliberately fails open as an availability control; auth/ABAC/CSRF fail closed).
3. Capabilities with no current consumer (multipart uploads, SSE) are added when a consumer
   exists, plugin or not — absence today is intentional, not an oversight.

## Consequences

- Security review reads ~one file per concern under `bootstrap/plugins/` instead of plugin
  configs — and those files are where the documented-vs-real drift checks point
  (header values, tier numbers, CSRF scope).
- The team owns patch responsibility for the hand-rolled surface; the trade was accepted at
  M1-T10 to keep the dependency budget near zero and the behavior fully specified by repo code.
- `CHARTWARDEN_SECURITY_HARDENING_v0_2.md` is the behavioral contract for this chain; when it and
  the code disagree, fix whichever is wrong *explicitly* (see the 2026-08-14 corrections) rather
  than assuming the plugin ecosystem's defaults.
