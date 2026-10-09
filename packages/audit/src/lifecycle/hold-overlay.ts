// @wardenx/audit - the legal-hold OVERLAY materialiser (M4 spec §2.6 / §10.6; GAP-008; ADR-0051).
//
// A hold cannot flip `audit_event.retention_class` (the column is in the integrity hash and `wardenx_app` has no UPDATE on the
// table), so a hold is recorded as rows in the append-only `legal_hold_audit_event` overlay: one per (hold, audit row). This
// module turns a hold's `criteria` into a SQL predicate over `audit_event` and writes the overlay in DAY WINDOWS, each in its
// own tenant-context transaction - bounded, idempotent (ON CONFLICT DO NOTHING) and resumable from `materialised_through`.
//
// THE MEANING OF A HOLD, in SQL (it must equal `holdCoversGroup` in ./legal-hold-match, row by row - the parity test pins it):
//   patientIds     the row's `context.patientId` is listed, OR its `resource_id` is listed (a patient-keyed row, or any row
//                  whose resource is the listed id);
//   resourceKinds  the row's `resource_kind` is listed;
//   dateRange      the row's `created_at` lies in [from, to]. (The group check uses SPAN overlap, which is wider; per row the
//                  exact test is the right one. A bound that does not parse is dropped from the predicate - over-holding.)
// Every selector the hold names must match (AND); a hold naming none selects nothing (the route refuses to create one).
//
// WHY A MATERIALISED OVERLAY ON TOP OF THE GROUP CHECK. The group check (`legalHoldFor`) is the first gate and covers rows that
// are not materialised yet; the overlay makes the protection per-row, queryable (`audit_event_effective`), and enforceable by
// the database (the BEFORE DELETE trigger). Supremacy never waits on this job.
//
// OVERLAP. Each pass re-scans the last `RESCAN_OVERLAP_MS` before `materialised_through`: an audit row can commit slightly after
// its `created_at` (async writers, clock skew), and ON CONFLICT DO NOTHING makes the re-scan free of duplicates.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type SQL, and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { LegalHoldCriteriaShape } from "./legal-hold-match";

const A = schema.auditEvents;
const HOLD = schema.legalHolds;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Re-scan this far behind the high-water mark (late commits). */
export const RESCAN_OVERLAP_MS = 10 * MINUTE_MS;
/** Windows written per hold per pass; the rest waits for the next tick (status stays `running`). */
export const DEFAULT_MAX_WINDOWS_PER_PASS = 400;

// The OUTER audit row, spelled with an explicit table qualifier. A Drizzle column reference renders UNQUALIFIED inside a
// single-table select / delete, and an unqualified `organization_id` / `id` / `created_at` inside the correlated subquery
// would bind to the overlay's own columns (or be ambiguous) instead of the audit row.
const OUTER_ORG = sql.raw('"audit_event"."organization_id"');
const OUTER_ID = sql.raw('"audit_event"."id"');
const OUTER_CREATED_AT = sql.raw('"audit_event"."created_at"');

/**
 * `EXISTS` an overlay entry of a still-ACTIVE hold for the OUTER `audit_event` row (ADR-0051). The pair (id, created_at) is the
 * row's identity across the partition key; the org predicate keeps the lookup on the overlay's
 * (organization_id, audit_event_id, audit_event_created_at) index. Use inside a statement whose FROM is `audit_event`.
 */
export function rowHeldByActiveLegalHold(): SQL {
  return sql`EXISTS (
    SELECT 1
      FROM legal_hold_audit_event h
      JOIN legal_hold l ON l.id = h.legal_hold_id AND l.status = 'active'
     WHERE h.organization_id = ${OUTER_ORG}
       AND h.audit_event_id = ${OUTER_ID}
       AND h.audit_event_created_at = ${OUTER_CREATED_AT}
  )`;
}

/** Parse an ISO bound; `null` when it does not parse (the bound is then dropped - over-holding is the safe direction). */
function parseBound(iso: string | undefined): Date | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * The `audit_event` predicate a hold's criteria select, or `null` when the criteria name no selector (a hold that names
 * nothing selects nothing). Pure: builds SQL, runs nothing.
 */
export function holdCriteriaPredicate(criteria: unknown): SQL | null {
  const c = (criteria ?? {}) as LegalHoldCriteriaShape;
  const patientIds = c.patientIds ?? [];
  const kinds = c.resourceKinds ?? [];
  const range = c.dateRange;
  const hasPatients = patientIds.length > 0;
  const hasKinds = kinds.length > 0;
  const hasRange = range !== undefined && range !== null;
  if (!hasPatients && !hasKinds && !hasRange) return null;

  const clauses: SQL[] = [];
  if (hasPatients) {
    const uuids = patientIds.filter((id) => UUID_SHAPE.test(id));
    const byContext = inArray(sql<string>`${A.context}->>'patientId'`, [...patientIds]);
    // A non-uuid id can never equal a real resource id; with none valid only the context arm can match.
    clauses.push(
      uuids.length > 0
        ? (or(byContext, inArray(A.resourceId, uuids)) as SQL)
        : (byContext as SQL),
    );
  }
  if (hasKinds) clauses.push(inArray(A.resourceKind, [...kinds]));
  if (hasRange) {
    const from = parseBound(range.from);
    const to = parseBound(range.to);
    if (from) clauses.push(gte(A.createdAt, from));
    if (to) clauses.push(lte(A.createdAt, to));
  }
  // A range whose bounds both failed to parse and no other selector leaves nothing to narrow by: it holds every row.
  return clauses.length === 0 ? sql`true` : (and(...clauses) as SQL);
}

/** The inclusive upper edge of a hold's materialisation: its `dateRange.to` when it has a parseable one. */
function upperBoundOf(criteria: unknown): Date | null {
  const range = ((criteria ?? {}) as LegalHoldCriteriaShape).dateRange;
  return range ? parseBound(range.to) : null;
}

function lowerBoundOf(criteria: unknown): Date | null {
  const range = ((criteria ?? {}) as LegalHoldCriteriaShape).dateRange;
  return range ? parseBound(range.from) : null;
}

type Rows<T> = { rows?: T[] };
const rowsOf = <T>(res: unknown): T[] => (res as Rows<T>).rows ?? [];

/** One window: write the overlay rows for `[from, to)`; returns how many were NEW. */
export async function materialiseHoldWindow(
  db: DbClient,
  input: {
    readonly organizationId: string;
    readonly legalHoldId: string;
    readonly criteria: unknown;
    readonly from: Date;
    readonly to: Date;
  },
): Promise<number> {
  const predicate = holdCriteriaPredicate(input.criteria);
  if (predicate === null) return 0;
  return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
    const res = await tx.execute(sql`
      INSERT INTO legal_hold_audit_event (organization_id, legal_hold_id, audit_event_id, audit_event_created_at)
      SELECT ${input.organizationId}::uuid, ${input.legalHoldId}::uuid, ${A.id}, ${A.createdAt}
        FROM ${A}
       WHERE ${A.organizationId} = ${input.organizationId}::uuid
         AND ${A.createdAt} >= ${input.from.toISOString()}::timestamptz
         AND ${A.createdAt} < ${input.to.toISOString()}::timestamptz
         AND ${predicate}
      ON CONFLICT DO NOTHING
      RETURNING 1`);
    return rowsOf<unknown>(res).length;
  });
}

export interface MaterialiseHoldResult {
  readonly legalHoldId: string;
  readonly windows: number;
  readonly newRows: number;
  /** True when the pass reached `now` (or the hold's upper bound); false when it hit the window cap. */
  readonly caughtUp: boolean;
}

interface HoldState {
  readonly id: string;
  readonly criteria: unknown;
  readonly status: string;
  readonly materialisedThrough: Date | null;
  readonly appliedAt: Date;
}

async function loadHold(
  db: DbClient,
  organizationId: string,
  legalHoldId: string,
): Promise<HoldState | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [row] = await tx
      .select({
        id: HOLD.id,
        criteria: HOLD.criteria,
        status: HOLD.status,
        materialisedThrough: HOLD.materialisedThrough,
        appliedAt: HOLD.appliedAt,
      })
      .from(HOLD)
      .where(and(eq(HOLD.organizationId, organizationId), eq(HOLD.id, legalHoldId)))
      .limit(1);
    return row ?? null;
  });
}

/** The earliest `audit_event.created_at` of the org, or null when it has none. */
async function earliestEventAt(db: DbClient, organizationId: string): Promise<Date | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const res = await tx.execute(
      sql`SELECT min(${A.createdAt}) AS first FROM ${A} WHERE ${A.organizationId} = ${organizationId}::uuid`,
    );
    const first = rowsOf<{ first: string | Date | null }>(res)[0]?.first;
    return first ? new Date(first) : null;
  });
}

async function recordProgress(
  db: DbClient,
  organizationId: string,
  legalHoldId: string,
  patch: {
    readonly status: "running" | "complete" | "failed";
    readonly through?: Date;
    readonly addedRows?: number;
  },
): Promise<void> {
  await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    await tx
      .update(HOLD)
      .set({
        materialisationStatus: patch.status,
        ...(patch.through ? { materialisedThrough: patch.through } : {}),
        ...(patch.addedRows
          ? { materialisedCount: sql`${HOLD.materialisedCount} + ${patch.addedRows}` }
          : {}),
      })
      .where(and(eq(HOLD.organizationId, organizationId), eq(HOLD.id, legalHoldId)));
  });
}

/**
 * Bring one hold's overlay up to date: from its high-water mark (less the overlap) to now (or its `dateRange.to`) in day
 * windows, capped per pass. A no-op for a hold that is not active. A window failure marks the hold `failed` and rethrows (the
 * next pass resumes from the last committed window).
 */
export async function materialiseHold(
  db: DbClient,
  input: {
    readonly organizationId: string;
    readonly legalHoldId: string;
    readonly now: Date;
    readonly maxWindows?: number;
  },
): Promise<MaterialiseHoldResult> {
  const { organizationId, legalHoldId, now } = input;
  const hold = await loadHold(db, organizationId, legalHoldId);
  const empty = { legalHoldId, windows: 0, newRows: 0, caughtUp: true };
  if (!hold || hold.status !== "active") return empty;
  if (holdCriteriaPredicate(hold.criteria) === null) return empty;

  const upper = upperBoundOf(hold.criteria);
  // The exclusive end: just past the upper bound's last instant, or the present.
  const end = upper && upper.getTime() + 1 < now.getTime() ? new Date(upper.getTime() + 1) : now;
  // A BOUNDED hold that is fully written has nothing more to find. An open-ended one never short-circuits: it always re-scans
  // its overlap window, because a row can commit just behind `materialised_through`.
  if (upper && hold.materialisedThrough && hold.materialisedThrough.getTime() >= end.getTime()) {
    return empty;
  }
  const lower = lowerBoundOf(hold.criteria);
  let cursor: Date;
  if (hold.materialisedThrough) {
    cursor = new Date(hold.materialisedThrough.getTime() - RESCAN_OVERLAP_MS);
  } else {
    const first = await earliestEventAt(db, organizationId);
    if (first === null) {
      await recordProgress(db, organizationId, legalHoldId, { status: "complete", through: now });
      return empty;
    }
    cursor = lower && lower.getTime() > first.getTime() ? lower : first;
  }
  if (lower && cursor.getTime() < lower.getTime()) cursor = lower;

  const maxWindows = input.maxWindows ?? DEFAULT_MAX_WINDOWS_PER_PASS;
  let windows = 0;
  let newRows = 0;
  try {
    while (cursor.getTime() < end.getTime() && windows < maxWindows) {
      const to = new Date(Math.min(cursor.getTime() + DAY_MS, end.getTime()));
      const added = await materialiseHoldWindow(db, {
        organizationId,
        legalHoldId,
        criteria: hold.criteria,
        from: cursor,
        to,
      });
      windows += 1;
      newRows += added;
      cursor = to;
      await recordProgress(db, organizationId, legalHoldId, {
        status: "running",
        through: to,
        addedRows: added,
      });
    }
  } catch (error) {
    await recordProgress(db, organizationId, legalHoldId, { status: "failed" }).catch(
      () => undefined,
    );
    throw error;
  }
  const caughtUp = cursor.getTime() >= end.getTime();
  if (caughtUp) await recordProgress(db, organizationId, legalHoldId, { status: "complete" });
  return { legalHoldId, windows, newRows, caughtUp };
}

/** The org's ACTIVE hold ids (the reconcile pass materialises each; released holds keep their overlay as history). */
export async function listActiveHoldIds(
  db: DbClient,
  organizationId: string,
): Promise<readonly string[]> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const rows = await tx
      .select({ id: HOLD.id })
      .from(HOLD)
      .where(and(eq(HOLD.organizationId, organizationId), eq(HOLD.status, "active")));
    return rows.map((r) => r.id);
  });
}

export interface ReconcileOrgResult {
  readonly holds: number;
  readonly newRows: number;
  readonly failed: readonly string[];
}

/**
 * One reconcile pass for an org: every active hold is brought up to date (newly applied holds, pre-existing holds the
 * migration left `pending`, and the rows an open-ended hold gains as time passes). A hold that fails is counted and never
 * stops the others.
 */
export async function reconcileOrgHolds(
  db: DbClient,
  organizationId: string,
  now: Date,
  options: { readonly maxWindows?: number } = {},
): Promise<ReconcileOrgResult> {
  const ids = await listActiveHoldIds(db, organizationId);
  let newRows = 0;
  const failed: string[] = [];
  for (const legalHoldId of ids) {
    try {
      const result = await materialiseHold(db, {
        organizationId,
        legalHoldId,
        now,
        ...(options.maxWindows === undefined ? {} : { maxWindows: options.maxWindows }),
      });
      newRows += result.newRows;
    } catch {
      failed.push(legalHoldId);
    }
  }
  return { holds: ids.length, newRows, failed };
}
