// M36 WP 3.4 - "My tasks" (the Tasks tab of Notifications & Tasks). Row actions come only from each task's
// allowed_actions (the server decides who may do what); a row changes only when the server's answer replaces it.
import type { TaskAction, TaskDto } from "@wardenx/types";
import { Button, EmptyState, LoadingSpinner, StatusPill } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { TaskCloseDialog } from "./task-close-dialog";
import { TaskReassignDialog } from "./task-reassign-dialog";
import {
  MEDICATION_QUESTION_LABEL,
  NEEDS_OWNER_LABEL,
  OVERDUE_LABEL,
  PATIENT_TASK_LABEL,
  TASKS_LOAD_FAILED,
  TASKS_OFF_TEXT,
  TASK_ACTION_LABELS,
  TASK_CLOSE_REASON_LABELS,
  TASK_NOTICE,
  TASK_STATUS_LABELS,
  isStaleRefusal,
  taskErrorText,
} from "./task-wording";
import {
  type TaskScope,
  type TaskStateFilter,
  type TasksSource,
  useTaskActions,
  useTasks,
} from "./use-tasks";
import "./tasks.css";

type Dialog =
  | { readonly kind: "close"; readonly task: TaskDto; readonly action: "complete" | "cancel" }
  | { readonly kind: "reassign"; readonly task: TaskDto };

const ACTION_ORDER: readonly TaskAction[] = ["accept", "complete", "cancel", "reassign"];
const SCOPES: readonly { value: TaskScope; label: string }[] = [
  { value: "assigned", label: "Assigned to me" },
  { value: "created", label: "Created by me" },
];
const STATES: readonly { value: TaskStateFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
];
const EMPTY_TEXT: Readonly<Record<TaskStateFilter, string>> = {
  active: "No active tasks.",
  closed: "No closed tasks.",
  all: "No tasks.",
};

function Toggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}): JSX.Element {
  return (
    <fieldset className="wx-task-toggle">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

const dueText = (iso: string): string => `Due ${new Date(iso).toLocaleDateString()}`;

function TaskRow({
  task,
  busy,
  onAction,
}: {
  task: TaskDto;
  busy: boolean;
  onAction: (action: TaskAction, task: TaskDto) => void;
}): JSX.Element {
  const actions = ACTION_ORDER.filter((action) => task.allowed_actions.includes(action));
  return (
    <li className="wx-task-row">
      <div className="wx-task-badges">
        <StatusPill
          label={TASK_STATUS_LABELS[task.status]}
          tone={
            task.status === "done"
              ? "success"
              : task.status === "cancelled"
                ? "neutral"
                : "progress"
          }
        />
        {task.source_kind === "medication_question" ? (
          <span className="wx-task-tag">{MEDICATION_QUESTION_LABEL}</span>
        ) : null}
        {task.patient_id ? <span className="wx-task-tag">{PATIENT_TASK_LABEL}</span> : null}
        {task.needs_owner ? (
          <StatusPill label={NEEDS_OWNER_LABEL} tone="warning" glyph="alert" />
        ) : null}
        {task.overdue ? <StatusPill label={OVERDUE_LABEL} tone="error" glyph="clock" /> : null}
      </div>
      <p className="wx-task-people-line">
        For {task.assignee_display_name ?? "a colleague"}, from{" "}
        {task.created_by_display_name ?? "a colleague"}
        {task.due_at ? `. ${dueText(task.due_at)}` : ""}
        {task.closed_reason ? `. ${TASK_CLOSE_REASON_LABELS[task.closed_reason]}` : ""}
      </p>
      <div className="wx-task-row-actions">
        {actions.map((action) => (
          <Button
            key={action}
            type="button"
            tone="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onAction(action, task)}
          >
            {TASK_ACTION_LABELS[action]}
          </Button>
        ))}
        <Link
          className="wx-task-link"
          to={`/messaging?channelId=${task.channel_id}&messageId=${task.message_id}`}
        >
          Open message
        </Link>
      </div>
    </li>
  );
}

export interface TasksListProps {
  readonly meId: string;
  /** The caller's already-read "assigned, active" list (the inbox shares it with its tab badge), used for that view. */
  readonly shared?: TasksSource;
}

export function TasksList({ meId, shared }: TasksListProps): JSX.Element {
  const [scope, setScope] = useState<TaskScope>("assigned");
  const [state, setState] = useState<TaskStateFilter>("active");
  const borrowing = shared !== undefined && scope === "assigned" && state === "active";
  const own = useTasks(scope, state, meId, borrowing);
  const { view, replace, reload } = borrowing ? shared : own;
  const actions = useTaskActions();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const refocus = useRef(false);
  const inFlight = useRef(false);

  // A finished action can remove the row (and its button) that had focus: land on the heading instead of <body>.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a dialog closes or the list changes
  useEffect(() => {
    if (!refocus.current || dialog) return;
    refocus.current = false;
    if (!document.activeElement || document.activeElement === document.body)
      headingRef.current?.focus();
  }, [dialog, view]);

  // A stale refusal reloads the list and may remove the row that had focus: land on the heading, not <body>.
  function onStaleRefusal(): void {
    refocus.current = true;
    reload();
  }

  function finished(task: TaskDto, text: string): void {
    replace(task);
    setMessage(text);
    refocus.current = true;
    setDialog(null);
  }

  async function onAction(action: TaskAction, task: TaskDto): Promise<void> {
    setFailure(null);
    setMessage("");
    if (action === "complete" || action === "cancel")
      return setDialog({ kind: "close", task, action });
    if (action === "reassign") return setDialog({ kind: "reassign", task });
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = await actions.accept(task.id);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) return finished(result.task, "Task accepted.");
    setFailure(taskErrorText(result.status, result.code));
    if (isStaleRefusal(result.status)) onStaleRefusal();
  }

  return (
    <section className="wx-tasks" aria-labelledby="wx-tasks-heading">
      <h2 id="wx-tasks-heading" ref={headingRef} tabIndex={-1}>
        My tasks
      </h2>
      <p className="wx-task-notice">{TASK_NOTICE}</p>
      <div className="wx-task-toolbar">
        <Toggle label="Which tasks" options={SCOPES} value={scope} onChange={setScope} />
        <Toggle label="Task state" options={STATES} value={state} onChange={setState} />
      </div>
      <output className="sr-only" aria-live="polite">
        {message}
      </output>
      {failure ? (
        <p className="wx-task-error" role="alert">
          {failure}
        </p>
      ) : null}
      {view.status === "loading" ? (
        <LoadingSpinner />
      ) : view.status === "error" ? (
        <p className="wx-task-error" role="alert">
          {TASKS_LOAD_FAILED}
        </p>
      ) : !view.enabled ? (
        <EmptyState title="Tasks" description={TASKS_OFF_TEXT} />
      ) : view.tasks.length === 0 ? (
        <EmptyState title="Tasks" description={EMPTY_TEXT[state]} />
      ) : (
        <ul className="wx-task-rows">
          {view.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              busy={busy}
              onAction={(a, t) => void onAction(a, t)}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === "close" ? (
        <TaskCloseDialog
          task={dialog.task}
          action={dialog.action}
          onClose={() => setDialog(null)}
          onStale={onStaleRefusal}
          onDone={(task) =>
            finished(task, dialog.action === "complete" ? "Task completed." : "Task cancelled.")
          }
        />
      ) : null}
      {dialog?.kind === "reassign" ? (
        <TaskReassignDialog
          task={dialog.task}
          meId={meId}
          onClose={() => setDialog(null)}
          onStale={onStaleRefusal}
          onDone={(task) => finished(task, "Task reassigned.")}
        />
      ) : null}
    </section>
  );
}
