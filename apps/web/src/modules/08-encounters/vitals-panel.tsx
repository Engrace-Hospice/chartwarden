// apps/web/src/modules/08-encounters — §2.2 vitals capture for the visit-note composer.
// The server remains responsible for validating clinical envelopes and clinically-not-indicated semantics. Weight and height ride along
// with the vitals set (the body-measure fields), because the vitals capture is where the server stores them.
import { Button, InlineAlert, TextField, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { CSSProperties, JSX } from "react";
import { type PanelStatusListener, useReportPanelStatus } from "../../shell/panel-status";
import { TRANSPORT_MESSAGE, readableValidation } from "./compose-text";
import { eyebrow, hairline } from "./encounter-compose-styles";
import { captureVitals } from "./encounters-api";
import {
  BodyMeasureFields,
  EMPTY_BODY_MEASURES,
  bodyMeasureErrors,
  bodyMeasurePayload,
  useWeightHistory,
} from "./findings";
import { useIsMounted } from "./use-is-mounted";

const FIELDS = [
  ["bpSystolic", "BP systolic", "mmHg"],
  ["bpDiastolic", "BP diastolic", "mmHg"],
  ["heartRate", "Heart rate", "bpm"],
  ["respiratoryRate", "Respiratory rate", "breaths/min"],
  ["temperature", "Temperature", "°F"],
  ["spo2", "SpO₂", "%"],
  ["painScore", "Pain score", "0–10"],
] as const;

/** A stored weight with a number and no unit (a legacy row) is left out of the note, the history and the BMI: the author must re-enter it. */
const WEIGHT_UNIT_MISSING =
  "A weight recorded earlier on this visit has no unit, so it is left out of the note and BMI. Record it again with its unit.";

export const BODY_MEASURE_ERROR = "Correct the weight or height before recording.";
const FIELD_ERRORS_SUMMARY =
  "Some entries were not accepted. Correct the marked fields and record again.";

/** A unit is chosen beside its value and is the same finding: the server's refusal of the unit shows on the value's field. */
const VALUE_FIELD_OF: Readonly<Record<string, string>> = {
  weightUnit: "weight",
  heightUnit: "height",
  temperatureUnit: "temperature",
};
const FIELD_KEYS: ReadonlySet<string> = new Set([
  ...FIELDS.map(([key]) => key),
  "weight",
  "height",
]);

const sentence = (message: string): string => {
  const text = message.trim();
  return text === ""
    ? text
    : `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
};

/**
 * A 422's field errors placed on the fields they name (the first message per field), and the first one that names no field of this
 * panel as a sentence for the alert. The server names a field as it names it in the request (`weight`, `heightUnit`).
 */
function problemsOf(details: unknown): {
  readonly fields: Readonly<Record<string, string>>;
  readonly unplaced: string | null;
} {
  const items = Array.isArray(details) ? details : details === undefined ? [] : [details];
  const fields: Record<string, string> = {};
  let unplaced: string | null = null;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const { field, message } = item as { field?: unknown; message?: unknown };
    if (typeof field !== "string" || typeof message !== "string") continue;
    const shownOn = VALUE_FIELD_OF[field] ?? field;
    if (FIELD_KEYS.has(shownOn)) fields[shownOn] ??= sentence(message);
    else unplaced ??= readableValidation(item, message);
  }
  return { fields, unplaced };
}

export interface VitalsPanelProps {
  readonly encounterId: string;
  /** The note cannot take a write right now (finalized, being edited, or busy): every control is read-only. */
  readonly disabled: boolean;
  /** Called after the vitals were recorded, so the note preview can be refreshed. */
  readonly onSaved: () => void;
  /** Told whether the form holds unsaved input and whether the capture is in flight (see `useReportPanelStatus`). */
  readonly onStatusChange?: PanelStatusListener;
}

export function VitalsPanel({
  encounterId,
  disabled,
  onSaved,
  onStatusChange,
}: VitalsPanelProps): JSX.Element {
  const client = useApiClient();
  const mounted = useIsMounted();
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [measures, setMeasures] = useState(EMPTY_BODY_MEASURES);
  const {
    weightHistory,
    error: weightHistoryError,
    reload: rereadWeight,
  } = useWeightHistory(encounterId);
  const [error, setError] = useState<string | null>(null);
  // The server's refusals, by field: shown beside the field until that field is edited again.
  const [serverErrors, setServerErrors] = useState<Readonly<Record<string, string>>>({});
  const clearServerError = (...keys: readonly string[]): void =>
    setServerErrors((held) =>
      Object.fromEntries(Object.entries(held).filter(([k]) => !keys.includes(k))),
    );

  const dirty =
    Object.values(values).some((raw) => raw.trim() !== "") ||
    JSON.stringify(measures) !== JSON.stringify(EMPTY_BODY_MEASURES);
  useReportPanelStatus(onStatusChange, { dirty, saving: busy });

  /** Clear everything typed and any refusal shown for it. */
  function discard(): void {
    setValues({});
    setMeasures(EMPTY_BODY_MEASURES);
    setServerErrors({});
    setError(null);
  }

  async function submit(): Promise<void> {
    setError(null);
    setServerErrors({});
    if (Object.keys(bodyMeasureErrors(measures)).length > 0) {
      setError(BODY_MEASURE_ERROR);
      return;
    }
    setBusy(true);

    const body: Record<string, number | string> = { ...bodyMeasurePayload(measures) };

    for (const [key] of FIELDS) {
      const raw = values[key];

      if (raw !== undefined && raw.trim() !== "" && !Number.isNaN(Number(raw))) {
        body[key] = Number(raw);
      }
    }
    // The panel labels temperature °F; say so, or the note would state a bare number with no unit.
    if (body.temperature !== undefined) body.temperatureUnit = "f";

    try {
      const res = await captureVitals(
        client,
        encounterId,
        body as Parameters<typeof captureVitals>[2],
      );
      if (res.ok) {
        // The panel stays mounted (hidden) after it is closed: start the next set empty.
        setValues({});
        setMeasures(EMPTY_BODY_MEASURES);
        setServerErrors({});
        // A weight with no unit was left out of the note; the one just recorded may have replaced it, so ask the same read again.
        if (weightHistory?.weightUnitMissing === true) rereadWeight();
        onSaved();
      } else if (mounted.current) {
        const { fields, unplaced } = problemsOf(res.details);
        if (Object.keys(fields).length > 0) {
          setServerErrors(fields);
          setError(unplaced ?? FIELD_ERRORS_SUMMARY);
        } else {
          setError(readableValidation(res.details, res.message));
        }
      }
    } catch {
      // A dropped connection is a failure like any other: say so and give the form back, never leave it on "Recording…".
      if (mounted.current) setError(TRANSPORT_MESSAGE);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section style={vitalsPanel}>
      <header style={vitalsHeader}>
        <div>
          <div style={eyebrow}>Quick capture</div>
          <h2 style={vitalsTitle}>Visit vitals</h2>
          <p style={vitalsDescription}>
            Record the measurements available for this visit. Leave unavailable fields blank.
          </p>
        </div>
      </header>

      <div style={vitalsGrid}>
        {FIELDS.map(([key, label, unit]) => (
          <div key={key} style={vitalField}>
            <TextField
              label={label}
              value={values[key] ?? ""}
              disabled={busy || disabled}
              error={serverErrors[key]}
              onChange={(e) => {
                clearServerError(key);
                setValues((current) => ({
                  ...current,
                  [key]: e.target.value,
                }));
              }}
            />
            <span style={vitalUnit}>{unit}</span>
          </div>
        ))}
      </div>

      <div style={vitalsMeasures}>
        <BodyMeasureFields
          values={measures}
          onChange={(next) => {
            clearServerError("weight", "height");
            setMeasures(next);
          }}
          disabled={busy || disabled}
          weightHistory={weightHistory}
          serverErrors={{ weight: serverErrors.weight, height: serverErrors.height }}
        />
        {weightHistory?.weightUnitMissing === true ? (
          <InlineAlert tone="warning">{WEIGHT_UNIT_MISSING}</InlineAlert>
        ) : null}
        {weightHistoryError ? (
          <p className="wx-form-hint">{`The last visit's weight is not shown: ${weightHistoryError}`}</p>
        ) : null}
      </div>

      {error ? (
        <div style={vitalsAlert}>
          <InlineAlert tone="error">{error}</InlineAlert>
        </div>
      ) : null}

      <footer style={vitalsFooter}>
        <span style={vitalsFooterHint}>Clinical validation is applied by the server.</span>

        <span style={vitalsActions}>
          {dirty ? (
            <Button tone="secondary" onClick={discard} disabled={busy || disabled}>
              Discard entries
            </Button>
          ) : null}
          <Button onClick={() => void submit()} disabled={busy || disabled}>
            {busy ? "Recording…" : "Record vitals"}
          </Button>
        </span>
      </footer>
    </section>
  );
}

const vitalsPanel: CSSProperties = {
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
};

const vitalsHeader: CSSProperties = {
  padding: "0.9rem 1rem 0",
};

const vitalsTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 700,
};

const vitalsDescription: CSSProperties = {
  margin: "0.25rem 0 0",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const vitalsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  gap: "0.75rem",
  padding: "0.9rem 1rem",
};

const vitalsMeasures: CSSProperties = {
  padding: "0 1rem 0.9rem",
};

const vitalField: CSSProperties = {
  position: "relative",
};

const vitalUnit: CSSProperties = {
  display: "block",
  marginTop: "0.18rem",
  fontSize: "0.65rem",
  color: "var(--color-on-surface-variant)",
};

const vitalsAlert: CSSProperties = {
  padding: "0 1rem 0.75rem",
};

const vitalsFooter: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.75rem 1rem",
  borderTop: hairline,
  background: "var(--color-surface-container-low)",
};

const vitalsFooterHint: CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--color-on-surface-variant)",
};

const vitalsActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
