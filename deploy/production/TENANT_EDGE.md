# Tenant edge runbook — per-tenant subdomains on the demo and the real environment (ADR-0049, ADR-0087, ADR-0088)

Each hospice is served at `https://<slug>.<base>`: the staff app at `/`, the patient/family portal at `/portal/`, the
API same-origin at `/api/`. Two environments use this mechanism, each with its own base domain and its own checklist below:

| | Demo | Real |
|---|---|---|
| Base domain | `chartwarden.cloud` | `chartwarden.com` |
| Data | synthetic, reseeded | real PHI |
| Server, database, object store, secrets | the existing demo install | its **own**, never the demo's |
| Web image | `deploy.yml`, build args from the repository variable `DEMO_TENANT_BASE_DOMAIN` | manual workflow **Release tenant web image** |
| Switched on by | that variable plus the five settings in the demo's `.env.production` | the `.env.tenant.example` overlay |
| Hosts that already exist | `app.`, `api.`, `storage.` and the legacy `wardenx.` host (a 308 redirect, `nginx/chartwarden-legacy-redirects.conf`) keep working: they are all reserved names, so none can be a tenant slug | none |

The demo's per-tenant mode is an owner decision that supersedes ADR-0088 decision 2 ("the demo stays single-host"); until it
is switched on the demo behaves exactly as before. `/ready` is proxied on the tenant vhost like the demo's `api.` vhost; it
names dependency health, so restrict it at the edge if that is unwanted. Nothing in this file is per tenant: provisioning a
tenant (M34) changes **no** DNS, certificate, Pangolin or nginx configuration. The shared web image also ships the portal at `/portal/`.

## Before anything else (blocks the edge, not the code)

- [ ] Someone on the team can sign in to the Cloudflare account that holds the zone (`chartwarden.cloud` for the demo,
      `chartwarden.com` for the real environment). quillwardhealth.com controls the `chartwarden.com` zone (ADR-0088 D5).
- [ ] A scoped DNS-01 credential per zone (next section), held **at the edge only**: never in `.env.production`, never in CI,
      never in a repository variable. One token per zone: the demo's token never touches `chartwarden.com`.

## Cloudflare and the edge (both zones)

### 1. API token

- [ ] Cloudflare dashboard, My Profile, API Tokens, Create Token, template **Edit zone DNS**.
- [ ] Permissions: **Zone, DNS, Edit**. Add **Zone, Zone, Read** only if issuance fails to find the zone (Traefik/lego look the zone up by name; it grants no write).
- [ ] Zone Resources: Include, Specific zone, **that one zone**. Client IP filtering: the edge server's address. Set an expiry and a calendar reminder to rotate it.
- [ ] Copy it once into the edge's secret store (step 3). Check it: `GET https://api.cloudflare.com/client/v4/user/tokens/verify` answers `"status":"active"`.

### 2. DNS records

Substitute the zone. Every record is **DNS-only (grey cloud)**, TTL 300 for the first week.

| Name | Type | Target | Proxy |
|---|---|---|---|
| `@` (apex) | A | the edge / ingress IP | DNS-only |
| `*` | A | same | DNS-only |
| `storage` | A | same (an exact record for a reserved name, so it can move on its own later) | DNS-only |

- [ ] Add an AAAA with each only if the edge really listens on that IPv6 address.
- [ ] A wildcard does not cover the apex, and an exact record always beats the wildcard, so the demo's existing `app`, `api`, `storage` and `wardenx` records stay as they are.
- [ ] Optional hardening: `CAA 0 issue "letsencrypt.org"` and `CAA 0 issuewild "letsencrypt.org"`.
- [ ] Pangolin's own dashboard host and its WireGuard endpoint stay DNS-only too (UDP does not pass the proxy).

Why not proxied (orange cloud): a proxy terminates TLS at Cloudflare and reads every request, so PHI would transit a third party (a BAA is not available on self-serve plans; confirm yours); `request.ip` and every per-address rate budget would key on Cloudflare addresses unless `TRUSTED_PROXY_CIDRS` listed Cloudflare's ranges, and trusting a hop you do not control makes `X-Forwarded-For` spoofable; and the origin already terminates TLS with its own wildcard certificate. The demo holds synthetic data, so proxying it would be legal, but keep it DNS-only for parity with the real environment.

### 3. Wildcard certificate (DNS-01)

One certificate for the base domain **and** `*.<base>` (HTTP-01 cannot issue a wildcard). Use whichever terminates TLS on that host.

**Option 1: Pangolin (Traefik), the target edge (ADR-0049 D2).** Per Pangolin's wildcard-certificate docs; check the keys against the version you run.
- [ ] `config/traefik/traefik_config.yml`: under `certificatesResolvers.letsencrypt.acme`, replace `httpChallenge` with `dnsChallenge: { provider: "cloudflare" }`.
- [ ] Traefik's container environment gets `CLOUDFLARE_DNS_API_TOKEN` (from a root-only `0600` env file kept at the edge, not in the compose file or git).
- [ ] Pangolin `config/config.yml`: `domains.domain1` with `base_domain: "<base>"`, `cert_resolver: "letsencrypt"`, `prefer_wildcard_cert: true`.
- [ ] Restart Traefik; `docker logs traefik` shows the `*.<base>` order succeeding; `acme.json` is on a persistent volume.

**Option 2: host nginx with certbot (no Pangolin in front).**
- [ ] `sudo apt install python3-certbot-dns-cloudflare`.
- [ ] Create `/etc/letsencrypt/cloudflare.ini` with `sudo install -m 600 /dev/null /etc/letsencrypt/cloudflare.ini && sudoedit /etc/letsencrypt/cloudflare.ini`, containing one line, `dns_cloudflare_api_token = <token>` (not through the shell, so it stays out of history).
- [ ] A lineage of its own (the demo already has a certbot lineage for `app.`/`api.`/`storage.`; leave it):
      `sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini --cert-name chartwarden-wildcard -d <base> -d '*.<base>' --deploy-hook 'systemctl reload nginx'`.
- [ ] Give the tenant vhost its 443 block: `sudo certbot install --nginx --cert-name chartwarden-wildcard -d <base> -d '*.<base>'`; if it finds no matching vhost, add `listen 443 ssl;`, `ssl_certificate .../chartwarden-wildcard/fullchain.pem;` and `ssl_certificate_key .../privkey.pem;` to `chartwarden-tenant.conf` by hand. `sudo certbot renew --dry-run` must pass.

### 4. Pangolin resources (skip with Option 2)

- [ ] One **wildcard** public resource for `*.<base>`, target the host nginx (`http://<host>:80`), the "custom host header" left **empty** so the original `Host` is preserved.
- [ ] **Exact-host** resources for the reserved names (`app`, `www`, `admin`, `api`, `portal`, `storage`, `status`, `docs`, `mail`, `wardenx`): exact hosts take precedence, so the wildcard never swallows them. Point the ones that serve something at their upstream (`app` at the web upstream, `storage` at the object store); point the rest at a static 404 or a redirect to the apex rather than leaving them to the wildcard (`wardenx` exists only on the demo, where it keeps its 308 to `app.`; the real environment points it at a 404). Reserved names can never be a tenant slug (backend rule).
- [ ] Wildcard-resource support is version dependent: confirm it exists in your Pangolin before building around it; ADR-0049 D2 is the design.
- [ ] The nginx vhost listens on port 80 behind this terminator, like the demo vhosts.

## Host configuration

```sh
sudo TENANT_BASE_DOMAIN=chartwarden.com FRONTEND_DOMAIN=app.chartwarden.com BACKEND_DOMAIN=app.chartwarden.com \
  STORAGE_DOMAIN=storage.chartwarden.com DEPLOY_DIR=/opt/chartwarden ./deploy/production/bootstrap-vps.sh
```

With `TENANT_BASE_DOMAIN` set, bootstrap overlays `.env.tenant.example` onto a **new** `.env.production` and installs
`nginx/chartwarden-tenant.conf` (apex + `*.base`). It keeps an existing `.env.production`: on an existing install (the demo)
merge the overlay by hand. The real environment gets its **own** database, object store and secrets, never the demo's.
On the demo, the exact `server_name` of the existing `app.`/`api.`/`storage.` vhosts wins over the wildcard one, so they keep serving.

| Setting | Why it matters |
|---|---|
| `TENANT_BASE_DOMAIN` | turns the host guard on (unset = single-host) |
| `PASSKEY_RP_ID` = base domain | one passkey works on every tenant host. Effectively permanent once passkeys exist: set once at launch |
| `BETTER_AUTH_URL` = `https://app.<base>` | fallback origin for links with no tenant |
| `TRUSTED_ORIGINS` includes `https://<base>` | without the apex, sign-in there fails `INVALID_ORIGIN` |
| `TRUSTED_PROXY_CIDRS` = the proxy only | `X-Forwarded-Host` is honoured from these peers and nobody else |

`WEBAUTHN_RP_ID` and `STORAGE_PUBLIC_ORIGIN` are set alongside them (see `.env.tenant.example`); `PASSKEY_RP_ID` must equal `TENANT_BASE_DOMAIN` or the API refuses to boot.

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
`web-nginx.conf`, so a deep-link reload never gets the staff document). Two build args matter, and both are **baked in**, so
single-host and per-tenant installs need separate builds:

- `VITE_TENANT_BASE_DOMAIN=<base>` shows the "find my organization" landing at `app.<base>`.
- `CSP_STORAGE_ORIGIN=https://storage.<base>` pins the CSP's `img-src` and `frame-src` to that origin in place of any `https:`
  (presigned previews load from there; `connect-src` stays `'self' wss:`, as nothing fetches storage directly).

**Real environment:** run the manual workflow **Release tenant web image** (`.github/workflows/release-tenant-web.yml`, input
`base_domain`). It builds `chartwarden-web-tenant:sha-<sha>` with both args, scans it (HIGH/CRITICAL fail) and signs it with
cosign. It is manual-only and the real environment is deployed by hand; set `CHARTWARDEN_WEB_IMAGE` to that image.

**Demo:** `deploy.yml` builds `chartwarden-web` on every release and passes both args from the repository variable
`DEMO_TENANT_BASE_DOMAIN` (empty or unset = both args empty, the Dockerfile defaults: the single-host behaviour is unchanged; the image digest still differs from build to build). A malformed value fails the first step after checkout, before any image is built. Setting
the variable changes nothing until the next release run, and adds no workflow trigger.

## Verify (smoke.sh)

Set `CHARTWARDEN_SMOKE_TENANT_URL=https://<sample-slug>.<base>` (a provisioned, active sample tenant) in that install's
`.env.production`. `smoke.sh` then asserts: the host resolves to an active organization, an unprovisioned label answers 404, and
`/portal/p/<x>/care-plan` and `/portal/signed-in` return the **portal** document. Unset skips all three. It runs in every
deploy, so set it only once that host answers, or the deploy fails its smoke tier.

## Checklist A: the demo, `chartwarden.cloud`

Warnings first.

- **Changing `PASSKEY_RP_ID` invalidates every existing demo passkey.** The demo's value is `app.chartwarden.cloud`; per-tenant
  mode needs `chartwarden.cloud`. Demo users must re-enrol a passkey (the demo is reseeded rather than remediated, so this is acceptable). Rolling back changes the id again and invalidates the ones enrolled in between.
- Sessions are per host and the CSRF cookie becomes host-only (`__Host-`): demo users sign in again on their tenant host.
- `app.`, `api.`, `storage.` (and `www`, `admin`, `portal`, `status`, `docs`, `mail`, plus the legacy `wardenx`) are **reserved names** that can never be a tenant. `app.chartwarden.cloud` becomes the "find my organization" landing; the demo organization's own address is `https://chartwarden-demo.chartwarden.cloud`.
- Do steps 5 to 7 in one sitting: the host's env, the web image and the API settings must change together.

Steps:

- [ ] 1. Cloudflare for the `chartwarden.cloud` zone: token, DNS records (add `@`, `*`; `storage` already exists), certificate and, if Pangolin fronts the demo, the resources (previous section). The demo's TLS is certbot on host nginx today (`INFRA_RENAME_RUNBOOK.md`), so Option 2 is the usual path.
- [ ] 2. Install the tenant vhost next to the existing ones, by hand: `sed 's#chartwarden\.com#chartwarden.cloud#g' deploy/production/nginx/chartwarden-tenant.conf | sudo tee /etc/nginx/sites-available/chartwarden-tenant.conf`, symlink it into `sites-enabled/`, `nginx -t && systemctl reload nginx`. **Do not re-run `bootstrap-vps.sh` on the demo**: it re-installs the storage vhost over the one certbot added its TLS block to.
- [ ] 3. Check the edge before touching the app: `dig +short chartwarden-demo.chartwarden.cloud`; `curl -sI https://chartwarden-demo.chartwarden.cloud/` shows a valid wildcard certificate and the staff app; `https://app.chartwarden.cloud` still works exactly as before.
- [ ] 4. Check the demo organization's slug is a legal label: `DATABASE_URL=<the demo database, from the host> bun run scripts/db/tenant-slugs-check.ts` exits 0 (the seeded one is `chartwarden-demo`).
- [ ] 5. On the host, edit `.env.production` (a deploy takes it up; nothing restarts on its own):
      `TENANT_BASE_DOMAIN=chartwarden.cloud`, `PASSKEY_RP_ID=chartwarden.cloud`, `WEBAUTHN_RP_ID=chartwarden.cloud`,
      `BETTER_AUTH_URL=https://app.chartwarden.cloud` (it is `https://api.chartwarden.cloud` today),
      `TRUSTED_ORIGINS=https://app.chartwarden.cloud,https://chartwarden.cloud` (keep any mobile origin already listed),
      `TRUSTED_PROXY_CIDRS` = the real proxy hops only (the demo's `127.0.0.1/32,172.16.0.0/12` is right for nginx directly in front of the API; add the Pangolin peer if it fronts nginx).
- [ ] 6. Set the repository variable: `gh variable set DEMO_TENANT_BASE_DOMAIN --body chartwarden.cloud --repo Engrace-Hospice/chartwarden` (Settings, Secrets and variables, Actions, Variables).
- [ ] 7. Ship it: merge anything you were merging anyway, or `gh workflow run deploy.yml --ref main` (dispatch skips only the debounce and runs the full metered CI matrix; do it once). The new web image bakes both args, the deploy restarts the API with the new settings.
- [ ] 8. Smoke: sign in at `https://chartwarden-demo.chartwarden.cloud`, enrol a passkey, open `/portal/`; `https://app.chartwarden.cloud` shows the landing; an unknown label such as `https://nope.chartwarden.cloud/api/v1/public/tenant` answers 404 `TENANT_HOST_UNKNOWN`.
- [ ] 9. Last, in the host's `.env.production`: `CHARTWARDEN_SMOKE_TENANT_URL=https://chartwarden-demo.chartwarden.cloud` so every later deploy proves it.
- Rollback: unset the repository variable, restore the five previous values, redeploy. Existing certificates and DNS can stay.

## Checklist B: the real environment, `chartwarden.com`

- [ ] 1. The "Before anything else" items hold for the `chartwarden.com` zone.
- [ ] 2. A server of its own with its own database, object store and secrets (`deploy/production/README.md`: compose, the Docker migrate job, never host `db:migrate`, no demo seed and no demo data, ADR-0088 D3). Then `bootstrap-vps.sh` as in "Host configuration"; it writes the `.env.tenant.example` overlay and installs the tenant vhost.
- [ ] 3. Cloudflare for the `chartwarden.com` zone: token, DNS (`@`, `*`, `storage`), wildcard certificate, Pangolin wildcard plus exact resources.
- [ ] 4. Settings in `.env.production`: `TENANT_BASE_DOMAIN=chartwarden.com`, `PASSKEY_RP_ID=chartwarden.com` (permanent: the environment starts with no passkeys), `BETTER_AUTH_URL=https://app.chartwarden.com`, `TRUSTED_ORIGINS` including `https://chartwarden.com`, `TRUSTED_PROXY_CIDRS` = the proxy only.
- [ ] 5. Build the web image: run **Release tenant web image** with `base_domain=chartwarden.com`; set `CHARTWARDEN_WEB_IMAGE` to its digest-pinned reference. The backend image is the same one the demo uses for that commit.
- [ ] 6. Start the stack; `/api/ready` is green; provision a sample tenant (platform console, New tenant: the subdomain field confirms availability and shows the address) and set `CHARTWARDEN_SMOKE_TENANT_URL` to it.
- [ ] 7. Run `smoke.sh` by hand on the host; open the sample tenant's staff app and `/portal/`.
- [ ] 8. Before any real PHI: backups and a restore drill (`deploy/production/README.md`, "Backups and restore").

## Known behaviour to tell support about

- Staff and portal sessions share one cookie per host: signing in to one replaces the other in that browser.
- Suspending/closing a tenant takes effect within 60 s on every process (the host cache); offboarding through M34 does
  not evict it early.
- A person who is a member of several organizations gets one email from the `app.<base>` landing listing each link.
