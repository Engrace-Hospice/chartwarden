# ADR-0049 — Each tenant is served at `<slug>.<TENANT_BASE_DOMAIN>`; the host must agree with the session's org, never replace it

- **Status:** **Accepted** — decided by the product owner 2026-10-05: host-only sessions (D4),
  path-mounted patient portal (D7), slugs never reused (D3), base domain deferred (D2).
- **Date:** 2026-10-05
- **Phase:** post-launch platform work (tenant onboarding / branding).
- **Amends:** Architecture §19 ("Per-tenant subdomain pattern: `<tenant-slug>.wardenx.app`") and
  System Design §6.1 ("Tenant scoping — encoded in subdomain … which Pangolin resolves to a tenant slug
  header"). See "Consequences".
- **Related:** [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (`app.org_id` is the only tenancy GUC),
  [ADR-0033](ADR-0033-better-auth-mount-and-prod-db-client.md) (Better Auth mount + the session →
  `SessionContextResolver` path), [ADR-0040](ADR-0040-handrolled-http-hardening-no-fastify-plugins.md)
  (M1's hand-rolled CORS / CSRF / header chain, which this ADR extends rather than replaces).

## Context

We want each hospice to reach ChartWarden at its own host, for example `sunrise.wardenx.com` and
`tenderly.wardenx.com`. The architecture already assumes this: §19 names the
`<tenant-slug>.wardenx.app` pattern, and System Design §6.1 says the subdomain carries the tenant but
the backend "never trusts URL or body for tenant identity". **None of it is built.** As of `main`
@ `a56e2c030`:

- **The tenant comes only from the session.** `authenticate.ts:121` scopes every request to
  `session.activeOrganizationId`, which `POST /api/v1/auth/select-organization` binds after sign-in.
  Nothing reads the request host.
- **The hosts are fixed.** The production nginx vhost serves `server_name wardenx.chartwarden.cloud`
  and proxies `/api/` same-origin to the backend, passing `Host` through
  (`deploy/production/nginx/wardenx-frontend.conf:4-12`).
- **Trusted origins are an exact list.** `resolveTrustedOrigins()` splits the `TRUSTED_ORIGINS` env var
  (`packages/auth/src/identity/auth.ts:185`). That one list feeds Better Auth's `trustedOrigins` and the
  passkey origin list (`resolvePasskeyOrigins`). M1's CORS allow-set is a separate exact `Set.has`
  (`apps/backend/src/bootstrap/plugins/security.ts:62`). One entry per tenant would mean an env edit
  and a redeploy for every new tenant.
- **The slug already exists.** `organization.slug` is `NOT NULL UNIQUE` (migration `0000`,
  `packages/db/src/schema/organizations.ts:13`), but nothing constrains it to be a valid DNS label or
  keeps it off reserved names.
- **The docs' mechanism is unsafe as written.** §6.1 has Pangolin inject a tenant-slug header that
  the backend trusts. Production today runs host nginx without Pangolin. The target platform puts
  Pangolin back at the edge, in front of Talos Linux / Kubernetes. Either way, a tenant identity
  carried in a proxy-set header is one misconfigured hop away from being client-settable.

Two facts about the browser shape the design:

- **Subdomains of one registrable domain are *same-site*.** `SameSite=Lax` cookies
  (`csrf.ts:126`) therefore do **not** stop `sunrise.wardenx.com` from sending requests that carry
  `tenderly.wardenx.com`'s cookies, if those cookies are scoped to the parent domain.
- **Any subdomain can set a cookie for the parent domain** (cookie tossing), unless the cookie names
  use the `__Host-` prefix.

## Decision

### D1 — The host is a *routing and consistency* signal, never an authorization source

The tenant for a request is still `session.activeOrganizationId`, exactly as today. The host's slug
resolves to an `organization_id`, and the request is **refused** (403 `TENANT_HOST_MISMATCH`, M1
error envelope) if the two disagree. That keeps §6.1's rule that the backend never trusts the URL for
tenant identity:

- A forged or misrouted `Host` can only cause a refusal; it can never widen access.
- RLS still keys on the `app.org_id` GUC set from the session (ADR-0010). The host never reaches
  `withOrgContext`.

The check is a new M1 bootstrap hook that runs after `authenticate` and before route handlers. It
skips:

- Unauthenticated requests: sign-in and the `/api/auth/*` mount.
- Requests that have no active org yet. The select-organization window that every sign-in passes
  through is one of these.

On those paths it applies D3's validation to the host and does nothing more.

### D2 — Hosts and base domain

- **Base domain:** a new env var, `TENANT_BASE_DOMAIN` (for example `wardenx.com`), with no default.
  Its absence leaves the deployment in **single-host mode**: today's behavior, unchanged, with no host
  check. That lets the feature ship dark and lets dev stay on `localhost`.
- **Which domain is deliberately deferred.** The candidates are `wardenx.com`, the architecture's
  `wardenx.app`, and today's `chartwarden.cloud`. Nothing in this ADR depends on the choice. It **must**
  be made before the first tenant goes live on a subdomain, because a domain change after that breaks
  every bookmark and emailed link.
- **Tenant host:** `<slug>.<TENANT_BASE_DOMAIN>` serves the staff SPA (`apps/web`) at `/`, with `/api/`
  proxied same-origin to the backend, the same shape as today's vhost. Same-origin API calls mean
  tenant hosts need **no CORS entries at all**.
- **Reserved hosts** (never tenant slugs):

  | Host | Serves |
  |---|---|
  | `www`, the apex | marketing / redirect |
  | `admin` | the platform-ops console (`apps/admin`) |
  | `api` | reserved for a future cross-origin API host |
  | `portal` | reserved; the portal is path-mounted per tenant (D7) |
  | `storage` | object store (today's `storage.` host) |
  | `app` | the tenant-picker landing page (D5) |
  | `status`, `docs`, `mail` | reserved for future use |

- **Edge: Pangolin.** The edge is a Pangolin **wildcard public resource** (subdomain `*` under
  `TENANT_BASE_DOMAIN`). One resource proxies every tenant hostname through one tunnel. A wildcard DNS
  record points `*.<TENANT_BASE_DOMAIN>` at Pangolin.
- **TLS:** Pangolin terminates TLS with one wildcard certificate for `*.<TENANT_BASE_DOMAIN>` from
  Let's Encrypt via **DNS-01**. HTTP-01 cannot issue wildcards, so Pangolin needs DNS-provider API
  credentials.
- **Downstream routing:** Pangolin forwards the original `Host` header unchanged to the downstream
  router. On the target platform, Talos Linux running Kubernetes, that router is the cluster ingress.
  It routes by path on every tenant host:
  - `/api/` → the backend Service
  - `/portal/` → the portal SPA (D7)
  - `/` → the staff SPA
- **Reserved hosts** (D2 table above) are separate, exact-host Pangolin resources. They take precedence
  over the wildcard.
- **Adding a tenant needs no DNS, certificate, Pangolin or ingress change.**
- **Platform-independence:** this ADR depends only on two things: an edge that terminates the
  wildcard certificate and preserves `Host`, and path routing below it. It does not decide the Talos /
  Kubernetes migration itself; that is a separate ADR. Until the migration, the same shape runs on
  today's VPS, with Pangolin in front of the host nginx and its `server_name` widened to
  `*.<TENANT_BASE_DOMAIN>`.

### D3 — Slug rules

- **Format:** an RFC 1123 DNS label, lower-case only: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`. It
  also must not start with `xn--` (no punycode, which blocks homograph look-alikes).
- **Reserved names:** D2's reserved list is a single exported constant (`RESERVED_TENANT_SLUGS` in
  `@chartwarden/types`). Both the API validator and a DB `CHECK` enforce it, so it holds even for inserts
  that bypass the API, the same defense-in-depth shape as the 2026-10-04 audit's GAP-003 role-key fix.
- **Who sets it:** the slug is set at tenant provisioning (M34) and is validated there and on any
  rename.
- **A slug is never reused.** Once an organization has held a slug, no other organization may take it,
  ever. Old links (bookmarks, emails, fax cover sheets, printed material) must never lead staff or
  families to a *different* organization's sign-in page. Names are plentiful; the confusion and
  phishing look-alike risk on a PHI system is not worth reclaiming them.
- **Renames:** the old slug goes into a new `organization_slug_alias` table (owned by M1, alongside
  `organization`, unique across both). Requests to an alias host get a 308 redirect to the current
  slug, **indefinitely**.
- **Departed tenants:** a closed organization keeps its slug and aliases reserved. Its hosts serve a
  static "this organization is no longer on ChartWarden" page and accept no sign-in.

### D4 — Cookies are host-only; one session per tenant host

- The Better Auth session cookie and the CSRF cookie are **host-only**: no `Domain` attribute,
  `__Host-` prefix, `Secure`, `Path=/`.
- Better Auth's `crossSubDomainCookies` stays **off**.

Consequences:

- **A session cannot cross tenants.** A session minted on `sunrise.` is never sent to `tenderly.`.
  Same-site cookie leakage (Context) and cookie tossing are closed by construction, not by the D1
  check alone.
- **Users with several orgs sign in per tenant host.** Switching tenants means navigating to the other
  subdomain. Passkeys still work everywhere if `PASSKEY_RP_ID` is set to `TENANT_BASE_DOMAIN`: a
  WebAuthn RP ID may be a registrable suffix of the origin.
- **The session's active org is pinned to its host.** The select-organization call made on a tenant
  host may only select the org the host resolves to. The tenant picker therefore becomes navigation
  between hosts (D5), not an in-session org switch.

The alternative, one parent-domain session that follows the user across subdomains, is rejected. It
would make D1 the *only* barrier between tenants and reintroduce cookie tossing. That is the wrong
trade for a PHI system.

### D5 — Sign-in entry and the tenant picker

- `app.<TENANT_BASE_DOMAIN>` serves a sign-in-free landing page. The user enters an email, and the page
  redirects to the tenant host(s) where that email has a membership.
- To avoid user enumeration, the page always answers "check your email". It mails links to the user's
  tenant hosts and never shows them in the page.
- Invitation and magic-link emails link straight to the inviting tenant's host.
- Tenant hosts serve the normal sign-in page.

### D6 — Origins are matched by rule, not by list

`resolveTrustedOrigins()` gains a matcher: an origin is trusted if it is in `TRUSTED_ORIGINS` (unchanged
— admin, portal, dev hosts), **or** it is `https://<label>.<TENANT_BASE_DOMAIN>` where `<label>`
resolves to an *active* organization or a live alias. The same predicate backs:

- Better Auth's trusted-origin check.
- The passkey origin check (`resolvePasskeyOrigins()` becomes a check rather than a list).

How each library accepts a dynamic rule is confirmed at implementation time against the installed Better
Auth and `@simplewebauthn` versions. If either only takes a static list, the bootstrap pre-validates the
request origin with this predicate and hands the library a one-element list.

M1's CORS allow-set is **not** widened. Tenant hosts are same-origin (D2), so CORS stays the exact list
ARCH-025 / ADR-0040 require.

The slug → org lookup runs through the platform credential, because organization rows are not
tenant-RLS-visible before the GUC is set. It is cached in-process for 60 s, and an org status change
(suspend / close) evicts that entry. A suspended tenant's host therefore fails D6 and D1 within one
cache window.

### D7 — The patient portal is path-mounted under the tenant host

- The patient portal (`apps/portal`) is served at `<slug>.<TENANT_BASE_DOMAIN>/portal/`, not at a
  shared `portal.` host.
- Families see their hospice's name in the address, which builds trust and makes look-alike phishing
  harder.
- The tenant is known from the host, so there is no "choose your hospice" step after sign-in.
- The wildcard DNS record and certificate (D2) already cover it.
- The portal keeps its own session class under its own cookie name. That cookie follows D4's rules:
  host-only, `__Host-` prefix, `Path=/`. The `__Host-` prefix requires `Path=/`, so the portal and
  staff sessions are kept apart by cookie name and session class, not by path. A staff cookie never
  authenticates a portal route, and a portal cookie never authenticates a staff route.
- D1's host check applies to portal requests exactly as to staff ones.

## Consequences

- **Architecture §19 and System Design §6.1** are amended to cite this ADR:
  - The pattern becomes `<slug>.<TENANT_BASE_DOMAIN>`.
  - Pangolin stays as the edge, but the "tenant slug header" mechanism is removed. Pangolin and the
    ingress only preserve `Host`, and the backend resolves it itself. No proxy-injected tenant header
    exists for a client to forge. Any inbound tenant-identifying header is ignored.
  - The backend honours `X-Forwarded-*` only from `TRUSTED_PROXY_CIDRS`. On Kubernetes that is the
    ingress pods' CIDR, so a client cannot claim a different scheme or address through them.
- **SECURITY_HARDENING** CSP: `img-src` / `connect-src` change from `*.wardenx.app` to
  `'self'` (tenant hosts are same-origin), plus the explicit `storage.` host.
- **Env:** `TENANT_BASE_DOMAIN` joins `env.ts` and `.env.example`. It is optional; when it is set in
  production, `PASSKEY_RP_ID` must equal it, or boot fails.
- **Ops:** the ops runbook documents:
  - the wildcard DNS record
  - Pangolin's DNS-01 credentials, the wildcard resource and the exact-host resources for reserved
    names
  - the ingress path rules (Kubernetes manifests on the Talos platform, or the widened nginx
    `server_name` on today's VPS)

  Single-host mode keeps the current host working throughout the migration.
- **A follow-up ADR** records the move from the single VPS (Docker Compose + host nginx) to Talos
  Linux / Kubernetes behind Pangolin. It covers manifests, secrets, the live database and the deploy
  pipeline, which replaces `deploy.yml`'s SSH step. This ADR neither blocks on it nor decides it.
- **Existing tenants:** slugs that fail D3 are listed by a one-off check before the `CHECK`
  constraint lands, and renamed by hand with an alias.
- **Out of scope:** tenant-owned custom domains (for example `ehr.sunrisehospice.org`). These need
  per-domain certificates (HTTP-01 / on-demand TLS) and a verified-domain table. They are a later ADR
  that builds on D1 and D6 unchanged.

## Verification (when implemented)

- A live suite on the real `wardenx_app` role covers the core cases:
  - Signed in on `sunrise.`, a request with `Host: tenderly.` → 403 `TENANT_HOST_MISMATCH`.
  - An alias host → 308 to the current slug.
  - A suspended org's host → refused.
  - A closed org's host → the "no longer on ChartWarden" page, and sign-in is refused.
  - Creating or renaming an org to any slug or alias ever used → refused, even after the holder closed.
  - A staff session cookie on a `/portal/` route, or a portal cookie on a staff route → 401.
- A browser-level E2E confirms a `sunrise.` session cookie is not sent to `tenderly.`.
- Unit tests:
  - D3 slug validator: reserved names, `xn--`, length, hyphen edges.
  - D6 origin matcher: active slug, alias, unknown slug, an apex look-alike such as
    `wardenx.com.evil.test`.
- `arch:request-header-auth`: register the `Host` read as `verified`, because D1 only ever compares it
  with the session. It is not authorization on its own.

## Decisions taken at sign-off (2026-10-05)

| Question | Options considered | Decision |
|---|---|---|
| Session cookie scope (D4) | Host-only, one sign-in per tenant host / parent-domain, one sign-in everywhere | **Host-only**: the browser, not only D1, keeps tenants apart |
| Patient portal host (D7) | `<slug>.<base>/portal/` / shared `portal.<base>` | **Path-mounted** under the tenant host |
| Slug reuse (D3) | Never / after a waiting period | **Never**; aliases redirect indefinitely |
| Base domain (D2) | `wardenx.com` / `wardenx.app` / `chartwarden.cloud` | **Deferred**; must be set before the first tenant goes live on a subdomain |

## Amendment 2026-10-21 (Phase 4 backend)

Emailed links name the organization's own host (`tenantAppOrigin`), portal and staff are kept apart by session class
rather than a second cookie, and two narrow SECURITY DEFINER lookups (migrations 1148, 1149) back the public tenant name and
the `app.` "find my organization" mail. None changes D1: the host is still never an authorization source.
See `docs/TENANT_SUBDOMAINS_PLAN.md` (Phase 4 backend build notes).
