// apps/backend/src/modules/08-encounters/closure/overdue-board.ts — the supervisor's overdue-notes board (ADR-0113).
//
// The org's (or the supervisor's sites') clocked open notes that are at risk, overdue or escalated, oldest first. As in the
// closure reader, SQL only narrows to open notes that have been running long enough to matter and the pure clock stages every
// row: a row the clock still calls `ok` is dropped, so the board can never disagree with the alerts or the gate. Policy `off`
// lists nothing (the engine is disabled for the tenant).
//
// LOCATION SCOPE. A site-scoped supervisor sees the notes at their sites AND the notes that have no site at all (a seeded draft
// whose visit carries no location): the escalation alert falls back to the org-wide supervisors for such a note, so the board and
// the override grant must not hide it from a scoped supervisor either. `closureLocationScope` is the ONE predicate; the override
// grant (override-service.ts) asks the same question of the blocked clinician's oldest note.
import { type DbClient, schema } from "@chartwarden/db";
import { type SQL, and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  AT_RISK_LEAD_HOURS,
  type NoteClosureMode,
  type NoteClosureStage,
  decideNoteClosure,
} from "./note-clock";
import { OPEN_NOTE_STATUS_LIST_SQL } from "./open-status";
import type { ClosurePolicy } from "./policy-service";

const MS_PER_HOUR = 3_600_000;
const E = schema.encounters;

export interface OverdueNoteItem {
  readonly encounterId: string;
  readonly authoredByMembershipId: string;
  readonly patientId: string;
  readonly encounterType: string;
  readonly discipline: string;
  readonly serviceDate: string;
  readonly status: string;
  readonly clockStartedAt: string;
  readonly deadlineAt: string;
  readonly stage: Exclude<NoteClosureStage, "ok">;
  readonly hoursOverdue: number;
}

export interface OverdueBoard {
  readonly mode: NoteClosureMode;
  readonly thresholdHours: number;
  readonly items: readonly OverdueNoteItem[];
  /** More rows matched than `limit`; the oldest `limit` are returned. */
  readonly truncated: boolean;
}

export interface ListOverdueNotesInput {
  readonly organizationId: string;
  readonly policy: ClosurePolicy;
  readonly now: Date;
  /** 1..N; the caller clamps. */
  readonly limit: number;
  /** `null` = org-wide scope; otherwise the encounters at these locations plus those with no location (an empty list sees nothing). */
  readonly locationIds: readonly string[] | null;
}

function emptyBoard(policy: ClosurePolicy): OverdueBoard {
  return { mode: policy.mode, thresholdHours: policy.thresholdHours, items: [], truncated: false };
}

/**
 * The location predicate for a caller's scope. `null` = org-wide (no predicate). A scoped caller matches their locations OR a note
 * with no location; an empty scope matches nothing (fail closed).
 */
export function closureLocationScope(locationIds: readonly string[] | null): SQL | undefined {
  if (locationIds === null) return undefined;
  if (locationIds.length === 0) return sql`false`;
  return or(inArray(E.locationId, [...locationIds]), isNull(E.locationId));
}

/** The earliest clock start that can already be at risk: `now - (threshold - lead)`. Uses the clock's own lead constant. */
function atRiskCutoff(now: Date, thresholdHours: number): Date {
  return new Date(now.getTime() - (thresholdHours - AT_RISK_LEAD_HOURS) * MS_PER_HOUR);
}

/** At-risk, overdue and escalated clocked open notes in scope, oldest first. */
export async function listOverdueNotes(
  tx: DbClient,
  input: ListOverdueNotesInput,
): Promise<OverdueBoard> {
  const { organizationId, policy, now, limit, locationIds } = input;
  if (policy.mode === "off") return emptyBoard(policy);
  if (locationIds !== null && locationIds.length === 0) return emptyBoard(policy);

  const rows = await tx
    .select({
      encounterId: E.id,
      authoredByMembershipId: E.authoredByMembershipId,
      patientId: E.patientId,
      encounterType: E.encounterType,
      discipline: E.discipline,
      serviceDate: E.serviceDate,
      status: E.status,
      clockStartedAt: E.clockStartedAt,
    })
    .from(E)
    .where(
      and(
        eq(E.organizationId, organizationId),
        // A literal list (not bind parameters) so the planner can prove the partial-index predicate.
        sql`${E.status} IN ${OPEN_NOTE_STATUS_LIST_SQL}`,
        isNotNull(E.clockStartedAt),
        lte(E.clockStartedAt, atRiskCutoff(now, policy.thresholdHours)),
        closureLocationScope(locationIds),
      ),
    )
    .orderBy(asc(E.clockStartedAt), asc(E.id))
    .limit(limit + 1);

  const items: OverdueNoteItem[] = [];
  for (const row of rows.slice(0, limit)) {
    const decision = decideNoteClosure({
      clockStartedAt: row.clockStartedAt,
      asOf: now,
      thresholdHours: policy.thresholdHours,
      enforceFrom: policy.enforceFrom,
    });
    if (decision.stage === "ok" || decision.deadlineAt === null || row.clockStartedAt === null)
      continue;
    items.push({
      encounterId: row.encounterId,
      authoredByMembershipId: row.authoredByMembershipId,
      patientId: row.patientId,
      encounterType: row.encounterType,
      discipline: row.discipline,
      serviceDate: row.serviceDate,
      status: row.status,
      clockStartedAt: row.clockStartedAt.toISOString(),
      deadlineAt: decision.deadlineAt.toISOString(),
      stage: decision.stage,
      hoursOverdue: decision.hoursOverdue,
    });
  }
  return {
    mode: policy.mode,
    thresholdHours: policy.thresholdHours,
    items,
    truncated: rows.length > limit,
  };
}
