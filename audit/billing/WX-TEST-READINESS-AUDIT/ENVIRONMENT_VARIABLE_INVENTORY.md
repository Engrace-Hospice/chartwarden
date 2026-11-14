# Inventaire des variables d’environnement

## Méthode

Consultation de `.env.example` (forme seulement), `deploy/production/.env.production.example`, `apps/backend/src/bootstrap/env.ts`, interpolations Compose et références littérales sous `apps/`, `packages/`, `scripts/`, `deploy/production/`, `.github/`. Extraction statique : 285 expressions de noms; lectures dynamiques/fichiers secrets non exhaustivement attribués. Les valeurs effectives des hôtes ne sont pas accessibles. Les regroupements ci-dessous couvrent les familles de runtime déterminantes, mais ne constituent pas une liste de 285 fiches par lecteur.

| Variables/famille constatées | Consommateur / usage | Classe et recommandation staging |
|---|---|---|
| `NODE_ENV`, `PORT`, `PROCESS_ROLE`, `LOG_LEVEL`, `APP_VERSION`, `GIT_SHA`, `BUILD_TIME`, `BOOT_CHECK_PORT`, `BOOT_CHECK_TIMEOUT_MS`, `WORKER_PORT`, `LISTENER_HEALTH_PORT` | Backend, worker, health, build | Généralement non-secret; `NODE_ENV=production`, SHA explicite, ports privés |
| `DATABASE_URL`, `DATABASE_PLATFORM_URL`, `DATABASE_DESTRUCTION_URL`, `DATABASE_ADMIN_URL`, `PROVISION_DATABASE_URL`, `DATABASE_SUPERUSER_URL`, `IDG_APP_DATABASE_URL`, `CHARTWARDEN_DB_NAME`, `POSTGRES_PASSWORD`, `CHARTWARDEN_*_PASSWORD` | DB, migration, provisioning | URLs/mots de passe secrets; ressources et rôles staging séparés |
| `REDIS_URL`, `CHARTWARDEN_TEST_DATABASE_URL`, `CHARTWARDEN_TEST_REDIS_URL` | BullMQ et suites live | Secrets/URLs; Redis staging dédié, variables de test réservées aux suites |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TWO_FACTOR_ENCRYPTION_KEY`, `CURSOR_SIGNING_KEY`, `TRUSTED_ORIGINS`, `TRUSTED_PROXY_CIDRS`, `PASSKEY_RP_ID`, `TENANT_BASE_DOMAIN`, `WEB_APP_URL`, `PORTAL_APP_URL`, `MOBILE_AUTH_TRUSTED_ORIGINS`, `CHARTWARDEN_MFA_ENFORCEMENT` | Auth, cookies, passkeys, domaines/proxy | Plusieurs secrets; URL, origins et RP ID strictement staging |
| `M24_CREDENTIAL_ENCRYPTION_KEY`, `M23_CLEARINGHOUSE_RETIRED_FINGERPRINT_KEYS`, `CLEARINGHOUSE_VENDOR`, `CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS`, `CLEARINGHOUSE_USAGE`, `CLEARINGHOUSE_PAYER_ID`, `CLAIMS_BILLING_ENFORCEMENT`, `STEDI_API_KEY`, `STEDI_TEST_API_KEY`, `CLAIMMD_ACCOUNT_KEY`, `CLAIMMD_ACCOUNT_REFERENCE`, `CLAIMMD_ACCOUNT_USAGE`, `CLAIMMD_M23_PAYER_ROUTES`, `CLAIM_PREVIEW_INTEGRITY_KEY`, `M23_X12_GATEWAY_URL`, `M23_X12_GATEWAY_TOKEN`, `M23_MAC_GATEWAY_TOKEN`, `M23_GATEWAY_TIMEOUT_MS` | M23/M24/M41, transport, credentials, X12 | Conditionnels/sensibles; aucun vendor au départ; sandbox uniquement |
| `CLAIMMD_WEBHOOK_ENABLED`, `CLAIMMD_WEBHOOK_PAYLOAD_KEY`, `CLAIMMD_ERA_CAPTURE_ENABLED`, `CLAIMMD_ERA_AUTO_POST_ENABLED`, `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED`, `CLAIMMD_ERA_M25_DELIVERY_ENABLED`, `CLAIMMD_ERA_OWNERSHIP_RESOLUTION_ENABLED`, `M23_CLAIMMD_NOTICE_UPLOAD_ENABLED` | Webhook/ERA et traitement | False/absent hors test sandbox contrôlé |
| `M23_HETS_*`, `M24_LAUNCH_GATEWAY_ENABLED`, `M24_GATEWAY_TIMEOUT_MS`, `M25_PAYEE_TIN_POLICY`, `EPISODE_ALERT_DDE_*`, `NPPES_SYNC_DISABLED`, `STEDI_CONTRACT_*` | Éligibilité, Medicaid, conformité | Conditionnelles; sandbox confirmée |
| `M34_PROVISION_GATEWAY_URL`, `M34_PROVISION_GATEWAY_TOKEN`, `M34_PROVISION_GATEWAY_TIMEOUT_MS`, `M34_INVITATION_ACCEPT_URL` | Provisioning | URL/token; endpoint staging interne |
| `M36_BODY_SEAL_SCHEME`, `MESSAGING_ENCRYPTION_KEY`, `MESSAGING_FAMILY_CODE_PEPPER`, `MESSAGING_ATTACHMENT_*`, `MESSAGING_ATTACHMENT_SCANNER`, `ALLOW_BUILTIN_ATTACHMENT_SCANNER`, `DOCUMENT_UPLOAD_SCAN_REQUIRED`, `CLAMD_HOST`, `CLAMD_PORT` | Messagerie, chiffrement, quota, antivirus | Secrets/contrôles; ClamAV activé, builtin scanner non adapté au staging public |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_PUBLIC_ENDPOINT`, `MINIO_REGION`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_APP_ACCESS_KEY`, `MINIO_APP_SECRET_KEY`, `MINIO_ACCESS_LOG_WEBHOOK_TOKEN`, `STORAGE_PUBLIC_ORIGIN`, `SEAWEEDFS_*` | S3, identité et objets | Secrets; stockage staging dédié, admin privé |
| `DOCLING_WORKER_URL`, `DOCLING_WORKER_TOKEN`, `DOCLING_TIMEOUT_MS`, `DOCLENS_AI`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODELS`, `ANTHROPIC_BAA_REFERENCE`, `ANTHROPIC_ZDR_*`, `OLLAMA_*`, `AI_MAX_OUTPUT_TOKENS`, `AI_PROMPT_ROOT` | OCR/IA | Secrets/contrat; désactivé ou sandbox, pas de PHI réelle |
| `POSTMARK_*`, `TWILIO_*`, `VAPID_*`, `FCM_SERVICE_ACCOUNT_JSON`, `APNS_*`, `MESSAGING_WEBHOOK_PUBLIC_BASE_URL` | Courriel/SMS/push/voix | Secrets/URL; sink ou destinataires de test consentis |
| `EVV_AGGREGATOR_*`, `SANDATA_API_BASE_URL`, `FAX_PROVIDER`, `GEOCODER_*`, `TELEHEALTH_DAILY_*`, `FHIR_*`, `TERMINOLOGY_*` | EVV, fax, géocodage, télésoin, FHIR | Conditionnels; désactivés ou sandbox approuvée |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_BASE_URL` | M35 | Jamais de secret live; test mode après isolation |
| `AUDIT_ARCHIVE_*`, `BACKUP_STORE_*`, `OBJECT_STORE_*`, `RESTORE_*`, `OBJECT_COPY_*`, `OPS_ALERT_WEBHOOK_URL`, `CHARTWARDEN_OPS_PAGE_WEBHOOK_*`, `DEPLOY_ALERT_WEBHOOK_URL`, `CHARTWARDEN_SOS_CONTACT_DIAL` | Archivage, backup, alertes, restore | Opérations; endpoints/credentials indépendants |
| `RUST_*`, `CW_ACTOR_SIGNING_KEY_FILE`, `CW_ACTOR_SIGNING_KEY`, autres `CW_*` | Bridge Rust et bootstrap | Signing key via fichier protégé; n’activer que routes nécessaires |
| `CHARTWARDEN_SEED_*`, `IDG_SEED_ORG_ID`, `ALLOW_PLAN_EDITS`, `CHARTWARDEN_SEED_ALLOW_PRODUCTION`, `CHARTWARDEN_DEMO`, `CHARTWARDEN_DEV_BYPASSRLS`, `CHARTWARDEN_INMEM_ASSERT` | Seeds/tests | Hors runtime; jamais seed production ni bypass RLS |
| `VITE_API_PROXY_TARGET`, `VITE_PORTAL_BASE` | Frontend build/dev | Non-secrets build-time; pointer vers staging |
| `CI`, `NODE_OPTIONS`, `TEST_TYPECHECK_SHARD_SIZE`, `UPDATE_GOLDEN`, `CHARTWARDEN_TEST_*`, `WX_DRILL_*`, `RESTORE_PHASE_*`, `PROBE_STEPS`, `IMAGE`, `LOCAL_IMAGE`, `PUBLISH_IMAGE`, `RELEASE_SHA` et similaires | CI/tests/drills | Hors runtime staging; limités à leurs jobs |

## Risques et anomalies

- Compose local contient des identifiants démo connus; impropre à Internet.
- Certaines interpolations locales sont optionnelles ou vides; un boot réussi n’est pas une preuve de sécurité.
- La prod impose des valeurs via `${VAR:?…}` et vérifie les secrets au boot; aucun validateur staging distinct n’a été trouvé.
- Configuration effective runner/hôte inconnue; rien n’est déclaré rempli.
- `.env.example` a un diff local préexistant; aucun `.env` réel consulté ou copié.

Compléter TEST-ENV-1 avec une fiche par variable runtime (source directe/indirecte, service, format, secret, défaut, build/runtime, validation, état de déploiement). Cet audit n’a pas fini ce niveau d’exhaustivité.
