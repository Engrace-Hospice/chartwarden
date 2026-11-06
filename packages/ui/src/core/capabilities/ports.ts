// @chartwarden/ui core — native-capability ports (ADR-0035). Screens and hooks depend on these
// interfaces, NEVER on `@capacitor/*` directly. Two adapter sets fulfill them: the web adapters
// in this folder (browser APIs / graceful fallback) and the Capacitor adapters wired at the
// native entrypoint (added with the Capacitor build PR). This is what keeps `apps/web` a pure
// web build that also ships, unchanged, as a native iOS/Android app.

/** Online/offline state — drives degraded-mode + offline draft sync (DR/BCP §11.1). */
export interface NetworkStatusPort {
  isOnline(): boolean;
  /** Subscribe to connectivity changes; returns an unsubscribe fn. */
  subscribe(listener: (online: boolean) => void): () => void;
}

/**
 * The capability ports an app provides. Only `network` has a consumer today; the other ADR-0035
 * ports (geolocation, camera, biometric, secure store, push, filesystem) are added with their first
 * caller.
 */
export interface CapabilityPorts {
  network: NetworkStatusPort;
}
