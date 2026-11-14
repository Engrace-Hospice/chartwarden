# Prochaines étapes

Premier choix : le SHA à tester — HEAD local `develop` (`31802ea…`) ou une révision publiée sur `main`. Le processus constaté ne déploie pas `develop` vers test; ne pas utiliser le workflow production.

1. Décider SHA, responsable, durée, population testeurs et hébergement dédié.
2. Réserver DNS/TLS, réseau, proxy et stockage staging sans partage prod.
3. Terminer TEST-ENV-1 avec responsable des secrets; ne pas mettre de secrets dans le rapport.
4. Mettre en place workflow staging avec CI complet, protection et digest immuable.
5. Préparer DB jetable, migrations, seeds synthétiques et procédure de reset.
6. Vérifier sorties réseau avec intégrations désactivées; sandbox documentées seulement.
7. Fermer la matrice et autoriser ensuite un déploiement contrôlé.

Seuls les rapports de cet audit ont été ajoutés. La modification préexistante de `.env.example` a été préservée. Aucun deploy, seed, migration ou contact d’intégration n’a eu lieu.
