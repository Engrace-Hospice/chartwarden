// apps/web/src/modules/08-encounters/findings — the chrome both findings panels share: a flat section with a heading and a line of guidance,
// the loading / failed-to-load states, and the save row (one Save button and the one status line under it).
//
// The title is an h3: the composer's section heading above it is the h2. A flat section, not a card: the panels sit inside the note composer, which already owns the surface. The status line is the kit's
// InlineAlert (an error is announced at once, a confirmation politely), so nothing here is a hand-rolled notice.
import { Button, InlineAlert, LoadingSpinner, useReloadFocus } from "@chartwarden/ui";
import { useEffect, useId, useRef } from "react";
import type { JSX, ReactNode } from "react";
import { STALE_MESSAGE } from "./findings-api";
import type { FindingsLoaded } from "./use-findings-record";

export interface FindingsFrameProps {
  readonly title: string;
  readonly description: string;
  readonly loaded: FindingsLoaded<unknown>;
  readonly onRetry: () => void;
  /** The form: pass it only once the record is loaded (`loaded.phase === "ready"`). */
  readonly children?: ReactNode;
}

export function FindingsFrame({
  title,
  description,
  loaded,
  onRetry,
  children,
}: FindingsFrameProps): JSX.Element {
  const headingId = useId();
  // A reload (Try again, Reload the record) replaces the button that had focus: hand it to the panel instead of <body>.
  const focusRef = useReloadFocus<HTMLElement>(loaded.phase === "loading");
  return (
    <section ref={focusRef} tabIndex={-1} className="wx-form-stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="wx-section-title">
        {title}
      </h3>
      <p className="wx-form-hint">{description}</p>
      {loaded.phase === "loading" ? (
        <LoadingSpinner label={`Loading ${title.toLowerCase()}`} />
      ) : null}
      {loaded.phase === "failed" ? (
        <>
          <InlineAlert tone="error">{loaded.message}</InlineAlert>
          <div>
            <Button tone="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </>
      ) : null}
      {children}
    </section>
  );
}

export interface SaveRowProps {
  readonly label: string;
  readonly saving: boolean;
  /** The form cannot be saved right now (read-only, or an entry that is not valid yet). */
  readonly disabled: boolean;
  readonly saved: boolean;
  readonly failure: string | null;
  /** The note will not take this record (signed, finalized, no section for it): the form is read-only and this says why, for good. */
  readonly locked: string | null;
  /** The record moved since the form was loaded: Save waits, and the author chooses to reload it (their entries stay until they do). */
  readonly stale: boolean;
  readonly onReload: () => void;
  /** Throw away what was entered and go back to the stored record; absent when nothing is unsaved. */
  readonly onDiscard?: (() => void) | undefined;
  readonly savedMessage: string;
  readonly onSave: () => void;
}

export function SaveRow({
  label,
  saving,
  disabled,
  saved,
  failure,
  locked,
  stale,
  onReload,
  onDiscard,
  savedMessage,
  onSave,
}: SaveRowProps): JSX.Element {
  const editable = locked === null;
  const reloadRow = useRef<HTMLDivElement>(null);
  // The choice the author now has to make: announce it at once and put keyboard focus on it.
  useEffect(() => {
    if (editable && stale) reloadRow.current?.querySelector("button")?.focus();
  }, [editable, stale]);
  return (
    <>
      {locked !== null ? <InlineAlert tone="warning">{locked}</InlineAlert> : null}
      {editable && stale ? (
        <>
          <div role="alert">
            <InlineAlert tone="warning" live={false}>
              {STALE_MESSAGE} Reload it to see the current record. What you entered here stays until
              you do.
            </InlineAlert>
          </div>
          <div ref={reloadRow} className="wx-action-row">
            <Button tone="secondary" size="sm" onClick={onReload}>
              Reload the record
            </Button>
          </div>
        </>
      ) : null}
      {editable && !stale && failure ? <InlineAlert tone="error">{failure}</InlineAlert> : null}
      {editable && !stale && saved ? (
        <InlineAlert tone="success">{savedMessage}</InlineAlert>
      ) : null}
      <div className="wx-form-actions">
        {editable && !stale && onDiscard ? (
          <Button tone="secondary" onClick={onDiscard} disabled={saving}>
            Discard changes
          </Button>
        ) : null}
        <Button onClick={onSave} loading={saving} disabled={disabled || stale}>
          {label}
        </Button>
      </div>
    </>
  );
}
