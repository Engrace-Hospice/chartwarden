// apps/backend/src/modules/02-identity/membership-display-for-org.ts — the org-explicit, BATCHED
// minimum-necessary staff display read other modules' screens need when a row carries only a
// `membership_id` (M14's finalized-minutes "Finalized by", and any later "recorded by" surface).
//
// It lives in M2's directory because `membership` (M1) / `user` are identity's rows; the consumer gets it
// injected as a locally-declared PORT at the composition root (apps/backend/src/index.ts) and imports no
// identity code or schema — the `patientDisplayLabelsForOrg` (M5) / `idgRecertWindowsForOrg` (M6) shape.
//
// MINIMUM NECESSARY: the staff member's display NAME only. No email, no user id, no role, no login
// history. A membership whose user has no display name resolves to `null` (the caller renders its own
// fallback) rather than leaking the email address as a label.
//
// Deliberately NO `status = 'active'` filter: a finalized record attributed to a since-revoked staff
// member must still name who signed it. RLS (`app.org_id`) is the wall; the explicit `organization_id`
// predicate is the belt behind it, so an unknown / cross-tenant membership id is simply ABSENT from the
// result. ONE query for the whole id set, never N+1.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray } from "drizzle-orm";

const MB = schema.memberships;
const U = schema.users;

/** A read with no acting human (the `SEAM_SYSTEM_USER_ID` convention — the M4 audit trigger maps "" to NULL). */
const MEMBERSHIP_DISPLAY_SYSTEM_USER_ID = "";

/** A membership id list this long is a caller bug (a meeting has dozens of people, not thousands). */
export const MEMBERSHIP_DISPLAY_MAX_IDS = 500;

/** The minimum-necessary display projection for one staff membership. */
export interface MembershipDisplayLabel {
  readonly membershipId: string;
  /** The staff member's display name, or null when the user has none on file. */
  readonly displayName: string | null;
}

/** Pure projection (unit-testable without a DB): trims, and treats a blank name as absent. */
export function toMembershipDisplayLabel(row: {
  readonly membershipId: string;
  readonly name: string | null;
}): MembershipDisplayLabel {
  const name = row.name?.trim() ?? "";
  return { membershipId: row.membershipId, displayName: name.length > 0 ? name : null };
}

/**
 * Resolve display labels for a set of membership ids in ONE query. Ids unknown in `organizationId` (or
 * belonging to another tenant) are omitted from the result map. Empty input performs no query.
 */
export async function membershipDisplayForOrg(
  db: DbClient,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, MembershipDisplayLabel>> {
  const ids = [...new Set(membershipIds)];
  if (ids.length === 0) return new Map();
  if (ids.length > MEMBERSHIP_DISPLAY_MAX_IDS) {
    throw new Error(
      `membershipDisplayForOrg: ${ids.length} ids exceeds the ${MEMBERSHIP_DISPLAY_MAX_IDS} cap`,
    );
  }
  const rows = await withOrgContext(
    db,
    { organizationId, userId: MEMBERSHIP_DISPLAY_SYSTEM_USER_ID },
    (tx) =>
      tx
        .select({ membershipId: MB.id, name: U.name })
        .from(MB)
        .innerJoin(U, eq(U.id, MB.userId))
        .where(and(eq(MB.organizationId, organizationId), inArray(MB.id, ids))),
  );
  return new Map(
    rows.map((r) => [
      r.membershipId,
      toMembershipDisplayLabel({ membershipId: r.membershipId, name: r.name }),
    ]),
  );
}
