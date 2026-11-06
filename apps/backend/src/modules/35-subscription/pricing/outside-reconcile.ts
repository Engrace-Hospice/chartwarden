// apps/backend/src/modules/35-subscription/pricing/outside-reconcile.ts — the hourly statement sweep's backstop for "a tenant that bills
// outside ChartWarden pays no billing percentage".
//
// The M34 wizard's post-commit sync sets the mode to none, best effort: a failure there is only retried by another clearinghouse change.
// Before an org's statement is computed, the sweep asks once more and applies the rule again. It touches only an org whose clearinghouse is
// `outside` AND that holds a live contract (the contract service answers "no change" without one, and for a mode already none or pending
// none), and it runs only where the pricing statement sweep is bound (it is a dependency of that sweep). Attributed to the system: a sweep
// has no request and no person.
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
