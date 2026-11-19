// apps/backend/src/modules/08-encounters/closure/override-grant-guards.ts — who may lift whose closure block (ADR-0113 D7).
//
// Refusals asked of a GRANT, in this order, on the grant's own transaction so RLS scopes every read:
//   1. NOTE_CLOSURE_GRANTOR_BLOCKED (403)      the granting supervisor has a note past its BLOCK INSTANT, ANY override they hold ignored.
//                                              Grant and revoke are on the gate's allowlist, so without this two blocked supervisors could
//                                              release each other, and two supervisors who each hold the other's override (so neither is
//                                              "blocked" any more) could keep releasing each other for ever without closing a note. A
//                                              supervisor whose note is past its deadline but not yet past its block instant (the grace
//                                              window after `block` was enabled) may still release others.
//   2. NOTE_CLOSURE_SUBJECT_NOT_BLOCKED (409)  nothing for THIS caller to lift, ONE answer for three states: the clinician has no open
//                                              clocked note, or their oldest open note (the one that decides the block) is outside the
//                                              grantor's locations (the board's predicate: a note with no location is in scope for every
//                                              supervisor; org-wide roles see every site), or they are not blocked (clear, warn-only, or
//                                              already overridden). Identical code, status and message in all three, so a site-scoped
//                                              supervisor cannot learn whether a clinician outside their sites has an open note or is
//                                              blocked. A stray grant would also pre-authorize a future block.
// A REVOKE has one refusal: NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE (403) unless the caller granted that override or covers every site. A blocked
// supervisor can still revoke what they granted (revoke stays on the allowlist).
// The verdicts come from the ONE evaluator the gate, the banner and the board share, so "blocked" means the same thing here.
import { type DbClient, schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { evaluateMemberClosure } from "./closure-reader";
import { closureLocationScope } from "./overdue-board";

export const NOTE_CLOSURE_GRANTOR_BLOCKED_CODE = "NOTE_CLOSURE_GRANTOR_BLOCKED";
export const NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE = "NOTE_CLOSURE_SUBJECT_NOT_BLOCKED";
export const NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE_CODE = "NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE";

const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const E = schema.encounters;

export interface GrantGuardInput {
  readonly organizationId: string;
  readonly subjectMembershipId: string;
  readonly grantedByMembershipId: string;
  /** The grantor's location scope, as the board reads it: `null` = org-wide; otherwise their sites (empty = none). */
  readonly locationIds: readonly string[] | null;
  readonly now: Date;
}

/** True when the encounter is inside the caller's scope (the board's predicate); an org-wide caller needs no query. */
async function noteInScope(
  tx: DbClient,
  organizationId: string,
  encounterId: string,
  locationIds: readonly string[] | null,
): Promise<boolean> {
  const scope = closureLocationScope(locationIds);
  if (scope === undefined) return true;
  const [row] = await tx
    .select({ id: E.id })
    .from(E)
    .where(and(eq(E.organizationId, organizationId), eq(E.id, encounterId), scope))
    .limit(1);
  return row !== undefined;
}

/** The one sentence for every grant that has nothing to lift for THIS caller (no open note, outside their sites, or not blocked). */
export const NOTHING_TO_LIFT_MESSAGE =
  "There is nothing for you to lift for this clinician right now.";
const REVOKE_OUT_OF_SCOPE_MESSAGE =
  "Only the supervisor who granted this override, or one who covers every site, can revoke it.";

/** Throws the first of the two refusals that applies (the grantor's own block, then "nothing to lift"); returns when the grant may proceed. */
export async function assertGrantAllowed(tx: DbClient, input: GrantGuardInput): Promise<void> {
  const { organizationId, now } = input;
  const grantor = await evaluateMemberClosure(tx, {
    organizationId,
    membershipId: input.grantedByMembershipId,
    now,
    // the grantor's OWN position: an override someone else holds for them does not make them fit to release others
    ignoreOverrides: true,
  });
  if (grantor.verdict === "blocked") {
    throw new ChartWardenError(
      NOTE_CLOSURE_GRANTOR_BLOCKED_CODE,
      "Close your own overdue notes before releasing someone else.",
      HTTP_FORBIDDEN,
    );
  }
  const subject = await evaluateMemberClosure(tx, {
    organizationId,
    membershipId: input.subjectMembershipId,
    now,
  });
  // ONE refusal for "no open note", "the oldest note is outside the grantor's sites" and "not blocked": the answer is the same whatever
  // the clinician's state, so a site-scoped supervisor cannot probe whether a clinician outside their sites has an open note or is
  // blocked. Only a clinician who is blocked AND in scope can be released.
  const oldestOpenNote = subject.encounterId;
  if (oldestOpenNote === null) throw nothingToLift();
  if (!(await noteInScope(tx, organizationId, oldestOpenNote, input.locationIds))) {
    throw nothingToLift();
  }
  if (subject.verdict !== "blocked") throw nothingToLift();
}

function nothingToLift(): ChartWardenError {
  return new ChartWardenError(
    NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE,
    NOTHING_TO_LIFT_MESSAGE,
    HTTP_CONFLICT,
  );
}

export interface RevokeGuardInput {
  readonly grantedByMembershipId: string;
  readonly revokedByMembershipId: string;
  /** The revoker's location scope, as the board reads it: `null` = org-wide; otherwise their sites. */
  readonly locationIds: readonly string[] | null;
}

/**
 * A revoke is allowed for the supervisor who granted the override, and for a caller whose scope is org-wide (every site). A site-scoped
 * supervisor cannot lift another supervisor's release of a clinician they may not even see.
 */
export function assertMayRevoke(input: RevokeGuardInput): void {
  if (input.locationIds === null) return;
  if (input.grantedByMembershipId === input.revokedByMembershipId) return;
  throw new ChartWardenError(
    NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE_CODE,
    REVOKE_OUT_OF_SCOPE_MESSAGE,
    HTTP_FORBIDDEN,
  );
}
