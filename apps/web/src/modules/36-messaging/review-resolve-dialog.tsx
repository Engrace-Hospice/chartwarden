// M36 WP 3.8 - a supervisor's decision on one review item: reassign its task, or close it with a reason CODE (no free
// text). Esc / Back close it and focus returns to the opening button (the kit Modal). The server re-checks everything.
import { TASK_CLOSE_REASONS } from "@chartwarden/types";
import type { ReviewItemDto, TaskCloseReason } from "@chartwarden/types";
import { Button, Modal } from "@chartwarden/ui";
import { useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import {
  CHOOSE_ASSIGNEE_TEXT,
  CHOOSE_REASON_TEXT,
  REVIEW_ACTION_LABELS,
  REVIEW_NOTICE,
  REVIEW_REASON_HINTS,
  REVIEW_REASON_LABELS,
  isStaleReviewRefusal,
  reviewErrorText,
} from "./review-wording";
import { type Assignee, AssigneePicker } from "./task-assignee-picker";
import { useReviewActions } from "./use-review-items";
import "./tasks.css";
import "./review.css";

export interface ReviewResolveDialogProps {
  readonly item: ReviewItemDto;
  readonly mode: "reassign" | "close";
  readonly meId: string;
  readonly onClose: () => void;
  /** The server said the item is gone or changed (404/409): the list behind should re-read. */
  readonly onStale: () => void;
  readonly onDone: (mode: "reassign" | "close") => void;
}

export function ReviewResolveDialog({
  item,
  mode,
  meId,
  onClose,
  onStale,
  onDone,
}: ReviewResolveDialogProps): JSX.Element {
  const id = useId();
  const actions = useReviewActions();
  const [assignee, setAssignee] = useState<Assignee | null>(null);
  const [reason, setReason] = useState<TaskCloseReason | "">("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const radioGroupRef = useRef<HTMLFieldSetElement>(null);
  const title = REVIEW_ACTION_LABELS[mode];

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    setError(null);
    if (mode === "reassign" && !assignee) {
      setError(CHOOSE_ASSIGNEE_TEXT);
      searchRef.current?.focus();
      return;
    }
    if (mode === "close" && !reason) {
      setError(CHOOSE_REASON_TEXT);
      radioGroupRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    const result =
      mode === "reassign" && assignee
        ? await actions.reassign(item.id, assignee.id)
        : reason
          ? await actions.close(item.id, reason)
          : null;
    inFlight.current = false;
    setSubmitting(false);
    if (result?.ok) return onDone(mode);
    setError(reviewErrorText(result?.status, result?.code));
    if (isStaleReviewRefusal(result?.status)) onStale();
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void submit();
  }

  return (
    <Modal open onClose={submitting ? undefined : onClose} ariaLabel={title} width="32rem">
      <form
        className="wx-task-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={onKeyDown}
      >
        <h2>{title}</h2>
        <p className="wx-task-notice">{REVIEW_NOTICE}</p>
        {mode === "reassign" ? (
          item.task ? (
            <AssigneePicker
              channelId={item.task.channel_id}
              meId={meId}
              selected={assignee}
              onSelect={setAssignee}
              error={error}
              inputRef={searchRef}
            />
          ) : null
        ) : (
          <fieldset
            className="wx-review-reasons"
            ref={radioGroupRef}
            aria-describedby={error ? `${id}-error` : undefined}
          >
            <legend>Reason (required)</legend>
            {TASK_CLOSE_REASONS.map((code) => (
              <label key={code} className="wx-review-reason">
                <input
                  type="radio"
                  name={`${id}-reason`}
                  value={code}
                  checked={reason === code}
                  aria-invalid={error ? true : undefined}
                  onChange={() => setReason(code)}
                />
                <span>{REVIEW_REASON_LABELS[code]}</span>
                <span className="wx-task-hint">{REVIEW_REASON_HINTS[code]}</span>
              </label>
            ))}
            {error ? (
              <p className="wx-task-error" id={`${id}-error`} role="alert">
                {error}
              </p>
            ) : null}
          </fieldset>
        )}
        <div className="wx-task-actions">
          <Button type="button" tone="secondary" disabled={submitting} onClick={onClose}>
            Back
          </Button>
          <Button type="submit" loading={submitting}>
            {title}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
