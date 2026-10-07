import {
  Button,
  Modal,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — the §2 scale-capture form (#91).
//
// A clinician could look at a PPS timeline and could not record a PPS. The scales are the hospice
// evidence base: PPS/KPS anchor the prognosis a recertification rests on, ESAS-r is the symptom record
// the plan of care is revised against, and the significant-change events derived from them are what the
// IDG reviews.
//
// EVERY FIELD BELOW IS RENDERED FROM THE SERVER'S OWN ITEM DEFINITIONS (F-067). Nothing about PPS's five
// ordinal axes, ESAS-r's nine 0..10 items or FAST's sixteen stages is written in this file. The route
// publishes `data` as a bare object and the instrument shapes lived only as TypeScript interfaces in
// `@wardenx/assessments`, which a client cannot read — so a hand-built form would have been a duplicate
// of those shapes, free to drift from what `scoring.ts` computes over. `GET /api/v1/scales` is the
// definition, and this component is a renderer for it: a new scale's items appear here when its module
// lands, without a change to this file.
//
// THE PICKER OFFERS ONLY `recordable` SCALES. Ten of the fourteen have no registered scorer and raise
// `SCALE_SCORER_UNAVAILABLE` — a 500 — on capture, and all fourteen are in the route's own enum.
//
// THE SCORE IS THE SERVER'S (D6). Nothing here adds up an ESAS-r total; the number and its
// interpretation come back from the capture, which is what makes them the same number the significant-
// change detector keys off.
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  type AssessmentView,
  type ScaleDefinition,
  nowIso,
  recordAssessment,
} from "./assessments-api";

export interface RecordAssessmentModalProps {
  readonly open: boolean;
  readonly patientId: string;
  readonly admissionId: string;
  readonly scales: readonly ScaleDefinition[];
  /** Preselect a scale (the timeline's "record another" path); otherwise the first recordable one. */
  readonly initialScaleType?: string;
  /** GAP-123 — the encounter the capture is launched from (the encounter screen); filed on the assessment. */
  readonly sourceEncounterId?: string;
  readonly onClose: () => void;
  readonly onRecorded: (assessment: AssessmentView) => void;
}

export function RecordAssessmentModal({
  open,
  patientId,
  admissionId,
  scales,
  initialScaleType,
  sourceEncounterId,
  onClose,
  onRecorded,
}: RecordAssessmentModalProps): JSX.Element | null {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scaleType, setScaleType] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  const recordable = useMemo(() => scales.filter((s) => s.recordable), [scales]);
  const selected = recordable.find((s) => s.scaleType === scaleType) ?? null;

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setValues({});
    const preferred =
      initialScaleType && recordable.some((s) => s.scaleType === initialScaleType)
        ? initialScaleType
        : (recordable[0]?.scaleType ?? "");
    setScaleType(preferred);
  }, [open, initialScaleType, recordable]);

  if (!open) return null;

  const items = selected?.items ?? [];
  const missing = items.filter(
    (i) => i.required && (values[i.key] === undefined || values[i.key]?.trim() === ""),
  );

  /** Build the `data` payload from the item definitions — numbers as numbers, the rest as strings. */
  function dataPayload(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const item of items) {
      const raw = values[item.key];
      if (raw === undefined || raw.trim() === "") continue;
      out[item.key] = item.kind === "number" ? Number(raw) : raw;
    }
    return out;
  }

  async function submit(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await recordAssessment(client, patientId, {
      admissionId,
      scaleType: selected.scaleType,
      capturedAt: nowIso(),
      ...(sourceEncounterId ? { sourceEncounterId } : {}),
      data: dataPayload(),
    } as Parameters<typeof recordAssessment>[2]);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onRecorded(res.value);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Record an assessment"
      width="34rem"
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={title}>Record an assessment</h2>

        {recordable.length === 0 ? (
          <p style={meta}>
            No scale on this deployment has a scoring module registered, so nothing can be captured
            yet.
          </p>
        ) : (
          <SelectField
            label="Scale"
            value={scaleType}
            onChange={(e) => {
              setScaleType(e.target.value);
              setValues({});
            }}
            options={recordable.map((s) => ({ value: s.scaleType, label: s.label }))}
          />
        )}

        {selected?.licenseRequired ? (
          <p style={meta}>
            <StatusPill label="Licensed instrument" tone="warning" /> The agency's licence is
            checked by the server when this is saved; a missing or expired one is refused there.
          </p>
        ) : null}

        {items.map((item) => {
          const value = values[item.key] ?? "";
          const set = (v: string): void => setValues((prev) => ({ ...prev, [item.key]: v }));
          if (item.kind === "choice") {
            return (
              <SelectField
                key={item.key}
                label={item.label}
                value={value}
                onChange={(e) => set(e.target.value)}
                options={[
                  { value: "", label: "Select…" },
                  ...(item.options ?? []).map((o) => ({ value: o.value, label: o.label })),
                ]}
              />
            );
          }
          if (item.kind === "text") {
            return (
              <TextAreaField
                key={item.key}
                label={item.label}
                value={value}
                onChange={(e) => set(e.target.value)}
                rows={2}
              />
            );
          }
          return (
            <div key={item.key}>
              <TextField
                label={`${item.label}${item.min !== undefined ? ` (${item.min}–${item.max})` : ""}`}
                value={value}
                onChange={(e) => set(e.target.value)}
              />
            </div>
          );
        })}

        {selected ? (
          <p style={meta}>
            The score is computed by the server from these values and shown on the record afterwards
            — this form never calculates one.
          </p>
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !selected || missing.length > 0}>
            {busy ? "Recording…" : "Record"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const title = { margin: 0, fontSize: "1.05rem", fontWeight: 600 } as const;
const meta = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
} as const;
const errorText = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" } as const;
