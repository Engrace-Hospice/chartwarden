# Santé, journaux et observabilité

- `apps/backend/src/bootstrap/routes/health.ts` expose `GET /health` (liveness) et `/ready` (readiness, 503 si dépendance déclarée en panne).
- Compose local sonde l’API; production définit healthchecks et `deploy/production/smoke.sh`.
- `LOG_LEVEL`, archives d’audit, alertes, audit access-log stockage ont des paramètres. L’audit stockage est best-effort; panne Fluent Bit peut laisser une lacune sans bloquer la lecture S3.
- BIL-5.5 relève qu’il n’existe pas de source durable de heartbeat worker et budget de requêtes.

## À établir en staging

Dashboard/alertes disponibilité, saturation disque/DB/Redis, queues/outbox, erreurs fournisseurs, TLS et coûts; durée des logs et exclusion de PHI/tokens/secrets. N’exposer qu’un healthcheck public minimal. Aucun outil de monitoring staging ou alerting n’a été vérifié.
