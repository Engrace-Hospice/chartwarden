// @chartwarden/ui core — web adapters for the capability ports (ADR-0035). Browser-API backed.
// The plain-web / PWA build uses these; the native build swaps in Capacitor adapters at its
// entrypoint. No `@capacitor/*` and no `react-dom` here — this is the web side of the seam.
import type { CapabilityPorts, NetworkStatusPort } from "./ports";

const hasNavigator = typeof navigator !== "undefined";
const hasWindow = typeof window !== "undefined";

const webNetwork: NetworkStatusPort = {
  isOnline() {
    return hasNavigator ? navigator.onLine : true;
  },
  subscribe(listener) {
    if (!hasWindow) return () => {};
    const onOnline = () => listener(true);
    const onOffline = () => listener(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  },
};

/** The browser/PWA capability bundle. The native build replaces this with Capacitor adapters. */
export const webCapabilityPorts: CapabilityPorts = {
  network: webNetwork,
};
