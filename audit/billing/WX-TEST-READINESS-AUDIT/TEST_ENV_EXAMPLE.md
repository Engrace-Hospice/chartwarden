# Gabarit indicatif staging

Valeurs factices uniquement. Ce contenu ne démarre pas l’application; remplacer les marqueurs via le secret store staging. Ne pas commiter des valeurs renseignées et ne jamais utiliser en production.

```dotenv
NODE_ENV=production
APP_VERSION=staging-placeholder
GIT_SHA=replace-with-reviewed-commit-sha
BETTER_AUTH_URL=https://auth.staging.example.invalid
WEB_APP_URL=https://staging.example.invalid
PORTAL_APP_URL=https://portal.staging.example.invalid
TRUSTED_ORIGINS=https://staging.example.invalid,https://portal.staging.example.invalid,https://admin.staging.example.invalid
TENANT_BASE_DOMAIN=
TRUSTED_PROXY_CIDRS=replace-with-staging-proxy-cidr
BETTER_AUTH_SECRET=GENERATE_STAGING_SECRET
TWO_FACTOR_ENCRYPTION_KEY=GENERATE_STAGING_SECRET
CURSOR_SIGNING_KEY=GENERATE_STAGING_SECRET
M24_CREDENTIAL_ENCRYPTION_KEY=GENERATE_STAGING_BASE64_32_BYTES
DATABASE_URL=INJECT_STAGING_DATABASE_URL
DATABASE_PLATFORM_URL=INJECT_STAGING_PLATFORM_DATABASE_URL
DATABASE_DESTRUCTION_URL=INJECT_STAGING_DESTRUCTION_DATABASE_URL
REDIS_URL=INJECT_STAGING_REDIS_URL
MINIO_ENDPOINT=https://objects.staging.example.invalid
MINIO_ACCESS_KEY=INJECT_STAGING_S3_ACCESS_KEY
MINIO_SECRET_KEY=INJECT_STAGING_S3_SECRET
MINIO_REGION=us-east-1
CLAIMS_BILLING_ENFORCEMENT=off
CLAIMMD_WEBHOOK_ENABLED=false
M24_LAUNCH_GATEWAY_ENABLED=false
REALTIME_ENABLED=false
MESSAGING_ATTACHMENT_SCANNER=clamd
LOG_LEVEL=info
PORT=3000
```

Le dépôt a d’autres variables conditionnelles selon les capacités activées. Finaliser l’inventaire avant d’utiliser ce gabarit.
