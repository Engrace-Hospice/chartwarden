// M36 WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED) - the dialogs of the Redactions tab. "Request" collects a message id and a reason. A decision
// (approve, countersign, and the PROVISIONAL sole-officer self-approval) is one explicit confirmation; the self-approval is worded loudly and needs
// a ticked acknowledgement. A stale step-up stashes which redaction it was and sends the officer through the step-up page; on return the dialog
// reopens and asks again (a decision is never replayed). Free text is only ever rendered as text.
import {
  MESSAGE_REDACTION_REASON_MAX_LENGTH,
  MESSAGE_REDACTION_REASON_MIN_LENGTH,
  type MessageRedactionDto,
} from "@chartwarden/types";
import { Button, Modal, TextAreaField, TextField } from "@chartwarden/ui";
import { useId, useRef, useState } from "react";
import type { JSX } from "react";
import { clearStepUpDraft, stashStepUpDraft } from "../../shell/step-up-redirect";
import { useAlive, useStepUpNavigation } from "./legal-hold-dialogs";
import * as W from "./redaction-wording";
import type { DecisionKind, RedactionActions, RedactionResult } from "./use-redactions";
import { UUID_RE } from "./uuid";

const failureText = (result: Exclude<RedactionResult, { kind: "ok" | "step_up" }>): string => {
  switch (result.kind) {
    case "denied":
      return W.deniedText(result.code);
    case "same_person":
      return W.SAME_PERSON;
    case "lapsed":
      return W.LAPSED_ERROR;
    case "unavailable":
    case "not_found":
      return W.NOT_AVAILABLE;
    default:
      return W.DECISION_FAILED;
  }
};

export function RequestRedactionDialog({
  actions,
  onClose,
  onRequested,
}: {
  readonly actions: RedactionActions;
  readonly onClose: () => void;
  readonly onRequested: () => void;
}): JSX.Element {
  const [messageId, setMessageId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useAlive();
  const detailId = useId();

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const id = messageId.trim();
    const text = reason.trim();
    if (!UUID_RE.test(id)) return setError(W.MESSAGE_ID_INVALID);
    if (
      text.length < MESSAGE_REDACTION_REASON_MIN_LENGTH ||
      text.length > MESSAGE_REDACTION_REASON_MAX_LENGTH
    )
      return setError(W.REASON_SHORT);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await actions.request({ message_id: id, reason: text });
    inFlight.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (result.kind === "ok") return onRequested();
    setError(
      result.kind === "exists"
        ? W.REQUEST_EXISTS
        : result.kind === "not_found"
          ? W.REQUEST_NOT_FOUND
          : result.kind === "denied"
            ? W.deniedText(result.code)
            : W.REQUEST_FAILED,
    );
  };

  const cancel = (): void => {
    if (!inFlight.current) onClose();
  };

  return (
    <Modal
      open
      ariaLabel={W.REQUEST_TITLE}
      ariaDescribedBy={detailId}
      onClose={cancel}
      dismissOnScrim={messageId.trim() === "" && reason.trim() === ""}
      width="36rem"
    >
      <form
        className="wx-retention-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{W.REQUEST_TITLE}</h2>
        <p id={detailId} className="wx-retention-detail">
          {W.REQUEST_DETAIL}
        </p>
        <TextField
          label={W.MESSAGE_ID_LABEL}
          value={messageId}
          onChange={(e) => setMessageId(e.target.value)}
        />
        <TextAreaField
          label={W.REASON_LABEL}
          hint={W.REASON_HINT}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error ? (
          <p className="wx-retention-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-retention-dialog-actions">
          <Button type="button" tone="secondary" aria-disabled={busy} onClick={cancel}>
            {W.CANCEL_LABEL}
          </Button>
          <Button type="submit" tone="primary" aria-disabled={busy}>
            {W.REQUEST_ACTION}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const COPY: Readonly<
  Record<DecisionKind, { title: string; detail: string; action: string; announce: string }>
> = {
  approve: {
    title: W.APPROVE_TITLE,
    detail: W.APPROVE_DETAIL,
    action: W.CONFIRM_APPROVE,
    announce: W.APPROVED_ANNOUNCEMENT,
  },
  countersign: {
    title: W.COUNTERSIGN_TITLE,
    detail: W.COUNTERSIGN_DETAIL,
    action: W.CONFIRM_COUNTERSIGN,
    announce: W.COUNTERSIGNED_ANNOUNCEMENT,
  },
  self_approve: {
    title: W.SELF_TITLE,
    detail: W.SELF_DETAIL,
    action: W.CONFIRM_SELF,
    announce: W.SELF_ANNOUNCEMENT,
  },
};

export function DecisionDialog({
  kind,
  redaction,
  actions,
  draftKey,
  onClose,
  onDone,
}: {
  readonly kind: DecisionKind;
  readonly redaction: MessageRedactionDto;
  readonly actions: RedactionActions;
  readonly draftKey: string | null;
  readonly onClose: () => void;
  /** The decision went through, or the row turned out to have moved on (the list is reloaded either way). */
  readonly onDone: (announcement: string) => void;
}): JSX.Element {
  const copy = COPY[kind];
  const [understood, setUnderstood] = useState(kind !== "self_approve");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useAlive();
  const goStepUp = useStepUpNavigation();
  const detailId = useId();

  const confirm = async (): Promise<void> => {
    if (inFlight.current || !understood) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await actions.decide(kind, redaction.id);
    inFlight.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (result.kind === "ok") {
      clearStepUpDraft(draftKey);
      return onDone(copy.announce);
    }
    if (result.kind === "step_up") {
      stashStepUpDraft(draftKey, { redactionId: redaction.id });
      if (!goStepUp(result.error)) setError(W.STEP_UP_TEXT);
      return;
    }
    if (result.kind === "unavailable" || result.kind === "lapsed" || result.kind === "not_found") {
      clearStepUpDraft(draftKey);
      setError(failureText(result));
      return;
    }
    setError(failureText(result));
  };

  const cancel = (): void => {
    if (inFlight.current) return;
    clearStepUpDraft(draftKey);
    onClose();
  };

  return (
    <Modal
      open
      role="alertdialog"
      ariaLabel={copy.title}
      ariaDescribedBy={detailId}
      onClose={cancel}
      dismissOnScrim={false}
      width="36rem"
    >
      <div className="wx-retention-dialog">
        <h2>{copy.title}</h2>
        <p id={detailId} className="wx-retention-detail">
          {copy.detail}
        </p>
        <p className="wx-retention-detail">{W.messageText(redaction.message_id)}</p>
        {kind === "self_approve" ? (
          <label className="wx-retention-check">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            {W.SELF_CONFIRM}
          </label>
        ) : null}
        {error ? (
          <p className="wx-retention-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-retention-dialog-actions">
          <Button type="button" tone="secondary" aria-disabled={busy} onClick={cancel}>
            {W.CANCEL_LABEL}
          </Button>
          <Button
            type="button"
            tone="primary"
            aria-disabled={busy || !understood}
            onClick={() => void confirm()}
          >
            {copy.action}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
