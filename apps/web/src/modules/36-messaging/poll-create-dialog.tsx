import {
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_LENGTH,
  POLL_MAX_QUESTION_LENGTH,
  POLL_MIN_OPTIONS,
  checkPollInput,
} from "@chartwarden/types";
// WP 2.10: "Create a poll" dialog. A question and 2..10 plain-text options; the same bounds the server enforces
// (shared from @chartwarden/types), checked as the user submits. The idempotency pair follows the live-send rule (one key per
// composed request, reused when no reply arrived, rotated after an answered failure) so a lost reply plus a retry is a
// replay, never two polls.
import { Button, Modal, useApiClient } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { apiErrorMessage, rotateIdempotencyKey, sendAttemptFor } from "./messaging-utils";
import type { SendAttempt } from "./messaging-utils";
import "./polls.css";

const FAILED = "The poll could not be created. Your question and options are still here.";
const INVALID = `Add a question and ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} different options, as plain text.`;

export interface PollCreateDialogProps {
  readonly channelId: string;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}

export function PollCreateDialog({
  channelId,
  onClose,
  onCreated,
}: PollCreateDialogProps): JSX.Element {
  const client = useApiClient();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef<SendAttempt | null>(null);
  const inFlightRef = useRef(false);

  function setOption(index: number, value: string): void {
    setOptions((current) => current.map((o, i) => (i === index ? value : o)));
    setError(null);
  }

  async function submit(): Promise<void> {
    if (inFlightRef.current) return;
    const checked = checkPollInput({ question, options });
    if (!checked.ok) {
      setError(INVALID);
      return;
    }
    const attempt = sendAttemptFor(attemptRef.current, JSON.stringify([channelId, checked]));
    attemptRef.current = attempt;
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const {
        data,
        error: failure,
        response,
      } = await client.POST("/api/v1/messaging/channels/{id}/polls", {
        params: { path: { id: channelId }, header: { "Idempotency-Key": attempt.idempotencyKey } },
        body: {
          question: checked.question,
          options: [...checked.options],
          clientMessageId: attempt.clientMessageId,
        },
      });
      const status = response?.status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
        attemptRef.current = rotateIdempotencyKey(attempt);
      }
      if (failure || !data) {
        setError(
          status === 422
            ? apiErrorMessage(failure, INVALID)
            : status === 410
              ? "This conversation is archived and read only."
              : FAILED,
        );
        return;
      }
      attemptRef.current = null;
      onCreated();
    } catch {
      setError(FAILED); // no reply arrived: keep the attempt so a retry replays instead of duplicating
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  // Portalled to <body>: the composer's own <form> contains this component, and a form nested in a form is invalid
  // HTML (the browser can submit the outer one, reloading the page). The submit also stops here so React's tree-wide
  // bubbling never reaches the composer's send handler.
  return createPortal(
    <Modal open onClose={submitting ? undefined : onClose} ariaLabel="Create a poll" width="30rem">
      <form
        className="wx-poll-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
      >
        <header>
          <h2>Create a poll</h2>
          <p>
            Everyone in this conversation can see who voted for what. Polls are for non-clinical
            questions only: do not include patient information.
          </p>
        </header>
        <label className="wx-poll-field">
          <span>Question</span>
          <input
            type="text"
            value={question}
            maxLength={POLL_MAX_QUESTION_LENGTH}
            disabled={submitting}
            // biome-ignore lint/a11y/noAutofocus: the dialog's first field is where the user starts
            autoFocus
            onChange={(event) => {
              setQuestion(event.target.value);
              setError(null);
            }}
          />
        </label>
        <fieldset className="wx-poll-field-group" disabled={submitting}>
          <legend>
            Options ({POLL_MIN_OPTIONS} to {POLL_MAX_OPTIONS})
          </legend>
          {options.map((value, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: options are positional and have no other identity
            <div key={index} className="wx-poll-option-row">
              <label>
                <span className="sr-only">{`Option ${index + 1}`}</span>
                <input
                  type="text"
                  value={value}
                  placeholder={`Option ${index + 1}`}
                  maxLength={POLL_MAX_OPTION_LENGTH}
                  onChange={(event) => setOption(index, event.target.value)}
                />
              </label>
              {options.length > POLL_MIN_OPTIONS ? (
                <Button
                  type="button"
                  tone="secondary"
                  size="sm"
                  aria-label={`Remove option ${index + 1}`}
                  onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            type="button"
            tone="secondary"
            size="sm"
            disabled={options.length >= POLL_MAX_OPTIONS}
            onClick={() => setOptions((current) => [...current, ""])}
          >
            Add option
          </Button>
        </fieldset>
        {error ? (
          <div role="alert" className="wx-messaging-error">
            {error}
          </div>
        ) : null}
        <footer>
          <Button type="button" tone="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting} loading={submitting}>
            {submitting ? "Creating…" : "Create poll"}
          </Button>
        </footer>
      </form>
    </Modal>,
    document.body,
  );
}
