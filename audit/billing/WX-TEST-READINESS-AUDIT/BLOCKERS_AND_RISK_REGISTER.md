# Blocages et risques

| Priorité | Risque | Fermeture requise |
|---|---|---|
| P0 | Staging isolé et chemin de livraison absents | hôte, domaine, réseau, volumes, secrets et workflow dédiés/revus |
| P0 | SHA à tester non décidé; HEAD local `develop` un commit au-dessus de `origin/main` | choisir SHA exact; CI/image attestée sur cette révision |
| P0 | CI complet temporairement dérogé dans deploy jusqu’au 29-11-2026 | gate CI complet staging; aucun accès au workflow/host prod |
| P0 | Configuration effective d’intégrations inconnue | credentials/routes prod bloqués par config et réseau; sandbox documentées |
| P1 | Compose local a credentials de démonstration | ne pas exposer; secret store et valeurs uniques staging |
| P1 | Migration/restauration et jeu synthétique non éprouvés | rehearsal DB jetable et politique synthétique/retention |
| P1 | Domaines, TLS, cookies, CORS, proxy et IdP inconnus | infra et parcours auth externe testés |
| P1 | Monitoring/heartbeat worker incomplets | alertes indépendantes et état runtime vérifiable |
| P2 | Client mobile introuvable | confirmer dépôt client séparé ou scope exclu |
| P2 | `.env.example` est pré-modifié dans l’arbre | préserver et isoler ce diff avant toute livraison |

Aucun secret, hôte, domaine ou identifiant réel n’est consigné.
