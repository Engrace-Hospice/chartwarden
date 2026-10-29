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

## Backups and restore (`compose.backup.yml`, `backup/`, #857)

Coordinated, encrypted, off-site backups of Postgres (pgBackRest, WAL archiving / PITR) and every MinIO bucket
(versioned SSE-C mirror to an object-locked bucket), tied together by a per-snapshot marker (DB LSN + object
manifest with sha256). Design, variables, key management and RPO/RTO: `docs/architecture/CHARTWARDEN_DR_BCP_v0.1.md`
§4.8; operating loop and alerts: `CHARTWARDEN_OPS_RUNBOOK_v0.1.md` §5.7. `deploy.yml` ships `compose.backup.yml` and
`backup/` with every release; nothing runs until it is enabled once:

```sh
cd /opt/chartwarden    # after setting the BACKUP_* ids in .env.production and the files in ./secrets/ (DR/BCP §4.8.4)
install -d -m 0700 -o 999 -g 999 secrets   # one file per secret, mode 0400, owner 999 (the image's postgres user)
dc() { docker compose --env-file .env.production -f compose.yml -f compose.backup.yml "$@"; }
dc build postgres                      # chartwarden-backup:local (pgvector/pgvector:pg18 + pgBackRest + mc)
dc run --rm minio-backup-provision     # read-only MinIO account for the backup
dc up -d postgres backup               # recreates postgres once (same volume) with archive_mode=on
dc logs -f backup                      # the first snapshot takes a full base backup
```

The off-site bucket must have Object Lock with a COMPLIANCE default retention of >= 100 days (every snapshot checks
it), a lifecycle longer than the lock, and three keys with the policies in `backup/offsite-policies/` (WAL-only key
in `postgres`, backup key in the sidecar, read-only key for restores). `OPS_ALERT_WEBHOOK_URL` (https) is mandatory.
`deploy.sh` never recreates `postgres`, so releases keep archiving on. Recreating `postgres` with `compose.yml` alone
turns archiving off; the next snapshot then fails and pages. Restore into an isolated target with
`BACKUP_ENV_FILE=... ./backup/restore.sh latest`, then run the verifier it prints. Prove changes to `backup/` with
`bun run backup:coordinated-drill` (private containers; writes `audit/restore-drill/<date>-coordinated-backup-drill.md`).

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

Migrations are forward-only and commit one file at a time, so a failed deploy can leave the schema ahead of the
previous release, or partway between the two releases. `deploy.sh` never starts the previous release on a schema
it cannot prove that release can run on (#861). It reads the migration ledger (`_chartwarden_migration`) before
migrating (and aborts, changing nothing, if it cannot), then again after, and the difference decides what a later
failure does:

| What this deploy applied | On failure |
| --- | --- |
| nothing | restore `.env.production`, recreate the previous api/worker/web (exit 1). The log says "rollback is clean". |
| only migrations declared `-- compat: expand` that also pass the `arch:migration-compat` check (classified by the new image) | same as above (exit 1). The log says "rollback is expand-safe". |
| anything else: a `contract` or undeclared migration (every migration before 1288 is undeclared), or the ledger or classifier could not be read | **hold** (exit **75**). Nothing is restarted or recreated. |

A failed migrate step is judged the same way: the ledger shows exactly which files committed before the failure.
A first-ever deploy has no previous release, and every pre-1288 file is undeclared, so it always holds on failure.
If `migrate.ts` adopts a historical filename alias (it renames the ledger row), that name shows up as newly
applied and causes a false hold. This is the safe direction.

The compatibility contract (each new migration declares `expand` or `contract`, enforced by
`bun run arch:migration-compat`) is described in `packages/db/migrations/README.md`.

#### When a deploy halts for an operator decision

The log shows `DEPLOY HALTED FOR AN OPERATOR DECISION: AUTOMATIC ROLLBACK REFUSED` and lists the migrations it
applied. At that point:

- Whatever was running is still running. If the failure came at or before `provision`, that is the previous
  api/worker/web. If it came at `up` or smoke, it is the new release. Stopping app containers is not the default:
  for an EHR, clinicians reading charts through a partly working app beats a full outage. If the operator does
  decide to stop them (or the running app is unsafe on the new schema), turn the maintenance page on first, below.
- `.env.production` names the **new** release, the only code written for this schema. The previous file is saved
  as `.env.production.previous-release`.

Pick one:

1. **Roll forward (the default).** Fix the cause, then re-run `deploy.sh` with the same or a fixed release.
   `migrate` is idempotent: it applies only what is still pending.
2. **Roll back**, only after reading the applied migrations and confirming the previous code works on this schema:
   ```sh
   cp .env.production.previous-release .env.production
   docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web
   ```

Either way, delete `.env.production.previous-release` afterwards (it holds secrets, mode 600).

**Maintenance page (#865).** A host-level nginx switch serves a static 503 page (`Retry-After: 600`, no PHI, no
external assets) instead of a raw 502 while app containers are stopped:

```sh
/opt/chartwarden/maintenance.sh on       # touches /etc/nginx/chartwarden-maintenance.on; effective on the next request
/opt/chartwarden/maintenance.sh status
/opt/chartwarden/maintenance.sh off      # removes the flag
```

Equivalent by hand: `touch /etc/nginx/chartwarden-maintenance.on` / `rm /etc/nginx/chartwarden-maintenance.on`. No nginx
reload is needed; the flag is tested per request. Every method (GET, PUT, PATCH, DELETE, OPTIONS, POST) gets the 503
and `Retry-After: 600`; the page is inline in the snippet, so no file has to be served.
Probes: the api answers `/ready` and `/health` at its root, and those two exact paths are exempt (`/ready%0a`,
`/ready/` are not). They reach the api only through the **backend** vhost (everything proxied) and, for `/ready` only,
the **tenant** vhost. On the **frontend** vhost they fall through to the web container, not the api, so that vhost has
no api probe.
Scope: the snippet gates the port-80 vhosts, in front of any certbot HTTP-to-HTTPS redirect, so a client is redirected
first and then sees the 503. Webhook senders (Twilio, Postmark, ...) get the 503 and must retry; nothing queues them.
`bootstrap-vps.sh` installs `nginx/chartwarden-maintenance.conf` to `/etc/nginx/snippets/`; the frontend, backend and
tenant vhosts include it (on a host that predates this, re-copy the vhosts and snippet, then
`nginx -t && systemctl reload nginx`). MinIO's storage vhost is not covered.
**Turn maintenance off before re-running `deploy.sh`**: its smoke tier 3 probes the public URLs and would see the 503.
Decision: `deploy.sh` never enables maintenance by itself. A halt is, by design, a state where the running app may
still be serving clinicians, and flipping it on automatically would cause the outage the hold exists to avoid.

**Deploy alert (#866).** Put `DEPLOY_ALERT_WEBHOOK_URL=https://...` (a Slack-compatible incoming webhook, or any
endpoint taking a JSON POST) in `<deploy dir>/.deploy-alert.env`, mode 0600 (template: `.deploy-alert.env.example`;
`bootstrap-vps.sh` creates it commented out). It is **not** read from `.env.production`, because `compose.yml` injects
that whole file into the api, worker, web and migrate containers. An exported `DEPLOY_ALERT_WEBHOOK_URL` wins over the
file. `deploy.sh` then posts on any non-zero exit after the env file check, including a killed deploy (HUP/INT/TERM
become exit 129/130/143): exit 75 is labelled "operator decision required". The payload has only the commit SHA, the
failing step, the exit code and the applied migration filenames. Delivery is best effort (5 s connect / 10 s total
timeout; a failure is logged and never changes the deploy's exit status); the URL is never printed. Unset means no
alert, and the failed `deploy` workflow run is then the only signal.

## Infrastructure images: digest pins (#855)

Every third-party image in `compose.yml` is `repo:tag@sha256:<digest>` (the tag is the human label; the digest is
what is pulled). The GHCR application images are digest-pinned through env by `deploy.sh`. `bun run
arch:compose-policy` (part of `arch:fitness`) fails on any literal image without a digest.

| Service | Image | Version at pin time (2026-10-27) |
|---|---|---|
| postgres | `pgvector/pgvector:pg18` | PostgreSQL 18 (same digest as `backup/Dockerfile`) |
| valkey | `valkey/valkey:8-alpine` | Valkey 8.x |
| minio, minio-provision | `cgr.dev/chainguard/minio:latest` | MinIO `RELEASE.2026-10-23T20-06-51Z` |
| clamav | `clamav/clamav-debian:1.4` | ClamAV 1.4.x |

MinIO: `minio/minio` is no longer published to Docker Hub, so the server is Chainguard's build (it ships `minio`,
`mc`, `sh` and `bash`, but no `curl`; the healthcheck therefore probes `/minio/health/ready` over bash `/dev/tcp`
and sends `Host: localhost`, which MinIO requires for this HTTP/1.0 request).
It defaults to uid 65532, but the existing `minio-data` volume is root-owned, so the service sets `user: "0:0"`.
Moving to the nonroot user needs a one-time `chown -R 65532 /data` on the volume. Chainguard's free tier only
tags `latest`; older digests stay pullable for now but are not guaranteed, so mirror the pinned digest into a
registry you control (e.g. GHCR) before relying on it for disaster recovery.

**Updating an image**
1. Resolve the new digest: `docker buildx imagetools inspect <repo:tag>` (the top-level `Digest:` is the index digest).
2. Edit `compose.yml` (tag and digest together) and the version table above; if it is postgres, update
   `backup/Dockerfile` to the same digest.
3. Restore-test: run the restore drill (`docs/runbooks/m36-restore-drill.md`; for postgres/minio also restore the
   previous backup onto the new image) and `smoke.sh` against a staging stack.
4. `bun run arch:compose-policy`, then ship through the normal PR/deploy path. Rollback is the previous digest.

## Resource budget (#856)

Every service sets `mem_limit` and `cpus` (plain `docker compose up` honours these, no Swarm needed); long-running
services also set `mem_reservation`, and postgres additionally has a larger `cpu_shares`. Enforced by
`bun run arch:compose-policy`. **These are reasonable defaults for a single 16 GiB / 8 vCPU host, not load-tested
values**; tune them from `docker stats` and OOM events (`docker inspect -f '{{.State.OOMKilled}}' <ctr>`).

| Service | mem_limit | mem_reservation | cpus |
|---|---|---|---|
| postgres | 4g | 2g | 4 (cpu_shares 2048) |
| clamav | 4g | 1g | 2 |
| docling-worker | 2g | 512m | 2 |
| api / worker | 1536m each | 512m each | 2 each |
| valkey | 1g | 128m | 1 |
| minio | 1g | 256m | 2 |
| web | 128m | 32m | 0.5 |
| one-shots (migrate, provision, minio-provision, tenant-buckets, seed-runner, hl7-listener) | 128m-1g | none | 0.5-2 |

Long-running limits sum to about 15 GiB (memory limits are ceilings, not a simultaneous allocation) and
reservations to about 5 GiB, which leaves headroom for the OS, host Nginx and Docker on 16 GiB. CPU limits are
deliberately oversubscribed (they throttle, they do not reserve). One-shots run transiently during deploys.
To tune: edit the numbers, keep `mem_limit` set on every service, and keep reservations below roughly half of RAM.
A hit memory ceiling shows as an OOM kill and a restart, so a limit set too low trades noisy neighbours for outages.
Known gaps: Postgres `shared_buffers`/`work_mem` and Valkey `maxmemory` are not tuned to these limits.
`preflight.sh` prints a warning (never fails) when the host has under about 15 GB of RAM or under about 1.5 GB available.

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
