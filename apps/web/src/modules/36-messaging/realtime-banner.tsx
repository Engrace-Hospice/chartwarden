// WP 2.11 degraded-realtime state (06-ux-design §4). Shown only after the socket has been up and then dropped; a
// deployment where realtime is off (or never connected) already polls by design and must not show a warning.
import { useState } from "react";
import type { JSX } from "react";

/** True once `connected` has been seen true and is now false. */
export function useRealtimeDegraded(connected: boolean): boolean {
  const [everConnected, setEverConnected] = useState(connected);
  if (connected && !everConnected) setEverConnected(true);
  return everConnected && !connected;
}

/** The live region stays mounted so the text appearing in it is announced. */
export function RealtimeBanner({
  degraded,
  refreshSeconds,
}: {
  degraded: boolean;
  refreshSeconds: number;
}): JSX.Element {
  return (
    <output className={degraded ? "wx-messaging-realtime-banner" : "wx-sr-only"}>
      {degraded ? `Live updates paused — refreshing every ${refreshSeconds} s` : ""}
    </output>
  );
}
