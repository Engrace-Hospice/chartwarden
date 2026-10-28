// apps/web/src/modules/02-identity — M2 Identity web slice (Track A, ADR-0030).
export { identityScreens } from "./screens";
export { appLandingScreens } from "./app-landing-screens";
export { isAppLandingHost } from "./tenant-info";
// ScreenLock is deliberately NOT re-exported: main.tsx lazy-loads it so the better-auth client stays out of the entry (#849).
export { CredentialStateGuard } from "./credential-state-guard";
