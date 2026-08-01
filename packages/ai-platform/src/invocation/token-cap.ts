// @wardenx/ai-platform — §3.2.9 / D6 / D7 / W2 token budget rules (M32-T04).
//
// The hard cap is the one gate that refuses a call for a reason unrelated to safety or consent, so D7
// pins exactly how it must feel to a clinician: "hard cap forces capability fallback to Layer-1, never
// user-facing error". Nothing here throws and nothing here is an exception path — a breached cap is a
// VALUE the invocation pipeline reads and turns into the same `available: false` envelope every other
// gate produces.
//
// ── THE WINDOW IS THE PARTITION IS THE BILLING PERIOD ──────────────────────────────────────────────
//
// `ai_token_ledger` is partitioned monthly on `accrued_at` (§3.8), the budget is monthly (§1.1), and
// the cap window is the same calendar month in UTC. That is not a coincidence to be preserved by
// convention — it is why "this tenant's spend this month" reads exactly one partition. A window that
// drifted from the partition boundary (a rolling 30 days, a tenant-local month) would make every cap
// evaluation a two-partition scan on the hot path of every AI call.
//
// UTC, not the org's timezone, for the same reason: the partition bounds are UTC, and an agency in
// Hawaii whose month started ten hours "late" would have a cap window straddling two partitions for
// ten hours of every month.
//
// ── FOUR STATES, NOT THREE ─────────────────────────────────────────────────────────────────────────
//
// `budget_unconfigured` is distinct from `hard_breached` and the distinction is load-bearing. The spec
// states a soft ratio (80%) and states that the budget lives on M2's `TenantConfiguration`, but names
// no default figure anywhere — so a platform with no budget row for an (org, capability) pair has not
// "used up" anything, it has never been given a bound.
//
// Both states refuse, because the alternative is inventing a token ceiling nobody approved and letting
// real vendor spend run against it. But only `hard_breached` is a SPEND incident: the §4.9
// `ai.token_hard_cap_breached` alert and the D7 auto-kill-switch belong to it alone, and firing them
// for an unconfigured budget would page an on-call engineer about a cost overrun that never happened
// when the actual fix is an ops-configuration one. Collapsing the two would make that indistinguishable
// (the M19/M20 finding: "unreadable" and "empty" must be different values).

/** §1.1 — "Soft cap at 80% of monthly budget". The only cap figure any authority states. */
export const AI_TOKEN_SOFT_CAP_DEFAULT_RATIO = 0.8;

/** A tenant's monthly token budget for one capability. */
export interface AiTokenBudget {
  /** 100% of the monthly budget: at or above it, the capability falls back to Layer 1 (D7). */
  readonly hardCapTokens: number;
  /** 80% of the hard cap by default; a tenant override changes the threshold (§13.8). */
  readonly softCapTokens: number;
}

/** The cap verdict for one (org, capability) in one window. See the header for why there are four. */
export type AiTokenCapState = "within" | "soft_breached" | "hard_breached" | "budget_unconfigured";

/** A closed-open UTC calendar-month window `[start, end)`, matching the `ai_token_ledger` partition. */
export interface AiTokenCapWindow {
  readonly start: string;
  readonly end: string;
}

/** Build a budget from a hard cap, deriving the soft cap when the tenant has not overridden it. */
export function aiTokenBudgetFor(
  hardCapTokens: number,
  softCapTokens?: number | null,
): AiTokenBudget {
  return {
    hardCapTokens,
    softCapTokens:
      softCapTokens === undefined || softCapTokens === null
        ? Math.floor(hardCapTokens * AI_TOKEN_SOFT_CAP_DEFAULT_RATIO)
        : softCapTokens,
  };
}

/**
 * The UTC calendar month containing `instant`, as `[start, end)`.
 *
 * Half-open on purpose: `accrued_at = 2026-09-01T00:00:00Z` belongs to September's window and
 * September's partition, and a closed upper bound would count it in August's spend as well — silently
 * double-charging the one accrual that lands on a month boundary against two caps.
 */
export function aiTokenCapWindowFor(instant: string): AiTokenCapWindow {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) {
    throw new RangeError(`aiTokenCapWindowFor: '${instant}' is not a parseable instant`);
  }
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/**
 * Evaluate the cap. `spentTokens` is the window's `SUM(input_tokens + output_tokens)`.
 *
 * Both comparisons are `>=`, not `>`: a cap is the figure spend may reach, not the figure it may pass.
 * Off-by-one here means the very last invocation of the month runs past the ceiling the tenant agreed
 * to, which is the one direction a cost guardrail must not err in.
 */
export function aiTokenCapStateFor(input: {
  readonly spentTokens: number;
  readonly budget: AiTokenBudget | null;
}): AiTokenCapState {
  const { spentTokens, budget } = input;
  if (budget === null) return "budget_unconfigured";
  if (spentTokens >= budget.hardCapTokens) return "hard_breached";
  if (spentTokens >= budget.softCapTokens) return "soft_breached";
  return "within";
}

/** True when the cap forbids the call. Both refusing states, in one place, so callers cannot forget
 *  `budget_unconfigured` by pattern-matching only the state whose name says "breached". */
export function aiTokenCapRefuses(state: AiTokenCapState): boolean {
  return state === "hard_breached" || state === "budget_unconfigured";
}

/**
 * Would recording these deltas cross the soft cap that this call's own spend has not yet crossed?
 *
 * W1.7's soft-cap alert fires on the increment that PUSHES the tally past the threshold, not on every
 * call thereafter — the §13.8 24-hour dedup exists to blunt repeats, but an alert that fires from the
 * crossing rather than from the standing state is the one a reader can date. The invocation pipeline
 * hands this to M32-T07's alert emit; T04 only computes it.
 */
export function aiTokenSoftCapCrossedBy(input: {
  readonly spentTokensBefore: number;
  readonly accruedTokens: number;
  readonly budget: AiTokenBudget | null;
}): boolean {
  const { spentTokensBefore, accruedTokens, budget } = input;
  if (budget === null) return false;
  return (
    spentTokensBefore < budget.softCapTokens &&
    spentTokensBefore + accruedTokens >= budget.softCapTokens
  );
}
