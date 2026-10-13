// WP 2.11 degraded-realtime state (06-ux-design §4). Shown only after the socket has been up and then dropped; a
// deployment where realtime is off (or never connected) already polls by design and must not show a warning.
import { useRef } from "react";
import type { JSX } from "react";

/** True once `connected` has been seen true and is now false. Render-pure: the ref only latches. */
export function useRealtimeDegraded(connected: boolean): boolean {
  const everConnected = useRef(false);
  if (connected) everConnected.current = true;
  return everConnected.current && !connected;
}

export function RealtimeBanner({
  degraded,
  refreshSeconds,
}: {
  degraded: boolean;
  refreshSeconds: number;
}): JSX.Element | null {
  if (!degraded) return null;
  return (
    <output className="wx-messaging-realtime-banner">
      Live updates paused — refreshing every {refreshSeconds} s
    </output>
  );
}
