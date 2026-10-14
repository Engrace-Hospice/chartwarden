// WP 3.4 - the pure task rules: the transition table, who may act, when a closing reason is required, the due window,
// patient derivation and the actions a caller is offered.
import { TASK_ACTIONS, TASK_STATUSES, type TaskAction, type TaskStatus } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  TASK_CLOSE_REASONS,
  type TaskActorRole,
  allowedActions,
  canAct,
  decideTransition,
  derivePatient,
  isActive,
  isOverdue,
  nextStatus,
  requiresCloseReason,
  taskActorRole,
  validateDue,
} from "../src/tasks/task-rules";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe("nextStatus", () => {
  it.each<[TaskStatus, TaskAction, TaskStatus | null]>([
    ["open", "accept", "accepted"],
    ["accepted", "accept", null],
    ["open", "complete", "done"],
    ["accepted", "complete", "done"],
    ["open", "cancel", "cancelled"],
    ["accepted", "cancel", "cancelled"],
    ["open", "reassign", "open"],
    ["accepted", "reassign", "open"],
    ["done", "accept", null],
    ["done", "complete", null],
    ["done", "cancel", null],
    ["done", "reassign", null],
    ["cancelled", "accept", null],
    ["cancelled", "complete", null],
    ["cancelled", "cancel", null],
    ["cancelled", "reassign", null],
  ])("from %s on %s goes to %s", (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });
});

describe("canAct", () => {
  const table: Record<TaskActorRole, Record<TaskAction, boolean>> = {
    assignee: { accept: true, complete: true, cancel: true, reassign: true },
    both: { accept: true, complete: true, cancel: true, reassign: true },
    creator: { accept: false, complete: false, cancel: true, reassign: true },
    none: { accept: false, complete: false, cancel: false, reassign: false },
  };
  for (const role of Object.keys(table) as TaskActorRole[])
    for (const action of TASK_ACTIONS)
      it(`${role} ${table[role][action] ? "may" : "may not"} ${action}`, () => {
        expect(canAct(role, action)).toBe(table[role][action]);
      });
});

describe("taskActorRole", () => {
  const task = { createdBy: "u1", assigneeId: "u2" };
  it("names creator, assignee, both and none", () => {
    expect(taskActorRole(task, "u1")).toBe("creator");
    expect(taskActorRole(task, "u2")).toBe("assignee");
    expect(taskActorRole({ createdBy: "u1", assigneeId: "u1" }, "u1")).toBe("both");
    expect(taskActorRole(task, "u3")).toBe("none");
  });
});

describe("decideTransition", () => {
  const task = (status: TaskStatus) => ({ status, createdBy: "c", assigneeId: "a" });

  it("applies a legal transition by an allowed actor", () => {
    expect(decideTransition(task("open"), "accept", "assignee")).toEqual({
      kind: "apply",
      to: "accepted",
    });
  });

  it("refuses an actor who may not take the action, before looking at state", () => {
    expect(decideTransition(task("open"), "accept", "creator")).toEqual({ kind: "forbidden" });
    expect(decideTransition(task("done"), "accept", "none")).toEqual({ kind: "forbidden" });
  });

  it.each<[TaskStatus, TaskAction]>([
    ["accepted", "accept"],
    ["done", "complete"],
    ["cancelled", "cancel"],
  ])("a repeat of %s via %s is a no-op replay, not a conflict", (status, action) => {
    expect(decideTransition(task(status), action, "assignee")).toEqual({ kind: "noop" });
  });

  it.each<[TaskStatus, TaskAction]>([
    ["done", "cancel"],
    ["cancelled", "complete"],
    ["done", "reassign"],
    ["cancelled", "accept"],
    ["done", "accept"],
  ])("%s then %s is a state conflict (terminal states are final)", (status, action) => {
    expect(decideTransition(task(status), action, "assignee")).toEqual({ kind: "conflict" });
  });

  it("reassign on an active task is applied and never a no-op", () => {
    expect(decideTransition(task("open"), "reassign", "creator")).toEqual({
      kind: "apply",
      to: "open",
    });
  });
});

describe("requiresCloseReason", () => {
  it("is true for a patient task, a flagged task, and false for a plain one", () => {
    expect(requiresCloseReason({ patientId: "p1", clinicalConcern: true })).toBe(true);
    expect(requiresCloseReason({ patientId: null, clinicalConcern: true })).toBe(true);
    expect(requiresCloseReason({ patientId: null, clinicalConcern: false })).toBe(false);
  });
  it("treats a patient task as clinical even if the flag is somehow false", () => {
    expect(requiresCloseReason({ patientId: "p1", clinicalConcern: false })).toBe(true);
  });
});

describe("validateDue", () => {
  it("accepts null and anything inside the window", () => {
    expect(validateDue(null, NOW)).toBeNull();
    expect(validateDue(minutes(-5), NOW)).toBeNull();
    expect(validateDue(days(1), NOW)).toBeNull();
    expect(validateDue(days(366), NOW)).toBeNull();
  });
  it("refuses a due instant more than 5 minutes in the past or beyond 366 days", () => {
    expect(validateDue(minutes(-6), NOW)).toBe("TASK_DUE_INVALID");
    expect(validateDue(new Date(days(366).getTime() + 1), NOW)).toBe("TASK_DUE_INVALID");
    expect(validateDue(new Date("not a date"), NOW)).toBe("TASK_DUE_INVALID");
  });
});

describe("derivePatient", () => {
  it("is the subject for care_team and bereavement channels only", () => {
    expect(derivePatient("care_team", "p1")).toBe("p1");
    expect(derivePatient("bereavement", "p1")).toBe("p1");
    expect(derivePatient("dm", "p1")).toBeNull();
    expect(derivePatient("announcement", "p1")).toBeNull();
    expect(derivePatient("group", null)).toBeNull();
    expect(derivePatient("care_team", null)).toBeNull();
  });
});

describe("isActive / isOverdue", () => {
  it("covers exactly open and accepted", () => {
    expect(TASK_STATUSES.filter(isActive)).toEqual(["open", "accepted"]);
  });
  it("is overdue only when active, due and past due", () => {
    expect(isOverdue({ status: "open", dueAt: minutes(-1) }, NOW)).toBe(true);
    expect(isOverdue({ status: "open", dueAt: minutes(1) }, NOW)).toBe(false);
    expect(isOverdue({ status: "open", dueAt: null }, NOW)).toBe(false);
    expect(isOverdue({ status: "done", dueAt: minutes(-1) }, NOW)).toBe(false);
  });
});

describe("allowedActions", () => {
  const t = (status: TaskStatus) => ({ status });
  it("offers the assignee accept, complete, cancel and reassign on an open task", () => {
    expect(allowedActions(t("open"), "assignee")).toEqual([
      "accept",
      "complete",
      "cancel",
      "reassign",
    ]);
  });
  it("drops accept once accepted, and offers the creator only cancel and reassign", () => {
    expect(allowedActions(t("accepted"), "assignee")).toEqual(["complete", "cancel", "reassign"]);
    expect(allowedActions(t("open"), "creator")).toEqual(["cancel", "reassign"]);
  });
  it("offers nothing on a closed task or to a non-participant", () => {
    expect(allowedActions(t("done"), "both")).toEqual([]);
    expect(allowedActions(t("cancelled"), "assignee")).toEqual([]);
    expect(allowedActions(t("open"), "none")).toEqual([]);
  });
});

it("re-exports the closed reason code set", () => {
  expect(TASK_CLOSE_REASONS).toEqual([
    "action_taken",
    "handled_elsewhere",
    "no_action_needed",
    "unable_to_complete",
    "duplicate",
  ]);
});
