# ChartWarden — Better Auth Mount Wave (production auth + the M2 sign-in front door)

Stand up real authentication: mount the (already-defined) Better Auth instance, give it a production
DB client, wire the `authenticate` hook, add the M2 auth plugins/policy/session-classes, and finish the
M2 sign-in/MFA/passkey screens. Governed by **[ADR-0033](../adr/ADR-0033-better-auth-mount-and-prod-db-client.md)**
(mount + prod DB client; needs Security-Owner sign-off) + **ADR-0026** (Better Auth = sole auth) +
**ADR-0032** (auth uses Better Auth's client, not the generated REST client).

> **Conventions, determinism rules, the validate gate, and the legend are inherited from
> `M01-M02_VERTICAL_SLICE_PLAN.md`.** Gate = `bun run build && bun run arch:fitness && bun run test`.
> **Security-critical:** the unit suite cannot exercise auth (infra-free); the **live-Postgres CI lane**
> is load-bearing here (ADR-0033 §5). Ratify ADR-0033 before starting.

## Why this is a wave, not a task (current state)
- Better Auth instance exists (`createIdentityAuth(db)`) but is **never instantiated or mounted**.
- **No production DB client** anywhere (`packages/db` exports only `schema`); the codebase is injected/
  slice-based; the unit suite is infra-free.
- **No Fastify↔Better-Auth bridge**; the composition root passes **no `authenticate` hook**.
- Password policy, 2FA/passkey/org/magic-link plugins, session classes, step-up = unbuilt M2 sub-tasks.

---

## AUTH-T01 — Production DB client (M1 foundation infra)
- files: `packages/db` (client factory), `apps/backend/src/index.ts` (construct + inject), env docs
- do: `createDbClient(env)` — pooled `pg` + `drizzle` bound to `schema`. Composition root builds it from
  `DATABASE_URL` and injects it (Better Auth, repositories, `withOrgContext`). Slice/tests inject
  nothing → host still boots infra-free. Missing `DATABASE_URL` in prod **fails closed**.
- accept: `bun run build` green; unit suite stays infra-free + green; `packages/db` stays a leaf
  (`arch:boundaries`); a live-PG smoke connects via the factory.

## AUTH-T02 — Mount Better Auth on Fastify
- files: `packages/auth/src/identity` (`registerIdentityAuth(app, auth)`), `apps/backend/src/index.ts`
- do: a Fastify `all("/api/auth/*")` bridge — Fastify req → web `Request` → `auth.handler` → reply
  (in `packages/auth`, the only place `better-auth` may be imported). Composition root creates the
  instance (when the DB client is present) + mounts it. Env: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
  (fail-closed in prod).
- accept: build + `arch:fitness` (vendor-adapter rule intact) green; live-PG: `/api/auth/sign-up` +
  `/api/auth/sign-in/email` round-trip a session cookie.

## AUTH-T03 — `authenticate` hook → SessionContextResolver → request.context
- files: `apps/backend/src/index.ts` (inject `authenticate`), `apps/backend/src/modules/02-identity`
- do: composition-root `authenticate` hook calls `auth.api.getSession({ headers })`, then drives the
  **`SessionContextResolver`** seam to populate `request.context` (actor, `organizationId` from session
  `activeOrganizationId`, step-up freshness). Roles/permissions stay M3's separate resolve.
- accept: live-PG integration — an authenticated request resolves a real context; an unauthenticated one
  is denied; a PHI route gated by `requirePermission` works end-to-end.

## AUTH-T04 — Password policy (Argon2id + HIBP)
- files: `packages/auth/src/identity/password-policy` (M2 §3.1)
- do: Argon2id hashing + NIST-aligned policy + HIBP k-anonymity breach check on sign-up/reset.
- accept: live-PG: a breached/weak password is rejected; a strong one hashes with Argon2id.

## AUTH-T05 — Plugins + session classes + step-up reconcile
- files: `packages/auth/src/identity` (plugins, session-classes), `apps/backend/src/modules/02-identity`
- do: enable the Better Auth **two-factor (TOTP/backup; SMS fallback), passkey, organization,
  magic-link** plugins; implement the **four session classes** (staff/auditor/external/funeral) +
  lifecycle; reconcile the existing custom routes — `select-organization` sets the session
  `activeOrganizationId`; the step-up route writes `lastStepUpAt`/`lastStepUpFactor`.
- accept: live-PG: enroll TOTP → MFA challenge on sign-in; passkey register/authenticate; org-select
  binds the session; step-up seeds the 5-minute window; SMS never qualifies as step-up.

## AUTH-T06 — Live-PG auth integration tests (the load-bearing lane)
- files: `apps/backend/__tests__/*.live.test.ts` (or extend `rls-live`); `package.json` CI
- do: end-to-end against real PG — sign-in → session → `authenticate` → context; MFA; org-select;
  step-up; lockout (3 fails/60s). Wire into the `rls-live` job (or a new `auth-live` job).
- accept: the live lane is green and covers each flow above; the infra-free unit suite is unchanged.

## AUTH-T07 — M2 sign-in front-door screens (frontend)
- files: `packages/auth` client export (or M1 shell), `apps/web/src/modules/02-identity`,
  `docs/design/DEFERRED_SCREENS.md`
- do: wire Better Auth's **client SDK** (ADR-0033 §4 — not the generated REST client). Build the
  deferred Auth Flow screens: **Sign in** (password + passkey), **MFA challenge** (TOTP/backup/SMS),
  **password reset**, **screen-lock**, **step-up modal**; finish **Accept Invitation** (set-password +
  MFA enroll) and re-point **Organization Select** at the real session. All use `CenteredCardLayout`.
- accept: build + `arch:fitness` + `test` green; ledger M2 Auth → done; manual/e2e: a user signs in,
  passes MFA, selects an org, and lands in the Role Home.

---

## Decisions captured (ADR-0033)
- Prod DB client = M1 infra, built at the composition root, injected (slice-safe).
- Better Auth mounted via a `packages/auth` Fastify bridge; instance created only when DB is present.
- `authenticate` resolves Better Auth sessions through `SessionContextResolver`.
- Auth uses Better Auth's client on the frontend; the generated REST client is for TypeBox routes only.
- Auth is verified in the **live-PG CI lane**; the unit suite stays infra-free.
- `DATABASE_URL` / `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` — documented, fail-closed in prod.

## Sequencing
T01 (DB client) → T02 (mount) → T03 (authenticate) → T04 (policy) → T05 (plugins/sessions) →
T06 (live tests) → T07 (screens). T01–T03 are the minimal chain to a working email+password sign-in;
T04–T05 harden it to the M2 spec; T07 delivers the UI the deferred ledger rows describe.
