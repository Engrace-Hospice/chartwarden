# Matrice de portes de préparation

| Porte | État | Preuve/manque |
|---|---|---|
| SHA et branche staging | **FAIL** | checkout `develop`; deploy vise `main`, aucun staging identifié |
| Séparation hôte/réseau/volume/secrets | **FAIL / inconnu** | cible staging non documentée |
| Image immutable du SHA choisi | **PARTIAL** | publication SHA prod existe, image staging non choisie |
| CI complet sur SHA | **FAIL** | job verify dérogé jusqu’au 29 nov. 2026 |
| Secrets fail-closed sans réutilisation prod | **PARTIAL** | validation app existe; injection staging inconnue |
| DB/Redis privés et données synthétiques | **PARTIAL** | patterns existent, cible non prouvée |
| Migrations et restore rehearsal | **FAIL / non vérifié** | procédure prod, pas staging |
| Login/MFA/domaines/isolation tenant | **PARTIAL** | contrôles code; IdP/DNS/cookies et test externe absents |
| Intégrations externes sûres | **PARTIAL** | flags présents, config effective inconnue |
| Workers/schedules/idempotence | **PARTIAL** | code présent; opération et heartbeat non certifiés |
| TLS/CORS/WebSocket/uploads | **FAIL / non vérifié** | prod documenté, staging absent |
| Mobile API | **NOT VERIFIED** | app mobile non détectée |
| Observabilité/on-call staging | **FAIL / partiel** | probes présents, monitoring non prouvé |
| Procédure d’effacement/reset staging | **FAIL** | pas de procédure cible identifiée |
| Aucun déploiement effectué | **PASS** | audit statique |

Ne pas ouvrir aux testeurs tant que les FAIL sont fermés et inconnus vérifiés.
