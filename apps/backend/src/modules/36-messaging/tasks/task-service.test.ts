// WP 3.4 - the task policy with an in-memory store: replay returns the existing active task and publishes nothing, a
// closed prior allows a new one, an assignee who cannot see the channel is the uniform 422, the participant rule is the
// uniform 404, a clinical close needs a reason before the store is touched, and events are PHI-free.
import type { DbClient } from "@wardenx/db";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { type TaskService, createTaskService } from "./task-service";
import { createMemoryTaskStore } from "./task-store-memory";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const CH = "00000000-0000-4000-8000-0000000000c1";
const MSG = "00000000-0000-4000-8000-0000000000d1";
const PAT = "00000000-0000-4000-8000-0000000000e1";
const ALICE = "00000000-0000-4000-8000-00000000aaa1";
const BOB = "00000000-0000-4000-8000-00000000bbb1";
const CAROL = "00000000-0000-4000-8000-00000000ccc1";
const NOW = new Date("2026-10-14T12:00:00.000Z");

const actor = (userId: string) => ({ orgId: ORG, userId });
const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => undefined }),
} as unknown as DbClient;

function setup(
  over: { viewers?: string[]; kind?: string; live?: boolean; archived?: boolean } = {},
) {
  const store = createMemoryTaskStore();
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const viewers = new Set(over.viewers ?? [ALICE, BOB, CAROL]);
  const calls = { store: 0 };
  const service: TaskService = createTaskService({
    db: fakeDb,
    store,
    outbox: {
      publish: async (_tx, e) =>
        void published.push({ eventName: e.eventName, payload: e.payload }),
    },
    messaging: { canViewChannel: async (_o, u) => viewers.has(u) },
    messageLookup: async () =>
      over.live === false
        ? null
        : {
            live: true,
            archived: over.archived === true,
            channelKind: over.kind ?? "group",
            subjectId: over.kind === "care_team" ? PAT : null,
          },
    displayName: async (_o, u) => (u === ALICE ? "Alice" : u === BOB ? "Bob" : null),
    now: () => NOW,
  });
  return { service, store, published, viewers, calls };
}

const convert = (s: TaskService, by = ALICE, to = BOB, extra: Record<string, unknown> = {}) =>
  s.convert(actor(by), { channelId: CH, messageId: MSG, assigneeUserId: to, ...extra });

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof WardenXError) return `${e.statusCode}:${e.code}`;
    throw e;
  }
  return "no-error";
};

describe("convert", () => {
  it("creates an open task, derives no patient on a plain channel, and publishes created", async () => {
    const { service, published } = setup();
    const r = await convert(service);
    expect(r.created).toBe(true);
    expect(r.task).toMatchObject({
      status: "open",
      patient_id: null,
      clinical_concern: false,
      assignee_display_name: "Bob",
      created_by_display_name: "Alice",
      overdue: false,
    });
    expect(r.task.allowed_actions).toEqual(["cancel", "reassign"]);
    expect(published.map((p) => p.eventName)).toEqual(["m36.task.created"]);
  });

  it("derives the patient from a care_team channel and forces clinical_concern", async () => {
    const { service } = setup({ kind: "care_team" });
    const r = await convert(service, ALICE, BOB, { clinicalConcern: false });
    expect(r.task.patient_id).toBe(PAT);
    expect(r.task.clinical_concern).toBe(true);
  });

  it("a requested clinical concern on a plain channel is kept", async () => {
    const { service } = setup();
    expect(
      (await convert(service, ALICE, BOB, { clinicalConcern: true })).task.clinical_concern,
    ).toBe(true);
  });

  it("replay returns the existing active task, unchanged, with no new row, event or outbox publish", async () => {
    const { service, store, published } = setup();
    const first = await convert(service, ALICE, BOB, { clinicalConcern: false });
    const second = await convert(service, ALICE, BOB, { clinicalConcern: true });
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.clinical_concern).toBe(false);
    expect(store.tasks.size).toBe(1);
    expect(store.eventLog).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("a replay by a non-participant is a generic 409 with no task, while the creator and the assignee still read it", async () => {
    const { service, published } = setup();
    const first = await convert(service, ALICE, BOB);
    expect(await code(convert(service, CAROL, BOB))).toBe("409:TASK_ASSIGNEE_ALREADY_HAS_ACTIVE");
    const byAssignee = await convert(service, BOB, BOB);
    expect(byAssignee.created).toBe(false);
    expect(byAssignee.task.id).toBe(first.task.id);
    expect(published).toHaveLength(1);
  });

  it("allows a new task once the previous one for the pair is closed", async () => {
    const { service, store } = setup();
    const first = await convert(service);
    await service.cancel(actor(ALICE), first.task.id);
    const again = await convert(service);
    expect(again.created).toBe(true);
    expect(again.task.id).not.toBe(first.task.id);
    expect(store.tasks.size).toBe(2);
  });

  it("refuses an assignee who cannot view the channel with the uniform 422", async () => {
    const { service, store } = setup({ viewers: [ALICE] });
    expect(await code(convert(service))).toBe("422:TASK_ASSIGNEE_INVALID");
    expect(store.tasks.size).toBe(0);
  });

  it("answers the uniform 404 when the caller cannot see the channel or the message is gone", async () => {
    const hidden = setup({ viewers: [BOB] });
    expect(await code(convert(hidden.service))).toBe("404:NOT_FOUND");
    const gone = setup({ live: false });
    expect(await code(convert(gone.service))).toBe("404:NOT_FOUND");
  });

  it("refuses a due date outside the window with TASK_DUE_INVALID", async () => {
    const { service } = setup();
    const past = new Date(NOW.getTime() - 3_600_000);
    expect(await code(convert(service, ALICE, BOB, { dueAt: past }))).toBe("422:TASK_DUE_INVALID");
  });
});

describe("participant rule", () => {
  it("hides a task from a non-participant and from a participant who lost the channel", async () => {
    const { service, viewers } = setup();
    const { task } = await convert(service);
    await expect(service.get(actor(CAROL), task.id)).rejects.toBeInstanceOf(NotFoundError);
    viewers.delete(BOB);
    await expect(service.get(actor(BOB), task.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.get(actor(ALICE), task.id)).resolves.toBeTruthy();
  });

  it("uses a byte-identical error for missing, non-participant and hidden", async () => {
    const { service, viewers } = setup();
    const { task } = await convert(service);
    const grab = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as WardenXError;
        return JSON.stringify({ c: err.code, m: err.message, s: err.statusCode });
      }
      return "none";
    };
    viewers.delete(BOB);
    const msgs = await Promise.all([
      grab(service.get(actor(CAROL), task.id)),
      grab(service.get(actor(BOB), task.id)),
      grab(service.get(actor(ALICE), "00000000-0000-4000-8000-0000000fffff")),
    ]);
    expect(new Set(msgs).size).toBe(1);
  });

  it("lists only the caller's own tasks on visible channels", async () => {
    const { service, viewers } = setup();
    await convert(service);
    expect(
      await service.list(actor(BOB), { scope: "assigned", state: "active", limit: 50 }),
    ).toHaveLength(1);
    expect(
      await service.list(actor(CAROL), { scope: "assigned", state: "active", limit: 50 }),
    ).toHaveLength(0);
    viewers.delete(BOB);
    expect(
      await service.list(actor(BOB), { scope: "assigned", state: "active", limit: 50 }),
    ).toHaveLength(0);
  });
});

describe("transitions", () => {
  it("accept is the assignee's; the creator is forbidden; repeats are 200 no-ops with no event", async () => {
    const { service, published, store } = setup();
    const { task } = await convert(service);
    await expect(service.accept(actor(ALICE), task.id)).rejects.toMatchObject({ statusCode: 403 });
    const accepted = await service.accept(actor(BOB), task.id);
    expect(accepted.status).toBe("accepted");
    const before = { events: store.eventLog.length, published: published.length };
    const again = await service.accept(actor(BOB), task.id);
    expect(again.status).toBe("accepted");
    expect({ events: store.eventLog.length, published: published.length }).toEqual(before);
    expect(published.at(-1)?.eventName).toBe("m36.task.status_changed");
  });

  it("a plain task closes with or without a reason, and a supplied reason is validated and stored", async () => {
    const { service } = setup();
    const a = await convert(service);
    expect((await service.complete(actor(BOB), a.task.id)).closed_reason).toBeNull();
    const b = await convert(service, ALICE, CAROL);
    expect((await service.complete(actor(CAROL), b.task.id, "action_taken")).closed_reason).toBe(
      "action_taken",
    );
    const c = await convert(service, CAROL, ALICE);
    expect(await code(service.cancel(actor(CAROL), c.task.id, "because"))).toBe(
      "422:TASK_CLOSE_REASON_INVALID",
    );
  });

  it("a clinical task cannot close without a reason, and the store is not touched", async () => {
    const { service, store } = setup({ kind: "care_team" });
    const { task } = await convert(service);
    const events = store.eventLog.length;
    expect(await code(service.complete(actor(BOB), task.id))).toBe(
      "422:TASK_CLOSE_REASON_REQUIRED",
    );
    expect(await code(service.cancel(actor(ALICE), task.id, null))).toBe(
      "422:TASK_CLOSE_REASON_REQUIRED",
    );
    expect(store.eventLog).toHaveLength(events);
    expect((await service.complete(actor(BOB), task.id, "no_action_needed")).status).toBe("done");
  });

  it("a closed task cannot be reopened or changed: 409 TASK_STATE_CONFLICT", async () => {
    const { service } = setup();
    const { task } = await convert(service);
    await service.complete(actor(BOB), task.id);
    expect(await code(service.cancel(actor(ALICE), task.id))).toBe("409:TASK_STATE_CONFLICT");
    expect(await code(service.reassign(actor(ALICE), task.id, CAROL))).toBe(
      "409:TASK_STATE_CONFLICT",
    );
    expect((await service.complete(actor(BOB), task.id)).status).toBe("done");
  });

  it("reassign needs a channel viewer and an assignee without an active task on the message", async () => {
    const { service, viewers } = setup();
    const { task } = await convert(service);
    await convert(service, ALICE, CAROL);
    expect(await code(service.reassign(actor(ALICE), task.id, CAROL))).toBe(
      "409:TASK_ASSIGNEE_ALREADY_HAS_ACTIVE",
    );
    viewers.delete("00000000-0000-4000-8000-00000000ddd1");
    expect(
      await code(service.reassign(actor(ALICE), task.id, "00000000-0000-4000-8000-00000000ddd1")),
    ).toBe("422:TASK_ASSIGNEE_INVALID");
  });

  it("a manual reassign returns the task to open for the new assignee and publishes reassigned", async () => {
    const { service, published } = setup({
      viewers: [ALICE, BOB, CAROL, "00000000-0000-4000-8000-00000000ddd1"],
    });
    const { task } = await convert(service);
    await service.accept(actor(BOB), task.id);
    const moved = await service.reassign(
      actor(BOB),
      task.id,
      "00000000-0000-4000-8000-00000000ddd1",
    );
    expect(moved).toMatchObject({
      status: "open",
      assignee_id: "00000000-0000-4000-8000-00000000ddd1",
    });
    expect(published.at(-1)).toMatchObject({
      eventName: "m36.task.reassigned",
      payload: { fromUserId: BOB, source: "manual" },
    });
  });
});

describe("events are PHI-free", () => {
  it("never carry a patient id or a reason", async () => {
    const { service, published } = setup({ kind: "care_team" });
    const { task } = await convert(service);
    await service.complete(actor(BOB), task.id, "action_taken");
    for (const p of published) {
      const keys = Object.keys(p.payload);
      expect(keys).not.toContain("patientId");
      expect(keys).not.toContain("reason");
      expect(JSON.stringify(p.payload)).not.toContain(PAT);
    }
  });
});

describe("openTaskCount", () => {
  it("counts only the caller's own active tasks on channels they can view", async () => {
    const { service, viewers } = setup({ kind: "care_team" });
    await convert(service);
    expect(await service.openTaskCount(ORG, PAT, BOB)).toBe(1);
    expect(await service.openTaskCount(ORG, PAT, CAROL)).toBe(0);
    viewers.delete(BOB);
    expect(await service.openTaskCount(ORG, PAT, BOB)).toBe(0);
  });
});

describe("task create on an archived channel (WP 3.8, GAP-104 closed for tasks)", () => {
  it("refuses with 410 CHANNEL_ARCHIVED and creates nothing", async () => {
    const { service, store, published } = setup({ archived: true, kind: "care_team" });

    const outcome = await code(convert(service));

    expect(outcome).toBe("410:CHANNEL_ARCHIVED");
    expect(store.tasks.size).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("still creates on a channel that is not archived", async () => {
    const { service } = setup({ archived: false, kind: "care_team" });

    const { created } = await convert(service);

    expect(created).toBe(true);
  });
});
