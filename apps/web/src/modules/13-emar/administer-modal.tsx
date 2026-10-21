import { parseWristbandPayload } from "@chartwarden/types";
import {
  Button,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  ghostBorder,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/13-emar — the ADMINISTER ceremony (M13 §2.1/§2.4/§2.6/§2.9, §6.1 #1; F-031).
//
// The screen that displayed a dose grid and could not record a dose is the sharp end of F-031: an eMAR a
// clinician might reasonably mistake for a working MAR. This is the modal that closes it — single-dose,
// PRN, controlled-substance-with-witness, the five IV-continuous segments, and refusal, all committing to
// the real M13 routes through emar-api.ts.
//
// WHAT THE CEREMONY MAKES VISIBLE, BECAUSE THE SERVER IS THE ONE ENFORCING IT.
//
//   • The five rights are a CLINICIAN'S checklist, not a server gate. M13's §5.11 five-rights validation
//     against the M12 order projection is a documented, still-open compromise in
//     `emar-route-service-db.ts` — so this list gates THIS BUTTON and nothing else, and the copy says
//     "confirm", never "verified". Presenting it as a system check would be the more dangerous lie.
//   • §2.6 D7 double witness. A controlled substance needs a token minted by a SECOND clinician from
//     THEIR session on THEIR device — a 60-second, single-use, server-minted credential. This modal can
//     only carry it. That is why there is a paste field and not a "witnessed by" dropdown: a dropdown
//     would let the administering clinician assert their own witness, which is exactly what the D7
//     ceremony exists to prevent.
//   • §2.5 late entry. The SERVER derives the tier from `administeredAt`; this form only offers the
//     reason box once the entered time is behind the grace window, and does not label the tier itself —
//     a client-side "significant late" that disagreed with the stored tier would be a second opinion
//     about a regulated field.
//   • §2.9 BCMA. The scan payloads are sent as OBSERVED; the server re-derives `barcodeMatchResult` and
//     hard-blocks a wrong-drug/expired/wrong-patient scan. The one thing checked here is that the wristband
//     field holds a well-formed, checksum-valid code - so a misread is a "rescan", never a false wrong-patient
//     alarm. WHOSE band it is, and whether it is the current one, is M5's answer, not this form's.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type ActiveMedicationOrder,
  type AdministrationMode,
  type MedClass,
  type PrnRequestedByKind,
  type RecordAdministrationBody,
  errorMessage,
  isWitnessRequired,
  recordAdministration,
  recordRefusal,
  wristbandRefusalOf,
} from "./emar-api";

/** The two acts this modal commits. A refusal is a RECORDED row, not an omission. */
export type AdministerIntent = "administer" | "refuse";

export interface AdministerModalProps {
  open: boolean;
  patientId: string;
  /** Active orders to choose from. Empty when the caller could not read M12 (see `ordersUnavailable`). */
  orders: readonly ActiveMedicationOrder[];
  /** Pre-selected order (a grid cell click, or an IV session's own order). */
  initialOrderId?: string;
  /** The scheduled dose this commits against, when the clinician picked a grid cell. */
  scheduledDoseId?: string;
  /** Fixed mode — the IV session passes its segment kind; the MAR grid leaves it single-dose. */
  mode?: AdministrationMode;
  /** True when `GET /medications/active` failed (no `prescribing.read`): the picker degrades to an id box. */
  ordersUnavailable?: boolean;
  intent: AdministerIntent;
  onClose: () => void;
  onRecorded: () => void;
}

const FIVE_RIGHTS = [
  { id: "patient", label: "Right patient" },
  { id: "drug", label: "Right drug" },
  { id: "dose", label: "Right dose" },
  { id: "route", label: "Right route" },
  { id: "time", label: "Right time" },
] as const;

const PRN_REQUESTED_BY: readonly { value: PrnRequestedByKind; label: string }[] = [
  { value: "clinician_observed", label: "Clinician observed" },
  { value: "patient_request", label: "Patient request" },
  { value: "caregiver_request", label: "Caregiver request" },
  { value: "scheduled_reassessment_protocol", label: "Scheduled reassessment protocol" },
];

/** The §2.5 reason box appears past this much drift. The SERVER decides the tier; this only decides when
 *  to ask for the sentence the tier will need. */
const LATE_ENTRY_PROMPT_MINUTES = 60;
/** `RecordAdministrationRequest.lateEntryReason` — minLength 20 on the server. Enforced here so a short
 *  reason is a field error rather than a 422 after the clinician has left the bedside. */
const LATE_REASON_MIN = 20;
/** `prn.triggeringPrnReason` — minLength 1, but a one-character PRN rationale is not a rationale. */
const PRN_REASON_MIN = 1;

/** A `datetime-local` value for `now`, in the browser's own zone (the server stores an instant). */
function nowLocal(): string {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function AdministerModal({
  open,
  patientId,
  orders,
  initialOrderId,
  scheduledDoseId,
  mode = "single_dose",
  ordersUnavailable = false,
  intent,
  onClose,
  onRecorded,
}: AdministerModalProps): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const [orderId, setOrderId] = useState(initialOrderId ?? orders[0]?.id ?? "");
  const [at, setAt] = useState(nowLocal);
  const [route, setRoute] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [isPrn, setIsPrn] = useState(false);
  const [prnReason, setPrnReason] = useState("");
  const [prnRequestedBy, setPrnRequestedBy] = useState<PrnRequestedByKind>("clinician_observed");
  const [lateReason, setLateReason] = useState("");
  const [witnessToken, setWitnessToken] = useState("");
  const [scanNdc, setScanNdc] = useState("");
  const [scanWristband, setScanWristband] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // GAP-020 - the wristband reason behind a refusal, so the form can offer the right next step.
  const [wristbandCode, setWristbandCode] = useState<string | null>(null);

  const order = orders.find((o) => o.id === orderId) ?? null;
  // The class the SERVER will gate on is the ORDER's, not a picker the clinician can change. When M12 is
  // unreadable the form falls back to `standard`, and a controlled substance then refuses at the route
  // with the D7 message — a refusal from the server, never a silent downgrade of the witness requirement.
  const medClass: MedClass = order?.medClass ?? "standard";
  const isControlled = medClass === "controlled_substance";

  // Reset per opening — a ceremony must never inherit the previous dose's fields.
  useEffect(() => {
    if (!open) return;
    setOrderId(initialOrderId ?? orders[0]?.id ?? "");
    setAt(nowLocal());
    setNotes("");
    setConfirmed({});
    setIsPrn(false);
    setPrnReason("");
    setLateReason("");
    setWitnessToken("");
    setScanNdc("");
    setScanWristband("");
    setError(null);
    setWristbandCode(null);
    setBusy(false);
  }, [open, initialOrderId, orders]);

  // Route/dose default from the order, so the common case is a confirmation rather than transcription.
  useEffect(() => {
    if (!order) return;
    setRoute((prev) => (prev.length > 0 ? prev : order.route));
  }, [order]);

  const minutesLate = useMemo(() => {
    const parsed = Date.parse(at);
    if (Number.isNaN(parsed)) return 0;
    return Math.round((Date.now() - parsed) / 60_000);
  }, [at]);
  const needsLateReason = minutesLate > LATE_ENTRY_PROMPT_MINUTES;

  const allRightsConfirmed = FIVE_RIGHTS.every((r) => confirmed[r.id]);
  const administering = intent === "administer";
  const commitReady =
    orderId.length > 0 &&
    at.length > 0 &&
    !busy &&
    (!administering || allRightsConfirmed) &&
    (!administering || !needsLateReason || lateReason.trim().length >= LATE_REASON_MIN) &&
    (!administering || !isPrn || prnReason.trim().length >= PRN_REASON_MIN);

  async function commit(): Promise<void> {
    setError(null);
    setWristbandCode(null);
    // A damaged / misread wristband code is caught HERE so it reads "rescan", not "wrong patient".
    if (administering && scanWristband.trim() && !parseWristbandPayload(scanWristband).ok) {
      setError("The wristband could not be read. Rescan it, or type the code printed under it.");
      return;
    }
    setBusy(true);
    const iso = new Date(at).toISOString();
    if (!administering) {
      const { error: err } = await recordRefusal(client, {
        patientId,
        medicationOrderId: orderId,
        medClass,
        refusedAt: iso,
        ...(scheduledDoseId ? { scheduledDoseId } : {}),
        ...(notes.trim() ? { refusalReason: notes.trim() } : {}),
      });
      setBusy(false);
      if (err) {
        setError(errorMessage(err, "The refusal could not be recorded."));
        return;
      }
      onRecorded();
      return;
    }

    const scan =
      scanNdc.trim() || scanWristband.trim()
        ? {
            ...(scanNdc.trim() ? { scannedNdc: scanNdc.trim() } : {}),
            ...(scanWristband.trim() ? { patientWristbandPayload: scanWristband.trim() } : {}),
          }
        : undefined;
    const body: RecordAdministrationBody = {
      medicationOrderId: orderId,
      medClass,
      mode,
      administeredAt: iso,
      // The per-mode payload the server carries opaquely; the discrete single-dose rights are read out
      // of it for the §5.11 checks and the snapshot columns.
      data: {
        route: route.trim(),
        ...(amount.trim() ? { administeredAmount: Number(amount) } : {}),
        ...(unit.trim() ? { administeredUnit: unit.trim() } : {}),
      },
      ...(scheduledDoseId ? { scheduledDoseId } : {}),
      ...(isPrn
        ? { prn: { triggeringPrnReason: prnReason.trim(), requestedByKind: prnRequestedBy } }
        : {}),
      ...(needsLateReason ? { lateEntryReason: lateReason.trim() } : {}),
      ...(scan ? { barcodeScan: scan } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    const { error: err } = await recordAdministration(
      client,
      body,
      witnessToken.trim() || undefined,
    );
    setBusy(false);
    if (err) {
      const wristband = wristbandRefusalOf(err);
      if (wristband) {
        setWristbandCode(wristband.code);
        setError(wristband.message);
        return;
      }
      setError(
        isWitnessRequired(err)
          ? "This controlled substance needs a live witness attestation. Ask the witnessing clinician to mint a token on their own device and paste it here within 60 seconds."
          : errorMessage(err, "The administration could not be recorded."),
      );
      return;
    }
    onRecorded();
  }

  if (!open) return null;

  const orderOptions = orders.map((o) => ({
    value: o.id,
    label: `${o.drugName} ${o.strength} · ${o.route} · ${o.status}${o.isControlledSubstance ? " · controlled" : ""}`,
  }));

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={administering ? "Record administration" : "Record refusal"}
      width="34rem"
      accent={isControlled ? t.alert : t.primary}
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={title}>{administering ? "Record administration" : "Record refusal"}</h2>

        {ordersUnavailable ? (
          <p style={meta}>
            Your account cannot read this patient's medication orders, so the drug list is
            unavailable. Enter the medication order id directly.
          </p>
        ) : null}

        {ordersUnavailable || orders.length === 0 ? (
          <TextField
            label="Medication order id"
            value={orderId}
            required
            onChange={(e) => setOrderId(e.target.value)}
          />
        ) : (
          <SelectField
            label="Medication"
            value={orderId}
            required
            options={orderOptions}
            onChange={(e) => setOrderId(e.target.value)}
          />
        )}

        <TextField
          label={administering ? "Administered at" : "Refused at"}
          type="datetime-local"
          value={at}
          required
          onChange={(e) => setAt(e.target.value)}
        />

        {administering ? (
          <>
            <div style={row}>
              <TextField
                label="Route"
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                style={{ width: "100%" }}
              />
              <TextField
                label="Dose"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{ width: "100%" }}
              />
              <TextField
                label="Unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>

            <fieldset style={fieldset}>
              <legend style={legend}>Five rights</legend>
              <p style={meta}>
                Confirm each before recording. This checklist gates this dialog only — the server
                does not yet validate the rights against the order.
              </p>
              {FIVE_RIGHTS.map((r) => (
                <label key={r.id} style={checkRow}>
                  <input
                    type="checkbox"
                    checked={Boolean(confirmed[r.id])}
                    onChange={(e) =>
                      setConfirmed((prev) => ({ ...prev, [r.id]: e.target.checked }))
                    }
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </fieldset>

            <label style={checkRow}>
              <input type="checkbox" checked={isPrn} onChange={(e) => setIsPrn(e.target.checked)} />
              <span>This is a PRN dose</span>
            </label>
            {isPrn ? (
              <>
                <TextAreaField
                  label="What prompted the PRN dose"
                  value={prnReason}
                  required
                  onChange={(e) => setPrnReason(e.target.value)}
                />
                <SelectField
                  label="Requested by"
                  value={prnRequestedBy}
                  options={PRN_REQUESTED_BY}
                  onChange={(e) => setPrnRequestedBy(e.target.value as PrnRequestedByKind)}
                />
              </>
            ) : null}

            {needsLateReason ? (
              <TextAreaField
                label="Late-entry reason"
                required
                value={lateReason}
                hint={`This dose is recorded ${minutesLate} minutes after the fact. The server assigns the late-entry tier; at least ${LATE_REASON_MIN} characters.`}
                onChange={(e) => setLateReason(e.target.value)}
              />
            ) : null}

            {isControlled && session?.membershipId ? (
              <div style={relayBox}>
                <span style={legend}>Your code — read this to the witness</span>
                <code style={relayCode}>{session.membershipId}</code>
              </div>
            ) : null}
            {isControlled ? (
              <TextField
                label="Witness attestation token"
                value={witnessToken}
                required
                hint="Minted by the witnessing clinician on their own device (Witness a controlled substance). Single use, valid 60 seconds."
                onChange={(e) => setWitnessToken(e.target.value)}
              />
            ) : null}

            <details>
              <summary style={summary}>Barcode scan (optional)</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <TextField
                  label="Scanned NDC"
                  value={scanNdc}
                  onChange={(e) => setScanNdc(e.target.value)}
                />
                <TextField
                  label="Scan patient wristband"
                  value={scanWristband}
                  autoComplete="off"
                  hint="Click here and scan with the handheld scanner, or type the code printed under the barcode."
                  onChange={(e) => setScanWristband(e.target.value)}
                />
                <p style={meta}>
                  Sent as scanned. The server verifies the wristband against the patient and derives
                  the match result; it blocks a wrong-patient, wrong-drug or expired scan.
                </p>
              </div>
            </details>
          </>
        ) : null}

        <TextAreaField
          label={administering ? "Notes (optional)" : "Reason the patient declined"}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {error ? (
          <p role="alert" style={alert}>
            {error}
            {wristbandCode === "WRISTBAND_NOT_ON_FILE" || wristbandCode === "WRISTBAND_VOIDED" ? (
              <>
                {" "}
                <Link to={`/patients/${patientId}`}>Open the chart to print a wristband</Link>
              </>
            ) : null}
          </p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={administering ? "primary" : "danger"}
            disabled={!commitReady}
            loading={busy}
            onClick={() => void commit()}
          >
            {administering ? "Record administration" : "Record refusal"}
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
const row: CSSProperties = { display: "flex", gap: "0.6rem", alignItems: "flex-end" };
const fieldset: CSSProperties = {
  border: ghostBorder,
  borderRadius: t.radiusLg,
  padding: "0.75rem 1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  margin: 0,
};
const legend: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: t.muted,
  padding: "0 0.35rem",
};
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.82rem",
  color: t.onSurface,
};
const summary: CSSProperties = {
  fontSize: "0.8rem",
  color: t.onSurfaceVariant,
  cursor: "pointer",
  marginBottom: "0.5rem",
};
const relayBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  background: t.surfaceLow,
  borderRadius: t.radiusLg,
  padding: "0.6rem 0.875rem",
};
const relayCode: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: "0.8rem",
  color: t.onSurface,
  wordBreak: "break-all",
};
const alert: CSSProperties = { fontSize: "0.8rem", color: t.error, margin: 0 };
