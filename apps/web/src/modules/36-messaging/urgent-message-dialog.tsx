// M36 WP 4.1 - the "Urgent clinical" dialog: one qualified recipient, the four SBAR sections, and the permanent
// not-the-emergency-path notice. The sender names the person and the dialog restates who it goes to before sending
// (hazard H-02). Nothing is parsed from the text: the server stores the SBAR document and marks the message urgent from
// this entry alone. One {Idempotency-Key, client_message_id} pair is reused only to retry an identical payload; an edit
// rotates both.
import { SBAR_SECTION_KEYS, SBAR_SECTION_LABELS, validateSbar } from "@wardenx/types";
import type { SbarIssue, SbarSectionKey } from "@wardenx/types";
import { Button, Modal, useApiClient } from "@wardenx/ui";
import { useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import {
  SBAR_DEFAULT_HINTS,
  type SbarFormValues,
  buildSbarBody,
  emptySbarValues,
  sectionLength,
} from "./sbar-utils";
import {
  CHOOSE_RECIPIENT_TEXT,
  NOT_EMERGENCY_NOTICE,
  NO_PAGE_NOTICE,
  NO_RECIPIENT_TEXT,
  RECIPIENT_LEGEND,
  SBAR_LOADING_TEXT,
  SBAR_UNAVAILABLE_TEXT,
  UNKNOWN_PERSON,
  URGENT_DIALOG_TITLE,
  confirmLine,
  sendLabel,
  urgentErrorText,
} from "./urgent-wording";
import { useSbarPolicy } from "./use-sbar-policy";
import type { EnabledUrgentOptions } from "./use-urgent-options";
import "./urgent.css";

export interface UrgentSent {
  /** False when the same message had already been sent (a replay). */
  readonly created: boolean;
}

export interface UrgentMessageDialogProps {
  readonly channelId: string;
  readonly options: EnabledUrgentOptions;
  readonly onClose: () => void;
  readonly onSent: (sent: UrgentSent) => void;
}

const BLANK: SbarFormValues = emptySbarValues("care_team");

export function UrgentMessageDialog({
  channelId,
  options,
  onClose,
  onSent,
}: UrgentMessageDialogProps): JSX.Element {
  const client = useApiClient();
  const id = useId();
  const policyState = useSbarPolicy(true);
  const policy = policyState.status === "ready" ? policyState.policy : null;
  const attempt = useRef({
    clientMessageId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    signature: null as string | null,
  });
  const [sections, setSections] = useState(BLANK.sections);
  const [recipientId, setRecipientId] = useState("");
  const [issues, setIssues] = useState<readonly SbarIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const refs = useRef<Partial<Record<SbarSectionKey, HTMLTextAreaElement | null>>>({});
  const recipient = options.recipients.find((r) => r.user_id === recipientId) ?? null;
  const values: SbarFormValues = { sections, urgency: "urgent" };

  async function submit(): Promise<void> {
    if (inFlight.current || !policy) return;
    setError(null);
    if (!recipient) {
      setError(CHOOSE_RECIPIENT_TEXT);
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
    const signature = JSON.stringify([sections, recipientId]);
    if (attempt.current.signature !== null && attempt.current.signature !== signature) {
      attempt.current = {
        clientMessageId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        signature,
      };
    }
    attempt.current = { ...attempt.current, signature };
    const { idempotencyKey, clientMessageId } = attempt.current;
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
          recipient_user_id: recipient.user_id,
          client_message_id: clientMessageId,
        },
      });
      if (data) return onSent({ created: data.created });
      // A 409 means the server still holds the first key as unfinished: only a new key can succeed (same message id).
      if (response?.status === 409) {
        attempt.current = { ...attempt.current, idempotencyKey: crypto.randomUUID() };
      }
      setError(urgentErrorText(response?.status, failure?.error.code));
    } catch {
      setError(urgentErrorText(undefined, undefined));
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

  return (
    <Modal
      open
      onClose={submitting ? undefined : onClose}
      ariaLabel={URGENT_DIALOG_TITLE}
      width="40rem"
    >
      <form
        className="wx-urgent-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={onKeyDown}
      >
        <h2>{URGENT_DIALOG_TITLE}</h2>
        <p className="wx-urgent-notice">{NOT_EMERGENCY_NOTICE}</p>
        <p className="wx-urgent-notice">{NO_PAGE_NOTICE}</p>
        {options.recipients.length === 0 ? (
          <p className="wx-urgent-error" role="alert">
            {NO_RECIPIENT_TEXT}
          </p>
        ) : (
          <fieldset disabled={submitting}>
            <legend>{RECIPIENT_LEGEND}</legend>
            {options.recipients.map((person) => (
              <label key={person.user_id}>
                <input
                  type="radio"
                  name={`${id}-recipient`}
                  value={person.user_id}
                  checked={recipientId === person.user_id}
                  onChange={() => setRecipientId(person.user_id)}
                />
                {person.display_name ?? UNKNOWN_PERSON}
              </label>
            ))}
          </fieldset>
        )}
        {recipient ? (
          <p className="wx-urgent-notice">{confirmLine(recipient.display_name)}</p>
        ) : null}
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
                    value={sections[key]}
                    disabled={submitting}
                    aria-invalid={issue ? true : undefined}
                    aria-describedby={`${ids}-hint ${ids}-count${issue ? ` ${ids}-error` : ""}`}
                    onChange={(event) => {
                      setIssues([]);
                      setSections({ ...sections, [key]: event.target.value });
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
        {error ? (
          <p className="wx-urgent-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-urgent-actions">
          <Button type="button" tone="secondary" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={submitting}
            disabled={!policy || options.recipients.length === 0}
          >
            {recipient ? sendLabel(recipient.display_name) : "Send urgent message"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
