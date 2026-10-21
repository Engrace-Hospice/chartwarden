// apps/backend/src/modules/02-identity/mfa-enrolment-gate.ts — the server-side MFA matrix gate (M2 §2.3,
// GAP-003 / GAP-005). Policy is the pure `evaluateMfa` in @chartwarden/auth; this is its composition: which roles a
// user holds (M3's `membershipRoleKeysForOrg`, injected as a port - M2 may not read M3's tables) against which
// factors they have enrolled (the M2 `MfaEnrollmentReader`).
//
// Used at three enforcement points:
//   - `select-organization`      refuse to bind an org while the matrix is unmet (403 MFA_ENROLMENT_REQUIRED);
//   - the authenticate hook      holds an ALREADY-bound session at the enrolment stage (a role granted later, a
//                                factor removed), allowing only /api/auth/* and /api/v1/auth/*;
//   - `two-factor/disable`       refused while any held role requires a second factor.
// The matrix tests ASSURANCE, not just enrolment: the session must have proved the factor at sign-in
// (`sessionProvedFactor`), else a passkey-only user would pass on a password-only session.
// Disabled (`enforced: false`) it answers "satisfied" without reading anything: the dev/test default (see
// `resolveMfaEnforcement`).
import { type MfaVerdict, evaluateMfa } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { withUserContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import type { MfaEnrollmentReader } from "./step-up-ports";

/** Why a verdict is unsatisfied: no usable factor enrolled, or enrolled but not proven by THIS session. */
export type MfaDenialReason = "not_enrolled" | "not_verified";
export type GateVerdict = MfaVerdict & { readonly reason?: MfaDenialReason };

const SATISFIED: GateVerdict = { requirement: "none", satisfied: true };
/** A satisfied verdict is cached this long per user; an UNsatisfied one is never cached. */
export const MFA_SATISFIED_CACHE_TTL_MS = 30_000;

export interface MembershipRef {
  readonly organizationId: string;
  readonly membershipId: string;
}

export interface MfaEnrolmentGateDeps {
  readonly enforced: boolean;
  readonly factors: MfaEnrollmentReader;
  /**
   * The second factor THIS session proved at sign-in (`session.last_step_up_factor`, written by the auth bridge
   * after a verified TOTP / passkey / backup-code ceremony), or null for a password-only session. Enrolment alone
   * is not assurance: Better Auth only challenges TOTP users, so a passkey-only user signs in on a password.
   */
  readonly sessionProvedFactor: (sessionId: string) => Promise<string | null>;
  /** M3's role keys for one membership (live roles only); injected at the composition root. */
  readonly roleKeysForMembership: (ref: MembershipRef) => Promise<readonly string[]>;
  /** The user's ACTIVE memberships, for the cross-org `two-factor/disable` check. */
  readonly activeMembershipsOf: (userId: string) => Promise<readonly MembershipRef[]>;
  readonly now?: () => number;
}

export interface MfaEnrolmentGate {
  readonly enforced: boolean;
  /** The verdict for a request's resolved role set (the authenticate hook; roles are already resolved there). */
  forRoles(input: {
    userId: string;
    sessionId: string;
    roleKeys: readonly string[];
  }): Promise<GateVerdict>;
  /** The verdict for one membership (select-organization, before the org is bound). */
  forMembership(input: { userId: string; sessionId: string } & MembershipRef): Promise<GateVerdict>;
  /**
   * Would the matrix still be met across ALL of the user's active memberships if their authenticator (TOTP) were
   * removed? `satisfied: false` means the removal must be refused (the `two-factor/disable` guard).
   */
  forUserWithoutTotp(userId: string): Promise<MfaVerdict>;
}

/** 403 raised when the matrix is unmet. The requirement is in the message so the UI can route to the right enrolment. */
export const mfaEnrolmentRequired = (requirement: string, reason?: string): ChartWardenError =>
  new ChartWardenError("MFA_ENROLMENT_REQUIRED", mfaDenialMessage(requirement, reason), 403);

/** The user-facing sentence for a denial; shared with the authenticate-stage hold. */
export function mfaDenialMessage(requirement: string, reason?: string): string {
  if (reason === "not_verified")
    return requirement === "passkey"
      ? "sign in again with your passkey before continuing (required for your role)"
      : "sign in again with your authenticator app or passkey before continuing (required for your role)";
  return requirement === "passkey"
    ? "register a passkey before continuing (required for your role)"
    : "enrol an authenticator app or passkey before continuing (required for your role)";
}

/** Does the factor a session proved meet the requirement? A passkey requirement needs a passkey ceremony. */
function assuranceMet(requirement: string, provedFactor: string | null): boolean {
  if (requirement === "passkey") return provedFactor === "webauthn";
  return provedFactor === "totp" || provedFactor === "webauthn";
}

export function createMfaEnrolmentGate(deps: MfaEnrolmentGateDeps): MfaEnrolmentGate {
  const now = deps.now ?? Date.now;
  const satisfiedUntil = new Map<string, number>();

  const factorsOf = async (userId: string) => ({
    totp: await deps.factors.hasFactor({ userId, factor: "totp" }),
    passkey: await deps.factors.hasFactor({ userId, factor: "webauthn" }),
  });

  const passkeyOf = (userId: string) =>
    Promise.resolve(deps.factors.hasFactor({ userId, factor: "webauthn" }));

  const verdictFor = async (
    userId: string,
    sessionId: string,
    roleKeys: readonly string[],
  ): Promise<GateVerdict> => {
    if (!deps.enforced) return SATISFIED;
    const requirementOnly = evaluateMfa(roleKeys, { totp: false, passkey: false });
    if (requirementOnly.requirement === "none") return SATISFIED;
    const requirement = requirementOnly.requirement;
    // The cache key carries the session and the requirement: assurance is per session, and a user who satisfied
    // "second_factor" has not satisfied "passkey".
    const cacheKey = `${userId}:${sessionId}:${requirement}`;
    if ((satisfiedUntil.get(cacheKey) ?? 0) > now()) return { requirement, satisfied: true };
    const enrolled = evaluateMfa(roleKeys, await factorsOf(userId));
    if (!enrolled.satisfied) return { ...enrolled, reason: "not_enrolled" };
    if (!assuranceMet(requirement, await deps.sessionProvedFactor(sessionId)))
      return { requirement, satisfied: false, reason: "not_verified" };
    satisfiedUntil.set(cacheKey, now() + MFA_SATISFIED_CACHE_TTL_MS);
    return enrolled;
  };

  return {
    enforced: deps.enforced,
    forRoles: ({ userId, sessionId, roleKeys }) => verdictFor(userId, sessionId, roleKeys),
    async forMembership({ userId, sessionId, organizationId, membershipId }) {
      if (!deps.enforced) return SATISFIED;
      return verdictFor(
        userId,
        sessionId,
        await deps.roleKeysForMembership({ organizationId, membershipId }),
      );
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
