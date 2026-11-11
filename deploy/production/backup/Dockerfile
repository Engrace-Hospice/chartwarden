# deploy/production/backup/Dockerfile — the production Postgres image plus the backup toolchain (#857).
#
# One image serves three roles so every pgBackRest invocation runs the same version against the same PGDATA layout:
#   - the `postgres` service (compose.backup.yml): archive_command = pgbackrest archive-push (WAL archiving / PITR)
#   - the `backup` sidecar: the scheduled coordinated snapshot (cw-backup.sh schedule)
#   - restore.sh: pgbackrest restore into an isolated volume, then a throwaway Postgres on it
#
# The runtime base is POSTGRES_IMAGE: ChartWarden's Wolfi Postgres (deploy/production/postgres/Dockerfile), by default
# the published, signed digest compose.yml pins, so the server running under the overlay is that image plus the tooling
# below. Pulling it from GHCR needs `docker login ghcr.io` on the host (the repository is private). To test the working
# tree instead, build the Postgres image locally and override the argument:
#   docker build -t chartwarden-postgres:drill deploy/production/postgres
#   docker build --build-arg POSTGRES_IMAGE=chartwarden-postgres:drill -t chartwarden-backup:local deploy/production/backup
# Bump POSTGRES_IMAGE together with compose.yml's pin, and keep the build stage's base digest and libpq/dev pins equal
# to the postgres Dockerfile's (pgBackRest links libpq, and glibc must be the one the cluster's indexes were built with).
#
# pgBackRest has no Wolfi package (Debian's PGDG repository went with the Debian base), so it is built from source:
# the build stage clones the release tag, asserts the commit the tag resolves to (a moved or re-tagged ref fails the
# build) and compiles with meson. Only the binary reaches the runtime image, next to the runtime libraries it links
# (the final RUN executes `pgbackrest version`, which the loader refuses to start with a missing library). SFTP
# (libssh2) is left out: the repositories are local disk and S3. OpenSSL 4.0 is what postgresql-18-dev requires, so
# pgBackRest runs on it while libpq keeps the base image's 3.x; the two coexist in one process because OpenSSL 4
# exports only OPENSSL_4.0.0 symbol versions. Bump deliberately: new tag plus its commit SHA, then re-run
# `bun run backup:coordinated-drill`: it builds this image and is the drill that proves it (`backup:restore-drill`
# runs the host's pgbackrest and says nothing about the image). arch:compose-policy keeps POSTGRES_IMAGE, every build
# stage's base digest and PG_VERSION equal to compose.yml's pin and the postgres Dockerfile's.
# `mc` is built here too (stage mc-build): minio/mc is archived and no longer publishes images, and Chainguard's
# build (commit 7394ce0d) carries golang.org/x/net v0.60.0 (CVE-2026-78661, HIGH). The stage builds that same commit
# with the dependency versions Chainguard ships (`go version -m` of /usr/bin/mc in cgr.dev/chainguard/minio-client@
# sha256:10388d58..., 2026-11-08) plus x/net 0.62.0, recorded in mc/go.mod + go.sum. When the PR image
# gate flags mc: bump the module (`go get <mod>@<fixed> && go mod tidy` in a checkout of MC_COMMIT, copy go.mod/go.sum
# back) or, for a Go stdlib CVE, the go-1.27 apk pin.
ARG POSTGRES_IMAGE=ghcr.io/engrace-hospice/chartwarden-postgres:18-sha-2ea20d5c0bf340d3f93c1d6fcd715a3027354793@sha256:b325d5fd8f295ef1aaed77508f808fcbd573787ff0469de6126fdff4ae261636

FROM cgr.dev/chainguard/wolfi-base@sha256:8509ee4351a2e501b7f98201f2e2642396e82020c61a589cacdcfe74b9de46c1 AS pgbackrest-build
ARG PGBACKREST_REF=release/2.60.0
ARG PGBACKREST_COMMIT=2e1c4f2ba727c45a0a23d4b326905088dc15b1a1
ARG PG_VERSION=18.6-r7
# Every package is pinned like the postgres Dockerfile's (its bump note applies: `apk add -s <pkgs>` in the base shows
# what resolves). ninja, meson and python3 are provides, not packages (samurai provides `ninja=1.9.0`, so a version
# pin on the provide never matches): the pins name the real packages.
RUN apk add --no-cache \
      build-base=1-r10 samurai=1.3-r3 py3.13-meson-bin=1.12.1-r0 git=2.56.0-r3 pkgconf=3.0.10-r2 \
      python-3.13=3.13.18_git20261030-r0 py3.13-pyyaml=6.0.3-r8 \
      "postgresql-18-dev=${PG_VERSION}" "libpq-18=${PG_VERSION}" \
      openssl-4.0-dev=4.0.3-r8 lz4-dev=1.11.0-r0 zstd-dev=1.5.7-r13 bzip2-dev=1.0.8-r30 \
      libxml2-dev=2.15.4-r2 zlib-dev=1.3.2.1_rc20260921-r2
RUN git clone -q --depth 1 --branch "$PGBACKREST_REF" https://github.com/pgbackrest/pgbackrest.git /src \
 && [ "$(git -C /src rev-parse HEAD)" = "$PGBACKREST_COMMIT" ] \
 && meson setup /build /src --buildtype=release \
 && ninja -C /build \
 && /build/src/pgbackrest version

FROM cgr.dev/chainguard/wolfi-base@sha256:8509ee4351a2e501b7f98201f2e2642396e82020c61a589cacdcfe74b9de46c1 AS mc-build
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
# mc/go.mod and mc/go.sum replace upstream's: the whole module graph is committed and the build is -mod=readonly, so a
# rebuild links exactly the versions the PR scan approved. GOTOOLCHAIN=local: never download a toolchain.
ENV GOTOOLCHAIN=local CGO_ENABLED=0
RUN apk add --no-cache go-1.27=1.27.3-r0 git=2.56.0-r3
COPY mc/go.mod mc/go.sum /tmp/mc-mod/
RUN git init -q /mc && cd /mc && git remote add origin https://github.com/minio/mc.git \
 && git fetch -q --depth 1 origin "$MC_COMMIT" && git checkout -q FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$MC_COMMIT" ] \
 && cp /tmp/mc-mod/go.mod /tmp/mc-mod/go.sum . \
 && go build -mod=readonly -trimpath -o /out/mc \
      -ldflags "-s -w -X github.com/minio/mc/cmd.ReleaseTag=$MC_RELEASE -X github.com/minio/mc/cmd.CommitID=$MC_COMMIT" . \
 && /out/mc --version

FROM ${POSTGRES_IMAGE}
ARG GLIBC_VERSION=2.44
# bash, coreutils, jq and curl are what cw-backup.sh and restore.sh call; the libraries are pgBackRest's own links.
# coreutils' applets shadow busybox's, so `date -u +%-H`, `stat -c`, `timeout`, `base64 -d` are the GNU ones.
# Pinned: bash, libzstd1, libxml2 and openssl-4.0-libssl are already in the Postgres image (the pin is that image's
# own version, a no-op); a different POSTGRES_IMAGE needs these re-resolved with it.
RUN glibc_is_pinned() { /lib/libc.so.6 | grep -q "release version ${GLIBC_VERSION}\." \
      || { echo "$(/lib/libc.so.6 | head -1), expected ${GLIBC_VERSION}: a glibc move needs a planned REINDEX" >&2; return 1; }; } \
 && apk add --no-cache bash=5.3-r14 coreutils=9.12-r7 jq=1.8.2-r3 curl=8.23.0-r3 openssl-4.0-libssl=4.0.3-r8 \
      lz4=1.11.0-r0 libzstd1=1.5.7-r13 libbz2-1=1.0.8-r30 libxml2=2.15.0-r0 \
 && glibc_is_pinned \
 && install -d -o postgres -g postgres -m 0700 /etc/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest /var/lib/cw-backup \
 && install -d -o postgres -g postgres -m 0770 /var/log/pgbackrest

COPY --from=pgbackrest-build /build/src/pgbackrest /usr/bin/pgbackrest
COPY --from=mc-build /out/mc /usr/local/bin/mc
COPY cw-backup.sh /usr/local/bin/cw-backup.sh
COPY schema-fingerprint.sql /usr/local/share/cw-backup/schema-fingerprint.sql
RUN chmod 0755 /usr/local/bin/cw-backup.sh \
 && pgbackrest version \
 && mc --version >/dev/null

# The postgres service renders /etc/pgbackrest/pgbackrest.conf from BACKUP_* env, then hands over to the Postgres
# image's docker-entrypoint.sh wrapper (which drops to the postgres user). Other roles override the command.
ENTRYPOINT ["/usr/local/bin/cw-backup.sh", "entrypoint"]
CMD ["postgres"]
