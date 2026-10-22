// apps/backend/src/modules/02-identity/staff-names.ts - the identity directory's by-id display-name lookup, published to other modules as a
// port bound at the composition root (apps/backend/src/index.ts). M2 owns the membership/user read; a consumer (M36 governance: "placed by",
// redaction requester and approver) declares the matching port structurally and never reads `user` or `membership` itself.
//
// Tenant-safe by construction: a name resolves only for a user who has (or had) a membership in THIS organisation, so an id from another
// tenant, or a made-up one, is simply absent from the result. Names only: never an email, username or status. Runs in the caller's tenant
// transaction (RLS on membership still applies; the org filter is explicit as well).
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray } from "drizzle-orm";

const MEMBERSHIP = schema.memberships;
const USER = schema.users;

/** Most ids resolved per call: a governance list page is far below it. */
export const STAFF_NAME_LOOKUP_LIMIT = 500;

export type StaffNameReader = (
  tx: DbClient,
  organizationId: string,
  userIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

export const readStaffNames: StaffNameReader = async (tx, organizationId, userIds) => {
  const ids = [...new Set(userIds)].slice(0, STAFF_NAME_LOOKUP_LIMIT);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .selectDistinct({ userId: MEMBERSHIP.userId, name: USER.name })
    .from(MEMBERSHIP)
    .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
    .where(and(eq(MEMBERSHIP.organizationId, organizationId), inArray(MEMBERSHIP.userId, ids)));
  const names = new Map<string, string>();
  for (const row of rows) {
    const name = row.name?.trim();
    if (name) names.set(row.userId, name);
  }
  return names;
};
