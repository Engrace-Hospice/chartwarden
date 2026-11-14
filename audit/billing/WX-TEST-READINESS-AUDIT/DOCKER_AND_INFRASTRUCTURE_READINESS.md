# Docker et infrastructure

## Éléments présents

- `docker-compose.yml` est un environnement de développement avec PostgreSQL, Redis, RustFS, ClamAV, migration, API, worker, Docling et provisioning gateway.
- `deploy/production/compose.yml` décrit une topologie VPS avec Postgres, Valkey, SeaweedFS, API, worker, web, Docling, ClamAV, HL7 et réseaux internes. Images tierces digest-pinnées et limites CPU/RAM documentées.
- Les services d’app sont destinés au proxy Nginx host/TLS; stockage S3 publié en loopback. PostgreSQL/Redis n’ont pas de ports publiés dans les extraits inspectés.
- Procédures prod incluent preflight, migration, health et smoke. Cette stack ne définit pas le staging.

## Bloqueurs

- Ne pas exposer la Compose locale : secrets démo connus, `NODE_ENV=development`, ports et services de développement.
- La topologie de production et son script modifient `.env.production`, images et services VPS. Réutilisation pour staging sans projet, volumes, domaines, secrets et hôte dédiés risque une collision avec production.
- Pas de définition Compose staging, inventaire d’hôte, firewall, DNS/TLS, CORS/cookies/WSS staging trouvé.
- Sauvegardes, volumes, stockage et réseaux doivent être dédiés. Définir chiffrement, quota, rétention, rotation des logs et procédure de restauration.
- Interpolations de développement optionnelles/vides; contraintes Compose de production ne certifient pas une future configuration staging.
- Seul le proxy HTTPS doit être public. DB, cache, S3 admin, scanner, HL7, sockets Rust, provisioning et workers restent privés.

Créer une définition staging séparée; vérifier son rendu avec fixture synthétique uniquement, ports publiés, volumes, nom de projet, limites et healthchecks avant tout déploiement.
