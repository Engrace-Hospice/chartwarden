// apps/web/src/modules/05-patient/wristband-action.tsx -- GAP-020: print / reprint the patient wristband.
//
// The wristband is the on-file side of the BCMA `wrong_patient` check. The server mints a random token, returns the
// printable payload ONCE, and stores only a digest - so the payload lives in THIS component's state for the life of
// the dialog and nowhere else (not the URL, not storage, not a query cache). Closing the dialog drops it; getting it
// back means printing again, which supersedes the previous band. That is why the dialog says so, plainly.
//
// Printing is the browser's: a print-only label sized for the common 1in x 11in direct-thermal band stock, a QR
// code plus a Code 128 for linear scanners, the human-readable line, and the typed fallback code under them. No
// diagnosis, payer or treatment program is printed - the band must not reveal program participation.
import { Button, Modal, SelectField, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { renderWristbandBarcodes } from "./wristband-barcode";

type Status = {
  state: "none" | "active";
  generation: number | null;
  issuedAt: string | null;
  /** True once any generation exists, voided ones included: the server then refuses `first_issue`. */
  everIssued: boolean;
};
interface Issued {
  generation: number;
  payload: string;
  label: { name: string; mrn: string; dob: string };
}

const REPRINT_REASONS = [
  { value: "reprint_lost", label: "Band lost" },
  { value: "reprint_damaged", label: "Band damaged or unreadable" },
  { value: "reprint_other", label: "Other" },
  { value: "identity_correction", label: "Identity corrected" },
] as const;

const PRINT_CSS = `
@page { size: 1in 11in; margin: 0; }
@media print {
  body * { visibility: hidden; }
  .wx-wristband-label, .wx-wristband-label * { visibility: visible; }
  .wx-wristband-label { position: fixed; left: 0; top: 0; width: 1in; }
}`;

export function WristbandAction({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("reprint_lost");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one-time secret. Cleared on close; never persisted anywhere.
  const [issued, setIssued] = useState<Issued | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await client.GET("/api/v1/patients/{id}/wristband", {
      params: { path: { id: patientId } },
    });
    setStatus(res.data ?? null);
  }, [client, patientId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const close = useCallback(() => {
    setIssued(null);
    setError(null);
    setOpen(false);
    void loadStatus();
  }, [loadStatus]);

  const hasBand = status?.state === "active";
  // A voided-out patient has no active band but is no longer a first print: only a reprint reason is accepted.
  const isReprint = hasBand || status?.everIssued === true;

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await client.POST("/api/v1/patients/{id}/wristbands", {
      params: { path: { id: patientId } },
      body: {
        reason: isReprint ? (reason as (typeof REPRINT_REASONS)[number]["value"]) : "first_issue",
        expectedCurrentGeneration: status?.generation ?? null,
      },
    });
    setBusy(false);
    if (res.error || !res.data) {
      const code = (res.error as { error?: { code?: string } } | undefined)?.error?.code;
      setError(
        code === "CONFLICT"
          ? "Another wristband was printed for this patient first. Close this and reload before printing again."
          : "The wristband could not be generated.",
      );
      return;
    }
    setIssued(res.data);
  }

  return (
    <>
      <Button type="button" tone="secondary" onClick={() => setOpen(true)}>
        {isReprint ? "Reprint wristband" : "Print wristband"}
      </Button>
      <Modal
        open={open}
        onClose={busy ? undefined : close}
        ariaLabel="Patient wristband"
        width="30rem"
      >
        <div style={bodyStyle}>
          <h2 style={titleStyle}>{isReprint ? "Reprint wristband" : "Print wristband"}</h2>
          {issued ? (
            <IssuedLabel issued={issued} onDone={close} />
          ) : (
            <>
              <p style={metaStyle}>
                {hasBand
                  ? "Printing a new wristband immediately retires the current one: the old band will no longer verify at the bedside."
                  : status?.everIssued
                    ? "Every wristband for this patient has been voided. Printing a new one starts a fresh generation."
                    : "This patient has no wristband on file. Until one is printed, a barcode scan for this patient cannot be verified."}
              </p>
              {isReprint ? (
                <SelectField
                  label="Reason for reprint"
                  value={reason}
                  options={REPRINT_REASONS}
                  onChange={(e) => setReason(e.target.value)}
                />
              ) : null}
              {error ? (
                <p role="alert" style={alertStyle}>
                  {error}
                </p>
              ) : null}
              <div style={rowStyle}>
                <Button type="button" tone="secondary" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  tone="primary"
                  disabled={busy}
                  onClick={() => void generate()}
                >
                  {busy ? "Generating..." : "Generate wristband"}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

function IssuedLabel({ issued, onDone }: { issued: Issued; onDone: () => void }): JSX.Element {
  const { qrSvg, linearSvg } = renderWristbandBarcodes(issued.payload);
  return (
    <>
      <style>{PRINT_CSS}</style>
      <output style={{ ...metaStyle, display: "block" }}>
        Generation {issued.generation}. This code is shown once: closing this dialog without
        printing means printing a new wristband.
      </output>
      <div className="wx-wristband-label" style={labelStyle}>
        <div style={{ fontWeight: 600 }}>{issued.label.name}</div>
        <div>
          MRN {issued.label.mrn} - DOB {issued.label.dob}
        </div>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: path-only SVG generated by bwip-js from our own payload */}
        <div style={{ width: "12mm" }} dangerouslySetInnerHTML={{ __html: qrSvg }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: path-only SVG generated by bwip-js from our own payload */}
        <div style={{ width: "100%" }} dangerouslySetInnerHTML={{ __html: linearSvg }} />
        <code style={{ fontSize: "7pt", wordBreak: "break-all" }}>{issued.payload}</code>
      </div>
      <div style={rowStyle}>
        <Button type="button" tone="secondary" onClick={onDone}>
          Done
        </Button>
        <Button type="button" tone="primary" onClick={() => window.print()}>
          Print
        </Button>
      </div>
    </>
  );
}

const bodyStyle: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
};
const titleStyle: CSSProperties = { margin: 0, fontSize: "1.125rem" };
const metaStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.875rem",
  color: "var(--color-on-surface-variant)",
};
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.875rem", color: "var(--color-error)" };
const rowStyle: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: "0.5rem" };
const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  fontSize: "9pt",
  border: "1px dashed var(--color-outline-variant)",
  padding: "0.5rem",
  borderRadius: "0.5rem",
};
