// M36 WP 3.7 - "Propose for the chart": choose where a clinician should review the message. No text is sent or copied;
// the server derives the patient from the channel. Server refusals land next to the choice; the notice that nothing
// enters the chart stays on screen.
import { Button, Modal } from "@chartwarden/ui";
import { useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import {
  CHOOSE_TARGET_TEXT,
  PROMOTION_NOTICE,
  PROPOSE_DIALOG_TITLE,
  TARGET_LABELS,
  TARGET_LEGEND,
  promotionErrorText,
} from "./promotion-wording";
import { type ProposeBody, usePromotionActions } from "./use-promotions";
import "./tasks.css";
import "./promotions.css";

const TARGETS: readonly { readonly value: "m8" | "m14"; readonly body: ProposeBody }[] = [
  { value: "m8", body: { target_module: "m8", target_kind: "encounter_addendum" } },
  { value: "m14", body: { target_module: "m14", target_kind: "idg_agenda_item" } },
];

export interface PromotionDialogProps {
  readonly channelId: string;
  readonly messageId: string;
  readonly onClose: () => void;
  /** `created` is false when the same proposal already existed. */
  readonly onProposed: (created: boolean) => void;
}

export function PromotionDialog({
  channelId,
  messageId,
  onClose,
  onProposed,
}: PromotionDialogProps): JSX.Element {
  const name = useId();
  const actions = usePromotionActions();
  const [target, setTarget] = useState<"m8" | "m14" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const firstRef = useRef<HTMLInputElement>(null);

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    setError(null);
    const chosen = TARGETS.find((entry) => entry.value === target);
    if (!chosen) {
      setError(CHOOSE_TARGET_TEXT);
      firstRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    const result = await actions.propose(channelId, messageId, chosen.body);
    inFlight.current = false;
    setSubmitting(false);
    if (result.ok) onProposed(result.data.created);
    else setError(promotionErrorText(result.status, result.code));
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void submit();
  }

  return (
    <Modal
      open
      onClose={submitting ? undefined : onClose}
      ariaLabel={PROPOSE_DIALOG_TITLE}
      width="32rem"
    >
      <form
        className="wx-task-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={onKeyDown}
      >
        <h2>{PROPOSE_DIALOG_TITLE}</h2>
        <p className="wx-task-notice">{PROMOTION_NOTICE}</p>
        <fieldset
          className="wx-promo-targets"
          aria-describedby={error ? `${name}-error` : undefined}
        >
          <legend>{TARGET_LEGEND}</legend>
          {TARGETS.map((entry, index) => (
            <label key={entry.value}>
              <input
                type="radio"
                name={name}
                ref={index === 0 ? firstRef : undefined}
                checked={target === entry.value}
                onChange={() => setTarget(entry.value)}
              />
              {TARGET_LABELS[entry.value]}
            </label>
          ))}
        </fieldset>
        {error ? (
          <p className="wx-task-error" id={`${name}-error`} role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-task-actions">
          <Button type="button" tone="secondary" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            Send for review
          </Button>
        </div>
      </form>
    </Modal>
  );
}
