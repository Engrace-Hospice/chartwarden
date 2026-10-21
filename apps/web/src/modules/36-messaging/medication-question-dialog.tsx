// M36 WP 3.10 - "Ask a nurse about a medication". The typed text is sent VERBATIM (nothing is built or parsed from it);
// the server builds the message, the optional read-only medication link and the nurse's task in one transaction. One
// {Idempotency-Key, client_message_id} pair is reused only to retry an identical payload; an edit rotates both. No order action or
// link exists here: the fixed notices say a message never changes a medication.
import { MEDICATION_QUESTION_TEXT_MAX } from "@chartwarden/types";
import { Button, Modal, useApiClient } from "@chartwarden/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ClinicalLinkCandidate } from "./clinical-link-kinds";
import {
  ASK_DIALOG_TITLE,
  CHOOSE_NURSE_OPTION,
  DESCRIBE_MEDICATION_HINT,
  ENTER_QUESTION_TEXT,
  MEDICATION_LABEL,
  NOT_EMERGENCY_NOTICE,
  NO_MEDICATION_OPTION,
  NO_NURSE_TEXT,
  NO_ORDER_NOTICE,
  QUESTION_LABEL,
  SEND_LABEL,
  SEND_TO_LABEL,
  SEND_WITHOUT_NURSE_LABEL,
  UNKNOWN_PERSON,
  goesToLine,
  medicationQuestionErrorText,
  nurseOptionLabel,
} from "./medication-question-wording";
import { useDefaultClinicalLinkSource } from "./use-clinical-link-source";
import type { EnabledOptions } from "./use-medication-question-options";
import "./tasks.css";
import "./medication-question.css";

export interface MedicationQuestionSent {
  readonly routed: boolean;
  /** False when the same question had already been sent (a replay). */
  readonly created: boolean;
}

export interface MedicationQuestionDialogProps {
  readonly channelId: string;
  readonly options: EnabledOptions;
  readonly onClose: () => void;
  readonly onSent: (sent: MedicationQuestionSent) => void;
}

type MedicationList =
  | { readonly status: "loading" | "unavailable" }
  | { readonly status: "ready"; readonly items: readonly ClinicalLinkCandidate[] };

/** The medication select is fed by the existing patient-scoped list; a failure or refusal hides it (fail closed). */
function useMedicationList(options: EnabledOptions): MedicationList {
  const source = useDefaultClinicalLinkSource();
  const patientId = options.patient_id;
  const wanted = options.links_enabled && patientId !== null;
  const [list, setList] = useState<MedicationList>({ status: wanted ? "loading" : "unavailable" });
  useEffect(() => {
    if (!wanted || patientId === null) return setList({ status: "unavailable" });
    let current = true;
    const controller = new AbortController();
    setList({ status: "loading" });
    Promise.resolve()
      .then(() => source.list("medication", patientId, controller.signal))
      .then(
        (items) => current && setList({ status: "ready", items }),
        () => current && setList({ status: "unavailable" }),
      );
    return () => {
      current = false;
      controller.abort();
    };
  }, [source, patientId, wanted]);
  return list;
}

export function MedicationQuestionDialog({
  channelId,
  options,
  onClose,
  onSent,
}: MedicationQuestionDialogProps): JSX.Element {
  const client = useApiClient();
  const id = useId();
  // The pair is reused only to retry an IDENTICAL payload (the server replays or finishes it). Any edit is a different
  // request: the M1 middleware answers a changed body under a used key with 409, so both ids rotate with the payload.
  const attempt = useRef({
    clientMessageId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    signature: null as string | null,
  });
  const [text, setText] = useState("");
  const [medicationId, setMedicationId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refusedNoNurse, setRefusedNoNurse] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const medications = useMedicationList(options);
  const { nurse, colleagues } = options;
  const nobodyChosen = assigneeId === "" && nurse === null;
  const textError = error === ENTER_QUESTION_TEXT;
  const offerUnrouted = nobodyChosen || refusedNoNurse;

  async function submit(allowUnrouted: boolean): Promise<void> {
    if (inFlight.current) return;
    setError(null);
    if (text.trim() === "") {
      setError(ENTER_QUESTION_TEXT);
      textRef.current?.focus();
      return;
    }
    const signature = JSON.stringify([text, medicationId, assigneeId, allowUnrouted]);
    if (attempt.current.signature !== null && attempt.current.signature !== signature)
      attempt.current = {
        clientMessageId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        signature,
      };
    attempt.current = { ...attempt.current, signature };
    const { idempotencyKey, clientMessageId } = attempt.current;
    inFlight.current = true;
    setSubmitting(true);
    try {
      const {
        data,
        error: body,
        response,
      } = await client.POST("/api/v1/messaging/channels/{id}/medication-questions", {
        params: {
          path: { id: channelId },
          header: { "Idempotency-Key": idempotencyKey },
        },
        body: {
          text,
          client_message_id: clientMessageId,
          ...(medicationId ? { medication_id: medicationId } : {}),
          ...(assigneeId ? { assignee_user_id: assigneeId } : {}),
          ...(allowUnrouted ? { allow_unrouted: true } : {}),
        },
      });
      if (data) return onSent({ routed: data.routed, created: data.created });
      const code = body?.error.code;
      // A 409 means the server still holds the first key as unfinished: only a new key can succeed (same message id).
      if (response?.status === 409)
        attempt.current = { ...attempt.current, idempotencyKey: crypto.randomUUID() };
      if (code === "MEDICATION_QUESTION_NO_NURSE") setRefusedNoNurse(true);
      setError(medicationQuestionErrorText(response?.status, code));
    } catch {
      setError(medicationQuestionErrorText(undefined, undefined));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void submit(false);
  }

  // Portalled to <body>: the composer's own <form> contains this component, and a form nested in a form is invalid
  // HTML (the browser can submit the outer one, reloading the page). The submit also stops here so React's tree-wide
  // bubbling never reaches the composer's send handler.
  return createPortal(
    <Modal
      open
      onClose={submitting ? undefined : onClose}
      ariaLabel={ASK_DIALOG_TITLE}
      width="34rem"
    >
      <form
        className="wx-task-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void submit(false);
        }}
        onKeyDown={onKeyDown}
      >
        <h2>{ASK_DIALOG_TITLE}</h2>
        <p className="wx-task-notice">{NO_ORDER_NOTICE}</p>
        <p className="wx-task-notice">{NOT_EMERGENCY_NOTICE}</p>
        <div className="wx-task-field">
          <label htmlFor={`${id}-text`}>{QUESTION_LABEL}</label>
          <textarea
            id={`${id}-text`}
            ref={textRef}
            rows={5}
            maxLength={MEDICATION_QUESTION_TEXT_MAX}
            value={text}
            aria-invalid={textError ? true : undefined}
            aria-describedby={textError ? `${id}-error` : undefined}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        {medications.status === "ready" ? (
          <div className="wx-task-field">
            <label htmlFor={`${id}-medication`}>{MEDICATION_LABEL}</label>
            <select
              id={`${id}-medication`}
              value={medicationId}
              onChange={(event) => setMedicationId(event.target.value)}
            >
              <option value="">{NO_MEDICATION_OPTION}</option>
              {medications.items.map((item) => (
                <option key={item.entityId} value={item.entityId}>
                  {item.detail ? `${item.label} (${item.detail})` : item.label}
                </option>
              ))}
            </select>
          </div>
        ) : medications.status === "unavailable" ? (
          <p className="wx-task-hint">{DESCRIBE_MEDICATION_HINT}</p>
        ) : null}
        {nurse && assigneeId === "" ? (
          <p className="wx-task-hint">{goesToLine(nurse.display_name)}</p>
        ) : null}
        {colleagues.length > 0 ? (
          <div className="wx-task-field">
            <label htmlFor={`${id}-assignee`}>{SEND_TO_LABEL}</label>
            <select
              id={`${id}-assignee`}
              value={assigneeId}
              onChange={(event) => setAssigneeId(event.target.value)}
            >
              <option value="">
                {nurse ? nurseOptionLabel(nurse.display_name) : CHOOSE_NURSE_OPTION}
              </option>
              {colleagues.map((person) => (
                <option key={person.user_id} value={person.user_id}>
                  {person.display_name ?? UNKNOWN_PERSON}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {offerUnrouted && !error ? <p className="wx-task-hint">{NO_NURSE_TEXT}</p> : null}
        {error ? (
          <p id={`${id}-error`} className="wx-task-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-task-actions">
          <Button type="button" tone="secondary" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          {offerUnrouted ? (
            <Button
              type="button"
              tone="secondary"
              disabled={submitting}
              onClick={() => void submit(true)}
            >
              {SEND_WITHOUT_NURSE_LABEL}
            </Button>
          ) : null}
          <Button type="submit" loading={submitting}>
            {SEND_LABEL}
          </Button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
