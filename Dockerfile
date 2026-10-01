# Dockerfile — WardenX API + worker runtime image (TASK-040F, production-readiness audit
# 2026-08-03, OPS-002/OPS-003).
#
# SCAFFOLD, NOT AN EXERCISED PRODUCTION IMAGE (see docker-compose.yml and
# .github/workflows/deploy.yml for the same caveat) — this builds and boots correctly under
# `docker compose up`, but no real cloud target has validated it under load, behind a real load
# balancer, or through the blue-green rollout WARDENX_OPS_RUNBOOK_v0.1.md describes aspirationally.
#
# ONE image, TWO roles: `bootWardenX(role)` (apps/backend/src/index.ts, TASK-040A) is the single
# composition root — the API and worker processes are the SAME source tree, differing only in
# which entrypoint file runs (index.ts vs worker.ts) and which env vars are set (PROCESS_ROLE/PORT
# vs WORKER_PORT). docker-compose.yml's `api`/`worker` services both build THIS image and override
# `command`/env — there is no separate worker image to keep in sync.
#
# Bun runs TypeScript directly (no compile/bundle step for the backend — see
# apps/backend/package.json's `start` script), so this is genuinely a two-step image: install deps,
# then run from source. Workspace deps (`@wardenx/*`) resolve as node_modules SYMLINKS at install
# time (Bun/npm/pnpm workspace convention), which means the full monorepo source must be present
# when `bun install` runs, not just apps/backend — see .dockerignore for what's excluded (build
# artifacts, docs, VCS, editor/AI tool state — never a workspace package itself).
FROM oven/bun:1.3.5-slim AS base
WORKDIR /app

# Refresh OS packages (fixes the util-linux/bsdutils findings, which all have fixes)
ARG OS_REFRESH=none
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Manifest-first layer caching would normally COPY every workspace package.json individually before
# the full source; with 48 packages + 4 apps (architecture/module-manifest.ts) that COPY list would
# silently drift out of sync as new modules are scaffolded. Trading some cache granularity for a
# COPY that can never go stale: bring in the whole context (respecting .dockerignore) in one layer,
# then install once.
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile

USER bun
ENV NODE_ENV=production

# AD-05 — the /version probe (bootstrap/routes/health.ts) reads APP_VERSION / GIT_SHA / BUILD_TIME.
# Nothing set them, so /version always answered {"version":"dev","gitSha":"unknown"} and the
# runbook's post-deploy "confirm the new SHA is live" check could never pass. deploy.yml injects
# these as build args; a plain local `docker build` still gets the honest "dev"/"unknown" defaults.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME
# 3000 = API (PORT default, apps/backend/src/index.ts); 3001 = worker (WORKER_PORT default,
# health/ready-only — TASK-040A). Both exposed since either role can run from this one image.
EXPOSE 3000 3001

# Default role is the API; docker-compose.yml's `worker` service overrides `command` (worker.ts)
# and PORT/PROCESS_ROLE env — see the file header.
ENV PROCESS_ROLE=api
CMD ["bun", "run", "apps/backend/src/index.ts"]
