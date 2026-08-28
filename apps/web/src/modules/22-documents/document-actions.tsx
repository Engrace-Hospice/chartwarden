import { Button, Modal, SelectField, TextField, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/22-documents — the two small §4.1/§4.2 document ceremonies (#91).
//
// EDIT is `PATCH /api/v1/documents/:id` — title and portal visibility. The route returns the patched
// document and its contract declared no response schema until this change, so `client:gen` typed the
// body `never`: an edit could be sent and there was no typed way to read back what the server made of
// it. Legal hold is refused by `ABAC_LEGAL_HOLD` server-side, not previewed here.
//
// PREVIEW is `GET .../versions/:versionId/content`, which is a GET that WRITES: it mints a short-lived
// signed URL and records a §164.528 disclosure-accounting entry against the stated purpose. That is why
// the purpose is asked for rather than defaulted — "treatment" is the common case, but recording every
// look as treatment would make the accounting log a fiction, and the log is the point. The URL is
// opened in a new tab rather than embedded: it points at object storage, and the artifact viewer that
// would render it inline (DOC.SignedUrlPreview) is a screen this slice does not build.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  type AccessPurpose,
  type DocumentView,
  mintContentUrl,
  patchDocument,
} from "./documents-api";

/** The §4.2 §164.528 access purposes the route accepts, in the order a clinician meets them. */
const PURPOSES: readonly AccessPurpose[] = [
  "treatment",
  "operations",
  "payment",
  "disclosure",
  "patient_access",
  "amendment_review",
  "survey_export",
];

const PURPOSE_LABEL: Record<string, string> = {
  treatment: "Treatment — caring for this patient",
  operations: "Operations — quality, training, administration",
  payment: "Payment — billing or claim support",
  disclosure: "Disclosure — releasing to a third party",
  patient_access: "Patient access — §164.524 request",
  amendment_review: "Amendment review",
  survey_export: "Survey export",
};

export interface DocumentEditDialogProps {
  readonly open: boolean;
  readonly document: DocumentView;
  readonly onClose: () => void;
  readonly onDone: (updated: DocumentView) => void;
}

export function DocumentEditDialog({
  open,
  document: doc,
  onClose,
  onDone,
}: DocumentEditDialogProps): JSX.Element | null {
  const client = useApiClient();
  const [title, setTitle] = useState(doc.title);
  const [patientFacing, setPatientFacing] = useState(Boolean(doc.patientFacing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(doc.title);
    setPatientFacing(Boolean(doc.patientFacing));
    setBusy(false);
    setError(null);
  }, [open, doc]);

  if (!open) return null;

  const unchanged = title.trim() === doc.title && patientFacing === Boolean(doc.patientFacing);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await patchDocument(client, doc.id, {
      ...(title.trim() !== doc.title ? { title: title.trim() } : {}),
      ...(patientFacing !== Boolean(doc.patientFacing) ? { patientFacing } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone(res.value);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Edit document"
      width="28rem"
      accent={t.primary}
    >
      <div style={body}>
        <h2 style={heading}>Edit document</h2>
        <TextField
          label="Title"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={patientFacing}
            disabled={busy}
            onChange={(e) => setPatientFacing(e.target.checked)}
          />
          <span>Visible to the patient and family in the portal</span>
        </label>
        <p style={meta}>
          A document under legal hold cannot be edited; the server refuses the change rather than
          this dialog hiding it.
        </p>
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || unchanged || title.trim() === ""}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface DocumentPreviewDialogProps {
  readonly open: boolean;
  readonly documentId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly onClose: () => void;
}

export function DocumentPreviewDialog({
  open,
  documentId,
  versionId,
  versionNumber,
  onClose,
}: DocumentPreviewDialogProps): JSX.Element | null {
  const client = useApiClient();
  const [purpose, setPurpose] = useState<AccessPurpose>("treatment");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPurpose("treatment");
    setBusy(false);
    setError(null);
  }, [open]);

  if (!open) return null;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await mintContentUrl(client, documentId, versionId, purpose);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    // `noopener` because the target is object storage, not this origin.
    globalThis.open(res.value.url, "_blank", "noopener,noreferrer");
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Open document content"
      width="28rem"
      accent={t.primary}
    >
      <div style={body}>
        <h2 style={heading}>Open version {versionNumber}</h2>
        <SelectField
          label="Reason for access"
          value={purpose}
          disabled={busy}
          onChange={(e) => setPurpose(e.target.value as AccessPurpose)}
          options={PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABEL[p] ?? p }))}
        />
        <p style={meta}>
          Opening this document is recorded in the patient's disclosure accounting (§164.528)
          against the reason chosen here. The link is short-lived and opens in a new tab.
        </p>
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Opening…" : "Open"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
};
const heading: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
