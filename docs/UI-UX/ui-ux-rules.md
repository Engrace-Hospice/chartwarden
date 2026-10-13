# Convergence UI/UX — `apps/portal` vers `apps/web`

Date de décision : 2026-10-13  
Statut : lot 0 adopté — baseline de conception pour les lots d'implémentation suivants  
Périmètre : présentation et expérience utilisateur de `apps/portal`; aucun changement de contrat
API, d'autorisation, de RLS, d'audit ou de périmètre PHI

## 1. Décision

`apps/portal` adopte le langage visuel actuellement rendu par `apps/web` : palette clinique
bleu/ardoise, typographie, hiérarchie de surfaces, rayons, bordures, ombres, états, focus et
composants partagés. Cette convergence ne transforme pas le portail en interface EHR pour le
personnel.

Le portail conserve son propre modèle d'expérience :

- une lecture calme, principalement mono-colonne;
- une navigation courte centrée sur la personne accompagnée;
- une densité plus faible que les écrans opérationnels du personnel;
- de grandes cibles tactiles et un texte lisible pour un public âgé ou malvoyant;
- un langage simple, compatissant et non technique;
- un accès persistant au contact hospice/24 h, sans présenter la messagerie comme un canal
  d'urgence;
- la minimisation des données de santé et les restrictions de consentement existantes.

Cette décision complète le programme général dans
[`redesign-plan.md`](./redesign-plan.md). Elle ne rouvre pas les phases déjà terminées de ce plan :
elle traite uniquement la dérive apparue entre les styles actuels de `apps/web` et la couche locale
de `apps/portal`.

## 2. Sources et règle d'arbitrage

L'ordre d'autorité du dépôt reste inchangé :

1. l'architecture et les règles de sécurité;
2. les spécifications d'écran et le pattern `Portal Dashboard` pour la structure et les usages;
3. `docs/design/DESIGN.md` pour l'intention visuelle;
4. les composants et tokens réellement livrés pour les détails d'implémentation.

Pour cette convergence, le rendu actuel de `apps/web` est la **baseline visuelle pratique**. Cette
précision est nécessaire parce que `DESIGN.md` décrit encore par endroits l'ancienne palette
Lantern indigo/papier et la règle historique « No-Line », tandis que `apps/web/src/index.css` porte
la refonte adoptée bleu/ardoise avec des cartes à bordure fine.

En cas d'écart :

- une exigence de sécurité, d'accessibilité ou de confidentialité gagne toujours;
- la structure du portail reste celle du pattern `Portal Dashboard`, pas celle de l'App Shell du
  personnel;
- pour une couleur, une police, une bordure, un rayon ou une ombre, la valeur calculée dans
  `apps/web` est la cible jusqu'à la réconciliation explicite de `DESIGN.md`;
- aucune valeur visuelle ne doit être copiée dans un écran : elle passe par un token ou une
  primitive partagée;
- une différence intentionnelle du portail doit être nommée et justifiée dans ce document ou dans
  la spécification d'écran concernée.

## 3. Matrice de convergence

| Domaine | Commun avec `apps/web` | Spécifique à `apps/portal` |
| --- | --- | --- |
| Couleurs | Palette light/dark, couleurs sémantiques, contrastes et focus. | Aucune palette parallèle; les surfaces peuvent être composées avec plus d'espace et moins de densité. |
| Typographie | Familles, échelle de base, chiffres tabulaires et mono pour les identifiants. | Corps et contrôles au moins aussi lisibles que `web`; pas de typographie dense de tableau par défaut. |
| Composants | Button, champs, alertes, pills, cartes, états loading/error/empty, dialogues et feedback. | Variantes de composition patient/famille uniquement lorsqu'une primitive commune ne suffit pas. |
| États | Même taxonomie success/warning/error/alert/progress/neutral, avec texte ou glyph en plus de la couleur. | Explications en langage courant; ne pas exposer les codes internes ni la terminologie clinique inutile. |
| Focus et mouvement | Même anneau de focus, chemin clavier complet et respect de `prefers-reduced-motion`. | Cibles tactiles de 44 px minimum sur toutes les actions du portail. |
| Thème | Même stratégie light/dark, préférence système et choix persistant non-PHI. | Le contrôle de thème peut vivre dans le menu de compte plutôt que dans le header principal. |
| Shell | Même identité de marque, rythme, surfaces et états interactifs. | Header compact, navigation courte, contexte patient et aide; aucune sidebar métier de `web`. |
| Navigation | Liens sémantiques, `aria-current`, focus visible et état actif non fondé sur la couleur seule. | Dashboard, visites, messages, documents et compte; navigation mobile adaptée à ce petit ensemble. |
| Pages | Même Page Header, cartes et feedback lorsqu'ils conviennent. | Colonne de lecture calme; actions secondaires; pas de Work Queue ou rail clinique par défaut. |
| Tableaux | Sémantique, alignement, overflow sûr et cellules accessibles communs. | Sur petit écran, préférer des cartes/lignes empilées présentant d'abord l'information utile. |
| Contenu sensible | Guardrail, Sensitivity et Consent visibles; aucune révélation silencieuse. | DTOs minimisés et formulations familiales; un contenu non partagé est expliqué sans révéler son existence au-delà de ce qui est autorisé. |
| Urgence | Alertes accessibles et non fondées sur la couleur seule. | Contact hospice/24 h disponible sur chaque écran authentifié; le portail et la messagerie ne sont jamais présentés comme services d'urgence. |

## 4. Éléments expressément exclus de la copie de `web`

Les éléments suivants ne font pas partie de la convergence :

- sidebar de modules et groupes Clinical/Revenue/Admin/Platform;
- recherche globale de dossiers;
- notifications opérationnelles destinées au personnel;
- densité des Work Queues, rails de contexte clinique et tableaux multi-colonnes;
- commandes, permissions ou informations qui ne sont pas déjà exposées par les routes portail;
- terminologie interne, identifiants techniques ou données PHI ajoutés pour remplir une maquette;
- persistance de données patient dans l'URL ou le stockage navigateur.

## 5. Écrans de référence

Les écrans ci-dessous forment la baseline du chantier. Ils doivent être comparés dans les deux
thèmes et aux largeurs 1440 px, 768 px et 390 px. Les captures sont des artefacts de recette, pas
une nouvelle source d'autorité; elles seront régénérées à chaque lot qui modifie leur rendu.

| Priorité | Écran | Route | Ce que la référence doit valider |
| --- | --- | --- | --- |
| P0 | Connexion | `/` | Marque, carte d'authentification, champs, focus, erreur, lien magique, mot de passe et MFA. |
| P0 | Sélection du patient | `/patient-picker` | Grande cible tactile, relation d'accès, état d'ouverture et absence d'accès. |
| P0 | Dashboard | `/p/:patientId` | Header portail, contexte patient, cartes de synthèse, prochaine visite, liens rapides et contact 24 h. |
| P1 | Visites | `/p/:patientId/visits` | Liste/table responsive, statuts, date/heure, téléconsultation et actions. |
| P1 | Messages | `/p/:patientId/messages` | Composer, aide « pas pour les urgences », validation, envoi et feedback. |
| P1 | Documents | `/p/:patientId/documents` | Liste responsive, statut de partage et action de consultation/téléchargement. |
| P2 | Compte | `/account` | Navigation secondaire, préférences, sécurité et contrôle du thème. |

Les scénarios de données à conserver pour la recette sont :

- chargement;
- erreur récupérable;
- vide global;
- contenu nominal;
- contenu long ou traduit;
- action en cours et action refusée;
- thème clair et sombre;
- zoom 200 % et navigation au clavier.

La capture historique
`docs/audits/live-browser-audit-2026-08-07/screenshots/06-portal-login.jpg` documente seulement
l'état antérieur de la connexion. Elle ne constitue pas une cible visuelle. Les autres écrans
nécessitent une session portail et des fixtures autorisées; aucune donnée de production ne doit
être utilisée pour fabriquer une baseline.

## 6. Règles UI/UX obligatoires

1. Une action de navigation est un lien; une action sur l'état courant est un bouton.
2. Chaque contrôle interactif du portail offre une cible d'au moins 44 × 44 px.
3. Aucun statut, sélection ou niveau de gravité n'est exprimé par la couleur seule.
4. Le focus clavier est toujours visible et l'ordre de tabulation suit l'ordre de lecture.
5. Les titres suivent une hiérarchie sans saut artificiel et chaque écran possède un seul `main`.
6. Les écrans pré-session restent hors du shell authentifié.
7. Les écrans authentifiés rendent le contexte patient et l'aide 24 h accessibles sans imposer la
   densité du shell personnel.
8. Les tables ne provoquent jamais de débordement de page. Leur représentation mobile privilégie
   les informations essentielles et conserve des intitulés accessibles.
9. Loading, error, empty et success sont explicites et annoncés lorsque leur changement est
   asynchrone.
10. Une action désactivée par une règle métier explique pourquoi; une action irréversible conserve
    sa confirmation ou sa cérémonie.
11. Aucun hexadécimal, espacement structurel récurrent ou style d'interaction nouveau n'est ajouté
    directement dans un écran si un token ou une primitive partagée couvre le besoin.
12. Les textes destinés au patient ou à la famille n'affichent ni code d'erreur interne ni jargon
    réglementaire sans explication.

## 7. Contrat de capture et de revue

Une capture de référence valide doit indiquer dans son nom ou ses métadonnées :

- l'écran et l'état;
- le viewport;
- le thème;
- le type de fixture, jamais une identité réelle;
- le commit source.

Format recommandé :

```text
portal-<screen>-<state>-<viewport>-<theme>.png
```

Exemples :

```text
portal-dashboard-content-1440-light.png
portal-dashboard-content-390-dark.png
portal-messages-error-390-light.png
```

La recette humaine vérifie au minimum : hiérarchie, compréhension en langage courant, priorité des
actions, absence de PHI supplémentaire, lisibilité mobile, clavier, zoom et contact 24 h. Les
captures seules ne prouvent ni le comportement responsive intermédiaire, ni l'accessibilité, ni
les permissions.

## 8. Critères de sortie du lot 0

Le lot 0 est terminé lorsque :

- `apps/web` est explicitement accepté comme baseline visuelle pratique;
- les différences intentionnelles du portail sont recensées;
- les éléments à ne pas copier du shell personnel sont explicites;
- les écrans, états, thèmes et viewports de référence sont définis;
- le contrat de capture exclut toute donnée de production;
- les lots suivants peuvent modifier tokens et composants sans rediscuter la direction générale;
- aucune modification fonctionnelle ou applicative n'a été introduite par ce lot.

## 9. Décisions reportées aux lots suivants

Les choix suivants ne bloquent pas la baseline et seront tranchés pendant leur lot propriétaire :

- emplacement exact du sélecteur de thème dans le shell portail;
- menu mobile ou barre de navigation inférieure;
- représentation mobile exacte de chaque tableau;
- outillage définitif de capture et de comparaison visuelle.

Ces décisions doivent respecter la matrice ci-dessus et ne peuvent pas réintroduire une palette,
un design system ou un shell concurrent.

## 10. Journal d'implémentation

### Lots 1 et 2 — 2026-10-13

- Les tokens light/dark de `apps/portal` ont été alignés sur la palette clinique de `apps/web`,
  y compris les variantes accessibles des pills et la palette data-viz.
- Les tokens restent définis localement dans chaque application, conformément aux contraintes
  Tailwind et au rôle canonique du `@theme` de `apps/web`.
- `arch:design-tokens` compare désormais les contrats partagés de `apps/admin` et `apps/portal`
  à celui de `apps/web`; une valeur manquante ou différente fait échouer le gate.
- Les defaults HTML, contrôles, focus, tableaux, nombres tabulaires et mouvement réduit ont été
  extraits dans `packages/ui/src/web/styles/base-elements.css`.
- `app-shell.css` ne contient plus que le shell destiné au personnel; le portail n'importe pas ce
  shell.
- Le portail initialise le thème avant le premier rendu et applique un minimum de 44 px aux
  boutons et contrôles de formulaire, y compris sur les routes d'authentification sans chrome.

### Lots 3 et 4 — 2026-10-13

- Le shell authentifié possède désormais une marque, une navigation courte centrée sur les quatre
  destinations principales, un état actif et un lien de compte distinct.
- La navigation patient n'apparaît qu'une fois un patient sélectionné. Le bandeau de contexte ne
  révèle aucune PHI supplémentaire et permet de changer de personne.
- Sur mobile, la navigation reste visible sous forme de barre horizontale défilable, sans menu
  masqué ni interaction JavaScript supplémentaire.
- L'aide urgente 24 h est portée par le shell et reste donc disponible sur tous les écrans avec
  chrome; le doublon auparavant limité au dashboard a été supprimé.
- Le shell fournit un lien d'évitement et un unique repère `main`; les routes d'authentification
  conservent leur rendu sans chrome.
- `PortalPage`, `PortalCard` et `PortalLoadState` utilisent maintenant la hiérarchie et les
  composants partagés. Une erreur de chargement est annoncée comme erreur, et non plus présentée
  comme un état vide.

### Lot 5 — 2026-10-13

- Les trois parcours P0 — connexion, sélection de patient et dashboard — utilisent maintenant la
  même hiérarchie bleu/ardoise, les mêmes surfaces et les mêmes états interactifs que la baseline.
- La connexion reste sans chrome et sans PHI. Ses actions occupent toute la largeur de la carte et
  l'aide rappelle de ne jamais partager mot de passe ou code d'authentification.
- Le sélecteur de patient utilise de grandes options tactiles, associe explicitement le détail du
  droit d'accès à chaque bouton et propose une relance après erreur.
- Le dashboard emploie les cartes partagées, une grille responsive de synthèse, une liste de
  rendez-vous lisible et des liens rapides sémantiques. Son erreur est désormais récupérable.
- Des fixtures exclusivement synthétiques couvrent le rendu nominal des DTO minimisés; aucun champ
  clinique ni contrat API supplémentaire n'a été introduit.

### Lots 6 et 7 — 2026-10-13

- Les écrans prioritaires Visites et Documents conservent une table sémantique sur grand écran et
  deviennent, sous 640 px, des cartes empilées dont chaque valeur garde un libellé explicite.
- Les actions Join, Download et Upload utilisent les états, focus et cibles tactiles du portail;
  l'upload conserve sa cérémonie et ses contraintes serveur existantes.
- Le composer de Messages emploie les champs, boutons et alertes partagés, expose l'aide urgente via
  `aria-describedby` et annonce l'envoi en cours.
- Les erreurs de chargement de Visites, Messages, Documents et Compte proposent une relance sans
  changer les contrats API.
- Le choix de thème est placé dans Compte, persisté localement comme préférence non-PHI et exprimé
  par un bouton à état accessible.
- La recette DOM couvre les libellés mobiles, la téléconsultation, le composer, les documents et la
  persistance du thème à partir de fixtures synthétiques.

### Lots 8 et 9 — 2026-10-13

- Les écrans secondaires Plan de soins, Médicaments, Corrections, Préférences, Deuil et
  Téléconsultation ont été ramenés aux primitives, rythmes et états partagés du portail.
- Les tableaux Médicaments et Corrections héritent du même comportement desktop/mobile libellé que
  Visites et Documents.
- Les formulaires sensibles utilisent les champs partagés, signalent leur progression et conservent
  les décisions serveur : attestation caregiver, demande de correction et consentement téléconsultation.
- Le retrait du programme de deuil annonce désormais aussi les erreurs serveur au lieu d'échouer
  silencieusement.
- La salle vidéo s'adapte à la hauteur disponible et conserve le token fournisseur dans l'iframe;
  aucun lien direct vers le fournisseur n'a été ajouté.
- La recette finale couvre les données mobiles, les formulaires sensibles et le consentement avant
  activation de Join à partir d'identifiants et de contenus exclusivement synthétiques.
