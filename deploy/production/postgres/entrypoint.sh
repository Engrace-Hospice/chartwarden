#!/bin/sh
# Debian's Postgres puts its socket in /var/run/postgresql; Wolfi's is compiled for /tmp and initdb ignores the sample
# config's setting. pgBackRest, cw-backup.sh, restore.sh and the pg-socket volume all expect /var/run/postgresql, so
# every server this image starts listens on both. A later `-c unix_socket_directories=...` still overrides it.
set -e
case "${1:-}" in
  postgres) shift; set -- postgres -c unix_socket_directories=/var/run/postgresql,/tmp "$@" ;;
  -*) set -- postgres -c unix_socket_directories=/var/run/postgresql,/tmp "$@" ;;
esac
exec /usr/bin/docker-entrypoint.sh "$@"
