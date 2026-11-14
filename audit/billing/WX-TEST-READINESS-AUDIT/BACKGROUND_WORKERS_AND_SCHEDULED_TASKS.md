# Workers et tâches planifiées

Le Compose local et la production séparent un `worker` de l’API. `REDIS_URL` est requis en production. Le backend crée des queues BullMQ, crons et consommateurs outbox; M41 a drains et schedules. Les gates d’architecture vérifient les noms et bindings.

## Portes staging

- Redis/DB isolés de production; API et worker sur le même SHA.
- Vérifier que le scheduler ne duplique pas les tâches, que retries, DLQ et jobs suspendus sont visibles et qu’aucun job d’envoi ne sort sans sandbox.
- Contrôler backlog outbox, redémarrage/idempotence et erreurs avec données synthétiques.
- BIL-5.5 signale l’absence de source durable pour heartbeat worker et budget requêtes; ne pas afficher des métriques inventées.
- Aucun conteneur n’a été démarré; santé/ordonnance des tâches distantes restent inconnues.

Worker requis pour une validation E2E complète.
