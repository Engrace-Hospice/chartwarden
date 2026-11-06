// apps/backend/src/modules/35-subscription/pricing/staff-meter.ts — the ACTIVE STAFF ACCOUNT meter (slice 2, tenant pricing).
//
// DEFINITION. For an organisation and a calendar month (UTC), an active staff account is a distinct USER who
//   (1) SIGNED IN to the organisation during the month: the pseudonymized `user_active_period` ledger holds a `was_active` row for the
//       month under the user's membership. The ledger is written by M35's `m2.session.created` consumer, and that event fires at ONE
//       place only, `POST /api/v1/auth/select-organization`: the moment a STAFF session binds to an organisation through a membership.
//       So a family / patient / bereaved PORTAL session (a portal account, no membership), an auditor magic-link session (minted already
//       bound), and a ChartWarden SUPPORT session (M34 `support_session`, platform side) never write the ledger at all;
//   (2) held a MEMBERSHIP of the organisation that was live at some point in the month: accepted before the month ended and not revoked
//       before it began (`membership.accepted_at` / `revoked_at`). A pending, never-accepted invitation is not an account;
//   (3) is NOT excluded: the membership holds neither the organisation's `external_auditor` role (an auditor given a membership for an
//       engagement) nor any PLATFORM-OWNED role (`role.organization_id IS NULL` with a reserved `platform_*` key: ChartWarden operators
//       are bound into a tenant organisation by `platform_alert_audience` purely so alerts reach them). Any grant counts, expired or not.
// Two memberships of one user in one month (a revoked one and its replacement) count once.
//
// HOW. The ledger stores only `HMAC(key, membership_id)`, never an id (M35 D6), and cannot say what role a membership holds. So the
// organisation's candidate memberships are read here (explicit columns, under the platform credential's column grants), the
// excluded ones are dropped, and each survivor's pseudonym is recomputed under the ledger's key epoch and matched to the ledger.
// Raw ids live in this function's memory only.
//
// CEILING (flagged, like the patient census): the ledger can be matched only under the ACTIVE key epoch. If the month's newest ledger epoch
// is no longer the active one (a key rotation since), the roles cannot be applied and the count falls back to the UNFILTERED ledger
// (`ledger_unfiltered`), which the statement records so an operator sees it.
import { isReservedPlatformRoleKey } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import {
  type PseudonymKeyProvider,
  computeBillingPseudonym,
  toBillingYearMonth,
} from "@chartwarden/subscription-billing";
import { and, eq, gt, inArray, isNotNull, isNull, lt, max, or } from "drizzle-orm";

const UAP = schema.userActivePeriod;
const MB = schema.memberships;
const MR = schema.membershipRoles;
const RL = schema.roles;

/** The org-owned role an auditor's membership holds for the length of an engagement (M3 `auditor-access-grant.ts`). */
export const EXTERNAL_AUDITOR_ROLE_KEY = "external_auditor";

export type StaffCountBasis = "identity_filtered" | "ledger_unfiltered";
export interface StaffCount {
  readonly count: number;
  readonly basis: StaffCountBasis;
}

export interface MonthWindow {
  readonly start: Date;
  readonly end: Date;
}

/** True for a role grant that makes its holder something other than tenant staff. */
export function isNonStaffRole(role: {
  readonly key: string;
  readonly organizationId: string | null;
}): boolean {
  if (role.organizationId === null) return isReservedPlatformRoleKey(role.key);
  return role.key === EXTERNAL_AUDITOR_ROLE_KEY;
}

export async function countActiveStaffForMonth(
  tx: DbClient,
  keyProvider: PseudonymKeyProvider,
  organizationId: string,
  window: MonthWindow,
): Promise<StaffCount> {
  const period = toBillingYearMonth(window.start);
  const ledgerScope = and(
    eq(UAP.organizationId, organizationId),
    eq(UAP.periodYearMonth, period),
    eq(UAP.wasActive, true),
  );
  const [newest] = await tx
    .select({ epoch: max(UAP.pseudonymKeyEpoch) })
    .from(UAP)
    .where(ledgerScope);
  if (!newest?.epoch) return { count: 0, basis: "identity_filtered" };
  const ledgerRows = await tx
    .select({ pseudonym: UAP.membershipPseudonym })
    .from(UAP)
    .where(and(ledgerScope, eq(UAP.pseudonymKeyEpoch, newest.epoch)));
  const signedIn = new Set(ledgerRows.map((r) => r.pseudonym));

  const key = await keyProvider.activeKey();
  if (key.keyEpoch !== newest.epoch) return { count: signedIn.size, basis: "ledger_unfiltered" };

  // Memberships live at some point in the month.
  const candidates = await tx
    .select({ id: MB.id, userId: MB.userId })
    .from(MB)
    .where(
      and(
        eq(MB.organizationId, organizationId),
        isNotNull(MB.acceptedAt),
        lt(MB.acceptedAt, window.end),
        or(isNull(MB.revokedAt), gt(MB.revokedAt, window.start)),
      ),
    );
  if (candidates.length === 0) return { count: 0, basis: "identity_filtered" };

  // Every role grant of those memberships, expired or not: any non-staff grant excludes the membership.
  const grants = await tx
    .select({ membershipId: MR.membershipId, key: RL.key, roleOrganizationId: RL.organizationId })
    .from(MR)
    .innerJoin(RL, eq(MR.roleId, RL.id))
    .where(
      and(
        eq(MR.organizationId, organizationId),
        inArray(
          MR.membershipId,
          candidates.map((c) => c.id),
        ),
      ),
    );
  const excluded = new Set(
    grants
      .filter((g) => isNonStaffRole({ key: g.key, organizationId: g.roleOrganizationId }))
      .map((g) => g.membershipId),
  );

  const staffUsers = new Set<string>();
  for (const candidate of candidates) {
    if (excluded.has(candidate.id)) continue;
    if (signedIn.has(computeBillingPseudonym(key.keyMaterial, candidate.id))) {
      staffUsers.add(candidate.userId);
    }
  }
  return { count: staffUsers.size, basis: "identity_filtered" };
}
