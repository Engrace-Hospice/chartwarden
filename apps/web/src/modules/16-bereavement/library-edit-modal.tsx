// apps/web/src/modules/16-bereavement — edit one grief-library item's details (ADR-0109 D10, route 79). The version the page READ goes in
// `If-Match`; a 412 tells the page to reload. The document itself is never replaced here: upload a new item instead.
import { useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { errorMessage, isStaleWrite } from "./bereavement-api";
import {
  ErrorText,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  primaryButtonStyle,
  useIdempotencyKey,
} from "./bereavement-ui";
import { LIBRARY_CATEGORIES, categoryLabel, intOrNull, orNull } from "./program-status";
import { type LibraryCategory, type LibraryItem, updateLibraryItem } from "./programs-api";

export function LibraryEditModal({
  item,
  onClose,
  onSaved,
  onStale,
}: {
  item: LibraryItem;
  onClose: () => void;
  onSaved: (item: LibraryItem) => void;
  /** The item moved under the reader: the page reloads. */
  onStale: () => void;
}): JSX.Element {
  const client = useApiClient();
  const keys = useIdempotencyKey();
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.summary ?? "");
  const [category, setCategory] = useState<LibraryCategory>(item.category);
  const [sortOrder, setSortOrder] = useState(String(item.sortOrder));
  const [transcript, setTranscript] = useState(item.transcriptDocumentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const order = intOrNull(sortOrder);
    if (!title.trim()) return setError("Give the item a title.");
    if (order === null || order < 0) return setError("Sort order must be a whole number.");
    const body = {
      title: title.trim(),
      summary: orNull(summary),
      category,
      transcriptDocumentId: orNull(transcript),
      sortOrder: order,
    };
    setBusy(true);
    setError(null);
    const res = await updateLibraryItem(
      client,
      item.itemId,
      item.version,
      body,
      keys.keyFor(`${item.version}:${JSON.stringify(body)}`),
    );
    keys.settle(res.status);
    setBusy(false);
    if (res.error || !res.data) {
      if (isStaleWrite(res.status)) onStale();
      setError(errorMessage(res.error, "The item could not be saved."));
      return;
    }
    onSaved(res.data);
  };

  return (
    <Modal
      title="Edit library item"
      onClose={onClose}
      busy={busy}
      dirty
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      }
    >
      <TextField label="Title" value={title} onChange={setTitle} maxLength={200} />
      <TextAreaField label="Summary" value={summary} onChange={setSummary} rows={3} />
      <SelectField
        label="Category"
        value={category}
        onChange={(v) => setCategory(v as LibraryCategory)}
        options={LIBRARY_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
      />
      <TextField label="Sort order" type="number" value={sortOrder} onChange={setSortOrder} />
      <TextField
        label="Transcript document id (a PDF, optional)"
        value={transcript}
        onChange={setTranscript}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
