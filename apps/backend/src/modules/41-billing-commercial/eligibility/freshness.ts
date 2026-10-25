// apps/backend/src/modules/41-billing-commercial/eligibility/freshness.ts - is the latest eligibility check good enough to bill on?
//
// PURE: no IO, no clock (the caller passes `now`), no member id anywhere. Claim assembly (#722) calls this with the plan's policy
// and the latest check it read, and turns the finding into a validation result (rule id, severity, evidence - ADR-0100 D9).
//
//   missing                     -> the plan's policy severity (warn => warning, block => block)
//   older than maxAgeDays       -> the plan's policy severity
//   fresh, payer said inactive  -> block, whatever the policy (the payer answered "not covered"; staleness is not the question)
//   fresh, unknown              -> the plan's policy severity (an answer we could not read is not an answer)
//   fresh, active               -> pass
// A timestamp that cannot be read is treated as stale: fail closed, never pass.
import {
  COMMERCIAL_ELIGIBILITY_FRESHNESS_RULE_ID,
  type CommercialEligibilityOutcome,
  type CommercialEligibilityStalenessPolicy,
  MAX_ELIGIBILITY_MAX_AGE_DAYS,
} from "@chartwarden/types";

const MS_PER_DAY = 86_400_000;

export interface LatestEligibilityCheck {
  readonly outcome: CommercialEligibilityOutcome;
  /** ISO timestamp the check was made. */
  readonly checkedAt: string;
}

export interface EligibilityFreshnessInput {
  readonly latest: LatestEligibilityCheck | null;
  readonly policy: CommercialEligibilityStalenessPolicy;
  /** Whole days, 1..365. */
  readonly maxAgeDays: number;
  /** ISO timestamp of "now"; injected so the function stays pure. */
  readonly now: string;
}

export type EligibilityFreshnessStatus = "fresh" | "stale" | "missing" | "inactive" | "unverified";
export type EligibilityFreshnessSeverity = "pass" | "warning" | "block";

export interface EligibilityFreshnessFinding {
  readonly ruleId: typeof COMMERCIAL_ELIGIBILITY_FRESHNESS_RULE_ID;
  readonly status: EligibilityFreshnessStatus;
  readonly severity: EligibilityFreshnessSeverity;
  /** User-facing, says what to do next. */
  readonly message: string;
  /** Values only about the check, never about the member. */
  readonly evidence: {
    readonly ageDays: number | null;
    readonly maxAgeDays: number;
    readonly policy: CommercialEligibilityStalenessPolicy;
    readonly outcome: CommercialEligibilityOutcome | null;
    readonly checkedAt: string | null;
  };
}

export function evaluateEligibilityFreshness(
  input: EligibilityFreshnessInput,
): EligibilityFreshnessFinding {
  const { latest, policy, maxAgeDays } = input;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > MAX_ELIGIBILITY_MAX_AGE_DAYS) {
    throw new RangeError(`maxAgeDays must be a whole number from 1 to ${MAX_ELIGIBILITY_MAX_AGE_DAYS}`);
  }
  const policySeverity: EligibilityFreshnessSeverity = policy === "block" ? "block" : "warning";
  const finding = (
    status: EligibilityFreshnessStatus,
    severity: EligibilityFreshnessSeverity,
    message: string,
    ageDays: number | null,
  ): EligibilityFreshnessFinding => ({
    ruleId: COMMERCIAL_ELIGIBILITY_FRESHNESS_RULE_ID,
    status,
    severity,
    message,
    evidence: {
      ageDays,
      maxAgeDays,
      policy,
      outcome: latest?.outcome ?? null,
      checkedAt: latest?.checkedAt ?? null,
    },
  });

  if (!latest) {
    return finding(
      "missing",
      policySeverity,
      "No eligibility check is on file for this patient and plan. Run an eligibility check before billing.",
      null,
    );
  }
  const checkedMs = Date.parse(latest.checkedAt);
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(checkedMs) || Number.isNaN(nowMs)) {
    return finding(
      "stale",
      policySeverity,
      "The eligibility check's date could not be read. Run a new eligibility check before billing.",
      null,
    );
  }
  const ageDays = Math.max(0, Math.floor((nowMs - checkedMs) / MS_PER_DAY));
  if (ageDays > maxAgeDays) {
    return finding(
      "stale",
      policySeverity,
      `The last eligibility check is ${ageDays} days old (limit ${maxAgeDays}). Run a new eligibility check before billing.`,
      ageDays,
    );
  }
  if (latest.outcome === "inactive") {
    return finding(
      "inactive",
      "block",
      "The payer reported this coverage as not active. Confirm coverage with the payer before billing.",
      ageDays,
    );
  }
  if (latest.outcome === "unknown") {
    return finding(
      "unverified",
      policySeverity,
      "The last eligibility response could not be read as active or inactive. Run a new eligibility check or confirm with the payer.",
      ageDays,
    );
  }
  return finding("fresh", "pass", "Eligibility was verified recently.", ageDays);
}
