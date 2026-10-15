// apps/backend/src/modules/36-messaging/review/review-store-db.ts - WP 3.8: the `messaging_review_item` rows (ADR-0065).
//
// Writes take the caller's `tx` (the service or the queue owns the transaction). Every statement names the organization on
// top of RLS. `wardenx_app` may INSERT and UPDATE only the decision columns and has no DELETE: nothing here removes a row.
// WP 3.9 queues its own rows through `queueReviewItems` (same table, source 'care_team_change').
import { schema } from "@wardenx/db";
import { REVIEW_LIST_DEFAULT, REVIEW_LIST_MAX } from "@wardenx/messaging";
import type {
  ReviewCause,
  ReviewItemKind,
  ReviewResolution,
  ReviewSource,
  TaskCloseReason,
} from "@wardenx/types";
import { TASK_ACTIVE_STATUSES } from "@wardenx/types";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const R = schema.messagingReviewItems;
const T = schema.communicationTasks;
const CH = schema.channels;

export type ReviewRow = typeof R.$inferSelect;
export type ReviewTaskRow = typeof T.$inferSelect;

export const CARE_TEAM_CHANNEL_KIND = "care_team";

export interface QueueReviewInput {
  readonly orgId: string;
  readonly source: ReviewSource;
  readonly cause: ReviewCause;
  readonly triggerRef: string;
  readonly patientId: string;
  readonly items: readonly {
    readonly itemKind: ReviewItemKind;
    readonly itemId: string;
    readonly subjectUserId: string;
  }[];
}

export interface ReviewListQuery {
  readonly state: "open" | "resolved" | "all";
  readonly limit: number;
}

export interface ResolveReviewArgs {
  readonly orgId: string;
  readonly id: string;
  readonly resolution: Exclude<ReviewResolution, "closed_elsewhere">;
  readonly resolutionReason: TaskCloseReason | null;
  readonly reassignedToUserId: string | null;
  readonly resolvedByUserId: string;
}

/** A task the lifecycle trigger may queue: active, on the patient, on a care-team channel. */
export interface ActiveCareTeamTask {
  readonly taskId: string;
  readonly assigneeId: string;
}

export interface ReviewStore {
  /** Idempotent: a repeated (trigger, task) inserts nothing, and a task with an open review gets no second one. */
  queueItems(tx: Tx, input: QueueReviewInput): Promise<{ inserted: number }>;
  /** Distinct subject users of the OPEN rows of one trigger, re-read after the insert (redeliveries still alert). */
  openSubjectsForTrigger(
    tx: Tx,
    orgId: string,
    source: ReviewSource,
    triggerRef: string,
  ): Promise<string[]>;
  /** One page of the patient's active care-team tasks, ordered by id, after `afterId`. Bereavement is excluded by kind. */
  activeCareTeamTasks(
    tx: Tx,
    orgId: string,
    patientId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ActiveCareTeamTask[]>;
  list(tx: Tx, orgId: string, q: ReviewListQuery): Promise<ReviewRow[]>;
  get(tx: Tx, orgId: string, id: string): Promise<ReviewRow | null>;
  /** Locks the row. */
  getForUpdate(tx: Tx, orgId: string, id: string): Promise<ReviewRow | null>;
  /** Open -> resolved by a decision; null when the row is not open any more. */
  resolve(tx: Tx, a: ResolveReviewArgs): Promise<ReviewRow | null>;
  /** The tasks the rows point at, for the read model. */
  tasksByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<ReviewTaskRow[]>;
}

const ACTIVE = [...TASK_ACTIVE_STATUSES];

export function clampReviewLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || REVIEW_LIST_DEFAULT, 1), REVIEW_LIST_MAX);
}

export async function queueReviewItems(
  tx: Tx,
  input: QueueReviewInput,
): Promise<{ inserted: number }> {
  if (input.items.length === 0) return { inserted: 0 };
  const rows = await tx
    .insert(R)
    .values(
      input.items.map((i) => ({
        organizationId: input.orgId,
        source: input.source,
        cause: input.cause,
        triggerRef: input.triggerRef,
        patientId: input.patientId,
        subjectUserId: i.subjectUserId,
        itemKind: i.itemKind,
        itemId: i.itemId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: R.id });
  return { inserted: rows.length };
}

export async function openSubjectsForTrigger(
  tx: Tx,
  orgId: string,
  source: ReviewSource,
  triggerRef: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ subjectUserId: R.subjectUserId })
    .from(R)
    .where(
      and(
        eq(R.organizationId, orgId),
        eq(R.source, source),
        eq(R.triggerRef, triggerRef),
        eq(R.state, "open"),
      ),
    )
    .orderBy(asc(R.subjectUserId));
  return rows.map((r) => r.subjectUserId);
}

export function createDbReviewStore(): ReviewStore {
  return {
    queueItems: queueReviewItems,
    openSubjectsForTrigger,

    async activeCareTeamTasks(tx, orgId, patientId, afterId, limit) {
      const rows = await tx
        .select({ taskId: T.id, assigneeId: T.assigneeId })
        .from(T)
        .innerJoin(CH, and(eq(CH.organizationId, T.organizationId), eq(CH.id, T.channelId)))
        .where(
          and(
            eq(T.organizationId, orgId),
            eq(T.patientId, patientId),
            inArray(T.status, ACTIVE),
            eq(CH.channelKind, CARE_TEAM_CHANNEL_KIND),
            afterId ? gt(T.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(T.id))
        .limit(limit);
      return rows;
    },

    async list(tx, orgId, q) {
      const stateFilter = q.state === "all" ? undefined : eq(R.state, q.state);
      // Open first, oldest first; decided rows newest decision first.
      return tx
        .select()
        .from(R)
        .where(and(eq(R.organizationId, orgId), stateFilter))
        .orderBy(
          asc(sql`(${R.state} = 'resolved')`),
          sql`CASE WHEN ${R.state} = 'open' THEN ${R.createdAt} END ASC`,
          desc(R.resolvedAt),
          asc(R.id),
        )
        .limit(clampReviewLimit(q.limit));
    },

    async get(tx, orgId, id) {
      const [row] = await tx
        .select()
        .from(R)
        .where(and(eq(R.organizationId, orgId), eq(R.id, id)))
        .limit(1);
      return row ?? null;
    },

    async getForUpdate(tx, orgId, id) {
      const [row] = await tx
        .select()
        .from(R)
        .where(and(eq(R.organizationId, orgId), eq(R.id, id)))
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async resolve(tx, a) {
      const now = new Date();
      const [row] = await tx
        .update(R)
        .set({
          state: "resolved",
          resolution: a.resolution,
          resolutionReason: a.resolutionReason,
          reassignedToUserId: a.reassignedToUserId,
          resolvedByUserId: a.resolvedByUserId,
          resolvedAt: now,
          updatedAt: now,
          version: sql`${R.version} + 1`,
        })
        .where(and(eq(R.organizationId, a.orgId), eq(R.id, a.id), eq(R.state, "open")))
        .returning();
      return row ?? null;
    },

    async tasksByIds(tx, orgId, ids) {
      if (ids.length === 0) return [];
      return tx
        .select()
        .from(T)
        .where(and(eq(T.organizationId, orgId), inArray(T.id, [...ids])));
    },
  };
}
