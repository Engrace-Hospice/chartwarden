// apps/backend/src/modules/36-messaging/handoffs/handoff-store-db.ts - WP 3.5: the `clinical_handoff` rows, their items
// and the append-only `clinical_handoff_event` history.
//
// Writes take the caller's `tx` (the service owns the transaction and publishes the outbox event inside it). Every
// statement names the organization on top of RLS. `wardenx_app` may UPDATE only the status columns and has no DELETE.
// The pair index (one open handoff per sender and recipient) is the idempotency arbiter for an offer; the one-pending
// index makes a work item belong to ONE open handoff; the closed-row and item-guard triggers are the backstop for the
// transition rules. Resolution takes the handoff row FOR UPDATE first, so an accept racing the expiry tick serialises
// and the loser sees the winner's state.
import { type DbClient, schema } from "@wardenx/db";
import type { HandoffItemAction } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import {
  type HandoffCloseReason,
  type HandoffEventType,
  type HandoffItemKind,
  type HandoffState,
  TASK_ACTIVE_STATUSES,
} from "@wardenx/types";
import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const H = schema.clinicalHandoffs;
const I = schema.clinicalHandoffItems;
const E = schema.clinicalHandoffEvents;
const T = schema.communicationTasks;

export type HandoffRow = typeof H.$inferSelect;
export type HandoffItemRow = typeof I.$inferSelect;
export type HandoffEventRow = typeof E.$inferSelect;
export interface HandoffWithItems {
  readonly handoff: HandoffRow;
  readonly items: HandoffItemRow[];
}

export type HandoffActor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "system" };

export const HANDOFF_LIST_DEFAULT_LIMIT = 50;
export const HANDOFF_LIST_MAX_LIMIT = 100;

/** The handoff is not in a state this action may start from (closed, or a different outcome already recorded). */
export class HandoffStateConflict extends Error {
  constructor() {
    super("handoff state conflict");
    this.name = "HandoffStateConflict";
  }
}

/** An offered work item is already pending in another open handoff. Carries nothing about that handoff. */
export class HandoffItemConflict extends Error {
  constructor() {
    super("handoff item conflict");
    this.name = "HandoffItemConflict";
  }
}

export interface OfferItemArgs {
  readonly kind: HandoffItemKind;
  readonly refId: string;
  readonly patientId: string;
}

export interface InsertOfferedArgs {
  readonly orgId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly offeredAt: Date;
  readonly expiresAt: Date;
  readonly items: readonly OfferItemArgs[];
}

export interface ResolveItemsArgs {
  readonly orgId: string;
  readonly handoffId: string;
  /** null = every pending item of the handoff. */
  readonly itemIds: readonly string[] | null;
  readonly action: HandoffItemAction;
  /** Required for `accept`: the recipient, who becomes the accountable clinician of the item. */
  readonly accountableUserId?: string;
  readonly now: Date;
}

export interface CloseHandoffArgs {
  readonly orgId: string;
  readonly handoffId: string;
  readonly state: Exclude<HandoffState, "offered">;
  readonly reason: HandoffCloseReason;
  readonly now: Date;
}

export interface AppendEventArgs {
  readonly orgId: string;
  readonly handoffId: string;
  readonly type: HandoffEventType;
  readonly actor: HandoffActor;
  readonly itemCount?: number;
  readonly reasonCode?: string | null;
}

export interface HandoffListQuery {
  readonly scope: "incoming" | "outgoing";
  readonly state: "active" | "closed" | "all";
  readonly limit: number;
}

export interface ActiveTaskRow {
  readonly id: string;
  readonly patientId: string;
  readonly status: string;
  readonly dueAt: Date | null;
}

export interface HandoffStore {
  /** The open handoff for the (sender, recipient) pair, or null. */
  findOpenForPair(
    tx: Tx,
    orgId: string,
    fromUserId: string,
    toUserId: string,
  ): Promise<HandoffRow | null>;
  /** Inserts the handoff, its items and the `offered` event; an existing open pair is returned with `created:false`. */
  insertOffered(
    tx: Tx,
    a: InsertOfferedArgs,
  ): Promise<{ handoff: HandoffRow; items: HandoffItemRow[]; created: boolean }>;
  /** Locks and returns the handoff (any state). */
  getForUpdate(tx: Tx, orgId: string, handoffId: string): Promise<HandoffRow | null>;
  itemsOf(tx: Tx, orgId: string, handoffId: string): Promise<HandoffItemRow[]>;
  /** Moves the still-PENDING chosen items; returns exactly the rows that changed. */
  resolveItems(tx: Tx, a: ResolveItemsArgs): Promise<HandoffItemRow[]>;
  /** Closes an OFFERED handoff; throws HandoffStateConflict when it is no longer offered. */
  closeHandoff(tx: Tx, a: CloseHandoffArgs): Promise<HandoffRow>;
  appendEvent(tx: Tx, a: AppendEventArgs): Promise<void>;
  hasEvent(tx: Tx, orgId: string, handoffId: string, type: HandoffEventType): Promise<boolean>;
  /** Appends a `needs_attention` system event unless one exists. True when it appended. */
  markNeedsAttention(tx: Tx, orgId: string, handoffId: string): Promise<boolean>;
  participantGet(
    orgId: string,
    userId: string,
    handoffId: string,
  ): Promise<HandoffWithItems | null>;
  participantList(orgId: string, userId: string, q: HandoffListQuery): Promise<HandoffWithItems[]>;
  events(orgId: string, handoffId: string): Promise<HandoffEventRow[]>;
  /** Ids of offered handoffs past their policy-capped deadline, oldest deadline first. */
  dueIds(
    orgId: string,
    effectiveMinutes: number,
    now: Date,
    limit: number,
    excludeIds: readonly string[],
  ): Promise<string[]>;
  /** Ids of offered handoffs where the leaver is the recipient, or the sender with no `sender_left` event yet. */
  leaverHandoffIds(
    orgId: string,
    leaverUserId: string,
    limit: number,
    excludeIds: readonly string[],
  ): Promise<string[]>;
  /** The user's ACTIVE tasks on the given patients (task pre-fill). */
  activeTasksAssignedTo(
    orgId: string,
    userId: string,
    patientIds: readonly string[],
  ): Promise<ActiveTaskRow[]>;
  /** The handoff's state, org-wide (no participant rule): the notification consumer's "is it still open" check. */
  stateOf(orgId: string, handoffId: string): Promise<HandoffState | null>;
  /** Which of the handoffs carry a `needs_attention` event (one batched read for list and detail). */
  needsAttentionIds(orgId: string, handoffIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Task statuses by id for the read-time item summary (a task the org does not have is simply absent). */
  taskStatuses(orgId: string, taskIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || cause === "23505";
}

const ACTION_STATE: Record<HandoffItemAction, string> = {
  accept: "accepted",
  decline: "declined",
  cancel: "cancelled",
  expire: "expired",
};

async function selectItems(tx: Tx, orgId: string, handoffId: string): Promise<HandoffItemRow[]> {
  return tx
    .select()
    .from(I)
    .where(and(eq(I.organizationId, orgId), eq(I.handoffId, handoffId)))
    .orderBy(asc(I.createdAt), asc(I.id));
}

async function selectOpenForPair(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<HandoffRow | null> {
  const [row] = await tx
    .select()
    .from(H)
    .where(
      and(
        eq(H.organizationId, orgId),
        eq(H.fromUserId, from),
        eq(H.toUserId, to),
        eq(H.state, "offered"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function insertEvent(tx: Tx, a: AppendEventArgs): Promise<void> {
  await tx.insert(E).values({
    organizationId: a.orgId,
    handoffId: a.handoffId,
    eventType: a.type,
    actorUserId: a.actor.kind === "user" ? a.actor.userId : null,
    actorKind: a.actor.kind,
    itemCount: a.itemCount ?? 0,
    reasonCode: a.reasonCode ?? null,
  });
}

async function withItems(tx: Tx, orgId: string, rows: HandoffRow[]): Promise<HandoffWithItems[]> {
  if (rows.length === 0) return [];
  const items = await tx
    .select()
    .from(I)
    .where(
      and(
        eq(I.organizationId, orgId),
        inArray(
          I.handoffId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(I.createdAt), asc(I.id));
  return rows.map((handoff) => ({
    handoff,
    items: items.filter((i) => i.handoffId === handoff.id),
  }));
}

function stateFilter(state: HandoffListQuery["state"]) {
  if (state === "active") return eq(H.state, "offered");
  return state === "closed" ? sql`${H.state} <> 'offered'` : undefined;
}

async function insertOffered(tx: Tx, a: InsertOfferedArgs) {
  const [handoff] = await tx
    .insert(H)
    .values({
      organizationId: a.orgId,
      fromUserId: a.fromUserId,
      toUserId: a.toUserId,
      offeredAt: a.offeredAt,
      expiresAt: a.expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!handoff) {
    const existing = await selectOpenForPair(tx, a.orgId, a.fromUserId, a.toUserId);
    if (!existing) throw new HandoffStateConflict();
    return {
      handoff: existing,
      items: await selectItems(tx, a.orgId, existing.id),
      created: false,
    };
  }
  let items: HandoffItemRow[];
  try {
    items = await tx
      .insert(I)
      .values(
        a.items.map((i) => ({
          organizationId: a.orgId,
          handoffId: handoff.id,
          patientId: i.patientId,
          itemKind: i.kind,
          refId: i.refId,
          accountableUserId: a.fromUserId,
        })),
      )
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HandoffItemConflict();
    throw err;
  }
  await insertEvent(tx, {
    orgId: a.orgId,
    handoffId: handoff.id,
    type: "offered",
    actor: { kind: "user", userId: a.fromUserId },
    itemCount: items.length,
  });
  return { handoff, items, created: true };
}

async function resolveItems(tx: Tx, a: ResolveItemsArgs): Promise<HandoffItemRow[]> {
  if (a.action === "accept" && !a.accountableUserId) throw new HandoffStateConflict();
  if (a.itemIds !== null && a.itemIds.length === 0) return [];
  const changed = await tx
    .update(I)
    .set({
      state: ACTION_STATE[a.action],
      resolvedAt: a.now,
      ...(a.action === "accept" ? { accountableUserId: a.accountableUserId as string } : {}),
    })
    .where(
      and(
        eq(I.organizationId, a.orgId),
        eq(I.handoffId, a.handoffId),
        eq(I.state, "pending"),
        a.itemIds === null ? undefined : inArray(I.id, [...a.itemIds]),
      ),
    )
    .returning();
  if (changed.length > 0) {
    await tx
      .update(H)
      .set({ version: sql`${H.version} + 1`, updatedAt: a.now })
      .where(and(eq(H.organizationId, a.orgId), eq(H.id, a.handoffId), eq(H.state, "offered")));
  }
  return changed;
}

async function closeHandoff(tx: Tx, a: CloseHandoffArgs): Promise<HandoffRow> {
  const [row] = await tx
    .update(H)
    .set({
      state: a.state,
      closedAt: a.now,
      closedReason: a.reason,
      updatedAt: a.now,
      version: sql`${H.version} + 1`,
      ...(a.state === "accepted" ? { acceptedAt: a.now } : {}),
    })
    .where(and(eq(H.organizationId, a.orgId), eq(H.id, a.handoffId), eq(H.state, "offered")))
    .returning();
  if (!row) throw new HandoffStateConflict();
  return row;
}

export function createDbHandoffStore(db: DbClient): HandoffStore {
  const participantFilter = (userId: string) =>
    or(eq(H.fromUserId, userId), eq(H.toUserId, userId));
  return {
    findOpenForPair: selectOpenForPair,
    insertOffered,
    async getForUpdate(tx, orgId, handoffId) {
      const [row] = await tx
        .select()
        .from(H)
        .where(and(eq(H.organizationId, orgId), eq(H.id, handoffId)))
        .limit(1)
        .for("update");
      return row ?? null;
    },
    itemsOf: selectItems,
    resolveItems,
    closeHandoff,
    appendEvent: insertEvent,
    async hasEvent(tx, orgId, handoffId, type) {
      const [row] = await tx
        .select({ id: E.id })
        .from(E)
        .where(and(eq(E.organizationId, orgId), eq(E.handoffId, handoffId), eq(E.eventType, type)))
        .limit(1);
      return !!row;
    },
    async markNeedsAttention(tx, orgId, handoffId) {
      const [existing] = await tx
        .select({ id: E.id })
        .from(E)
        .where(
          and(
            eq(E.organizationId, orgId),
            eq(E.handoffId, handoffId),
            eq(E.eventType, "needs_attention"),
          ),
        )
        .limit(1);
      if (existing) return false;
      await insertEvent(tx, {
        orgId,
        handoffId,
        type: "needs_attention",
        actor: { kind: "system" },
      });
      return true;
    },

    participantGet: (orgId, userId, handoffId) =>
      withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const t = tx as unknown as Tx;
        const [row] = await t
          .select()
          .from(H)
          .where(and(eq(H.organizationId, orgId), eq(H.id, handoffId), participantFilter(userId)))
          .limit(1);
        if (!row) return null;
        return { handoff: row, items: await selectItems(t, orgId, row.id) };
      }),

    participantList: (orgId, userId, q) =>
      withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const t = tx as unknown as Tx;
        const limit = Math.min(
          Math.max(Math.trunc(q.limit) || HANDOFF_LIST_DEFAULT_LIMIT, 1),
          HANDOFF_LIST_MAX_LIMIT,
        );
        const mine = q.scope === "incoming" ? eq(H.toUserId, userId) : eq(H.fromUserId, userId);
        // Open first (soonest deadline), then closed newest first.
        const rows = await t
          .select()
          .from(H)
          .where(and(eq(H.organizationId, orgId), mine, stateFilter(q.state)))
          .orderBy(
            asc(sql`(${H.state} <> 'offered')`),
            asc(sql`CASE WHEN ${H.state} = 'offered' THEN ${H.expiresAt} END`),
            desc(H.closedAt),
            asc(H.id),
          )
          .limit(limit);
        return withItems(t, orgId, rows);
      }),

    events: (orgId, handoffId) =>
      withOrgContext(db, systemOrgContext(orgId), (tx) =>
        tx
          .select()
          .from(E)
          .where(and(eq(E.organizationId, orgId), eq(E.handoffId, handoffId)))
          .orderBy(asc(E.createdAt), asc(E.id)),
      ),

    dueIds: (orgId, effectiveMinutes, now, limit, excludeIds) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        const nowIso = now.toISOString();
        const rows = await tx
          .select({ id: H.id })
          .from(H)
          .where(
            and(
              eq(H.organizationId, orgId),
              eq(H.state, "offered"),
              sql`(${H.expiresAt} <= ${nowIso}::timestamptz OR ${H.offeredAt} + (${effectiveMinutes} * interval '1 minute') <= ${nowIso}::timestamptz)`,
              excludeIds.length > 0 ? notInArray(H.id, [...excludeIds]) : undefined,
            ),
          )
          .orderBy(asc(H.expiresAt), asc(H.id))
          .limit(limit);
        return rows.map((r) => r.id);
      }),

    leaverHandoffIds: (orgId, leaverUserId, limit, excludeIds) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        const senderNotYetFlagged = sql`(${H.fromUserId} = ${leaverUserId} AND NOT EXISTS (
          SELECT 1 FROM clinical_handoff_event e
          WHERE e.organization_id = ${H.organizationId} AND e.handoff_id = ${H.id} AND e.event_type = 'sender_left'))`;
        const rows = await tx
          .select({ id: H.id })
          .from(H)
          .where(
            and(
              eq(H.organizationId, orgId),
              eq(H.state, "offered"),
              or(eq(H.toUserId, leaverUserId), senderNotYetFlagged),
              excludeIds.length > 0 ? notInArray(H.id, [...excludeIds]) : undefined,
            ),
          )
          .orderBy(asc(H.offeredAt), asc(H.id))
          .limit(limit);
        return rows.map((r) => r.id);
      }),

    activeTasksAssignedTo: (orgId, userId, patientIds) =>
      patientIds.length === 0
        ? Promise.resolve([])
        : withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
            const rows = await tx
              .select({ id: T.id, patientId: T.patientId, status: T.status, dueAt: T.dueAt })
              .from(T)
              .where(
                and(
                  eq(T.organizationId, orgId),
                  eq(T.assigneeId, userId),
                  inArray(T.status, [...TASK_ACTIVE_STATUSES]),
                  inArray(T.patientId, [...patientIds]),
                ),
              );
            return rows.flatMap((r) => (r.patientId ? [{ ...r, patientId: r.patientId }] : []));
          }),

    stateOf: (orgId, handoffId) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        const [row] = await tx
          .select({ state: H.state })
          .from(H)
          .where(and(eq(H.organizationId, orgId), eq(H.id, handoffId)))
          .limit(1);
        return row ? (row.state as HandoffState) : null;
      }),

    needsAttentionIds: (orgId, handoffIds) =>
      handoffIds.length === 0
        ? Promise.resolve(new Set<string>())
        : withOrgContext(db, systemOrgContext(orgId), async (tx) => {
            const rows = await tx
              .select({ id: E.handoffId })
              .from(E)
              .where(
                and(
                  eq(E.organizationId, orgId),
                  inArray(E.handoffId, [...handoffIds]),
                  eq(E.eventType, "needs_attention"),
                ),
              );
            return new Set(rows.map((r) => r.id));
          }),

    taskStatuses: (orgId, taskIds) =>
      taskIds.length === 0
        ? Promise.resolve(new Map<string, string>())
        : withOrgContext(db, systemOrgContext(orgId), async (tx) => {
            const rows = await tx
              .select({ id: T.id, status: T.status })
              .from(T)
              .where(and(eq(T.organizationId, orgId), inArray(T.id, [...taskIds])));
            return new Map(rows.map((r) => [r.id, r.status] as const));
          }),
  };
}
