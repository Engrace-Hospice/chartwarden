// apps/backend/src/modules/08-encounters/closure/override-lookup.ts — reading closure overrides (ADR-0113 D7).
//
// The read half of the override table, split from override-service.ts so the evaluator (closure-reader.ts) and the grant guards can
// both import it without a cycle: the service imports the evaluator to decide who may be released, and the evaluator needs "is there
// an active override" for its own verdict. override-service.ts re-exports everything here, so callers keep one import path.
import { type DbClient, schema } from "@chartwarden/db";
import type { DocumentationObligationKind } from "@chartwarden/types";
import { and, desc, eq, isNull, ne } from "drizzle-orm";

const O = schema.documentationObligationOverrides;

/** A grant as the routes and the gate see it. The free-text reason is deliberately absent. */
export interface ClosureOverrideView {
  readonly id: string;
  readonly subjectMembershipId: string;
  readonly grantedByMembershipId: string;
  readonly obligationKind: DocumentationObligationKind;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export const closureOverrideViewColumns = {
  id: O.id,
  subjectMembershipId: O.subjectMembershipId,
  grantedByMembershipId: O.grantedByMembershipId,
  obligationKind: O.obligationKind,
  grantedAt: O.grantedAt,
  expiresAt: O.expiresAt,
  revokedAt: O.revokedAt,
};

/** The ONE definition of "active": not revoked, and `asOf` is strictly before `expires_at`. SQL only narrows to unrevoked rows. */
export function isOverrideActive(
  override: Pick<ClosureOverrideView, "expiresAt" | "revokedAt">,
  asOf: Date,
): boolean {
  return override.revokedAt === null && asOf.getTime() < override.expiresAt.getTime();
}

/**
 * The clinician's active override for `kind` at `asOf`, or null. SQL returns the unrevoked grant that expires last (the
 * `documentation_obligation_override_active_idx` partial index); {@link isOverrideActive} decides whether it still counts.
 */
export async function findActiveOverride(
  tx: DbClient,
  organizationId: string,
  membershipId: string,
  kind: DocumentationObligationKind,
  asOf: Date,
): Promise<ClosureOverrideView | null> {
  const [latest] = await tx
    .select(closureOverrideViewColumns)
    .from(O)
    .where(
      and(
        eq(O.organizationId, organizationId),
        eq(O.subjectMembershipId, membershipId),
        eq(O.obligationKind, kind),
        isNull(O.revokedAt),
      ),
    )
    .orderBy(desc(O.expiresAt))
    .limit(1);
  return latest && isOverrideActive(latest, asOf) ? latest : null;
}

/**
 * When the clinician is still lifted AFTER `exceptOverrideId` is out of the picture: the latest expiry of any OTHER unrevoked grant
 * for the same clinician and kind that is still active at `asOf`, or null. Revoking one grant does not re-block a clinician another
 * supervisor has also released (the gate honours any active grant), so a revoke reports this to its caller.
 */
export async function remainingActiveUntil(
  tx: DbClient,
  scope: {
    readonly organizationId: string;
    readonly subjectMembershipId: string;
    readonly obligationKind: DocumentationObligationKind;
    readonly exceptOverrideId: string;
  },
  asOf: Date,
): Promise<Date | null> {
  const [latest] = await tx
    .select({ expiresAt: O.expiresAt, revokedAt: O.revokedAt })
    .from(O)
    .where(
      and(
        eq(O.organizationId, scope.organizationId),
        eq(O.subjectMembershipId, scope.subjectMembershipId),
        eq(O.obligationKind, scope.obligationKind),
        ne(O.id, scope.exceptOverrideId),
        isNull(O.revokedAt),
      ),
    )
    .orderBy(desc(O.expiresAt))
    .limit(1);
  return latest && isOverrideActive(latest, asOf) ? latest.expiresAt : null;
}
