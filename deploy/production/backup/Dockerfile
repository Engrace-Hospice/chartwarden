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
# exports only OPENSSL_4.0.0 symbol versions. Bump deliberately: new tag plus its commit SHA, then re-run both
# drills (`bun run backup:coordinated-drill`, `bun run backup:restore-drill`).
# `mc` is copied from the Chainguard MinIO client image because the minio/mc Docker Hub repository is no longer
# published. Mirror that digest into a registry you control (a vanished upstream digest breaks the next rebuild).
ARG POSTGRES_IMAGE=ghcr.io/engrace-hospice/chartwarden-postgres:18-sha-2ea20d5c0bf340d3f93c1d6fcd715a3027354793@sha256:b325d5fd8f295ef1aaed77508f808fcbd573787ff0469de6126fdff4ae261636

FROM cgr.dev/chainguard/wolfi-base@sha256:8509ee4351a2e501b7f98201f2e2642396e82020c61a589cacdcfe74b9de46c1 AS pgbackrest-build
ARG PGBACKREST_REF=release/2.60.0
ARG PGBACKREST_COMMIT=2e1c4f2ba727c45a0a23d4b326905088dc15b1a1
ARG PG_VERSION=18.6-r7
RUN apk add --no-cache build-base meson ninja git pkgconf python3 py3-pyyaml \
      "postgresql-18-dev=${PG_VERSION}" "libpq-18=${PG_VERSION}" \
      openssl-4.0-dev lz4-dev zstd-dev bzip2-dev libxml2-dev zlib-dev
RUN git clone -q --depth 1 --branch "$PGBACKREST_REF" https://github.com/pgbackrest/pgbackrest.git /src \
 && [ "$(git -C /src rev-parse HEAD)" = "$PGBACKREST_COMMIT" ] \
 && meson setup /build /src --buildtype=release \
 && ninja -C /build \
 && /build/src/pgbackrest version

FROM ${POSTGRES_IMAGE}
ARG GLIBC_VERSION=2.44
# bash, coreutils, jq and curl are what cw-backup.sh and restore.sh call; the libraries are pgBackRest's own links.
# coreutils' applets shadow busybox's, so `date -u +%-H`, `stat -c`, `timeout`, `base64 -d` are the GNU ones.
RUN glibc_is_pinned() { /lib/libc.so.6 | grep -q "release version ${GLIBC_VERSION}\." \
      || { echo "$(/lib/libc.so.6 | head -1), expected ${GLIBC_VERSION}: a glibc move needs a planned REINDEX" >&2; return 1; }; } \
 && apk add --no-cache bash coreutils jq curl openssl-4.0-libssl lz4 libzstd1 libbz2-1 libxml2 \
 && glibc_is_pinned \
 && install -d -o postgres -g postgres -m 0700 /etc/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest /var/lib/cw-backup \
 && install -d -o postgres -g postgres -m 0770 /var/log/pgbackrest

COPY --from=pgbackrest-build /build/src/pgbackrest /usr/bin/pgbackrest
COPY --from=cgr.dev/chainguard/minio-client@sha256:10388d580a724f356b94c9b2631b5a179039cabe8c76e9b37d86ed007d569b05 /usr/bin/mc /usr/local/bin/mc
COPY cw-backup.sh /usr/local/bin/cw-backup.sh
COPY schema-fingerprint.sql /usr/local/share/cw-backup/schema-fingerprint.sql
RUN chmod 0755 /usr/local/bin/cw-backup.sh \
 && pgbackrest version \
 && mc --version | head -1

# The postgres service renders /etc/pgbackrest/pgbackrest.conf from BACKUP_* env, then hands over to the Postgres
# image's docker-entrypoint.sh wrapper (which drops to the postgres user). Other roles override the command.
ENTRYPOINT ["/usr/local/bin/cw-backup.sh", "entrypoint"]
CMD ["postgres"]
