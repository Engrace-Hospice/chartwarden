// M36 offline state (06-ux-design §4): a banner while the browser reports no network. The composer stays enabled and
// messages queue as "Not sent" (use-outbox). The live region stays mounted so the text appearing in it is announced.
import { useSyncExternalStore } from "react";
import type { JSX } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** navigator.onLine, live. Optimistic (true) on the server and wherever the browser does not say. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof navigator === "undefined" || navigator.onLine !== false,
    () => true,
  );
}

export function OfflineBanner(): JSX.Element {
  const online = useOnlineStatus();
  return (
    <output className={online ? "wx-sr-only" : "wx-messaging-realtime-banner"}>
      {online ? "" : "You're offline — messages will be sent when you reconnect"}
    </output>
  );
}
