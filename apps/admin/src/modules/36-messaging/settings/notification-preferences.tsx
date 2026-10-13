// apps/admin/src/modules/36-messaging/settings — M36 §4.2 notification preferences (`GET`/`PUT
// /api/v1/notifications/preferences`, notifications.preferences.manage; SELF-only). A routing grid (alert
// category x severity -> channels), quiet hours and vacation forwarding, saved as one PUT. A 422
// INVALID_ROUTING_MAP / 409 VACATION_FORWARD_* refusal surfaces its server message and keeps the draft.
import { Button, TextField, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
import { useCallback, useState } from "react";
import type { FormEvent, JSX } from "react";
import { humanize } from "./alert-rules";
import { toResult, useLoad } from "./api";
import { type QuietHours, QuietHoursEditor } from "./quiet-hours";
import { type Banner, BannerView, PageHead, renderLoadFallback } from "./ui";

type PreferencesView =
  operations["getApiV1NotificationsPreferences"]["responses"][200]["content"]["application/json"];
type RoutingMap = PreferencesView["routingMap"];
type Channel = RoutingMap[string][string][number];

const CATEGORIES = [
  "clinical_urgent",
  "clinical_routine",
  "operational",
  "field_safety",
  "administrative",
  "system",
];
const SEVERITIES = ["info", "warn", "critical"];
const CHANNELS: readonly Channel[] = ["in_app", "push", "sms", "email", "voice"];

interface Draft {
  routingMap: RoutingMap;
  quietHours: QuietHours;
  vacationForwardToUserId: string;
  vacationUntil: string;
}

const dateOnly = (iso: string | null): string => (iso ?? "").slice(0, 10);

const toDraft = (p: PreferencesView): Draft => ({
  routingMap: p.routingMap,
  quietHours: p.quietHours,
  vacationForwardToUserId: p.vacationForwardToUserId ?? "",
  vacationUntil: dateOnly(p.vacationUntil),
});

/** A channel toggled in/out of one (category, severity) cell, returned as a new map. */
export function toggleChannel(
  map: RoutingMap,
  category: string,
  severity: string,
  channel: Channel,
  on: boolean,
): RoutingMap {
  const current = map[category]?.[severity] ?? [];
  const next = on
    ? [...current.filter((c) => c !== channel), channel]
    : current.filter((c) => c !== channel);
  return { ...map, [category]: { ...map[category], [severity]: next } };
}

export function NotificationPreferences(): JSX.Element {
  const client = useApiClient();
  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/notifications/preferences");
    return toResult(res, "Notification preferences unavailable.");
  }, [client]);
  const { state, reload } = useLoad(load);
  const fallback = renderLoadFallback(state, {
    loadingLabel: "Loading notification preferences…",
    what: "notification preferences",
    onRetry: reload,
  });
  return (
    <div className="wx-list-drawer-main">
      <PageHead
        title="Notification preferences"
        sub="Choose how and when you are alerted. These settings apply to you only."
      />
      {fallback ?? (state.status === "ready" ? <PreferencesForm initial={state.data} /> : null)}
    </div>
  );
}

function PreferencesForm({ initial }: { initial: PreferencesView }): JSX.Element {
  const client = useApiClient();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setBanner(null);
    const res = await client.PUT("/api/v1/notifications/preferences", {
      body: {
        routingMap: draft.routingMap,
        quietHours: draft.quietHours,
        vacationForwardToUserId: draft.vacationForwardToUserId.trim() || null,
        // An untouched date keeps the server's original timestamp.
        vacationUntil:
          draft.vacationUntil === ""
            ? null
            : draft.vacationUntil === dateOnly(initial.vacationUntil)
              ? initial.vacationUntil
              : draft.vacationUntil,
      },
    });
    const result = toResult(res, "Could not save your preferences.");
    setSaving(false);
    setBanner(
      result.ok
        ? { ok: true, message: "Preferences saved." }
        : {
            ok: false,
            message: result.forbidden
              ? "You do not have access to change these preferences."
              : result.message,
          },
    );
  };

  return (
    <form className="wx-form-stack" onSubmit={(e) => void save(e)} aria-busy={saving || undefined}>
      <BannerView banner={banner} />
      <fieldset className="wx-drawer-card grid gap-4" disabled={saving}>
        <legend>Delivery channels by alert type</legend>
        {CATEGORIES.map((category) => (
          <fieldset key={category} className="grid gap-1">
            <legend>{humanize(category)}</legend>
            {SEVERITIES.map((severity) => (
              <div key={severity} className="flex flex-wrap items-center gap-2">
                <span className="w-20">{humanize(severity)}</span>
                {CHANNELS.map((channel) => (
                  <label key={channel} className="inline-flex min-h-11 min-w-11 items-center gap-1">
                    <input
                      type="checkbox"
                      className="size-5"
                      aria-label={`${humanize(category)} ${severity} via ${humanize(channel)}`}
                      checked={draft.routingMap[category]?.[severity]?.includes(channel) ?? false}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          routingMap: toggleChannel(
                            draft.routingMap,
                            category,
                            severity,
                            channel,
                            e.target.checked,
                          ),
                        })
                      }
                    />
                    {humanize(channel)}
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
        ))}
      </fieldset>
      <QuietHoursEditor
        value={draft.quietHours}
        disabled={saving}
        onChange={(quietHours) => setDraft({ ...draft, quietHours })}
      />
      <fieldset className="wx-drawer-card wx-form-stack" disabled={saving}>
        <legend>Vacation forwarding</legend>
        <TextField
          label="Forward alerts to (user ID)"
          hint="Leave empty to not forward."
          value={draft.vacationForwardToUserId}
          onChange={(e) => setDraft({ ...draft, vacationForwardToUserId: e.target.value })}
        />
        <TextField
          type="date"
          label="Forward until"
          value={draft.vacationUntil}
          onChange={(e) => setDraft({ ...draft, vacationUntil: e.target.value })}
        />
      </fieldset>
      <div className="wx-drawer-actions">
        <Button type="submit" loading={saving}>
          Save preferences
        </Button>
      </div>
    </form>
  );
}
