#!/bin/sh
# clamd needs a signature DB to start: fetch it on the first start (the volume is empty), then keep it fresh while clamd
# runs in the foreground as PID 1's child. freshclam is a one-shot in a loop, not `--daemon`: a daemon that dies (or
# fails to update) is a zombie nobody notices, the loop just tries again at the next interval.
# FRESHCLAM_CHECKS = updates per day (upstream's variable and default of 1; freshclam allows 1..50).
set -eu

checks=${FRESHCLAM_CHECKS:-1}
[ "$checks" -ge 1 ] && [ "$checks" -le 50 ] 2>/dev/null \
  || { echo "FRESHCLAM_CHECKS must be 1..50 (updates per day), got: $checks" >&2; exit 1; }
interval=$((86400 / checks))

chown -R clamav:clamav /var/lib/clamav

if [ ! -f /var/lib/clamav/main.cvd ] && [ ! -f /var/lib/clamav/main.cld ]; then  # .cld: freshclam's incrementally patched copy
  echo "Updating initial database"
  # No clamd to notify yet.
  grep -v '^NotifyClamd' /etc/clamav/freshclam.conf > /tmp/freshclam-initial.conf
  gosu clamav freshclam --foreground --stdout --config-file=/tmp/freshclam-initial.conf
  rm -f /tmp/freshclam-initial.conf
fi

# Check first, then sleep: a host that restarts the container more than daily must still update.
while :; do
  gosu clamav freshclam --stdout || echo "freshclam failed; retrying in ${interval}s" >&2
  sleep "$interval"
done &
exec gosu clamav clamd --foreground
