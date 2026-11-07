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
//   (3) is NOT excluded: the ledger row was not flagged `non_staff_observed`. That flag is written when each sign-in is OBSERVED (the
//       `m2.session.created` consumer reads the membership's grants at that moment) and is true only when every sign-in of the month was
//       by a membership whose grants were ALL non-staff: the organisation's SYSTEM `external_auditor` role or a PLATFORM-OWNED role
//       (ChartWarden operators are bound into a tenant organisation by `platform_alert_audience` purely so alerts reach them). A
//       membership that also holds any staff role is staff, and one staff sign-in makes the month staff. The exclusion is therefore
//       decided by what the member WAS when they signed in, never by today's grants: a tenant administrator who swaps a member who
//       worked as staff to auditor-only (in the month, or in the grace window before it finalizes) cannot take them off the bill.
//       "The system auditor role" is the row M3's auditor grant creates: org-owned, key AND category `external_auditor`, and
//       `system_default`; a tenant cannot create a role under that key (M3 refuses it, and so does the database), so it cannot attach a
//       look-alike to staff either. An expired grant counts.
// Two memberships of one user in one month (a revoked one and its replacement) count once.
//
// HOW. The ledger stores only `HMAC(key, membership_id)`, never an id (M35 D6). The organisation's candidate memberships are read here
// (explicit columns, under the platform credential's column grants), each one's pseudonym is recomputed under the ledger's key epoch
// and matched to the unflagged ledger rows, and a user with two memberships counts once. Raw ids live in this function's memory only.
//
// CEILING (flagged, like the patient census): memberships can be matched to the ledger only under the ACTIVE key epoch, and only when
// the month's ledger holds ONE epoch. If it spans more than one key epoch (a rotation mid-month: a member who signed in before and after
// it has a different pseudonym under each key, so identities cannot be told apart across epochs), or its one epoch is no longer the
// active one, the count falls back to the UNMATCHED ledger (`ledger_unfiltered`): the busiest SINGLE epoch's distinct unflagged
// pseudonyms (never the sum, which would count a rotated member twice; users are not deduplicated and liveness is not checked, but an
// observed auditor or operator is still left out). The statement records the basis and is flagged `needs_review`.
import { EXTERNAL_AUDITOR_ROLE_KEY, isReservedPlatformRoleKey } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import {
  type PseudonymKeyProvider,
  computeBillingPseudonym,
  toBillingYearMonth,
} from "@chartwarden/subscription-billing";
import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { MonthWindow } from "./statement-period";

const UAP = schema.userActivePeriod;
const MB = schema.memberships;
export { EXTERNAL_AUDITOR_ROLE_KEY };
/** The `role_category` M3's auditor grant stamps on that role (a tenant may also pick this category for its own role). */
const EXTERNAL_AUDITOR_ROLE_CATEGORY = "external_auditor";

export type StaffCountBasis = "identity_filtered" | "ledger_unfiltered";
export interface StaffCount {
  readonly count: number;
  readonly basis: StaffCountBasis;
}

export interface RoleFacts {
  readonly key: string;
  readonly organizationId: string | null;
  readonly category: string;
  readonly systemDefault: boolean;
}

/** True for a role grant that makes its holder something other than tenant staff (the system auditor role, a platform-owned role). */
export function isNonStaffRole(role: RoleFacts): boolean {
  if (role.organizationId === null) return isReservedPlatformRoleKey(role.key);
  return (
    role.key === EXTERNAL_AUDITOR_ROLE_KEY &&
    role.category === EXTERNAL_AUDITOR_ROLE_CATEGORY &&
    role.systemDefault
  );
}

/** The memberships whose EVERY grant is non-staff: one staff grant (or none at all) keeps a membership counted. */
export function nonStaffMembershipIds(
  grants: readonly (RoleFacts & { readonly membershipId: string })[],
): ReadonlySet<string> {
  const onlyNonStaff = new Map<string, boolean>();
  for (const grant of grants) {
    onlyNonStaff.set(
      grant.membershipId,
      (onlyNonStaff.get(grant.membershipId) ?? true) && isNonStaffRole(grant),
    );
  }
  return new Set([...onlyNonStaff].filter(([, only]) => only).map(([id]) => id));
}

/** The month's ledger: the distinct pseudonyms that signed in as STAFF (not flagged non-staff at sign-in), per key epoch. */
async function readStaffLedgerByEpoch(
  tx: DbClient,
  organizationId: string,
  window: MonthWindow,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const rows = await tx
    .select({
      epoch: UAP.pseudonymKeyEpoch,
      pseudonym: UAP.membershipPseudonym,
      nonStaff: UAP.nonStaffObserved,
    })
    .from(UAP)
    .where(
      and(
        eq(UAP.organizationId, organizationId),
        eq(UAP.periodYearMonth, toBillingYearMonth(window.start)),
        eq(UAP.wasActive, true),
      ),
    );
  const byEpoch = new Map<string, Set<string>>();
  for (const row of rows) {
    const staff = byEpoch.get(row.epoch) ?? new Set<string>();
    if (!row.nonStaff) staff.add(row.pseudonym);
    byEpoch.set(row.epoch, staff);
  }
  return byEpoch;
}

/** Memberships that were live at some point in the month: accepted before it ended and not revoked before it began. */
function liveMemberships(tx: DbClient, organizationId: string, window: MonthWindow) {
  return tx
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
}

export async function countActiveStaffForMonth(
  tx: DbClient,
  keyProvider: PseudonymKeyProvider,
  organizationId: string,
  window: MonthWindow,
): Promise<StaffCount> {
  const byEpoch = await readStaffLedgerByEpoch(tx, organizationId, window);
  if (byEpoch.size === 0) return { count: 0, basis: "identity_filtered" };
  const key = await keyProvider.activeKey();
  const [onlyEpoch] = byEpoch.size === 1 ? [...byEpoch.keys()] : [undefined];
  if (onlyEpoch === undefined || key.keyEpoch !== onlyEpoch) {
    const busiest = Math.max(...[...byEpoch.values()].map((pseudonyms) => pseudonyms.size));
    return { count: busiest, basis: "ledger_unfiltered" };
  }
  const signedInAsStaff = byEpoch.get(onlyEpoch) ?? new Set<string>();
  const staffUsers = new Set<string>();
  for (const candidate of await liveMemberships(tx, organizationId, window)) {
    if (signedInAsStaff.has(computeBillingPseudonym(key.keyMaterial, candidate.id))) {
      staffUsers.add(candidate.userId);
    }
  }
  return { count: staffUsers.size, basis: "identity_filtered" };
}
