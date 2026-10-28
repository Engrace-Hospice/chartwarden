import { Button, Glyph, Modal, SelectField, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, JSX } from "react";
import { usePortalPatient } from "../patient-context";
import { formatPortalVisitDate, humanize, readError } from "./portal-format";
import { PortalPage } from "./portal-page";

interface PortalDoc {
  documentId: string;
  title?: string;
  documentType?: string;
  sharedAt?: string;
}
type UploadPurpose =
  | "insurance_card"
  | "prior_records"
  | "wound_photo"
  | "advance_directive_copy"
  | "other";
type LibraryState =
  | { patientId: string | null; status: "loading" | "error"; items: [] }
  | { patientId: string | null; status: "ready"; items: PortalDoc[] };
type UploadStage = "idle" | "preparing" | "transferring" | "submitting" | "complete" | "error";

const MAX_UPLOAD_BYTES = 52_428_800;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/tiff",
]);
const PURPOSE_OPTIONS = [
  { value: "insurance_card", label: "Insurance card" },
  { value: "prior_records", label: "Prior records" },
  { value: "wound_photo", label: "Wound photo" },
  { value: "advance_directive_copy", label: "Advance directive copy" },
  { value: "other", label: "Other" },
] as const;
const validTime = (value?: string): number => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};
const sortDocuments = (items: PortalDoc[]): PortalDoc[] =>
  [...items].sort(
    (a, b) =>
      validTime(b.sharedAt) - validTime(a.sharedAt) ||
      (a.title ?? a.documentId).localeCompare(b.title ?? b.documentId),
  );
const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;
const sharedDate = (value?: string): string =>
  formatPortalVisitDate(value) ?? "Shared date unavailable";

function DocumentsSkeleton(): JSX.Element {
  return (
    <output className="wx-documents-skeleton" aria-label="Loading shared documents">
      <span />
      <span />
      <span />
    </output>
  );
}

function DocumentsEmptyState({
  onUpload,
}: {
  onUpload: () => void;
}): JSX.Element {
  return (
    <section className="wx-documents-empty" aria-labelledby="documents-empty-title">
      <span className="wx-documents-empty__icon" aria-hidden="true">
        <Glyph name="folder" size={28} />
      </span>
      <div>
        <h2 id="documents-empty-title">No documents shared yet</h2>
        <p>Documents your care team shares with you will appear here.</p>
      </div>
      <Button tone="secondary" onClick={onUpload}>
        <Glyph name="upload" size={17} aria-hidden="true" /> Send a document
      </Button>
    </section>
  );
}

function UploadDocumentDialog({
  open,
  patientId,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  patientId: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const patientRef = useRef(patientId);
  const [purpose, setPurpose] = useState<UploadPurpose>("prior_records");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [resumeUploadId, setResumeUploadId] = useState<string | null>(null);
  const busy = stage === "preparing" || stage === "transferring" || stage === "submitting";

  useLayoutEffect(() => {
    patientRef.current = patientId;
    setFile(null);
    setFileError(null);
    setStage("idle");
    setFeedback(null);
    setResumeUploadId(null);
    return () => {
      patientRef.current = null;
    };
  }, [patientId]);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = "";
    setResumeUploadId(null);
    setFeedback(null);
    setStage("idle");
    if (!selected) return;
    if (selected.size === 0) {
      setFile(null);
      setFileError("Choose a file that is not empty.");
      return;
    }
    if (selected.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setFileError("This file is larger than the 50 MB limit.");
      return;
    }
    if (!ALLOWED_MIME.has(selected.type)) {
      setFile(null);
      setFileError("Choose a PDF, JPEG, PNG, HEIC or TIFF file.");
      return;
    }
    setFile(selected);
    setFileError(null);
  };

  const complete = async (uploadId: string, requestPatient: string | null): Promise<void> => {
    setStage("submitting");
    const done = await client.POST("/api/v1/portal/documents/upload-complete/{uploadId}", {
      params: { path: { uploadId } },
    });
    if (patientRef.current !== requestPatient) return;
    if (done.error) {
      setResumeUploadId(uploadId);
      setStage("error");
      setFeedback("The file was sent, but could not be submitted for processing. Try again.");
      return;
    }
    setResumeUploadId(null);
    setStage("complete");
    setFeedback("Your document was submitted for secure processing.");
    onSubmitted();
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !file) return;
    const requestPatient = patientRef.current;
    try {
      if (resumeUploadId) {
        await complete(resumeUploadId, requestPatient);
        return;
      }
      setStage("preparing");
      setFeedback(null);
      const init = await client.POST("/api/v1/portal/documents/upload-init", {
        body: { purpose, mimeType: file.type, expectedByteSize: file.size },
      });
      if (patientRef.current !== requestPatient) return;
      if (init.error || !init.data?.uploadId) {
        setStage("error");
        setFeedback(readError(init.response?.status));
        return;
      }
      const uploadId = init.data.uploadId;
      setStage("transferring");
      const put = await client.PUT("/api/v1/portal/documents/uploads/{uploadId}/content", {
        params: { path: { uploadId } },
        body: file as never,
        bodySerializer: (body: unknown) => body as BodyInit,
        headers: { "content-type": file.type },
      } as never);
      if (patientRef.current !== requestPatient) return;
      if (put.error) {
        setStage("error");
        setFeedback("The file could not be sent. Check your connection and try again.");
        return;
      }
      await complete(uploadId, requestPatient);
    } catch {
      if (patientRef.current !== requestPatient) return;
      setStage("error");
      setFeedback("The document could not be submitted. Please try again.");
    }
  };

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Send a document"
      width="36rem"
    >
      <form className="wx-document-upload" onSubmit={(event) => void submit(event)}>
        <header>
          <span aria-hidden="true">
            <Glyph name="upload" size={22} />
          </span>
          <div>
            <h2>Send a document</h2>
            <p>Share a file securely with the care team.</p>
          </div>
        </header>
        <SelectField
          label="What kind of document is this?"
          value={purpose}
          disabled={busy || stage === "complete"}
          onChange={(event) => setPurpose(event.target.value as UploadPurpose)}
          options={PURPOSE_OPTIONS}
        />
        <div className="wx-document-upload__picker">
          <label htmlFor="portal-document-file">Choose a file</label>
          <input
            id="portal-document-file"
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.heic,.tif,.tiff,application/pdf,image/jpeg,image/png,image/heic,image/tiff"
            disabled={busy || stage === "complete"}
            aria-describedby="portal-document-file-help"
            aria-invalid={fileError ? "true" : undefined}
            onChange={chooseFile}
          />
          <p id="portal-document-file-help">
            PDF, JPEG, PNG, HEIC or TIFF. Maximum file size: 50 MB.
          </p>
        </div>
        {file ? (
          <div className="wx-document-upload__file" aria-label="Selected file">
            <Glyph name="file-text" size={22} aria-hidden="true" />
            <div>
              <strong>{file.name}</strong>
              <span>{formatBytes(file.size)}</span>
            </div>
            {stage !== "complete" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFile(null);
                  setResumeUploadId(null);
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        ) : null}
        {fileError ? (
          <p className="wx-document-upload__error" role="alert">
            {fileError}
          </p>
        ) : null}
        {feedback ? (
          <div
            className={`wx-document-upload__feedback wx-document-upload__feedback--${stage}`}
            role={stage === "error" ? "alert" : "status"}
          >
            <Glyph
              name={stage === "complete" ? "check-circle" : "alert-circle"}
              size={20}
              aria-hidden="true"
            />
            <span>{feedback}</span>
          </div>
        ) : null}
        {busy ? (
          <output className="wx-document-upload__stage">
            {stage === "preparing"
              ? "Preparing secure upload…"
              : stage === "transferring"
                ? "Sending file securely…"
                : "Submitting for processing…"}
          </output>
        ) : null}
        <footer>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            {stage === "complete" ? "Close" : "Cancel"}
          </Button>
          {stage !== "complete" ? (
            <Button type="submit" loading={busy} disabled={!file}>
              {resumeUploadId ? "Retry submission" : "Send document"}
            </Button>
          ) : null}
        </footer>
      </form>
    </Modal>
  );
}

export function PortalDocumentList(): JSX.Element {
  const { patientId } = usePortalPatient();
  return <DocumentsForPatient key={patientId ?? "no-patient"} patientId={patientId} />;
}

function DocumentsForPatient({
  patientId,
}: {
  patientId: string | null;
}): JSX.Element {
  const client = useApiClient();
  const mounted = useRef(true);
  const pendingPopups = useRef<Set<Window>>(new Set());
  useLayoutEffect(() => {
    mounted.current = true;
    const popups = pendingPopups.current;
    return () => {
      mounted.current = false;
      for (const popup of popups) popup.close();
      popups.clear();
    };
  }, []);
  const [attempt, setAttempt] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryState>({
    patientId,
    status: "loading",
    items: [],
  });
  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    void attempt;
    let active = true;
    const requestedPatient = patientId;
    setLibrary({ patientId: requestedPatient, status: "loading", items: [] });
    setDownloadBusy(null);
    setDownloadError(null);
    setUploadOpen(false);
    void (async () => {
      try {
        const response = await client.GET("/api/v1/portal/documents", {});
        if (!active) return;
        if ("error" in response)
          setLibrary({
            patientId: requestedPatient,
            status: "error",
            items: [],
          });
        else
          setLibrary({
            patientId: requestedPatient,
            status: "ready",
            items: sortDocuments((response.data?.items ?? []) as unknown as PortalDoc[]),
          });
      } catch {
        if (active)
          setLibrary({
            patientId: requestedPatient,
            status: "error",
            items: [],
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt, client, patientId]);

  const visible: LibraryState =
    library.patientId === patientId ? library : { patientId, status: "loading", items: [] };
  const countLabel = useMemo(
    () =>
      visible.status === "ready"
        ? `${visible.items.length} shared ${visible.items.length === 1 ? "document" : "documents"}`
        : "Shared documents",
    [visible],
  );
  const download = async (documentId: string): Promise<void> => {
    if (downloadBusy) return;
    // Reserve the browsing context during the user's click. Waiting for the signed-URL request
    // before calling window.open causes legitimate downloads to be treated as unsolicited pop-ups.
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      pendingPopups.current.add(popup);
    }
    setDownloadBusy(documentId);
    setDownloadError(null);
    try {
      const response = await client.GET("/api/v1/portal/documents/{documentId}/download-url", {
        params: { path: { documentId } },
      });
      // A pending request must not open the previous patient's signed URL after
      // their page was unmounted (including a rapid patient switch).
      if (!mounted.current) {
        popup?.close();
        return;
      }
      const url = response.data?.url;
      if ("error" in response || !url || !/^https?:\/\//i.test(url)) {
        popup?.close();
        setDownloadError("This document could not be opened securely. Please try again.");
        return;
      }
      if (popup) popup.location.replace(url);
      else setDownloadError("Your browser blocked the new window. Allow pop-ups, then try again.");
    } catch {
      popup?.close();
      if (mounted.current)
        setDownloadError("This document could not be opened securely. Please try again.");
    } finally {
      if (popup) pendingPopups.current.delete(popup);
      if (mounted.current) setDownloadBusy(null);
    }
  };

  return (
    <PortalPage
      width="workspace"
      title="Documents"
      subtitle="Review files shared by your care team or send them a document securely."
      actions={
        <Button size="lg" onClick={() => setUploadOpen(true)}>
          <Glyph name="upload" size={18} aria-hidden="true" /> Send a document
        </Button>
      }
    >
      <section className="wx-documents-library" aria-labelledby="shared-documents-title">
        <header className="wx-documents-library__header">
          <div>
            <h2 id="shared-documents-title">Shared with you</h2>
            <p>Documents made available by your care team.</p>
          </div>
          <span>{countLabel}</span>
        </header>
        {downloadError ? (
          <div className="wx-documents-inline-error" role="alert">
            <Glyph name="alert-circle" size={19} aria-hidden="true" />
            <span>{downloadError}</span>
            <button type="button" onClick={() => setDownloadError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {visible.status === "loading" ? <DocumentsSkeleton /> : null}
        {visible.status === "error" ? (
          <div className="wx-documents-error" role="alert">
            <Glyph name="alert-circle" size={24} aria-hidden="true" />
            <div>
              <h3>Documents are unavailable</h3>
              <p>We couldn't load the shared document library.</p>
            </div>
            <Button tone="secondary" onClick={reload}>
              <Glyph name="rotate-ccw" size={16} aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : null}
        {visible.status === "ready" && visible.items.length === 0 ? (
          <DocumentsEmptyState onUpload={() => setUploadOpen(true)} />
        ) : null}
        {visible.status === "ready" && visible.items.length > 0 ? (
          <ul className="wx-document-list">
            {visible.items.map((document) => {
              const title = document.title?.trim() || "Untitled document";
              const busy = downloadBusy === document.documentId;
              return (
                <li key={document.documentId} className="wx-document-row">
                  <span className="wx-document-row__icon" aria-hidden="true">
                    <Glyph name="file-text" size={23} />
                  </span>
                  <div className="wx-document-row__content">
                    <h3>{title}</h3>
                    <div className="wx-document-row__meta">
                      {document.documentType ? (
                        <StatusPill tone="neutral" label={humanize(document.documentType)} />
                      ) : (
                        <span>Document type unavailable</span>
                      )}
                      <span>Shared {sharedDate(document.sharedAt)}</span>
                    </div>
                  </div>
                  <Button
                    tone="secondary"
                    loading={busy}
                    disabled={Boolean(downloadBusy)}
                    aria-label={`Download ${title}`}
                    onClick={() => void download(document.documentId)}
                  >
                    <Glyph name="download" size={17} aria-hidden="true" /> Download
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      <aside className="wx-documents-security">
        <Glyph name="shield-check" size={22} aria-hidden="true" />
        <div>
          <strong>Secure document access</strong>
          <p>Download links are created only when you request them and expire automatically.</p>
        </div>
      </aside>
      <UploadDocumentDialog
        open={uploadOpen}
        patientId={patientId}
        onClose={() => setUploadOpen(false)}
        onSubmitted={reload}
      />
    </PortalPage>
  );
}
