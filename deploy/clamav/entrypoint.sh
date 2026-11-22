#!/bin/sh
# clamd needs a signature DB to start: fetch it on the first start (the volume is empty), then keep freshclam refreshing
# it (FRESHCLAM_CHECKS times a day, upstream's default of 1) while clamd runs in the foreground as PID 1's child.
set -eu

chown -R clamav:clamav /var/lib/clamav

if [ ! -f /var/lib/clamav/main.cvd ] && [ ! -f /var/lib/clamav/main.cld ]; then  # .cld: freshclam's incrementally patched copy
  echo "Updating initial database"
  # No clamd to notify yet.
  grep -v '^NotifyClamd' /etc/clamav/freshclam.conf > /tmp/freshclam-initial.conf
  gosu clamav freshclam --foreground --stdout --config-file=/tmp/freshclam-initial.conf
  rm -f /tmp/freshclam-initial.conf
fi

gosu clamav freshclam --daemon --foreground --stdout --checks="${FRESHCLAM_CHECKS:-1}" &
exec gosu clamav clamd --foreground
