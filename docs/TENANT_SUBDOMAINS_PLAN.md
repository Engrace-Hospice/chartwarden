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

### Phase 4 — web (PR B)
- Tenant host: normal sign-in page with the tenant's name; no org-select. Invite and magic-link emails link
  to the inviting tenant's host.
- `app.chartwarden.com` landing (D5): email in, always "check your email", links mailed to the user's tenant
  hosts, never shown (no user enumeration).
- Portal served under `/portal/` of the tenant host. Staff cookie never authenticates a portal route and the
  reverse (401).

### Phase 5 — edge and environment (PR B)
- Confirm quillwardhealth.com controls `chartwarden.com` DNS; add the wildcard record and DNS-01 credentials.
- Pangolin wildcard resource plus exact-host resources for reserved names (they take precedence).
- Real-environment env file (`TENANT_BASE_DOMAIN`, `PASSKEY_RP_ID`, `BETTER_AUTH_URL`, `TRUSTED_PROXY_CIDRS`),
  own database and secrets. Widen nginx `server_name` to `*.chartwarden.com` on the VPS interim, or ingress
  path rules on Talos. Path routing: `/api/` backend, `/portal/` portal SPA, `/` staff SPA.
- CSP: `img-src` and `connect-src` to `'self'` plus the explicit `storage.` host.
- Ops runbook section; `smoke.sh` probes a sample tenant host and a wrong-tenant request.

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
