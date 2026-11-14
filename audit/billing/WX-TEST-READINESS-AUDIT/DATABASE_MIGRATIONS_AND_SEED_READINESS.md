# Base de données, migrations et seeds

## Constats

- Historique de migrations sous `packages/db/migrations`; commandes `db:migrate`, `db:migrate:deploy`, provisioning des rôles et attente DB dans `package.json`.
- Compose local séquence migration/provisioning avant API. La procédure production exécute migration stricte avant recréation des services et traite les migrations contractantes comme décision opérateur.
- Rôles app/platform/destruction séparés; les tests RLS doivent utiliser le vrai rôle `NOBYPASSRLS` selon AGENTS.md.
- Nombreux seeds; `db:seed:all` inclut billing et d’autres scénarios. Ne pas lancer sans revue des capacités externes.
- Aucune base, migration ni seed n’a été exécuté ici; état d’une DB distante inconnu.

## Préparation

Créer une DB vide dédiée avec rôle de migration distinct et URLs staging; refuser les URLs prod. Tester la chaîne complète et le ledger, puis répéter depuis une restauration jetable. Charger seulement des données synthétiques autorisées par `compliance/synthetic-identifiers.json` et le skill `synthetic-phi`. Vérifier RLS avec rôle non-superuser, audit triggers, indexes FK, catalogues et queues. Définir expiration/réinitialisation; aucun backup production ni PHI.

**État partiel** : outils et procédures existent, exécution/restauration staging non certifiées. Toute suite live suit les instructions Postgres privé d’AGENTS.md; jamais le cluster Docker partagé.
