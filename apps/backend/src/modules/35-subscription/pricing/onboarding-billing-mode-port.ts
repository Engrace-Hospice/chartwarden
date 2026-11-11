// apps/backend/src/modules/35-subscription/pricing/onboarding-billing-mode-port.ts — M35's side of the platform billing-mode seam
// (bootstrap/onboarding-billing-mode-port.ts): an operator's switch of a tenant OUT of `outside` sets the billing mode through the SAME
// contract service the pricing routes use, so the mode is dated like any mode change and audited with the operator and the reason.
import { getRequestContext } from "@chartwarden/tenancy";
import type {
  OnboardingBillingModeOperator,
  OnboardingBillingModePort,
} from "../../../bootstrap/onboarding-billing-mode-port";
import type { ContractService } from "./contract-service";
import { modeTriggerOf } from "./mode-trigger";

/** `contracts` is a getter: the contract service is built after the platform data service that uses this port (a late-bound holder). */
export function buildOnboardingBillingModePort(
  contracts: () => Pick<
    ContractService,
    "hasContract" | "setBillingServiceMode" | "setModeNoneForOutsideBilling"
  >,
): OnboardingBillingModePort {
  return {
    hasContract: (organizationId) => contracts().hasContract(organizationId),
    async setModeLeavingOutside(operator: OnboardingBillingModeOperator, orgSlug, mode, reason) {
      await contracts().setBillingServiceMode(
        {
          organizationId: operator.organizationId,
          userId: operator.userId,
          roles: operator.roles,
          membershipId: operator.membershipId,
          stepUpRecent: operator.stepUpRecent,
        },
        orgSlug,
        mode,
        reason,
        { leavingOutside: true },
      );
    },
    async restoreNone(organizationId) {
      await contracts().setModeNoneForOutsideBilling(
        organizationId,
        modeTriggerOf(getRequestContext(), organizationId),
      );
    },
  };
}
