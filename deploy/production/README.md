# Production deployment automation

Merging a change to `main` deploys automatically only after the `CI` workflow succeeds. The release
workflow builds and pushes immutable backend and web images tagged `sha-<full-commit-sha>`, then runs
`deploy.sh` over SSH on the VPS. The server updates its local `.env.production` itself; no operator
edits `CHARTWARDEN_IMAGE` or `CHARTWARDEN_WEB_IMAGE` for a normal release.

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
access to the deploy directory (`/opt/chartwarden`; a legacy `/opt/wardenx` symlink may remain until the late cleanup, see `INFRA_RENAME_RUNBOOK.md`) and permission to run the narrowly required Docker Compose commands; do not
use a root SSH account or disable host-key checking.

The server must already contain a mode-`0600` `.env.production` copied from the production template.
To automate that first-time setup (and start MinIO before the first release), copy this repository
(or just `deploy/production`) to the VPS and run:

```sh
sudo DEPLOY_DIR=/opt/chartwarden ./deploy/production/bootstrap-vps.sh
```

An install lives in `/opt/chartwarden`, which is the fallback of `deploy.yml` and `reseed-production.yml` (override with the repository variable
`DEPLOY_DIR`). `preflight.sh` (piped by the workflows before any upload, and run by `deploy.sh`) is read-only and refuses (exit 67) when the configured volumes, database or layout do not match the host (it accepts every intermediate state of the infra-rename windows); see
`INFRA_RENAME_RUNBOOK.md`, "Merge order". The env template already carries `CHARTWARDEN_SMOKE_APP_URL` / `_API_URL`, which bootstrap rewrites with the domains.

Override domains when needed:

```sh
sudo FRONTEND_DOMAIN=app.example.com BACKEND_DOMAIN=api.example.com STORAGE_DOMAIN=storage.example.com \
  DEPLOY_DIR=/opt/chartwarden ./deploy/production/bootstrap-vps.sh
```

The bootstrap keeps an existing `.env.production`, installs the storage Nginx vhost when Nginx is
present, starts MinIO, and verifies `http://127.0.0.1:9000/minio/health/ready`. After DNS points
`STORAGE_DOMAIN` to the VPS, issue TLS for that host with Certbot or the server's normal reverse-proxy
TLS automation. The application reaches MinIO over the Compose network (`http://minio:9000`) and
uses `STORAGE_PUBLIC_ORIGIN` only for browser-facing presigned URLs. The public origin must resolve
for clients, but `/ready` does not depend on a host-network hairpin through Nginx/TLS.

The real, per-tenant-subdomain environment (`*.chartwarden.com`) has its own edge, env overlay and smoke probes:
see [`TENANT_EDGE.md`](./TENANT_EDGE.md).

### Nginx logging (PHI)

The stock `combined` access-log format records the full request URI, so patient search terms
(`?q=Smith`), cursors and S3 presigned signatures (`X-Amz-Signature`, `X-Amz-Credential`) would land in
`/var/log/nginx`. The repo's vhosts therefore name `chartwarden_phi_safe` (defined in
`nginx/chartwarden-log-format.conf`, installed to `/etc/nginx/conf.d/` by `bootstrap-vps.sh`), which logs
`$uri` (path only, no query string) and omits the Referer. The storage vhost has `access_log off`.

Host requirements — the repo cannot enforce these, so check them once per host:

- `/etc/nginx/nginx.conf` must include `conf.d/*.conf` **before** `sites-enabled/*` (the Debian/Ubuntu
  default), and must not set a server-wide `access_log` with the `combined`/`main` format.
- `error_log` can still echo the request line on upstream errors (`request: "GET /x?q=..."`). Keep it at
  `warn` or above and treat it as PHI-bearing: same retention and access controls as the application logs.
- Verify: `nginx -T | grep -n chartwarden_phi_safe`, then `curl -s "https://<host>/api/health?q=Smith" >/dev/null`
  and confirm the new `/var/log/nginx/chartwarden-*.access.log` line shows `/api/health` with no `?q=Smith`.

The workflow uploads `deploy.sh`, `smoke.sh` and `compose.yml` for every release, pulls the SHA-pinned
images, provisions the scoped MinIO account, runs strict schema-only migrations and runtime-role
provisioning, recreates `api`, `worker` and `web`, then runs `smoke.sh`. If any step fails, it restores
the previous image references and recreates those services. Database migrations are forward-only and
are not rolled back.

## DocLens worker and the scoped object-store account (GAP-138 / GAP-139)

`compose.yml` runs two more services alongside `api`/`worker`/`web`:

- **`docling-worker`** — DocLens OCR + layout, CPU-only, models baked into the image, reachable only on the compose
  network with the `DOCLING_WORKER_TOKEN` bearer. The release builds, scans (fixable HIGH/CRITICAL fail the release; unfixed ones are ignored), signs and
  attests `ghcr.io/<owner>/chartwarden-docling-worker:sha-<commit>` and passes it to `deploy.sh` as an optional third
  argument; `deploy.sh` verifies it like the other images and writes the digest-pinned `CHARTWARDEN_DOCLING_IMAGE`.
  `api`/`worker` deliberately do not `depends_on` it: a down worker makes DocLens answer 503, nothing else.
- **`minio-provision`** — a one-shot that creates the IAM policy (`CHARTWARDEN_MINIO_POLICY`, default `chartwarden-app`) and the service account the api/worker use
  (`MINIO_APP_ACCESS_KEY` / `MINIO_APP_SECRET_KEY`). The policy allows object and bucket operations on `tenant-*`
  and `chartwarden-*` buckets only; the MinIO root account is no longer an application credential.

- **`clamav`** (M36 message attachments) — clamd over TCP on the compose network only (no published port), config from
  `deploy/clamav/clamd.conf` (shipped to `<deploy dir>/clamav/` by `deploy.yml`): alerts on encrypted archives/documents
  and over-limit files, `StreamMaxLength` 26M (>= the 25 MB upload cap), signature DB in the `clamav-data` volume,
  refreshed in-container by freshclam. api/worker run `MESSAGING_ATTACHMENT_SCANNER=clamd` against `clamav:3310` and do not
  `depends_on` it: a down scanner leaves attachments `pending` (nothing is delivered). Alert on `pending` attachments
  older than a few minutes or repeated `deferred` scans; check the scanner with `docker compose exec clamav clamdcheck.sh`.
  `deploy.sh` brings it up without recreating it. clamd's protocol is unauthenticated, so the sidecar sits on a dedicated
  `scan` network that only `clamav`, `api` and `worker` join (postgres, minio, docling and the rest cannot reach it), and
  it is capped (`mem_limit: 4g`, `cpus: 2`) so a scan flood or a bad signature reload cannot starve the host. Follow-ups
  (not done here, they need network access to resolve): pin `clamav/clamav-debian:1.4` by digest
  (`image: clamav/clamav-debian@sha256:...`) when you promote it, and alert on a stale signature database (for example
  `docker compose exec clamav clamscan --version` reporting a database older than 2 days, or freshclam errors in the log).
- **Attachment upload size (defence in depth).** The presigned PUT signs `content-length` for exactly the declared
  `byteSize`, so MinIO refuses any other length and the quota (which counts `byteSize`) is real; `complete` also compares
  the stored size and destroys a mismatching object at once. The independent backstop is on the storage origin:
  `client_max_body_size` in `nginx/chartwarden-storage.conf` (100m today, sized for the largest M22 upload, so it is a ceiling
  not a per-file limit) and, if you want a hard per-tenant cap, a MinIO bucket quota on `tenant-*` buckets
  (`mc quota set <alias>/tenant-<orgId> --size <bytes>`). Browsers set `Content-Length` themselves and ignore it in the
  returned `headers` map, which is expected.
- **Attachment retention.** `MESSAGING_ATTACHMENT_RETENTION_DAYS` (default 7) is how long the object of a quarantined file, or of
  a file on a deleted message, is kept before the reaper destroys it (the row stays for audit; it stops counting toward the
  quota only once the object is destroyed, not when the message is deleted). It runs on the `DATABASE_DESTRUCTION_URL` credential like the orphan reaper.
- **`tenant-buckets`** — idempotent one-shot (`scripts/backfill-tenant-buckets.ts`) that creates `tenant-<orgId>` for every
  org lacking it; `deploy.sh` runs it each deploy (a failure only warns: the attachment upload path also creates a missing
  bucket on demand, and answers a typed 503 naming the bucket if it cannot).
- `DATABASE_DESTRUCTION_URL` (already set on api/worker) is required by attachments: the tenant eraser and the orphan
  reaper delete `message_attachment` rows, which `chartwarden_app` cannot. Without it the reaper is disabled (logged at boot)
  and a messaging erase refuses loudly. Its password, `CHARTWARDEN_DESTRUCTION_PASSWORD`, is required by `compose.yml`
  (already true before attachments); `deploy.sh` generates one into `.env.production` when the file predates it and never
  overwrites a value an operator set.

`minio` also runs MinIO's **audit webhook** to the api (`MINIO_AUDIT_WEBHOOK_*`, token `MINIO_ACCESS_LOG_WEBHOOK_TOKEN`):
the api keeps successful `GetObject` calls on `tenant-*` buckets and records them as `signed_url_consumed` in
`document_access_log`, attributed to the principal the signed URL was issued to (best effort; unattributable fetches are
dropped).

`deploy.sh` generates `DOCLING_WORKER_TOKEN`, `MINIO_APP_ACCESS_KEY`, `MINIO_APP_SECRET_KEY` and `MINIO_ACCESS_LOG_WEBHOOK_TOKEN` into `.env.production`
the first time it runs (existing values are never touched, and this happens before the rollback backup is taken).
To rotate the MinIO application secret, edit `MINIO_APP_SECRET_KEY` and deploy: `minio-provision` re-sets it.

## OWNER DECISION: production now enables the Oregon Medicaid gateway (GAP-146)

`M24_LAUNCH_GATEWAY_ENABLED` used to be opt-in, so a production deploy that never set it silently built no Medicaid
submit/poll workers. It is now **opt-out in production: an unset value means ENABLED** (dev/test/CI are unchanged:
unset = off). Consequences, so the owner can veto:

- With the gate on and `M24_CREDENTIAL_ENCRYPTION_KEY` set (already required in production), the M24 Medicaid
  submission and acknowledgement-poll workers are built and scheduled. They contact an Oregon endpoint only for a
  provider entity that has its own state trading-partner credential configured; with no credential nothing calls out.
- To veto and keep the previous behaviour, set `M24_LAUNCH_GATEWAY_ENABLED=false` in `.env.production` (any value other
  than `true`/`false` refuses to boot). `.env.example` documents the switch.

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

Tier 4 needs `CHARTWARDEN_SMOKE_EMAIL` and `CHARTWARDEN_SMOKE_PASSWORD` in `.env.production`. Provision an
account that is:

- **least privilege** — it must resolve an organization membership and nothing more. It does **not**
  need to read PHI, and it should not be able to. A standing deploy-time credential with chart access
  is a worse liability than the check is worth.
- **not 2FA-enrolled** — a deploy cannot type a TOTP code. `smoke.sh` detects `twoFactorRedirect` and
  fails with that explanation rather than a confusing 401 one step later.

If the account is not provisioned yet, the deploy **fails**. That is deliberate: skipping the only
end-to-end check because a variable happened to be unset is the same defect as the old loopback probe —
reporting success for something never measured. To deploy without it, set
`CHARTWARDEN_SMOKE_ALLOW_ANONYMOUS=1` explicitly; the skip is then printed to stderr on every deploy.

### Optional overrides

| Variable | Default |
| --- | --- |
| `CHARTWARDEN_SMOKE_APP_URL` | `.env.production` key of the same name, else `https://app.chartwarden.cloud` |
| `CHARTWARDEN_SMOKE_API_URL` | `.env.production` key of the same name, else `https://api.chartwarden.cloud` |

An exported variable wins, then the `.env.production` key, then the legacy host (what the live host serves until the
infra-rename cutover). The cutover sets both keys in `.env.production`, so the post-deploy smoke follows the new hosts
without a code change. A new install should set both keys to its `nginx/chartwarden-*.conf` hosts.

### Env-var rename and rolling back to an older release

`deploy.sh` and `compose.yml` read only `CHARTWARDEN_*` keys (the temporary `WARDENX_*` bridge is gone). A release from **before the ChartWarden env-var rename** (before #528) reads `WARDENX_*` only, so a deliberate manual rollback to such a commit needs every `CHARTWARDEN_*` key in `.env.production` renamed back to `WARDENX_*`, not just the three image pins. The automatic rollback inside a failed deploy is unaffected: it restores the pre-deploy backup of `.env.production`.

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
release**. To deploy without verification, set `CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED=1` explicitly — it
prints the fact on every deploy that uses it, because an unverified deploy must never be
indistinguishable from a verified one in the log.

What is actually checked is the **workflow identity**, not a key:

| Variable | Default |
| --- | --- |
| `CHARTWARDEN_COSIGN_IDENTITY` | env or `.env.production` value (space-separated for several), else `https://github.com/Engrace-Hospice/chartwarden/.github/workflows/deploy.yml@refs/heads/main` only. Images signed before the GitHub rename carry the old `Engrace-Hospice/wardenx` identity; a rollback to one needs it listed as a time-boxed opt-in (see `INFRA_RENAME_RUNBOOK.md`); the certificate's repository claim is verified too |
| `CHARTWARDEN_COSIGN_ISSUER` | `https://token.actions.githubusercontent.com` |

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
export DEPLOY_DIR="/opt/chartwarden"

SHA="94b4ca9dfb56e3c1d0551d08e18b78532e26728f"
# Image names: releases built before the infra rename were published as `wardenx` / `wardenx-web` (and
# `wardenx-docling-worker`); newer ones as `chartwarden*`. Use the name the target SHA was published under.
BACKEND_IMAGE="ghcr.io/engrace-hospice/wardenx:sha-${SHA}"
WEB_IMAGE="ghcr.io/engrace-hospice/wardenx-web:sha-${SHA}"

scp -P "$DEPLOY_PORT" \
  deploy/production/deploy.sh \
  deploy/production/smoke.sh \
  deploy/production/compose.yml \
  "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_DIR/"

ssh -p "$DEPLOY_PORT" "$DEPLOY_USER@$DEPLOY_HOST" \
  "chmod 700 $DEPLOY_DIR/deploy.sh $DEPLOY_DIR/smoke.sh && $DEPLOY_DIR/deploy.sh '$BACKEND_IMAGE' '$WEB_IMAGE'"


  git rev-parse main (to get de SHA)
```

### Database role rename (migration 1139)

Migration `1139_chartwarden_role_rename.sql` renames the database roles `wardenx_*` -> `chartwarden_*`
(`app`, `admin`, `readonly`, `audit_writer`, `platform` + `_login`, `destruction` + `_login`, `m36_reseal`,
`body_backfill_login`). Grants, RLS policies and SCRAM passwords move with the rename. A privilege-free
`NOLOGIN` role `wardenx_destruction` remained after 1139 because nine already-applied function bodies tested
`pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')`; migration 1142 rewrites those bodies and drops the
alias (migrate every database of a cluster back to back: the role is cluster-global). The database is named `chartwarden` (`CHARTWARDEN_DB_NAME`) after the infra-rename cutover.

- `compose.yml` now connects as `chartwarden_app` / `chartwarden_platform_login` / `chartwarden_destruction_login`.
  `deploy.sh` runs the migration before recreating containers, so the running containers briefly cannot open
  *new* connections until the new image is up; deploy at a quiet time and confirm `/health`.
- Before the first production run: `pg_dump` the database, and confirm `SHOW password_encryption;` is
  `scram-sha-256` and the login roles' verifiers are SCRAM (an MD5 verifier is cleared by a rename).
- Rollback to an older image after this migration keeps working (once it has committed; `deploy.sh` leaves the running containers alone if migrations did not complete) because the new `compose.yml` supplies the new
  role names; there is no down-migration.
