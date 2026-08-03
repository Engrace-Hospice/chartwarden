// apps/web/src/shell — offline banner (TASK-033, UI-004). Driven by the browser's own
// online/offline signal via the already-built `NetworkStatusPort` (ADR-0035) — not by any single
// failed request — so it reflects "this device has no connection" rather than "one call 503'd".
// Mounted once at the very top of AppShell (outside routing/session) so it's visible no matter what
// screen is rendered underneath, including the chromeless auth flow and the system pages.
import { t, webCapabilityPorts } from "@wardenx/ui";
import { useSyncExternalStore } from "react";
import type { JSX } from "react";

function subscribe(listener: () => void): () => void {
  return webCapabilityPorts.network.subscribe(() => listener());
}

function isOnline(): boolean {
  return webCapabilityPorts.network.isOnline();
}

/** SSR/initial-render snapshot — assume online until the browser tells us otherwise. */
function isOnlineServer(): boolean {
  return true;
}

export function OfflineBanner(): JSX.Element | null {
  const online = useSyncExternalStore(subscribe, isOnline, isOnlineServer);
  if (online) return null;
  return (
    <div
      role="alert"
      style={{
        display: "block",
        background: t.warning,
        color: t.onEmphasis,
        fontFamily: t.fontSans,
        fontSize: "0.875rem",
        fontWeight: 500,
        textAlign: "center",
        padding: "0.5rem 1rem",
      }}
    >
      You’re offline — changes won’t save until your connection returns.
    </div>
  );
}
