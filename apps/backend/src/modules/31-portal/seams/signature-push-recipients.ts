// M31 ADR-0107 D7 - who is told (by push) that a signature request is waiting, read from M31's own tables. Org-explicit and run under
// `withOrgContext` (an outbox consumer is not a request). Two reads, both injected where the other side needs them:
//   * `signatureRecipientUserIds`  - the users whose LIVE grant for the patient may sign this document kind (the authority matrix, not a copy of it)
//                                    AND who have a verified push device (migration 1309's reader). A person with no device is not pushed:
//                                    a delivery planned to nobody would only settle `failed` and raise noise.
//   * `activePortalUserIds`        - of a set of user ids, the ones with an ACTIVE portal account in the org (M36's recipient filter asks this
//                                    through a port, because portal accounts hold no membership and M36 may not read M31's tables)
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type PortalSigningGrantKind, decideSigningAuthority } from "../portal-signing-authority";

const ACCOUNT = schema.portalAccounts;
const GRANT = schema.portalAccessGrants;
const REQUEST = schema.portalSignatureRequests;

const SYSTEM_READER = "";

export async function signatureRecipientUserIds(
  db: DbClient,
  organizationId: string,
  patientId: string,
  docKind: schema.PortalSignatureDocKind,
): Promise<readonly string[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_READER }, async (tx) => {
    const rows = await (tx as DbClient)
      .select({ userId: ACCOUNT.userId, grantKind: GRANT.grantKind })
      .from(GRANT)
      .innerJoin(ACCOUNT, eq(ACCOUNT.id, GRANT.portalAccountId))
      .where(
        and(
          eq(GRANT.organizationId, organizationId),
          eq(GRANT.patientId, patientId),
          isNull(GRANT.revokedAt),
          eq(ACCOUNT.organizationId, organizationId),
          eq(ACCOUNT.status, "active"),
        ),
      );
    const eligible = [
      ...new Set(
        rows
          .filter(
            (r) =>
              decideSigningAuthority({ grantKind: r.grantKind as PortalSigningGrantKind, docKind })
                .allowed,
          )
          .map((r) => r.userId),
      ),
    ];
    if (eligible.length === 0) return [];
    const withDevice = await (tx as DbClient).execute<{ user_id: string }>(sql`
      SELECT user_id FROM delivery_endpoint_verified_push_for_portal_users(
        ${organizationId}, ${JSON.stringify(eligible)}::jsonb)
    `);
    const reachable = new Set(withDevice.rows.map((r) => r.user_id));
    return eligible.filter((id) => reachable.has(id));
  });
}

export async function activePortalUserIds(
  db: DbClient,
  organizationId: string,
  userIds: readonly string[],
): Promise<readonly string[]> {
  if (userIds.length === 0) return [];
  return withOrgContext(db, { organizationId, userId: SYSTEM_READER }, async (tx) => {
    const rows = await (tx as DbClient)
      .selectDistinct({ userId: ACCOUNT.userId })
      .from(ACCOUNT)
      .where(
        and(
          eq(ACCOUNT.organizationId, organizationId),
          eq(ACCOUNT.status, "active"),
          inArray(ACCOUNT.userId, [...userIds]),
        ),
      );
    return rows.map((r) => r.userId);
  });
}

/** True while the request is still waiting for the person: a signed, parked or withdrawn request is never pushed about. */
export async function signatureRequestStillPending(
  db: DbClient,
  organizationId: string,
  requestId: string,
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_READER }, async (tx) => {
    const [row] = await (tx as DbClient)
      .select({ status: REQUEST.status })
      .from(REQUEST)
      .where(eq(REQUEST.id, requestId))
      .limit(1);
    return row?.status === "pending";
  });
}
