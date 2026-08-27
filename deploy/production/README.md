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

To roll back application code, run **Release and deploy** manually from the commit to restore (or add a
dedicated rollback workflow that passes the previous immutable image tags); never replace production
image references with `:latest`.
