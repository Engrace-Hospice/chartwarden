// apps/backend/src/modules/31-portal/lifecycle — M31-T03. The §2.2 domain core: the portal session class
// (§8.1 `SESSION_POLICY.portal`), the §7.1 magic-link invitation state machine, the §2.3/§6.4 grant scope-
// set resolver, the §4.4/§8.2 M39 portal-access foundation gate, and the §7.5/D6 bereaved lateral flip.
//
// Everything here is PURE — injected facts in, a new state or a declarative plan out — except the two thin
// impure resolvers (`resolvePortalAccessConsent`, `resolveBereavedInWindow`) that read an already-registered
// upstream seam OPAQUELY from the M1 registry, fail-CLOSED. The route layer (M31-T07) and the §7.5/§7.6
// outbox consumers (M31-T06) execute the plans + gates inside one transaction.
export * from "./errors";
export * from "./scope-set";
export * from "./session";
export * from "./invitation";
export * from "./portal-access-gate";
export * from "./bereaved-flip";
