// M36 WP 2.8 - platform templates for a template manager. Each shows the platform wording (the floor), the words an
// overlay must keep, and this organization's overlay: re-word the title/body, hide it from staff, or go back to the
// platform text. The server refuses an overlay that drops a required phrase or contains an identifier; its refusal is
// shown here verbatim (it never contains the text that triggered it).
import { Button, ConfirmDialog, InlineAlert, Panel, TextAreaField, TextField } from "@wardenx/ui";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { CATEGORY_LABEL, type PlatformReplyAdmin } from "./saved-replies-types";

export interface OverlayWrites {
  readonly save: (
    id: string,
    overlay: { title: string | null; body: string | null; isEnabled: boolean },
  ) => Promise<string | null>;
  readonly reset: (id: string) => Promise<string | null>;
}

function PlatformReplyRow({
  item,
  writes,
}: { item: PlatformReplyAdmin; writes: OverlayWrites }): JSX.Element {
  const overlay = item.overlay;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(overlay?.title ?? item.floorTitle);
  const [body, setBody] = useState(overlay?.body ?? item.floorBody);
  const [enabled, setEnabled] = useState(overlay?.isEnabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const status = !overlay
    ? "Platform text"
    : !overlay.isEnabled
      ? "Hidden from staff"
      : overlay.title !== null || overlay.body !== null
        ? "Customized"
        : "Platform text";

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    // Text identical to the platform's is stored as "keep the platform text", so a later platform update still flows.
    const failure = await writes.save(item.id, {
      title: title.trim() === item.floorTitle ? null : title,
      body: body.trim() === item.floorBody ? null : body,
      isEnabled: enabled,
    });
    setPending(false);
    if (failure) setError(failure);
    else setEditing(false);
  }

  async function reset(): Promise<void> {
    setPending(true);
    const failure = await writes.reset(item.id);
    setPending(false);
    setConfirmReset(false);
    if (failure) setError(failure);
    else {
      setEditing(false);
      setTitle(item.floorTitle);
      setBody(item.floorBody);
      setEnabled(true);
    }
  }

  return (
    <li className="wx-saved-reply-row">
      <strong>{item.floorTitle}</strong>
      <small>
        {CATEGORY_LABEL[item.category]} · {status}
      </small>
      <p>{overlay?.body ?? item.floorBody}</p>
      {item.requiredPhrases.length > 0 ? (
        <ul className="wx-required-phrases" aria-label={`Wording ${item.floorTitle} must keep`}>
          {item.requiredPhrases.map((phrase) => (
            <li key={phrase}>{phrase}</li>
          ))}
        </ul>
      ) : null}
      {error && !editing ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {editing ? (
        <form
          className="wx-saved-reply-form"
          aria-label={`Customize ${item.floorTitle}`}
          onSubmit={(event) => void save(event)}
        >
          <TextField
            label="Title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
          />
          <TextAreaField
            label="Reply text"
            hint={
              item.requiredPhrases.length > 0
                ? `Must keep: ${item.requiredPhrases.join(", ")}.`
                : "Plain text. Identifiers are refused."
            }
            rows={4}
            maxLength={2000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            Available to staff in the composer
          </label>
          {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
          <div className="wx-saved-reply-form-actions">
            <Button type="submit" loading={pending}>
              Save
            </Button>
            <Button
              type="button"
              tone="secondary"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="wx-saved-reply-actions">
          <Button
            type="button"
            tone="secondary"
            aria-label={`Customize ${item.floorTitle}`}
            onClick={() => setEditing(true)}
          >
            Customize
          </Button>
          {overlay ? (
            <Button
              type="button"
              tone="secondary"
              aria-label={`Use platform text for ${item.floorTitle}`}
              onClick={() => setConfirmReset(true)}
            >
              Use platform text
            </Button>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={confirmReset}
        title="Use the platform text?"
        description="This organization's customization of this template is removed."
        confirmLabel="Use platform text"
        pending={pending}
        onConfirm={() => void reset()}
        onCancel={() => setConfirmReset(false)}
      />
    </li>
  );
}

export function PlatformReplyPanel({
  items,
  writes,
}: { items: readonly PlatformReplyAdmin[]; writes: OverlayWrites }): JSX.Element {
  return (
    <Panel
      title="Platform templates"
      icon="shield"
      description="Provided for every organization. You can re-word or hide them, but required wording stays."
    >
      <ul className="wx-saved-reply-list">
        {items.map((item) => (
          <PlatformReplyRow key={item.id} item={item} writes={writes} />
        ))}
      </ul>
    </Panel>
  );
}
