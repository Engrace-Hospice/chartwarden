#!/bin/sh
# End-to-end proof of a ClamAV image: it downloads and loads the real signatures, answers on 3310, and flags EICAR over
# TCP INSTREAM from a second container (the way api/worker reach it) while passing a clean file.
# Usage: deploy/clamav/smoke.sh <image>   (needs network for the first signature download, ~110 MB)
set -eu

image=${1:?usage: smoke.sh <image>}
here=$(cd "$(dirname "$0")" && pwd)
name="cw-clamav-smoke-$$"
trap 'docker rm -f -v "$name" >/dev/null 2>&1 || true' EXIT
trap 'exit 1' INT TERM  # a cancelled job must still run the EXIT cleanup

# The test string is built from two halves so this file is not itself an antivirus hit.
# shellcheck disable=SC2016  # literal: the single quotes are the point
eicar='X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR'
eicar="${eicar}-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*"

docker run -d --name "$name" -v "$here/clamd.conf:/etc/clamav/clamd.conf:ro" "$image" >/dev/null

tries=0
until docker exec "$name" sh -c 'echo PING | nc 127.0.0.1 3310 | grep -q PONG' 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ] || [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
    echo "clamd never answered PING" >&2
    docker logs "$name" >&2
    exit 1
  fi
  sleep 5
done

ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
scan() {
  docker run --rm --entrypoint sh "$image" -c \
    "printf 'TCPSocket 3310\nTCPAddr $ip\n' > /tmp/c.conf; printf '%s' \"\$1\" > /tmp/f; clamdscan -c /tmp/c.conf --stream /tmp/f" \
    sh "$1" || true
}

infected=$(scan "$eicar")
clean=$(scan "clean file")
# The signature name belongs to the database (Eicar-Test-Signature today), so match any EICAR detection.
case $infected in *[Ee][Ii][Cc][Aa][Rr]*" FOUND"*) ;; *) echo "EICAR not detected: $infected" >&2; exit 1 ;; esac
case $clean in *": OK"*) ;; *) echo "clean file not reported OK: $clean" >&2; exit 1 ;; esac
echo "smoke ok: $(docker exec "$name" clamd --version)"
