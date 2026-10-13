// M36 WP 2.6 — "Send later" dialog: a native date/time input (min 2 minutes ahead, max 30 days), the viewer's time zone
// stated plainly, and the submit. The idempotency pair follows the same rule as a live send (one key per composed
// request, reused when no reply arrived, rotated after any answered failure), so a lost reply followed by a retry is
// a replay, never two scheduled copies.
import { Button, Modal, useApiClient } from "@wardenx/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { apiErrorCode } from "./attachment-utils";
import { apiErrorMessage, rotateIdempotencyKey, sendAttemptFor } from "./messaging-utils";
import type { SendAttempt } from "./messaging-utils";
import {
  defaultScheduleValue,
  formatScheduledTime,
  fromLocalInputValue,
  scheduleBounds,
  scheduleErrorText,
  toLocalInputValue,
  viewerTimeZone,
} from "./scheduled-send-utils";
import "./scheduled-send.css";

const FAILED_MESSAGE = "The message could not be scheduled. Your text is still in the composer.";

export interface ScheduleSendDialogProps {
  open: boolean;
  channelId: string;
  /** The composer text being scheduled (plain text; sent exactly as typed). */
  text: string;
  onClose: () => void;
  /** The server accepted it; `scheduledFor` is the instant it will go out. */
  onScheduled: (scheduledFor: string) => void;
}

export function ScheduleSendDialog({
  open,
  channelId,
  text,
  onClose,
  onScheduled,
}: ScheduleSendDialogProps): JSX.Element {
  const client = useApiClient();
  const [value, setValue] = useState(() => defaultScheduleValue(new Date()));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef<SendAttempt | null>(null);
  const inFlightRef = useRef(false);
  const zone = viewerTimeZone();
  const bounds = scheduleBounds(new Date());
  const picked = fromLocalInputValue(value);

  async function submit(): Promise<void> {
    if (inFlightRef.current || !picked) return;
    const scheduledFor = picked.toISOString();
    const attempt = sendAttemptFor(
      attemptRef.current,
      JSON.stringify([channelId, text, scheduledFor]),
    );
    attemptRef.current = attempt;
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
      if (response && response.status >= 400) attemptRef.current = rotateIdempotencyKey(attempt);
      if (failure || !data) {
        setError(
          scheduleErrorText(apiErrorCode(failure)) ?? apiErrorMessage(failure, FAILED_MESSAGE),
        );
        return;
      }
      attemptRef.current = null;
      onScheduled(data.scheduledFor);
    } catch {
      // No reply arrived: keep the attempt so a retry replays instead of duplicating.
      setError(FAILED_MESSAGE);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  return (
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
        </header>
        <label className="wx-schedule-field">
          <span>Send at</span>
          <input
            type="datetime-local"
            value={value}
            min={toLocalInputValue(bounds.min)}
            max={toLocalInputValue(bounds.max)}
            disabled={submitting}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p className="wx-schedule-zone">
          Your time zone: <strong>{zone}</strong>
          {picked ? <> · {formatScheduledTime(picked.toISOString())}</> : null}
        </p>
        {error ? (
          <div role="alert" className="wx-messaging-error">
            {error}
          </div>
        ) : null}
        <footer>
          <Button tone="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!picked || submitting}
            loading={submitting}
          >
            {submitting ? "Scheduling…" : "Schedule"}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
