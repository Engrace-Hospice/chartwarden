// apps/web/src/modules/16-bereavement — upload and register one grief-library item (ADR-0109 D10, route 78 over M22's verified upload).
// The file goes through M22 first (hash, reserve, PUT to storage, complete: a reservation that fails later is aborted), then the returned
// document is registered as a DRAFT library item under one Idempotency-Key per attempt. A draft is not shown to families until published.
import { useApiClient } from "@chartwarden/ui";
import { useId, useRef, useState } from "react";
import type { JSX } from "react";
import { errorMessage } from "./bereavement-api";
import {
  ErrorText,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  mutedStyle,
  primaryButtonStyle,
  useIdempotencyKey,
} from "./bereavement-ui";
import { LIBRARY_CATEGORIES, categoryLabel, intOrNull, orNull } from "./program-status";
import {
  LIBRARY_UPLOAD_MIME,
  type LibraryCategory,
  type LibraryItem,
  registerLibraryItem,
  uploadLibraryDocument,
} from "./programs-api";

export function LibraryUploadModal({
  onClose,
  onRegistered,
}: {
  onClose: () => void;
  onRegistered: (item: LibraryItem) => void;
}): JSX.Element {
  const client = useApiClient();
  const keys = useIdempotencyKey();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<LibraryCategory>("understanding_grief");
  const [sortOrder, setSortOrder] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The document an earlier attempt already uploaded: a retry registers it rather than uploading the file twice. */
  const uploaded = useRef<{ file: File; documentId: string } | null>(null);

  const submit = async (): Promise<void> => {
    const order = intOrNull(sortOrder);
    if (!file) return setError("Choose a file to upload.");
    if (!title.trim()) return setError("Give the item a title.");
    if (order === null || order < 0) return setError("Sort order must be a whole number.");
    setBusy(true);
    setError(null);
    let documentId = uploaded.current?.file === file ? uploaded.current.documentId : null;
    if (documentId === null) {
      const result = await uploadLibraryDocument(client, file, title.trim());
      if ("message" in result) {
        setBusy(false);
        setError(result.message);
        return;
      }
      documentId = result.documentId;
      uploaded.current = { file, documentId };
    }
    const body = {
      documentId,
      title: title.trim(),
      summary: orNull(summary),
      category,
      transcriptDocumentId: null,
      sortOrder: order,
    };
    const res = await registerLibraryItem(client, body, keys.keyFor(JSON.stringify(body)));
    keys.settle(res.status);
    setBusy(false);
    if (res.error || !res.data) {
      setError(
        errorMessage(res.error, "The file was uploaded but could not be added to the library."),
      );
      return;
    }
    onRegistered(res.data);
  };

  return (
    <Modal
      title="Upload a library item"
      onClose={onClose}
      busy={busy}
      dirty
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      }
    >
      <label htmlFor={fileId} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={mutedStyle}>File (MP4 videos up to 500 MB; PDF, PNG or JPEG up to 25 MB)</span>
        <input
          id={fileId}
          type="file"
          accept={LIBRARY_UPLOAD_MIME.join(",")}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <TextField label="Title" value={title} onChange={setTitle} maxLength={200} />
      <TextAreaField label="Summary" value={summary} onChange={setSummary} rows={3} />
      <SelectField
        label="Category"
        value={category}
        onChange={(v) => setCategory(v as LibraryCategory)}
        options={LIBRARY_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
      />
      <TextField label="Sort order" type="number" value={sortOrder} onChange={setSortOrder} />
      <span style={mutedStyle}>
        The item is added as a draft: families see it once it is published.
      </span>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
