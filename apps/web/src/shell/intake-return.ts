const REFERRAL_ID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const INTAKE_RETURN = new RegExp(`^/referrals/(${REFERRAL_ID})/intake\\?step=(receive|verify)$`);

export type IntakeDocumentStep = "receive" | "verify";

/** A PHI-free, same-origin return target for a referral's guided intake workspace. */
export function intakeWorkspaceReturnTo(
  referralId: string,
  step: IntakeDocumentStep = "receive",
): string {
  return `/referrals/${encodeURIComponent(referralId)}/intake?step=${step}`;
}

/** Add a return target to an M22 route without letting it become part of that route's authority. */
export function withIntakeReturnTo(path: string, returnTo?: string | null): string {
  if (!returnTo) return path;
  const params = new URLSearchParams({ returnTo });
  return `${path}?${params.toString()}`;
}

/**
 * Accept only the two referral-workspace destinations this flow creates. This is intentionally
 * narrower than a generic same-origin guard: a document link must never become an open redirect.
 */
export function safeIntakeReturnTo(value: string | null): string | null {
  if (!value || value.includes("\\") || value.includes("//")) return null;
  return INTAKE_RETURN.test(value) ? value : null;
}
