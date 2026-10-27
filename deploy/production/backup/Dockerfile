# deploy/production/backup/Dockerfile — the production Postgres image plus the backup toolchain (#857).
#
# One image serves three roles so every pgBackRest invocation runs the same version against the same PGDATA layout:
#   - the `postgres` service (compose.backup.yml): archive_command = pgbackrest archive-push (WAL archiving / PITR)
#   - the `backup` sidecar: the scheduled coordinated snapshot (cw-backup.sh schedule)
#   - restore.sh: pgbackrest restore into an isolated volume, then a throwaway Postgres on it
#
# The base is the exact image deploy/production/compose.yml runs (pgvector/pgvector:pg18, Debian bookworm with the
# PGDG apt repository already configured), pinned by digest. `mc` is copied from the Chainguard MinIO client image
# because the minio/mc Docker Hub repository is no longer published.
FROM pgvector/pgvector:pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest jq curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0700 /etc/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest /var/lib/cw-backup \
 && install -d -o postgres -g postgres -m 0770 /var/log/pgbackrest

COPY --from=cgr.dev/chainguard/minio-client@sha256:778b2dac231584d5d5749ab663f9f61979d60dd5c00abf682af888db6a9f46e4 /usr/bin/mc /usr/local/bin/mc
COPY cw-backup.sh /usr/local/bin/cw-backup.sh
COPY schema-fingerprint.sql /usr/local/share/cw-backup/schema-fingerprint.sql
RUN chmod 0755 /usr/local/bin/cw-backup.sh

# The postgres service renders /etc/pgbackrest/pgbackrest.conf from BACKUP_* env, then hands over to the stock
# entrypoint (which drops to the postgres user). Other roles override the command.
ENTRYPOINT ["/usr/local/bin/cw-backup.sh", "entrypoint"]
CMD ["postgres"]
