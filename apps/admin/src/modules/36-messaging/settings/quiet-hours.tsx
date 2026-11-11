// apps/admin/src/modules/36-messaging/settings — quiet-hours editor for the notification preferences screen:
// time zone, the severity that breaks through quiet hours, and any number of weekly ranges.
import { Button, SelectField, TextField } from "@chartwarden/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";

export interface QuietRange {
  daysOfWeek: number[];
  start: string;
  end: string;
}
export interface QuietHours {
  tz: string;
  ranges: QuietRange[];
  severityOverride: "info" | "warn" | "critical";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SEVERITY_OPTIONS = [
  { value: "info", label: "Info and above" },
  { value: "warn", label: "Warnings and above" },
  { value: "critical", label: "Critical only" },
];
const NEW_RANGE: QuietRange = { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "22:00", end: "06:00" };

export function QuietHoursEditor({
  value,
  disabled,
  onChange,
}: {
  value: QuietHours;
  disabled: boolean;
  /** Receives a functional update so rapid edits compose instead of overwriting each other. */
  onChange: (update: (current: QuietHours) => QuietHours) => void;
}): JSX.Element {
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const removedAt = useRef<number | null>(null);
  const rangeCount = value.ranges.length;
  // Ranges are keyed by position, so removing one unmounts the LAST range's controls, and focus on them falls to the page. After a
  // removal focus goes to the Remove button now at that position, else the one before it, else the Add button.
  useEffect(() => {
    const at = removedAt.current;
    if (at === null) return;
    removedAt.current = null;
    const next = rootRef.current?.querySelector<HTMLElement>(
      `[data-quiet-remove="${Math.min(at, rangeCount - 1)}"]`,
    );
    (next ?? rootRef.current?.querySelector<HTMLElement>("[data-quiet-add]"))?.focus();
  }, [rangeCount]);
  const setRange = (index: number, patch: (range: QuietRange) => QuietRange): void =>
    onChange((v) => ({ ...v, ranges: v.ranges.map((r, i) => (i === index ? patch(r) : r)) }));
  return (
    <fieldset ref={rootRef} className="wx-drawer-card" disabled={disabled}>
      <legend>Quiet hours</legend>
      <div className="wx-form-stack">
        <TextField
          label="Time zone"
          hint="IANA name, for example America/Chicago."
          value={value.tz}
          onChange={(e) => {
            const tz = e.target.value;
            onChange((v) => ({ ...v, tz }));
          }}
        />
        <SelectField
          label="Still notify me for"
          options={SEVERITY_OPTIONS}
          value={value.severityOverride}
          onChange={(e) => {
            const severityOverride = e.target.value as QuietHours["severityOverride"];
            onChange((v) => ({ ...v, severityOverride }));
          }}
        />
      </div>
      {value.ranges.map((range, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ranges have no id; edited in place by position
        <fieldset key={index} className="wx-form-stack">
          <legend>Range {index + 1}</legend>
          <div className="wx-drawer-title-row">
            {DAYS.map((day, d) => (
              <label key={day} className="wx-action-check">
                <input
                  type="checkbox"
                  checked={range.daysOfWeek.includes(d)}
                  aria-label={`Range ${index + 1} ${day}`}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setRange(index, (r) => ({
                      ...r,
                      daysOfWeek: on
                        ? [...r.daysOfWeek.filter((x) => x !== d), d].sort()
                        : r.daysOfWeek.filter((x) => x !== d),
                    }));
                  }}
                />
                {day}
              </label>
            ))}
          </div>
          <div className="wx-drawer-title-row is-bottom">
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
              tone="tertiary"
              size="lg"
              aria-label={`Remove range ${index + 1}`}
              data-quiet-remove={index}
              onClick={() => {
                removedAt.current = index;
                onChange((v) => ({ ...v, ranges: v.ranges.filter((_, i) => i !== index) }));
              }}
            >
              Remove
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button
          tone="secondary"
          size="lg"
          data-quiet-add
          onClick={() => onChange((v) => ({ ...v, ranges: [...v.ranges, NEW_RANGE] }))}
        >
          Add quiet range
        </Button>
      </div>
    </fieldset>
  );
}
