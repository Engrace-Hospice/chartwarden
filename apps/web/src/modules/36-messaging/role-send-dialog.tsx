// M36 role-based send (ADR-0081, PROPOSED) - "Message the on-call role". Two steps in one portalled dialog. COMPOSE: pick a role (closed
// list) and write the four SBAR sections. CONFIRM: the server says who covers that role right now (name, role, shift end in the roster's
// zone); the sender confirms that person and only then can send. A gap, an unconnected roster or any failed lookup is an explicit message
// with the telephone procedure and no way to send. If who is on call changed between the check and the send, the server refuses (409),
// nothing is sent, and the sender is asked to confirm the new name: never a silent re-route. The draft and the {Idempotency-Key,
// client_message_id} pair live in the button (`draft`), so an identical retry reuses them; the signature includes the role and the person.
// The dialog is portalled to <body> because the composer's own <form> contains the button; the submit stops propagation for the same reason.
import {
  ONCALL_DIRECTORY_ROLES,
  type OnCallDirectoryRole,
  ROLE_SEND_ERROR_CODES,
  SBAR_SECTION_KEYS,
  SBAR_SECTION_LABELS,
  validateSbar,
} from "@wardenx/types";
import type { SbarIssue, SbarSectionKey } from "@wardenx/types";
import { Button, Modal, useApiClient } from "@wardenx/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { RoleSendConfirm, chosenPerson, namedPeople } from "./role-send-confirm";
import {
  BACK_LABEL,
  CANCEL_LABEL,
  CHOOSE_PERSON_TEXT,
  CHOOSE_ROLE_TEXT,
  DISCARD_LABEL,
  DISCARD_PROMPT,
  KEEP_DRAFT_LABEL,
  KEEP_EDITING_LABEL,
  REVIEW_LABEL,
  ROLE_LEGEND,
  ROLE_NAMES,
  ROLE_SEND_DIALOG_TITLE,
  ROLE_SEND_NOT_EMERGENCY_NOTICE,
  ROLE_SEND_NO_PAGE_NOTICE,
  SBAR_LOADING_TEXT,
  SBAR_UNAVAILABLE_TEXT,
  isIndeterminateSend,
  sendErrorText,
  sendLabel,
} from "./role-send-wording";
import {
  SBAR_DEFAULT_HINTS,
  type SbarFormValues,
  buildSbarBody,
  sectionLength,
} from "./sbar-utils";
import { useRoleResolution } from "./use-role-resolution";
import { useSbarPolicy } from "./use-sbar-policy";
import type { UrgentDraft } from "./use-urgent-draft";
import "./urgent.css";
import "./role-send.css";

export interface RoleSent {
  /** False when the same message had already been sent (a replay). */
  readonly created: boolean;
  readonly role: OnCallDirectoryRole;
  readonly name: string;
}

export interface RoleSendDialogProps {
  readonly channelId: string;
  readonly patientId: string;
  readonly draft: UrgentDraft;
  readonly onClose: () => void;
  readonly onSent: (sent: RoleSent) => void;
  /** A failure that does not prove the message was not stored: the thread should be re-read. */
  readonly onIndeterminate: () => void;
}

type Stage = "compose" | "confirm";

export function RoleSendDialog({
  channelId,
  patientId,
  draft,
  onClose,
  onSent,
  onIndeterminate,
}: RoleSendDialogProps): JSX.Element {
  const client = useApiClient();
  const id = useId();
  const policyState = useSbarPolicy(true);
  const policy = policyState.status === "ready" ? policyState.policy : null;
  const [role, setRole] = useState<OnCallDirectoryRole | null>(null);
  const [stage, setStage] = useState<Stage>("compose");
  const [issues, setIssues] = useState<readonly SbarIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inFlight = useRef(false);
  const refs = useRef<Partial<Record<SbarSectionKey, HTMLTextAreaElement | null>>>({});
  const roleRef = useRef<HTMLFieldSetElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLDivElement>(null);
  const { view, reload } = useRoleResolution(channelId, patientId, role, stage === "confirm");
  const values: SbarFormValues = { sections: draft.sections, urgency: "urgent" };

  const named = view.status === "ready" ? namedPeople(view.resolution).named : [];
  const covered = view.status === "ready" && view.resolution.status === "covered";
  const chosen = covered ? chosenPerson(named, draft.recipientId) : null;
  const needsChoice = stage === "confirm" && covered && !chosen && named.length > 1;

  // Moving to the confirm step puts focus on it so the answer (or the refusal) is read out.
  useEffect(() => {
    if (stage === "confirm") confirmRef.current?.focus();
  }, [stage]);
  useEffect(() => {
    if (confirmingDiscard) keepRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmingDiscard]);

  function requestClose(): void {
    if (submitting) return;
    if (confirmingDiscard || draft.dirty) {
      // Escape (or a scrim click) inside the prompt means "keep editing", never "close".
      setConfirmingDiscard(!confirmingDiscard);
      return;
    }
    onClose();
  }

  function review(): void {
    setError(null);
    if (!role) {
      setError(CHOOSE_ROLE_TEXT);
      roleRef.current?.focus();
      return;
    }
    if (!policy) return;
    const found = validateSbar(buildSbarBody(values), policy);
    setIssues(found);
    const first = SBAR_SECTION_KEYS.find((key) => found.some((i) => i.field === `sbar.${key}`));
    if (first) {
      refs.current[first]?.focus();
      return;
    }
    draft.setRecipientId("");
    setStage("confirm");
  }

  async function send(): Promise<void> {
    if (inFlight.current || !role || !chosen || confirmingDiscard) return;
    const body = buildSbarBody(values);
    const { idempotencyKey, clientMessageId } = draft.attemptFor(
      JSON.stringify([draft.sections, role, chosen.userId]),
    );
    setError(null);
    inFlight.current = true;
    setSubmitting(true);
    try {
      const {
        data,
        error: failure,
        response,
      } = await client.POST("/api/v1/messaging/channels/{id}/role-send", {
        params: { path: { id: channelId }, header: { "Idempotency-Key": idempotencyKey } },
        body: {
          role,
          patient_id: patientId,
          recipient_user_id: chosen.userId,
          body_doc: body as never,
          client_message_id: clientMessageId,
        },
      });
      if (data) return onSent({ created: data.created, role, name: chosen.name });
      const status = response?.status;
      const code = (failure as { error?: { code?: string } } | undefined)?.error?.code;
      // The idempotency middleware caches EVERY response, refusals included: retrying a refused send under the same key would replay the
      // refusal even after coverage changed. A clean refusal therefore gets a fresh key; only a failure that may have stored the message
      // keeps its key (the retry must be the same request), except an untyped 409 (an unfinished attempt: only a new key can succeed).
      if (!isIndeterminateSend(status, code) || (status === 409 && code === undefined)) {
        draft.rotateKey();
      }
      setError(sendErrorText(status, code));
      // A changed resolution or a refused coverage is a clean refusal: read the roster again and make the sender confirm again.
      if (
        code === ROLE_SEND_ERROR_CODES.resolutionChanged ||
        code === ROLE_SEND_ERROR_CODES.noCoverage
      ) {
        draft.setRecipientId("");
        reload();
      }
      if (isIndeterminateSend(status, code)) onIndeterminate();
    } catch {
      setError(sendErrorText(undefined, undefined));
      onIndeterminate();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const issueFor = (key: SbarSectionKey) => issues.find((i) => i.field === `sbar.${key}`);
  const missingRole = error === CHOOSE_ROLE_TEXT;
  const composing = stage === "compose";
  const busy = submitting || confirmingDiscard;

  return createPortal(
    <Modal
      open
      onClose={submitting ? undefined : requestClose}
      ariaLabel={ROLE_SEND_DIALOG_TITLE}
      ariaDescribedBy={`${id}-notices`}
      width="40rem"
    >
      <form
        className="wx-urgent-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (composing) review();
          else void send();
        }}
      >
        <h2>{ROLE_SEND_DIALOG_TITLE}</h2>
        <div id={`${id}-notices`} className="wx-urgent-notices">
          <p className="wx-urgent-notice">{ROLE_SEND_NOT_EMERGENCY_NOTICE}</p>
          <p className="wx-urgent-notice">{ROLE_SEND_NO_PAGE_NOTICE}</p>
        </div>
        {composing ? (
          <>
            <fieldset
              ref={roleRef}
              tabIndex={-1}
              disabled={busy}
              aria-describedby={missingRole ? `${id}-role-error` : undefined}
            >
              <legend>{ROLE_LEGEND}</legend>
              {ONCALL_DIRECTORY_ROLES.map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`${id}-role`}
                    value={value}
                    checked={role === value}
                    onChange={() => {
                      setRole(value);
                      if (missingRole) setError(null);
                    }}
                  />
                  <span>{ROLE_NAMES[value]}</span>
                </label>
              ))}
              {missingRole ? (
                <p className="wx-urgent-error" id={`${id}-role-error`}>
                  {CHOOSE_ROLE_TEXT}
                </p>
              ) : null}
            </fieldset>
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
                        disabled={busy}
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
          </>
        ) : role ? (
          <RoleSendConfirm
            id={id}
            role={role}
            view={view}
            chosenId={draft.recipientId}
            disabled={busy}
            regionRef={confirmRef}
            onChoose={(userId) => {
              draft.setRecipientId(userId);
              setError(null);
            }}
            onRetry={reload}
          />
        ) : null}
        {error && !missingRole ? (
          <p className="wx-urgent-error" role="alert">
            {error}
          </p>
        ) : null}
        {confirmingDiscard ? (
          <div
            className="wx-urgent-notice"
            role="alertdialog"
            aria-label={ROLE_SEND_DIALOG_TITLE}
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
        {needsChoice ? (
          <p className="wx-urgent-hint" id={`${id}-send-hint`}>
            {CHOOSE_PERSON_TEXT}
          </p>
        ) : null}
        <div className="wx-urgent-actions">
          {composing ? (
            <>
              <Button type="button" tone="secondary" disabled={busy} onClick={requestClose}>
                {CANCEL_LABEL}
              </Button>
              <Button type="submit" disabled={!policy || busy}>
                {REVIEW_LABEL}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                tone="secondary"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStage("compose");
                }}
              >
                {BACK_LABEL}
              </Button>
              <Button
                type="submit"
                loading={submitting}
                disabled={!chosen || busy}
                aria-describedby={needsChoice ? `${id}-send-hint` : undefined}
              >
                {chosen ? sendLabel(chosen.name) : "Send urgent message"}
              </Button>
            </>
          )}
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
