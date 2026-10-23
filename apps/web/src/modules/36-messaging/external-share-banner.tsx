// M36 WP 6.6 (ADR-0096 D18) - the member banner: "an outside partner can read new messages in this conversation until <date>". The fact comes from the
// channel detail the thread already reads (`externalShare`, computed live from the share table by the server for members who can view the channel),
// so a revoked or expired share disappears on the next read. It is re-read every minute while the thread is open, so a revoke is not shown as live
// for long. The banner is a persistent status region (an <output>) and is never dismissible: it describes who can read what is typed here.
import { BACKGROUND_REQUEST_HEADERS, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";

/** How often an open thread re-asks whether a partner can still read it. */
export const EXTERNAL_SHARE_BANNER_REFRESH_MS = 60_000;

interface Indicator {
  readonly expiresAt: string;
}

function untilText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function ExternalShareBanner({
  channelId,
}: { readonly channelId: string }): JSX.Element | null {
  const client = useApiClient();
  const [indicator, setIndicator] = useState<Indicator | null>(null);

  useEffect(() => {
    setIndicator(null);
    let cancelled = false;
    const read = (): void => {
      void Promise.resolve()
        .then(() =>
          client.GET("/api/v1/messaging/channels/{id}", {
            params: { path: { id: channelId } },
            headers: BACKGROUND_REQUEST_HEADERS,
          }),
        )
        .then(({ data }) => {
          if (cancelled || !data) return;
          const share = (data as { externalShare?: { active?: boolean; expiresAt?: string } })
            .externalShare;
          setIndicator(share?.active && share.expiresAt ? { expiresAt: share.expiresAt } : null);
        })
        .catch(() => undefined); // best effort: an unreadable refresh leaves what is shown
    };
    read();
    const timer = setInterval(read, EXTERNAL_SHARE_BANNER_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, channelId]);

  if (!indicator) return null;
  return (
    <output className="wx-thread-refresh-warning" data-testid="external-share-banner">
      An outside partner can read new messages in this conversation until{" "}
      {untilText(indicator.expiresAt)}.
    </output>
  );
}
