// M36 WP 3.4 - hand a task to another member of its conversation. Same picker as the convert dialog; the server checks
// the person can read the channel and does not already hold an active task on the message.
import type { TaskDto } from "@wardenx/types";
import { Button, Modal } from "@wardenx/ui";
import { useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { type Assignee, AssigneePicker } from "./task-assignee-picker";
import { CHOOSE_ASSIGNEE_TEXT, TASK_NOTICE, taskErrorText } from "./task-wording";
import { useTaskActions } from "./use-tasks";
import "./tasks.css";

export interface TaskReassignDialogProps {
  readonly task: TaskDto;
  readonly meId: string;
  readonly onClose: () => void;
  readonly onDone: (task: TaskDto) => void;
}

export function TaskReassignDialog({
  task,
  meId,
  onClose,
  onDone,
}: TaskReassignDialogProps): JSX.Element {
  const actions = useTaskActions();
  const [assignee, setAssignee] = useState<Assignee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    setError(null);
    if (!assignee) {
      setError(CHOOSE_ASSIGNEE_TEXT);
      searchRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    const result = await actions.reassign(task.id, assignee.id);
    inFlight.current = false;
    setSubmitting(false);
    if (result.ok) onDone(result.task);
    else setError(taskErrorText(result.status, result.code));
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void submit();
  }

  return (
    <Modal open onClose={submitting ? undefined : onClose} ariaLabel="Reassign task" width="32rem">
      <form
        className="wx-task-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={onKeyDown}
      >
        <h2>Reassign task</h2>
        <p className="wx-task-notice">{TASK_NOTICE}</p>
        <AssigneePicker
          channelId={task.channel_id}
          meId={meId}
          selected={assignee}
          onSelect={setAssignee}
          error={error}
          inputRef={searchRef}
        />
        <div className="wx-task-actions">
          <Button type="button" tone="secondary" disabled={submitting} onClick={onClose}>
            Back
          </Button>
          <Button type="submit" loading={submitting}>
            Reassign
          </Button>
        </div>
      </form>
    </Modal>
  );
}
