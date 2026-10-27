import { Glyph, StatusPill, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { readError } from "./portal-format";
import { PortalLoadState, PortalPage } from "./portal-page";

interface Prefs {
  channels: { channel: string; enabled: boolean }[];
  quietHours?: { startHour: number; endHour: number };
}

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "Text messages",
  push: "Push notifications",
};
function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? "Other notification channel";
}
function hour(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 23) return "time not available";
  const period = value < 12 ? "AM" : "PM";
  return `${value % 12 || 12}:00 ${period}`;
}

export function PortalNotificationPreferences(): JSX.Element {
  const client = useApiClient();
  const { patientId = "" } = useParams();
  const [state, setState] = useState<{
    id: string;
    prefs: Prefs | null;
    loading: boolean;
    error: string | null;
  }>({ id: patientId, prefs: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ id: patientId, prefs: null, loading: true, error: null });
    void (async () => {
      try {
        const res = await client.GET("/api/v1/portal/notification-preferences", {});
        if (!active) return;
        setState({
          id: patientId,
          prefs: "error" in res ? null : ((res.data as Prefs) ?? null),
          loading: false,
          error: "error" in res ? readError(res.response?.status) : null,
        });
      } catch {
        if (active)
          setState({
            id: patientId,
            prefs: null,
            loading: false,
            error: readError(undefined),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, attempt]);

  const current = state.id === patientId;
  const prefs = current ? state.prefs : null;
  const loading = !current || state.loading;
  const error = current ? state.error : null;
  const channels = Array.isArray(prefs?.channels) ? prefs.channels : [];

  return (
    <PortalPage
      title="Notifications"
      subtitle="Review how notifications are configured for your portal access."
      width="standard"
      actions={
        <Link className="wx-portal-account-back" to="/account">
          ← Account & security
        </Link>
      }
    >
      <PortalLoadState
        loading={loading}
        error={error}
        empty={!prefs}
        emptyTitle="Preferences unavailable"
        emptyDescription="Your notification preferences are not available right now."
        onRetry={() => setAttempt((n) => n + 1)}
      >
        <div className="wx-portal-notification-intro">
          <span className="wx-portal-settings-panel__icon" aria-hidden="true">
            <Glyph name="bell" size={21} />
          </span>
          <div>
            <h2>Notification settings</h2>
            <p>
              These settings are shown for reference. To request a change, contact your hospice care
              team.
            </p>
          </div>
        </div>
        <section className="wx-portal-settings-panel" aria-labelledby="channel-settings-heading">
          <div className="wx-portal-settings-panel__heading">
            <div>
              <h2 id="channel-settings-heading">Available channels</h2>
              <p>How the portal is currently configured to notify you.</p>
            </div>
          </div>
          {channels.length ? (
            <ul className="wx-portal-notification-list">
              {channels.map((entry) => (
                <li key={entry.channel}>
                  <div>
                    <strong>{channelLabel(entry.channel)}</strong>
                    <small>
                      {entry.channel === "sms"
                        ? "Text message notifications"
                        : entry.channel === "email"
                          ? "Email notifications"
                          : "Portal notification channel"}
                    </small>
                  </div>
                  <StatusPill
                    tone={entry.enabled ? "success" : "neutral"}
                    label={entry.enabled ? "Enabled" : "Off"}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="wx-portal-supporting-copy">
              No notification channels are available for this account.
            </p>
          )}
        </section>
        {prefs?.quietHours ? (
          <section className="wx-portal-settings-panel" aria-labelledby="quiet-hours-heading">
            <div className="wx-portal-settings-panel__heading">
              <div>
                <h2 id="quiet-hours-heading">Quiet hours</h2>
                <p>Non-urgent notifications may be limited during these hours.</p>
              </div>
            </div>
            <p className="wx-portal-notification-time">
              {hour(prefs.quietHours.startHour)} – {hour(prefs.quietHours.endHour)}
            </p>
            <p className="wx-portal-settings-hint">
              This does not replace calling your care team directly for urgent needs.
            </p>
          </section>
        ) : null}
      </PortalLoadState>
    </PortalPage>
  );
}
