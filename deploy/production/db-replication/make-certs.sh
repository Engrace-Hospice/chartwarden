#!/usr/bin/env bash
# deploy/production/db-replication/make-certs.sh — mutual-TLS material for primary -> standby streaming (CW-CP-01).
#
#   make-certs.sh <out-dir> <primary-host> [days]
#
# <primary-host> is the DNS name or IP the standby connects to (it goes into the server certificate's SAN, because the
# standby verifies it: sslmode=verify-full). Writes, named exactly like the Docker secrets that consume them:
#
#   replication_ca.crt            keep with the escrow; it is the CA the primary trusts and the standby verifies against
#   <out-dir>.ca/replication_ca.key
#                                 OFFLINE ONLY: it can mint a client certificate that reads the whole database. Written to a
#                                 SIBLING directory (./certs -> ./certs.ca), never into <out-dir>, so copying <out-dir> to a
#                                 host (scp -r, rsync, cp -r) cannot carry it. Never copied to either host (deploy.yml does
#                                 not ship this script either); written UNENCRYPTED, so run this on a machine you trust,
#                                 escrow the key (encrypted) and delete it from that machine at once. There is no CRL: to
#                                 revoke a client certificate, replace the CA and re-issue
#   replication_ca                (copy of replication_ca.crt) -> secret `replication_ca` on both hosts
#   replication_server_cert/_key  -> the primary (ssl_cert_file / ssl_key_file)
#   replication_client_cert/_key  -> the standby (CN = cw_replicator, the role the primary's `cert` rule authenticates)
#
# The standby has no password: the primary's pg_hba rule is `hostssl replication cw_replicator <the standby /32> cert`
# (provision-primary.sh), so a connection needs a client certificate this CA signed whose CN is the role, from the standby's
# address. Defaults: leaf certificates 365 days
# (renew before they lapse: an expired one shows up as `replication.standby_absent`), the CA 5 years.
# Portable on purpose (bash 3.2, OpenSSL or LibreSSL): the drill runs it on a developer machine.
set -Eeuo pipefail
umask 077

OUT="${1:?usage: make-certs.sh <out-dir> <primary-host> [days]}"
OUT="${OUT%/}"
CA_DIR="$OUT.ca"
HOST="${2:?usage: make-certs.sh <out-dir> <primary-host> [days]}"
DAYS="${3:-365}"
ROLE="${REPLICATION_ROLE:-cw_replicator}"
CA_DAYS=1825

[[ $HOST =~ ^[A-Za-z0-9.:-]+$ ]] || { echo "make-certs: primary host must be a DNS name or an IP address" >&2; exit 1; }
[[ $ROLE =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "make-certs: REPLICATION_ROLE must be a plain role name" >&2; exit 1; }
[[ $DAYS =~ ^[0-9]+$ ]] && [ "$DAYS" -ge 1 ] && [ "$DAYS" -le "$CA_DAYS" ] || { echo "make-certs: days must be a number from 1 to $CA_DAYS (the CA's own lifetime)" >&2; exit 1; }
if [ -e "$CA_DIR/replication_ca.key" ] || [ -e "$OUT/replication_ca.crt" ]; then echo "make-certs: $OUT or $CA_DIR already holds a CA; refusing to overwrite it" >&2; exit 1; fi
mkdir -p "$OUT" "$CA_DIR"

if [[ $HOST =~ ^[0-9.]+$ ]] || [[ $HOST == *:* ]]; then SAN="IP:$HOST"; else SAN="DNS:$HOST"; fi

genkey() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1"; }

genkey "$CA_DIR/replication_ca.key"
openssl req -x509 -new -key "$CA_DIR/replication_ca.key" -sha256 -days "$CA_DAYS" -subj "/CN=chartwarden-replication-ca" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out "$OUT/replication_ca.crt"
cp "$OUT/replication_ca.crt" "$OUT/replication_ca"

leaf() { # name cn extfile-contents
  local name="$1" cn="$2" ext="$3"
  genkey "$OUT/${name}_key"
  openssl req -new -key "$OUT/${name}_key" -subj "/CN=$cn" -out "$OUT/$name.csr"
  printf '%s\n' "$ext" >"$OUT/$name.ext"
  openssl x509 -req -in "$OUT/$name.csr" -CA "$OUT/replication_ca.crt" -CAkey "$CA_DIR/replication_ca.key" -CAcreateserial \
    -sha256 -days "$DAYS" -extfile "$OUT/$name.ext" -out "$OUT/${name}_cert"
  rm -f "$OUT/$name.csr" "$OUT/$name.ext"
}
leaf replication_server "$HOST" "subjectAltName=$SAN
basicConstraints=CA:FALSE
extendedKeyUsage=serverAuth"
leaf replication_client "$ROLE" "basicConstraints=CA:FALSE
extendedKeyUsage=clientAuth"
rm -f "$OUT/replication_ca.srl"

# The files that go to a host are read by the container's postgres user (uid 999); the CA key stays 0400 and offline.
chmod 0400 "$CA_DIR/replication_ca.key"
chmod 0444 "$OUT/replication_ca" "$OUT/replication_ca.crt" "$OUT/replication_server_cert" "$OUT/replication_client_cert"
chmod 0400 "$OUT/replication_server_key" "$OUT/replication_client_key"
echo "wrote replication_{ca,server_cert,server_key,client_cert,client_key} to $OUT (CA key: $CA_DIR/replication_ca.key, OUTSIDE $OUT: escrow it offline and delete it from this machine)"
