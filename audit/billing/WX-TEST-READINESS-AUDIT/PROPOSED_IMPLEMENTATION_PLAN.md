# Phases proposées

## TEST-ENV-1 — Révision, séparation et secrets

- Objectif : choisir SHA et définir config exhaustive dédiée.
- Travaux : fiche variable par variable, secret store staging, validation anti-production, sorties externes fermées, aucun secret dans build args.
- Dépendances : responsable infra, hébergement et domaine choisis.
- Acceptation : config validée, aucune valeur prod; boot refuse endpoint/credentials interdits.
- Vérification : schémas avec fixtures, consulter métadonnées de secret seulement.
- Risque : clés partagées/destinations réelles. Accès manuel : secret store, GitHub environments.

## TEST-ENV-2 — Infrastructure, CI/CD et DB

- Objectif : cible isolée et publication SHA staging seulement.
- Travaux : host/projet/volumes/réseaux, TLS, firewall, compose staging, workflow gate complet, migration et restore.
- Acceptation : aucune DB/Redis/S3 publique; workflow sans secrets/environment production; CI vert.
- Vérification : rendu avec fixtures et revue des ports sans connexion prod.
- Risque : collision de volume ou exécution deploy prod. Accès manuel : hôte, DNS, GHCR/GitHub.

## TEST-ENV-3 — Garde-fous, comptes et données

- Objectif : valider fonctions sans transaction ni PHI réelle.
- Travaux : tenant synthétique, comptes test, simulateurs ou sandbox confirmée, blocage deny-by-default des sorties.
- Acceptation : tests anti-live, logs sans secret/PHI, jobs confinés.
- Vérification : mock endpoints/queues et vérification de destination sans exposer credentials.
- Risque : sandbox absente. Accès manuel : responsable fournisseur seulement si intégration retenue.

## TEST-ENV-4 — Déploiement internet et smoke/E2E

- Objectif : service accessible uniquement aux testeurs autorisés.
- Travaux : deploy SHA, migrations, auth/web/API, worker, fichiers, RLS, sauvegardes et alertes.
- Acceptation : matrice PASS; restore drill et arrêt/effacement testés.
- Vérification : E2E synthétiques, pas d’action vendor live.
- Risque : exposition PHI, coûts et queues résiduelles. Accès manuel : opérateur staging.
