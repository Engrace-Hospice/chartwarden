// M36 WP 3.4 - complete or cancel a task. A clinical task needs a reason CODE (no free text); the submit is blocked
// here and refused by the server alike. A non-clinical task may close with no reason.
import { TASK_CLOSE_REASONS } from "@chartwarden/types";
import type { TaskDto } from "@chartwarden/types";
import { Button, Modal } from "@chartwarden/ui";
import { useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import {
  CHOOSE_REASON_TEXT,
  MEDICATION_CLOSE_NOTE,
  TASK_CLOSE_REASON_LABELS,
  isStaleRefusal,
  taskErrorText,
} from "./task-wording";
import { useTaskActions } from "./use-tasks";
import "./tasks.css";

export interface TaskCloseDialogProps {
  readonly task: TaskDto;
  readonly action: "complete" | "cancel";
  readonly onClose: () => void;
  /** The server said the task is gone or changed (404/409): the list behind should re-read. */
  readonly onStale: () => void;
  readonly onDone: (task: TaskDto) => void;
}

export function TaskCloseDialog({
  task,
  action,
  onClose,
  onStale,
  onDone,
}: TaskCloseDialogProps): JSX.Element {
  const id = useId();
  const actions = useTaskActions();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const title = action === "complete" ? "Complete task" : "Cancel task";

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    setError(null);
    if (task.clinical_concern && !reason) {
      setError(CHOOSE_REASON_TEXT);
      selectRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    const result = await actions.close(action, task.id, reason || null);
    inFlight.current = false;
    setSubmitting(false);
    if (result.ok) onDone(result.task);
    else {
      setError(taskErrorText(result.status, result.code));
      if (isStaleRefusal(result.status)) onStale();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void submit();
  }

  return (
    <Modal open onClose={submitting ? undefined : onClose} ariaLabel={title} width="28rem">
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
        {task.source_kind === "medication_question" ? (
          <p className="wx-task-notice">{MEDICATION_CLOSE_NOTE}</p>
        ) : null}
        <div className="wx-task-field">
          <label htmlFor={`${id}-reason`}>
            Reason{task.clinical_concern ? " (required)" : " (optional)"}
          </label>
          <select
            id={`${id}-reason`}
            ref={selectRef}
            value={reason}
            aria-required={task.clinical_concern}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => setReason(event.target.value)}
          >
            <option value="">Choose a reason</option>
            {TASK_CLOSE_REASONS.map((code) => (
              <option key={code} value={code}>
                {TASK_CLOSE_REASON_LABELS[code]}
              </option>
            ))}
          </select>
          {error ? (
            <p className="wx-task-error" id={`${id}-error`} role="alert">
              {error}
            </p>
          ) : null}
        </div>
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
