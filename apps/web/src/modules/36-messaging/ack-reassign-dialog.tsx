// M36 ADR-0078 (G-6, G-2) - the reassign dialog, for the card ("party": the sender before it is taken, or the assignee) and for the
// supervisor queue ("supervisor": adds a REQUIRED reason). Opening sends only the colleague read. Confirm is inert (aria-disabled,
// with its explanation) until the choices are made. Escape and Cancel close it and the modal returns focus to the button that
// opened it. It names no patient, no message text and no id.
import { ACK_SUPERVISOR_REASON_CODES } from "@wardenx/types";
import { Button, Modal } from "@wardenx/ui";
import { useEffect, useId, useRef } from "react";
import type { JSX } from "react";
import {
  REASSIGN_CANCEL_LABEL,
  REASSIGN_CARD_NOTICE,
  REASSIGN_CARD_TITLE,
  REASSIGN_COLLEAGUE_LEGEND,
  REASSIGN_CONFIRM_LABEL,
  REASSIGN_EMPTY_TEXT,
  REASSIGN_LOADING_TEXT,
  REASSIGN_LOAD_FAILED_TEXT,
  REASSIGN_NEEDS_CHOICE_TEXT,
  REASSIGN_NEEDS_COLLEAGUE_TEXT,
  REASSIGN_NEEDS_REASON_TEXT,
  REASSIGN_REASON_LEGEND,
  REASSIGN_REASON_TEXT,
  REASSIGN_RETRY_LABEL,
  REASSIGN_SAVING_TEXT,
  REASSIGN_SUPERVISOR_NOTICE,
  REASSIGN_SUPERVISOR_TITLE,
  reassignAvailableText,
} from "./ack-reassign-wording";
import { type ReassignMode, type ReassignRun, useAckReassign } from "./use-ack-reassign";
import "./ack-reassign.css";

export interface AckReassignDialogProps {
  readonly mode: ReassignMode;
  /** The request's id (the card) or its `request_ref` (the supervisor queue). */
  readonly requestId: string;
  readonly run: ReassignRun;
  /** Called on Cancel or Escape, and after the call settled with a result that closes the dialog. `saved` is true only for a saved reassign. */
  readonly onClose: (saved: boolean) => void;
}

export function AckReassignDialog({
  mode,
  requestId,
  run,
  onClose,
}: AckReassignDialogProps): JSX.Element {
  const id = useId();
  const supervisor = mode === "supervisor";
  const state = useAckReassign(mode, requestId, run);
  const { candidates, submitting } = state;
  const title = supervisor ? REASSIGN_SUPERVISOR_TITLE : REASSIGN_CARD_TITLE;
  const needs = supervisor
    ? state.reason === null && state.userId === null
      ? REASSIGN_NEEDS_CHOICE_TEXT
      : state.reason === null
        ? REASSIGN_NEEDS_REASON_TEXT
        : REASSIGN_NEEDS_COLLEAGUE_TEXT
    : REASSIGN_NEEDS_COLLEAGUE_TEXT;

  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Focus never falls to the page inside the modal: when the control that had it left (Retry while loading, a refusal), it goes to the
  // refusal text when there is one, else to the heading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the dialog's state settles
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && formRef.current?.contains(active)) return;
    (state.error ? errorRef.current : headingRef.current)?.focus();
  }, [candidates.status, state.error, submitting]);

  async function confirm(): Promise<void> {
    if (!state.ready || submitting) return;
    const result = await state.submit();
    if (result?.kind === "done") onClose(!result.failure);
  }

  return (
    <Modal
      open
      onClose={submitting ? undefined : () => onClose(false)}
      ariaLabel={title}
      ariaDescribedBy={`${id}-notice`}
      width="32rem"
    >
      <form
        ref={formRef}
        className="wx-reassign-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <h2 ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        <p id={`${id}-notice`} className="wx-reassign-notice">
          {supervisor ? REASSIGN_SUPERVISOR_NOTICE : REASSIGN_CARD_NOTICE}
        </p>
        {supervisor ? (
          <fieldset aria-busy={submitting || undefined}>
            <legend>{REASSIGN_REASON_LEGEND}</legend>
            {ACK_SUPERVISOR_REASON_CODES.map((code) => (
              <label key={code}>
                <input
                  type="radio"
                  name={`${id}-reason`}
                  value={code}
                  checked={state.reason === code}
                  onChange={() => state.setReason(code)}
                />
                {REASSIGN_REASON_TEXT[code]}
              </label>
            ))}
          </fieldset>
        ) : null}
        {candidates.status === "loading" ? (
          <output className="wx-reassign-hint">{REASSIGN_LOADING_TEXT}</output>
        ) : null}
        {candidates.status === "error" ? (
          <div role="alert" className="wx-reassign-error">
            <p>{REASSIGN_LOAD_FAILED_TEXT}</p>
            <Button type="button" tone="secondary" size="sm" onClick={() => void state.load()}>
              {REASSIGN_RETRY_LABEL}
            </Button>
          </div>
        ) : null}
        {candidates.status === "ready" ? (
          <output className="wx-reassign-sr">
            {reassignAvailableText(candidates.colleagues.length)}
          </output>
        ) : null}
        {candidates.status === "ready" && candidates.colleagues.length === 0 ? (
          <p className="wx-reassign-hint">{REASSIGN_EMPTY_TEXT}</p>
        ) : null}
        {candidates.status === "ready" && candidates.colleagues.length > 0 ? (
          <fieldset aria-busy={submitting || undefined}>
            <legend>{REASSIGN_COLLEAGUE_LEGEND}</legend>
            {candidates.colleagues.map((person) => (
              <label key={person.userId}>
                <input
                  type="radio"
                  name={`${id}-colleague`}
                  checked={state.userId === person.userId}
                  onChange={() => state.setUserId(person.userId)}
                />
                {person.label}
              </label>
            ))}
          </fieldset>
        ) : null}
        {state.error ? (
          <p className="wx-reassign-error" role="alert" ref={errorRef} tabIndex={-1}>
            {state.error}
          </p>
        ) : null}
        {state.ready ? null : (
          <p id={`${id}-needs`} className="wx-reassign-hint">
            {needs}
          </p>
        )}
        <div className="wx-reassign-actions">
          <Button
            type="button"
            tone="secondary"
            disabled={submitting}
            onClick={() => onClose(false)}
          >
            {REASSIGN_CANCEL_LABEL}
          </Button>
          <Button
            type="submit"
            aria-disabled={!state.ready || submitting || undefined}
            aria-describedby={state.ready ? undefined : `${id}-needs`}
          >
            {submitting ? REASSIGN_SAVING_TEXT : REASSIGN_CONFIRM_LABEL}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
