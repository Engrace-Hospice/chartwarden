# Révision et état du dépôt

## Baseline observée

- Branche `develop`; HEAD `31802ea5f4c746c0de6ff78e75d66f146bdd60d3` (`Typecheck`).
- Référence locale `origin/main`: `bfddd5db1c071a01cffba32b1e450a9568b2e0ba`.
- `origin/main...HEAD = 0 1`: le HEAD est un commit au-dessus de la référence locale de main.
- `git status`: `develop...origin/develop [ahead 1006]`; actualité de cette référence non vérifiée auprès de GitHub.
- Arbre de travail : `.env.example` modifié avant l’audit; préservé et non reproduit dans ce rapport.
- Diff `origin/main...HEAD`: 10 fichiers applicatifs/types/auth, 87 insertions, 10 suppressions au moment de la lecture.

## Conséquence de livraison

Le workflow trouvé publie sur `main` ou par dispatch et vise le VPS production. Il ne sélectionne pas `develop` pour un environnement test. Le SHA d’un futur staging est **indéterminé**. Choisir explicitement une révision et un processus de promotion. Les changements commis du checkout sont pris en compte, mais l’auteur et la date de publication future ne sont pas attribués. Les autres worktrees ne sont pas observables depuis ce clone.

## Sources et limites

Commandes consultées : `git branch --show-current`, `git rev-parse HEAD`, `git status --short --branch`, `git remote -v`, `git log -8`, `git merge-base HEAD origin/main`, `git rev-list --left-right --count origin/main...HEAD`, `git diff --stat`.

Aucun fetch, appel GitHub, lecture d’un vrai `.env`/secret, ni connexion au runner, GHCR ou VPS. La révision réellement déployée n’est donc pas déclarée.
