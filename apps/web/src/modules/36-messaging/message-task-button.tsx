// M36 WP 3.4 - the message-row "Task" trigger. It renders nothing unless the tenant has tasks on, and tells the person
// (politely, in a live region) what happened when the dialog closes.
import type { JSX } from "react";
import { useState } from "react";
import { TaskConvertDialog } from "./task-convert-dialog";
import { useTasksEnabled } from "./use-tasks-enabled";
import "./tasks.css";

export interface MessageTaskButtonProps {
  readonly channelId: string;
  readonly messageId: string;
  readonly meId: string;
}

export function MessageTaskButton({
  channelId,
  messageId,
  meId,
}: MessageTaskButtonProps): JSX.Element | null {
  const enabled = useTasksEnabled();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  if (!enabled) return null;
  return (
    <>
      <button
        type="button"
        className="wx-pin-toggle"
        aria-label="Convert this message to a task"
        onClick={() => {
          setStatus("");
          setOpen(true);
        }}
      >
        Task
      </button>
      <output className="sr-only" aria-live="polite">
        {status}
      </output>
      {open ? (
        <TaskConvertDialog
          channelId={channelId}
          messageId={messageId}
          meId={meId}
          onClose={() => setOpen(false)}
          onCreated={(created) => {
            setStatus(
              created ? "Task created." : "That person already has an active task on this message.",
            );
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
