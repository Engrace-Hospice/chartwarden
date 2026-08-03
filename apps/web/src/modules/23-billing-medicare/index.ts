// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare web slice (R2, ADR-0030, §10 PR-J).
// Screens are lazy-loaded inside ./screens (TASK-033) — this barrel exports ONLY the registration
// object. Re-exporting each screen component here too would give it a second, static import path
// alongside screens.ts's dynamic one, which defeats the route-level code-splitting (Rollup/Vite
// merges a module into whichever chunk reaches it statically, even via an otherwise-unused re-export).
export { billingScreens } from "./screens";
