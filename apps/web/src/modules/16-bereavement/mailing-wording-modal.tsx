// apps/web/src/modules/16-bereavement — edit ONE DRAFT RUN's wording (ADR-0109 D10, route 47).
//
// The save carries the run version the page READ in `If-Match`. A 412 means someone else saved first: the page reloads, what was typed
// stays in the editor, and the dialog shows THEIR saved wording beside it. Saving is then blocked until the reader picks one: "Replace
// with theirs" (drop the typed wording) or "Overwrite with mine" (the next save writes over theirs, against the newer version). A newer
// version is never written over silently. If that reload fails (or still answers the refused version), the dialog says so and offers
// "Try again"; the typed wording stays. A 409/404 (the run is no longer a draft, or is gone) closes the dialog and the page says why.
// Unsaved wording is protected three ways: the scrim cannot dismiss the dialog, Cancel and Escape ask before discarding, and while the
// write is in flight every control is inert and the dialog cannot close.
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
  "Someone else saved this run's wording while you were editing. Your wording is still here. Choose which wording to keep.";

export function EditWordingModal({
  run,
  onClose,
  onSaved,
  onStale,
  onRefused,
}: {
  run: MailingRun;
  onClose: () => void;
  onSaved: (run: MailingRun) => void;
  /** The run moved under the editor: the page reloads (the draft in the editor is kept). Resolves true when the page now holds a fresh read. */
  onStale: () => Promise<boolean>;
  /** The run can no longer take this edit (409 / 404): the page closes the dialog, shows `message` and reloads. */
  onRefused: (message: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const baseline = wordingOf(run.content);
  const [draft, setDraft] = useState(baseline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /** The run version a 412 refused; until the reader chooses, saving is blocked. */
  const [conflictAt, setConflictAt] = useState<number | null>(null);
  /** The page is re-reading the run after a 412. */
  const [reloading, setReloading] = useState(false);
  const idempotency = useIdempotencyKey();
  // The newer wording, once the page has re-read the run past the refused version.
  const theirs = conflictAt !== null && run.version !== conflictAt ? baseline : null;

  const dirty = !sameWording(draft, baseline);
  const blocked = wordingProblems(draft).length > 0;

  /** Cancel, Escape and the header close all land here: unsaved wording asks first. */
  const requestClose = (): void => {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  };

  const reloadTheirs = async (): Promise<void> => {
    setReloading(true);
    await onStale();
    setReloading(false); // whether it failed or answered the same version, `theirs` stays null and the dialog offers "Try again"
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
      if (status === 412) {
        setConflictAt(run.version);
        setError(RUN_MOVED);
        await reloadTheirs();
        return;
      }
      const message = errorMessage(err, "The wording could not be saved.");
      if (isStaleWrite(status)) {
        onRefused(message);
        return;
      }
      setError(message);
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
          disabled={busy || blocked || !dirty || conflictAt !== null}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save wording"}
        </button>
      }
    >
      <MailingContentEditor value={draft} onChange={setDraft} disabled={busy} />
      {busy ? <Notice tone="info">Saving the wording…</Notice> : null}
      {conflictAt !== null ? (
        theirs === null ? (
          reloading ? (
            <Notice tone="info">Loading the newer wording…</Notice>
          ) : (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <ErrorText>
                The newer wording could not be loaded. Your wording is still here.
              </ErrorText>
              <button type="button" style={ghostButtonStyle} onClick={() => void reloadTheirs()}>
                Try again
              </button>
            </div>
          )
        ) : (
          <section aria-label="Their saved wording">
            <Notice tone="warning">
              Their saved wording: <strong>{theirs.title || "(no title)"}</strong>
              {theirs.greeting ? ` ${theirs.greeting}` : ""}
              {theirs.paragraphs.map((p) => ` ${p}`).join("")}
              {theirs.signoff ? ` ${theirs.signoff}` : ""}
            </Notice>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
              <button
                type="button"
                style={ghostButtonStyle}
                onClick={() => {
                  setDraft(theirs);
                  setConflictAt(null);
                  setError(null);
                }}
              >
                Replace with theirs
              </button>
              <button
                type="button"
                style={ghostButtonStyle}
                onClick={() => {
                  setConflictAt(null);
                  setError(null);
                }}
              >
                Overwrite with mine
              </button>
            </div>
          </section>
        )
      ) : null}
      {confirmingDiscard ? (
        <div role="alert">
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
        </div>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
