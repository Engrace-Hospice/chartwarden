import {
  Button,
  EmptyState,
  LoadingSpinner,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, DragEvent, JSX, ReactNode } from "react";
import { lifecycleTone } from "./lantern";

type DocumentContext =
  | { kind: "patient"; patientId: string; admissionId?: string | null }
  | {
      kind: "referral";
      referralId: string;
      patientId?: string | null;
      admissionId?: string | null;
    };

interface DocumentRow {
  id: string;
  patientId: string | null;
  admissionId: string | null;
  retentionClass: string;
  aggregateType: string;
  aggregateId: string | null;
  title: string;
  patientFacing: boolean;
  metadata: DocumentMetadata | null;
  status: string;
  version: number;
  versionsCount: number;
  createdAt: string;
  updatedAt: string;
}

interface DocumentMetadata {
  documentType?: DocumentTypeValue;
  sourceChannel?: SourceChannel;
  receivedAt?: string;
  originalFilename?: string;
  externalMessageId?: string;
  sender?: string;
  faxReference?: string;
  notes?: string;
}

interface VersionRow {
  id: string;
  documentId: string;
  versionNumber: number;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
  createdAt: string;
}

type UploadStage =
  | "idle"
  | "preparing"
  | "uploading"
  | "verifying"
  | "complete";
type DocumentTypeValue =
  | "code_status_directive"
  | "consent_record"
  | "referral"
  | "intake_source"
  | "other";
type RetentionClass =
  | "compliance"
  | "clinical_record"
  | "bereavement"
  | "operational"
  | "intake_artifact"
  | "compliance_42cfr_part2";
type AcceptedMime =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "image/jpeg"
  | "image/png"
  | "image/tiff";
type SourceChannel =
  | "email"
  | "fax"
  | "scanned_physical"
  | "manual_upload"
  | "portal"
  | "api";

const ACCEPTED_MIME = new Map<AcceptedMime, string>([
  ["application/pdf", "PDF"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "DOCX",
  ],
  ["image/jpeg", "JPG"],
  ["image/png", "PNG"],
  ["image/tiff", "TIFF"],
]);

const DOCUMENT_TYPE_OPTIONS: ReadonlyArray<{
  value: DocumentTypeValue;
  label: string;
}> = [
  { value: "code_status_directive", label: "POLST" },
  { value: "consent_record", label: "Consent form" },
  { value: "referral", label: "Referral document" },
  { value: "intake_source", label: "Intake document" },
  { value: "other", label: "Other" },
];

const FILTERS = [
  { value: "", label: "All" },
  { value: "code_status_directive", label: "POLST" },
  { value: "consent_record", label: "Consent forms" },
  { value: "intake_source", label: "Intake" },
  { value: "other", label: "Other" },
];

const SOURCE_OPTIONS: ReadonlyArray<{ value: SourceChannel; label: string }> = [
  { value: "email", label: "Email" },
  { value: "fax", label: "Fax" },
  { value: "scanned_physical", label: "Scanned physical copy" },
  { value: "manual_upload", label: "Manual upload" },
];

export function PatientDocumentWorkspace({
  patientId,
}: {
  patientId: string;
}): JSX.Element {
  return (
    <DocumentCollection
      context={{ kind: "patient", patientId }}
      title="Documents"
      subtitle="POLST, consent forms, intake documents, and other patient records."
      emptyTitle="No patient documents yet."
      emptyDescription="Upload POLST, consent forms, intake documents, or other patient records."
      defaultDocumentType="code_status_directive"
      showPatientFacing
    />
  );
}

export function ReferralDocumentsPanel({
  referralId,
  patientId,
  admissionId,
}: {
  referralId: string;
  patientId?: string | null;
  admissionId?: string | null;
}): JSX.Element {
  return (
    <DocumentCollection
      context={{ kind: "referral", referralId, patientId, admissionId }}
      title="Referral Documents"
      subtitle="Files received for this referral remain linked here after patient matching."
      emptyTitle="No documents received yet."
      emptyDescription="Upload files received by fax, email, PDF, Word, or from a scanned physical copy."
      defaultDocumentType="referral"
      compact
    />
  );
}

function DocumentCollection({
  context,
  title,
  subtitle,
  emptyTitle,
  emptyDescription,
  defaultDocumentType,
  compact = false,
  showPatientFacing = false,
}: {
  context: DocumentContext;
  title: string;
  subtitle: string;
  emptyTitle: string;
  emptyDescription: string;
  defaultDocumentType: string;
  compact?: boolean;
  showPatientFacing?: boolean;
}): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [versions, setVersions] = useState<Record<string, VersionRow[]>>({});
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [newVersionFor, setNewVersionFor] = useState<DocumentRow | null>(null);
  const [detail, setDetail] = useState<DocumentRow | null>(null);
  const [preview, setPreview] = useState<{
    doc: DocumentRow;
    version: VersionRow;
    url: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query =
      context.kind === "patient"
        ? { patientId: context.patientId }
        : { aggregateType: "referral", aggregateId: context.referralId };
    const { data, error: err } = await client.GET("/api/v1/documents", {
      params: { query },
    });
    if (err) {
      setError(errorMessage(err, "Could not load documents."));
      setLoading(false);
      return;
    }
    const items = ((data?.items ?? []) as DocumentRow[])
      .filter((doc) => Boolean(doc?.id && doc?.title && doc?.aggregateType))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    setRows(items);
    setLoading(false);
    const versionPairs = await Promise.all(
      items.map(async (doc) => {
        const response = await client.GET("/api/v1/documents/{id}/versions", {
          params: { path: { id: doc.id }, query: { limit: 25 } },
        });
        return [
          doc.id,
          response.error ? [] : ((response.data?.items ?? []) as VersionRow[]),
        ] as const;
      }),
    );
    setVersions(Object.fromEntries(versionPairs));
  }, [client, context]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      rows.filter((doc) => !filter || displayDocumentTypeValue(doc) === filter),
    [filter, rows],
  );

  const openSigned = async (
    doc: DocumentRow,
    mode: "preview" | "download",
  ): Promise<void> => {
    const current = currentVersion(doc, versions[doc.id]);
    if (!current) {
      setError("This document has no current uploaded version yet.");
      return;
    }
    const { data, error: err } = await client.GET(
      "/api/v1/documents/{id}/versions/{versionId}/content",
      {
        params: {
          path: { id: doc.id, versionId: current.id },
          query: { purpose: "treatment", ttlSeconds: 300 },
        },
      },
    );
    if (err || !data?.url) {
      setError(errorMessage(err, "Signed URL is unavailable."));
      return;
    }
    if (mode === "preview" && canInlinePreview(current.mimeType)) {
      setPreview({ doc, version: current, url: data.url });
    } else {
      window.open(data.url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <section style={compact ? referralShell : patientShell}>
      <div style={sectionHead}>
        <div>
          <h2 style={compact ? compactTitle : pageTitle}>{title}</h2>
          <p style={muted}>{subtitle}</p>
        </div>
        <Button tone="primary" onClick={() => setUploadOpen(true)}>
          Upload document
        </Button>
      </div>

      {error ? (
        <div role="alert" style={alert}>
          {error}
        </div>
      ) : null}

      <div style={filters}>
        {FILTERS.map((option) => (
          <button
            key={option.value || "all"}
            type="button"
            style={option.value === filter ? filterActive : filterButton}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : visible.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          action={
            <Button tone="primary" onClick={() => setUploadOpen(true)}>
              Upload document
            </Button>
          }
        />
      ) : (
        <div style={list}>
          {visible.map((doc) => {
            const current = currentVersion(doc, versions[doc.id]);
            return (
              <article key={doc.id} style={rowShell}>
                <div style={typeBadge(displayDocumentTypeValue(doc))}>
                  {displayDocumentType(doc)}
                </div>
                <div style={rowMain}>
                  <strong style={rowTitle}>{doc.title}</strong>
                  <div style={rowMeta}>
                    {current ? formatMime(current.mimeType) : "File"} • v
                    {doc.version || current?.versionNumber || 1}
                    {" • "}
                    {formatDate(doc.updatedAt)}
                    {doc.admissionId
                      ? ` • Admission ${shortId(doc.admissionId)}`
                      : ""}
                  </div>
                  <div style={rowMeta}>{provenanceLabel(doc.metadata)}</div>
                </div>
                <StatusPill
                  label={labelize(doc.status)}
                  tone={lifecycleTone(doc.status)}
                />
                <div style={rowActions}>
                  <button
                    type="button"
                    style={linkButton}
                    onClick={() => void openSigned(doc, "preview")}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    style={linkButton}
                    onClick={() => void openSigned(doc, "download")}
                  >
                    Download
                  </button>
                  <button
                    type="button"
                    style={linkButton}
                    onClick={() => setDetail(doc)}
                  >
                    History
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {uploadOpen ? (
        <DocumentUploadDialog
          context={context}
          defaultDocumentType={defaultDocumentType}
          showPatientFacing={showPatientFacing}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            void load();
          }}
        />
      ) : null}
      {newVersionFor ? (
        <DocumentUploadDialog
          context={context}
          mode="new_version"
          targetDocument={newVersionFor}
          defaultDocumentType={displayDocumentTypeValue(newVersionFor)}
          showPatientFacing={showPatientFacing}
          onClose={() => setNewVersionFor(null)}
          onUploaded={() => {
            setNewVersionFor(null);
            void load();
          }}
        />
      ) : null}
      {detail ? (
        <DocumentDetail
          doc={detail}
          versions={versions[detail.id] ?? []}
          onClose={() => setDetail(null)}
          onOpen={(mode) => void openSigned(detail, mode)}
          onNewVersion={() => {
            setDetail(null);
            setNewVersionFor(detail);
          }}
        />
      ) : null}
      {preview ? (
        <PreviewModal preview={preview} onClose={() => setPreview(null)} />
      ) : null}
    </section>
  );
}

function DocumentUploadDialog({
  context,
  defaultDocumentType,
  showPatientFacing,
  mode = "new_document",
  targetDocument,
  onClose,
  onUploaded,
}: {
  context: DocumentContext;
  defaultDocumentType: string;
  showPatientFacing: boolean;
  mode?: "new_document" | "new_version";
  targetDocument?: DocumentRow;
  onClose: () => void;
  onUploaded: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [documentType, setDocumentType] = useState<DocumentTypeValue>(
    asDocumentType(defaultDocumentType),
  );
  const [sourceChannel, setSourceChannel] = useState<SourceChannel>(
    context.kind === "referral" ? "fax" : "manual_upload",
  );
  const [receivedAt, setReceivedAt] = useState("");
  const [title, setTitle] = useState(
    targetDocument?.title ?? defaultTitle(defaultDocumentType),
  );
  const [patientFacing, setPatientFacing] = useState(
    targetDocument?.patientFacing ?? false,
  );
  const [file, setFile] = useState<File | null>(null);
  const [sender, setSender] = useState("");
  const [externalMessageId, setExternalMessageId] = useState("");
  const [faxReference, setFaxReference] = useState("");
  const [notes, setNotes] = useState("");
  const [stage, setStage] = useState<UploadStage>("idle");
  const [error, setError] = useState<string | null>(null);

  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setFile(event.dataTransfer.files[0] ?? null);
  };

  const submit = async (): Promise<void> => {
    if (!file) {
      setError("Choose a PDF, DOCX, JPG, PNG or TIFF file.");
      return;
    }
    setError(null);
    try {
      await verifiedUpload(client, {
        context,
        mode,
        targetDocumentId: targetDocument?.id,
        file,
        title: title.trim() || file.name,
        documentType,
        patientFacing,
        sourceMetadata: prune({
          documentType,
          sourceChannel,
          receivedAt: receivedAt
            ? new Date(receivedAt).toISOString()
            : undefined,
          originalFilename: file.name,
          sender,
          externalMessageId,
          faxReference,
          notes,
        }),
        onStage: setStage,
      });
      onUploaded();
    } catch (err) {
      setError(errorMessage(err, "The upload could not be completed."));
      if (stage !== "complete") setStage("idle");
    }
  };

  const isVersion = mode === "new_version";
  return (
    <Modal
      onClose={onClose}
      title={isVersion ? "Upload new version" : "Upload document"}
    >
      <div style={form}>
        {error ? (
          <div role="alert" style={alert}>
            {error}
          </div>
        ) : null}
        {!isVersion ? (
          <label style={field}>
            Document type
            <select
              value={documentType}
              onChange={(event) => {
                const next = asDocumentType(event.target.value);
                setDocumentType(next);
                if (!title || title === defaultTitle(documentType))
                  setTitle(defaultTitle(next));
              }}
              style={input}
            >
              {DOCUMENT_TYPE_OPTIONS.filter(
                (option) =>
                  context.kind === "referral" || option.value !== "referral",
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label style={field}>
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            style={input}
          />
        </label>
        {context.kind === "referral" ? (
          <>
            <label style={field}>
              Source
              <select
                value={sourceChannel}
                onChange={(event) =>
                  setSourceChannel(asSourceChannel(event.target.value))
                }
                style={input}
              >
                {SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={field}>
              Received at
              <input
                type="datetime-local"
                value={receivedAt}
                onChange={(event) => setReceivedAt(event.target.value)}
                style={input}
              />
            </label>
            <div style={optionalGrid}>
              <label style={field}>
                Sender
                <input
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  style={input}
                />
              </label>
              <label style={field}>
                Message ID
                <input
                  value={externalMessageId}
                  onChange={(event) => setExternalMessageId(event.target.value)}
                  style={input}
                />
              </label>
              <label style={field}>
                Fax reference
                <input
                  value={faxReference}
                  onChange={(event) => setFaxReference(event.target.value)}
                  style={input}
                />
              </label>
            </div>
          </>
        ) : showPatientFacing ? (
          <label style={check}>
            <input
              type="checkbox"
              checked={patientFacing}
              onChange={(event) => setPatientFacing(event.target.checked)}
            />
            Visible in patient portal
          </label>
        ) : null}
        <label
          style={dropZone}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <input
            type="file"
            accept=".pdf,.docx,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/tiff"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            style={{ display: "none" }}
          />
          <strong>{file ? file.name : "Choose file or drag and drop"}</strong>
          <span style={muted}>PDF, DOCX, JPG, PNG or TIFF • Maximum 25 MB</span>
        </label>
        <label style={field}>
          Notes
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            style={input}
          />
        </label>
        <div style={stageLine}>{stageLabel(stage)}</div>
        <div style={dialogActions}>
          <Button tone="tertiary" onClick={onClose} disabled={stage !== "idle"}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() => void submit()}
            disabled={stage !== "idle"}
          >
            Upload
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DocumentDetail({
  doc,
  versions,
  onClose,
  onOpen,
  onNewVersion,
}: {
  doc: DocumentRow;
  versions: VersionRow[];
  onClose: () => void;
  onOpen: (mode: "preview" | "download") => void;
  onNewVersion: () => void;
}): JSX.Element {
  const current = currentVersion(doc, versions);
  return (
    <Modal onClose={onClose} title={doc.title}>
      <div style={form}>
        <div style={detailGrid}>
          <Field label="Type" value={displayDocumentType(doc)} />
          <Field label="Status" value={labelize(doc.status)} />
          <Field
            label="Uploaded"
            value={formatDateTime(current?.uploadedAt ?? doc.createdAt)}
          />
          <Field label="Source" value={provenanceLabel(doc.metadata)} />
          <Field
            label="Patient"
            value={doc.patientId ? shortId(doc.patientId) : "Not linked"}
          />
          <Field
            label="Admission"
            value={doc.admissionId ? shortId(doc.admissionId) : "Not linked"}
          />
          <Field
            label="Current version"
            value={`v${current?.versionNumber ?? doc.version ?? 1}`}
          />
          <Field
            label="File type"
            value={current ? formatMime(current.mimeType) : "Unknown"}
          />
          <Field
            label="File size"
            value={current ? formatBytes(current.byteSize) : "Unknown"}
          />
        </div>
        <div style={dialogActions}>
          <Button tone="secondary" onClick={() => onOpen("preview")}>
            View
          </Button>
          <Button tone="secondary" onClick={() => onOpen("download")}>
            Download/Open
          </Button>
          <Button tone="primary" onClick={onNewVersion}>
            Upload new version
          </Button>
        </div>
        <h3 style={smallHeading}>Version history</h3>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Version</th>
              <th style={th}>Type</th>
              <th style={th}>Size</th>
              <th style={th}>Uploaded</th>
              <th style={th}>Current</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.id}>
                <td style={td}>v{version.versionNumber}</td>
                <td style={td}>{formatMime(version.mimeType)}</td>
                <td style={td}>{formatBytes(version.byteSize)}</td>
                <td style={td}>{formatDateTime(version.uploadedAt)}</td>
                <td style={td}>{version.id === current?.id ? "Active" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function PreviewModal({
  preview,
  onClose,
}: {
  preview: { doc: DocumentRow; version: VersionRow; url: string };
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal onClose={onClose} title={`View ${preview.doc.title}`}>
      <div style={previewFrame}>
        {preview.version.mimeType === "application/pdf" ? (
          <iframe
            title={preview.doc.title}
            src={preview.url}
            style={previewMedia}
          />
        ) : (
          <img src={preview.url} alt={preview.doc.title} style={previewImage} />
        )}
      </div>
    </Modal>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}): JSX.Element {
  return (
    <div>
      <div style={fieldLabel}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      style={modalBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <section style={modal}>
        <div style={sectionHead}>
          <h2 style={compactTitle}>{title}</h2>
          <button
            type="button"
            style={iconButton}
            onClick={onClose}
            aria-label="Close"
          >
            x
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

async function verifiedUpload(
  client: ApiClient,
  input: {
    context: DocumentContext;
    mode: "new_document" | "new_version";
    targetDocumentId?: string;
    file: File;
    title: string;
    documentType: DocumentTypeValue;
    patientFacing: boolean;
    sourceMetadata: DocumentMetadata;
    onStage: (stage: UploadStage) => void;
  },
): Promise<void> {
  const mimeType = normalizeMime(input.file);
  if (!mimeType) {
    throw new Error(
      "Unsupported file type. Upload PDF, DOCX, JPG, PNG or TIFF.",
    );
  }
  if (input.file.size > 25 * 1024 * 1024) {
    throw new Error("File is too large. Maximum size is 25 MB.");
  }
  input.onStage("preparing");
  const sha256Hex = await sha256(input.file);
  const body = {
    mode: input.mode,
    targetDocumentId: input.targetDocumentId,
    patientId:
      input.context.kind === "patient"
        ? input.context.patientId
        : (input.context.patientId ?? undefined),
    admissionId: input.context.admissionId ?? undefined,
    retentionClass: retentionFor(input.documentType),
    aggregateType:
      input.context.kind === "referral" ? "referral" : input.documentType,
    aggregateId:
      input.context.kind === "referral" ? input.context.referralId : undefined,
    title: input.title,
    patientFacing: input.patientFacing,
    mimeType,
    byteSize: input.file.size,
    sha256Hex,
    sourceMetadata: input.sourceMetadata,
  };
  const initiated = await client.POST("/api/v1/document-uploads", { body });
  if (initiated.error || !initiated.data) {
    throw new Error(
      errorMessage(initiated.error, "Upload could not be prepared."),
    );
  }
  input.onStage("uploading");
  const uploadId = initiated.data.uploadId;
  try {
    const uploadHeaders = new Headers(initiated.data.requiredHeaders);

    if (!uploadHeaders.has("content-type")) {
      uploadHeaders.set("content-type", mimeType);
    }

    const put = await fetch(initiated.data.uploadUrl, {
      method: "PUT",
      headers: uploadHeaders,
      body: input.file,
    });
    if (!put.ok) throw new Error(storageError(put.status));
    input.onStage("verifying");
    const completed = await client.POST(
      "/api/v1/document-uploads/{id}/complete",
      {
        params: { path: { id: uploadId } },
        body: {},
      },
    );
    if (completed.error) {
      throw new Error(
        errorMessage(
          completed.error,
          "Object uploaded, but verification did not complete. Try again or contact support.",
        ),
      );
    }
    input.onStage("complete");
  } catch (err) {
    await client
      .DELETE("/api/v1/document-uploads/{id}", {
        params: { path: { id: uploadId } },
      })
      .catch(() => undefined);
    throw err;
  }
}

async function sha256(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error("This browser cannot verify file integrity.");
  const bytes =
    typeof file.arrayBuffer === "function"
      ? await file.arrayBuffer()
      : await new Response(file).arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeMime(file: File): AcceptedMime | "" {
  if (isAcceptedMime(file.type)) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".tif") || name.endsWith(".tiff")) return "image/tiff";
  return "";
}

function isAcceptedMime(value: string): value is AcceptedMime {
  return ACCEPTED_MIME.has(value as AcceptedMime);
}

function displayDocumentType(doc: DocumentRow): string {
  return labelForType(displayDocumentTypeValue(doc));
}

function displayDocumentTypeValue(doc: DocumentRow): string {
  return doc.metadata?.documentType ?? doc.aggregateType;
}

function labelForType(value: string): string {
  return (
    DOCUMENT_TYPE_OPTIONS.find((option) => option.value === value)?.label ??
    labelize(value)
  );
}

function asDocumentType(value: string): DocumentTypeValue {
  return DOCUMENT_TYPE_OPTIONS.some((option) => option.value === value)
    ? (value as DocumentTypeValue)
    : "other";
}

function asSourceChannel(value: string): SourceChannel {
  return SOURCE_OPTIONS.some((option) => option.value === value)
    ? (value as SourceChannel)
    : "manual_upload";
}

function defaultTitle(value: string): string {
  if (value === "code_status_directive") return "Patient POLST";
  if (value === "consent_record") return "Hospice consent";
  if (value === "referral") return "Referral packet";
  if (value === "intake_source") return "Intake document";
  return "Patient document";
}

function retentionFor(documentType: DocumentTypeValue): RetentionClass {
  return documentType === "referral" || documentType === "intake_source"
    ? "intake_artifact"
    : "clinical_record";
}

function currentVersion(
  doc: DocumentRow,
  versions: VersionRow[] | undefined,
): VersionRow | null {
  if (!versions?.length) return null;
  return (
    [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null
  );
}

function provenanceLabel(metadata: DocumentMetadata | null): string {
  if (!metadata?.sourceChannel) return "Source not recorded";
  const source =
    SOURCE_OPTIONS.find((option) => option.value === metadata.sourceChannel)
      ?.label ?? labelize(metadata.sourceChannel);
  const received = metadata.receivedAt
    ? ` • Received ${formatDateTime(metadata.receivedAt)}`
    : "";
  const sender = metadata.sender ? ` • ${metadata.sender}` : "";
  return `${source}${received}${sender}`;
}

function formatMime(mime: string): string {
  return ACCEPTED_MIME.get(mime as AcceptedMime) ?? mime;
}

function canInlinePreview(mime: string): boolean {
  return (
    mime === "application/pdf" || mime === "image/jpeg" || mime === "image/png"
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function labelize(value: string | undefined): string {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function prune(metadata: DocumentMetadata): DocumentMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([, value]) => value != null && value !== "",
    ),
  ) as DocumentMetadata;
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as {
    error?: { message?: string; details?: Array<{ message?: string }> };
    message?: string;
  };
  const message =
    e?.error?.details?.[0]?.message ??
    e?.error?.message ??
    e?.message ??
    fallback;
  if (/mime|unsupported/i.test(message))
    return "Unsupported file type. Upload PDF, DOCX, JPG, PNG or TIFF.";
  if (/size|too large/i.test(message))
    return "File is too large. Maximum size is 25 MB.";
  if (/sha|checksum|integrity/i.test(message))
    return "The upload failed integrity verification. Choose the file again and retry.";
  if (/expired/i.test(message))
    return "The upload expired. Start a new upload and try again.";
  if (/referral/i.test(message) && /not found|denied|access/i.test(message))
    return "Referral not accessible.";
  if (/patient/i.test(message) && /not found|denied|access/i.test(message))
    return "Patient not accessible.";
  if (/VERSION_MISMATCH|412/i.test(message))
    return "This document changed since you opened it. Refresh and try again.";
  if (/storage|s3|minio/i.test(message))
    return "Document storage is temporarily unavailable.";
  return message;
}

function storageError(status: number): string {
  if (status >= 500) return "Document storage is temporarily unavailable.";
  if (status === 403)
    return "The upload URL is no longer valid. Start a new upload and try again.";
  return "The file could not be uploaded to document storage.";
}

function stageLabel(stage: UploadStage): string {
  const labels: Record<UploadStage, string> = {
    idle: "Ready",
    preparing: "Preparing upload",
    uploading: "Uploading",
    verifying: "Verifying",
    complete: "Complete",
  };
  return labels[stage];
}

const patientShell: CSSProperties = { display: "grid", gap: "1rem" };
const referralShell: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  padding: "1rem",
  display: "grid",
  gap: "0.85rem",
};
const sectionHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};
const pageTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.375rem",
  color: t.onSurface,
};
const compactTitle: CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  color: "var(--color-on-surface)",
};
const muted: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};
const alert: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--color-error) 35%, transparent)",
  borderRadius: "8px",
  color: "var(--color-error)",
  padding: "0.75rem 1rem",
};
const filters: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const filterButton: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "999px",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  padding: "0.45rem 0.75rem",
  cursor: "pointer",
};
const filterActive: CSSProperties = {
  ...filterButton,
  borderColor: "var(--color-primary)",
  background:
    "color-mix(in srgb, var(--color-primary) 12%, var(--color-surface))",
  fontWeight: 700,
};
const list: CSSProperties = { display: "grid", gap: "0.65rem" };
const rowShell: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 11rem), 1fr))",
  gap: "0.85rem",
  alignItems: "center",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  padding: "0.85rem",
};
const rowMain: CSSProperties = { display: "grid", gap: "0.2rem", minWidth: 0 };
const rowTitle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const rowMeta: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};
const rowActions: CSSProperties = {
  display: "flex",
  gap: "0.45rem",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};
const linkButton: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--color-primary)",
  fontWeight: 700,
  cursor: "pointer",
  padding: "0.25rem",
};
const modalBackdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(17, 24, 39, 0.36)",
  display: "grid",
  placeItems: "center",
  zIndex: 50,
  padding: "1rem",
};
const modal: CSSProperties = {
  width: "min(56rem, 100%)",
  maxHeight: "90vh",
  overflow: "auto",
  background: "var(--color-surface)",
  borderRadius: "8px",
  boxShadow: "var(--shadow-soft)",
  padding: "1rem",
  display: "grid",
  gap: "1rem",
};
const iconButton: CSSProperties = {
  width: "2rem",
  height: "2rem",
  borderRadius: "999px",
  border: "1px solid var(--color-outline-variant)",
  background: "var(--color-surface)",
  cursor: "pointer",
};
const form: CSSProperties = { display: "grid", gap: "0.8rem" };
const field: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontSize: "0.85rem",
  fontWeight: 600,
};
const input: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  padding: "0.6rem 0.7rem",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  font: "inherit",
  minWidth: 0,
};
const optionalGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.7rem",
};
const check: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.9rem",
};
const dropZone: CSSProperties = {
  border: "1px dashed var(--color-outline)",
  borderRadius: "8px",
  padding: "1rem",
  display: "grid",
  placeItems: "center",
  textAlign: "center",
  gap: "0.25rem",
  cursor: "pointer",
  background: "var(--color-surface-low)",
};
const stageLine: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};
const dialogActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.8rem",
};
const fieldLabel: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: 0,
};
const smallHeading: CSSProperties = {
  margin: "0.5rem 0 0",
  fontSize: "0.95rem",
};
const table: CSSProperties = { width: "100%", borderCollapse: "collapse" };
const th: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.78rem",
  padding: "0.55rem",
};
const td: CSSProperties = {
  borderTop: "1px solid var(--color-outline-variant)",
  padding: "0.55rem",
  fontSize: "0.85rem",
};
const previewFrame: CSSProperties = {
  height: "70vh",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  overflow: "hidden",
  background: "var(--color-surface-low)",
};
const previewMedia: CSSProperties = {
  width: "100%",
  height: "100%",
  border: 0,
};
const previewImage: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
};

function typeBadge(value: string): CSSProperties {
  const polst = value === "code_status_directive";
  return {
    borderRadius: "8px",
    padding: "0.55rem 0.65rem",
    background: polst
      ? "color-mix(in srgb, var(--color-warning) 18%, var(--color-surface))"
      : "var(--color-surface-low)",
    color: polst
      ? "var(--color-on-surface)"
      : "var(--color-on-surface-variant)",
    fontWeight: 800,
    textAlign: "center",
    fontSize: "0.84rem",
  };
}
