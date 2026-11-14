# Applications et services

Inventaire déduit des manifests et Compose inspectés; la présence d’un service ne prouve pas qu’il existe à distance.

| Composant | Usage / emplacement | Préparation staging |
|---|---|---|
| Backend API | `apps/backend`, `Dockerfile`; Compose `api` | Obligatoire; SHA dédié, DB/Redis/S3 privés |
| Worker | `apps/backend`, Compose `worker` | Obligatoire pour parcours asynchrones; même SHA et Redis staging |
| Web | `apps/web`, `Dockerfile.web`, Compose `web` | Obligatoire pour E2E web; bundle construit avec URL staging |
| Admin | `apps/admin` | Inclure pour parcours opérateur, origine/auth staging |
| Portail | `apps/portal` | Optionnel au smoke minimal; nécessaire si parcours famille/patient testés |
| PostgreSQL | Compose local/prod `postgres` | DB isolée, volumes dédiés et rôles distincts |
| Redis / Valkey | `redis` local, `valkey` production | Privé, instance et queues séparées de prod |
| S3 | RustFS local, SeaweedFS prod | Identités S3 à privilèges distincts et stockage dédié |
| ClamAV | Compose `clamav` | À garder; éviter le scanner builtin sur Internet |
| Docling | `docling-worker` | Optionnel au smoke de base; requis pour OCR/DocLens |
| Provisioning | `provision-gateway` local et services prod associés | Privé, optionnel si onboarding non testé |
| HL7 listener | `hl7-listener` prod | Désactivé/privé jusqu’à préparation de flux synthétiques |
| Rust bridge | service et sockets prod | Optionnel; image signée requise, socket privé |
| Reverse proxy/TLS | Nginx host documenté pour VPS prod | Bloquant pour accès Internet; aucun staging trouvé |
| Courriel/SMS/push | Postmark, Twilio, VAPID, FCM, APNs via backend | Sink/test uniquement, aucun destinataire réel |
| Billing/clearinghouse | M23/M24/M41, transport commun | Désactivé/sandbox, aucun compte de production |
| Prescription | DoseSpot/M12 | Désactivé; pas de prescription réelle |
| Mobile natif | aucun `apps/mobile` détecté | Non qualifié par ce checkout |

Les commandes locales sont dans `package.json` (`dev:backend`, `dev:web`, `db:up`, `db:migrate`, seeds). La production utilise images immuables et `deploy/production/deploy.sh`. Aucun workflow de staging détecté.
