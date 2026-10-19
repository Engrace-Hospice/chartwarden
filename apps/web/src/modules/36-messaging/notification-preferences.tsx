// apps/web/src/modules/36-messaging - WP 4.6 (ADR-0073): "My notifications" at /messaging/preferences. The caller's OWN routing map, quiet hours
// and vacation forwarding over GET/PUT /api/v1/notifications/preferences, saved as one PUT. Urgent and designated alerts can never be silenced:
// the locked rows say so in words (quiet-hours-section.tsx), and the server enforces it whatever this form sends. Flag off = nothing here.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  TextField,
  humanizeIdentifier,
} from "@wardenx/ui";
import { useEffect, useId, useState } from "react";
import type { FormEvent, JSX } from "react";
import {
  PREFS_DENIED,
  PREFS_LOAD_FAILED,
  PREFS_OFF,
  PREFS_SAVED,
  PREFS_SAVE_FAILED,
  PREFS_SUB,
  PREFS_TITLE,
  PREFS_UNSAVED,
} from "./notification-preferences-wording";
import { QuietHoursSection } from "./quiet-hours-section";
import {
  type Channel,
  type Preferences,
  type RoutingMap,
  useNotificationPreferences,
} from "./use-notification-preferences";
import "./notification-preferences.css";

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

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number): string => String(n).padStart(2, "0");

/** The local calendar day to show in the date input: a picked bare date as is, a stored instant in the viewer's zone. */
const dateOnly = (value: string | null): string => {
  if (!value || BARE_DATE.test(value)) return value ?? "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A picked day means "until the end of that day" in the viewer's zone (a bare date would parse as 00:00 UTC and end forwarding early). */
const endOfDayInstant = (value: string | null): string | null =>
  !value ? null : BARE_DATE.test(value) ? new Date(`${value}T23:59:59`).toISOString() : value;

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
  const { view, retry, save } = useNotificationPreferences();
  let body: JSX.Element;
  if (view.status === "loading") body = <LoadingSpinner />;
  else if (view.status === "off") body = <EmptyState title={PREFS_OFF} />;
  else if (view.status === "denied")
    body = (
      <p className="wx-prefs-error" role="alert">
        {PREFS_DENIED}
      </p>
    );
  else if (view.status === "error")
    body = (
      <div className="wx-prefs-error" role="alert">
        <p>{PREFS_LOAD_FAILED}</p>
        <Button type="button" tone="secondary" size="sm" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  else body = <PreferencesForm initial={view.prefs} save={save} />;
  return (
    <div className="wx-prefs">
      <PageHeader title={PREFS_TITLE}>
        <p className="wx-prefs-note">{PREFS_SUB}</p>
      </PageHeader>
      {body}
    </div>
  );
}

function PreferencesForm({
  initial,
  save,
}: {
  initial: Preferences;
  save: (
    draft: Preferences,
  ) => Promise<{ ok: true; prefs: Preferences } | { ok: false; message: string | null }>;
}): JSX.Element {
  const [baseline, setBaseline] = useState<Preferences>(initial);
  const [draft, setDraft] = useState<Preferences>(initial);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const outcomeId = useId();
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  // Unsaved changes are guarded: the browser asks before a reload or close discards them.
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    setSaving(true);
    setOutcome(null);
    const sent: Preferences = {
      ...draft,
      vacationForwardToUserId: draft.vacationForwardToUserId?.trim() || null,
      vacationUntil: endOfDayInstant(draft.vacationUntil),
    };
    const result = await save(sent);
    setSaving(false);
    if (result.ok) {
      setBaseline(result.prefs);
      setDraft(result.prefs);
      setOutcome({ ok: true, text: PREFS_SAVED });
    } else setOutcome({ ok: false, text: result.message ?? PREFS_SAVE_FAILED });
  };

  return (
    <form
      className="wx-prefs-form"
      onSubmit={(e) => void submit(e)}
      aria-busy={saving || undefined}
    >
      <QuietHoursSection
        value={draft.quietHours}
        disabled={saving}
        onChange={(update) => setDraft((d) => ({ ...d, quietHours: update(d.quietHours) }))}
      />
      <section className="wx-prefs-card" aria-labelledby="wx-prefs-channels">
        <h2 id="wx-prefs-channels">Delivery channels by alert type</h2>
        <p className="wx-prefs-note">
          Channels you add are used in addition to the ones the platform requires for urgent
          requests; they can never replace them.
        </p>
        {CATEGORIES.map((category) => (
          <details key={category} className="wx-prefs-category">
            <summary>{humanizeIdentifier(category)}</summary>
            {SEVERITIES.map((severity) => (
              <fieldset key={severity} className="wx-prefs-severity" disabled={saving}>
                <legend>{humanizeIdentifier(severity)}</legend>
                {CHANNELS.map((channel) => (
                  <label key={channel} className="wx-prefs-check">
                    <input
                      type="checkbox"
                      checked={draft.routingMap[category]?.[severity]?.includes(channel) ?? false}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setDraft((d) => ({
                          ...d,
                          routingMap: toggleChannel(d.routingMap, category, severity, channel, on),
                        }));
                      }}
                    />
                    {humanizeIdentifier(channel)}
                  </label>
                ))}
              </fieldset>
            ))}
          </details>
        ))}
      </section>
      <section className="wx-prefs-card" aria-labelledby="wx-prefs-vacation">
        <h2 id="wx-prefs-vacation">Vacation forwarding</h2>
        <TextField
          label="Forward alerts to (user ID)"
          hint="Leave empty to not forward."
          value={draft.vacationForwardToUserId ?? ""}
          disabled={saving}
          onChange={(e) => {
            const vacationForwardToUserId = e.target.value;
            setDraft((d) => ({ ...d, vacationForwardToUserId }));
          }}
        />
        <TextField
          type="date"
          label="Forward until"
          value={dateOnly(draft.vacationUntil)}
          disabled={saving}
          onChange={(e) => {
            const vacationUntil = e.target.value;
            setDraft((d) => ({ ...d, vacationUntil }));
          }}
        />
      </section>
      <div className="wx-prefs-actions">
        <Button
          type="submit"
          loading={saving}
          aria-describedby={outcome && !outcome.ok ? outcomeId : undefined}
        >
          Save preferences
        </Button>
        {dirty ? <span className="wx-prefs-note">{PREFS_UNSAVED}</span> : null}
        <output className="wx-prefs-note" aria-live="polite">
          {outcome?.ok ? outcome.text : ""}
        </output>
        {outcome && !outcome.ok ? (
          <p id={outcomeId} className="wx-prefs-error" role="alert">
            {outcome.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
