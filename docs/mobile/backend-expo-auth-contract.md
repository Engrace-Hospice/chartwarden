# Contrat backend Expo / Better Auth — handoff PR C

## Portée et invariants

Ce contrat lie le repository `wardenx` à la future PR C de `wardenx-mobile`. Le mobile utilise
l’instance Better Auth existante et les routes `/api/auth/*`; il n’existe ni JWT WardenX, ni second
store de sessions, ni endpoint d’authentification mobile parallèle. Le serveur calcule l’utilisateur,
l’organisation, les rôles, les permissions, les attributs ABAC et les rooms Socket.IO. Une valeur
`organizationId`, un rôle ou une permission fourni par le client n’est jamais une autorité.

PR B prouve les contrats côté serveur. Elle ne prouve pas le transport réel iOS/Android, SecureStore,
les app links, les passkeys natifs ou les contrôles du terminal. Ces preuves appartiennent à PR C et
aux lots de sécurité mobile suivants.

## Configuration par environnement

| Élément | Développement | Staging / production |
|---|---|---|
| API `baseURL` | origine réelle du backend accessible au device, par exemple `http://localhost:3000` pour le simulateur qui peut la joindre | origine HTTPS exacte du backend déployé |
| chemin Better Auth | `/api/auth` | `/api/auth` |
| `BETTER_AUTH_URL` | origine du backend | origine HTTPS du backend |
| `TRUSTED_ORIGINS` | origines HTTP(S) exactes des SPA web | origines HTTPS exactes des SPA approuvées |
| `MOBILE_AUTH_TRUSTED_ORIGINS` | scheme de callback exact choisi pour le dev build, par exemple `wardenx-dev://` | scheme/app link exact de l’application signée, à valider humainement |
| WebAuthn | origins web résolues depuis `TRUSTED_ORIGINS` + `BETTER_AUTH_URL` | mêmes origins HTTP(S) uniquement, avec `PASSKEY_RP_ID`/`WEBAUTHN_RP_ID` |

Les schemes natifs ne vont jamais dans CORS ou dans les expected origins WebAuthn. `exp://`, `*`,
`Origin: null`, les chemins et les valeurs dérivées d’une requête sont refusés. Aucun localhost n’est
ajouté automatiquement en production. Un téléphone physique doit recevoir une URL réseau/TLS
explicitement configurée ; `localhost` ne désigne pas la machine de développement depuis ce device.

## Client Better Auth et stockage

PR C doit pinner une version client compatible avec Better Auth `1.6.25` et configurer
`better-auth/react` avec `@better-auth/expo/client` et Expo SecureStore. Le helper officiel
`authClient.getCookie()` fournit le matériel cookie Better Auth conservé par ce plugin. Le code peut
l’appeler sous une forme compatible sync/async : `await authClient.getCookie()`.

Le helper ne doit pas être supposé propriétaire du cookie applicatif `wardenx_csrf`. Le nonce CSRF
WardenX suit le protocole séparé ci-dessous. `withCredentials: true` ne suffit pas à persister ou
réémettre des cookies dans React Native : l’adaptateur fournit explicitement le header `Cookie`.

SecureStore contient seulement le matériel d’authentification Better Auth nécessaire. Le nonce CSRF
peut rester en mémoire ; s’il est persisté pour une reprise d’application, il doit utiliser SecureStore
et être purgé avec la session. AsyncStorage ne contient aucun cookie, token, nonce, PHI, réponse patient,
message ou brouillon clinique.

## Protocole CSRF natif

Le navigateur conserve son double-submit actuel. Le flux natif utilise le même contrôle, sans exemption.

1. Terminer l’étape Better Auth nécessaire et obtenir une vraie session.
2. Appeler `GET /api/v1/auth/csrf` avec `Cookie: <cookies Better Auth>`. La route accepte une session
   pré-organisation, MFA-enrolment, changement de mot de passe requis ou auditor-enrolment lorsque cette
   classe de session peut poursuivre son parcours.
3. Exiger `200`, `Cache-Control: no-store, max-age=0` et un body `{ "token": "<64 hex>" }`. Le serveur
   émet aussi `Set-Cookie: wardenx_csrf=<token>; Path=/; SameSite=Lax[; Secure]`. Le client natif utilise
   le body comme source explicite, car l’accès React Native à `Set-Cookie` varie selon le transport.
4. Pour chaque `POST`, `PUT`, `PATCH` ou `DELETE` protégé sous `/api/v1/*`, construire :

   ```http
   Cookie: <cookies Better Auth>; wardenx_csrf=<token>
   X-CSRF-Token: <token>
   ```

   Les deux valeurs doivent être strictement identiques. Ne jamais envoyer le nonce dans l’URL.
5. Réamorcer après login, reprise froide, perte du nonce, remplacement de session, erreur
   `CSRF_VALIDATION_FAILED`, et avant une mutation si l’état local est incertain. Une sélection
   d’organisation réussie conserve la session mais doit être suivie d’une relecture du contexte ; un
   nouvel amorçage CSRF est permis et recommandé.
6. Sur erreur CSRF, réamorcer une seule fois. Rejouer automatiquement seulement une requête démontrée
   idempotente. Une signature, un check-in/out, une transition clinique ou toute commande au résultat
   ambigu reste « résultat à vérifier » et exige une lecture REST ou une action utilisateur.

Sans session Better Auth valide, le bootstrap répond `401` et ne donne aucun accès. Une mutation avec
cookie de session mais nonce absent, nouvellement émis ou différent répond `403` avec l’enveloppe
`CSRF_VALIDATION_FAILED`. `503 CSRF_BOOTSTRAP_UNAVAILABLE` indique une mauvaise composition serveur ;
le client ne contourne jamais la protection.

## Séquence d’authentification

1. Login username + password par Better Auth sous `/api/auth/*`.
2. Satisfaire le challenge TOTP ou l’enrôlement demandé. Les backup codes sont le fallback prévu.
   Les passkeys navigateur restent disponibles, mais le passkey natif n’est pas déclaré fonctionnel.
3. Amorcer CSRF dès qu’une vraie session existe.
4. Lire `GET /api/v1/auth/credential-status`. Si `passwordChangeRequired`, exécuter uniquement le
   parcours autorisé et `POST /api/v1/auth/password/complete-required-change` avec double-submit.
5. Lire `GET /api/v1/auth/memberships`. Sélectionner une organisation avec
   `POST /api/v1/auth/select-organization`, toujours avec double-submit. La liaison est one-shot :
   `ORG_ALREADY_BOUND` est attendu au second essai. Modifier seulement un identifiant local ne change
   jamais de tenant ; un changement d’organisation exige aujourd’hui sign-out puis réauthentification.
6. Lire `GET /api/v1/auth/context` et construire l’interface à partir des permissions effectives.
   Les rôles ne servent qu’aux raccourcis.
7. Au foreground ou après reconnexion, vérifier la session, réamorcer CSRF si nécessaire, puis relire
   le contexte. Le verrou biométrique client ne prolonge pas la session serveur.
8. Pour logout, fermer Socket.IO, appeler le sign-out Better Auth, puis purger cookies Better Auth,
   nonce CSRF, stores, cache et brouillons. Une révocation ou expiration reçue en `401` déclenche la
   même purge locale.

Les sessions limitées, le timeout inactif, les maxima de classe, le changement de mot de passe, MFA,
step-up et la révocation restent inchangés. Pour une signature ou autre action sensible, le client
effectue le step-up serveur puis reprend l’intention sans rejouer aveuglément la commande.

## Adaptateur Axios documentaire

Ce pseudocode décrit PR C ; aucun code React Native n’est livré dans ce repository :

```ts
async function authHeaders(mutating: boolean) {
  const betterAuthCookie = await authClient.getCookie();
  if (!mutating) return { Cookie: betterAuthCookie };

  const csrf = await csrfStore.requireCurrent();
  return {
    Cookie: `${betterAuthCookie}; wardenx_csrf=${csrf}`,
    "X-CSRF-Token": csrf,
  };
}
```

L’intercepteur ne journalise jamais `Cookie`, `Set-Cookie`, `X-CSRF-Token`, mot de passe, TOTP, backup
code, reset token ou body d’authentification. Utiliser des timeouts et `AbortSignal`; distinguer timeout
avant envoi et résultat serveur ambigu. Ne pas retry automatiquement une mutation sensible. Les GET
peuvent être retentés avec backoff borné lorsque leur contrat le permet.

## Erreurs et corrélation

Le client conserve l’enveloppe WardenX et le correlation ID :

| Statut | Traitement mobile |
|---|---|
| `401` | session absente, expirée ou révoquée ; fermer socket, purger, revenir à l’auth |
| `403` | lire le code : permission/ABAC, step-up, MFA/password stage ou CSRF ; ne pas les confondre |
| `409` | conflit/version ou `ORG_ALREADY_BOUND`; relire la ressource/contexte |
| `422` | afficher les erreurs de validation sur les champs ou le workflow |
| `423` | état verrouillé ; présenter la raison autorisée et ne pas retry en boucle |
| `503` | indisponibilité ; conserver une intention non sensible seulement si son contrat le permet |

Le correlation ID peut être envoyé/généré selon le client partagé et affiché au support. Il ne doit pas
contenir d’identité, tenant ou PHI.

## Socket.IO

La connexion utilise la même session : fournir les cookies Better Auth dans `extraHeaders.Cookie` du
handshake. Ne pas envoyer d’`organizationId`, rôle ou room comme autorité. Le serveur résout le
principal et l’organisation, attribue les rooms, limite le débit et revérifie la révocation.

Une absence d’`Origin` depuis le transport natif est tolérée au niveau origine, mais elle ne donne aucun
droit : une session invalide est refusée. Si `Origin` est présent, il doit être une origine web exacte
autorisée. Les schemes mobiles ne sont pas ajoutés à la liste Socket.IO/CORS.

Après reconnexion, relire session et `/api/v1/auth/context`, puis la ressource REST concernée. Socket.IO
signale une invalidation ; il n’est pas la source persistante de vérité. Aucun événement ne transporte
de PHI dans des logs ou diagnostics.

## Handoff PR C

| Travail PR C | Critère de preuve |
|---|---|
| Choisir scheme, bundle/application IDs et app/universal links | valeurs revues par environnement, association files et callback sur builds signés |
| Configurer Better Auth Expo + SecureStore | login/reprise/logout réels iOS et Android, purge vérifiée |
| Adapter Axios | cookies Better Auth explicites, bootstrap CSRF, double-submit exact, aucun secret loggé |
| Parcours MFA/password/org/context | TOTP/backup, changement obligatoire, liaison one-shot, permissions serveur observées |
| Cycle foreground/expiration/révocation | contexte relu, session invalide purgée, mutation ambiguë non rejouée |
| Socket.IO | handshake avec vraie session, session invalide refusée, reconnexion suivie d’une relecture REST |
| Passkey natif | rester désactivé/non annoncé tant que domaines associés et cérémonies device ne sont pas prouvés |
| Contrôles terminal | preuves séparées pour biométrie, screenshot, root/jailbreak, attestation, pinning, MDM et offline chiffré |

