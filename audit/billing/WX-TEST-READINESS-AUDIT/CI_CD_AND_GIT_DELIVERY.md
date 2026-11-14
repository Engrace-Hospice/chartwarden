# CI/CD et livraison

- `.github/workflows/deploy.yml` se déclenche sur push `main` ou `workflow_dispatch`; le job SSH déploie au VPS production.
- Les images GHCR sont liées au SHA et signées/attestées.
- Au 12 novembre 2026, le job réutilisable `verify` qui exécute le workflow CI complet est commenté (« ci-waived until 2026-11-29 »). Le job `quality` exécute `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`; tests unitaires et suites live ne bloquent pas ce chemin de release.
- `ci.yml` limite les PR à `fix/admission` dans la configuration observée; les branches `develop`/`main` sont commentées. Le workflow offre dispatch manuel et appel réutilisable.
- Aucun workflow ou environnement de livraison staging n’a été identifié. Le déploiement main ne publie pas le checkout local `develop`.
- Le fichier deploy indique que la protection de branche `main` et les protections d’environnement GitHub `production` manquent; la configuration GitHub n’a pas été consultée.

**Verdict : non prêt pour staging.** Ajouter une voie distincte avec SHA immuable, secrets/environnement staging, gate CI complet, approbation et garantie qu’elle ne peut appeler l’hôte production. Ne pas employer le workflow prod comme mécanisme de test.
