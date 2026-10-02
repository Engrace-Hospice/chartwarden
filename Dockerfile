# Dockerfile — WardenX API + worker runtime image
FROM oven/bun:1.3.5-slim AS base

WORKDIR /app

# Keep the runtime OS current at image-build time.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Runtime environment must be established before dependency installation.
ENV NODE_ENV=production

# The complete workspace source is needed because @wardenx/* workspace
# dependencies are linked from node_modules into workspace packages.
COPY --chown=bun:bun . .

# IMPORTANT:
# Production image must not contain devDependencies such as esbuild.
RUN bun install \
    --frozen-lockfile \
    --production

USER bun

ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown

ENV APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

EXPOSE 3000 3001

ENV PROCESS_ROLE=api

CMD ["bun", "run", "apps/backend/src/index.ts"]