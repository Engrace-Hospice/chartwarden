// M36 WP 6.6 (ADR-0096 D18) - the member banner: "an outside partner has been given read access to new messages in this conversation until <date>". The fact
// comes from the channel detail the thread already reads (`externalShare`, computed live by the server for MEMBERS who can view the channel), through the
// ONE shared read in use-channel-detail.ts (the presence hook uses the same request, so opening a thread costs one). A revoked or expired share
// disappears on the next read: the banner re-reads every minute while the thread is open and visible (it pauses while the tab is hidden and reads
// again when it comes back). It clears on a 403 or 404 (the channel or the share is gone for this reader) but KEEPS what it shows through a network
// error or a server error, since nothing was learned. It says access was GRANTED, not that it is in use: a share not yet opened by the partner counts.
// The banner is a persistent status region (an <output>) and is never dismissible.
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { readChannelDetail } from "./use-channel-detail";

/** How often an open, visible thread re-asks whether a partner has been given access. */
export const EXTERNAL_SHARE_BANNER_REFRESH_MS = 60_000;

interface Shown {
  readonly channelId: string;
  readonly expiresAt: string | null;
}

function untilText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function ExternalShareBanner({
  channelId,
}: { readonly channelId: string }): JSX.Element | null {
  const client = useApiClient();
  // Tied to the channel it was read for: switching channels never shows the old channel's banner, and nothing is reset to null in between.
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      if (typeof document !== "undefined" && document.hidden) return;
      void readChannelDetail(client, channelId).then((reply) => {
        if (cancelled || reply.failed) return; // offline or aborted: keep what is shown
        if (reply.status === 403 || reply.status === 404) {
          setShown({ channelId, expiresAt: null });
          return;
        }
        if (!reply.data) return; // a server error: nothing learned, keep what is shown
        const share = (reply.data as { externalShare?: { active?: boolean; expiresAt?: string } })
          .externalShare;
        setShown({
          channelId,
          expiresAt: share?.active && share.expiresAt ? share.expiresAt : null,
        });
      });
    };
    read();
    const timer = setInterval(read, EXTERNAL_SHARE_BANNER_REFRESH_MS);
    const onVisible = (): void => {
      if (!document.hidden) read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, channelId]);

  if (!shown || shown.channelId !== channelId || !shown.expiresAt) return null;
  return (
    <output className="wx-thread-refresh-warning" data-testid="external-share-banner">
      An outside partner has been given read access to new messages in this conversation until{" "}
      {untilText(shown.expiresAt)}.
    </output>
  );
}
