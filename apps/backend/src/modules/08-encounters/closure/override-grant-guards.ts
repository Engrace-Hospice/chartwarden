// apps/backend/src/modules/08-encounters/closure/override-grant-guards.ts — who may lift whose closure block (ADR-0113 D8).
//
// Three refusals, asked in this order of a grant, on the grant's own transaction so RLS scopes every read:
//   1. NOTE_CLOSURE_GRANTOR_BLOCKED (403)      the supervisor who is granting is themselves blocked right now. Grant and revoke are on the
//                                              gate's allowlist, so without this two blocked supervisors could release each other and
//                                              nobody would have closed anything. A grantor who is clear or overridden may grant.
//   2. NOTE_CLOSURE_SUBJECT_NOT_BLOCKED (409)  the clinician is not blocked (clear, warn-only, or already overridden): nothing to lift,
//                                              and a stray grant would pre-authorize a future block.
//   3. NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE (403) the clinician's oldest open note (the one that decides the block) is outside the grantor's
//                                              locations, by the same predicate the overdue board uses (a note with no location is in
//                                              scope for every supervisor). Org-wide roles see every site.
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

/** Throws the first of the three refusals that applies; returns when the grant may proceed. */
export async function assertGrantAllowed(tx: DbClient, input: GrantGuardInput): Promise<void> {
  const { organizationId, now } = input;
  const grantor = await evaluateMemberClosure(tx, {
    organizationId,
    membershipId: input.grantedByMembershipId,
    now,
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
  if (subject.verdict !== "blocked" || subject.encounterId === null) {
    throw new ChartWardenError(
      NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE,
      "This clinician is not blocked right now, so there is nothing to lift.",
      HTTP_CONFLICT,
    );
  }
  if (!(await noteInScope(tx, organizationId, subject.encounterId, input.locationIds))) {
    throw new ChartWardenError(
      NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE_CODE,
      "That clinician's note is outside your sites.",
      HTTP_FORBIDDEN,
    );
  }
}
