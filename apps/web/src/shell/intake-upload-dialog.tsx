// apps/web/src/shell/intake-upload-dialog.tsx — the one way a file enters DocLens from the UI (F-238).
// Checksum-verified upload → `POST /api/v1/intake/uploads` → `POST …/extraction/run`. Shared by the referral
// Records tab (filed against that referral) and the Intake review queue (an unfiled fax: the cover sheet's
// records-request code files it, or a reviewer does with Move document). Lives in the shell because M6
// (Records tab) may not import M22's web module.
import { Button, Modal, SelectField, StatusPill, t } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { verifiedUpload } from "./document-workflows";
import type { SourceChannel as DocumentSourceChannel } from "./document-workflows";

/** The three ways records arrive, as the intake batch + the filed document name them. */
const CHANNELS = [
  { value: "fax", label: "Fax", intake: "fax", document: "fax" },
  { value: "email", label: "Email", intake: "email_ingest", document: "email" },
  { value: "scan", label: "Scanned upload", intake: "admin_upload", document: "scanned_physical" },
] as const satisfies ReadonlyArray<{
  value: string;
  label: string;
  intake: "fax" | "email_ingest" | "admin_upload";
  document: DocumentSourceChannel;
}>;
type ChannelKey = (typeof CHANNELS)[number]["value"];

/** DocLens reads PDF, TIFF and images (no DOCX). */
const ACCEPT = "application/pdf,image/tiff,image/jpeg,image/png,.pdf,.tif,.tiff,.jpg,.jpeg,.png";

const errorText = (err: unknown, fallback: string): string => {
  const e = err as { error?: { message?: string }; message?: string } | undefined;
  return e?.error?.message ?? e?.message ?? fallback;
};

export function IntakeUploadDialog({
  open,
  client,
  referralId,
  patientId,
  onClose,
  onFiled,
}: {
  open: boolean;
  client: ApiClient;
  /** File against this referral (Records tab). Absent ⇒ an unfiled fax (Intake review): a records-request
   *  code on its cover sheet files it, otherwise a reviewer files it with Move document. */
  referralId?: string | null;
  patientId?: string | null;
  onClose: () => void;
  onFiled: (message: string) => void;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [channel, setChannel] = useState<ChannelKey>("fax");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = stage !== null;

  useEffect(() => {
    if (!open) {
      setFile(null);
      setChannel("fax");
      setStage(null);
      setError(null);
    }
  }, [open]);

  async function submit(): Promise<void> {
    if (!file) return;
    const ch = CHANNELS.find((c) => c.value === channel) ?? CHANNELS[0];
    setError(null);
    setStage("Uploading");
    try {
      // 1 — the checksum-verified upload, filed as an intake document of this referral.
      const uploaded = await verifiedUpload(client, {
        context: referralId
          ? { kind: "referral", referralId, patientId: patientId ?? null }
          : { kind: "intake" },
        mode: "new_document",
        file,
        title:
          file.name.replace(/\.[^.]+$/, "") || (referralId ? "Referral records" : "Intake fax"),
        documentType: "intake_source",
        patientFacing: false,
        sourceMetadata: {
          documentType: "intake_source",
          sourceChannel: ch.document,
          originalFilename: file.name,
          receivedAt: new Date().toISOString(),
        },
        onStage: () => undefined,
      });
      // 2 — the intake batch, filed against the referral (the server gives it the referral's patient).
      setStage("Filing");
      const batch = await client.POST("/api/v1/intake/uploads", {
        body: {
          documentId: uploaded.documentId,
          ...(referralId ? { referralId } : {}),
          sourceChannel: ch.intake,
        },
      });
      if (batch.error || !batch.data) {
        throw new Error(
          errorText(
            batch.error,
            referralId
              ? "The records could not be filed to this referral."
              : "The upload could not be queued for intake.",
          ),
        );
      }
      // 3 — start DocLens. A refusal here (DocLens off, no queue) leaves the batch filed.
      setStage("Starting");
      const run = await client
        .POST("/api/v1/intake/uploads/{id}/extraction/run", {
          params: { path: { id: batch.data.id } },
          body: {},
        })
        .catch((err: unknown) => ({ error: err }));
      setStage(null);
      onFiled(
        run.error
          ? `Records filed. WardenLens did not start reading them: ${errorText(run.error, "the server refused the run")}.`
          : referralId
            ? "Records filed. WardenLens is reading them; they appear here as they progress."
            : "Uploaded. WardenLens is reading it; it appears in the queue as it progresses.",
      );
    } catch (err) {
      setStage(null);
      setError(errorText(err, "The records could not be uploaded."));
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={referralId ? "Add records" : "Upload fax"}
      width="30rem"
      accent={t.primary}
    >
      <div style={dialog}>
        <h2 style={heading}>{referralId ? "Add records" : "Upload fax"}</h2>
        <p style={muted}>
          {referralId
            ? "The file is filed against this referral and read by WardenLens."
            : "WardenLens reads it. A records-request code on its cover sheet (or in the email subject) files it under that referral; otherwise file it with Move document during review."}{" "}
          PDF, TIFF, JPEG or PNG, up to 25 MB.
        </p>
        <label style={fieldLabel}>
          <span>File</span>
          <input
            type="file"
            accept={ACCEPT}
            disabled={busy}
            aria-label="Records file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <SelectField
          label="Received by"
          value={channel}
          disabled={busy}
          onChange={(e) => setChannel(e.target.value as ChannelKey)}
          options={CHANNELS.map((c) => ({ value: c.value, label: c.label }))}
        />
        {stage ? (
          <output>
            <StatusPill label={stage} tone="progress" />
          </output>
        ) : null}
        {error ? (
          <p role="alert" style={alertText}>
            {error}
          </p>
        ) : null}
        <div style={dialogActions}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || file === null}>
            {busy ? "Uploading…" : referralId ? "Upload and file" : "Upload"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const heading: CSSProperties = { margin: 0, fontSize: "1rem" };
const muted: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};
const dialog: CSSProperties = { padding: "1.5rem", display: "grid", gap: "0.9rem" };
const fieldLabel: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontSize: "0.85rem",
  fontWeight: 600,
};
const alertText: CSSProperties = { margin: 0, color: "var(--color-error)", fontSize: "0.875rem" };
const dialogActions: CSSProperties = { display: "flex", gap: "0.5rem", justifyContent: "flex-end" };
