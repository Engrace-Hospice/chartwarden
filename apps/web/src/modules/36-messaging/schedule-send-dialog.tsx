// M36 WP 2.6 — "Send later" dialog: a native date/time input (min 2 minutes ahead, max 30 days), the viewer's time zone
// stated plainly, and the submit. The idempotency pair follows the same rule as a live send (one key per composed
// request, reused when no reply arrived, rotated after any answered failure), so a lost reply followed by a retry is
// a replay, never two scheduled copies.
import { Button, Modal, useApiClient } from "@wardenx/ui";
import { type MutableRefObject, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { apiErrorCode } from "./attachment-utils";
import { apiErrorMessage, rotateIdempotencyKey, sendAttemptFor } from "./messaging-utils";
import type { SendAttempt } from "./messaging-utils";
import {
  defaultScheduleValue,
  formatScheduledTime,
  fromLocalInputValue,
  isDefiniteRefusal,
  scheduleBounds,
  scheduleErrorText,
  toLocalInputValue,
  validateScheduleTime,
  viewerTimeZone,
} from "./scheduled-send-utils";
import "./scheduled-send.css";

const FAILED_MESSAGE = "The message could not be scheduled. Your text is still in the composer.";

/** What outlives the dialog: the in-flight attempt (its idempotency key) and the time it was made for. */
export interface ScheduleAttemptMemory {
  attempt: SendAttempt | null;
  value: string | null;
}

export interface ScheduleSendDialogProps {
  /** Owned by the button so a close and reopen after an ambiguous failure reuses the key. */
  memory?: MutableRefObject<ScheduleAttemptMemory>;
  open: boolean;
  channelId: string;
  /** The composer text being scheduled (plain text; sent exactly as typed). */
  text: string;
  onClose: () => void;
  /** The draft carries @mentions: a scheduled message is plain text and notifies nobody. */
  hasMentions?: boolean;
  /** The server accepted it; `scheduledFor` is the instant it will go out. */
  onScheduled: (scheduledFor: string) => void;
}

export function ScheduleSendDialog({
  open,
  channelId,
  text,
  hasMentions = false,
  memory,
  onClose,
  onScheduled,
}: ScheduleSendDialogProps): JSX.Element {
  const client = useApiClient();
  const ownMemory = useRef<ScheduleAttemptMemory>({ attempt: null, value: null });
  const remembered = memory ?? ownMemory;
  const [value, setValue] = useState(
    () => remembered.current.value ?? defaultScheduleValue(new Date()),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const zone = viewerTimeZone();
  const bounds = scheduleBounds(new Date());
  const picked = fromLocalInputValue(value);
  const timeProblem = validateScheduleTime(picked, new Date());

  async function submit(): Promise<void> {
    if (inFlightRef.current) return;
    // Re-checked against the clock NOW: the dialog may have sat open past the suggested time.
    const problem = validateScheduleTime(picked, new Date());
    if (problem || !picked) {
      setError(problem);
      return;
    }
    const scheduledFor = picked.toISOString();
    const attempt = sendAttemptFor(
      remembered.current.attempt,
      JSON.stringify([channelId, text, scheduledFor]),
    );
    remembered.current = { attempt, value };
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const {
        data,
        error: failure,
        response,
      } = await client.POST("/api/v1/messaging/channels/{id}/scheduled-messages", {
        params: { path: { id: channelId }, header: { "Idempotency-Key": attempt.idempotencyKey } },
        body: { body: text, scheduledFor, timeZone: zone },
      });
      // Rotate only after a definite refusal; a 5xx/408 may have committed behind the gateway, so a retry must replay.
      if (isDefiniteRefusal(response?.status)) {
        remembered.current = { attempt: rotateIdempotencyKey(attempt), value };
      }
      if (failure || !data) {
        setError(
          scheduleErrorText(apiErrorCode(failure)) ?? apiErrorMessage(failure, FAILED_MESSAGE),
        );
        return;
      }
      remembered.current = { attempt: null, value: null };
      onScheduled(data.scheduledFor);
    } catch {
      // No reply arrived: keep the attempt so a retry replays instead of duplicating.
      setError(FAILED_MESSAGE);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  // Portalled to <body>: the composer's own <form> contains this component, and Enter in the date input would
  // implicitly submit that form and send the draft.
  return createPortal(
    <Modal
      open={open}
      onClose={submitting ? undefined : onClose}
      ariaLabel="Schedule message"
      width="28rem"
    >
      <div className="wx-schedule-dialog">
        <header>
          <h2>Send later</h2>
          <p>
            The message is sent at the time you choose, as long as you can still send to this
            conversation then. Mentions and attachments are not included.
          </p>
          {hasMentions ? (
            <p className="wx-schedule-warning">
              Mentions won't notify anyone when a message is scheduled: it is sent as plain text.
            </p>
          ) : null}
        </header>
        <label className="wx-schedule-field">
          <span>Send at</span>
          <input
            type="datetime-local"
            value={value}
            min={toLocalInputValue(bounds.min)}
            max={toLocalInputValue(bounds.max)}
            disabled={submitting}
            aria-invalid={timeProblem ? true : undefined}
            aria-describedby={timeProblem ? "wx-schedule-time-problem" : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
        </label>
        {timeProblem ? (
          // Typing shows the reason quietly; once Schedule was refused for it, it is an alert (inserted, so announced).
          <p
            id="wx-schedule-time-problem"
            className="wx-messaging-error"
            role={error === timeProblem ? "alert" : undefined}
          >
            {timeProblem}
          </p>
        ) : null}
        <p className="wx-schedule-zone">
          Your time zone: <strong>{zone}</strong>
          {picked ? <> · {formatScheduledTime(picked.toISOString())}</> : null}
        </p>
        {error && error !== timeProblem ? (
          <div role="alert" className="wx-messaging-error">
            {error}
          </div>
        ) : null}
        <footer>
          <Button tone="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting} loading={submitting}>
            {submitting ? "Scheduling…" : "Schedule"}
          </Button>
        </footer>
      </div>
    </Modal>,
    document.body,
  );
}
