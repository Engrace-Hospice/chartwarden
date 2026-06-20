# ADR-0033 — Mount Better Auth + stand up the production DB client

- **Status:** **Accepted** — ratified 2026-06-20 (Security-Owner sign-off). Authorizes the Better Auth
  mount wave (`docs/plans/WAVE_AUTH_BETTER_AUTH_PLAN.md`): prod DB client → mount → authenticate →
  policy/plugins/session-classes → live-PG tests → M2 sign-in screens.
- **Date:** 2026-06-20
- **Phase:** pre-build governance (blocks the Better Auth wave; unblocks the M2 sign-in/MFA/passkey
  screens, which are deferred in `docs/ui/DEFERRED_SCREENS.md`).
- **Depends on / refines:**
  - [ADR-0026](ADR-0026-m19-vendor-operator-auth-via-better-auth.md) — Better Auth is the single
    authentication surface; this ADR decides *how it is mounted and run*.
  - [ADR-0032](ADR-0032-frontend-api-transport-and-client.md) — the generated REST client is for the
    TypeBox routes; this ADR carves out auth (Better Auth's own client, not the generated one).
  - [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) — vendor-adapter rule (`better-auth` may
    be imported only in `packages/auth`); the Fastify bridge lives there.

## Context

The Better Auth instance is **defined but never mounted**: `createIdentityAuth(db)` in
`packages/auth/src/identity/auth.ts` binds it to M1's `user`/`session`/`account`/`verification` tables
with the session `additionalFields` (org binding, session class, step-up). But:

- **No production DB client exists anywhere.** `packages/db` exports only `schema`; there is no
  `drizzle()`/`Pool` construction. The codebase is entirely injected/slice-based and the unit suite is
  **infra-free**. Better Auth needs a live Postgres connection to function.
- **No Fastify ↔ Better Auth bridge**, and the composition root passes **no `authenticate` hook** — so
  production currently has no real authentication wired at all.
- **`SessionContextResolver` (M2 §4.7) is the intended path** from a validated session to
  `request.context`; it is registered but never driven by a real session today.
- Password policy (Argon2id/HIBP), 2FA/passkey/organization/magic-link plugins, the four session
  classes, and step-up are **separate, unbuilt M2 sub-tasks**.

So unblocking sign-in is an ordered, security-critical, **infra-dependent** program — most of which the
infra-free unit suite cannot exercise.

## Decision

1. **The production DB client is M1 foundation infra.** `packages/db` gains a `createDbClient(env)`
   factory (pooled `pg` + `drizzle`, bound to `schema`). The **composition root**
   (`apps/backend/src/index.ts`) constructs it once from `DATABASE_URL` and **injects** it everywhere a
   real DB is needed (Better Auth, repositories, `withOrgContext`). Slice/tests inject nothing → the
   host still boots infra-free. Missing `DATABASE_URL` in production **fails closed**.
2. **Better Auth is mounted via a `packages/auth` Fastify bridge.** A `registerIdentityAuth(app, auth)`
   helper (in `packages/auth`, the only place that may import `better-auth`) mounts an
   `all("/api/auth/*")` route that converts the Fastify request to a web `Request`, calls
   `auth.handler(request)`, and pipes the web `Response` back to the Fastify reply. The instance is
   created only when the DB client is present (production); absent → not mounted.
3. **The `authenticate` hook resolves Better Auth sessions through the seam.** The composition root
   injects an `authenticate` hook that calls `auth.api.getSession({ headers })`, then drives the
   **`SessionContextResolver`** seam to populate `request.context` (actor, `organizationId` from the
   session's `activeOrganizationId`, step-up freshness). Roles/permissions remain M3's separate resolve.
4. **Auth uses Better Auth's own client on the frontend — not the generated REST client.** The M2
   sign-in/MFA/passkey screens use `better-auth`'s client SDK (wired in `packages/auth`'s client export
   or the M1 shell), distinct from the `packages/ui/src/api` openapi-fetch client (ADR-0032). Reason:
   the `/api/auth/*` routes are Better Auth's web handler, not TypeBox Fastify routes, so they are not
   in `openapi.json`.
5. **Auth integration is verified in the live-Postgres CI lane, not the unit suite.** Sign-in → session
   → `authenticate` → context, MFA, and org-select are exercised against real PG (extend the `rls-live`
   job or add an `auth-live` job). The infra-free unit suite stays green and does **not** gain a DB dep.
6. **The custom M2 session routes reconcile onto Better Auth sessions.** `select-organization` sets the
   session's `activeOrganizationId`; the step-up route writes `lastStepUpAt`/`lastStepUpFactor`. The
   `OrganizationSelect`/`AcceptInvitation` screens already built (PR #9) re-point at the real flow.

## Consequences

- **Security-critical boot path changes** — hence Security-Owner sign-off, and the live-PG verification
  requirement before it is trusted.
- The unit suite cannot prove sign-in; the **`rls-live` lane becomes load-bearing** for auth. This is an
  accepted, explicit trade-off (the alternative — a DB in the unit suite — is rejected per the project's
  infra-free unit-test invariant).
- **`packages/db` gains a runtime `pg` dependency** for the client factory (it already depends on
  `drizzle-orm`); it stays a leaf (no feature-package import).
- Adds env/secrets: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` — documented + fail-closed.
- Sequenced as a backend wave (see `docs/plans/WAVE_AUTH_BETTER_AUTH_PLAN.md`): DB client → mount →
  authenticate → policy/2FA/plugins/session-classes → live tests → M2 sign-in/MFA/passkey screens.

## References

- `packages/auth/src/identity/auth.ts` (the unmounted instance), `apps/backend/src/index.ts`
  (composition root), `apps/backend/src/bootstrap/index.ts` (the `authenticate` injection point),
  `packages/types/src/seams.ts` (`SessionContextResolver`).
- Wave plan: `docs/plans/WAVE_AUTH_BETTER_AUTH_PLAN.md`.
- ADR-0026, ADR-0032, ADR-0005.
