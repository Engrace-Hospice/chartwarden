// apps/web/src/shell/intake-upload-dialog.tsx — the one way a file enters DocLens from the UI (F-238).
// Checksum-verified upload → `POST /api/v1/intake/uploads` → `POST …/extraction/run`. Shared by the referral
// Records tab (filed against that referral) and the Intake review queue (an unfiled fax: the cover sheet's
// records-request code files it, or a reviewer does with Move document). Lives in the shell because M6
// (Records tab) may not import M22's web module.
import {
  Button,
  Modal,
  SelectField,
  StatusPill,
  freshIdempotencyKeyHeaders,
  t,
} from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { useLayoutEffect, useRef, useState } from "react";
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
  const [fileState, setFileState] = useState<{ contextKey: string; file: File } | null>(null);
  const [channelState, setChannelState] = useState<{
    contextKey: string;
    value: ChannelKey;
  } | null>(null);
  const [stages, setStages] = useState<Record<string, string>>({});
  const [errorState, setErrorState] = useState<{
    contextKey: string;
    message: string;
  } | null>(null);
  const [uploadedState, setUploadedState] = useState<{
    contextKey: string;
    documentId: string;
  } | null>(null);
  const submissionsInFlight = useRef(new Set<string>());
  const contextKey = `${referralId ?? "unfiled"}:${patientId ?? "none"}`;
  const currentContextKey = useRef(contextKey);
  useLayoutEffect(() => {
    currentContextKey.current = contextKey;
  }, [contextKey]);
  const file = fileState?.contextKey === contextKey ? fileState.file : null;
  const channel = channelState?.contextKey === contextKey ? channelState.value : "fax";
  const error = errorState?.contextKey === contextKey ? errorState.message : null;
  const uploaded = uploadedState?.contextKey === contextKey ? uploadedState : null;
  const stage = stages[contextKey] ?? null;
  const busy = stage !== null;

  function setContextStage(key: string, value: string | null): void {
    setStages((current) => {
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }

  function closeDialog(): void {
    if (!uploaded) {
      setFileState(null);
      setChannelState(null);
      setErrorState(null);
    }
    setContextStage(contextKey, null);
    submissionsInFlight.current.delete(contextKey);
    onClose();
  }

  async function submit(): Promise<void> {
    if (!file || submissionsInFlight.current.has(contextKey)) return;
    submissionsInFlight.current.add(contextKey);
    const submissionContextKey = contextKey;
    const ch = CHANNELS.find((c) => c.value === channel) ?? CHANNELS[0];
    setErrorState(null);
    let completedDocumentId = uploaded?.documentId ?? null;
    try {
      // 1 — the checksum-verified upload, filed as an intake document of this referral.
      if (!completedDocumentId) {
        setContextStage(submissionContextKey, "Uploading");
        const completedUpload = await verifiedUpload(client, {
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
        if (currentContextKey.current !== submissionContextKey) return;
        completedDocumentId = completedUpload.documentId;
        setUploadedState({ contextKey: submissionContextKey, documentId: completedDocumentId });
      }
      // 2 — the intake batch, filed against the referral (the server gives it the referral's patient).
      setContextStage(submissionContextKey, "Filing");
      const batch = await client.POST("/api/v1/intake/uploads", {
        body: {
          documentId: completedDocumentId,
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
      setContextStage(submissionContextKey, "Starting");
      const run = await client
        .POST("/api/v1/intake/uploads/{id}/extraction/run", {
          params: { path: { id: batch.data.id } },
          body: {},
          // A run reads the batch as it is now: never replay an earlier (lost-reply) answer.
          headers: freshIdempotencyKeyHeaders(),
        })
        .catch((err: unknown) => ({ error: err }));
      setFileState((current) => (current?.contextKey === submissionContextKey ? null : current));
      setChannelState((current) => (current?.contextKey === submissionContextKey ? null : current));
      setErrorState((current) => (current?.contextKey === submissionContextKey ? null : current));
      setUploadedState((current) =>
        current?.contextKey === submissionContextKey ? null : current,
      );
      if (currentContextKey.current !== submissionContextKey) return;
      setContextStage(submissionContextKey, null);
      onFiled(
        run.error
          ? `Records filed. WardenLens did not start reading them: ${errorText(run.error, "the server refused the run")}.`
          : referralId
            ? "Records filed. WardenLens is reading them; they appear here as they progress."
            : "Uploaded. WardenLens is reading it; it appears in the queue as it progresses.",
      );
    } catch (err) {
      const message = errorText(err, "The records could not be uploaded.");
      if (currentContextKey.current === submissionContextKey) {
        setErrorState({
          contextKey: submissionContextKey,
          message: completedDocumentId
            ? `${message} The verified file is preserved; Retry filing reuses it and will not upload a duplicate.`
            : message,
        });
      }
    } finally {
      setContextStage(submissionContextKey, null);
      submissionsInFlight.current.delete(submissionContextKey);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : closeDialog}
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
            disabled={busy || uploaded !== null}
            aria-label="Records file"
            onChange={(e) => {
              const nextFile = e.target.files?.[0] ?? null;
              setFileState(nextFile ? { contextKey, file: nextFile } : null);
              setErrorState(null);
            }}
          />
        </label>
        <SelectField
          label="Received by"
          value={channel}
          disabled={busy || uploaded !== null}
          onChange={(e) => setChannelState({ contextKey, value: e.target.value as ChannelKey })}
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
          <Button tone="tertiary" onClick={closeDialog} disabled={busy}>
            {uploaded ? "Close" : "Cancel"}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || file === null}>
            {busy
              ? `${stage}…`
              : uploaded
                ? "Retry filing"
                : referralId
                  ? "Upload and file"
                  : "Upload"}
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
