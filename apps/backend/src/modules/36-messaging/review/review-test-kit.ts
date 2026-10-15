// WP 3.8 test support: a fully in-memory review service (memory stores, fake db, captured outbox, controllable ports).
// Not a test file itself; the *.test.ts files in this directory build on it.
import type { DbClient } from "@wardenx/db";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { createMemoryTaskStore } from "../tasks/task-store-memory";
import { queueLifecycleReviewForPatient } from "./lifecycle-queue";
import { type ReviewService, createReviewService } from "./review-service";
import { createMemoryReviewStore } from "./review-store-memory";

export const ORG = "00000000-0000-4000-8000-0000000000a1";
export const ALICE = "00000000-0000-4000-8000-00000000aaa1";
export const BOB = "00000000-0000-4000-8000-00000000bbb1";
export const CAROL = "00000000-0000-4000-8000-00000000ccc1";
export const DAVE = "00000000-0000-4000-8000-00000000ddd1";
export const SUPERVISOR = "00000000-0000-4000-8000-00000000eee1";
export const P1 = "00000000-0000-4000-8000-0000000000e1";
export const P2 = "00000000-0000-4000-8000-0000000000e2";
export const ADMISSION = "00000000-0000-4000-8000-0000000000a9";
export const CARE_CH = "00000000-0000-4000-8000-0000000000c1";
export const CARE_CH_2 = "00000000-0000-4000-8000-0000000000c2";
export const BEREAVEMENT_CH = "00000000-0000-4000-8000-0000000000c3";
export const NOW = new Date("2026-10-14T12:00:00.000Z");

export const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => undefined }),
} as unknown as DbClient;

export const actor = (userId: string) => ({ orgId: ORG, userId });

export interface KitOptions {
  /** Users who may be assigned a task (active and able to view its channel). Defaults to everyone but DAVE. */
  ineligible?: string[];
  /** `userId:patientId` pairs the Part 2 gate refuses. */
  part2Denied?: string[];
  part2Throws?: boolean;
  /** Called with a label each time eligibility is asked, for ordering assertions. */
  trace?: (event: string) => void;
}

let messageSeq = 0;

export function buildKit(opts: KitOptions = {}) {
  const taskStore = createMemoryTaskStore();
  const channelKinds = new Map<string, string>([
    [CARE_CH, "care_team"],
    [CARE_CH_2, "care_team"],
    [BEREAVEMENT_CH, "bereavement"],
  ]);
  const store = createMemoryReviewStore({ tasks: () => taskStore.tasks.values(), channelKinds });
  const published: Array<{
    eventName: string;
    payload: Record<string, unknown>;
    aggregateId: string;
  }> = [];
  const part2Gate: Part2ChannelGate = {
    async allowedUserIds({ patientId, userIds }) {
      if (opts.part2Throws) throw new Error("gate down");
      const denied = new Set(opts.part2Denied ?? []);
      return new Set(userIds.filter((u) => !denied.has(`${u}:${patientId}`)));
    },
  };
  const service: ReviewService = createReviewService({
    db: fakeDb,
    store,
    taskStore,
    outbox: { publish: async (_tx, e) => void published.push(e) },
    isEligible: async (_o, userId) => {
      opts.trace?.("eligible");
      return !(opts.ineligible ?? [DAVE]).includes(userId);
    },
    isActiveInTx: async (_tx, _o, userId) => {
      opts.trace?.("active-in-tx");
      return !(opts.ineligible ?? [DAVE]).includes(userId);
    },
    part2Gate,
    patientLabels: async (_o, ids) =>
      new Map(ids.map((id) => [id, { displayName: "Pat I.", mrnSuffix: "1234" }])),
    displayName: async (_o, u) => `user-${u.slice(-4)}`,
    now: () => NOW,
  });

  /** An active task on `channelId` about `patientId`, assigned to `assignee`. */
  async function task(
    assignee: string,
    over: { patientId?: string; channelId?: string; createdBy?: string } = {},
  ) {
    const created = await taskStore.createOrGetActive(null as never, {
      orgId: ORG,
      messageId: `00000000-0000-4000-8000-${String(++messageSeq).padStart(12, "0")}`,
      channelId: over.channelId ?? CARE_CH,
      patientId: over.patientId ?? P1,
      createdBy: over.createdBy ?? CAROL,
      assigneeId: assignee,
      dueAt: null,
      clinicalConcern: true,
    });
    return created.task;
  }

  const queue = (cause: "death" | "discharge" | "transfer", triggerRef: string, patientId = P1) =>
    queueLifecycleReviewForPatient({ db: fakeDb, store }, ORG, { cause, triggerRef, patientId });

  /** A participant closes the task themselves; the database trigger resolves the review (mirrored by the memory store). */
  async function closeElsewhere(taskId: string, byUserId: string) {
    const r = await taskStore.transition(null as never, {
      orgId: ORG,
      taskId,
      actor: { kind: "user", userId: byUserId },
      action: "complete",
      reason: "action_taken",
    });
    store.resolveForClosedTask(r.task);
  }

  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "ok";
    } catch (e) {
      const err = e as { statusCode?: number; code?: string; message?: string };
      return `${err.statusCode}:${err.code ?? err.message}`;
    }
  };

  return { service, store, taskStore, published, task, queue, closeElsewhere, code };
}
