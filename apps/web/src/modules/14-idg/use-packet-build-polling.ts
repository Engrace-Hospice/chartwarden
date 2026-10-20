// apps/web/src/modules/14-idg — polling while the background packet build runs.
//
// The build is a worker job: the POST returns a `packets_building` view and the status later becomes
// `packets_ready`. Poll the caller's quiet `poll` until the status leaves `packets_building`, give up after
// PACKET_BUILD_STALE_MS (Retry build calls `restart`, which resets the clock and re-enables polling), and
// replace the "Building packets…" notice with an announcement when the build finishes.
import { useEffect, useRef, useState } from "react";
import { useLiveRefresh } from "./use-live-refresh";

/** The worker normally finishes in seconds; past this we stop polling and say so. */
export const PACKET_BUILD_STALE_MS = 3 * 60 * 1000;

export interface PacketBuildPolling {
  readonly building: boolean;
  /** Polling gave up: the build has been running longer than PACKET_BUILD_STALE_MS. */
  readonly stale: boolean;
  /** The last poll failed (we are backing off; the stale page stays on screen). */
  readonly failing: boolean;
  /** A build was (re)requested: restart the stale clock and polling. */
  readonly restart: () => void;
}

export function usePacketBuildPolling(opts: {
  readonly status: string | undefined;
  readonly poll: (signal: AbortSignal) => Promise<void>;
  readonly setNotice: (notice: string | null) => void;
}): PacketBuildPolling {
  const { status, poll, setNotice } = opts;
  const building = status === "packets_building";
  const [stale, setStale] = useState(false);
  const [epoch, setEpoch] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch is a restart trigger, not a read value
  useEffect(() => {
    setStale(false);
    if (!building) return;
    const timer = setTimeout(() => setStale(true), PACKET_BUILD_STALE_MS);
    return () => clearTimeout(timer);
  }, [building, epoch]);
  const refresh = useLiveRefresh({ enabled: building && !stale, refresh: poll });

  const wasBuilding = useRef(false);
  useEffect(() => {
    if (wasBuilding.current && !building)
      setNotice(status === "packets_ready" ? "Packets are ready." : null);
    wasBuilding.current = building;
  }, [building, status, setNotice]);

  return { building, stale, failing: refresh.failing, restart: () => setEpoch((n) => n + 1) };
}
