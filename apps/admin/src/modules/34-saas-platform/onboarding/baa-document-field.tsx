// apps/admin/src/modules/34-saas-platform/onboarding — step 3, the signed agreement: the operator chooses the file, the panel checks what it
// can before any request (a type, not empty, at most 10 MB: the server checks again, and it is the server's word that counts), and the
// upload goes through the reason prompt (a fresh step-up, a reason, an Idempotency-Key) to the platform route, which files it with the
// tenant's documents under its one BAA kind. The panel then records the BAA with the document id that came back.
// A chosen file cannot survive a Re-verify (the page is left): the typed form is stashed, the file is chosen again.
import { Button, InlineAlert, TextField, useApiClient, useRequestGuard } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { sha256Hex } from "./body-digest";
import { RecordSaveDialog } from "./record-save-dialog";
import { useOpsWrite } from "./use-ops-write";

/** The signed agreement's cap (the route's own, below the documents pipeline's); the server enforces it on the decoded bytes. */
export const BAA_FILE_MAX_BYTES = 10 * 1024 * 1024;
type AgreementMime =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/tiff"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TYPE_BY_EXTENSION: Readonly<Record<string, AgreementMime>> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const ALLOWED_TYPES: ReadonlySet<string> = new Set(Object.values(TYPE_BY_EXTENSION));
const ACCEPT = Object.keys(TYPE_BY_EXTENSION)
  .map((ext) => `.${ext}`)
  .join(",");
const BYTES_PER_MB = 1024 * 1024;

interface Picked {
  readonly name: string;
  readonly mimeType: AgreementMime;
  readonly size: number;
  readonly contentBase64: string;
  /** SHA-256 of the content (hex): the upload's idempotency fingerprint, so two different files never share a key. */
  readonly digest: string;
}

/** The type the server will see: the browser's, else the extension's. Null when it is not one the pipeline accepts. */
export function agreementMimeType(file: { name: string; type: string }): AgreementMime | null {
  const declared = file.type.trim().toLowerCase();
  if (ALLOWED_TYPES.has(declared)) return declared as AgreementMime;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return TYPE_BY_EXTENSION[extension] ?? null;
}

/** Why a chosen file is not sent, or null. */
export function agreementProblem(file: { name: string; type: string; size: number }):
  | string
  | null {
  if (agreementMimeType(file) === null) return "Choose a PDF, JPEG, PNG, TIFF or Word file.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > BAA_FILE_MAX_BYTES) return "The file can be at most 10 MB.";
  return null;
}

/** The file's bytes as base64, via FileReader (a data URL is `data:<type>;base64,<payload>`). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("unreadable file"));
    reader.readAsDataURL(file);
  });
}

const sizeLabel = (bytes: number): string =>
  bytes >= BYTES_PER_MB
    ? `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function BaaDocumentField({
  orgSlug,
  linked,
  uploadedName,
  error,
  onUploaded,
  onReverify,
}: {
  orgSlug: string;
  /** A signed document is already linked to what is being edited (or was uploaded in this form). */
  linked: boolean;
  /** The file uploaded in this form, if any (its id is already in the form). */
  uploadedName: string | null;
  error?: string | undefined;
  onUploaded: (documentId: string, fileName: string) => void;
  /** Called just before leaving for Re-verify: the caller stashes what was typed. */
  onReverify: () => void;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [asking, setAsking] = useState(false);
  // A read is slow (up to 10 MB): only the newest pick may land, so a stale read can never replace a file chosen after it.
  const guard = useRequestGuard();

  async function choose(file: File | null): Promise<void> {
    const isCurrent = guard();
    setPicked(null);
    setFileError(null);
    if (!file) return;
    const mimeType = agreementMimeType(file);
    const problem = agreementProblem(file);
    if (problem || mimeType === null) {
      setFileError(problem ?? "Choose a PDF, JPEG, PNG, TIFF or Word file.");
      return;
    }
    try {
      const contentBase64 = await readBase64(file);
      // SHA-256 of the base64 text the request carries (one-to-one with the bytes)
      const digest = await sha256Hex(contentBase64);
      if (!isCurrent()) return;
      setPicked({ name: file.name, mimeType, size: file.size, contentBase64, digest });
    } catch {
      if (isCurrent()) setFileError("The file could not be read. Choose it again.");
    }
  }

  async function upload(reason: string): Promise<void> {
    if (!picked) return;
    const body = { contentBase64: picked.contentBase64, mimeType: picked.mimeType, reason };
    const outcome = await write.run(`${picked.digest}:${picked.mimeType}:${reason}`, (key) =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/baa-document", {
        params: { path: { orgSlug }, header: { "Idempotency-Key": key } },
        body,
      }),
    );
    if (!outcome.ok) return;
    onUploaded(outcome.data.documentId, picked.name);
    setPicked(null);
    setInputKey((k) => k + 1);
    setAsking(false);
  }

  return (
    <div className="wx-form-field-wide">
      <TextField
        key={inputKey}
        type="file"
        label="Signed agreement"
        accept={ACCEPT}
        hint="PDF, JPEG, PNG, TIFF or Word, at most 10 MB. Required when the status is executed."
        error={fileError ?? error}
        onChange={(e) => void choose(e.target.files?.[0] ?? null)}
      />
      {uploadedName ? (
        <InlineAlert tone="success">
          Uploaded {uploadedName}. Save the BAA to link it to this record.
        </InlineAlert>
      ) : linked ? (
        <p>A signed agreement is linked. Choose a file to replace it.</p>
      ) : null}
      <Button
        size="sm"
        tone="secondary"
        disabled={picked === null || write.busy}
        onClick={() => setAsking(true)}
      >
        Upload agreement
      </Button>

      <RecordSaveDialog
        open={asking}
        title="Upload the signed agreement"
        description={
          picked
            ? `${picked.name} (${sizeLabel(picked.size)}) is filed with this tenant's documents. Re-verifying leaves this page: choose the file again afterwards.`
            : undefined
        }
        confirmLabel="Upload"
        write={write}
        orgSlug={orgSlug}
        onReverify={onReverify}
        onConfirm={(reason) => void upload(reason)}
        onCancel={() => {
          write.clear();
          setAsking(false);
        }}
      />
    </div>
  );
}
