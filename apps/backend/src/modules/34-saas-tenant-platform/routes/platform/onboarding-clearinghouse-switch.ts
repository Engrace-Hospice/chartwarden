// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-clearinghouse-switch.ts — an operator's clearinghouse write
// that LEAVES `outside` for a vendor.
//
// A tenant that bills outside ChartWarden is on billing mode none (an invariant: the system sets it and an operator cannot set another
// mode on an outside tenant). Moving it to a vendor therefore means choosing the mode the vendor billing calls for, and only an operator
// may: while the tenant has a contract the write must name the mode (`billingServiceMode`), which is set BEFORE the vendor and put back
// if the vendor change fails. Everywhere else the field is refused, so it is never silently ignored.
import { ValidationError } from "@chartwarden/types";
import type {
  OnboardingBillingModePort,
  OnboardingBillingServiceMode,
} from "../../../../bootstrap/onboarding-billing-mode-port";
import type {
  OnboardingClearinghousePort,
  OnboardingWriteScope,
} from "../../../../bootstrap/onboarding-clearinghouse-port";

export interface ClearinghouseSwitchPlan {
  /** The write body for the clearinghouse adapter: the billing mode is not part of it. */
  readonly body: Readonly<Record<string, unknown>>;
  /** The mode to set with the switch, or null when this write is not a contracted tenant's switch out of outside. */
  readonly billingServiceMode: OnboardingBillingServiceMode | null;
}

const refuse = (code: string, message: string): ValidationError =>
  new ValidationError("request validation failed", [
    { field: "billingServiceMode", code, message },
  ]);

export async function planClearinghouseSwitch(
  deps: {
    readonly clearinghouse: Pick<OnboardingClearinghousePort, "get">;
    readonly billingMode?: Pick<OnboardingBillingModePort, "hasContract">;
  },
  scope: OnboardingWriteScope,
  fields: Readonly<Record<string, unknown>>,
): Promise<ClearinghouseSwitchPlan> {
  const { billingServiceMode, ...body } = fields as {
    billingServiceMode?: OnboardingBillingServiceMode;
  } & Record<string, unknown>;
  // Only a vendor can be "left outside for", so a write that stays outside (and names no mode) never reads the tenant's choice.
  if (body.vendor === "outside" && billingServiceMode === undefined) {
    return { body, billingServiceMode: null };
  }
  const current = (await deps.clearinghouse.get(scope)) as {
    vendor?: string | null;
    source?: string;
  };
  const leavingOutside =
    current.source === "tenant" && current.vendor === "outside" && body.vendor !== "outside";
  const contracted =
    leavingOutside && (await deps.billingMode?.hasContract(scope.organizationId)) === true;
  if (contracted) {
    if (billingServiceMode === undefined) {
      throw refuse(
        "BILLING_SERVICE_MODE_REQUIRED",
        "this tenant bills outside ChartWarden and has a contract: choose the billing service mode it takes with the vendor (none keeps it unbilled)",
      );
    }
    return { body, billingServiceMode };
  }
  if (billingServiceMode !== undefined) {
    throw refuse(
      "BILLING_SERVICE_MODE_NOT_APPLICABLE",
      "a billing service mode is set only when a tenant with a contract leaves outside ChartWarden for a clearinghouse",
    );
  }
  return { body, billingServiceMode: null };
}
