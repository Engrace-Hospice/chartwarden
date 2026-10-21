// @chartwarden/auth · identity — the server-side MFA matrix (M2 §2.3 "MFA required", Security Hardening §5.1.2,
// HIPAA 164.312(d); GAP-003 / GAP-005).
//
// WHAT WAS MISSING. Better Auth's `twoFactor()` plugin only CHALLENGES a user who has already enrolled; nothing
// required enrolment, so any staff member could sign in with a password alone, bind an organization and reach
// PHI. The matrix below is the policy; the enforcement points (select-organization, the authenticate hook, the
// `two-factor/disable` guard) live in the backend and call these pure functions.
//
// THE MATRIX. Every staff role is a clinical or administrative role, so a second factor (TOTP or a passkey) is
// required of every staff member who holds at least one live role. `org_admin` and `platform_ops` additionally
// require a PASSKEY (phishing-resistant). A membership with no live role confers no access and requires nothing
// (it cannot reach PHI; requiring enrolment of someone who can do nothing would only add friction).
//
// Auditor, collaborator, funeral-home, portal and vendor sessions are NOT staff sessions: they carry their own
// stage-gated enrolment (auditor, M2 §7.7) or are link-bound and pinned to one patient. {@link
// sessionClassRequiresMfa} scopes the matrix to the staff class.

/** Role keys whose holders must have a passkey enrolled (Security Hardening §5.1.2). */
export const PASSKEY_REQUIRED_ROLE_KEYS: ReadonlySet<string> = new Set([
  "org_admin",
  "platform_ops",
]);

export type MfaRequirement = "none" | "second_factor" | "passkey";

/** What the user has enrolled, verified and usable. */
export interface MfaFactorState {
  readonly totp: boolean;
  readonly passkey: boolean;
}

/** The decision for one user in one role set. */
export interface MfaVerdict {
  readonly requirement: MfaRequirement;
  readonly satisfied: boolean;
}

/** The session classes the matrix governs. Only interactive staff sessions are; see the file header. */
export function sessionClassRequiresMfa(sessionClass: string | null | undefined): boolean {
  return sessionClass === undefined || sessionClass === null || sessionClass === "staff";
}

/** The strongest requirement any of `roleKeys` imposes. */
export function mfaRequirementFor(roleKeys: readonly string[]): MfaRequirement {
  if (roleKeys.length === 0) return "none";
  return roleKeys.some((key) => PASSKEY_REQUIRED_ROLE_KEYS.has(key)) ? "passkey" : "second_factor";
}

/** Whether `factors` satisfies `requirement`. */
export function mfaSatisfied(requirement: MfaRequirement, factors: MfaFactorState): boolean {
  switch (requirement) {
    case "none":
      return true;
    case "second_factor":
      return factors.totp || factors.passkey;
    case "passkey":
      return factors.passkey;
  }
}

/** Evaluate the matrix for a role set against the user's enrolled factors. */
export function evaluateMfa(roleKeys: readonly string[], factors: MfaFactorState): MfaVerdict {
  const requirement = mfaRequirementFor(roleKeys);
  return { requirement, satisfied: mfaSatisfied(requirement, factors) };
}

/**
 * Whether the server enforces the matrix. OPT-IN: only `WARDENX_MFA_ENFORCEMENT=true` turns it on, in every
 * environment, production included.
 *
 * Why not strict-by-default in production: refusing a staff session until a factor is enrolled needs an in-app
 * enrolment path, and apps/web has a passkey page but no TOTP enrolment screen and does not yet react to
 * `403 MFA_ENROLMENT_REQUIRED`. Defaulting ON would lock every existing staff user (the first org_admin, who needs a
 * passkey, included) out of a deploy with no way to enrol. Roll out by enrolling the existing users first, then set
 * the variable. Flip this default back to strict once the enrolment UI ships.
 */
export function resolveMfaEnforcement(env: {
  readonly WARDENX_MFA_ENFORCEMENT?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}): boolean {
  return env.WARDENX_MFA_ENFORCEMENT === "true";
}
