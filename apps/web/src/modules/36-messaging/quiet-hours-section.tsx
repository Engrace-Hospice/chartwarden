// M36 WP 4.6 - the quiet-hours part of "My notifications": an on/off switch (role="switch" with state text), the time zone, the severity
// that still breaks through, the weekly ranges, and the LOCKED rows (text, not just an icon) that quiet hours can never silence.
import { Button, SelectField, TextField } from "@wardenx/ui";
import type { JSX } from "react";
import {
  DAY_LABELS,
  LOCKED_QUIET_ROWS,
  LOCKED_REASON,
  SEVERITY_OPTIONS,
} from "./notification-preferences-wording";
import type { QuietHours, QuietRange } from "./use-notification-preferences";

export const NEW_RANGE: QuietRange = {
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  start: "22:00",
  end: "06:00",
};

interface Props {
  readonly value: QuietHours;
  readonly disabled: boolean;
  /** Receives a functional update so rapid edits compose instead of overwriting each other. */
  readonly onChange: (update: (current: QuietHours) => QuietHours) => void;
}

export function QuietHoursSection({ value, disabled, onChange }: Props): JSX.Element {
  const on = value.ranges.length > 0;
  const setRange = (index: number, patch: (range: QuietRange) => QuietRange): void =>
    onChange((v) => ({ ...v, ranges: v.ranges.map((r, i) => (i === index ? patch(r) : r)) }));
  return (
    <section className="wx-prefs-card" aria-labelledby="wx-prefs-quiet">
      <div className="wx-prefs-switch-row">
        <h2 id="wx-prefs-quiet">Quiet hours</h2>
        <button
          type="button"
          role="switch"
          className="wx-prefs-switch"
          aria-checked={on}
          aria-label="Quiet hours"
          disabled={disabled}
          onClick={() =>
            onChange((v) => ({ ...v, ranges: v.ranges.length > 0 ? [] : [NEW_RANGE] }))
          }
        >
          {on ? "On" : "Off"}
        </button>
      </div>
      {on ? (
        <div className="wx-prefs-stack">
          <TextField
            label="Time zone"
            hint="IANA name, for example America/Chicago."
            value={value.tz}
            disabled={disabled}
            onChange={(e) => {
              const tz = e.target.value;
              onChange((v) => ({ ...v, tz }));
            }}
          />
          <SelectField
            label="Still notify me for"
            options={SEVERITY_OPTIONS}
            value={value.severityOverride}
            disabled={disabled}
            onChange={(e) => {
              const severityOverride = e.target.value as QuietHours["severityOverride"];
              onChange((v) => ({ ...v, severityOverride }));
            }}
          />
          {value.ranges.map((range, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ranges have no id; edited in place by position
            <fieldset key={index} className="wx-prefs-range" disabled={disabled}>
              <legend>Range {index + 1}</legend>
              <div className="wx-prefs-days">
                {DAY_LABELS.map((day, d) => (
                  <label key={day} className="wx-prefs-check">
                    <input
                      type="checkbox"
                      checked={range.daysOfWeek.includes(d)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setRange(index, (r) => ({
                          ...r,
                          daysOfWeek: checked
                            ? [...r.daysOfWeek.filter((x) => x !== d), d].sort()
                            : r.daysOfWeek.filter((x) => x !== d),
                        }));
                      }}
                    />
                    {day}
                  </label>
                ))}
              </div>
              <div className="wx-prefs-times">
                <TextField
                  type="time"
                  label={`Range ${index + 1} start`}
                  value={range.start}
                  onChange={(e) => {
                    const start = e.target.value;
                    setRange(index, (r) => ({ ...r, start }));
                  }}
                />
                <TextField
                  type="time"
                  label={`Range ${index + 1} end`}
                  value={range.end}
                  onChange={(e) => {
                    const end = e.target.value;
                    setRange(index, (r) => ({ ...r, end }));
                  }}
                />
                <Button
                  type="button"
                  tone="tertiary"
                  aria-label={`Remove range ${index + 1}`}
                  onClick={() =>
                    onChange((v) => ({ ...v, ranges: v.ranges.filter((_, i) => i !== index) }))
                  }
                >
                  Remove
                </Button>
              </div>
            </fieldset>
          ))}
          <div>
            <Button
              type="button"
              tone="secondary"
              onClick={() => onChange((v) => ({ ...v, ranges: [...v.ranges, NEW_RANGE] }))}
            >
              Add quiet range
            </Button>
          </div>
        </div>
      ) : null}
      <h3 className="wx-prefs-locked-title">Never silenced</h3>
      <ul className="wx-prefs-locked">
        {LOCKED_QUIET_ROWS.map((row) => (
          <li key={row.id} aria-label={`${row.label}, locked`}>
            <strong>{row.label}</strong>
            <span className="wx-prefs-lock-tag">Locked</span>
            <span>{row.delivered}</span>
            <span className="wx-prefs-note">{LOCKED_REASON}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
