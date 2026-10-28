#!/usr/bin/env sh
# Bootstrap the single-VPS production host for ChartWarden object storage.
#
# Run from the repository root after copying the repo or the deploy/production folder to the VPS:
#   sudo DEPLOY_DIR=/opt/chartwarden ./deploy/production/bootstrap-vps.sh
#
# The script is idempotent: it creates missing files, refreshes compose/nginx config, starts MinIO,
# and leaves an existing .env.production untouched.
set -eu

DEPLOY_DIR=${DEPLOY_DIR:-/opt/chartwarden}
SOURCE_DIR=${SOURCE_DIR:-deploy/production}
TENANT_BASE_DOMAIN=${TENANT_BASE_DOMAIN:-}
if [ -n "$TENANT_BASE_DOMAIN" ]; then
  # Lowercase labels only: the value is substituted into sed scripts that run as root.
  case $TENANT_BASE_DOMAIN in
    *[!a-z0-9.-]* | .* | *. | *..*) echo "TENANT_BASE_DOMAIN must be a bare lowercase domain (e.g. chartwarden.com)" >&2; exit 64 ;;
  esac
  FRONTEND_DOMAIN=${FRONTEND_DOMAIN:-app.$TENANT_BASE_DOMAIN}
  BACKEND_DOMAIN=${BACKEND_DOMAIN:-app.$TENANT_BASE_DOMAIN}
else
  FRONTEND_DOMAIN=${FRONTEND_DOMAIN:-app.chartwarden.cloud}
  BACKEND_DOMAIN=${BACKEND_DOMAIN:-api.chartwarden.cloud}
fi
STORAGE_DOMAIN=${STORAGE_DOMAIN:-storage.chartwarden.cloud}
# ADR-0049: set to the base domain (e.g. chartwarden.com) to build the real per-tenant-subdomain environment. Unset = the
# single-host demo, byte-for-byte as before. See TENANT_EDGE.md.

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
install -m 0755 "$SOURCE_DIR/maintenance.sh" "$DEPLOY_DIR/maintenance.sh"
install -m 0755 "$SOURCE_DIR/preflight.sh" "$DEPLOY_DIR/preflight.sh"

if [ ! -f "$DEPLOY_DIR/.env.production" ]; then
  umask 077
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
    -e "s#https://app.chartwarden.cloud#https://$FRONTEND_DOMAIN#g" \
    -e "s#https://api.chartwarden.cloud#https://$BACKEND_DOMAIN#g" \
    -e "s#https://storage.chartwarden.cloud#https://$STORAGE_DOMAIN#g" \
    -e "s#^PASSKEY_RP_ID=.*#PASSKEY_RP_ID=$FRONTEND_DOMAIN#" \
    -e "s#^WEBAUTHN_RP_ID=.*#WEBAUTHN_RP_ID=$FRONTEND_DOMAIN#" \
    >"$tmp_env"
  if [ -n "$TENANT_BASE_DOMAIN" ]; then
    # Overlay the tenant settings: replace a key already present, append one that is not.
    sed "s#chartwarden\\.com#$TENANT_BASE_DOMAIN#g" "$SOURCE_DIR/.env.tenant.example" | grep -E '^[A-Z][A-Z0-9_]*=' | while IFS= read -r line; do
      key=${line%%=*}
      if grep -q "^$key=" "$tmp_env"; then
        grep -v "^$key=" "$tmp_env" >"$tmp_env.next" && mv "$tmp_env.next" "$tmp_env"
      fi
      printf '%s\n' "$line" >>"$tmp_env"
    done
    chmod 600 "$tmp_env"
  fi
  mv "$tmp_env" "$DEPLOY_DIR/.env.production"
  echo "created $DEPLOY_DIR/.env.production with generated secrets"
  echo "edit CHARTWARDEN_IMAGE, CHARTWARDEN_WEB_IMAGE, GHCR owner/SHA, and provider gateway URLs before full app deploy"
else
  echo "kept existing $DEPLOY_DIR/.env.production"
fi

if command -v nginx >/dev/null 2>&1; then
  install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
  install -d -m 0755 /etc/nginx/conf.d
  install -m 0644 "$SOURCE_DIR/nginx/chartwarden-log-format.conf" /etc/nginx/conf.d/chartwarden-log-format.conf
  # Maintenance switch (#865): the app vhosts include this snippet; the page it serves lives under /var/www.
  install -d -m 0755 /etc/nginx/snippets /var/www/chartwarden-maintenance
  install -m 0644 "$SOURCE_DIR/nginx/chartwarden-maintenance.conf" /etc/nginx/snippets/chartwarden-maintenance.conf
  install -m 0644 "$SOURCE_DIR/nginx/maintenance.html" /var/www/chartwarden-maintenance/maintenance.html
  install -m 0644 "$SOURCE_DIR/nginx/chartwarden-storage.conf" /etc/nginx/sites-available/chartwarden-storage.conf
  ln -sfn /etc/nginx/sites-available/chartwarden-storage.conf /etc/nginx/sites-enabled/chartwarden-storage.conf
  if [ -n "$TENANT_BASE_DOMAIN" ]; then
    sed "s#chartwarden\\.com#$TENANT_BASE_DOMAIN#g" "$SOURCE_DIR/nginx/chartwarden-tenant.conf" >/etc/nginx/sites-available/chartwarden-tenant.conf
    chmod 0644 /etc/nginx/sites-available/chartwarden-tenant.conf
    ln -sfn /etc/nginx/sites-available/chartwarden-tenant.conf /etc/nginx/sites-enabled/chartwarden-tenant.conf
  fi
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
