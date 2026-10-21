#!/usr/bin/env sh
# Bootstrap the single-VPS production host for ChartWarden object storage.
#
# Run from the repository root after copying the repo or the deploy/production folder to the VPS:
#   sudo DEPLOY_DIR=/opt/wardenx ./deploy/production/bootstrap-vps.sh
#
# The script is idempotent: it creates missing files, refreshes compose/nginx config, starts MinIO,
# and leaves an existing .env.production untouched.
set -eu

DEPLOY_DIR=${DEPLOY_DIR:-/opt/wardenx}
SOURCE_DIR=${SOURCE_DIR:-deploy/production}
FRONTEND_DOMAIN=${FRONTEND_DOMAIN:-wardenx.chartwarden.cloud}
BACKEND_DOMAIN=${BACKEND_DOMAIN:-be082026.wardenx.chartwarden.cloud}
STORAGE_DOMAIN=${STORAGE_DOMAIN:-storage.wardenx.chartwarden.cloud}

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root, or with sudo" >&2
  exit 77
fi

if [ ! -f "$SOURCE_DIR/compose.yml" ] || [ ! -d "$SOURCE_DIR/nginx" ] || [ ! -f "$SOURCE_DIR/.env.production.example" ]; then
  echo "expected $SOURCE_DIR/compose.yml, $SOURCE_DIR/nginx and $SOURCE_DIR/.env.production.example; run from the repo root or set SOURCE_DIR" >&2
  exit 66
fi

secret_hex() {
  openssl rand -hex 32
}

secret_b64() {
  openssl rand -base64 32
}

install -d -m 0750 "$DEPLOY_DIR"
install -m 0644 "$SOURCE_DIR/compose.yml" "$DEPLOY_DIR/compose.yml"
install -m 0755 "$SOURCE_DIR/deploy.sh" "$DEPLOY_DIR/deploy.sh"

if [ ! -f "$DEPLOY_DIR/.env.production" ]; then
  tmp_env=$(mktemp "$DEPLOY_DIR/.env.production.XXXXXX")
  chmod 600 "$tmp_env"
  # Every REPLACE_WITH_* token gets its OWN freshly generated secret (a shared value would make e.g. the
  # tenant KEK and the pseudonym KEK identical, which their specs forbid). awk shells out to openssl
  # once per token occurrence.
  awk '
    function gen(kind,   cmd, out) {
      if (kind == "REPLACE_WITH_BASE64_32_BYTES") cmd = "openssl rand -base64 32"
      else cmd = "openssl rand -hex 32"
      cmd | getline out
      close(cmd)
      return out
    }
    {
      while (match($0, /REPLACE_WITH_[A-Z0-9_]+/)) {
        tok = substr($0, RSTART, RLENGTH)
        if (tok != "REPLACE_WITH_64_HEX_CHARACTERS" && tok != "REPLACE_WITH_BASE64_32_BYTES" && tok != "REPLACE_WITH_AT_LEAST_32_CHARACTERS") {
          print "unknown placeholder " tok > "/dev/stderr"; exit 65
        }
        $0 = substr($0, 1, RSTART - 1) gen(tok) substr($0, RSTART + RLENGTH)
      }
      print
    }
  ' "$SOURCE_DIR/.env.production.example" | sed \
    -e "s#https://wardenx.chartwarden.cloud#https://$FRONTEND_DOMAIN#g" \
    -e "s#https://be082026.wardenx.chartwarden.cloud#https://$BACKEND_DOMAIN#g" \
    -e "s#https://storage.wardenx.chartwarden.cloud#https://$STORAGE_DOMAIN#g" \
    -e "s#^PASSKEY_RP_ID=.*#PASSKEY_RP_ID=$FRONTEND_DOMAIN#" \
    -e "s#^WEBAUTHN_RP_ID=.*#WEBAUTHN_RP_ID=$FRONTEND_DOMAIN#" \
    >"$tmp_env"
  mv "$tmp_env" "$DEPLOY_DIR/.env.production"
  echo "created $DEPLOY_DIR/.env.production with generated secrets"
  echo "edit CHARTWARDEN_IMAGE, CHARTWARDEN_WEB_IMAGE, GHCR owner/SHA, and provider gateway URLs before full app deploy"
else
  echo "kept existing $DEPLOY_DIR/.env.production"
fi

if command -v nginx >/dev/null 2>&1; then
  install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
  install -d -m 0755 /etc/nginx/conf.d
  install -m 0644 "$SOURCE_DIR/nginx/wardenx-log-format.conf" /etc/nginx/conf.d/wardenx-log-format.conf
  install -m 0644 "$SOURCE_DIR/nginx/wardenx-storage.conf" /etc/nginx/sites-available/wardenx-storage.conf
  ln -sfn /etc/nginx/sites-available/wardenx-storage.conf /etc/nginx/sites-enabled/wardenx-storage.conf
  nginx -t
  systemctl reload nginx || systemctl restart nginx
else
  echo "nginx is not installed; skipped nginx config install"
fi

cd "$DEPLOY_DIR"
docker compose --env-file .env.production -f compose.yml up -d minio

attempt=0
until curl --fail --silent --show-error http://127.0.0.1:9000/minio/health/ready >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "MinIO did not become ready on 127.0.0.1:9000" >&2
    exit 1
  fi
  sleep 2
done

echo "MinIO is ready locally."
echo "Public S3 endpoint expected by ChartWarden: https://$STORAGE_DOMAIN"
echo "Next: make DNS point $STORAGE_DOMAIN to this VPS, then issue TLS with certbot or your reverse-proxy TLS automation."
