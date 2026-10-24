// M36 WP 6.7 (ADR-0099 D3, D8, D18) - may family access run on this deployment? Two conditions, both fail closed:
//   1. The per-address budgets must be keyed on a REAL client address: NODE_ENV development/test, or a VALID TRUSTED_PROXY_CIDRS (the ADR-0096 D17 rule,
//      read through the same function so the two features can never disagree about it).
//   2. The code pepper must be present (>= 32 characters). The 8-digit code is hashed under it, held OUTSIDE the database, so a stolen row alone cannot be
//      brute-forced offline (D3). Without it nothing can be issued or verified, so the contact routes are not mounted and creating an invitation answers 503.
import { partnerAccessAvailability } from "../external-share/external-share-proxy";

/** The environment variable that holds the per-deployment code pepper. */
export const FAMILY_CODE_PEPPER_ENV = "MESSAGING_FAMILY_CODE_PEPPER";
export const FAMILY_CODE_PEPPER_MIN_LENGTH = 32;

export interface FamilyAccessAvailability {
  readonly available: boolean;
  /** The pepper to hash codes under; null when unavailable. Never logged. */
  readonly pepper: string | null;
  /** One boot warning line when unavailable; null otherwise. Names the missing setting; contains no secret. */
  readonly warning: string | null;
}

export function familyAccessAvailability(env: {
  readonly NODE_ENV?: string | undefined;
  readonly TRUSTED_PROXY_CIDRS?: string | undefined;
  readonly MESSAGING_FAMILY_CODE_PEPPER?: string | undefined;
}): FamilyAccessAvailability {
  const proxy = partnerAccessAvailability(env);
  const pepper = env.MESSAGING_FAMILY_CODE_PEPPER?.trim() ?? "";
  const reasons: string[] = [];
  if (!proxy.available) reasons.push("TRUSTED_PROXY_CIDRS is unset or invalid (per-address budgets need a real client address)");
  if (pepper.length < FAMILY_CODE_PEPPER_MIN_LENGTH) {
    reasons.push(`${FAMILY_CODE_PEPPER_ENV} is unset or shorter than ${FAMILY_CODE_PEPPER_MIN_LENGTH} characters`);
  }
  if (reasons.length > 0) {
    return {
      available: false,
      pepper: null,
      warning: `M36 family messaging is DISABLED: ${reasons.join("; ")}. The family contact routes are not mounted and creating an invitation answers FAMILY_ACCESS_UNAVAILABLE (503).`,
    };
  }
  return { available: true, pepper, warning: null };
}
