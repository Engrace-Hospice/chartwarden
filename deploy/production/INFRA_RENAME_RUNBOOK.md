# Infrastructure rename runbook: wardenx -> chartwarden

Operator runbook for the infrastructure identifiers that a code merge CANNOT rename safely. The
product/code rename is already merged. Nothing below is automated; each step is manual, ordered, and
reversible until its "commit point". Run it from a maintenance window the operator owns. Never run
any step against production without a fresh `pg_dump` and a MinIO mirror (Step 0).

Ship order matters: Phase 1 is already in code, Phases 2-5 are independent unless a dependency is
stated. Recommended order: 1 (verify) -> 2 (repo rename) -> 3 (MinIO) -> 4 (`/opt` dir) -> 5 (hostnames).

## What was already applied in code (Phase 1, no manual step except verification)

| Identifier | Change |
| --- | --- |
| GHCR images `wardenx`, `wardenx-web`, `wardenx-docling-worker` | CI now builds/signs/scans/deploys `ghcr.io/engrace-hospice/chartwarden`, `-web`, `-docling-worker` |
| `deploy.sh` image allow-list | accepts BOTH name families, so a rollback to a pre-rename release is still accepted |
| `compose.yml` docling default image, `seed-api` container name, `reseed-demo.sh` names | renamed (one-shot / default-only, no data) |
| `.env.production.example`, README image examples, `pr-image-gate.yml` local tag | renamed (cosmetic) |

Why the image rename is safe: the cosign certificate identity is the *workflow* identity
(`https://github.com/<repo>/.github/workflows/deploy.yml@refs/heads/main`), not the image name, so
signatures on `chartwarden*` verify against the unchanged pinned identity. `.env.production` on the VPS
holds the OLD image refs (digest-pinned `wardenx@sha256:...`); `deploy.sh` rewrites
`CHARTWARDEN_IMAGE` / `CHARTWARDEN_WEB_IMAGE` / `CHARTWARDEN_DOCLING_IMAGE` with the new refs after
cosign passes, and `restore_previous_release` restores the backed-up env file (old refs) so the old
images are pulled by digest from the old, untouched GHCR packages. DO NOT delete the old `wardenx*`
GHCR packages until the rollback window for the last pre-rename release has closed.

First-release preconditions (verify BEFORE merging to `main`, which auto-deploys):

1. GHCR creates the three new packages on first push. Confirm the org allows `GITHUB_TOKEN` to create
   packages (Org settings -> Packages) and that the pull credential on the VPS can read new packages:
   `ssh deploy@VPS 'docker pull ghcr.io/engrace-hospice/chartwarden:sha-<any-pushed-sha>'` is only
   possible after the first release job pushes; if the release job succeeds but the VPS pull fails,
   deploy.sh restores the previous env and leaves running containers untouched (nothing is down).
   Fix: grant the package read access to the PAT owner (Package settings -> Manage access) or
   re-run `docker login ghcr.io` with a PAT that has `read:packages`, then re-run the deploy job.
2. Package visibility: set each new package to "Inherit access from repository" (private) and add the
   repo under "Manage Actions access" so later releases can push.
3. Rollback rehearsal (read-only): `sh -n deploy/production/deploy.sh` and check that
   `./deploy.sh ghcr.io/o/wardenx:sha-x ghcr.io/o/wardenx-web:sha-x` is accepted by the case filter
  .

Rollback of Phase 1: re-run the deploy workflow on the previous commit (old workflow builds old names),
or `deploy.sh` with the old names (accepted). No data is involved.

## Step 0 - Safety net (before any phase)

```sh
ssh deploy@2.25.109.137
cd /opt/wardenx
docker compose --env-file .env.production -f compose.yml exec -T postgres pg_dump -U postgres -d wardenx | gzip > ~/pre-rename-$(date +%F).sql.gz
# pg_dump omits cluster roles and their passwords; without this a restore onto a fresh cluster fails on ownership/grants
docker compose --env-file .env.production -f compose.yml exec -T postgres pg_dumpall -U postgres --globals-only > ~/pre-rename-globals-$(date +%F).sql
# MinIO: mirror every bucket first (mc mirror) - this step is mandatory, not optional
cp .env.production ~/.env.production.pre-rename && chmod 600 ~/.env.production.pre-rename
docker compose --env-file .env.production -f compose.yml config > ~/compose.resolved.pre-rename.yml
```

## Phase 2 - GitHub repo rename `Engrace-Hospice/wardenx` -> `Engrace-Hospice/chartwarden`

Downtime: none for the running app. CI is unusable between the rename and the identity change (below),
so do not merge to `main` during the window.

Preconditions: no deploy running; no open release; org-owner rights; `gh auth status` ok.

Important coupling: the cosign certificate identity embeds `<owner>/<repo>`. Signatures made BEFORE the
rename carry `.../Engrace-Hospice/wardenx/...`; signatures made AFTER carry `.../chartwarden/...`.
`deploy.sh` pins ONE identity (`CHARTWARDEN_COSIGN_IDENTITY`, default in `deploy.sh`). So:

1. Rename (GitHub keeps web + git redirects, but NOT Actions OIDC claims):
   `gh api -X PATCH repos/Engrace-Hospice/wardenx -f name=chartwarden`
2. Update local remotes everywhere: `git remote set-url origin git@github.com:Engrace-Hospice/chartwarden.git`.
3. Change the default identity in `deploy/production/deploy.sh` (the `cosign_identity=` line) to
   `https://github.com/Engrace-Hospice/chartwarden/.github/workflows/deploy.yml@refs/heads/main`.
   MANDATORY before step 1: land a PR that makes `deploy.sh` accept BOTH identities (try the new, then the old), so no
   main push in the window between the rename and this change can fail a deploy and pre-rename signed images still roll
   back. The alternative for a one-off rollback is to export `CHARTWARDEN_COSIGN_IDENTITY=https://github.com/Engrace-Hospice/wardenx/.github/workflows/deploy.yml@refs/heads/main`
   before running `deploy.sh` (the env override already exists). Pre-rename images were signed
   under the OLD identity and will fail verification against the new default.
4. The first release after the rename signs with the new identity. Merge the identity change as the
   FIRST commit after the rename; the release job's own `cosign verify` uses `${GITHUB_REPOSITORY}`
   and needs no edit. The VPS `deploy.sh` is re-uploaded on every deploy, so no VPS edit is needed.
   If you deploy before step 3 is merged, `deploy.sh` rejects the new signatures and restores the
   previous release (safe, but the release is not deployed).
5. Update repo references: `gh` issue-tracker docs (`docs/agents/issue-tracker.md`, another owner),
   `CLAUDE.md`/`AGENTS.md` (verbatim copies), badges, `.archon/workflows`, branch protection / required
   status checks (re-save, check names are unchanged), GitHub Environments `production` (kept on rename),
   Actions secrets (kept), self-hosted runner registration URL (runner keeps working via redirect;
   re-register if it logs "repository not found": `./config.sh remove` then `./config.sh --url
   https://github.com/Engrace-Hospice/chartwarden --token <new>`), Dependabot/other integrations, and
   any external link to `ghcr.io/engrace-hospice/wardenx*`.
6. GHCR package -> repo links: new packages built from the renamed repo link via the
   `org.opencontainers.image.source` label that `deploy.yml` now sets on every build; old `wardenx*` packages stay linked to the renamed repo.

Verification: `gh repo view Engrace-Hospice/chartwarden`; push a no-op commit to a branch and confirm CI
starts; after the first `main` release, `cosign verify ghcr.io/engrace-hospice/chartwarden@<digest>
--certificate-identity <new identity> --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

Rollback: `gh api -X PATCH repos/Engrace-Hospice/chartwarden -f name=wardenx`, revert the identity
commit. Caveat: do NOT create a new repo named `wardenx` in the org after renaming; it would break the
old-name redirect.

## Phase 3 - MinIO buckets (data movement; buckets cannot be renamed)

Downtime: only if you want zero risk of lost writes. Platform buckets are written rarely
(terminology releases); `wardenx-readiness` is an ephemeral probe. `tenant-*` buckets are NOT renamed and
NOT touched. Cut over in a short write freeze (stop `worker`) or accept re-running the sync.

Bucket inventory (code/config references):

| Bucket | Where it is referenced |
| --- | --- |
| `chartwarden-platform-terminology` (was `wardenx-platform-terminology`; code switched in step 2) | `apps/backend/src/modules/38-terminology/jobs/platform-objects.ts` (`DEFAULT_PLATFORM_BUCKET`, overridable via env `TERMINOLOGY_PLATFORM_BUCKET`); `apps/backend/src/index.ts` (~3968); `apps/backend/src/modules/22-documents/access-log/minio-access-log.test.ts` |
| `chartwarden-readiness` (was `wardenx-readiness`; code switched in step 2) | `apps/backend/src/index.ts` (`READINESS_PROBE_BUCKET`) |
| `wardenx-*` IAM scope | `deploy/production/compose.yml` minio-provision policy `wardenx-app` (`arn:aws:s3:::wardenx-*`, `.../wardenx-*/*`) |
| Policy / account names | `wardenx-app` (policy and `MINIO_APP_ACCESS_KEY` default in `deploy.sh` and `.env.production.example`), `wardenx-minio-admin` (root user) |
| Audit webhook target id | `compose.yml` `MINIO_AUDIT_WEBHOOK_*_wardenx` (suffix is the target name) |
| Docs | `deploy/production/README.md`, `docs/` (other owner) |

Order of the bucket change (production holds only `tenant-*` buckets today; neither `wardenx-platform-terminology` nor
`wardenx-readiness` exists on disk, so no data copy is needed unless a terminology release has been uploaded since):
1. Policy PR (additive, done first): the `wardenx-app` policy in `compose.yml` also allows `chartwarden-*`. After its deploy,
   confirm with `mc admin policy info local wardenx-app` that both prefixes are present.
2. DONE (code PR, after step 1 was live): `DEFAULT_PLATFORM_BUCKET` / `READINESS_PROBE_BUCKET` switched to the new names.
   Neither creates a bucket: the readiness probe treats 404 (missing bucket) as healthy; the terminology store fails on a
   missing bucket, so `chartwarden-platform-terminology` must exist (`mc mb`) before the first terminology upload/read.
   A deployment already holding releases in the old bucket must either mirror them (procedure below) or set
   `TERMINOLOGY_PLATFORM_BUCKET=wardenx-platform-terminology` to keep using the old bucket.
3. Cleanup (after the rollback window): drop the `wardenx-*` entries and rename the policy/account.

Only after step 1 is deployed may `TERMINOLOGY_PLATFORM_BUCKET=chartwarden-platform-terminology` be set in `.env.production`;
setting it earlier makes every terminology read/write fail with AccessDenied because the policy would still only allow
`wardenx-*`. `minio-provision` re-applies the policy on every deploy, before api/worker are recreated. `READINESS_PROBE_BUCKET`
is hardcoded (not env-overridable), so that bucket needs the code change (step 2).

Procedure (on the VPS; `mc` alias `local` points at the MinIO root):

```sh
cd /opt/wardenx
# 1. Record old settings to recreate (versioning, lifecycle, policy, notifications, quota, tags, encryption)
for b in wardenx-platform-terminology wardenx-readiness; do
  echo "== $b"; mc version info local/$b; mc ilm rule ls local/$b; mc anonymous get local/$b
  mc event ls local/$b; mc quota info local/$b; mc encrypt info local/$b; mc tag list local/$b
done
# 2. Create new buckets with the same settings
mc mb local/chartwarden-platform-terminology
# re-apply versioning / ilm / quota / encrypt / anonymous policy exactly as recorded above
# (bucket policies and event/webhook notifications are per-bucket and are NOT copied by mirror)
# 3. Copy data (preserves metadata and versions are NOT copied unless --preserve and versioning on)
mc mirror --preserve --overwrite local/wardenx-platform-terminology local/chartwarden-platform-terminology
# 4. Verify
mc diff local/wardenx-platform-terminology local/chartwarden-platform-terminology   # expect no output
mc du local/wardenx-platform-terminology; mc du local/chartwarden-platform-terminology
# 5. Switch: ship the policy/code/env change above, deploy, re-run the mirror once more, then smoke
```

Verification: terminology release job reads/writes the new bucket; `GET /api/ready` (readiness probe)
healthy; MinIO audit webhook still posts to `/api/v1/webhooks/minio/access-log` for the new bucket
(`mc admin config get local audit_webhook`; the webhook target is server-wide, buckets need no per-bucket
hook). Keep the old buckets read-only for at least one release cycle; delete only after the operator
confirms (`mc rb --force local/wardenx-platform-terminology`). Rollback: revert the env/code change; old
buckets are untouched. Renaming the policy `wardenx-app` or the webhook target suffix is optional and
restarts/reconfigures MinIO (brief downtime); do it last, or leave as-is (internal names, never user-facing).

## Phase 4 - VPS directory `/opt/wardenx` -> `/opt/chartwarden`

Downtime: about one `docker compose up` cycle (30-120 s) if you move the directory while containers run
with bind mounts (`/opt/wardenx/clamav/clamd.conf`). Compose project name stays `wardenx` (see below), so
volumes/networks are unaffected.

References to change in a follow-up PR (after the move): `.github/workflows/deploy.yml` (scp targets,
`mkdir -p`, `chmod`, `deploy.sh` path), `.github/workflows/reseed-production.yml`, `deploy.sh` /
`smoke.sh` / `reseed-demo.sh` defaults (`CHARTWARDEN_DEPLOY_DIR:-/opt/wardenx`), `bootstrap-vps.sh`
(`DEPLOY_DIR`), `README.md` paths, `/etc/sudoers.d` entries and the deploy user's allowed Docker Compose
commands (they name `/opt/wardenx`), any cron/systemd units, log/backup paths (`CREDENTIALS.production.md`).

Procedure (symlink strategy keeps old and new paths valid so the merged-code and VPS changes can land in
either order):

```sh
ssh deploy@2.25.109.137
cd /opt/wardenx && docker compose --env-file .env.production -f compose.yml ps   # note healthy state
sudo systemctl stop <runner or cron that deploys> || true        # make sure no deploy runs
sudo mv /opt/wardenx /opt/chartwarden
sudo ln -s /opt/chartwarden /opt/wardenx                          # old path still works
cd /opt/chartwarden
docker compose --env-file .env.production -f compose.yml up -d --force-recreate    # force: a moved bind-mount path (clamav) is not always detected as a change
./smoke.sh   # or: bash smoke.sh
```

Then merge the follow-up PR that points all scripts/workflows at `/opt/chartwarden`. Remove the symlink
(`sudo rm /opt/wardenx`) only after one successful deploy and one reseed dry run use the new path.
Compose caveat: the project name is `name: wardenx` in `compose.yml` and containers/volumes/networks are
`wardenx_*`. KEEP IT. Changing `name:` makes Compose create new, empty `chartwarden_pgdata` / MinIO / clamav
volumes and orphan the old ones (data loss from the app's point of view). A volume rename needs
`docker run` copy into new volumes with downtime; it is not worth doing and is out of scope.
Rollback: `sudo rm /opt/wardenx && sudo mv /opt/chartwarden /opt/wardenx`, `up -d`.

## Phase 5 - Hostnames, DNS, TLS, nginx

Current hosts: `wardenx.chartwarden.cloud` (web), `be082026.wardenx.chartwarden.cloud` (api),
`storage.wardenx.chartwarden.cloud` (S3). Target names are the operator's choice (for example
`app.chartwarden.cloud`); the host list below is parameterised.

Downtime: none if the old hosts keep serving until cutover (dual-host). Users are logged out and passkeys
break unless handled, see the warnings.

WARNINGS (not reversible by DNS alone):

- `PASSKEY_RP_ID` / `WEBAUTHN_RP_ID` (`.env.production`): changing the relying-party id invalidates every
  registered passkey/WebAuthn credential. Either keep the old RP id (a parent-domain RP id such as
  `chartwarden.cloud` is valid for both hosts and is the migration target), or plan a re-enrolment.
- `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `STORAGE_PUBLIC_ORIGIN`, `M34_INVITATION_ACCEPT_URL`,
  `FHIR_TOKEN_ENDPOINT_URL`, `CORS` lists: changing the origin invalidates cookies scoped to the old host
  (sessions) and presigned URLs. Mobile deep link `wardenx://` and wire names are a different owner.

Procedure:

1. DNS: add A/AAAA records for the new hosts to `2.25.109.137` (TTL 300). Keep the old records.
2. TLS: `sudo certbot certonly --nginx -d <new-web> -d <new-api> -d <new-storage>` (or add SANs to the
   existing certificate with `--expand`). Confirm `certbot renew --dry-run`.
3. nginx: `bootstrap-vps.sh` installs `nginx/wardenx-*.conf` to `/etc/nginx/sites-available/` and the
   `wardenx_phi_safe` log format. Add the new hosts as additional `server_name` values (or run
   `FRONTEND_DOMAIN=... BACKEND_DOMAIN=... STORAGE_DOMAIN=... sudo ./bootstrap-vps.sh`, which sed-rewrites the
   hostnames), `nginx -t && systemctl reload nginx`. Renaming the vhost files / the `wardenx_phi_safe` format
   is cosmetic: if done, rename the file, the `ln -sfn` in `bootstrap-vps.sh`, the `access_log` path, and
   the format name together, `nginx -T | grep phi_safe`, and keep log rotation (`logrotate`) and any log shipper in sync.
4. Env: update the variables above in `.env.production` and the defaults in `smoke.sh` /
   `bootstrap-vps.sh` / `.env.production.example`; `docker compose up -d --force-recreate api worker web`.
5. Cut over web clients/links; keep the old hosts as 301 redirects for at least 30 days (staff bookmarks,
   emailed invitation links, FHIR/HL7 partners that hold the old base URL: notify first).

Verification: `curl -sI https://<new-web>`, `/api/health` and `/api/ready` on the new API host, `openssl
s_client -connect <host>:443 -servername <host> | openssl x509 -noout -subject -dates`, login and presigned
upload/download through the new storage host, `./smoke.sh` with `CHARTWARDEN_SMOKE_APP_URL` /
`CHARTWARDEN_SMOKE_API_URL` set to the new hosts. Rollback: point env back to the old hosts, `up -d`; the old
records and certificate were never removed.

## Explicitly NOT renamed (by design)

- Postgres database name `wardenx` (parameterized by `CHARTWARDEN_DB_NAME`, default `wardenx`; flipped only in the downtime window below), applied migration SQL, legacy function names
  (renaming a database requires dropping connections and updating every `DATABASE_*_URL`; applied-migration
  checksums forbid editing SQL). The `wardenx_destruction` role alias was dropped by migration 1142.
- The `_wardenx_migration` ledger IS renamed to `_chartwarden_migration` (by `scripts/db/migrate.ts`
  `ensureLedger`). A `_wardenx_migration` compat view remains so a rollback to the previous release's runner
  keeps working; a later cleanup step drops it.
- Compose project name `wardenx` and the `wardenx_*` volumes/network (data loss, see Phase 4).
- Wire names (metrics, cookies, HL7, `wardenx://`, `x-wardenx-background`, `/_wardenx-internal/*`): other owner.
- The `wardenx-demo` organization slug and `*@wardenx.local` demo accounts: now `chartwarden-demo` / `*@chartwarden.local` in the seed. Production needs one demo reseed (`reseed-production.yml`); `scripts/db/seed.ts` removes the legacy `wardenx-demo` org and its sole-tenant identities.

## Database rename downtime window (`wardenx` -> `chartwarden`)

The database name is now read from `CHARTWARDEN_DB_NAME` (default `wardenx`) by `compose.yml`
(`POSTGRES_DB`, the `pg_isready` healthcheck, every `DATABASE_*_URL` built in compose),
`reseed-demo.sh` and `deploy.sh`, which both fail fast (exit 64) unless the value matches
`^[a-z_][a-z0-9_]*$`. Until the flip, behaviour is unchanged. Compose project `wardenx` and the `wardenx_*`
volumes stay as they are. Estimated downtime: 5-10 minutes. Execute only with the user's go-ahead.

Note: `POSTGRES_DB` only matters on first init of an empty data volume; the existing cluster keeps its
database, so the rename below is what actually changes it.

1. Safety net: Step 0 above (`pg_dump` + `pg_dumpall --globals-only`, MinIO mirror, env backup).
2. Disable `deploy.yml` (Actions UI) and make sure no deploy is running; no merges to `main` meanwhile.
3. Stop the app containers so nothing holds a connection:
   `docker compose --env-file .env.production -f compose.yml stop api worker web`
   (also any `seed-api`/`docling-worker` profile containers that are running).
4. Rename (needs zero connections to the target database; connect to `postgres`, not `wardenx`):
   ```sh
   docker compose --env-file .env.production -f compose.yml exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
     "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'wardenx' AND pid <> pg_backend_pid();" -c \
     "ALTER DATABASE wardenx RENAME TO chartwarden;"
   ```
5. In `.env.production`, together: add `CHARTWARDEN_DB_NAME=chartwarden` (unquoted, no trailing comment, LF line
   endings: `deploy.sh` reads it with a strict `sed` and exits 64 on anything else) and change the database path of every
   whole-URL value (`.../wardenx` -> `.../chartwarden`) such as `DATABASE_URL`, `DATABASE_ADMIN_URL`,
   `DATABASE_PLATFORM_URL`, `DATABASE_DESTRUCTION_URL`, `PROVISION_DATABASE_URL` if present. Compose-built URLs follow
   the variable on their own; whole URLs in the file do not. Check with
   `docker compose --env-file .env.production -f compose.yml config | grep -E '/(wardenx|chartwarden)$'`.
6. `docker compose --env-file .env.production -f compose.yml up -d`, then `./smoke.sh`. Re-enable `deploy.yml`
   only after smoke is green.
7. Update the remaining hardcoded names in a follow-up: `scripts/m36-restore-drill.ts` reads the same variable;
   `docs/architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md` pgbouncer example is illustrative.

Rollback: stop api/worker/web, terminate backends, `ALTER DATABASE chartwarden RENAME TO wardenx;`, restore
`.env.production` from the backup (or remove `CHARTWARDEN_DB_NAME` and revert the URLs), `up -d`, `./smoke.sh`.
If the rename itself failed, nothing changed: just restart the containers. Last resort: restore the Step 0 dump.
