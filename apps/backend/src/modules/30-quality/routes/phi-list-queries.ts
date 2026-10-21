// apps/backend/src/modules/30-quality/routes/phi-list-queries.ts — GAP-091.
//
// The three M30 PHI list reads (R-50 incidents, R-70 mortality, R-90 infection events) as real keyset
// queries. They used to fetch the newest 200 rows and filter + paginate in memory, which made every older
// record unreachable. Here the filters, the patient scope and the `(anchor DESC, id DESC)` keyset cursor
// are all in the WHERE clause, and a page is fetched as `size + 1` rows so `hasMore` is exact.
import { schema } from "@chartwarden/db";
import type { QualityDb } from "@chartwarden/quality";
import { ChartWardenError } from "@chartwarden/types";
import { type SQL, and, desc, eq, gte, inArray, lt, lte, ne, or } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { type CursorPage, decodeCursor, encodeCursor } from "./concurrency";
import { type QualityPatientScope, patientScopeCondition } from "./patient-scope";
import type { IncidentListFilter, InfectionEventFilter, MortalityListFilter } from "./read-service";

const I = schema.incidentReport;
const M = schema.mortalityReview;
const E = schema.infectionSurveillanceEvent;

const KIND_ABUSE = "allegation_of_abuse";

/** A decoded keyset cursor: the partition-key anchor + row id of the last row of the previous page. */
export interface ListCursor {
  readonly at: Date;
  readonly id: string;
}

function olderThan(
  anchor: PgColumn,
  idCol: PgColumn,
  cursor: ListCursor | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  return or(lt(anchor, cursor.at), and(eq(anchor, cursor.at), lt(idCol, cursor.id)));
}

const dateOrUndef = (iso: string | undefined): Date | undefined =>
  iso === undefined ? undefined : new Date(iso);

export function incidentListWhere(
  organizationId: string,
  filter: IncidentListFilter,
  scope: QualityPatientScope,
  cursor: ListCursor | undefined,
  ownMembershipId?: string,
): SQL {
  const after = dateOrUndef(filter.occurredAfter);
  const before = dateOrUndef(filter.occurredBefore);
  const where = and(
    eq(I.organizationId, organizationId),
    // Dropped in SQL, BEFORE the page is cut, so a short page / skipped cursor cannot reveal abuse rows.
    filter.mayViewAbuseAllegations ? undefined : ne(I.kind, KIND_ABUSE),
    filter.patientId ? eq(I.patientId, filter.patientId) : undefined,
    filter.kinds?.length ? inArray(I.kind, [...filter.kinds]) : undefined,
    filter.states?.length ? inArray(I.lifecycle, [...filter.states]) : undefined,
    filter.severities?.length ? inArray(I.severity, [...filter.severities]) : undefined,
    after ? gte(I.occurredAt, after) : undefined,
    before ? lte(I.occurredAt, before) : undefined,
    patientScopeCondition(I.patientId, scope, {
      columns: [I.reportedByMembershipId, I.triagedByMembershipId],
      membershipId: ownMembershipId,
    }),
    olderThan(I.occurredAt, I.id, cursor),
  );
  return where as SQL;
}

const MORTALITY_STORED_STATUSES = {
  created: ["pending"],
  in_progress: ["in_progress", "overdue"],
  completed: ["completed"],
} as const;

export function mortalityListWhere(
  organizationId: string,
  filter: MortalityListFilter,
  scope: QualityPatientScope,
  cursor: ListCursor | undefined,
  ownMembershipId?: string,
): SQL {
  const where = and(
    eq(M.organizationId, organizationId),
    filter.patientId ? eq(M.deceasedPatientId, filter.patientId) : undefined,
    filter.status ? inArray(M.status, [...MORTALITY_STORED_STATUSES[filter.status]]) : undefined,
    patientScopeCondition(M.deceasedPatientId, scope, {
      columns: [M.assignedReviewerMembershipId],
      membershipId: ownMembershipId,
    }),
    olderThan(M.deathAt, M.id, cursor),
  );
  return where as SQL;
}

export function infectionEventListWhere(
  organizationId: string,
  filter: InfectionEventFilter,
  scope: QualityPatientScope,
  cursor: ListCursor | undefined,
): SQL {
  const after = dateOrUndef(filter.observedAfter);
  const before = dateOrUndef(filter.observedBefore);
  const where = and(
    eq(E.organizationId, organizationId),
    filter.patientId ? eq(E.patientId, filter.patientId) : undefined,
    filter.pathogen ? eq(E.pathogen, filter.pathogen) : undefined,
    after ? gte(E.observedAt, after) : undefined,
    before ? lte(E.observedAt, before) : undefined,
    patientScopeCondition(E.patientId, scope),
    olderThan(E.observedAt, E.id, cursor),
  );
  return where as SQL;
}

/** Decode the opaque cursor into its keyset; a malformed cursor is a 400, never "page from the start". */
export function toListCursor(cursor: string | undefined): ListCursor | undefined {
  if (!cursor) return undefined;
  const key = decodeCursor(cursor);
  const at = new Date(key.createdAt);
  if (Number.isNaN(at.getTime())) {
    throw new ChartWardenError("VALIDATION_FAILED", "the cursor is malformed", 400);
  }
  return { at, id: key.id };
}

/** Trim the `size + 1` probe row off a fetched page; its presence is what makes `hasMore` exact. */
export function splitPage<T>(rows: readonly T[], size: number): { page: T[]; hasMore: boolean } {
  return { page: rows.slice(0, size), hasMore: rows.length > size };
}

export async function fetchIncidentPage(
  tx: QualityDb,
  organizationId: string,
  filter: IncidentListFilter,
  scope: QualityPatientScope,
  cursor: ListCursor | undefined,
  size: number,
  ownMembershipId?: string,
): Promise<{ page: schema.IncidentReport[]; hasMore: boolean }> {
  const rows = await tx
    .select()
    .from(I)
    .where(incidentListWhere(organizationId, filter, scope, cursor, ownMembershipId))
    .orderBy(desc(I.occurredAt), desc(I.id))
    .limit(size + 1);
  return splitPage(rows, size);
}

export async function fetchMortalityPage(
  tx: QualityDb,
  organizationId: string,
  filter: MortalityListFilter,
  scope: QualityPatientScope,
  cursor: ListCursor | undefined,
  size: number,
  ownMembershipId?: string,
): Promise<{ page: schema.MortalityReview[]; hasMore: boolean }> {
  const rows = await tx
    .select()
    .from(M)
    .where(mortalityListWhere(organizationId, filter, scope, cursor, ownMembershipId))
    .orderBy(desc(M.deathAt), desc(M.id))
    .limit(size + 1);
  return splitPage(rows, size);
}

export async function fetchInfectionEventPage(
  tx: QualityDb,
  organizationId: string,
  filter: InfectionEventFilter,
  scope: QualityPatientScope,
  cursor: ListCursor | undefined,
  size: number,
): Promise<{ page: schema.InfectionSurveillanceEvent[]; hasMore: boolean }> {
  const rows = await tx
    .select()
    .from(E)
    .where(infectionEventListWhere(organizationId, filter, scope, cursor))
    .orderBy(desc(E.observedAt), desc(E.id))
    .limit(size + 1);
  return splitPage(rows, size);
}

/** Project a fetched page onto a {@link CursorPage}, minting `nextCursor` from the last row's keyset. */
export function toKeysetPage<R, V>(
  fetched: { readonly page: readonly R[]; readonly hasMore: boolean },
  keyOf: (row: R) => { readonly at: Date; readonly id: string },
  map: (row: R) => V,
): CursorPage<V> {
  const last = fetched.page[fetched.page.length - 1];
  const nextCursor =
    fetched.hasMore && last
      ? encodeCursor({ createdAt: keyOf(last).at.toISOString(), id: keyOf(last).id })
      : null;
  return { items: fetched.page.map(map), nextCursor, hasMore: fetched.hasMore };
}
