// apps/backend/src/modules/08-encounters/closure/overdue-board.ts — the supervisor's overdue-notes board (ADR-0113).
//
// The org's (or the supervisor's sites') clocked open notes that are at risk, overdue or escalated, oldest first. As in the
// closure reader, SQL only narrows to open notes that have been running long enough to matter and the pure clock stages every
// row: a row the clock still calls `ok` is dropped, so the board can never disagree with the alerts or the gate. Policy `off`
// lists nothing (the engine is disabled for the tenant).
import { type DbClient, schema } from "@chartwarden/db";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  AT_RISK_LEAD_HOURS,
  type NoteClosureMode,
  type NoteClosureStage,
  decideNoteClosure,
} from "./note-clock";
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
  /** `null` = org-wide scope; otherwise only encounters at these locations (an empty list sees nothing). */
  readonly locationIds: readonly string[] | null;
}

function emptyBoard(policy: ClosurePolicy): OverdueBoard {
  return { mode: policy.mode, thresholdHours: policy.thresholdHours, items: [], truncated: false };
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
        sql`${E.status} IN ('draft', 'finalized')`,
        isNotNull(E.clockStartedAt),
        lte(E.clockStartedAt, atRiskCutoff(now, policy.thresholdHours)),
        locationIds === null ? undefined : inArray(E.locationId, [...locationIds]),
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
