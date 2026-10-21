// M36 WP 2.8 - one form for authoring a personal or shared saved reply. The server owns every rule (bounds, the PHI
// lint, uniqueness); a refusal comes back as text and is shown in place without losing what was typed.
import { Button, InlineAlert, SelectField, TextAreaField, TextField } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import {
  CATEGORY_LABEL,
  type ReplyDraft,
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
} from "./saved-replies-types";

const CATEGORY_OPTIONS = TEMPLATE_CATEGORIES.map((value) => ({
  value,
  label: CATEGORY_LABEL[value],
}));

export interface SavedReplyFormProps {
  readonly heading: string;
  readonly submitLabel: string;
  readonly initial?: ReplyDraft;
  /** Resolves to null on success, or the text to show. */
  readonly onSubmit: (draft: ReplyDraft, idempotencyKey: string) => Promise<string | null>;
  readonly onCancel?: () => void;
}

const EMPTY: ReplyDraft = { title: "", body: "", category: "general" };

export function SavedReplyForm({
  heading,
  submitLabel,
  initial = EMPTY,
  onSubmit,
  onCancel,
}: SavedReplyFormProps): JSX.Element {
  const [draft, setDraft] = useState<ReplyDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  // One Idempotency-Key per attempt: a retry of the same content after a lost reply carries the key again (the server
  // dedupes it); it is dropped when the content changes or the server has answered, so a new reply gets a new key.
  const attemptKey = useRef<string | null>(null);

  function change(next: ReplyDraft): void {
    attemptKey.current = null;
    setDraft(next);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    attemptKey.current ??= crypto.randomUUID();
    try {
      const failure = await onSubmit(draft, attemptKey.current);
      attemptKey.current = null;
      if (failure) setError(failure);
      else if (initial === EMPTY) setDraft(EMPTY);
    } catch {
      // No answer at all: keep the key so a retry of this same content dedupes.
      setError("This could not be saved. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form
      className="wx-saved-reply-form"
      onSubmit={(event) => void submit(event)}
      aria-label={heading}
    >
      <TextField
        label="Title"
        value={draft.title}
        maxLength={120}
        required
        onChange={(event) => change({ ...draft, title: event.target.value })}
      />
      <SelectField
        label="Category"
        value={draft.category}
        options={CATEGORY_OPTIONS}
        onChange={(event) => change({ ...draft, category: event.target.value as TemplateCategory })}
      />
      <TextAreaField
        label="Reply text"
        hint="Plain text. Do not include patient names, dates, phone numbers or identifiers; they are refused."
        value={draft.body}
        rows={4}
        maxLength={2000}
        required
        onChange={(event) => change({ ...draft, body: event.target.value })}
      />
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div className="wx-saved-reply-form-actions">
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" tone="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
