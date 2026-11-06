// apps/web/src/modules/16-bereavement — edit ONE DRAFT RUN's wording (ADR-0109 D10, route 47).
//
// The save carries the run version the page READ in `If-Match`; a 412 means the run moved, which is said, the page reloads, and what was
// typed stays in the editor (nothing is lost to a refusal). Unsaved wording is protected three ways: the scrim cannot dismiss the
// dialog, Cancel and Escape ask before discarding, and while the write is in flight every control is inert and the dialog cannot close.
import { useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import {
  type MailingRun,
  errorMessage,
  isStaleWrite,
  updateMailingRunContent,
} from "./bereavement-api";
import {
  ErrorText,
  Modal,
  Notice,
  ghostButtonStyle,
  primaryButtonStyle,
  useIdempotencyKey,
} from "./bereavement-ui";
import { MailingContentEditor } from "./mailing-content-editor";
import { contentForSave, sameWording, wordingOf, wordingProblems } from "./mailing-status";

const RUN_MOVED =
  "This run changed while you were editing. The page has been refreshed; your wording is still here, so check it and save again.";

export function EditWordingModal({
  run,
  onClose,
  onSaved,
  onStale,
}: {
  run: MailingRun;
  onClose: () => void;
  onSaved: (run: MailingRun) => void;
  /** The run moved under the editor: the page reloads (the draft in the editor is kept). */
  onStale: () => void;
}): JSX.Element {
  const client = useApiClient();
  const baseline = wordingOf(run.content);
  const [draft, setDraft] = useState(baseline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const idempotency = useIdempotencyKey();

  const dirty = !sameWording(draft, baseline);
  const blocked = wordingProblems(draft).length > 0;

  /** Cancel, Escape and the header close all land here: unsaved wording asks first. */
  const requestClose = (): void => {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const content = contentForSave(draft);
    const {
      run: next,
      error: err,
      status,
    } = await updateMailingRunContent(
      client,
      run.runId,
      run.version,
      content,
      idempotency.keyFor(`${run.version}:${JSON.stringify(content)}`),
    );
    idempotency.settle(status);
    setBusy(false);
    if (err || !next) {
      if (isStaleWrite(status)) onStale();
      setError(status === 412 ? RUN_MOVED : errorMessage(err, "The wording could not be saved."));
      return;
    }
    onSaved(next);
  };

  return (
    <Modal
      title="Edit the wording"
      onClose={requestClose}
      busy={busy}
      dirty={dirty}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || blocked || !dirty}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save wording"}
        </button>
      }
    >
      <MailingContentEditor value={draft} onChange={setDraft} disabled={busy} />
      {busy ? <Notice tone="info">Saving the wording…</Notice> : null}
      {confirmingDiscard ? (
        <Notice tone="warning">
          You have unsaved wording. Discard it?{" "}
          <button type="button" style={ghostButtonStyle} onClick={onClose}>
            Discard changes
          </button>{" "}
          <button
            type="button"
            style={ghostButtonStyle}
            onClick={() => setConfirmingDiscard(false)}
          >
            Keep editing
          </button>
        </Notice>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
