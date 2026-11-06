# Dockerfile — ChartWarden API + worker runtime image
#
# Two stages: dependencies are installed on the slim (Debian) image, then copied into Bun's distroless image,
# which has no shell, package manager or coreutils. Nothing in production shells into this image (healthchecks
# and deploy.sh one-shots use `bun -e`), and the release scan no longer sees Debian's apt/dpkg/util-linux tree.
# OS patches now arrive by bumping the base tag, not by `apt-get upgrade` at build time.
FROM oven/bun:1.3.5-slim AS deps

WORKDIR /app

# Runtime environment must be established before dependency installation.
ENV NODE_ENV=production

# The complete workspace source is needed because @chartwarden/* workspace
# dependencies are linked from node_modules into workspace packages.
COPY . .

# The runtime only needs declared production dependencies. Bun otherwise auto-installs peer
# dependencies too; Better Auth's optional Drizzle Kit peer pulls in esbuild's Go binary, which is
# neither used nor needed by the API or worker.
RUN bun install \
    --frozen-lockfile \
    --production \
    --omit=peer

FROM oven/bun:1.3.5-distroless

WORKDIR /app

ENV NODE_ENV=production

# uid/gid 1000 (the slim image's `bun` user): compose's rust-sock volume grants group 1000.
COPY --from=deps --chown=1000:1000 /app /app

USER 1000:1000

ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown

ENV APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

EXPOSE 3000 3001

ENV PROCESS_ROLE=api

# The base image's entrypoint is `bun`; clear it so `command: ["bun", ...]` in compose keeps working.
ENTRYPOINT []
CMD ["bun", "run", "apps/backend/src/index.ts"]
