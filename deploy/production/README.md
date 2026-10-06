# Production deployment automation

Merging a change to `main` deploys automatically only after the `CI` workflow succeeds. The release
workflow builds and pushes immutable backend and web images tagged `sha-<full-commit-sha>`, then runs
`deploy.sh` over SSH on the VPS. The server updates its local `.env.production` itself; no operator
edits `WARDENX_IMAGE` or `WARDENX_WEB_IMAGE` for a normal release.

Before enabling the workflow, configure the GitHub `production` Environment with required reviewers
and these secrets:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | VPS hostname or IP address |
| `DEPLOY_PORT` | SSH port (optional; defaults to `22`) |
| `DEPLOY_USER` | Restricted deploy account, normally `deploy` |
| `DEPLOY_SSH_PRIVATE_KEY` | Dedicated Ed25519 private key for that account |
| `DEPLOY_KNOWN_HOSTS` | Exact `known_hosts` line(s) for the VPS SSH host key |

The matching public key belongs in the deploy account's `~/.ssh/authorized_keys`. The account needs
access to `/opt/wardenx` and permission to run the narrowly required Docker Compose commands; do not
use a root SSH account or disable host-key checking.

The server must already contain a mode-`0600` `.env.production` copied from the production template.
To automate that first-time setup (and start MinIO before the first release), copy this repository
(or just `deploy/production`) to the VPS and run:

```sh
sudo DEPLOY_DIR=/opt/wardenx ./deploy/production/bootstrap-vps.sh
```

Override domains when needed:

```sh
sudo FRONTEND_DOMAIN=app.example.com BACKEND_DOMAIN=api.example.com STORAGE_DOMAIN=storage.example.com \
  DEPLOY_DIR=/opt/wardenx ./deploy/production/bootstrap-vps.sh
```

The bootstrap keeps an existing `.env.production`, installs the storage Nginx vhost when Nginx is
present, starts MinIO, and verifies `http://127.0.0.1:9000/minio/health/ready`. After DNS points
`STORAGE_DOMAIN` to the VPS, issue TLS for that host with Certbot or the server's normal reverse-proxy
TLS automation. The application reads the public S3 origin from `STORAGE_PUBLIC_ORIGIN`; if it is
missing or unreachable, `/ready` will fail and document uploads will show storage unavailable.

### Nginx logging (PHI)

The stock `combined` access-log format records the full request URI, so patient search terms
(`?q=Smith`), cursors and S3 presigned signatures (`X-Amz-Signature`, `X-Amz-Credential`) would land in
`/var/log/nginx`. The repo's vhosts therefore name `wardenx_phi_safe` (defined in
`nginx/wardenx-log-format.conf`, installed to `/etc/nginx/conf.d/` by `bootstrap-vps.sh`), which logs
`$uri` (path only, no query string) and omits the Referer. The storage vhost has `access_log off`.

Host requirements — the repo cannot enforce these, so check them once per host:

- `/etc/nginx/nginx.conf` must include `conf.d/*.conf` **before** `sites-enabled/*` (the Debian/Ubuntu
  default), and must not set a server-wide `access_log` with the `combined`/`main` format.
- `error_log` can still echo the request line on upstream errors (`request: "GET /x?q=..."`). Keep it at
  `warn` or above and treat it as PHI-bearing: same retention and access controls as the application logs.
- Verify: `nginx -T | grep -n wardenx_phi_safe`, then `curl -s "https://<host>/api/health?q=Smith" >/dev/null`
  and confirm the new `/var/log/nginx/wardenx-*.access.log` line shows `/api/health` with no `?q=Smith`.

The workflow uploads `deploy.sh`, `smoke.sh` and `compose.yml` for every release, pulls the SHA-pinned
images, runs strict schema-only migrations and runtime-role provisioning, recreates `api`, `worker` and
`web`, then runs `smoke.sh`. If any step fails it restores the previous image references and recreates
those services. Database migrations are forward-only and are not rolled back.

## Post-deploy verification (`smoke.sh`)

Until #98 the deploy verified exactly one thing: that `http://127.0.0.1:3000/ready` eventually returned
200. That is one process answering its own readiness endpoint on loopback — it proved nothing about the
worker (which publishes no port and had no healthcheck, so a worker that booted and died left the deploy
green while every background job stopped), nothing about the web tier, and nothing about nginx or TLS,
because a loopback probe bypasses the reverse proxy entirely.

`smoke.sh` runs four tiers, ordered so a failure names its own cause:

| Tier | Checks | Rules out |
| --- | --- | --- |
| 1 containers | `api`/`worker`/`web` are `running`, and every declared healthcheck is green | crash loops, a service that never started |
| 2 loopback | api `/ready` on `:3000`; worker `/ready` **inside** its container; web on `:8080` | app-level failure, and — via the api's real `/ready` — an unreachable database, Valkey or object store |
| 3 ingress | the public hostnames answer over **TLS**, and `/` serves the SPA document | expired or mis-issued certificates, wrong upstream, empty web root |
| 4 authenticated | sign in, then `/auth/context` resolves a real `organizationId` | a broken auth stack, session cookies not surviving the proxy, org-context resolution failing |

### The synthetic monitor account (required)

Tier 4 needs `WARDENX_SMOKE_EMAIL` and `WARDENX_SMOKE_PASSWORD` in `.env.production`. Provision an
account that is:

- **least privilege** — it must resolve an organization membership and nothing more. It does **not**
  need to read PHI, and it should not be able to. A standing deploy-time credential with chart access
  is a worse liability than the check is worth.
- **not 2FA-enrolled** — a deploy cannot type a TOTP code. `smoke.sh` detects `twoFactorRedirect` and
  fails with that explanation rather than a confusing 401 one step later.

If the account is not provisioned yet, the deploy **fails**. That is deliberate: skipping the only
end-to-end check because a variable happened to be unset is the same defect as the old loopback probe —
reporting success for something never measured. To deploy without it, set
`WARDENX_SMOKE_ALLOW_ANONYMOUS=1` explicitly; the skip is then printed to stderr on every deploy.

### Optional overrides

| Variable | Default |
| --- | --- |
| `WARDENX_SMOKE_APP_URL` | `https://wardenx.chartwarden.cloud` |
| `WARDENX_SMOKE_API_URL` | `https://be082026.wardenx.chartwarden.cloud` |

Defaults come from the `server_name`s in `nginx/`, so a stock install needs no configuration.

### Rollback and migrations

`deploy.sh` now records how many migrations the release applied and reports the rollback accordingly:

- **0 applied** — the restored image ran against this exact schema minutes ago; the rollback is clean, and the log says so.
- **N applied (or unknown)** — images roll back, the schema does not. The restored release is running against a schema it has never seen, which is safe **only** if every migration in the release was expand-phase. Nothing in the toolchain enforces that, so the log says plainly that a human has to check `git diff --name-only <prev>..<sha> -- packages/db/migrations`.

## Supply chain (F-040 / #100)

The `release` job scans, describes and signs every image it publishes — all three addressing the
**digest**, never the tag. `sha-<commit>` is immutable by convention and by nothing else; a registry
will move a tag, so signing or attesting one proves nothing a minute later.

| Step | Tool | Failure behaviour |
| --- | --- | --- |
| Vulnerability scan | Trivy | **HIGH/CRITICAL fail the release.** Only `.trivyignore.yaml` gets past it, and every entry needs a statement plus an unexpired date within 90 days (`arch:vuln-allowlist`). |
| SBOM | syft (SPDX JSON) | Uploaded as a workflow artifact **and** attached to the image as a cosign attestation. An empty SBOM fails the build — it would answer "are we affected?" with a confident, wrong "no". |
| Signature | cosign, keyless | Signed after the scan passes. Signing a known-vulnerable image devalues every signature the process has produced. |

Scanning happens **before** signing on purpose: the signature asserts that an artefact went through this
release process, so the process must not stamp findings it would otherwise fail on.

### Verification on the VPS — `cosign` is now a prerequisite

`deploy.sh` verifies both images before pulling and **pins `.env.production` to the digest cosign
returned**, so Compose cannot re-resolve the tag to something else in between. Install it once:

```sh
curl -sSfLo /usr/local/bin/cosign   https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x /usr/local/bin/cosign
cosign version
```

If `cosign` is missing, or a signature does not verify, **the deploy refuses and restores the previous
release**. To deploy without verification, set `WARDENX_DEPLOY_ALLOW_UNVERIFIED=1` explicitly — it
prints the fact on every deploy that uses it, because an unverified deploy must never be
indistinguishable from a verified one in the log.

What is actually checked is the **workflow identity**, not a key:

| Variable | Default |
| --- | --- |
| `WARDENX_COSIGN_IDENTITY` | `https://github.com/Engrace-Hospice/wardenx/.github/workflows/deploy.yml@refs/heads/main` |
| `WARDENX_COSIGN_ISSUER` | `https://token.actions.githubusercontent.com` |

A signature produced by any other workflow, repository, branch or actor fails. That property is worth
more than usual here: `main` has no branch protection and the `production` environment has no approval
rules (#16), so this is currently the strongest statement available about where a running image came
from. It is **not** a substitute for #16 — someone able to edit workflows can still change what gets
signed; it means they cannot do it invisibly, because the Rekor entry records which workflow signed
what, and when.

## Rolling back

To roll back application code, run **Release and deploy** manually from the commit to restore (or add a
dedicated rollback workflow that passes the previous immutable image tags); never replace production
image references with `:latest`. Note that `.env.production` holds a digest after a verified deploy,
which is a stronger rollback target than a tag: it names one artefact and cannot drift.

``` bash
export DEPLOY_HOST="2.25.109.137"
export DEPLOY_USER="deploy"
export DEPLOY_PORT="22"

SHA="94b4ca9dfb56e3c1d0551d08e18b78532e26728f"
BACKEND_IMAGE="ghcr.io/engrace-hospice/wardenx:sha-${SHA}"
WEB_IMAGE="ghcr.io/engrace-hospice/wardenx-web:sha-${SHA}"

scp -P "$DEPLOY_PORT" \
  deploy/production/deploy.sh \
  deploy/production/smoke.sh \
  deploy/production/compose.yml \
  "$DEPLOY_USER@$DEPLOY_HOST:/opt/wardenx/"

ssh -p "$DEPLOY_PORT" "$DEPLOY_USER@$DEPLOY_HOST" \
  "chmod 700 /opt/wardenx/deploy.sh /opt/wardenx/smoke.sh && /opt/wardenx/deploy.sh '$BACKEND_IMAGE' '$WEB_IMAGE'"


  git rev-parse main (to get de SHA)
```
