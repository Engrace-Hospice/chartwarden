# Web, administration, portail et mobile

- Workspaces détectés : `apps/web`, `apps/admin`, `apps/portal`, `apps/backend`; `Dockerfile.web` et service web prod existent.
- `VITE_API_PROXY_TARGET`, `VITE_PORTAL_BASE` sont build/dev; `TENANT_BASE_DOMAIN` influe le routage. Construire contre les seules URLs staging.
- Redirect auth, cookies, CORS, uploads/téléchargements signés et WebSocket exigent un domaine réel et une vérification externe.
- Aucun `apps/mobile` ou workspace mobile natif détecté; support React Native non établi par ce checkout.
- Tests DOM ne prouvent pas login Internet, parcours cross-origin ou compatibilité appareils.

**Web : partiel. Mobile : non vérifié.** Tester auth, navigation, console réseau, cookies, upload/scanning/download, reauth/CSRF et tenants par domaine, uniquement en synthétique.
