import { Button, Modal, TextAreaField, TextField, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/13-emar — the §2.11 D11 IV-CONTINUOUS SEGMENT ceremony (F-031 / #134).
//
// A continuous infusion is not a dose, it is a SESSION: an append-only sequence of rows sharing one
// `iv_session_id` (start → (rate_change | pause→resume)* → stop). This modal records one segment of it.
//
// WHY THE FORM CHANGES SHAPE PER SEGMENT, AND WHY THAT IS NOT COSMETIC. The §2.1 mode catalog states each
// segment's required body fields, and the server validates against them: a `rate_change` without a
// `newRate` and a titration reason is not a weaker rate change, it is an unrecorded one. So the fields
// rendered here are the catalog's, per mode, and nothing is offered that the segment cannot carry.
//
// TWO REFUSALS THIS SURFACES RATHER THAN PRE-EMPTS.
//
//   • ORDERING. `IV_SESSION_GRAPH` is enforced server-side by `assertIvSegmentLegal`. The caller only ever
//     opens this modal for a segment the published session `state` accepts, so an illegal one should be
//     unreachable — but if the session moved under the clinician (another device stopped the pump), the
//     server answers ILLEGAL_IV_SESSION_TRANSITION and that is shown verbatim, not retried.
//   • TITRATION BOUNDS. A `rate_change` is checked against the ORDER's `[minRate, maxRate]`. An order that
//     states no bounds authorises no titration at all, and the refusal says so — the remedy is the
//     prescriber amending the order, which is not something this screen can or should route around.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  type IvSegmentMode,
  type RecordAdministrationBody,
  errorMessage,
  isWitnessRequired,
  recordAdministration,
} from "./emar-api";

export interface IvSegmentModalProps {
  open: boolean;
  mode: IvSegmentMode;
  medicationOrderId: string;
  /** The class the SERVER will gate on — a controlled infusion is witnessed at start / titrate / stop. */
  medClass: RecordAdministrationBody["medClass"];
  /** Absent for `iv_continuous_start`, which mints the session. */
  ivSessionId?: string;
  /** The rate the session is running at, so a titration starts from the truth rather than a blank field. */
  currentRate?: number | null;
  currentRateUnit?: string | null;
  onClose: () => void;
  onRecorded: (ivSessionId: string | null) => void;
}

const COPY: Record<IvSegmentMode, { title: string; commit: string }> = {
  iv_continuous_start: { title: "Start infusion", commit: "Start infusion" },
  iv_continuous_rate_change: { title: "Titrate infusion", commit: "Record rate change" },
  iv_continuous_pause: { title: "Pause infusion", commit: "Record pause" },
  iv_continuous_resume: { title: "Resume infusion", commit: "Record resume" },
  iv_continuous_stop: { title: "Stop infusion", commit: "Record stop" },
};

/** §2.6 D7 — the segments that begin, alter or end administration. Pause/resume change no dose and need
 *  no witness; this only decides whether to render the token field, the server decides the rest. */
const WITNESSED: readonly IvSegmentMode[] = [
  "iv_continuous_start",
  "iv_continuous_rate_change",
  "iv_continuous_stop",
];

function nowLocal(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function IvSegmentModal({
  open,
  mode,
  medicationOrderId,
  medClass,
  ivSessionId,
  currentRate,
  currentRateUnit,
  onClose,
  onRecorded,
}: IvSegmentModalProps): JSX.Element | null {
  const client = useApiClient();
  const [at, setAt] = useState(nowLocal);
  const [rate, setRate] = useState("");
  const [rateUnit, setRateUnit] = useState("");
  const [dilution, setDilution] = useState("");
  const [reason, setReason] = useState("");
  const [wastage, setWastage] = useState("");
  const [wastageReason, setWastageReason] = useState("");
  const [witnessToken, setWitnessToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isControlled = medClass === "controlled_substance";
  const needsWitness = isControlled && WITNESSED.includes(mode);

  useEffect(() => {
    if (!open) return;
    setAt(nowLocal());
    setRate(mode === "iv_continuous_rate_change" ? "" : "");
    setRateUnit(currentRateUnit ?? "");
    setDilution("");
    setReason("");
    setWastage("");
    setWastageReason("");
    setWitnessToken("");
    setError(null);
    setBusy(false);
  }, [open, mode, currentRateUnit]);

  // The §2.1 catalog's required body fields, per mode — the same list the server validates against.
  const needsRate = mode === "iv_continuous_start" || mode === "iv_continuous_rate_change";
  const needsDilution = mode === "iv_continuous_start";
  const needsReason =
    mode === "iv_continuous_rate_change" ||
    mode === "iv_continuous_pause" ||
    mode === "iv_continuous_stop";
  const mayWaste = mode === "iv_continuous_stop";

  const commitReady =
    !busy &&
    at.length > 0 &&
    (!needsRate || Number.isFinite(Number(rate))) &&
    (!needsRate || rate.trim().length > 0) &&
    (!needsDilution || dilution.trim().length > 0) &&
    (!needsReason || reason.trim().length > 0) &&
    (!needsWitness || witnessToken.trim().length > 0);

  async function commit(): Promise<void> {
    setBusy(true);
    setError(null);
    // The per-mode body, built to the catalog's field names. `previousRate` rides the titration so the
    // record reads as a change rather than as an isolated new rate.
    const data: Record<string, unknown> = {};
    if (mode === "iv_continuous_start") {
      data.infusionRate = Number(rate);
      data.infusionDilution = dilution.trim();
      if (rateUnit.trim()) data.rateUnit = rateUnit.trim();
    }
    if (mode === "iv_continuous_rate_change") {
      data.newRate = Number(rate);
      data.previousRate = currentRate ?? null;
      data.titrationReason = reason.trim();
      if (rateUnit.trim()) data.rateUnit = rateUnit.trim();
    }
    if (mode === "iv_continuous_pause") data.pauseReason = reason.trim();
    if (mode === "iv_continuous_stop") {
      data.stopReason = reason.trim();
      if (wastage.trim()) {
        data.wastageAmount = Number(wastage);
        if (wastageReason.trim()) data.wastageReason = wastageReason.trim();
      }
    }

    const body: RecordAdministrationBody = {
      medicationOrderId,
      medClass,
      mode,
      administeredAt: new Date(at).toISOString(),
      data,
      ...(ivSessionId ? { ivSessionId } : {}),
    };
    const { administration, error: err } = await recordAdministration(
      client,
      body,
      witnessToken.trim() || undefined,
    );
    setBusy(false);
    if (err) {
      setError(
        isWitnessRequired(err)
          ? "This controlled infusion needs a live witness attestation. Ask the witnessing clinician to mint a token on their own device and paste it here within 60 seconds."
          : errorMessage(err, "The infusion segment could not be recorded."),
      );
      return;
    }
    onRecorded(administration?.ivSessionId ?? ivSessionId ?? null);
  }

  if (!open) return null;
  const copy = COPY[mode];

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={copy.title}
      width="32rem"
      accent={isControlled ? t.alert : t.primary}
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={title}>{copy.title}</h2>

        <TextField
          label="Recorded at"
          type="datetime-local"
          value={at}
          required
          onChange={(e) => setAt(e.target.value)}
        />

        {needsRate ? (
          <>
            {mode === "iv_continuous_rate_change" && currentRate != null ? (
              <p style={meta}>
                Running at <strong>{currentRate}</strong>
                {currentRateUnit ? ` ${currentRateUnit}` : ""}. The order&rsquo;s titration bounds
                are enforced by the server; an order that states none authorises no rate change.
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-end" }}>
              <TextField
                label={mode === "iv_continuous_start" ? "Infusion rate" : "New rate"}
                inputMode="decimal"
                required
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                style={{ width: "100%" }}
              />
              <TextField
                label="Rate unit"
                value={rateUnit}
                placeholder="mg/hr"
                onChange={(e) => setRateUnit(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
          </>
        ) : null}

        {needsDilution ? (
          <TextField
            label="Dilution"
            required
            value={dilution}
            placeholder="morphine 1 mg/mL in NS"
            onChange={(e) => setDilution(e.target.value)}
          />
        ) : null}

        {needsReason ? (
          <TextAreaField
            label={
              mode === "iv_continuous_rate_change"
                ? "Titration reason"
                : mode === "iv_continuous_pause"
                  ? "Pause reason"
                  : "Stop reason"
            }
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        ) : null}

        {mayWaste ? (
          <>
            <TextField
              label="Wastage (optional)"
              inputMode="decimal"
              value={wastage}
              hint={
                isControlled
                  ? "Drug left in the bag and destroyed. A controlled wastage is announced on the record and carries this segment's witness."
                  : "Drug left in the bag and destroyed."
              }
              onChange={(e) => setWastage(e.target.value)}
            />
            {wastage.trim() ? (
              <TextField
                label="Wastage reason"
                value={wastageReason}
                onChange={(e) => setWastageReason(e.target.value)}
              />
            ) : null}
          </>
        ) : null}

        {needsWitness ? (
          <TextField
            label="Witness attestation token"
            required
            value={witnessToken}
            hint="Minted by the witnessing clinician on their own device. Single use, valid 60 seconds. Pause and resume need no witness — they change no dose."
            onChange={(e) => setWitnessToken(e.target.value)}
          />
        ) : null}

        {error ? (
          <p role="alert" style={alert}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={mode === "iv_continuous_stop" ? "danger" : "primary"}
            disabled={!commitReady}
            loading={busy}
            onClick={() => void commit()}
          >
            {copy.commit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const title: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.25rem",
  color: t.onSurface,
};
const meta: CSSProperties = { fontSize: "0.78rem", color: t.onSurfaceVariant, margin: 0 };
const alert: CSSProperties = { fontSize: "0.8rem", color: t.error, margin: 0 };
