// WP 3.5 test support: a fully in-memory handoff service (memory stores, fake db, captured outbox, controllable ports).
// Not a test file itself; the *.test.ts files in this directory build on it.
import type { DbClient } from "@wardenx/db";
import { ChartWardenError } from "@wardenx/types";
import { allowAllPart2ChannelGate } from "../part2-channel-gate";
import { createMemoryTaskStore } from "../tasks/task-store-memory";
import { createMemoryHandoffPolicyStore } from "./handoff-policy-store-db";
import { type HandoffService, createHandoffService } from "./handoff-service";
import type { HandoffSourcePorts } from "./handoff-sources";
import { createMemoryHandoffStore } from "./handoff-store-memory";
import type { HandoffSummaryPorts } from "./handoff-summaries";

export const ORG = "00000000-0000-4000-8000-0000000000a1";
export const ALICE = "00000000-0000-4000-8000-00000000aaa1";
export const BOB = "00000000-0000-4000-8000-00000000bbb1";
export const CAROL = "00000000-0000-4000-8000-00000000ccc1";
export const P1 = "00000000-0000-4000-8000-0000000000e1";
export const P2 = "00000000-0000-4000-8000-0000000000e2";
export const P3 = "00000000-0000-4000-8000-0000000000e3";
export const VISIT = "00000000-0000-4000-8000-0000000000f1";
export const REFILL = "00000000-0000-4000-8000-0000000000f2";
export const SFV = "00000000-0000-4000-8000-0000000000f3";
export const NOW = new Date("2026-10-14T12:00:00.000Z");

export const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => undefined }),
} as unknown as DbClient;

export const actor = (userId: string) => ({ orgId: ORG, userId });

export interface KitOptions {
  caseload?: string[];
  inactive?: string[];
  missingPermission?: string[];
  /** `userId:patientId` pairs the Part 2 gate refuses. */
  part2Denied?: string[];
  part2Throws?: boolean;
  sourceDown?: ("visit" | "refill" | "sfv" | "tasks")[];
  viewableChannels?: string[];
  policyMinutes?: number | null;
}

export function buildKit(opts: KitOptions = {}) {
  // `opts` is read lazily, so a test may mutate it after the offer (a permission lost, a release revoked).
  let clockMs = NOW.getTime();
  const store = createMemoryHandoffStore();
  const taskStore = createMemoryTaskStore();
  const policyStore = createMemoryHandoffPolicyStore(opts.policyMinutes ?? null);
  const published: Array<{
    eventName: string;
    payload: Record<string, unknown>;
    aggregateId: string;
  }> = [];
  const down = new Set(opts.sourceDown ?? []);
  const sources: HandoffSourcePorts = {
    async nextVisit() {
      if (down.has("visit")) throw new Error("seam down");
      return {
        visitId: VISIT,
        status: "scheduled",
        scheduledStartedAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      };
    },
    async pendingRefills() {
      if (down.has("refill")) throw new Error("seam down");
      return [{ id: REFILL, status: "pending", requestedAt: NOW.toISOString() }];
    },
    async openSfvs() {
      if (down.has("sfv")) throw new Error("seam down");
      return [{ sfvId: SFV, sfvStatus: "scheduled", sfvDueAt: NOW.toISOString() }];
    },
    async activeTasks(_o, _u, patientIds) {
      if (down.has("tasks")) throw new Error("store down");
      return store.tasks.filter((t) => patientIds.includes(t.patientId));
    },
  };
  const summaries: HandoffSummaryPorts = {
    visit: async () => ({ status: "scheduled", occurredAt: NOW.toISOString() }),
    refill: async () => ({ status: "pending", occurredAt: NOW.toISOString() }),
    openSfv: async () => ({ status: "scheduled", occurredAt: NOW.toISOString() }),
    taskStatuses: async (o, ids) => store.taskStatuses(o, ids),
  };
  const viewable = new Set(opts.viewableChannels ?? []);
  const service: HandoffService = createHandoffService({
    db: fakeDb,
    outbox: {
      publish: async (_tx, e) =>
        void published.push({
          eventName: e.eventName,
          payload: e.payload,
          aggregateId: e.aggregateId,
        }),
    },
    store,
    policyStore,
    taskStore,
    messaging: { canViewChannel: async (_o, _u, channelId) => viewable.has(channelId) },
    caseloadPatientIds: async (_o, userId) => (userId === ALICE ? (opts.caseload ?? [P1, P2]) : []),
    patientLabels: async (_o, ids) =>
      new Map(ids.map((id) => [id, { displayName: `Pat ${id.slice(-2)}.`, mrnSuffix: "1234" }])),
    part2Gate: {
      allowedUserIds: async ({ patientId, userIds }) => {
        if (opts.part2Throws) throw new Error("privacy flag unreadable");
        return new Set(
          userIds.filter((u) => !(opts.part2Denied ?? []).includes(`${u}:${patientId}`)),
        );
      },
    },
    permissionsFor: async (_o, userId) =>
      new Set(
        ["messaging.read", "messaging.send", "patient.read"].filter(
          (p) => !(opts.missingPermission ?? []).includes(`${userId}:${p}`),
        ),
      ),
    isActiveUser: async (_o, userId) => !(opts.inactive ?? []).includes(userId),
    sources,
    summaries,
    displayName: async (_o, u) => (u === ALICE ? "Alice" : u === BOB ? "Bob" : null),
    now: () => new Date(clockMs),
  });
  return {
    service,
    store,
    taskStore,
    policyStore,
    published,
    sources,
    summaries,
    viewable,
    advanceMinutes(n: number) {
      clockMs += n * 60_000;
    },
    clock: () => new Date(clockMs),
    allowAll: allowAllPart2ChannelGate,
  };
}

export type Kit = ReturnType<typeof buildKit>;

export const item = (
  kind: "patient" | "visit" | "refill_request" | "symptom_followup" | "task",
  patient: string,
  ref?: string,
) => ({
  kind,
  patient_id: patient,
  ref_id: ref ?? patient,
});

/** The `status:code` of a rejected promise, or "no-error". */
export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChartWardenError) return `${e.statusCode}:${e.code}`;
    throw e;
  }
  return "no-error";
}

export async function offerStandard(kit: Kit, to = BOB) {
  return kit.service.offer(actor(ALICE), {
    toUserId: to,
    items: [item("patient", P1), item("visit", P1, VISIT), item("patient", P2)],
  });
}
