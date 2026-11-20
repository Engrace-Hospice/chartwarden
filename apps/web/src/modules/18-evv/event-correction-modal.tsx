import {
  Button,
  Modal,
  TextAreaField,
  TextField,
  toLocalInput,
  useApiClient,
} from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import {
  type CorrectEventBody,
  type CorrectEventResult,
  type EvvEventView,
  correctEventRecord,
} from "./evv-api";

export const CORRECTION_REASON_MIN = 60;

export interface CorrectionDraft {
  readonly capturedAt: string;
  readonly latitude: string;
  readonly longitude: string;
  readonly accuracyM: string;
  readonly reason: string;
  readonly degradedAttested: boolean;
}

interface EventCorrectionModalProps {
  readonly event: EvvEventView;
  readonly open: boolean;
  readonly initialDraft?: CorrectionDraft | null;
  readonly onClose: () => void;
  readonly onDone: (result: CorrectEventResult) => void;
  readonly onStepUp: (draft: CorrectionDraft, error: unknown) => void;
}

const shell = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
} as const;
const title = { margin: 0, fontSize: "1.05rem", fontWeight: 600 } as const;
const note = { margin: 0, fontSize: "0.78rem", color: "var(--color-on-surface-variant)" } as const;
const errorText = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" } as const;
const footer = { display: "flex", gap: "0.5rem", justifyContent: "flex-end" } as const;
const row = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
  gap: "0.625rem",
} as const;

function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return toLocalInput(date);
}

function emptyDraft(event: EvvEventView): CorrectionDraft {
  return {
    capturedAt: localDateTime(event.capturedAt),
    latitude: "",
    longitude: "",
    accuracyM: "",
    reason: "",
    degradedAttested: false,
  };
}

export function EventCorrectionModal({
  event,
  open,
  initialDraft,
  onClose,
  onDone,
  onStepUp,
}: EventCorrectionModalProps): JSX.Element {
  const client = useApiClient();
  const [draft, setDraft] = useState<CorrectionDraft>(() => initialDraft ?? emptyDraft(event));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft ?? emptyDraft(event));
    setBusy(false);
    setError(null);
  }, [event, initialDraft, open]);

  const set = <K extends keyof CorrectionDraft>(key: K, value: CorrectionDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const valid =
    draft.capturedAt !== "" &&
    draft.latitude !== "" &&
    draft.longitude !== "" &&
    draft.accuracyM !== "" &&
    draft.reason.trim().length >= CORRECTION_REASON_MIN;

  const submit = async (formEvent: FormEvent): Promise<void> => {
    formEvent.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);

    const base = {
      visitId: event.visitId,
      capturedAt: new Date(draft.capturedAt).toISOString(),
      coords: { lat: Number(draft.latitude), lng: Number(draft.longitude) },
      accuracyM: Number(draft.accuracyM),
      evvDeviceId: event.evvDeviceId,
      offlineCapture: event.offlineCapture,
      ...(draft.degradedAttested ? { gpsQualityAttested: "degraded_attested" as const } : {}),
    };
    const newEvent =
      event.kind === "check_in" ? { ...base, serviceTypeCode: event.serviceTypeCode } : base;
    const body: CorrectEventBody = { newEvent, correctionReason: draft.reason.trim() };
    try {
      const result = await correctEventRecord(client, event.id, body);
      if (!result.ok) {
        const stepUp =
          result.code === "STEP_UP_REQUIRED" || result.code === "EVV_CORRECTION_STEP_UP_REQUIRED";
        if (stepUp) {
          onStepUp(draft, result.error);
          return;
        }
        setError(result.message);
        return;
      }
      onDone(result.value);
    } catch {
      setError(
        "The correction could not be submitted because the connection failed. Check the current event before retrying.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      dismissOnScrim={false}
      ariaLabel="Correct EVV event"
      ariaDescribedBy="evv-correction-impact"
      width="38rem"
    >
      <form style={shell} onSubmit={(formEvent) => void submit(formEvent)}>
        <h2 style={title}>Correct EVV event</h2>
        <p id="evv-correction-impact" style={note}>
          The original event remains unchanged. This creates a linked replacement, records your
          reason, and reopens the visit for EVV review.
        </p>
        <p style={note}>
          {event.kind === "check_in" ? "Check in" : "Check out"} · Visit {event.visitId} · Device{" "}
          {event.evvDeviceId}
        </p>

        <TextField
          label="Captured at"
          type="datetime-local"
          required
          value={draft.capturedAt}
          onChange={(e) => set("capturedAt", e.currentTarget.value)}
        />
        <div style={row}>
          <TextField
            label="Latitude"
            type="number"
            min={-90}
            max={90}
            step="any"
            required
            value={draft.latitude}
            onChange={(e) => set("latitude", e.currentTarget.value)}
          />
          <TextField
            label="Longitude"
            type="number"
            min={-180}
            max={180}
            step="any"
            required
            value={draft.longitude}
            onChange={(e) => set("longitude", e.currentTarget.value)}
          />
          <TextField
            label="Accuracy in meters"
            type="number"
            min={0}
            max={500}
            step="any"
            required
            value={draft.accuracyM}
            onChange={(e) => set("accuracyM", e.currentTarget.value)}
          />
        </div>
        <label
          style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.8rem" }}
        >
          <input
            type="checkbox"
            checked={draft.degradedAttested}
            onChange={(e) => set("degradedAttested", e.currentTarget.checked)}
          />
          I reviewed the location reading after a retake and attest to degraded GPS accuracy.
        </label>
        <TextAreaField
          label="Correction reason"
          required
          minLength={CORRECTION_REASON_MIN}
          value={draft.reason}
          onChange={(e) => set("reason", e.currentTarget.value)}
          hint={`${Math.max(0, CORRECTION_REASON_MIN - draft.reason.trim().length)} more characters required`}
        />
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!valid}>
            Create correction
          </Button>
        </div>
      </form>
    </Modal>
  );
}
