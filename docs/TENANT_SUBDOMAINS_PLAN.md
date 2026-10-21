# Per-tenant subdomains — implementation plan

Mechanism: [ADR-0049](./adr/ADR-0049-tenant-subdomains.md) (Accepted). Base domain and environments:
[ADR-0088](./adr/ADR-0088-tenant-base-domain-and-environments.md). Status: **approved 2026-10-21; phases 1–3 built on branch `feat/tenant-subdomains-a`, phases 4–6 not yet.**
This plan only sequences the work; every design question is answered in those two ADRs, and where this file
and an ADR disagree, **the ADR wins**.

## Outcome

Hospice tenants of the real-data environment are served at `<slug>.chartwarden.com`. The demo on
`chartwarden.cloud` is unchanged. quillwardhealth.com owns the software and operates the real environment.

## Current state (verified in code, 2026-10-21)

- Nothing reads the request host. The tenant is `session.activeOrganizationId`, set by
  `POST /api/v1/auth/select-organization`.
- `packages/auth/src/identity/auth.ts`: `resolveTrustedOrigins()` is an exact list from `TRUSTED_ORIGINS`
  (wildcards rejected), shared by Better Auth and `resolvePasskeyOrigins()`; `resolvePasskeyRpId()` returns
  one `PASSKEY_RP_ID`.
- `apps/backend/src/bootstrap/plugins/security.ts` holds M1's exact CORS set; `csrf.ts` the CSRF chain.
- `deploy/production/nginx/*.conf` serve fixed `server_name`s under `chartwarden.cloud`.
- `organization.slug` is `NOT NULL UNIQUE` but not constrained to a DNS label or kept off reserved names.

## Decisions already made (no re-opening)

| Question | Answer | Source |
|---|---|---|
| Host's role | consistency check vs the session org, 403 `TENANT_HOST_MISMATCH`; never an authorization source | ADR-0049 D1 |
| Base domain | `chartwarden.com` (real); unset on demo | ADR-0088 |
| Passkey RP ID | `chartwarden.com`, must equal `TENANT_BASE_DOMAIN` (boot fails otherwise) | ADR-0049 D4, ADR-0088 |
| Cookies | host-only, `__Host-`, `Secure`, `Path=/`; `crossSubDomainCookies` off | ADR-0049 D4 |
| Portal | path-mounted at `<slug>.chartwarden.com/portal/` | ADR-0049 D7 |
| Slugs | DNS-label rule, reserved list, never reused, rename aliases redirect (308) forever | ADR-0049 D3 |
| Origins | matched by rule, CORS unchanged (tenant hosts are same-origin) | ADR-0049 D6 |
| Edge | Pangolin wildcard resource, DNS-01 wildcard cert, `Host` preserved | ADR-0049 D2 |

## Build notes (as built)

- **Phase 1** — migration 1144 (slug-rule guard trigger (a `NOT VALID` CHECK would also fail every UPDATE of a legacy row), `organization_slug_alias`, rename triggers), `tenant-slug.ts` in
  `@chartwarden/types`, `scripts/db/tenant-slugs-check.ts`. Migration number 1144 (renumbered from 1141, above the 1143 database-object rename; 1140 went to break-glass) and
  ADR-0088 (break-glass took ADR-0087 on `main`; the ADR index must stay contiguous).
- **Phase 2** — migration 1145 (`resolve_tenant_host`, a narrow SECURITY DEFINER function, used instead of the "platform
  credential" ADR-0049 D6 names: same purpose, smaller authority, and the M31 portal sign-in read is the precedent);
  `bootstrap/tenant-host.ts` (`TENANT_BASE_DOMAIN`, host classification, guard, caching resolver);
  `tenant-host-resolver-db.ts`; the guard is registered right after `authenticate`; `select-organization` pins the org
  to the host; the cache is evicted when M2's organization lifecycle suspends, closes or activates an org; env rule
  `PASSKEY_RP_ID == TENANT_BASE_DOMAIN`. The org-offboarding path in M34 does not evict, so a closed tenant is served for
  up to the 60 s TTL there.
- **Phase 3** — origin matching and host-only cookies. `classifyTenantHost` moved into `@chartwarden/types` so
  `packages/auth` shares it without importing the backend. `packages/auth/src/identity/tenant-origin.ts` is the matcher
  (https, default port, bare origin, tenant host, org not suspended/closed; resolver injected as a port). Better Auth's
  `trustedOrigins` becomes an async function and the passkey `origin` is `null` (falls back to the already-validated
  request Origin) only when the matcher is supplied; `@simplewebauthn` takes a static list, so the step-up verifier
  appends `https://<request.hostname>` only when the host guard stamped `tenantHostOrgId`. The realtime handshake checks
  the same matcher, failing closed. CORS is not widened. Cookies: `host-only-cookies.ts` gives the Better Auth session
  `__Host-better-auth.*` (Secure, Path=/, no Domain, `crossSubDomainCookies` off) and `csrf.ts` mints
  `__Host-chartwarden_csrf`, both only when `TENANT_BASE_DOMAIN` is set. **Not built:** a separate portal cookie. Staff
  and portal sessions share one Better Auth instance and cookie name, told apart by `sessionClass` and portal ABAC; a
  distinct cookie needs a second instance or custom cookie handling and is a decision for Phase 4.
- Decisions taken while building: an org in status `created` is served (it cannot be selected anyway: `select-organization`
  refuses a non-active org); only `suspended` (403 `TENANT_SUSPENDED`) and `closed` (410 `TENANT_CLOSED`) are refused.
  The "no longer on ChartWarden" page itself is a Phase 4 SPA concern; the backend answers 410.

## Delivery

Two PRs and batched pushes (metered Actions minutes): **PR A** backend (phases 1–3), **PR B** web, edge and
provisioning (phases 4–6). Before each PR opens, run `/ecc:code-review` on `git diff main...HEAD` in a fresh
agent, plus `/ecc:security-scan` for PR A (auth/PHI/RLS) and `/ecc:react-review` for PR B. A merge needs the
user's explicit go-ahead.

### Phase 1 — slugs and aliases (PR A)
- `RESERVED_TENANT_SLUGS` and the slug validator in `@chartwarden/types`.
- Migration: DB `CHECK` on `organization.slug` (DNS label, not reserved, no `xn--`); new
  `organization_slug_alias` table (M1-owned, unique across slug and alias, RLS per the three-column rule).
- One-off check listing existing slugs that fail the rule before the `CHECK` lands; rename those by hand
  with an alias.
- Manifest `.ts` + `.cjs` (`ownedTables`), `packages/db/src/enums.ts`, `packages/types` mirrors.
- Run `arch:migration-numbering` against `main` first.

### Phase 2 — host resolution and the D1 check (PR A)
- `TENANT_BASE_DOMAIN` in `bootstrap/env.ts` and `.env.example`; unset ⇒ single-host mode, hook is a no-op.
- Slug → org lookup through the platform credential (org rows are not tenant-RLS-visible before the GUC),
  60 s in-process cache, evicted on org suspend or close.
- New M1 hook after `authenticate`, before handlers: 403 `TENANT_HOST_MISMATCH` (M1 envelope) when the host's
  org differs from the session's active org. Skips unauthenticated requests and sessions with no active org.
- Alias host ⇒ 308 to the current slug. Suspended org ⇒ refused. Closed org ⇒ static "no longer on
  ChartWarden" page, sign-in refused.
- `select-organization` on a tenant host may only select the org the host resolves to.
- `X-Forwarded-*` honoured only from `TRUSTED_PROXY_CIDRS`; any inbound tenant-identifying header ignored.
- Register the `Host` read in `arch:request-header-auth` as `verified`.

### Phase 3 — auth config (PR A)
- D6 origin matcher: `TRUSTED_ORIGINS` exact list, **or** `https://<label>.chartwarden.com` whose label is an
  active org or live alias. Same predicate for Better Auth and the passkey origin check; if a library only
  takes a static list, pre-validate the origin and pass a one-element list. Confirm against the installed
  Better Auth and `@simplewebauthn` versions.
- Boot check: in production with `TENANT_BASE_DOMAIN` set, `PASSKEY_RP_ID` must equal it.
- Cookies: host-only, `__Host-` prefix for the session and CSRF cookies (verify the current cookie names and
  attributes in `csrf.ts` and the Better Auth config before changing them); portal gets its own cookie name
  and session class.

### Phase 4 — web (PR B) — built (backend + web)

PR A merged as #538; its migrations landed as 1144 and 1145 (renumbered on merge). Decisions taken for Phase 4
(the recommended answers, recorded before building):

- **Link hosts are per organization.** One resolver, `tenantAppOrigin(orgId)`, returns `https://<slug>.<base>` when
  `TENANT_BASE_DOMAIN` is set and falls back to today's `WEB_APP_URL` / `BETTER_AUTH_URL` otherwise (demo unchanged).
  It replaces the global `webAppBaseUrl` for staff invitation, auditor redeem, M34 first-admin invite, portal
  invitation and funeral-home / collaborator links. Better Auth's reset and magic-link `url` is rewritten to the
  request's origin only when the tenant origin matcher trusts it; otherwise it is left alone.
- **No second portal cookie.** Staff and portal share the Better Auth cookie on a host. Separation is enforced by
  session class in one `onRequest` hook beside the tenant-host guard: a portal-class session on a non-portal path,
  or a staff-class session on `/api/v1/portal/*`, gets 401. Signing in to one replaces the other in that browser;
  that is acceptable (a person is rarely both) and is stated in the runbook.
- **Tenant sign-in shows the tenant's name** through `GET /api/v1/public/tenant`: host-derived (no parameter),
  unauthenticated, rate limited, answers `{ status, displayName }` where `displayName` is present only for an
  active or created org. Backed by a narrow SECURITY DEFINER function (the `resolve_tenant_host` pattern). The SPA
  picker is skipped on a tenant host (the pin already makes it a one-org choice).
- **Closed / suspended / unknown host** renders a static page chosen by the response body `error.code`
  (`TENANT_CLOSED`, `TENANT_SUSPENDED`, `TENANT_HOST_UNKNOWN`); the response-signal layer learns the codes.
- **`app.<base>` landing:** `POST /api/v1/public/find-my-organization { email }` always answers 202 "check your
  email". It mails the user the sign-in link of each active organization they belong to (one email, only when at
  least one exists), after a per-IP limit and a per-hashed-email limit. A narrow SECURITY DEFINER function maps
  email to `(slug, display_name)` of active memberships. No link or organization is ever shown in the response.
- **Portal** is built with `base: "/portal/"` and served under `/portal/` of the tenant host, same origin as `/api`.

**Phase 4 backend build notes** (branch `feat/tenant-subdomains-b`, backend half only; the SPA work is separate).
`bootstrap/tenant-app-origin.ts` is `tenantAppOrigin(orgId)` (slug read under the org's own `withOrgContext`, no
extra privileged path; unset base or an unreadable slug falls back to the global origin). It feeds the staff invite
(`deliverInvite` and the echoed `inviteUrl`), the auditor redeem link, portal invitations and funeral-home /
collaborator links (landing base `<origin>/portal`; `PORTAL_APP_URL` is honoured only when `TENANT_BASE_DOMAIN` is
unset) and the M34 first-admin link (`<origin>/tenant-invite/<token>`, via an optional `acceptBaseUrlFor` on the
invitation port; `M34_INVITATION_ACCEPT_URL` still applies when the base is unset). The link-delivery port gained
`organizationId`. Better Auth reset / magic-link URLs are rewritten to the request origin by
`rewriteLinkToRequestOrigin` only when `Origin` is a tenant origin the matcher trusts and equals the request `Host`.
Migration 1146 adds `resolve_tenant_public(label)` and `tenant_links_for_email(email)` (same SECURITY DEFINER shape
as 1145; the second returns active memberships in active orgs, capped at 20). `GET /api/v1/public/tenant` and
`POST /api/v1/public/find-my-organization` live in M2 (`routes/public-tenant-routes.ts`); both 404 unless the base
domain is set. The find route answers 202 for every well-formed address; the per-IP budget (10 / 15 min) answers 429,
the per-sha256(email) budget (3 / 15 min) silently suppresses the send, and the lookup and send run after the reply.
`tenantSessionClassGuard` (registered right after the host guard, acting only where it stamped `tenantHostOrgId`)
answers 401 `SESSION_CLASS_MISMATCH` for a portal-class session outside `/api/v1/portal/*` plus session plumbing
(`/api/auth/`, `/api/v1/auth/`, `/api/v1/public/`, `/health`, `/ready`) and for a staff-class session on
`/api/v1/portal/*` other than `/api/v1/portal/sign-in/*`. It is off in single-host mode, so the demo is unchanged.

**Phase 4 web build notes** (same branch; SPA half).
- *Sign-in*: `02-identity/tenant-info.ts` `fetchTenantInfo(client)` calls `GET /api/v1/public/tenant` once; a 200 with
  `displayName` replaces the subtitle with "Sign in to <name>". A 404, a network error or a throw all return `null`
  and the page is exactly as before; sign-in is never gated on the call.
- *Picker skipped on a tenant host*: `OrganizationSelect` binds the sole active membership through
  `select-organization` without a click only when `fetchTenantInfo` answers (a tenant host) AND there is exactly one
  active membership; the spinner stays up until the full-page reload. The demo host, and a tenant host with several
  memberships, keep the picker.
- *Closed / suspended / unknown*: `api client onResponseStatus` now receives the `Response` as a third argument;
  `main.tsx` clones and reads the body only for 403/404/410 on `/api/*` outside `/api/v1/public/*`
  (`mayCarryTenantRefusal`), and `error.code` `TENANT_CLOSED` / `TENANT_SUSPENDED` / `TENANT_HOST_UNKNOWN` raises a
  `tenant-unavailable` signal. `GlobalResponseWatcher` navigates (replace) to the static chromeless
  `/tenant-unavailable?reason=closed|suspended|unknown` (`system.tenant-unavailable`). Any other 403/404 is untouched.
  `/api/v1/public/*` is excluded because it answers 404 `TENANT_HOST_UNKNOWN` on the demo host and on `app.<base>`.
  Consequence: an unknown tenant host's sign-in page itself stays generic (its public lookup is excluded); the first
  auth/context call after sign-in lands on the "no organization" page.
- *`app.<base>` landing*: `isAppLandingHost(hostname)` (first label exactly `app`, at least 3 labels; `app` is a
  reserved slug so no tenant collides) gates `main.tsx` registering `appLandingScreens` (`/`, chromeless). The shell
  drops the Role Home index route when a chromeless screen owns `/`, otherwise the chromed layout outranks it. The
  screen POSTs `find-my-organization` and always shows "If that address belongs to an organization, we've emailed
  sign-in links", including when the request fails.
- *Portal under `/portal/`*: `apps/portal/src/base-path.ts` (`PORTAL_BASE_PATH = "/portal"`) feeds Vite `base`, the
  router `basename`, the magic-link `callbackURL` (`${origin}/portal/signed-in`) and `errorCallbackURL`, the two brand
  `<img>` URLs and the post-sign-out `location.assign`. `index.html` public assets are rewritten by Vite. API calls
  stay same-origin absolute `/api/...`; the dev proxy keys are unchanged, and dev serves the portal at
  `http://localhost:5174/portal/`. No service worker or manifest exists. Portal tests push `/portal/...` URLs.
- *Session-class allowlist audit*: every non-`/api/v1/portal/*` call in `apps/portal/src` is `/api/auth/*` (allowed),
  `POST /api/v1/collaborators/consume` (anonymous) and `GET /api/v1/funeral/case` (a `funeral_home` session, which the
  guard treats as neither portal nor staff). `StepUpCard`'s `/api/v1/sessions/step-up` is not used by the portal (it
  uses `/api/v1/portal/sessions/step-up`). No allowlist change was needed; `apps/portal/__tests__/tenant-base-path.test.ts`
  fails if the SPA gains a call outside that set.
- *Not verified here*: a live browser pass against the Docker API on a real `*.<base>` host (needs wildcard DNS or
  hosts entries and `TENANT_BASE_DOMAIN`); covered by jsdom tests and a production build of both SPAs only.

**Phase 4 pre-PR review fixes** (same branch; findings from the mandatory pre-PR review).
- *Recipient gate (B1, was a regression)*: `userMayUseTenantHost` read `tenant_links_for_email`, which only knows ACTIVE
  memberships, so a portal-only person (patient / caregiver / bereaved: a `portal_account`, no membership) kept their
  magic link on the global origin. Migration **1147** adds `email_belongs_to_tenant(p_email, p_label)` (SECURITY DEFINER,
  owner `chartwarden_admin`, pinned search_path, EXECUTE for `chartwarden_app` only): boolean, no row cap, true for an
  active membership OR a live portal account (invited / active / bereaved, not revoked or suspended) in the organization
  whose CURRENT slug is `p_label` and whose status is `active` / `created` (a retired alias never matches).
  `createUserMayUseTenantHost` (02-identity) wraps it; proved live in `m1-organization-slug-alias.live.test.ts`.
- *Portal base path (B2)*: no deploy config serves the portal SPA today (no Dockerfile / nginx / compose entry), so the
  only contract is `PORTAL_APP_URL` plus the build. The base is now a build-time knob, `VITE_PORTAL_BASE`
  (`apps/portal/src/base-path.ts` `resolvePortalBase`): unset keeps `/portal` (tenant mode, dev, tests); `""` or `/`
  builds for an origin-root deployment. In single-host mode (TENANT_BASE_DOMAIN unset) the backend still returns
  `PORTAL_APP_URL` verbatim, so the operator sets `PORTAL_APP_URL` to wherever that build is served
  (`https://portal.example` with `VITE_PORTAL_BASE=`, or `https://app.example/portal` with the default). Demo links are
  unchanged. In tenant mode links are `https://<slug>.<base>/portal/...` as before.
- *Session-class guard (B3)*: matches the DECODED path (`/api/v1/%70ortal/x` previously bypassed the staff-on-portal
  check); a path that does not decode answers 400. Two token flows pass a stale cookie of the other class (POST only):
  `POST /api/v1/portal/invitations/accept` for a staff-class session and `POST /api/v1/collaborators/consume` for a
  portal-class session.
- *find-my-organization hardening (B4-B6)*: the two limiters are built with `failClosed` (new opt-in on
  `createBudgetedRateLimiter`; default stays fail-open for every other route), so a store outage skips the send and
  still answers 202. `tenantOriginForSlug` (types) refuses a slug the 1144 rules would reject; `tenant-app-origin` falls
  back to the global origin and the email omits that link (no email at all if none is left). Display names are
  capped at 80 characters with URLs and control characters stripped; links remain slug-only.
- *Link delivery gate (B7)*: collaborator / funeral links send when only `TENANT_BASE_DOMAIN` is set
  (`baseUrl` is optional on `createLinkDelivery`; it throws, rather than mail a dead link, when neither a tenant origin nor
  a global base resolves).
- *Web (W1-W6)*: the organization picker's auto-bind is wrapped end to end; a rejected or refused bind falls back to the
  picker, a `TENANT_HOST_MISMATCH` refusal names the host's organization, and every error state offers "Try again" and
  "Sign out". The tenant lookup now runs in parallel with the memberships fetch and must report `status === "active"`.
  `isAppLandingHost` requires the build-time `VITE_TENANT_BASE_DOMAIN` (set it to the backend's `TENANT_BASE_DOMAIN`;
  `Dockerfile.web` takes it as a build ARG) and matches `app.<base>` exactly - unset means never the landing, so a
  single-host deployment at `app.<domain>` is not hijacked. The landing uses the shared `TextField` / `Button`, announces
  the confirmation as `role="status"` and moves focus to its heading. `GlobalResponseWatcher` no longer re-navigates when
  already on `/tenant-unavailable`. `handleObservedResponse` (shell) is the one `onResponseStatus` handler; tests cover the
  Response reaching it and a 410 body routing to `/tenant-unavailable` end to end.

### Phase 5 — edge and environment (PR B)
- Confirm quillwardhealth.com controls `chartwarden.com` DNS; add the wildcard record and DNS-01 credentials.
- Pangolin wildcard resource plus exact-host resources for reserved names (they take precedence).
- Real-environment env file (`TENANT_BASE_DOMAIN`, `PASSKEY_RP_ID`, `BETTER_AUTH_URL`, `TRUSTED_PROXY_CIDRS`),
  own database and secrets. Widen nginx `server_name` to `*.chartwarden.com` on the VPS interim, or ingress
  path rules on Talos. Path routing: `/api/` backend, `/portal/` portal SPA, `/` staff SPA.
- CSP: `img-src` and `connect-src` to `'self'` plus the explicit `storage.` host.
- Ops runbook section; `smoke.sh` probes a sample tenant host and a wrong-tenant request.
- Edge must serve the portal build for EVERY `/portal/*` path (a deep-link reload such as `/portal/p/<id>/care-plan`, and the
  magic-link return `/portal/signed-in`) with its own `index.html` fallback, and must not shadow it with the staff SPA's
  fallback. `smoke.sh` probes a deep `/portal/` path and asserts the portal document (not the staff one) comes back.
- Pass `VITE_TENANT_BASE_DOMAIN` (= `TENANT_BASE_DOMAIN`) as a build arg to `Dockerfile.web` so `app.<base>` shows the landing.

### Phase 6 — provisioning (PR B)
- M34 tenant provisioning validates the slug (Phase 1 rules) and audits the action. No per-tenant DNS,
  certificate, Pangolin or ingress change.

## Tests and gates

- Live suite on the real NOBYPASSRLS `chartwarden_app` role, in a private `pgvector/pgvector:pg18` container
  on its own port (never the shared cluster), one database at a time:
  - signed in on host A, request with host B ⇒ 403 `TENANT_HOST_MISMATCH`;
  - alias host ⇒ 308; suspended org ⇒ refused; closed org ⇒ static page, no sign-in;
  - creating or renaming to a slug or alias ever used ⇒ refused, even after the holder closed;
  - staff cookie on a `/portal/` route, or portal cookie on a staff route ⇒ 401.
- Unit tests: slug validator (reserved, `xn--`, length, hyphen edges); origin matcher (active slug, alias,
  unknown slug, apex look-alike such as `chartwarden.com.evil.test`).
- Browser E2E: a session cookie from host A is not sent to host B.
- New live suite ⇒ `package.json` script **and** a `ci.yml` job row (`arch:live-suites`).
- Run centrally before pushing: `bun run build`, `typecheck`, `arch:fitness`, non-live tests,
  `check:boot:platform`. Hit changed routes on the Docker stack before merge; migrate with the Docker
  `migrate` service, not host `db:migrate`.

## Risks

| Risk | Level | Mitigation |
|---|---|---|
| Cross-tenant session reuse | High | D1 check on every authenticated request; host-only cookies; live test |
| Forged `Host` or forwarded headers | High | Host only ever compared with the session; `X-Forwarded-*` only from trusted CIDRs |
| Origin matcher trusts an unprovisioned or reserved subdomain | High | Label must resolve to an active org or live alias; apex look-alike test |
| Existing slugs fail the new `CHECK` | Medium | One-off listing and manual rename with alias before the constraint lands |
| `chartwarden.com` DNS not controlled by quillwardhealth.com | Medium | Confirm before Phase 5; blocks only the edge work |
| Wildcard cert or DNS credential exposure | Medium | Scoped DNS-01 token held at the edge only |
| Passkey RP ID choice is effectively permanent | Medium | Set once at real-environment launch, which has no passkeys yet |
| Demo behaviour changes by accident | Medium | `TENANT_BASE_DOMAIN` unset ⇒ no-op; demo config untouched |
| Actions minutes burned by pushes | Low | Two PRs, batched pushes |

## Done when

- [ ] PR A and PR B merged with review findings addressed; all gates and the live suite green.
- [ ] A test tenant answers at `<slug>.chartwarden.com` with its own sign-in and is refused on another tenant's host.
- [ ] Architecture §19 / System Design §6.1 carry the ADR-0049 amendment (already present) and the ops runbook
      documents the wildcard DNS, Pangolin and ingress setup.
