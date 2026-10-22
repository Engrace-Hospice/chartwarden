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

## Merge order for the final-rename PR (DO NOT MERGE before the cutover)

The PR `chore/infra-final-rename` flips every default to `chartwarden`: `/opt/chartwarden` (`deploy.yml`, `reseed-production.yml`,
`deploy.sh`, `smoke.sh`, docs), compose project `chartwarden`, volume prefix default `chartwarden`, MinIO policy default
`chartwarden-app`, `smoke.sh` hosts `app./api.chartwarden.cloud`, and it REMOVES the code that appended `CHARTWARDEN_DB_NAME=wardenx`
to `.env.production`. `main` auto-deploys, so merge it only when the host already matches:

| Merge only after | Why (what breaks if early) |
| --- | --- |
| Step C done: `/opt/chartwarden` exists and holds `.env.production`; `.env.production` has `CHARTWARDEN_VOLUME_PREFIX=wardenx` and `CHARTWARDEN_COMPOSE_PROJECT=chartwarden` | new default dir / project / volume prefix |
| Step E done: database renamed and `CHARTWARDEN_DB_NAME=chartwarden` set in `.env.production` (or, if the rename is deferred, the line stays `CHARTWARDEN_DB_NAME=wardenx`: it is already on the host, so removing the pin code changes nothing) | default DB name is `chartwarden` |
| Step D done: `CHARTWARDEN_SMOKE_APP_URL` / `_API_URL` set in `.env.production` (or the new hosts serve) | `smoke.sh` fallback hosts changed |
| Step B decision: cosign identity and repo-name strings are NOT in this PR (opt-in `CHARTWARDEN_COSIGN_IDENTITY`; the repo name does not exist yet) | unchanged |

Safety net if merged early anyway (nothing is created, nothing is restarted):

1. Workflow step "Preflight deploy directory" (`deploy.yml`, `reseed-production.yml`) runs `test -d $DEPLOY_DIR && test -f
   $DEPLOY_DIR/.env.production` over SSH BEFORE any upload. Missing: the job fails with an error, no file is uploaded.
2. `deploy.sh` PREFLIGHT (exit 67, read-only, before the env file is touched, before any container, image pull or migration):
   - the deploy dir exists (else exit 67);
   - `/opt/wardenx` must not be a live real directory with a `.env.production` while the deploy runs from elsewhere;
   - if ANY `*_postgres-data` volume exists, the configured one (`${CHARTWARDEN_VOLUME_PREFIX:-${CHARTWARDEN_COMPOSE_PROJECT:-chartwarden}}_postgres-data`,
     values from the environment or `.env.production`) must exist, so a missing `CHARTWARDEN_VOLUME_PREFIX=wardenx` cannot create an empty volume;
   - if postgres containers of another compose project exist and none of the configured project does, refuse (no second stack);
   - if a postgres container is running and the configured database is absent while `wardenx` exists, refuse (no empty new database).
   A fresh host (no volumes, no containers) passes. On refusal, fix the host or `.env.production` (the message names the fix) and re-run.
   `reseed-demo.sh` only gets the workflow preflight (it runs against the existing stack and fails on a missing database anyway).
3. Rollback after a merge that went wrong: revert the PR, or set the repository variable `DEPLOY_DIR` back to `/opt/wardenx`
   and keep the host env keys (`CHARTWARDEN_VOLUME_PREFIX`, `CHARTWARDEN_DB_NAME`, `CHARTWARDEN_COMPOSE_PROJECT`) pointing at the live names.

After merging, Step G below is done for everything except the repo-name strings and the cosign default (both wait for Step B).
The legacy-redirect nginx file, the `wardenx-app` MinIO account and the legacy volumes are NOT touched here (Step F).

## Cutover plan (ordered, supersedes the per-phase order below where they differ)

`main` auto-deploys, so the repo ships every renamed identifier behind a variable whose default is the CURRENT live
value. Merging changes nothing on the host; each step below is a manual operator action with its own rollback.
Execute only with the user's go-ahead. Facts observed read-only on 2.25.109.137 on 2026-10-21 are marked (host).

### What is code-safe now (a) and what is gated (b)

| Item | Class | State after merge | Operator action |
| --- | --- | --- | --- |
| GHCR image names, CI container names, `pr-image-gate` tag | (a) | already `chartwarden*` | none |
| Deploy dir in `deploy.sh`/`smoke.sh`/`reseed-demo.sh` | (a) | default = the directory the script sits in (works from both `/opt/wardenx` and `/opt/chartwarden`) | none |
| `deploy.yml` / `reseed-production.yml` upload path | (b) | `vars.DEPLOY_DIR`, falls back to `/opt/wardenx` | set repo variable `DEPLOY_DIR=/opt/chartwarden` in Step C |
| Compose project (containers `<p>-<svc>-1`, networks `<p>_default`, `<p>_scan`) | (b) | `CHARTWARDEN_COMPOSE_PROJECT`, default `wardenx` | set `chartwarden` in `.env.production` in Step C |
| Data volumes | (b) | named explicitly: `${CHARTWARDEN_VOLUME_PREFIX:-<project>}_postgres-data` etc.; resolves to today's `wardenx_*` | set `CHARTWARDEN_VOLUME_PREFIX=wardenx` BEFORE the project flip (keeps the live volumes, no copy) |
| MinIO IAM policy name | (b) | `CHARTWARDEN_MINIO_POLICY`, default `wardenx-app` | set `chartwarden-app` in Step C |
| MinIO app account `MINIO_APP_ACCESS_KEY` | (b) | env value (host: key present) | set `chartwarden-app` in Step C (the secret value is unchanged; `minio-provision` creates the new account) |
| `deploy.sh` `ensure_secret MINIO_APP_ACCESS_KEY` default, `.env.production.example` account names | (a) | `chartwarden-app` / `chartwarden-minio-admin`; only affect hosts where the key is absent | none |
| DB name default (compose, `deploy.sh`, `reseed-demo.sh`) | (a) | default is now `chartwarden`; `deploy.sh`/`reseed-demo.sh` first append `CHARTWARDEN_DB_NAME=wardenx` to an env file that lacks the key (host: key is ABSENT and the cluster holds database `wardenx`) | none until the DB-rename window below, which replaces that line |
| cosign identity | (b) | default = the CURRENT repository identity (`.../chartwarden/...`, since the repo rename) only; `deploy.sh` also checks the certificate's repository claim (`--certificate-github-workflow-repository`); a second identity is an explicit opt-in via `CHARTWARDEN_COSIGN_IDENTITY` (env or `.env.production`) | only needed to roll back to an image signed before the rename (identity `.../wardenx/...`); remove it afterwards |
| nginx vhosts, log format, bootstrap, env template | (a) | files renamed `chartwarden-*`, hostnames `app./api./storage.chartwarden.cloud`; NOT auto-deployed (only `bootstrap-vps.sh` or the operator installs them) | Step D |
| `smoke.sh` probe URLs | (b) | `.env.production` keys `CHARTWARDEN_SMOKE_APP_URL` / `_API_URL`, default the legacy hosts | set both in Step D |
| MinIO audit-webhook target id (`MINIO_AUDIT_WEBHOOK_*_wardenx`), `wardenx-minio-admin` root user | kept | internal ids, never user-visible; changing the env KEY recreates MinIO | leave; optional rename in the follow-up commit, which only takes effect on a MinIO recreate |
| `wardenx-*` bucket ARNs in the policy, old buckets, `wardenx-app` policy/account | held | additive policy still allows both prefixes | Step F, only after the rollback window |
| Repo-name strings (`CLAUDE.md`/`AGENTS.md`, issue-template link, README clone URLs) | follow-up | unchanged (the new repo name does not exist yet) | Step G, a commit AFTER the repo rename |
| cron / systemd / logrotate / pgbackrest / sudoers | n/a | none exist for `wardenx` on the host (host) and none are in the repo | none |

Host facts (host): containers `wardenx-{postgres,valkey,minio,clamav,api,worker,web,docling-worker}-1`; volumes
`wardenx_{postgres,valkey,minio,clamav}-data`; networks `wardenx_default`, `wardenx_scan`; deploy dir `/opt/wardenx`
(owner `deploy`, with `backups/`, `clamav/`, `CREDENTIALS.*.md`); nginx vhosts `/etc/nginx/sites-enabled/wardenx-{frontend,backend,storage}`
(certbot-managed; ONE certificate lineage `wardenx.chartwarden.cloud`, SANs for the three legacy hosts, expires 2027-01-16);
`.env.production` has no `CHARTWARDEN_DB_NAME`, no `COMPOSE_PROJECT_NAME`, has `MINIO_APP_ACCESS_KEY`; Docker Compose v5.5.0.
Drift worth fixing in Step D: the live vhosts have NO `access_log ... phi_safe` line and `nginx -T` shows no `log_format`,
so request URIs (including query strings) go to the default `/var/log/nginx/access.log`.

### Step 0 - Safety net

Run "Step 0" below (pg_dump, pg_dumpall --globals-only, MinIO mirror, env backup). Also record
`docker compose --env-file .env.production -f compose.yml ps` and `docker volume ls`.

### Step A - Merge

Merge deploys normally. Verify afterwards on the host: `grep -c '^CHARTWARDEN_DB_NAME=wardenx$' /opt/wardenx/.env.production`
prints 1 (pinned by the first deploy), `docker ps` still shows the `wardenx-*` containers, the volumes are unchanged.
Downtime: the normal deploy recreate only.

### Step B - GitHub repository rename (Phase 2 below)

After Step A. The cosign identity is the one coupling (see Phase 2): BEFORE renaming, add to `/opt/wardenx/.env.production` the line
`CHARTWARDEN_COSIGN_IDENTITY=https://github.com/Engrace-Hospice/chartwarden/.github/workflows/deploy.yml@refs/heads/main https://github.com/Engrace-Hospice/wardenx/.github/workflows/deploy.yml@refs/heads/main`
(new name first; the old one is only needed while a pre-rename release may still be rolled back to). Rename, deploy once, then land
the Step G commit (default flips to the chartwarden identity) and REMOVE the line from `.env.production`. Do not leave it set:
an identity that is listed is trusted. Security prerequisite: the org must prevent anyone from recreating a repository named
`wardenx` (or any retired name) after the rename; keep the GitHub redirect in place by never creating a repo with the old
name, and restrict repository creation to org owners. Rollback: delete the line, rename the repo back.
Then land the Step G follow-up commit.

### Step C - Host cutover: project, directory, MinIO names (downtime about 2-4 minutes)

PRE-REHEARSAL on the host (Compose v5.5.0; verified only on v5.6.0 locally). Touches nothing of production: unique throwaway
names, own scratch directory, removed afterwards.
```sh
mkdir /tmp/rehearsal && cd /tmp/rehearsal
cat > compose.yml <<'EOF'
name: ${P:-zzrehold}
services:
  a: {image: alpine:3, command: sleep 60, volumes: [d:/d]}
volumes:
  d: {name: "${V:-zzrehold_d}"}
EOF
docker compose up --no-start                      # project zzrehold, creates volume zzrehold_d labelled for it
P=zzrehnew docker compose up --no-start           # flip project, volume name pinned: must succeed and reuse zzrehold_d
docker inspect zzrehnew-a-1 --format '{{range .Mounts}}{{.Name}}{{end}}'    # expect zzrehold_d
P=zzrehnew docker compose down; docker compose down; docker volume rm zzrehold_d; cd / && rm -rf /tmp/rehearsal
```
If the flip errors with a "volume ... was not created by Docker Compose / belongs to project" message, STOP: use `external: true`
volumes or copy the data instead (not covered here). Then dry-run the real file: in a scratch copy of `compose.yml` with the
real env plus the new variables, `docker compose --env-file e -f compose.yml config | grep -E '^name:|    name:'` must show
`name: chartwarden` and volumes `wardenx_*`.

1. Disable `deploy.yml` and `reseed-production.yml` (Actions UI) and make sure none is running.
2. On the host as `deploy`:
   ```sh
   cd /opt/wardenx
   cp .env.production ~/.env.production.pre-infra-cutover && chmod 600 ~/.env.production.pre-infra-cutover
   docker compose --env-file .env.production -f compose.yml down          # NEVER -v: the named volumes hold all data
   docker volume ls | grep wardenx_                                       # all four still listed
   sudo mv /opt/wardenx /opt/chartwarden && sudo ln -s /opt/chartwarden /opt/wardenx
   cd /opt/chartwarden
   printf '%s\n' 'CHARTWARDEN_VOLUME_PREFIX=wardenx' 'CHARTWARDEN_COMPOSE_PROJECT=chartwarden' \
     'CHARTWARDEN_MINIO_POLICY=chartwarden-app' >> .env.production
   sed -i 's/^MINIO_APP_ACCESS_KEY=.*/MINIO_APP_ACCESS_KEY=chartwarden-app/' .env.production
   docker compose --env-file .env.production -f compose.yml config | grep -E '^name:|    name:'
   #   expect: name: chartwarden, chartwarden_default, chartwarden_scan, volumes wardenx_*-data
   docker compose --env-file .env.production -f compose.yml up -d --no-deps postgres valkey minio clamav
   docker compose --env-file .env.production -f compose.yml run --rm minio-provision   # creates policy chartwarden-app + account
   docker compose --env-file .env.production -f compose.yml up -d --no-deps api worker web docling-worker
   ./smoke.sh
   docker inspect chartwarden-postgres-1 --format '{{range .Mounts}}{{.Name}} {{end}}'   # expect wardenx_postgres-data
   ```
3. In the repo settings set the Actions variable `DEPLOY_DIR=/opt/chartwarden`, then re-enable the workflows and run
   one deploy (or the reseed `inventory` mode) to prove the new path.
4. Keep `/opt/wardenx` (symlink) until one deploy and one reseed have used the new path.

Rollback (any point before step 3): `cd /opt/chartwarden && docker compose --env-file .env.production -f compose.yml down`;
`cp ~/.env.production.pre-infra-cutover .env.production`; `sudo rm /opt/wardenx && sudo mv /opt/chartwarden /opt/wardenx`;
`cd /opt/wardenx && docker compose --env-file .env.production -f compose.yml up -d`; `./smoke.sh`; unset the `DEPLOY_DIR`
variable. The old `wardenx-app` policy and account were never removed, so the restored env authenticates unchanged.

### Step D - Hostnames (no downtime; dual-host, then redirect)

Canonical names proposed (change the three strings and the nginx files if the user prefers others): web
`app.chartwarden.cloud`, api `api.chartwarden.cloud`, storage `storage.chartwarden.cloud`. These sit on the demo
domain (ADR-0088: demo stays `chartwarden.cloud`, single-host, `TENANT_BASE_DOMAIN` unset). The `*.chartwarden.com`
wildcard and `admin.`/`app.` hosts of the real environment belong to that separate deployment and its own manifests;
nothing on this host changes for them.

1. DNS (operator): A/AAAA for the three new names to `2.25.109.137`, TTL 300. Keep the old records.
2. nginx on the host (as root), keeping a backup of the old vhosts:
   ```sh
   # from a workstation first: scp -r deploy/production/nginx root@2.25.109.137:/root/nginx-chartwarden
   cp -a /etc/nginx/sites-available /root/nginx-sites-available.pre-infra-cutover
   cd /root/nginx-chartwarden
   install -m 0644 chartwarden-log-format.conf /etc/nginx/conf.d/chartwarden-log-format.conf
   for n in frontend backend storage; do
     install -m 0644 chartwarden-$n.conf /etc/nginx/sites-available/chartwarden-$n.conf
     ln -sfn /etc/nginx/sites-available/chartwarden-$n.conf /etc/nginx/sites-enabled/chartwarden-$n.conf
   done
   nginx -t && systemctl reload nginx
   certbot --nginx -d app.chartwarden.cloud -d api.chartwarden.cloud -d storage.chartwarden.cloud --cert-name chartwarden.cloud
   nginx -t && systemctl reload nginx && certbot renew --dry-run
   ```
   (The legacy vhosts keep serving; the old certificate lineage stays.) This also installs the PHI-safe access-log
   format the live vhosts lack; confirm with `curl -s "https://api.chartwarden.cloud/ready?q=Smith"` and a log line without `?q=`.
3. PRE-FLIP CHECK (before touching `PASSKEY_RP_ID`): every operator/admin account must have a sign-in path that does not need a
   passkey, i.e. a working password plus TOTP, or a platform-admin reset you have verified. Test one real sign-in per operator
   without the passkey first. Rollback for access loss is env-only: set `PASSKEY_RP_ID` / `WEBAUTHN_RP_ID` back to
   `wardenx.chartwarden.cloud` and recreate api/worker/web; the old passkeys work again as long as the old host still serves
   the web app (so do this BEFORE the Step 4 redirect swap, or serve the old host again).
   Env flip in `.env.production`, together, then `docker compose ... up -d --no-deps --force-recreate api worker web`:
   `BETTER_AUTH_URL=https://api.chartwarden.cloud`, `TRUSTED_ORIGINS=https://app.chartwarden.cloud` (add the old origin as a
   second comma-separated entry during the transition if links are still in flight), `STORAGE_PUBLIC_ORIGIN=https://storage.chartwarden.cloud`,
   `M34_INVITATION_ACCEPT_URL=https://app.chartwarden.cloud/tenant-invite`, `FHIR_TOKEN_ENDPOINT_URL=https://api.chartwarden.cloud/fhir/oauth2/token`,
   `PASSKEY_RP_ID` and `WEBAUTHN_RP_ID` = `app.chartwarden.cloud` (ALL existing passkeys stop working, no RP id value
   preserves them; see the Phase 5 warning), and `CHARTWARDEN_SMOKE_APP_URL=https://app.chartwarden.cloud`,
   `CHARTWARDEN_SMOKE_API_URL=https://api.chartwarden.cloud`. List every other occurrence first:
   `grep -n 'wardenx.chartwarden.cloud' .env.production`. Then `./smoke.sh`, log in, upload and download a document.
4. After a successful session, swap the three old vhosts for `nginx/chartwarden-legacy-redirects.conf` (308 to the new hosts,
   uses the old certificate): remove `sites-enabled/wardenx-*`, install that file, `nginx -t && systemctl reload nginx`,
   `curl -sI https://wardenx.chartwarden.cloud/` shows `308` to `app.chartwarden.cloud`. Notify any FHIR/HL7 partner and
   mobile build that holds the old base URL before this step. Then `certbot renew --dry-run`: the redirect vhosts keep using the
   legacy lineage `wardenx.chartwarden.cloud` (expires 2027-01-16), whose renewal needs the old names to keep resolving to this
   host and port 80 to answer the ACME challenge (the redirect file's `listen 80` blocks 308 everything, so certbot's
   `--nginx` authenticator injects its challenge location; confirm the dry run passes). If you retire the old DNS names before
   the redirects are retired, the legacy certificate will fail to renew and the redirects will break TLS at expiry.

Rollback: restore `~/.env.production.pre-infra-cutover` values for the keys above, `up -d --force-recreate api worker web`, and
re-link the old vhosts from `/root/nginx-sites-available.pre-infra-cutover`. Old DNS records and certificate are never removed
by this step. Retire the redirects, the old DNS names and the old certificate (`certbot delete --cert-name wardenx.chartwarden.cloud`)
no earlier than 30 days later.

### Step E - Database rename

Separate window, see "Database rename downtime window" at the end. Note: `deploy.sh` has by then appended
`CHARTWARDEN_DB_NAME=wardenx` to `.env.production`, so step 5 there means REPLACE that line (a second line would also work
because the last one wins, but keep one).

### Step F - Late cleanup (held until the rollback window closes; one clearly separate change)

- Bucket step 3: drop the `wardenx-*` ARNs from the policy in `compose.yml`, deploy, then on the host
  `mc admin policy detach local wardenx-app --user wardenx-app`, `mc admin user rm local wardenx-app`,
  `mc admin policy rm local wardenx-app`; mirror/remove the legacy buckets per Phase 3.
- Remove the `/opt/wardenx` symlink, the legacy redirects/DNS/certificate (Step D), the `wardenx-*` GHCR packages,
  `_wardenx_migration` view (other owner).

### Step G - Follow-up commit AFTER Step B/C/D (not part of the merge that ships the gates)

Each edit flips a default that is only safe once the host matches. All are mechanical:

- `compose.yml`: `CHARTWARDEN_COMPOSE_PROJECT:-wardenx` -> `chartwarden` (twice: `name:` and the volume prefix default; the
  host keeps `CHARTWARDEN_VOLUME_PREFIX=wardenx` in its env), `CHARTWARDEN_MINIO_POLICY:-wardenx-app` -> `chartwarden-app`.
- `smoke.sh`: legacy URL fallbacks -> `https://app.chartwarden.cloud` / `https://api.chartwarden.cloud`.
- `.github/workflows/deploy.yml`, `reseed-production.yml`: `'/opt/wardenx'` fallback -> `'/opt/chartwarden'` (then the variable can be deleted).
- Repo-name strings after Step B: `CLAUDE.md` and `AGENTS.md` (copy verbatim) line "Issue tracker: ... `Engrace-Hospice/wardenx`", `.github/ISSUE_TEMPLATE/config.yml`
  line 4 (the `blob/develop` link), `deploy/production/README.md` rollback image examples, `docs/START_PROJECT.md` clone URLs,
  `docs/architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md` cosign identities. Leave `fabwebdev/wardenx` (a different, pre-migration
  repository) and dated history/audit documents alone. Flip the `deploy.sh` default identity to `.../chartwarden/...` here, then delete `CHARTWARDEN_COSIGN_IDENTITY` from the host's `.env.production`
  (a rollback to a pre-rename release needs the old identity re-added as a one-off, then removed).
- Optionally the MinIO audit-webhook suffix and root user (see table); only together with a planned MinIO recreate.

The numbered Phases below are the detailed reference for each area; where they disagree with the plan above, the plan above wins.

## Phase 2 - GitHub repo rename `Engrace-Hospice/wardenx` -> `Engrace-Hospice/chartwarden`

Downtime: none for the running app. CI is unusable between the rename and the identity change (below),
so do not merge to `main` during the window.

Preconditions: no deploy running; no open release; org-owner rights; `gh auth status` ok.

Important coupling: the cosign certificate identity embeds `<owner>/<repo>`. Signatures made BEFORE the
rename carry `.../Engrace-Hospice/wardenx/...`; signatures made AFTER carry `.../chartwarden/...`.
`deploy.sh` trusts only the identities in `CHARTWARDEN_COSIGN_IDENTITY` (env or `.env.production`), default the current
`.../wardenx/...` one only, and also checks the certificate's repository claim. So:

1. BEFORE the rename: set `CHARTWARDEN_COSIGN_IDENTITY` in `.env.production` to both identities (Step B above).
2. Rename (GitHub keeps web + git redirects, but NOT Actions OIDC claims):
   `gh api -X PATCH repos/Engrace-Hospice/wardenx -f name=chartwarden`
3. Update local remotes everywhere: `git remote set-url origin git@github.com:Engrace-Hospice/chartwarden.git`.
4. The first release after the rename signs with the new identity (accepted through the opt-in above). Merge the Step G
   commit that flips the default as the FIRST commit after the rename and then delete the env line; the release job's own `cosign verify` uses `${GITHUB_REPOSITORY}`
   and needs no edit. The VPS `deploy.sh` is re-uploaded on every deploy, so no VPS edit is needed.
   If you deploy after the rename without the opt-in from step 1, `deploy.sh` rejects the new signatures and restores the
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
NOT touched. Cut over (mirror, then deploy the code switch) in a short write freeze (stop `worker`) or accept re-running the sync.

Bucket inventory (code/config references):

| Bucket | Where it is referenced |
| --- | --- |
| `chartwarden-platform-terminology` (was `wardenx-platform-terminology`; code switched in step 2) | `apps/backend/src/modules/38-terminology/jobs/platform-objects.ts` (`DEFAULT_PLATFORM_BUCKET`, overridable via env `TERMINOLOGY_PLATFORM_BUCKET`); `apps/backend/src/index.ts` (`TERMINOLOGY_PLATFORM_BUCKET`, ~3986); `apps/backend/src/modules/22-documents/access-log/minio-access-log.test.ts` |
| `chartwarden-readiness` (was `wardenx-readiness`; code switched in step 2) | `apps/backend/src/index.ts` (`READINESS_PROBE_BUCKET`) |
| `wardenx-*` IAM scope | REMOVED in step 3 (`compose.yml` minio-provision policy now allows `tenant-*` and `chartwarden-*` only) |
| Policy / account names | `wardenx-app` (policy and `MINIO_APP_ACCESS_KEY` default in `deploy.sh` and `.env.production.example`), `wardenx-minio-admin` (root user) |
| Audit webhook target id | `compose.yml` `MINIO_AUDIT_WEBHOOK_*_wardenx` (suffix is the target name) |
| Docs | `deploy/production/README.md`, `docs/` (other owner) |

Order of the bucket change (production holds only `tenant-*` buckets today; neither `wardenx-platform-terminology` nor
`wardenx-readiness` exists on disk, so no data copy is needed unless a terminology release has been uploaded since):
1. Policy PR (additive, done first): the `wardenx-app` policy in `compose.yml` also allows `chartwarden-*` (done; after step 3 the
   policy holds only `tenant-*` and `chartwarden-*`, confirm with `mc admin policy info local wardenx-app`).
2. DONE (code PR, after step 1 was live): `DEFAULT_PLATFORM_BUCKET` / `READINESS_PROBE_BUCKET` switched to the new names.
   Neither creates a bucket: the readiness probe treats 404 (missing bucket) as healthy; the terminology store fails on a
   missing bucket, so `chartwarden-platform-terminology` is a MANUAL prerequisite: nothing creates it (not minio-provision),
   run `mc mb local/chartwarden-platform-terminology` before the first terminology upload/read.
   A deployment already holding releases in the old bucket MUST mirror them (procedure below); after step 3 the old bucket
   cannot be used as a fallback (see the step 3 note).
3. DONE (cleanup PR): the `wardenx-*` ARNs were dropped from the policy (kept: `tenant-*`, `chartwarden-*`; the readiness
   probe's `s3:ListBucket` on `chartwarden-readiness` is covered by `chartwarden-*`). Verified read-only on production first:
   `/data` held only `tenant-*` buckets, no `wardenx-*` on disk or in `.minio.sys/buckets`, no `TERMINOLOGY_PLATFORM_BUCKET`
   override in `.env.production`, no old-name references in api logs. Rollback: re-add `"arn:aws:s3:::wardenx-*"` /
   `"arn:aws:s3:::wardenx-*/*"` to the two `Resource` arrays in `compose.yml` and redeploy (policy is re-applied each deploy).
   Renaming the policy/account (`wardenx-app`) is left to the infra rename and is not part of this step.

The copy procedure below is only for a deployment that still holds data in `wardenx-platform-terminology` (production does
not); run it with the MinIO root `mc` alias. The app account no longer has access to `wardenx-*`, so
`TERMINOLOGY_PLATFORM_BUCKET=wardenx-platform-terminology` is no longer a working fallback.

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
# 5. Switch: the code already uses the new names (step 2) and the policy already allows them; re-run the mirror once more, then smoke
```

Verification: terminology release job reads/writes the new bucket; `GET /api/ready` (readiness probe)
healthy; MinIO audit webhook still posts to `/api/v1/webhooks/minio/access-log` for the new bucket
(`mc admin config get local audit_webhook`; the webhook target is server-wide, buckets need no per-bucket
hook). Keep the old buckets read-only for at least one release cycle; delete only after the operator
confirms (`mc rb --force local/wardenx-platform-terminology`). Rollback: revert the code change AND re-add the
`wardenx-*` policy ARNs (step 3 rollback above), otherwise the app cannot reach the old buckets; old buckets are untouched. Renaming the policy `wardenx-app` or the webhook target suffix is optional and
restarts/reconfigures MinIO (brief downtime); do it last, or leave as-is (internal names, never user-facing).

## Phase 4 - VPS directory `/opt/wardenx` -> `/opt/chartwarden`

Downtime: about one `docker compose up` cycle (30-120 s) if you move the directory while containers run
with bind mounts (`/opt/wardenx/clamav/clamd.conf`). The ordered procedure is Step C above; this section is the reference.

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
Compose caveat: the project name (`CHARTWARDEN_COMPOSE_PROJECT`, default `wardenx`) drives container and network names.
The data volumes are pinned by explicit `name:` (`CHARTWARDEN_VOLUME_PREFIX`), so flipping the project to `chartwarden`
while `CHARTWARDEN_VOLUME_PREFIX=wardenx` keeps the existing `wardenx_*` volumes: no copy. Flipping the project WITHOUT
setting the prefix first would create new, empty `chartwarden_*` volumes and orphan the data, so the prefix goes first (Step C).
Rollback: `sudo rm /opt/wardenx && sudo mv /opt/chartwarden /opt/wardenx`, `up -d`.

## Phase 5 - Hostnames, DNS, TLS, nginx

Current hosts: `wardenx.chartwarden.cloud` (web), `be082026.wardenx.chartwarden.cloud` (api),
`storage.wardenx.chartwarden.cloud` (S3). Target names are the operator's choice (for example
`app.chartwarden.cloud`); the host list below is parameterised.

Downtime: none if the old hosts keep serving until cutover (dual-host). Users are logged out and passkeys
break unless handled, see the warnings.

WARNINGS (not reversible by DNS alone):

- `PASSKEY_RP_ID` / `WEBAUTHN_RP_ID` (`.env.production`): a WebAuthn credential is bound to the exact RP id it was
  registered under (today `wardenx.chartwarden.cloud`). A browser only accepts an RP id that is a registrable suffix of the
  page's domain, and `wardenx.chartwarden.cloud` is not a suffix of `app.chartwarden.cloud`, so NO RP id value carries the
  existing passkeys to the new host (a parent-domain id such as `chartwarden.cloud` is valid for the new host but is a
  different id from the registered one, so those credentials still fail). Every existing passkey must be re-enrolled; the
  only way to keep them is to keep serving the web app on the old host. Run the pre-flip check in Step D.3.
- `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `STORAGE_PUBLIC_ORIGIN`, `M34_INVITATION_ACCEPT_URL`,
  `FHIR_TOKEN_ENDPOINT_URL`, `CORS` lists: changing the origin invalidates cookies scoped to the old host
  (sessions) and presigned URLs. Mobile deep link `wardenx://` and wire names are a different owner.

Procedure:

1. DNS: add A/AAAA records for the new hosts to `2.25.109.137` (TTL 300). Keep the old records.
2. TLS: `sudo certbot certonly --nginx -d <new-web> -d <new-api> -d <new-storage>` (or add SANs to the
   existing certificate with `--expand`). Confirm `certbot renew --dry-run`.
3. nginx: `bootstrap-vps.sh` installs `nginx/chartwarden-*.conf` to `/etc/nginx/sites-available/` and the
   `chartwarden_phi_safe` log format (the procedure that actually applies is Step D). Add the new hosts as additional `server_name` values (or run
   `FRONTEND_DOMAIN=... BACKEND_DOMAIN=... STORAGE_DOMAIN=... sudo ./bootstrap-vps.sh`, which sed-rewrites the
   hostnames), `nginx -t && systemctl reload nginx`. The repo files and format are already renamed; if you rename a live vhost,
   change the file, the `ln -sfn`, the `access_log` path and the format name together, `nginx -T | grep phi_safe`, and keep log rotation (`logrotate`) and any log shipper in sync.
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

- Postgres database name `wardenx` (parameterized by `CHARTWARDEN_DB_NAME`; the compose/script default is now `chartwarden`, and the host's `.env.production` carries the explicit value; the former pin code in `deploy.sh`/`reseed-demo.sh` is gone, replaced by the PREFLIGHT in "Merge order"), applied migration SQL, legacy function names
  (renaming a database requires dropping connections and updating every `DATABASE_*_URL`; applied-migration
  checksums forbid editing SQL). The `wardenx_destruction` role alias was dropped by migration 1142.
- The `_wardenx_migration` ledger IS renamed to `_chartwarden_migration` (by `scripts/db/migrate.ts`
  `ensureLedger`). The `_wardenx_migration` compat view is gone: `ensureLedger` drops it if present (only ever a
  view, never a table); the one-time table rename remains for a database that still has the legacy table.
  A rollback to a pre-#545 image must skip its migration step: that runner's `CREATE TABLE IF NOT EXISTS
  _wardenx_migration` would now create an EMPTY legacy table and try to replay the chain. If it ran, stop and
  drop the empty `_wardenx_migration` table it created before running the new runner again (otherwise the new
  runner throws "both are tables"). Migrations 1139/1142/1143 already make app-level rollback of that age
  unsupported.
- The `wardenx_*` data VOLUME names: the project/containers/networks are renamed (Step C), the volumes keep their names via `CHARTWARDEN_VOLUME_PREFIX=wardenx` (a copy would add downtime for no benefit; internal names only).
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

<!-- BEGIN DB-RENAME ADDENDUM (owner: refactor/rename-db-name-dev-items; the infra agent need not edit between these markers) -->
## Database rename: ordered procedure and what changes at the same moment

This addendum supersedes the shorter "Database rename downtime window" section above wherever they differ
(that section's "default `wardenx`", "Until the flip, behaviour is unchanged" and the rollback wording "or remove
`CHARTWARDEN_DB_NAME`" are stale once the infra branch has flipped the defaults; see the end of this addendum).

State of the code: every NON-production default is already `chartwarden` (root `docker-compose.yml`,
`.env.example`, `drizzle.config.ts`, `scripts/db/wait-for-postgres.ts`, `scripts/m36-restore-drill.ts`, CI
databases). For `deploy/production/**` there are two possible states, depending on whether the infra branch
(`refactor/rename-infra-wardenx`) has been merged:

- **Infra NOT merged:** `compose.yml`, `deploy.sh` and `reseed-demo.sh` still default to `wardenx`; production keeps
  working with no `CHARTWARDEN_DB_NAME`.
- **Infra merged:** those three default to `chartwarden`, and `deploy.sh` APPENDS `CHARTWARDEN_DB_NAME=wardenx` to
  `.env.production` when the key is absent (the pin). From then on ONLY that pin keeps production on the existing
  `wardenx` database. Do not remove it except as part of step 5 below.

Downtime ~5-10 min. Run only with the user's go-ahead.

1. Step 0 safety net: `pg_dump -d wardenx`, `pg_dumpall --globals-only`, MinIO mirror, copy of `.env.production`.
2. DISABLE `deploy.yml` and `reseed-production.yml` in the Actions UI, and hold merges to `main`. This is mandatory,
   not tidiness: any `deploy.sh` run during the window sees the key absent or still `wardenx` and re-pins/starts
   against `wardenx`, undoing or racing the rename.
3. Stop `api`, `worker`, `web` and any `seed-api` / `docling-worker` / `provision-gateway` containers. Check
   `SELECT pid, usename, application_name FROM pg_stat_activity WHERE datname = 'wardenx';` is empty.
4. Connect to the `postgres` maintenance DB (not `wardenx`), `pg_terminate_backend` leftovers, then
   `ALTER DATABASE wardenx RENAME TO chartwarden;` (fails and changes nothing if a connection remains).
5. In `.env.production`, in the same minute: SET OR REPLACE the single existing `CHARTWARDEN_DB_NAME` line so it
   reads `CHARTWARDEN_DB_NAME=chartwarden` (unquoted, no trailing comment, LF endings). Never add a second line:
   `deploy.sh` reads it with `sed -n ... | tail -n 1` and compose takes one value. If the key is absent (infra not yet
   merged), add it. Also change `/wardenx` to `/chartwarden` in every whole `DATABASE_*_URL` and
   `PROVISION_DATABASE_URL` value. Verify: `grep -c '^CHARTWARDEN_DB_NAME=' .env.production` prints 1 and
   `docker compose --env-file .env.production -f compose.yml config | grep -E '/(wardenx|chartwarden)$'` shows
   only `chartwarden`.
6. `docker compose ... up -d`, then `./smoke.sh`. Re-enable the workflows only after smoke is green.
7. Defaults in `deploy/production/**`, conditional on the infra merge state:
   - Infra already merged: `compose.yml`, `deploy.sh` and `reseed-demo.sh` already default to `chartwarden`, and the
     pin is now the explicit `chartwarden` value from step 5. Nothing to flip.
   - Infra not merged: after smoke is green and one good deploy, flip these (by content, not line number): every
     `${CHARTWARDEN_DB_NAME:-wardenx}` in `compose.yml` to `:-chartwarden`; the `db_name=${db_name:-wardenx}` default
     and its comment in `deploy.sh`; the same default in `reseed-demo.sh`; the `README.md` sentence saying the database
     name `wardenx` is unchanged. Do NOT flip before step 5: with the variable unset, compose would then point at a
     database that does not exist yet.

Facts to carry into the window:

- The `_wardenx_migration` view and the `_chartwarden_migration` ledger live INSIDE the database, so they travel
  with `ALTER DATABASE ... RENAME`. `scripts/db/migrate.ts` is unchanged by this PR (the compat view stays for
  rollback of the previous release's runner; drop it in a later cleanup).
- Roles are cluster-global and already `chartwarden_*` (migration 1139); the rename touches no roles, grants, RLS
  policies or the `app.org_id` GUC. Production role passwords are unchanged (the dev password rename applies to the
  local compose stack only).
- pgBackRest is cluster-level, has no database name in `ops/pgbackrest/pgbackrest.conf.template`, and its stanza is
  already `chartwarden_*`. Take a fresh full backup after the rename anyway. Logical dumps restore into a database of
  any name; the m36 restore drill reads `CHARTWARDEN_DB_NAME` (default now `chartwarden`).
- `ALTER DATABASE ... SET` settings move with the database. External monitors naming the database (postgres_exporter
  DSN, Grafana data source, a pgbouncer `[databases]` section) are not in this repo: update them in the same minute.

Rollback (any point up to step 6): keep the workflows disabled, stop api/worker/web, terminate backends,
`ALTER DATABASE chartwarden RENAME TO wardenx;`, then SET `CHARTWARDEN_DB_NAME=wardenx` in `.env.production`
(restoring the step-0 copy also works). Never remove the key once the infra defaults are merged: `deploy.sh` would
then default to `chartwarden`. Then `up -d`, `./smoke.sh`. If the rename itself failed nothing changed: just restart
the containers. Last resort: restore the step-0 dump into a fresh `wardenx` database.

Verification after step 6: `psql -U postgres -d postgres -c '\l'` lists `chartwarden` and not `wardenx`;
`SELECT count(*) FROM _chartwarden_migration;` equals the pre-window count; `/api/health` and `/api/ready` green;
one demo sign-in.
<!-- END DB-RENAME ADDENDUM -->
