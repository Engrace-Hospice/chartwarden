#!/bin/sh
# cw-refresh-collation — run once after this image's glibc differs from the one that built the cluster's indexes
# (first start on a volume the Debian image created, or a deliberate GLIBC_VERSION bump). Postgres says so on every
# connection: "database ... has a collation version mismatch". Rebuilds every index in every connectable database,
# then records the new collation version, which silences the warning. Stop api/worker first: REINDEX locks each table.
#
#   docker compose exec -u postgres postgres cw-refresh-collation
set -eu
user="${POSTGRES_USER:-postgres}"
psql_() { psql -X -v ON_ERROR_STOP=1 -U "$user" "$@"; }

for db in $(psql_ -At -d postgres -c "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname"); do
  echo "== $db"
  psql_ -d "$db" -v db="$db" <<'SQL'
REINDEX DATABASE;
ALTER DATABASE :"db" REFRESH COLLATION VERSION;
SQL
done

psql_ -d postgres -c "SELECT datname, datcollversion AS recorded, pg_database_collation_actual_version(oid) AS os
                        FROM pg_database WHERE datallowconn ORDER BY datname"
