// apps/backend/src/modules/36-messaging/review/review-store-memory.ts - WP 3.8: an in-memory ReviewStore that applies the
// same rules as the database store (one row per trigger and task, one OPEN review per task, a decided row is final, the
// task-close trigger). It exists for unit tests of the queue and the service; the database behaviour itself is proven by
// the live suite. The tasks are the memory task store's, and `channelKinds` stands in for the channel join.
import { REVIEW_QUEUE_BATCH } from "@wardenx/messaging";
import { TASK_ACTIVE_STATUSES } from "@wardenx/types";
import {
  type ActiveCareTeamTask,
  CARE_TEAM_CHANNEL_KIND,
  type ReviewRow,
  type ReviewStore,
  type ReviewTaskRow,
  clampReviewLimit,
} from "./review-store-db";

export interface MemoryReviewStoreSources {
  readonly tasks: () => Iterable<ReviewTaskRow>;
  readonly channelKinds: ReadonlyMap<string, string>;
}

export interface MemoryReviewStore extends ReviewStore {
  readonly rows: Map<string, ReviewRow>;
  /** Mirrors `trg_communication_task_resolve_review`: call it after a task closes by any path. */
  resolveForClosedTask(task: ReviewTaskRow): void;
}

const isActive = (status: string): boolean =>
  (TASK_ACTIVE_STATUSES as readonly string[]).includes(status);

export function createMemoryReviewStore(sources: MemoryReviewStoreSources): MemoryReviewStore {
  const rows = new Map<string, ReviewRow>();
  let seq = 0;
  const nextId = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`;

  const duplicates = (r: Omit<ReviewRow, "id">): boolean =>
    [...rows.values()].some(
      (x) =>
        x.organizationId === r.organizationId &&
        x.itemKind === r.itemKind &&
        x.itemId === r.itemId &&
        ((x.source === r.source && x.triggerRef === r.triggerRef) || x.state === "open"),
    );

  return {
    rows,

    async queueItems(_tx, input) {
      let inserted = 0;
      for (const i of input.items) {
        const now = new Date();
        const row: Omit<ReviewRow, "id"> = {
          organizationId: input.orgId,
          source: input.source,
          cause: input.cause,
          triggerRef: input.triggerRef,
          patientId: input.patientId,
          subjectUserId: i.subjectUserId,
          itemKind: i.itemKind,
          itemId: i.itemId,
          state: "open",
          resolution: null,
          resolutionReason: null,
          reassignedToUserId: null,
          resolvedByUserId: null,
          resolvedAt: null,
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
        if (duplicates(row)) continue;
        const id = nextId();
        rows.set(id, { id, ...row });
        inserted += 1;
      }
      return { inserted };
    },

    async openSubjectsForTrigger(_tx, orgId, source, triggerRef) {
      const subjects = [...rows.values()]
        .filter(
          (r) =>
            r.organizationId === orgId &&
            r.source === source &&
            r.triggerRef === triggerRef &&
            r.state === "open",
        )
        .map((r) => r.subjectUserId);
      return [...new Set(subjects)].sort();
    },

    async activeCareTeamTasks(
      _tx,
      orgId,
      patientId,
      afterId,
      limit,
    ): Promise<ActiveCareTeamTask[]> {
      return [...sources.tasks()]
        .filter(
          (t) =>
            t.organizationId === orgId &&
            t.patientId === patientId &&
            isActive(t.status) &&
            sources.channelKinds.get(t.channelId) === CARE_TEAM_CHANNEL_KIND &&
            (afterId === null || t.id > afterId),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, Math.min(limit, REVIEW_QUEUE_BATCH))
        .map((t) => ({ taskId: t.id, assigneeId: t.assigneeId }));
    },

    async list(_tx, orgId, q) {
      const mine = [...rows.values()].filter(
        (r) => r.organizationId === orgId && (q.state === "all" || r.state === q.state),
      );
      const open = mine
        .filter((r) => r.state === "open")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const decided = mine
        .filter((r) => r.state === "resolved")
        .sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0));
      return [...open, ...decided].slice(0, clampReviewLimit(q.limit));
    },

    async get(_tx, orgId, id) {
      const r = rows.get(id);
      return r && r.organizationId === orgId ? r : null;
    },

    async getForUpdate(_tx, orgId, id) {
      const r = rows.get(id);
      return r && r.organizationId === orgId ? r : null;
    },

    async resolve(_tx, a) {
      const cur = rows.get(a.id);
      if (!cur || cur.organizationId !== a.orgId || cur.state !== "open") return null;
      const now = new Date();
      const next: ReviewRow = {
        ...cur,
        state: "resolved",
        resolution: a.resolution,
        resolutionReason: a.resolutionReason,
        reassignedToUserId: a.reassignedToUserId,
        resolvedByUserId: a.resolvedByUserId,
        resolvedAt: now,
        updatedAt: now,
        version: cur.version + 1,
      };
      rows.set(cur.id, next);
      return next;
    },

    async tasksByIds(_tx, orgId, ids) {
      const wanted = new Set(ids);
      return [...sources.tasks()].filter((t) => t.organizationId === orgId && wanted.has(t.id));
    },

    resolveForClosedTask(task) {
      for (const [id, r] of rows) {
        if (r.organizationId !== task.organizationId || r.itemId !== task.id || r.state !== "open")
          continue;
        const now = new Date();
        rows.set(id, {
          ...r,
          state: "resolved",
          resolution: "closed_elsewhere",
          resolutionReason: task.closedReason,
          resolvedByUserId: null,
          resolvedAt: now,
          updatedAt: now,
          version: r.version + 1,
        });
      }
    },
  };
}
