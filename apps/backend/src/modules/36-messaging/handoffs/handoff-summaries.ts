// apps/backend/src/modules/36-messaging/handoffs/handoff-summaries.ts - WP 3.5: the per-item display state, re-resolved at
// READ time through the owning module's seam (like clinical links, ADR-0059). A handoff stores pointers only, so what an
// item currently looks like (visit status, refill status, follow-up still open, task status) is never a stale copy and
// never a second PHI store. Ids, status codes and instants only. A failing seam yields `unavailable` for that one item.
import type { HandoffItemKind, HandoffItemSummary } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";
import { HANDOFF_SOURCE_CONCURRENCY, mapLimit } from "./handoff-sources";

export interface HandoffSummaryPorts {
  visit(
    orgId: string,
    visitId: string,
  ): Promise<{ status: string; occurredAt: string | null } | null>;
  refill(
    orgId: string,
    refillId: string,
  ): Promise<{ status: string; occurredAt: string | null } | null>;
  /** The follow-up's status when it is still an open obligation, else null. */
  openSfv(
    patientId: string,
    sfvId: string,
  ): Promise<{ status: string | null; occurredAt: string | null } | null>;
  /** Task statuses by id (missing id = gone). */
  taskStatuses(orgId: string, taskIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface SummaryItem {
  readonly id: string;
  readonly kind: HandoffItemKind;
  readonly refId: string;
  readonly patientId: string;
}

export function createSeamSummaryPorts(
  taskStatuses: HandoffSummaryPorts["taskStatuses"],
): HandoffSummaryPorts {
  return {
    async visit(orgId, visitId) {
      const s = await getSeam("VisitReader").linkSummary(orgId, visitId);
      return s ? { status: s.status, occurredAt: s.occurredAt } : null;
    },
    async refill(orgId, refillId) {
      const r = await getSeam("RefillInboxProvider").getRefillRequestById(orgId, refillId);
      return r ? { status: r.status as string, occurredAt: r.requestedAt } : null;
    },
    async openSfv(patientId, sfvId) {
      const rows = await getSeam("HopeJ2051Provider").openSfvs(patientId as never);
      const hit = rows.find((r) => r.sfvId === sfvId);
      return hit ? { status: hit.sfvStatus as string | null, occurredAt: hit.sfvDueAt } : null;
    },
    taskStatuses,
  };
}

const ok = (
  status: string | null,
  occurredAt: string | null,
  stillOpen?: boolean,
): HandoffItemSummary => ({
  state: "ok",
  ...(status ? { status } : {}),
  ...(occurredAt ? { occurred_at: occurredAt } : {}),
  ...(stillOpen === undefined ? {} : { still_open: stillOpen }),
});
const GONE: HandoffItemSummary = { state: "gone" };
const UNAVAILABLE: HandoffItemSummary = { state: "unavailable" };

async function summariseOne(
  ports: HandoffSummaryPorts,
  orgId: string,
  item: SummaryItem,
  taskStatus: ReadonlyMap<string, string> | null,
): Promise<HandoffItemSummary> {
  switch (item.kind) {
    case "patient":
      return { state: "ok" };
    case "visit": {
      const v = await ports.visit(orgId, item.refId);
      return v ? ok(v.status, v.occurredAt) : GONE;
    }
    case "refill_request": {
      const r = await ports.refill(orgId, item.refId);
      return r ? ok(r.status, r.occurredAt) : GONE;
    }
    case "symptom_followup": {
      const s = await ports.openSfv(item.patientId, item.refId);
      return s ? ok(s.status, s.occurredAt, true) : { state: "ok", still_open: false };
    }
    case "task": {
      const status = taskStatus?.get(item.refId);
      return status ? ok(status, null) : GONE;
    }
  }
}

/** One summary per item id. Never throws: a failing source marks only its own items `unavailable`. */
export async function resolveItemSummaries(
  ports: HandoffSummaryPorts,
  orgId: string,
  items: readonly SummaryItem[],
): Promise<Map<string, HandoffItemSummary>> {
  const taskIds = items.filter((i) => i.kind === "task").map((i) => i.refId);
  const taskStatus =
    taskIds.length > 0 ? await ports.taskStatuses(orgId, taskIds).catch(() => null) : null;
  const done = await mapLimit(items, HANDOFF_SOURCE_CONCURRENCY, async (item) => {
    if (item.kind === "task" && taskStatus === null) return UNAVAILABLE;
    try {
      return await summariseOne(ports, orgId, item, taskStatus);
    } catch {
      return UNAVAILABLE;
    }
  });
  return new Map(items.map((item, i) => [item.id, done[i] as HandoffItemSummary]));
}
