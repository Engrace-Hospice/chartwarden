// @chartwarden/billing · repositories — `dde_work_item` + `dde_work_event` (ADR-0052; migration 1060). ORG-SCOPED +
// VERSIONED, shape-identical to the notice repos: keyset pagination, §2.5 optimistic concurrency, no state
// codec (the DDE alphabet is stored as the lowercase domain text). The event table is APPEND-ONLY: this repo
// exposes `append` and a read, never an update. No PHI beyond ids and dates; NO MBI (the service screens notes).
import * as schema from "@chartwarden/db/schema";
import { type SQL, and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import {
  type BillingDb,
  type CursorPage,
  type VersionedUpdateResult,
  buildCursorPage,
  decodeCursor,
  keysetBefore,
  pageSizeOf,
  versionConflict,
  versionOk,
} from "./db";

const I = schema.ddeWorkItem;
const E = schema.ddeWorkEvent;

export type DdeWorkItemRecord = schema.DdeWorkItem;
export type DdeWorkEventRecord = schema.DdeWorkEvent;
export type NewDdeWorkItemInput = schema.NewDdeWorkItem;
export type NewDdeWorkEventInput = schema.NewDdeWorkEvent;

/** The still-open states (a subject may hold at most one open item per type). */
const OPEN_STATES: schema.DdeStateValue[] = [
  "queued",
  "assigned",
  "in_progress",
  "submitted",
  "returned",
];

/** The provider entities a list may span: everything in the org (`all`), or only these ids (empty = nothing). */
export interface DdeListScope {
  readonly all: boolean;
  readonly providerEntityIds: readonly string[];
}

export interface DdeWorkItemListFilter {
  /** REQUIRED: the actor's provider-entity reach, applied in the query so cursors and pages stay correct. */
  readonly scope: DdeListScope;
  readonly state?: schema.DdeStateValue;
  readonly itemType?: schema.DdeItemTypeValue;
  readonly assigneeMembershipId?: string;
  readonly providerEntityId?: string;
  readonly patientId?: string;
  /** Open items past their deadline as of `asOf`. */
  readonly overdue?: boolean;
  /** Open, not-yet-overdue items that are submitted-without-acceptance or within `atRiskDays` of the deadline. */
  readonly atRisk?: boolean;
  /** `YYYY-MM-DD` the overdue / at-risk filters are judged against. */
  readonly asOf: string;
  readonly atRiskDays: number;
}

/** Columns a transition (or a same-state, version-checked edit) may set. */
export type DdeWorkItemPatch = Partial<
  Pick<
    schema.NewDdeWorkItem,
    | "assigneeMembershipId"
    | "attemptNumber"
    | "submittedAt"
    | "submissionMode"
    | "providerReference"
    | "macAcceptedOn"
    | "dcn"
    | "rtpReasonCode"
    | "outcomeCode"
    | "notes"
    | "priority"
  >
>;

function dayPlus(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class DdeWorkItemRepository {
  constructor(private readonly db: BillingDb) {}

  async findById(id: string): Promise<DdeWorkItemRecord | null> {
    const [row] = await this.db.select().from(I).where(eq(I.id, id)).limit(1);
    return row ?? null;
  }

  /** The open item of this type on the subject, if any (the partial unique index's key). */
  async findOpenForSubject(
    subjectKind: schema.DdeSubjectKindValue,
    subjectId: string,
    itemType: schema.DdeItemTypeValue,
  ): Promise<DdeWorkItemRecord | null> {
    const [row] = await this.db
      .select()
      .from(I)
      .where(
        and(
          eq(I.subjectKind, subjectKind),
          eq(I.subjectId, subjectId),
          eq(I.itemType, itemType),
          inArray(I.state, OPEN_STATES),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Every OPEN item on the subject (optionally only of these types), oldest first. */
  async listOpenForSubject(
    subjectKind: schema.DdeSubjectKindValue,
    subjectId: string,
    itemTypes?: readonly schema.DdeItemTypeValue[],
  ): Promise<readonly DdeWorkItemRecord[]> {
    return this.db
      .select()
      .from(I)
      .where(
        and(
          eq(I.subjectKind, subjectKind),
          eq(I.subjectId, subjectId),
          inArray(I.state, OPEN_STATES),
          ...(itemTypes ? [inArray(I.itemType, [...itemTypes])] : []),
        ),
      )
      .orderBy(asc(I.createdAt), asc(I.id));
  }

  /**
   * What the filing-window watch should do for a notice (ADR-0052 D4):
   *   - `none`    an OPEN item exists, or the latest item was cancelled (an explicit human decision that stays),
   *               or it was closed AFTER an accepted outcome (the notice is accepted), or its closure was already
   *               followed by a respawn;
   *   - `create`  the notice has never had an item;
   *   - `respawn` the latest item is `closed` with no MAC acceptance and has not been respawned yet: re-queue, linked
   *               to it. Each closed item can be followed by at most one respawn, ever.
   */
  async watchdogAction(
    subjectKind: schema.DdeSubjectKindValue,
    subjectId: string,
    itemType: schema.DdeItemTypeValue,
  ): Promise<
    { readonly kind: "none" | "create" } | { readonly kind: "respawn"; readonly fromId: string }
  > {
    const items = await this.db
      .select()
      .from(I)
      .where(
        and(eq(I.subjectKind, subjectKind), eq(I.subjectId, subjectId), eq(I.itemType, itemType)),
      )
      .orderBy(desc(I.createdAt), desc(I.id));
    const latest = items[0];
    if (!latest) return { kind: "create" };
    if (items.some((r) => OPEN_STATES.includes(r.state))) return { kind: "none" };
    if (latest.state !== "closed" || latest.macAcceptedOn !== null) return { kind: "none" };
    if (items.some((r) => r.respawnedFromId === latest.id)) return { kind: "none" };
    return { kind: "respawn", fromId: latest.id };
  }

  /**
   * Insert, or return null when an OPEN item of the same (subject, type) already exists, or the closed item being
   * respawned already was. The partial unique indexes `dde_work_item_open_subject_uq` and
   * `dde_work_item_respawn_once_uq` are the race-safe arbiters, so the NOE/NOTR watchdog and a manual create can
   * never duplicate work.
   */
  async insertIfNoOpen(input: NewDdeWorkItemInput): Promise<DdeWorkItemRecord | null> {
    const [row] = await this.db
      .insert(I)
      .values(input)
      // DELIBERATELY target-less: it covers exactly the unique indexes on this table besides the primary key,
      // `dde_work_item_open_subject_uq` (one open item per subject and type) and `dde_work_item_respawn_once_uq` (one
      // respawn per closed item). A pinned live test lists them; adding a unique index means revisiting this call.
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async listByOrgPage(
    organizationId: string,
    filter: DdeWorkItemListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<DdeWorkItemRecord>> {
    const size = pageSizeOf(limit);
    const conditions: (SQL | undefined)[] = [
      eq(I.organizationId, organizationId),
      // Reach first: an actor with no reach sees nothing (never everything), and an explicit providerEntityId outside
      // the reach simply matches no row, so it reveals nothing about that entity.
      filter.scope.all
        ? undefined
        : filter.scope.providerEntityIds.length === 0
          ? sql`false`
          : inArray(I.providerEntityId, [...filter.scope.providerEntityIds]),
      filter.state ? eq(I.state, filter.state) : undefined,
      filter.itemType ? eq(I.itemType, filter.itemType) : undefined,
      filter.assigneeMembershipId
        ? eq(I.assigneeMembershipId, filter.assigneeMembershipId)
        : undefined,
      filter.providerEntityId ? eq(I.providerEntityId, filter.providerEntityId) : undefined,
      filter.patientId ? eq(I.patientId, filter.patientId) : undefined,
      filter.overdue
        ? and(inArray(I.state, OPEN_STATES), lt(I.deadlineAt, filter.asOf))
        : undefined,
      filter.atRisk
        ? and(
            inArray(I.state, OPEN_STATES),
            gte(I.deadlineAt, filter.asOf),
            or(
              eq(I.state, "submitted"),
              lte(I.deadlineAt, dayPlus(filter.asOf, filter.atRiskDays)),
            ),
          )
        : undefined,
      keysetBefore(I.createdAt, I.id, cursor ? decodeCursor(cursor) : undefined),
    ];
    const rows = await this.db
      .select()
      .from(I)
      .where(and(...conditions))
      .orderBy(desc(I.createdAt), desc(I.id))
      .limit(size + 1);
    return buildCursorPage(rows, size, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }));
  }

  /**
   * REDUCER-DRIVEN, version-checked write (§2.5). `nextState` may equal the current state for a same-state edit
   * (a reassignment). VERSION_CONFLICT carries the persisted version (or null when the row vanished).
   */
  async transitionToState(
    id: string,
    expectedVersion: number,
    nextState: schema.DdeStateValue,
    patch: DdeWorkItemPatch = {},
  ): Promise<VersionedUpdateResult<DdeWorkItemRecord>> {
    const [row] = await this.db
      .update(I)
      .set({ ...patch, state: nextState, version: expectedVersion + 1, updatedAt: new Date() })
      .where(and(eq(I.id, id), eq(I.version, expectedVersion)))
      .returning();
    if (row) return versionOk(row);
    const current = await this.findById(id);
    return versionConflict(current?.version ?? null);
  }
}

export class DdeWorkEventRepository {
  constructor(private readonly db: BillingDb) {}

  async append(input: NewDdeWorkEventInput): Promise<DdeWorkEventRecord> {
    const [row] = await this.db.insert(E).values(input).returning();
    if (!row) throw new Error("dde_work_event insert returned no row");
    return row;
  }

  /** The item's history, oldest first. */
  async listForItem(workItemId: string): Promise<readonly DdeWorkEventRecord[]> {
    return this.db
      .select()
      .from(E)
      .where(eq(E.workItemId, workItemId))
      .orderBy(asc(E.occurredAt), asc(E.id));
  }
}
