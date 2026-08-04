import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Notification preferences (`/p/:patientId/preferences`). Reads the per-channel +
// quiet-hours settings (GET /portal/notification-preferences). Each channel is reconciled server-side against
// the tenant's M36 channel availability, so a channel shown here is one the tenant actually offers. Toggling a
// channel is a PATCH on that channel's preference id (optimistic concurrency); this surface presents current
// state and the tenant's quiet-hours window.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { readError } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface Prefs {
  channels: { channel: string; enabled: boolean }[];
  quietHours?: { startHour: number; endHour: number };
}

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "Text message",
  push: "Push notification",
};

function label(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

function hour(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${period}`;
}

export function PortalNotificationPreferences(): JSX.Element {
  const client = useApiClient();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const res = await client.GET("/api/v1/portal/notification-preferences", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else setPrefs((res.data as Prefs) ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <PortalPage title="Notifications" subtitle="How your care team reaches you.">
      <PortalLoadState
        loading={loading}
        error={error}
        empty={!prefs || prefs.channels.length === 0}
        emptyTitle="No channels available"
        emptyDescription="Notification channels will appear here once your account is fully set up."
      >
        <PortalCard heading="Channels">
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.6rem",
            }}
          >
            {(prefs?.channels ?? []).map((c) => (
              <li
                key={c.channel}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <span style={{ fontSize: "0.92rem" }}>{label(c.channel)}</span>
                <StatusPill
                  tone={c.enabled ? "success" : "neutral"}
                  label={c.enabled ? "On" : "Off"}
                />
              </li>
            ))}
          </ul>
        </PortalCard>
        {prefs?.quietHours ? (
          <PortalCard heading="Quiet hours">
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              We won't send non-urgent notifications between {hour(prefs.quietHours.startHour)} and{" "}
              {hour(prefs.quietHours.endHour)}.
            </p>
          </PortalCard>
        ) : null}
      </PortalLoadState>
    </PortalPage>
  );
}
