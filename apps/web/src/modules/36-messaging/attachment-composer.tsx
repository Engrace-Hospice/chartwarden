import { Glyph } from "@wardenx/ui";
import { useEffect, useRef } from "react";
import type { JSX, RefObject } from "react";
import { ATTACHMENT_ACCEPT, displayFileName, formatBytes } from "./attachment-utils";
import type { AttachmentChip } from "./messaging-types";
import type { AttachmentUploads } from "./use-attachment-upload";

const STATUS_LABEL: Readonly<Record<AttachmentChip["status"], string>> = {
  hashing: "Preparing…",
  uploading: "Uploading…",
  scanning: "Scanning…",
  ready: "Ready",
  blocked: "Blocked",
  failed: "Failed",
};

interface AttachButtonProps {
  uploads: Pick<AttachmentUploads, "addFiles">;
  disabled: boolean;
  /** Where focus lands when the last chip is removed. */
  buttonRef: RefObject<HTMLButtonElement>;
}

/** The paperclip control plus its hidden file input. Rendered inside the composer form. */
export function AttachButton({ uploads, disabled, buttonRef }: AttachButtonProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="wx-attach-button"
        aria-label="Attach file"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Glyph name="link" size={18} />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        data-testid="attachment-input"
        accept={ATTACHMENT_ACCEPT}
        tabIndex={-1}
        onChange={(event) => {
          uploads.addFiles([...(event.target.files ?? [])]);
          // Allow re-picking the same file after removing it.
          event.target.value = "";
        }}
      />
    </>
  );
}

interface AttachmentChipsProps {
  uploads: Pick<AttachmentUploads, "chips" | "notices" | "remove" | "retry">;
  disabled: boolean;
  attachButtonRef: RefObject<HTMLButtonElement>;
}

/** Two notices can read the same (two files with one name): number repeats so keys stay unique. */
function keyedNotices(notices: readonly string[]): { key: string; text: string }[] {
  const seen = new Map<string, number>();
  return notices.map((text) => {
    const occurrence = seen.get(text) ?? 0;
    seen.set(text, occurrence + 1);
    return { key: `${text}#${occurrence}`, text };
  });
}

function announcement(chip: AttachmentChip): string {
  const note = chip.message ? `. ${chip.message}` : "";
  return `${displayFileName(chip.fileName)}: ${STATUS_LABEL[chip.status]}${note}`;
}

/**
 * Per-file chips with state, remove and retry, plus pre-validation notices. The two live regions stay mounted
 * (hidden while idle) so text added later is announced; a region inserted with its text already in it is not.
 */
export function AttachmentChips({
  uploads,
  disabled,
  attachButtonRef,
}: AttachmentChipsProps): JSX.Element {
  const { chips, notices, remove, retry } = uploads;
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  // undefined: nothing to restore; null: the Attach button; string: that chip's Remove button.
  const pendingFocus = useRef<string | null | undefined>(undefined);

  // The button that held focus is gone after a re-render: put focus somewhere real.
  useEffect(() => {
    void chips;
    const target = pendingFocus.current;
    if (target === undefined) return;
    pendingFocus.current = undefined;
    const element = target === null ? attachButtonRef.current : removeButtons.current.get(target);
    element?.focus();
  }, [chips, attachButtonRef]);

  function removeChip(index: number): void {
    const neighbour = chips[index + 1] ?? chips[index - 1];
    pendingFocus.current = neighbour?.localId ?? null;
    const chip = chips[index];
    if (chip) remove(chip.localId);
  }

  function retryChip(localId: string): void {
    pendingFocus.current = localId;
    retry(localId);
  }

  const active = chips.length > 0 || notices.length > 0;
  return (
    <div className={active ? "wx-attachment-tray" : "sr-only"}>
      <div aria-live="assertive" aria-atomic="true" className="wx-composer-error">
        {keyedNotices(notices).map(({ key, text }) => (
          <div key={key}>{text}</div>
        ))}
      </div>
      {/* Non-atomic: a change to one chip announces that chip, not the whole list. */}
      <output className="sr-only" aria-atomic="false" aria-relevant="additions text">
        {chips.map((chip) => (
          <span key={chip.localId}>{announcement(chip)}</span>
        ))}
      </output>
      {chips.length > 0 ? (
        <ul className="wx-attachment-chips" aria-label="Attached files">
          {chips.map((chip, index) => {
            const name = displayFileName(chip.fileName);
            return (
              <li key={chip.localId} className={`wx-attachment-chip is-${chip.status}`}>
                <Glyph name="file-text" size={16} />
                <span className="wx-attachment-name" title={name}>
                  {name}
                </span>
                <span className="wx-attachment-size">{formatBytes(chip.byteSize)}</span>
                <span className="wx-attachment-state">
                  {STATUS_LABEL[chip.status]}
                  {chip.message ? (
                    <span className="wx-attachment-note"> {chip.message}</span>
                  ) : null}
                </span>
                {chip.status === "failed" ? (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Retry ${name}`}
                    onClick={() => retryChip(chip.localId)}
                  >
                    Retry
                  </button>
                ) : null}
                <button
                  ref={(element) => {
                    if (element) removeButtons.current.set(chip.localId, element);
                    else removeButtons.current.delete(chip.localId);
                  }}
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${name}`}
                  onClick={() => removeChip(index)}
                >
                  <Glyph name="close" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
