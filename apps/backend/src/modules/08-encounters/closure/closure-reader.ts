// apps/backend/src/modules/08-encounters/closure/closure-reader.ts — the ONE evaluator of "where does this clinician stand on the
// visit-note closure clock" (ADR-0113). The request-time gate, GET /closure-status and the supervisor board all call it, so the
// answer cannot differ between them.
//
// SQL only finds the member's CLOCKED OPEN notes, oldest first, through the partial index `encounter_open_clock_idx`
// (organization_id, authored_by_membership_id, clock_started_at WHERE status IN ('draft','finalized') AND clock_started_at IS NOT
// NULL). The pure functions in note-clock.ts decide every stage, deadline and verdict, so the SQL and the rule cannot drift: there
// is no overdue predicate in the query. A note with no clock (a legacy draft, no backfill) is never selected, so it never alerts
// and never blocks. The override lookup runs ONLY when a block is actually in play.
import { type DbClient, schema } from "@chartwarden/db";
import type { DocumentationObligationKind } from "@chartwarden/types";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  type ClosureVerdict,
  type NoteClosureDecision,
  type NoteClosureMode,
  closureVerdict,
  decideNoteClosure,
} from "./note-clock";
import { findActiveOverride } from "./override-service";
import { type ClosurePolicy, readClosurePolicy } from "./policy-service";

/** Slice 1 evaluates one obligation kind. */
const VISIT_NOTE: DocumentationObligationKind = "visit_note";

/**
 * How many open notes one evaluation reads. A clinician with more open notes than this reports `OPEN_NOTE_SCAN_LIMIT` overdue
 * at most; the verdict never depends on it, because the oldest note (always row 0) decides.
 * ponytail: raise the cap, or add a COUNT(*) FILTER, only if a real tenant carries a backlog this deep.
 */
export const OPEN_NOTE_SCAN_LIMIT = 100;

const E = schema.encounters;

/** One clocked open note as SQL returns it. */
export interface ClockedOpenNote {
  readonly id: string;
  readonly clockStartedAt: Date | null;
}

export interface MemberClosureEvaluation {
  readonly mode: NoteClosureMode;
  readonly thresholdHours: number;
  readonly verdict: ClosureVerdict;
  /** The oldest clocked open note's decision; the no-clock decision (stage ok, null instants) when there is none. */
  readonly decision: NoteClosureDecision;
  /** The oldest clocked open note, or null. */
  readonly encounterId: string | null;
  /** Clocked open notes past their deadline (stage overdue or escalated), capped at {@link OPEN_NOTE_SCAN_LIMIT}. */
  readonly overdueCount: number;
  /** When a supervisor override is lifting the block right now, its expiry; otherwise null. */
  readonly overrideExpiresAt: Date | null;
}

export interface EvaluateMemberClosureInput {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly now: Date;
  /** The caller's already-resolved policy (the gate passes its cached one); read from the database when absent. */
  readonly policy?: ClosurePolicy;
}

function isPastDeadline(decision: NoteClosureDecision): boolean {
  return decision.stage === "overdue" || decision.stage === "escalated";
}

function decide(
  clockStartedAt: Date | null,
  policy: ClosurePolicy,
  now: Date,
): NoteClosureDecision {
  return decideNoteClosure({
    clockStartedAt,
    asOf: now,
    thresholdHours: policy.thresholdHours,
    enforceFrom: policy.enforceFrom,
  });
}

/** The pure half: given the member's clocked open notes (oldest first), the oldest decides and every note past its deadline counts. */
export function evaluateOpenNotes(
  notes: readonly ClockedOpenNote[],
  policy: ClosurePolicy,
  now: Date,
): { decision: NoteClosureDecision; encounterId: string | null; overdueCount: number } {
  const clocked = notes.filter((n) => n.clockStartedAt !== null);
  const oldest = clocked[0];
  const overdueCount = clocked.filter((n) =>
    isPastDeadline(decide(n.clockStartedAt, policy, now)),
  ).length;
  return {
    decision: decide(oldest?.clockStartedAt ?? null, policy, now),
    encounterId: oldest?.id ?? null,
    overdueCount,
  };
}

async function loadClockedOpenNotes(
  tx: DbClient,
  organizationId: string,
  membershipId: string,
): Promise<readonly ClockedOpenNote[]> {
  return tx
    .select({ id: E.id, clockStartedAt: E.clockStartedAt })
    .from(E)
    .where(
      and(
        eq(E.organizationId, organizationId),
        eq(E.authoredByMembershipId, membershipId),
        // A literal list (not bind parameters) so the planner can prove the partial-index predicate.
        sql`${E.status} IN ('draft', 'finalized')`,
        isNotNull(E.clockStartedAt),
      ),
    )
    .orderBy(asc(E.clockStartedAt), asc(E.id))
    .limit(OPEN_NOTE_SCAN_LIMIT);
}

const CLEAR_WITHOUT_NOTES = (policy: ClosurePolicy, now: Date): MemberClosureEvaluation => ({
  mode: policy.mode,
  thresholdHours: policy.thresholdHours,
  verdict: "clear",
  decision: decide(null, policy, now),
  encounterId: null,
  overdueCount: 0,
  overrideExpiresAt: null,
});

/**
 * Where one clinician stands on the visit-note clock at `now`. Mode `off` answers clear without reading any note. Otherwise one
 * indexed query reads the clinician's clocked open notes, the pure clock decides, and the override table is consulted only when
 * the mode is `block` and the oldest note is past its deadline.
 */
export async function evaluateMemberClosure(
  tx: DbClient,
  input: EvaluateMemberClosureInput,
): Promise<MemberClosureEvaluation> {
  const { organizationId, membershipId, now } = input;
  const policy = input.policy ?? (await readClosurePolicy(tx, organizationId, VISIT_NOTE));
  if (policy.mode === "off") return CLEAR_WITHOUT_NOTES(policy, now);

  const notes = await loadClockedOpenNotes(tx, organizationId, membershipId);
  const { decision, encounterId, overdueCount } = evaluateOpenNotes(notes, policy, now);
  const override =
    policy.mode === "block" && isPastDeadline(decision)
      ? await findActiveOverride(tx, organizationId, membershipId, VISIT_NOTE, now)
      : null;
  return {
    mode: policy.mode,
    thresholdHours: policy.thresholdHours,
    verdict: closureVerdict(policy.mode, decision, override !== null, now),
    decision,
    encounterId,
    overdueCount,
    overrideExpiresAt: override?.expiresAt ?? null,
  };
}
