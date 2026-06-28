// @wardenx/billing — M23 sequestration applier (D11, spec §1.1 / §3.3 `sequestration_policy`). A PURE
// wrapper over the penny-exact `applySequestration` money primitive that resolves WHICH percentage to
// apply: the active `sequestration_policy` snapshot supplied for the claim's service period, or — when no
// policy row is supplied — the platform-default constant exported here (currently 2%, the CMS-announced
// rate restored from the temporary 1% COVID reduction). The percentage is carried as a decimal STRING
// end-to-end (never a float); the result reports both the net payable and the withheld reduction (which
// sum back to the gross EXACTLY) plus which percentage was applied and from where, so the Phase-3 service
// can snapshot `claim.sequestration_applied_pct` for reproducible audit math.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`, no clock. No PHI (D18).
import type { Cents, SequestrationResult } from "../domain/money";
import { applySequestration } from "../domain/money";

/**
 * The platform-default sequestration percentage as a decimal STRING (D11). Tracks the CMS-announced
 * Medicare FFS sequestration rate — currently 2.0% (restored from the temporary 1% reduction). Applied
 * when no `sequestration_policy` snapshot is supplied for the claim's service period. The platform-floor
 * loader forward-dates any change; tenants never edit historical periods.
 */
export const DEFAULT_SEQUESTRATION_PERCENT = "2.0" as const;

/** The minimal active sequestration-policy snapshot the applier reads (D11). */
export interface SequestrationPolicySnapshot {
  /** Decimal STRING (e.g. `"2.00"`) — never a float. */
  readonly percentage: string;
}

/** Where the applied percentage came from — recorded for audit transparency. */
export type SequestrationSource = "policy" | "platform_default";

/** The result of applying sequestration: the money split plus the percentage + its provenance. */
export interface SequestrationApplication extends SequestrationResult {
  /** The decimal-string percentage actually applied. */
  readonly percentApplied: string;
  readonly source: SequestrationSource;
}

/**
 * Apply the Medicare sequestration reduction (D11) to a gross payable amount. When an active
 * `policy` snapshot is supplied, its `percentage` is used (`source: "policy"`); when `policy` is
 * `null`/`undefined`, the {@link DEFAULT_SEQUESTRATION_PERCENT} platform default is used (`source:
 * "platform_default"`). `netCents + reductionCents === amountCents` exactly. Pure + deterministic;
 * throws (via `applySequestration`) on a percentage outside `[0, 100]`.
 */
export function applySequestrationPolicy(
  amountCents: Cents,
  policy?: SequestrationPolicySnapshot | null,
): SequestrationApplication {
  const percentApplied = policy?.percentage ?? DEFAULT_SEQUESTRATION_PERCENT;
  const source: SequestrationSource = policy ? "policy" : "platform_default";
  const split = applySequestration(amountCents, percentApplied);
  return { ...split, percentApplied, source };
}
