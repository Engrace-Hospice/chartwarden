// apps/backend/src/modules/02-identity/mfa-enrolment-gate.ts — the server-side MFA matrix gate (M2 §2.3,
// GAP-003 / GAP-005). Policy is the pure `evaluateMfa` in @wardenx/auth; this is its composition: which roles a
// user holds (M3's `membershipRoleKeysForOrg`, injected as a port - M2 may not read M3's tables) against which
// factors they have enrolled (the M2 `MfaEnrollmentReader`).
//
// Used at three enforcement points:
//   - `select-organization`      refuse to bind an org while the matrix is unmet (403 MFA_ENROLMENT_REQUIRED);
//   - the authenticate hook      holds an ALREADY-bound session at the enrolment stage (a role granted later, a
//                                factor removed), allowing only /api/auth/* and /api/v1/auth/*;
//   - `two-factor/disable`       refused while any held role requires a second factor.
// Disabled (`enforced: false`) it answers "satisfied" without reading anything: the dev/test default (see
// `resolveMfaEnforcement`).
import { type MfaVerdict, evaluateMfa } from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import { withUserContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { sql } from "drizzle-orm";
import type { MfaEnrollmentReader } from "./step-up-ports";

const SATISFIED: MfaVerdict = { requirement: "none", satisfied: true };
/** A satisfied verdict is cached this long per user; an UNsatisfied one is never cached. */
export const MFA_SATISFIED_CACHE_TTL_MS = 30_000;

export interface MembershipRef {
  readonly organizationId: string;
  readonly membershipId: string;
}

export interface MfaEnrolmentGateDeps {
  readonly enforced: boolean;
  readonly factors: MfaEnrollmentReader;
  /** M3's role keys for one membership (live roles only); injected at the composition root. */
  readonly roleKeysForMembership: (ref: MembershipRef) => Promise<readonly string[]>;
  /** The user's ACTIVE memberships, for the cross-org `two-factor/disable` check. */
  readonly activeMembershipsOf: (userId: string) => Promise<readonly MembershipRef[]>;
  readonly now?: () => number;
}

export interface MfaEnrolmentGate {
  readonly enforced: boolean;
  /** The verdict for a request's resolved role set (the authenticate hook; roles are already resolved there). */
  forRoles(input: { userId: string; roleKeys: readonly string[] }): Promise<MfaVerdict>;
  /** The verdict for one membership (select-organization, before the org is bound). */
  forMembership(input: { userId: string } & MembershipRef): Promise<MfaVerdict>;
  /**
   * Would the matrix still be met across ALL of the user's active memberships if their authenticator (TOTP) were
   * removed? `satisfied: false` means the removal must be refused (the `two-factor/disable` guard).
   */
  forUserWithoutTotp(userId: string): Promise<MfaVerdict>;
}

/** 403 raised when the matrix is unmet. The requirement is in the message so the UI can route to the right enrolment. */
export const mfaEnrolmentRequired = (requirement: string): WardenXError =>
  new WardenXError(
    "MFA_ENROLMENT_REQUIRED",
    requirement === "passkey"
      ? "register a passkey before continuing (required for your role)"
      : "enrol an authenticator app or passkey before continuing (required for your role)",
    403,
  );

export function createMfaEnrolmentGate(deps: MfaEnrolmentGateDeps): MfaEnrolmentGate {
  const now = deps.now ?? Date.now;
  const satisfiedUntil = new Map<string, number>();

  const factorsOf = async (userId: string) => ({
    totp: await deps.factors.hasFactor({ userId, factor: "totp" }),
    passkey: await deps.factors.hasFactor({ userId, factor: "webauthn" }),
  });

  const passkeyOf = (userId: string) =>
    Promise.resolve(deps.factors.hasFactor({ userId, factor: "webauthn" }));

  const verdictFor = async (userId: string, roleKeys: readonly string[]): Promise<MfaVerdict> => {
    if (!deps.enforced) return SATISFIED;
    const requirementOnly = evaluateMfa(roleKeys, { totp: false, passkey: false });
    if (requirementOnly.requirement === "none") return SATISFIED;
    // The cache key carries the requirement: a user who satisfied "second_factor" has not satisfied "passkey".
    const cacheKey = `${userId}:${requirementOnly.requirement}`;
    if ((satisfiedUntil.get(cacheKey) ?? 0) > now()) {
      return { requirement: requirementOnly.requirement, satisfied: true };
    }
    const verdict = evaluateMfa(roleKeys, await factorsOf(userId));
    if (verdict.satisfied) satisfiedUntil.set(cacheKey, now() + MFA_SATISFIED_CACHE_TTL_MS);
    return verdict;
  };

  return {
    enforced: deps.enforced,
    forRoles: ({ userId, roleKeys }) => verdictFor(userId, roleKeys),
    async forMembership({ userId, organizationId, membershipId }) {
      if (!deps.enforced) return SATISFIED;
      return verdictFor(userId, await deps.roleKeysForMembership({ organizationId, membershipId }));
    },
    async forUserWithoutTotp(userId) {
      if (!deps.enforced) return SATISFIED;
      const memberships = await deps.activeMembershipsOf(userId);
      const roleKeys = (
        await Promise.all(memberships.map((m) => deps.roleKeysForMembership(m)))
      ).flat();
      const requirement = evaluateMfa(roleKeys, { totp: false, passkey: false }).requirement;
      if (requirement === "none") return SATISFIED;
      // Not cached: removal is rare and must see the factor state as of now.
      return evaluateMfa(roleKeys, { totp: false, passkey: await passkeyOf(userId) });
    },
  };
}

/**
 * The user's ACTIVE memberships across orgs. `membership` is RLS-scoped on `app.org_id`, so the pre-org read goes
 * through the same `m2_list_own_memberships` SECURITY DEFINER function (migration 0231) the membership picker uses.
 */
export function createDbActiveMembershipLister(
  db: DbClient,
): MfaEnrolmentGateDeps["activeMembershipsOf"] {
  return async (userId) =>
    withUserContext<DbClient, readonly MembershipRef[]>(db, { userId }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT membership_id, organization_id, status FROM m2_list_own_memberships(${userId}::uuid)`,
      );
      const rows =
        (
          result as unknown as {
            rows?: { membership_id: string; organization_id: string; status: string }[];
          }
        ).rows ?? [];
      return rows
        .filter((row) => row.status === "active")
        .map((row) => ({ organizationId: row.organization_id, membershipId: row.membership_id }));
    });
}
