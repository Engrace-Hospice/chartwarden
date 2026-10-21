// M36 WP 3.4 - the caller's tasks and the four things they can do to one. No optimistic state: a row only changes when
// the server's answer replaces it (a closed answer leaves an "active" list), and a refusal leaves the row untouched.
import type { TaskAction, TaskDto } from "@chartwarden/types";
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

export type TaskScope = "assigned" | "created";
export type TaskStateFilter = "active" | "closed" | "all";

export type TasksView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly enabled: boolean; readonly tasks: readonly TaskDto[] };

const isActive = (task: TaskDto): boolean => task.status === "open" || task.status === "accepted";
const matches = (state: TaskStateFilter, task: TaskDto): boolean =>
  state === "all" || (state === "active") === isActive(task);

/** What a list needs from `useTasks`; the inbox owns one and lends it to the list for the default view. */
export type TasksSource = ReturnType<typeof useTasks>;

/** `skip` leaves the list unread (the caller is borrowing another source for this scope and state). */
export function useTasks(scope: TaskScope, state: TaskStateFilter, meId: string, skip = false) {
  const client = useApiClient();
  const [view, setView] = useState<TasksView>({ status: "loading" });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    if (skip) return;
    let current = true;
    setView({ status: "loading" });
    client
      .GET("/api/v1/messaging/tasks", { params: { query: { scope, state } } })
      .then(({ data }) => {
        if (!current) return;
        setView(
          data
            ? {
                status: "ready",
                enabled: data.enabled === true,
                tasks: data.enabled === true ? data.tasks : [],
              }
            : { status: "error" },
        );
      })
      .catch(() => {
        if (current) setView({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [client, scope, state, tick, skip]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  // A row leaves this list when the server's answer no longer fits its state filter, or (assigned scope) it was given away.
  const belongs = useCallback(
    (task: TaskDto) => matches(state, task) && (scope !== "assigned" || task.assignee_id === meId),
    [scope, state, meId],
  );
  const replace = useCallback(
    (task: TaskDto) =>
      setView((now) =>
        now.status !== "ready"
          ? now
          : {
              ...now,
              tasks: now.tasks.flatMap((row) =>
                row.id !== task.id ? [row] : belongs(task) ? [task] : [],
              ),
            },
      ),
    [belongs],
  );
  return { view, reload, replace };
}

export type TaskActionResult =
  | { readonly ok: true; readonly task: TaskDto }
  | { readonly ok: false; readonly status: number | undefined; readonly code: string | undefined };

interface RawAnswer {
  readonly data?: { readonly task: TaskDto };
  readonly error?: { readonly error?: { readonly code?: string } };
  readonly response?: { readonly status: number };
}

const NETWORK_FAILURE: TaskActionResult = { ok: false, status: undefined, code: undefined };

function toResult(answer: RawAnswer): TaskActionResult {
  if (answer.data) return { ok: true, task: answer.data.task };
  return { ok: false, status: answer.response?.status, code: answer.error?.error?.code };
}

export interface TaskActions {
  readonly accept: (taskId: string) => Promise<TaskActionResult>;
  readonly close: (
    action: Extract<TaskAction, "complete" | "cancel">,
    taskId: string,
    reason: string | null,
  ) => Promise<TaskActionResult>;
  readonly reassign: (taskId: string, assigneeUserId: string) => Promise<TaskActionResult>;
}

export function useTaskActions(): TaskActions {
  const client = useApiClient();
  return useMemo(() => {
    const path = (taskId: string) => ({ params: { path: { taskId } } });
    return {
      accept: (taskId) =>
        client
          .POST("/api/v1/messaging/tasks/{taskId}/accept", path(taskId))
          .then(toResult, () => NETWORK_FAILURE),
      close: (action, taskId, reason) => {
        const call =
          action === "complete"
            ? client.POST("/api/v1/messaging/tasks/{taskId}/complete", {
                ...path(taskId),
                body: { reason },
              })
            : client.POST("/api/v1/messaging/tasks/{taskId}/cancel", {
                ...path(taskId),
                body: { reason },
              });
        return call.then(toResult, () => NETWORK_FAILURE);
      },
      reassign: (taskId, assigneeUserId) =>
        client
          .POST("/api/v1/messaging/tasks/{taskId}/reassign", {
            ...path(taskId),
            body: { assignee_user_id: assigneeUserId },
          })
          .then(toResult, () => NETWORK_FAILURE),
    };
  }, [client]);
}
