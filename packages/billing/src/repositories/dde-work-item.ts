// @wardenx/billing · repositories — `dde_work_item` + `dde_work_event` (ADR-0052; migration 1060). ORG-SCOPED +
// VERSIONED, shape-identical to the notice repos: keyset pagination, §2.5 optimistic concurrency, no state
// codec (the DDE alphabet is stored as the lowercase domain text). The event table is APPEND-ONLY: this repo
// exposes `append` and a read, never an update. No PHI beyond ids and dates; NO MBI (the service screens notes).
import * as schema from "@wardenx/db/schema";
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

export interface DdeWorkItemListFilter {
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

  /** True when ANY item (open or finished) of this type exists on the subject (the watchdog files at most one). */
  async existsForSubject(
    subjectKind: schema.DdeSubjectKindValue,
    subjectId: string,
    itemType: schema.DdeItemTypeValue,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: I.id })
      .from(I)
      .where(
        and(eq(I.subjectKind, subjectKind), eq(I.subjectId, subjectId), eq(I.itemType, itemType)),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Insert, or return null when an OPEN item of the same (subject, type) already exists. The partial unique index
   * `dde_work_item_open_subject_uq` is the race-safe arbiter, so the NOE/NOTR watchdog and a manual create can
   * never duplicate work.
   */
  async insertIfNoOpen(input: NewDdeWorkItemInput): Promise<DdeWorkItemRecord | null> {
    const [row] = await this.db
      .insert(I)
      .values(input)
      .onConflictDoNothing({
        target: [I.subjectKind, I.subjectId, I.itemType],
        where: sql`state IN ('queued','assigned','in_progress','submitted','returned')`,
      })
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
