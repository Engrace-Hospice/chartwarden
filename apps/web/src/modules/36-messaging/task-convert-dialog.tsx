// M36 WP 3.4 - "Convert to task": pick an assignee (required), an optional due date, and whether the task is a clinical
// concern. The patient link is never sent: the server derives it from the channel. Server refusals land next to the
// field they describe; the notice that tasks do not page anyone stays on screen.
import { Button, Modal, useApiClient } from "@chartwarden/ui";
import { useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { type Assignee, AssigneePicker } from "./task-assignee-picker";
import {
  CHOOSE_ASSIGNEE_TEXT,
  CLINICAL_CONCERN_LABEL,
  TASK_NOTICE,
  taskErrorText,
} from "./task-wording";
import "./tasks.css";

export interface TaskConvertDialogProps {
  readonly channelId: string;
  readonly messageId: string;
  readonly meId: string;
  readonly onClose: () => void;
  /** `created` is false when the person already held an active task on the message. */
  readonly onCreated: (created: boolean) => void;
}

/** A calendar day as the local end of that day, so "due Friday" means all of Friday. */
export function endOfLocalDay(day: string): string | null {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return null;
  return new Date(year, month - 1, date, 23, 59, 59).toISOString();
}

const todayInput = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

export function TaskConvertDialog({
  channelId,
  messageId,
  meId,
  onClose,
  onCreated,
}: TaskConvertDialogProps): JSX.Element {
  const client = useApiClient();
  const dueId = useId();
  const [assignee, setAssignee] = useState<Assignee | null>(null);
  const [due, setDue] = useState("");
  const [clinical, setClinical] = useState(false);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);
  const [dueError, setDueError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    setAssigneeError(null);
    setDueError(null);
    setFormError(null);
    if (!assignee) {
      setAssigneeError(CHOOSE_ASSIGNEE_TEXT);
      searchRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const { data, error, response } = await client.POST(
        "/api/v1/messaging/channels/{id}/messages/{messageId}/tasks",
        {
          params: { path: { id: channelId, messageId } },
          body: {
            assignee_user_id: assignee.id,
            due_at: due ? endOfLocalDay(due) : null,
            clinical_concern: clinical,
          },
        },
      );
      if (data) return onCreated(data.created);
      const text = taskErrorText(response?.status, error?.error.code);
      if (error?.error.code === "TASK_ASSIGNEE_INVALID") setAssigneeError(text);
      else if (error?.error.code === "TASK_DUE_INVALID") setDueError(text);
      else setFormError(text);
    } catch {
      setFormError(taskErrorText(undefined, undefined));
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

  return (
    <Modal
      open
      onClose={submitting ? undefined : onClose}
      ariaLabel="Convert to task"
      width="32rem"
    >
      <form
        className="wx-task-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={onKeyDown}
      >
        <h2>Convert to task</h2>
        <p className="wx-task-notice">{TASK_NOTICE}</p>
        <AssigneePicker
          channelId={channelId}
          meId={meId}
          selected={assignee}
          onSelect={setAssignee}
          error={assigneeError}
          inputRef={searchRef}
        />
        <div className="wx-task-field">
          <label htmlFor={dueId}>Due date (optional)</label>
          <input
            id={dueId}
            type="date"
            min={todayInput()}
            value={due}
            aria-invalid={dueError ? true : undefined}
            aria-describedby={dueError ? `${dueId}-error` : undefined}
            onChange={(event) => setDue(event.target.value)}
          />
          {dueError ? (
            <p className="wx-task-error" id={`${dueId}-error`} role="alert">
              {dueError}
            </p>
          ) : null}
        </div>
        <label className="wx-task-check">
          <input
            type="checkbox"
            checked={clinical}
            onChange={(event) => setClinical(event.target.checked)}
          />{" "}
          {CLINICAL_CONCERN_LABEL}
        </label>
        {formError ? (
          <p className="wx-task-error" role="alert">
            {formError}
          </p>
        ) : null}
        <div className="wx-task-actions">
          <Button type="button" tone="secondary" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            Create task
          </Button>
        </div>
      </form>
    </Modal>
  );
}
