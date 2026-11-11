# deploy/production/postgres/Dockerfile — ChartWarden's Postgres: PostgreSQL 18 + pgvector on Wolfi (glibc).
#
# Replaces pgvector/pgvector:pg18 (Debian), whose OS layer carried dozens of HIGH/CRITICAL CVEs Debian will not fix.
# Production runs the published, scanned, signed digest (.github/workflows/postgres-image.yml) that compose.yml and
# backup/Dockerfile pin; dev compose, CI and the restore drills build this file, so every Postgres the code meets is the same package set.
#
# Drop-in for a volume the Debian image created: postgres is uid/gid 999, PGDATA is the PG18 layout under the
# /var/lib/postgresql volume, LANG is en_US.utf8, and entrypoint.sh adds Debian's socket directory (/var/run/postgresql,
# the pg-socket volume) to Wolfi's /tmp. Behind it, Wolfi's stock docker-entrypoint.sh (postgresql-18-oci-entrypoint)
# keeps the POSTGRES_* contract; init scripts go in /var/lib/postgres/initdb/, not /docker-entrypoint-initdb.d.
# posix-libc-utils-bin ships `locale`, so initdb imports the libc collations (en_US.utf8 ...) a Debian cluster has.
#
# COLLATION. Text indexes are ordered by glibc's collation. GLIBC_VERSION is asserted at build time, so a base bump
# that moves glibc fails here instead of silently reordering indexes. Moving it is a planned change: after the new
# image starts, run cw-refresh-collation (REINDEX + REFRESH COLLATION VERSION on every database; deploy/production/README.md).
#
# Bump: refresh the base digest (`crane digest cgr.dev/chainguard/wolfi-base:latest`) and the package pins
# (`apk add -s <pkgs>` in that base shows the versions it resolves); Wolfi keeps old versions, so pins stay buildable.
FROM cgr.dev/chainguard/wolfi-base@sha256:8509ee4351a2e501b7f98201f2e2642396e82020c61a589cacdcfe74b9de46c1

ARG GLIBC_VERSION=2.44
ARG PG_VERSION=18.6-r7
ARG PGVECTOR_VERSION=0.8.7-r0

RUN glibc_is_pinned() { /lib/libc.so.6 | grep -q "release version ${GLIBC_VERSION}\." \
      || { echo "$(/lib/libc.so.6 | head -1), expected ${GLIBC_VERSION}: a glibc move needs a planned REINDEX" >&2; return 1; }; } \
 && glibc_is_pinned \
 && addgroup -g 999 postgres \
 && adduser -D -H -u 999 -G postgres -h /var/lib/postgresql -s /bin/sh postgres \
 && apk add --no-cache \
      "postgresql-18=${PG_VERSION}" \
      "postgresql-18-client=${PG_VERSION}" \
      "postgresql-18-contrib=${PG_VERSION}" \
      "postgresql-18-oci-entrypoint=${PG_VERSION}" \
      "pgvector-18=${PGVECTOR_VERSION}" \
      gosu=1.20-r0 tzdata=2026f-r0 \
      "glibc-${GLIBC_VERSION}-locale-en" "posix-libc-utils-bin-${GLIBC_VERSION}" \
 && glibc_is_pinned \
 && install -d -o postgres -g postgres -m 0755 /var/lib/postgresql \
 && install -d -o postgres -g postgres -m 3777 /var/run/postgresql

COPY --chmod=0755 entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chmod=0755 cw-refresh-collation.sh /usr/local/bin/cw-refresh-collation

ENV LANG=en_US.utf8 \
    PGDATA=/var/lib/postgresql/18/docker

VOLUME /var/lib/postgresql
STOPSIGNAL SIGINT
EXPOSE 5432
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["postgres"]
