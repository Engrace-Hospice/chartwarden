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

The server must already contain `compose.yml` and a mode-`0600` `.env.production` copied from the
production template. To automate that first-time setup, copy this repository (or just
`deploy/production`) to the VPS and run:

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

The workflow uploads `deploy.sh` for every release, pulls the SHA-pinned images, runs strict
schema-only migrations and runtime-role provisioning, recreates `api`, `worker`, and `web`, then
requires `http://127.0.0.1:3000/ready` to pass. If an image pull, provisioning, or readiness check
fails, it restores the previous image references and recreates those services. Database migrations are
forward-only and are not rolled back.

To roll back application code, run **Release and deploy** manually from the commit to restore (or add a
dedicated rollback workflow that passes the previous immutable image tags); never replace production
image references with `:latest`.
