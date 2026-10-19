// M36 WP 4.1 - the "Urgent clinical" dialog: one qualified recipient, the four SBAR sections, and the permanent
// not-the-emergency-path notice (announced with the dialog through aria-describedby). The sender names the person and the dialog
// restates who it goes to in a polite live region before sending (hazard H-02); a recipient whose name cannot be shown is never
// offered. Nothing is parsed from the text: the server stores the SBAR document and marks the message urgent from this entry
// alone. The draft and the {Idempotency-Key, client_message_id} pair live in the button (`draft`), so a retry of an identical
// payload reuses them across close/reopen; closing with text asks first, in the dialog.
import { SBAR_SECTION_KEYS, SBAR_SECTION_LABELS, validateSbar } from "@wardenx/types";
import type { SbarIssue, SbarSectionKey } from "@wardenx/types";
import { Button, Modal, useApiClient } from "@wardenx/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  SBAR_DEFAULT_HINTS,
  type SbarFormValues,
  buildSbarBody,
  sectionLength,
} from "./sbar-utils";
import {
  CHOOSE_RECIPIENT_TEXT,
  DISCARD_LABEL,
  DISCARD_PROMPT,
  KEEP_DRAFT_LABEL,
  KEEP_EDITING_LABEL,
  NAME_UNAVAILABLE_TEXT,
  NOT_EMERGENCY_NOTICE,
  NO_PAGE_NOTICE,
  NO_RECIPIENT_TEXT,
  RECIPIENT_LEGEND,
  SBAR_LOADING_TEXT,
  SBAR_UNAVAILABLE_TEXT,
  TURNED_OFF_NOTICE,
  URGENT_DIALOG_TITLE,
  confirmLine,
  isIndeterminate,
  sendLabel,
  urgentErrorText,
} from "./urgent-wording";
import { useSbarPolicy } from "./use-sbar-policy";
import type { UrgentDraft } from "./use-urgent-draft";
import type { EnabledUrgentOptions } from "./use-urgent-options";
import "./urgent.css";

export interface UrgentSent {
  /** False when the same message had already been sent (a replay). */
  readonly created: boolean;
}

export interface UrgentMessageDialogProps {
  readonly channelId: string;
  readonly options: EnabledUrgentOptions;
  /** The feature was turned off while the dialog was open: the draft stays, sending is blocked, the person is told. */
  readonly blocked?: boolean;
  readonly draft: UrgentDraft;
  readonly onClose: () => void;
  readonly onSent: (sent: UrgentSent) => void;
  /** A failure that does not prove the message was not stored: the thread should be re-read. */
  readonly onIndeterminate: () => void;
}

interface Choice {
  readonly userId: string;
  readonly label: string;
}

/** Only people with a usable name are offered; same names get an ordinal so the restated name is unambiguous. */
export function recipientChoices(options: EnabledUrgentOptions): {
  readonly choices: readonly Choice[];
  readonly hidden: number;
} {
  const named = options.recipients.filter((r) => (r.display_name ?? "").trim() !== "");
  const counts = new Map<string, number>();
  for (const r of named) {
    const name = (r.display_name as string).trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const choices = named.map((r) => {
    const name = (r.display_name as string).trim();
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const total = counts.get(name) ?? 1;
    return { userId: r.user_id, label: total > 1 ? `${name} (${n} of ${total})` : name };
  });
  return { choices, hidden: options.recipients.length - named.length };
}

export function UrgentMessageDialog({
  channelId,
  options,
  blocked = false,
  draft,
  onClose,
  onSent,
  onIndeterminate,
}: UrgentMessageDialogProps): JSX.Element {
  const client = useApiClient();
  const id = useId();
  const policyState = useSbarPolicy(true);
  const policy = policyState.status === "ready" ? policyState.policy : null;
  const [issues, setIssues] = useState<readonly SbarIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inFlight = useRef(false);
  const refs = useRef<Partial<Record<SbarSectionKey, HTMLTextAreaElement | null>>>({});
  const recipientRef = useRef<HTMLFieldSetElement>(null);
  const keepRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLDivElement>(null);
  const { choices, hidden } = recipientChoices(options);
  const chosen = choices.find((c) => c.userId === draft.recipientId) ?? null;
  const values: SbarFormValues = { sections: draft.sections, urgency: "urgent" };

  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmingDiscard) keepRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (wasConfirming.current) {
      // Back to editing: focus the first section (the Cancel button when the form has not loaded).
      (refs.current[SBAR_SECTION_KEYS[0]] ?? cancelRef.current?.querySelector("button"))?.focus();
    }
    wasConfirming.current = confirmingDiscard;
  }, [confirmingDiscard]);

  function requestClose(): void {
    if (submitting) return;
    if (confirmingDiscard) {
      // Escape (or a scrim click) inside the prompt means "keep editing", never "close".
      setConfirmingDiscard(false);
      return;
    }
    if (draft.dirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }

  async function submit(): Promise<void> {
    if (inFlight.current || !policy || blocked || confirmingDiscard) return;
    setError(null);
    if (!chosen) {
      setError(CHOOSE_RECIPIENT_TEXT);
      recipientRef.current?.focus();
      return;
    }
    const body = buildSbarBody(values);
    const found = validateSbar(body, policy);
    setIssues(found);
    const first = SBAR_SECTION_KEYS.find((key) => found.some((i) => i.field === `sbar.${key}`));
    if (first) {
      refs.current[first]?.focus();
      return;
    }
    const { idempotencyKey, clientMessageId } = draft.attemptFor(
      JSON.stringify([draft.sections, chosen.userId]),
    );
    inFlight.current = true;
    setSubmitting(true);
    try {
      const {
        data,
        error: failure,
        response,
      } = await client.POST("/api/v1/messaging/channels/{id}/urgent-messages", {
        params: { path: { id: channelId }, header: { "Idempotency-Key": idempotencyKey } },
        body: {
          body_doc: body as never,
          recipient_user_id: chosen.userId,
          client_message_id: clientMessageId,
        },
      });
      if (data) return onSent({ created: data.created });
      const status = response?.status;
      if (status === 409) draft.rotateKey();
      setError(urgentErrorText(status, failure?.error.code));
      if (isIndeterminate(status)) onIndeterminate();
    } catch {
      setError(urgentErrorText(undefined, undefined));
      onIndeterminate();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void submit();
  }

  const issueFor = (key: SbarSectionKey) => issues.find((i) => i.field === `sbar.${key}`);
  const missingRecipient = error === CHOOSE_RECIPIENT_TEXT;

  // Portalled to <body>: the composer's own <form> contains this component, and a form nested in a form is invalid
  // HTML (the browser can submit the outer one, reloading the page). The submit also stops here so React's tree-wide
  // bubbling never reaches the composer's send handler.
  return createPortal(
    <Modal
      open
      onClose={submitting ? undefined : requestClose}
      ariaLabel={URGENT_DIALOG_TITLE}
      ariaDescribedBy={`${id}-notices`}
      width="40rem"
    >
      <form
        className="wx-urgent-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
        onKeyDown={onKeyDown}
      >
        <h2>{URGENT_DIALOG_TITLE}</h2>
        <div id={`${id}-notices`} className="wx-urgent-notices">
          <p className="wx-urgent-notice">{NOT_EMERGENCY_NOTICE}</p>
          <p className="wx-urgent-notice">{NO_PAGE_NOTICE}</p>
        </div>
        {blocked ? (
          <p className="wx-urgent-error" role="alert">
            {TURNED_OFF_NOTICE}
          </p>
        ) : null}
        {choices.length === 0 ? (
          <p className="wx-urgent-error" role="alert">
            {NO_RECIPIENT_TEXT}
          </p>
        ) : (
          <fieldset
            ref={recipientRef}
            tabIndex={-1}
            disabled={submitting || confirmingDiscard}
            aria-describedby={missingRecipient ? `${id}-recipient-error` : undefined}
          >
            <legend>{RECIPIENT_LEGEND} (required)</legend>
            {choices.map((person) => (
              <label key={person.userId}>
                <input
                  type="radio"
                  aria-labelledby={`${id}-name-${person.userId}`}
                  name={`${id}-recipient`}
                  value={person.userId}
                  checked={draft.recipientId === person.userId}
                  onChange={() => {
                    draft.setRecipientId(person.userId);
                    if (missingRecipient) setError(null);
                  }}
                />
                <span id={`${id}-name-${person.userId}`}>{person.label}</span>
              </label>
            ))}
            {missingRecipient ? (
              <p className="wx-urgent-error" id={`${id}-recipient-error`}>
                {CHOOSE_RECIPIENT_TEXT}
              </p>
            ) : null}
          </fieldset>
        )}
        {hidden > 0 ? <p className="wx-urgent-hint">{NAME_UNAVAILABLE_TEXT}</p> : null}
        <p className="wx-urgent-notice" aria-live="polite">
          {chosen ? confirmLine(chosen.label) : ""}
        </p>
        {policyState.status === "loading" || policyState.status === "idle" ? (
          <p className="wx-urgent-hint">{SBAR_LOADING_TEXT}</p>
        ) : null}
        {policyState.status !== "ready" &&
        policyState.status !== "loading" &&
        policyState.status !== "idle" ? (
          <p className="wx-urgent-error" role="alert">
            {SBAR_UNAVAILABLE_TEXT}
          </p>
        ) : null}
        {policy
          ? SBAR_SECTION_KEYS.map((key) => {
              const issue = issueFor(key);
              const min = Math.max(policy.minChars[key], 1);
              const ids = `${id}-${key}`;
              return (
                <div className="wx-urgent-field" key={key}>
                  <label htmlFor={`${ids}-input`}>{SBAR_SECTION_LABELS[key]}</label>
                  <textarea
                    id={`${ids}-input`}
                    ref={(node) => {
                      refs.current[key] = node;
                    }}
                    rows={3}
                    value={draft.sections[key]}
                    disabled={submitting || confirmingDiscard}
                    aria-invalid={issue ? true : undefined}
                    aria-describedby={`${ids}-hint ${ids}-count${issue ? ` ${ids}-error` : ""}`}
                    onChange={(event) => {
                      const text = event.target.value;
                      setIssues([]);
                      draft.setSections((current) => ({ ...current, [key]: text }));
                    }}
                  />
                  <p className="wx-urgent-hint" id={`${ids}-hint`}>
                    {policy.hints[key] ?? SBAR_DEFAULT_HINTS[key]}
                  </p>
                  <p className="wx-urgent-count" id={`${ids}-count`}>
                    {sectionLength(values, key)} / {min}
                  </p>
                  {issue ? (
                    <p className="wx-urgent-error" id={`${ids}-error`} role="alert">
                      {SBAR_SECTION_LABELS[key]} {issue.message}
                    </p>
                  ) : null}
                </div>
              );
            })
          : null}
        {error && !missingRecipient ? (
          <p className="wx-urgent-error" role="alert">
            {error}
          </p>
        ) : null}
        {confirmingDiscard ? (
          <div
            className="wx-urgent-notice"
            role="alertdialog"
            aria-label={URGENT_DIALOG_TITLE}
            aria-describedby={`${id}-discard`}
          >
            <p id={`${id}-discard`}>{DISCARD_PROMPT}</p>
            <div className="wx-urgent-actions" ref={keepRef}>
              <Button type="button" tone="secondary" onClick={() => setConfirmingDiscard(false)}>
                {KEEP_EDITING_LABEL}
              </Button>
              <Button type="button" tone="secondary" onClick={onClose}>
                {KEEP_DRAFT_LABEL}
              </Button>
              <Button
                type="button"
                tone="secondary"
                onClick={() => {
                  draft.reset();
                  onClose();
                }}
              >
                {DISCARD_LABEL}
              </Button>
            </div>
          </div>
        ) : null}
        {chosen || missingRecipient || choices.length === 0 ? null : (
          <p className="wx-urgent-hint" id={`${id}-send-hint`}>
            {CHOOSE_RECIPIENT_TEXT}
          </p>
        )}
        <div className="wx-urgent-actions" ref={cancelRef}>
          <Button
            type="button"
            tone="secondary"
            disabled={submitting || confirmingDiscard}
            onClick={requestClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            loading={submitting}
            aria-describedby={
              chosen ? undefined : missingRecipient ? `${id}-recipient-error` : `${id}-send-hint`
            }
            disabled={!policy || !chosen || blocked || confirmingDiscard}
          >
            {chosen ? sendLabel(chosen.label) : "Send urgent message"}
          </Button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
