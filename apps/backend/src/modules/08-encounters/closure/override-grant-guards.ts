// apps/backend/src/modules/08-encounters/closure/override-grant-guards.ts — who may lift whose closure block (ADR-0113 D7).
//
// Refusals asked of a GRANT, in this order, on the grant's own transaction so RLS scopes every read:
//   1. NOTE_CLOSURE_GRANTOR_BLOCKED (403)      the granting supervisor has a note past its block instant, ANY override they hold ignored.
//                                              Grant and revoke are on the gate's allowlist, so without this two blocked supervisors could
//                                              release each other, and two supervisors who each hold the other's override (so neither is
//                                              "blocked" any more) could keep releasing each other for ever without closing a note. Only a
//                                              supervisor who is genuinely clear (nothing past its deadline) may release others.
//   2. NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE (403) the clinician's oldest open note (the one that decides the block) is outside the grantor's
//                                              locations, by the same predicate the overdue board uses (a note with no location is in scope
//                                              for every supervisor). Decided on that note's location whether or not it is blocked yet,
//                                              and BEFORE the blocked question, so a site-scoped supervisor cannot learn whether a clinician
//                                              outside their sites is blocked. Org-wide roles see every site.
//   3. NOTE_CLOSURE_SUBJECT_NOT_BLOCKED (409)  the clinician is not blocked (no open note, clear, warn-only, or already overridden):
//                                              nothing to lift, and a stray grant would pre-authorize a future block.
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

const OUT_OF_SCOPE_MESSAGE = "That clinician's note is outside your sites.";
const REVOKE_OUT_OF_SCOPE_MESSAGE =
  "Only the supervisor who granted this override, or one who covers every site, can revoke it.";

/** Throws the first of the three refusals that applies; returns when the grant may proceed. */
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
  const oldestOpenNote = subject.encounterId;
  if (oldestOpenNote === null) throw subjectNotBlocked();
  if (!(await noteInScope(tx, organizationId, oldestOpenNote, input.locationIds))) {
    throw new ChartWardenError(
      NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE_CODE,
      OUT_OF_SCOPE_MESSAGE,
      HTTP_FORBIDDEN,
    );
  }
  if (subject.verdict !== "blocked") throw subjectNotBlocked();
}

function subjectNotBlocked(): ChartWardenError {
  return new ChartWardenError(
    NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE,
    "This clinician is not blocked right now, so there is nothing to lift.",
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
