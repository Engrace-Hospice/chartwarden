# Tenant edge runbook — the real environment (ADR-0049, ADR-0087)

The demo (`chartwarden.cloud`) is single-host; its vhosts and settings are not touched here. (The shared web image now also ships the portal at `/portal/`, unused on the demo.) `/ready` is proxied on the tenant vhost like the demo's `api.` vhost; it names dependency health, so restrict it at the edge if that is unwanted. The real environment serves each
hospice at `https://<slug>.chartwarden.com`, the staff app at `/`, the patient/family portal at `/portal/`, and the
API same-origin at `/api/`. Nothing in this file is per tenant: provisioning a tenant (M34) changes **no** DNS,
certificate, Pangolin or nginx configuration.

## Before anything else (blocks the edge, not the code)

- [ ] quillwardhealth.com controls the `chartwarden.com` DNS zone. Nothing below can start without it.
- [ ] A scoped DNS-01 credential for that zone exists and is held **at the edge only** (never in `.env.production`,
      never in CI). It can edit `_acme-challenge` records and nothing else if the provider allows.

## DNS and certificates

| Record | Target |
|---|---|
| `chartwarden.com`, `*.chartwarden.com` | the VPS / ingress IP |
| `storage.chartwarden.com` | same (exact record; reserved name) |

One wildcard certificate for `chartwarden.com` + `*.chartwarden.com` (DNS-01; HTTP-01 cannot issue a wildcard).
In Pangolin: one wildcard resource for `*.chartwarden.com` plus **exact-host resources** for the reserved names
(`app`, `www`, `admin`, `api`, `portal`, `storage`, `status`, `docs`, `mail`): exact hosts take precedence, so the
wildcard never swallows them. Reserved names can never be a tenant slug (backend rule), so they are safe to route
elsewhere. The nginx vhost below listens on port 80 behind that TLS terminator, like the demo vhosts.

## Host configuration

```sh
sudo TENANT_BASE_DOMAIN=chartwarden.com FRONTEND_DOMAIN=app.chartwarden.com BACKEND_DOMAIN=app.chartwarden.com \
  STORAGE_DOMAIN=storage.chartwarden.com DEPLOY_DIR=/opt/chartwarden ./deploy/production/bootstrap-vps.sh
```

With `TENANT_BASE_DOMAIN` set, bootstrap overlays `.env.tenant.example` onto a **new** `.env.production` and installs
`nginx/chartwarden-tenant.conf` (apex + `*.base`). It keeps an existing `.env.production`: on an existing install merge
the overlay by hand. This environment gets its **own** database, object store and secrets, never the demo's.

| Setting | Why it matters |
|---|---|
| `TENANT_BASE_DOMAIN` | turns the host guard on (unset = single-host) |
| `PASSKEY_RP_ID` = base domain | one passkey works on every tenant host. Effectively permanent once passkeys exist: set once at launch |
| `BETTER_AUTH_URL` = `https://app.<base>` | fallback origin for links with no tenant |
| `TRUSTED_ORIGINS` includes `https://<base>` | without the apex, sign-in there fails `INVALID_ORIGIN` |
| `TRUSTED_PROXY_CIDRS` = the proxy only | `X-Forwarded-Host` is honoured from these peers and nobody else |

`TRUSTED_PROXY_CIDRS` also decides what `request.ip` is, and therefore what every per-address rate budget is keyed on (public signup,
auditor redeem, **external partner access**). The value is validated: IPv4/IPv6 addresses or CIDRs with a prefix of 1 or more, or
the keywords `loopback`, `linklocal`, `uniquelocal`. **`/0` (`0.0.0.0/0`, `::/0`), `*`, `true`, a bare number and anything malformed
make the whole list unusable** (Fastify then trusts nobody). **Messaging external partner access (ADR-0096 D17) fails closed:** it is
available only when `NODE_ENV` is exactly `development` or `test`, or the list is present and valid. In any other case (production,
staging, `prod`, an unset or mistyped `NODE_ENV`, a missing or invalid list) the partner routes are not mounted, one warning naming the
offending entry is logged at boot, and creating or reissuing a partner share answers `PARTNER_ACCESS_UNAVAILABLE` (HTTP 503, "partner
access needs trusted proxy configuration"). List only the real proxy hops: a hop the caller controls lets a spoofed
`X-Forwarded-For` pick its own budget bucket.

**The reverse proxy must overwrite `X-Forwarded-Host`** (the shipped vhost sets it to `$host`). A proxy that forwards
the client's value lets a caller choose their own tenant host for every request. The API must not be reachable except
through that proxy. If Pangolin sits in front of nginx, list the Pangolin peer **and** make sure it too overwrites
rather than appends.

## The web image

`Dockerfile.web` builds the staff app and the portal (served at `/portal/`, its own `index.html` fallback in
`web-nginx.conf`, so a deep-link reload never gets the staff document). Build the **real-environment** image with
`--build-arg VITE_TENANT_BASE_DOMAIN=<base>`: that is what shows the "find my organization" landing at `app.<base>`.
The value is baked into the bundle, so the demo and the real environment need **separate image builds** (the demo's is
empty). Run the manual workflow **Release tenant web image** (`.github/workflows/release-tenant-web.yml`, input `base_domain`): it builds `chartwarden-web-tenant:sha-<sha>` with the build arg, scans it (HIGH/CRITICAL fail) and signs it with cosign. It is manual-only and the real environment is deployed by hand; set `CHARTWARDEN_WEB_IMAGE` to that image.
The workflow also passes `CSP_STORAGE_ORIGIN=https://storage.<base>`, which pins the CSP's `img-src` and `frame-src` to that origin in place of the demo's any-`https:` (presigned previews load from there; `connect-src` stays `'self' wss:`, as nothing fetches storage directly).

## Verify (smoke.sh)

Set `CHARTWARDEN_SMOKE_TENANT_URL=https://<sample-slug>.<base>` (a provisioned, active sample tenant). `smoke.sh` then
asserts: the host resolves to an active organization, an unprovisioned label answers 404, and `/portal/p/<x>/care-plan`
and `/portal/signed-in` return the **portal** document. Unset (the demo) skips all three.

## Known behaviour to tell support about

- Staff and portal sessions share one cookie per host: signing in to one replaces the other in that browser.
- Suspending/closing a tenant takes effect within 60 s on every process (the host cache); offboarding through M34 does
  not evict it early.
- A person who is a member of several organizations gets one email from the `app.<base>` landing listing each link.
