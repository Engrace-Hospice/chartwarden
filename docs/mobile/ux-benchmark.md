# Benchmark UX appliqué à WardenX

## Cadre de preuve

- **Observé** : comportement ou structure vérifié dans le dépôt.
- **Pratique externe** : règle publiée par la source citée.
- **Hypothèse** : proposition WardenX à valider par recherche utilisateur et mesure terrain.

Aucun test utilisateur n’a été mené dans ce lot. Les produits comparés servent de repères, pas de
modèles à copier.

## Sources

- [Android — Layouts and navigation patterns](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns)
- [Apple HIG — Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Apple HIG — Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple HIG — Layout et safe areas](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Nielsen Norman Group — 10 usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [Dynamics 365 Field Service mobile overview](https://learn.microsoft.com/en-us/dynamics365/field-service/mobile-power-app-overview)
- [Dynamics 365 Field Service — refreshed mobile UX](https://learn.microsoft.com/en-us/dynamics365/field-service/mobile-powerapp-newux-overview)
- [Epic Rover — fiche App Store publique](https://apps.apple.com/us/app/epic-rover/id583359867)
- [Apple Healthcare — usages publics de Rover](https://www.apple.com/healthcare/hospital-care/)
- [Expo Router — navigation et anchors](https://docs.expo.dev/router/basics/navigation/)

## Recommandations majeures

| Preuve/référence | Problème WardenX concret | Règle proposée | Gain utilisateur |
|---|---|---|---|
| Observé : `primary-nav.ts` expose un catalogue métier vaste. Pratique : Android limite la navigation bar à 3–5 destinations. | Reproduire la sidebar web en bottom bar rendrait les labels illisibles et les cibles instables. | 3–5 shortcuts stables + `Modules` recherché. | Accès rapide au quotidien sans perdre les fonctions rares. |
| Pratique : Apple réserve les tab bars à la navigation, pas aux actions. | Les tabs Admissions web incluent `New Admission` et `New Referral`, qui déclenchent une création. | Retirer créations/signatures/check-in des tabs ; les rendre contextuels. | Réduit les erreurs et rend la hiérarchie prévisible. |
| Pratique : Android recommande rail sur grands écrans ; Apple réserve la sidebar aux espaces suffisants. | Une bottom bar étirée sur tablette gaspille l’espace, une sidebar téléphone masque le contenu. | Bottom bar compact, rail medium, sidebar/split view expanded. | Ergonomie adaptée à la prise en main et meilleure densité sur tablette. |
| Observé : `chart-module-rail.tsx` contient 12 sections patient. NN/g : reconnaissance plutôt que mémorisation. | Douze tabs horizontaux obligent scrolling et mémorisation, avec risque de changer de patient. | Bannière patient persistante + 5–6 groupes de sections filtrés individuellement. | Maintient le bon patient et rend les destinations reconnaissables. |
| NN/g : visibilité du statut système. Dynamics : statut/sync offline doit être consultable. | EVV offline peut réussir partiellement ; un toast global pourrait mentir. | État par événement `pending/syncing/accepted/rejected`, file visible et réconciliation. | Confiance dans la preuve EVV, pas de faux succès. |
| NN/g : prévention d’erreurs et confirmation avant engagement. | Sign, discharge, transfer, administration et correction ont des conséquences cliniques/légales. | Confirmation nommant ressource, version et conséquence ; succès après réponse serveur. | Évite actions accidentelles et ambiguïtés de version. |
| Field Service : agenda, quick actions, directions et travail assigné structurent le terrain. | Les cliniciens ouvrent d’abord la journée, pas un catalogue abstrait de modules. | My Visits/Today comme initiale terrain, avec actions de visite dans le détail. | Moins de navigation pendant la tournée. |
| Rover public : patient lists, clinical review, medication administration, specimen/vitals sur iPhone ; fonctionnalités dépendent de l’organisation. | WardenX doit viser le staff clinique complet sans supposer toutes les capacités disponibles à tous. | Patient list + contexte clinique + tâches ciblées, filtrés par permissions effectives tenant. | Parité progressive sans portail patient réduit ni faux accès par rôle. |
| NN/g : contrôle et liberté ; Expo Router : anchor pour deep links. | Un push froid vers Encounter peut laisser Back sans destination ou empiler des copies. | Route canonique + origin + anchor de module ; Back revient à l’origine ou racine sûre. | Sortie claire et aucun écran dupliqué. |
| NN/g : cohérence/standards. | Hamburger du header et tab `More` seraient deux conventions concurrentes. | Sur téléphone, convention unique `Modules`; pas de hamburger global. | Discoverability stable et état actif non ambigu. |
| Apple safe areas/Dynamic Type ; Android patterns natifs. | Formulaires longs, clavier et bottom bar peuvent masquer les CTA. | Insets natifs, CTA au-dessus du clavier, Dynamic Type, 44pt/48dp minimum. | Utilisable sur appareils compacts et avec aides d’accessibilité. |
| Observé : WardenX ne met plus la recherche PHI en query URL (`layout.tsx`). NN/g : minimalisme et prévention. | Une recherche globale persistée localement peut exposer noms/MRN. | Recherche en mémoire, pas d’index PHI local ; résultats chargés après permission. | Réduit les traces sensibles sans perdre l’accès rapide. |

## Ce que nous retenons par source

### Android

Retenir la paire largeur↔pattern et la limite 3–5 destinations. Utiliser tabs/segmented controls pour
vues sœurs, pas pour une arborescence profonde. Rejeter un drawer modal comme unique accès principal sur
téléphone : Android note lui-même le coût d’atteindre le top bar. WardenX garde un catalogue plein écran
dans la bottom bar, puis transforme ce même modèle en rail/sidebar sur grand écran.

### Apple

Retenir la stabilité de la tab bar, les labels courts, la séparation tab/navigation vs toolbar/action et
l’adaptation sidebar sur iPad. Rejeter l’overflow automatique `More` non contrôlé : WardenX possède un
catalogue `Modules` explicite et recherché, pas une liste résiduelle de tabs cachés.

### Nielsen Norman Group

Appliquer visibilité du statut aux syncs, drafts et transitions ; match système/monde réel aux labels
`My Visits`, `Referral Inbox`, `Orders`; contrôle/liberté à Back et brouillons ; prévention aux actions
critiques ; reconnaissance au Patient Workspace. Les codes techniques restent disponibles dans les
détails/support, pas comme message principal.

### Dynamics 365 Field Service

Retenir l’agenda quotidien, les actions dans le contexte d’une intervention, les directions/GPS et le
statut de sync. La documentation Microsoft souligne aussi qu’une nouvelle UX peut ne pas prendre en
charge l’offline : WardenX ne doit donc jamais déduire « mobile = offline complet ». Chaque tranche
offline reçoit un contrat et une preuve propres.

### Epic Rover et comparables cliniques

Les informations publiques établissent une orientation point-of-care : listes de patients, revue,
médication, vitals et documentation ; Apple décrit le scan patient + médicament comme mesure de sécurité.
WardenX retient le principe de vérification au point d’action et d’accès ciblé, pas les workflows ou le
design propriétaire. Le scan barcode n’est pas ajouté au périmètre sans contrat WardenX démontré.

## Hypothèses produit à tester

1. `My Visits` est la meilleure destination initiale pour la majorité des cliniciens terrain.
2. `Modules` en tab est plus discoverable qu’un hamburger pour les utilisateurs multirôles.
3. Les six groupes du Patient Workspace correspondent au modèle mental des équipes hospice.
4. Les physicians préfèrent une queue `Tasks to sign` unifiée à des inbox séparées Orders/Encounters.
5. Une bannière patient compacte suffit sur téléphone sans masquer les alertes critiques.
6. La tablette est assez présente sur le terrain pour prioriser un split view au Lot 2/3.

Mesures proposées : temps jusqu’à la prochaine visite, erreurs de patient, taux de sortie de workflow,
conflits de version, temps de signature, syncs EVV non résolues, taux de recherche dans Modules et succès
au premier essai avec VoiceOver/TalkBack.

