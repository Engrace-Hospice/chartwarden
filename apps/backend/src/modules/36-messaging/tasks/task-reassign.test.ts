// WP 3.4 - offboarding: the creator is preferred, the care team is the fallback in stable order, a throwing care-team
// seam never fails the job, no successor flags needs_owner, and a second run is a no-op.
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { type ReassignDeps, reassignTasksForLeaver } from "./task-reassign";
import { createMemoryTaskStore } from "./task-store-memory";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const CH = "00000000-0000-4000-8000-0000000000c1";
const PAT = "00000000-0000-4000-8000-0000000000e1";
const LEAVER = "00000000-0000-4000-8000-00000000eee1";
const CREATOR = "00000000-0000-4000-8000-00000000aaa1";
const TEAM_B = "00000000-0000-4000-8000-00000000bbb2";
const TEAM_A = "00000000-0000-4000-8000-00000000bbb1";
const msg = (n: number) => `00000000-0000-4000-8000-0000000000d${n}`;
const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => undefined }),
} as unknown as DbClient;

async function seed(over: { patient?: boolean; creator?: string; message?: string } = {}) {
  const store = createMemoryTaskStore();
  const r = await store.createOrGetActive(null as never, {
    orgId: ORG,
    messageId: over.message ?? msg(1),
    channelId: CH,
    patientId: over.patient ? PAT : null,
    createdBy: over.creator ?? CREATOR,
    assigneeId: LEAVER,
    dueAt: null,
    clinicalConcern: over.patient === true,
  });
  return { store, task: r.task };
}

function deps(
  store: ReturnType<typeof createMemoryTaskStore>,
  over: Partial<ReassignDeps> & { eligible?: string[] } = {},
) {
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const d: ReassignDeps = {
    db: fakeDb,
    store,
    outbox: {
      publish: async (_t, e) => void published.push({ eventName: e.eventName, payload: e.payload }),
    },
    isEligible: async (_o, u) => (over.eligible ?? [CREATOR, TEAM_A, TEAM_B]).includes(u),
    careTeamMembers: over.careTeamMembers ?? (async () => [TEAM_B, TEAM_A, LEAVER]),
    ...(over.now ? { now: over.now } : {}),
  };
  return { d, published };
}

describe("reassignTasksForLeaver", () => {
  it("prefers the creator, returns the task to open, and records a system reassigned event", async () => {
    const { store, task } = await seed({ patient: true });
    await store.transition(null as never, {
      orgId: ORG,
      taskId: task.id,
      actor: { kind: "user", userId: LEAVER },
      action: "accept",
    });
    const { d, published } = deps(store);
    const summary = await reassignTasksForLeaver(d, ORG, LEAVER);
    expect(summary).toEqual({ reassigned: 1, flaggedNeedsOwner: 0, failed: 0 });
    expect(store.tasks.get(task.id)).toMatchObject({
      assigneeId: CREATOR,
      status: "open",
      acceptedAt: null,
    });
    expect(store.eventLog.at(-1)).toMatchObject({
      eventType: "reassigned",
      actorKind: "system",
      actorUserId: null,
      reasonCode: "offboarding",
      fromAssigneeId: LEAVER,
      toAssigneeId: CREATOR,
    });
    expect(published).toEqual([
      expect.objectContaining({
        eventName: "m36.task.reassigned",
        payload: expect.objectContaining({
          fromUserId: LEAVER,
          toUserId: CREATOR,
          source: "offboarding",
        }),
      }),
    ]);
  });

  it("falls back to the first eligible care-team member by user id when the creator is not eligible", async () => {
    const { store, task } = await seed({ patient: true });
    const { d } = deps(store, { eligible: [TEAM_A, TEAM_B] });
    await reassignTasksForLeaver(d, ORG, LEAVER);
    expect(store.tasks.get(task.id)?.assigneeId).toBe(TEAM_A);
  });

  it("never uses the care team for a task with no patient", async () => {
    const { store, task } = await seed();
    const { d, published } = deps(store, { eligible: [TEAM_A] });
    const summary = await reassignTasksForLeaver(d, ORG, LEAVER);
    expect(summary.flaggedNeedsOwner).toBe(1);
    expect(store.tasks.get(task.id)).toMatchObject({ assigneeId: LEAVER, needsOwner: true });
    expect(published[0]?.eventName).toBe("m36.task.needs_owner");
    expect(published[0]?.payload).toMatchObject({ creatorUserId: CREATOR });
  });

  it("still reassigns (to the creator) when the care-team seam throws, and flags when nobody else qualifies", async () => {
    const boom = async () => {
      throw new Error("Jane Doe seam outage");
    };
    const a = await seed({ patient: true });
    await reassignTasksForLeaver(deps(a.store, { careTeamMembers: boom }).d, ORG, LEAVER);
    expect(a.store.tasks.get(a.task.id)?.assigneeId).toBe(CREATOR);

    const b = await seed({ patient: true });
    const summary = await reassignTasksForLeaver(
      deps(b.store, { careTeamMembers: boom, eligible: [] }).d,
      ORG,
      LEAVER,
    );
    expect(summary.flaggedNeedsOwner).toBe(1);
    expect(b.store.tasks.get(b.task.id)?.needsOwner).toBe(true);
  });

  it("skips a candidate who already holds an active task on the message", async () => {
    const { store, task } = await seed({ patient: true });
    await store.createOrGetActive(null as never, {
      orgId: ORG,
      messageId: task.messageId,
      channelId: CH,
      patientId: PAT,
      createdBy: CREATOR,
      assigneeId: CREATOR,
      dueAt: null,
      clinicalConcern: true,
    });
    await reassignTasksForLeaver(deps(store).d, ORG, LEAVER);
    expect(store.tasks.get(task.id)?.assigneeId).toBe(TEAM_A);
  });

  it("is idempotent: a second run changes nothing and writes no event", async () => {
    const { store } = await seed();
    const first = deps(store, { eligible: [] });
    await reassignTasksForLeaver(first.d, ORG, LEAVER);
    const events = store.eventLog.length;
    const second = deps(store, { eligible: [] });
    const summary = await reassignTasksForLeaver(second.d, ORG, LEAVER);
    expect(summary).toEqual({ reassigned: 0, flaggedNeedsOwner: 0, failed: 0 });
    expect(store.eventLog).toHaveLength(events);
    expect(second.published).toHaveLength(0);
  });

  it("leaves closed tasks alone and handles several tasks in one run", async () => {
    const { store, task } = await seed({ message: msg(1) });
    const second = await store.createOrGetActive(null as never, {
      orgId: ORG,
      messageId: msg(2),
      channelId: CH,
      patientId: null,
      createdBy: CREATOR,
      assigneeId: LEAVER,
      dueAt: null,
      clinicalConcern: false,
    });
    await store.transition(null as never, {
      orgId: ORG,
      taskId: second.task.id,
      actor: { kind: "user", userId: LEAVER },
      action: "complete",
    });
    const summary = await reassignTasksForLeaver(deps(store).d, ORG, LEAVER);
    expect(summary.reassigned).toBe(1);
    expect(store.tasks.get(second.task.id)?.assigneeId).toBe(LEAVER);
    expect(store.tasks.get(task.id)?.assigneeId).toBe(CREATOR);
  });

  it("isolates a failing task, finishes the rest, then rethrows without the seam's message", async () => {
    const BAD_CHANNEL = "00000000-0000-4000-8000-0000000000c9";
    const { store, task } = await seed({ message: msg(1) });
    const bad = await store.createOrGetActive(null as never, {
      orgId: ORG,
      messageId: msg(2),
      channelId: BAD_CHANNEL,
      patientId: null,
      createdBy: CREATOR,
      assigneeId: LEAVER,
      dueAt: null,
      clinicalConcern: false,
    });
    const { d } = deps(store);
    const failing: ReassignDeps = {
      ...d,
      isEligible: async (o, u, c) => {
        if (c === BAD_CHANNEL) throw new Error("MRN 12345");
        return d.isEligible(o, u, c);
      },
    };
    const error = await reassignTasksForLeaver(failing, ORG, LEAVER).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/1 task\(s\)/);
    expect((error as Error).message).not.toMatch(/MRN/);
    expect(store.tasks.get(task.id)?.assigneeId).toBe(CREATOR);
    expect(store.tasks.get(bad.task.id)?.assigneeId).toBe(LEAVER);
  });
});
