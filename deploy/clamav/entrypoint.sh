#!/bin/sh
# clamd needs a signature DB to start: fetch it on the first start (the volume is empty), then keep it fresh while clamd
# runs in the foreground as PID 1's child. freshclam is a one-shot in a loop, not `--daemon`: a daemon that dies (or
# fails to update) is a zombie nobody notices, the loop just tries again, sooner after a failure than after a success.
# FRESHCLAM_CHECKS = updates per day (freshclam allows 1..50). Default 12, not upstream's 1: one CDN error would
# otherwise leave the signatures a day or two stale.
set -eu

checks=${FRESHCLAM_CHECKS:-12}
[ "$checks" -ge 1 ] && [ "$checks" -le 50 ] 2>/dev/null \
  || { echo "FRESHCLAM_CHECKS must be 1..50 (updates per day), got: $checks" >&2; exit 1; }
interval=$((86400 / checks))
retry=1800
if [ "$interval" -lt "$retry" ]; then retry=$interval; fi

# .cld is freshclam's incrementally patched copy of a .cvd.
have_db() { [ -f "/var/lib/clamav/$1.cvd" ] || [ -f "/var/lib/clamav/$1.cld" ]; }

chown -R clamav:clamav /var/lib/clamav

# clamd refuses to start without main and daily; a first start cut off after one of them downloads the rest.
if ! have_db main || ! have_db daily; then
  echo "Updating initial database"
  # No clamd to notify yet.
  grep -v '^NotifyClamd' /etc/clamav/freshclam.conf > /tmp/freshclam-initial.conf
  gosu clamav freshclam --foreground --stdout --config-file=/tmp/freshclam-initial.conf
  rm -f /tmp/freshclam-initial.conf
fi

# Check first, then sleep: a host that restarts the container more than daily must still update.
while :; do
  if gosu clamav freshclam --stdout; then
    wait_seconds=$interval
  else
    echo "freshclam failed; retrying in ${retry}s" >&2
    wait_seconds=$retry
  fi
  sleep "$wait_seconds"
done &
exec gosu clamav clamd --foreground
