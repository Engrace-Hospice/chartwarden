import {
  Button,
  Modal,
  SelectField,
  StatusPill,
  TextField,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/22-documents — the staff document upload dialog (#91).
//
// THE STAFF APP HAD NO FILE INPUT. `grep -rn 'type="file"' apps/web/src apps/admin/src
// apps/portal/src` returned exactly ONE hit, in the PORTAL: a family member could attach a document
// and the clinical staff who run the agency could not. This is that control.
//
// It drives the CHECKSUM-ENFORCED path (`POST /api/v1/document-uploads` → PUT to object storage →
// `POST …/complete`), not the metadata-only `POST /api/v1/documents`. The difference matters: the
// browser hashes the file, the server stores that digest as an EXPECTED value, and `complete` inspects
// the stored object and refuses to commit a version whose size or SHA-256 does not match. A document
// that reaches the record has been proven byte-identical to the one the clinician chose.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030):
//   • whether this caller may upload (`documents.upload`), and whether the target document is under
//     legal hold or tombstoned (409 `DOCUMENT_IMMUTABLE`);
//   • whether the bytes that arrived are the bytes that were promised — the size and MIME checks below
//     are a courtesy so the user is not made to wait for a round trip, never the enforcement point;
//   • the 15-minute reservation TTL, and the §164.528 accounting a later signed URL writes.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  ACCEPTED_UPLOAD_MIME,
  type AggregateType,
  type CompleteUploadResult,
  MAX_UPLOAD_BYTES,
  type RetentionClass,
  uploadDocument,
} from "./documents-api";

/** §3.2 retention classes, in the order the CMS/agency mental model puts them. */
const RETENTION_CLASSES: readonly RetentionClass[] = [
  "clinical_record",
  "compliance",
  "compliance_42cfr_part2",
  "bereavement",
  "operational",
  "intake_artifact",
];

/**
 * §3.2 aggregate types. The full vocabulary is 30 values, most of which are what OTHER modules file
 * automatically (an `encounter` PDF, an `evv_verification`, an `idg_minutes`). A staff member
 * uploading a scan is filing one of these — the paper that arrives by fax or in a folder — so the
 * picker offers those and `other`, rather than 30 options of which 20 are things a human never files
 * by hand. The server accepts any of the 30; this narrows the CHOICE, not the contract.
 */
const STAFF_FILED_TYPES: readonly AggregateType[] = [
  "election_statement",
  "cti",
  "f2f",
  "nor",
  "revocation",
  "discharge_summary",
  "nomnc",
  "abn",
  "hipaa_privacy_notice",
  "code_status_directive",
  "consent_record",
  "intake_source",
  "patient_amendment_statement_of_disagreement",
  "other",
];

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const LABEL: Record<string, string> = {
  cti: "Certification of Terminal Illness",
  f2f: "Face-to-Face Encounter",
  nor: "Notice of Rights",
  nomnc: "NOMNC",
  abn: "ABN",
  hipaa_privacy_notice: "HIPAA Privacy Notice",
  compliance_42cfr_part2: "Compliance (42 CFR Part 2)",
};
const label = (k: string): string => LABEL[k] ?? humanize(k);

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export interface DocumentUploadDialogProps {
  readonly open: boolean;
  /** Files the patient chart uploads are filed against; omitted for a tenant-wide upload. */
  readonly patientId?: string | null;
  /** Visible confirmation of the selected target when upload starts from the organization explorer. */
  readonly patientLabel?: string;
  /**
   * Set to add a NEW VERSION of an existing document rather than create one. The server refuses this
   * for a document under legal hold or tombstoned, which is the case this mode exists to be refused in.
   */
  readonly targetDocumentId?: string | null;
  readonly onClose: () => void;
  readonly onDone: (result: CompleteUploadResult) => void;
}

export function DocumentUploadDialog({
  open,
  patientId = null,
  patientLabel,
  targetDocumentId = null,
  onClose,
  onDone,
}: DocumentUploadDialogProps): JSX.Element | null {
  const client = useApiClient();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [retentionClass, setRetentionClass] = useState<RetentionClass>("clinical_record");
  const [aggregateType, setAggregateType] = useState<AggregateType>("intake_source");
  const [patientFacing, setPatientFacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const newVersion = targetDocumentId !== null;

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setTitle("");
    setRetentionClass("clinical_record");
    setAggregateType("intake_source");
    setPatientFacing(false);
    setBusy(false);
    setStage(null);
    setError(null);
  }, [open]);

  if (!open) return null;

  const tooBig = file !== null && file.size > MAX_UPLOAD_BYTES;
  const wrongType =
    file !== null &&
    !ACCEPTED_UPLOAD_MIME.includes(file.type as (typeof ACCEPTED_UPLOAD_MIME)[number]);
  const blocked = file === null || title.trim() === "" || tooBig || wrongType;

  async function submit(): Promise<void> {
    if (file === null) return;
    setBusy(true);
    setError(null);
    // The hash is the slow step on a large scan, and it happens before any request — without this the
    // dialog would sit silent for seconds looking hung.
    setStage("Checksumming…");
    // The ceremony spans four steps and two origins; an unexpected throw anywhere in it would leave
    // this dialog busy forever with nothing on screen. `busy` is cleared in `finally` so the modal is
    // always escapable, and an unrecognised failure still SAYS something.
    try {
      const res = await uploadDocument(client, file, {
        mode: newVersion ? "new_version" : "new_document",
        ...(targetDocumentId !== null ? { targetDocumentId } : {}),
        ...(patientId !== null ? { patientId } : {}),
        retentionClass,
        aggregateType,
        title: title.trim(),
        patientFacing,
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      onDone(res.value);
      onClose();
    } catch {
      setError("The upload could not be completed. Nothing was saved.");
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={newVersion ? "Upload a new version" : "Upload a document"}
      width="32rem"
      accent={t.primary}
    >
      <div style={body}>
        <h2 style={heading}>{newVersion ? "Upload new version" : "Upload document"}</h2>
        {patientId && patientLabel ? (
          <p style={meta}>
            Patient: {patientLabel} · This file will appear in their Documents tab.
          </p>
        ) : null}

        <label style={fieldLabel}>
          <span style={labelText}>File</span>
          <input
            type="file"
            accept={ACCEPTED_UPLOAD_MIME.join(",")}
            disabled={busy}
            aria-label="File"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              // A scan's filename is the only title most uploads will ever get typed for them.
              if (picked && title.trim() === "") setTitle(picked.name.replace(/\.[^.]+$/, ""));
            }}
          />
        </label>
        {file !== null ? (
          <p style={meta}>
            {file.name} · {mb(file.size)} · {file.type || "unknown type"}
          </p>
        ) : (
          <p style={meta}>PDF, JPEG, PNG or TIFF, up to {mb(MAX_UPLOAD_BYTES)}.</p>
        )}
        {tooBig ? (
          <p role="alert" style={errorText}>
            That file is {mb(file?.size ?? 0)} — larger than the {mb(MAX_UPLOAD_BYTES)} limit.
          </p>
        ) : null}
        {wrongType ? (
          <p role="alert" style={errorText}>
            {file?.type || "That file type"} is not accepted. Use PDF, JPEG, PNG or TIFF.
          </p>
        ) : null}

        <TextField
          label="Title"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />

        {!newVersion ? (
          <>
            <SelectField
              label="Document type"
              value={aggregateType}
              disabled={busy}
              onChange={(e) => setAggregateType(e.target.value as AggregateType)}
              options={STAFF_FILED_TYPES.map((k) => ({ value: k, label: label(k) }))}
            />
            <SelectField
              label="Retention class"
              value={retentionClass}
              disabled={busy}
              onChange={(e) => setRetentionClass(e.target.value as RetentionClass)}
              options={RETENTION_CLASSES.map((k) => ({ value: k, label: label(k) }))}
            />
            <p style={meta}>
              Retention class decides how long this document is kept and under which rules — 42 CFR
              Part 2 content is held to the stricter regime and cannot be relaxed later.
            </p>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={patientFacing}
                disabled={busy}
                onChange={(e) => setPatientFacing(e.target.checked)}
              />
              <span>Visible to the patient and family in the portal</span>
            </label>
          </>
        ) : (
          <p style={meta}>
            A new version is appended to this document's chain; earlier versions are never replaced.
            The server refuses a document under legal hold.
          </p>
        )}

        {stage !== null ? (
          <output style={stageBox}>
            <StatusPill label={stage} tone="progress" />
            <span style={meta}>
              The file is hashed here, sent directly to storage, and only committed once the server
              has verified it arrived intact.
            </span>
          </output>
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
          <Button onClick={submit} disabled={busy || blocked}>
            {busy ? "Uploading…" : "Upload"}
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
  gap: "0.75rem",
  maxHeight: "80vh",
  overflowY: "auto",
};
const heading: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const fieldLabel: CSSProperties = { display: "grid", gap: "0.25rem" };
const labelText: CSSProperties = { fontSize: "0.8rem", fontWeight: 600 };
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const stageBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.375rem",
  padding: "0.625rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--color-outline-variant)",
};
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
