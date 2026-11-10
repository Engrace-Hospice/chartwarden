// apps/backend/src/modules/35-subscription/pricing/outside-reconcile.ts — the hourly pricing worker's backstop for "a tenant that bills
// outside ChartWarden pays no billing percentage".
//
// The M34 wizard's post-commit sync sets the mode to none, best effort: a failure there is only retried by another clearinghouse change.
// The pricing worker asks once more for every current contract, including onboarding and paused tenants that may have no statement run. It
// applies the rule only where the clearinghouse is `outside`; the contract service answers "no change" when the mode is already none or
// pending none. It runs only where the pricing worker is bound. Attributed to the system: a sweep has no request and no person.
import type { ContractService } from "./contract-service";
import { SYSTEM_TRIGGER } from "./mode-trigger";

export function createOutsideModeReconciler(deps: {
  /** Whether the org's clearinghouse is `outside` (M23's choice, read lazily by the composition root). */
  readonly billsOutside: (organizationId: string) => Promise<boolean>;
  /** The contract service, resolved when USED (it is built after the sweep's wiring). */
  readonly contracts: () => Pick<ContractService, "setModeNoneForOutsideBilling">;
}): (organizationId: string) => Promise<void> {
  return async (organizationId) => {
    if (!(await deps.billsOutside(organizationId))) return;
    await deps.contracts().setModeNoneForOutsideBilling(organizationId, SYSTEM_TRIGGER);
  };
}
