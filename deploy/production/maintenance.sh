#!/usr/bin/env sh
# Toggle the host-level nginx maintenance page (#865): maintenance.sh on|off|status
# The flag file is read per request by nginx/chartwarden-maintenance.conf; no reload is needed. Run as a user that can
# write the flag path (root, normally).
set -eu

flag=${CHARTWARDEN_MAINTENANCE_FLAG:-/etc/nginx/chartwarden-maintenance.on}

case "${1:-}" in
  on) : >"$flag"; echo "maintenance ON: app traffic gets a 503 page (health probes still pass)" ;;
  off) rm -f "$flag"; echo "maintenance OFF" ;;
  status) if [ -f "$flag" ]; then echo "maintenance ON"; else echo "maintenance OFF"; fi ;;
  *) echo "usage: $0 on|off|status" >&2; exit 64 ;;
esac
