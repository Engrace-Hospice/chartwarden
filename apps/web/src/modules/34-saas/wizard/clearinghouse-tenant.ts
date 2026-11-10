// apps/web/src/modules/34-saas/wizard — step 7, Billing: clearinghouse, in the tenant's voice. The facts are @chartwarden/ui's
// `clearinghouseFacts` with the tenant's wording (an operator reads about "the tenant", the tenant about "your organization"); this adds
// what only the tenant's panel decides: which actions to OFFER now. The server owns every rule (verify before activate, the BAA gate, the
// vendor lock, who may leave "outside"); this only keeps the member from being handed a button the server is certain to refuse.
import {
  type ClearinghouseMode,
  type ClearinghouseVendor,
  type ClearinghouseWording,
  type Fact,
  clearinghouseFacts,
  isChosen,
  isTransmitting,
  needsSecret,
  type operations,
} from "@chartwarden/ui";

export type TenantClearinghouseView =
  operations["getApiV1TenantClearinghouse"]["responses"][200]["content"]["application/json"];

export const TENANT_WORDING: ClearinghouseWording = {
  platformEnvDetail:
    "Only the deployment's shared setting names one; none is recorded for your organization.",
  outsideDetail:
    "ChartWarden will not send claims for your organization. No credential, BAA or activation is needed.",
  baaRecordedLabel: "You recorded your vendor BAA",
  baaNotRecordedDetail: "Record the BAA your organization holds with this vendor.",
  baaVerifiedLabel: "ChartWarden verified your vendor BAA",
};

export const tenantFactsOf = (view: TenantClearinghouseView): Fact[] =>
  clearinghouseFacts(view, TENANT_WORDING);

/**
 * The organization chose to bill outside ChartWarden. It cannot move to a vendor from the wizard: the server refuses whenever a pricing
 * contract exists (CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR: the switch also sets the billing service mode), and the tenant's view
 * carries no contract flag to tell the two cases apart. Step 7 comes after the plan step, so a contract is the normal case.
 */
export const isChosenOutside = (view: TenantClearinghouseView): boolean =>
  isChosen(view) && view.vendor === "outside";

export interface TenantClearinghouseActions {
  readonly canRecordBaa: boolean;
  readonly canVerifyConnection: boolean;
  /** Connection and BAA are both verified: the organization's own administrator may activate. */
  readonly canActivate: boolean;
  /** A BAA is recorded and ChartWarden has not verified it yet: the member can do nothing but wait. */
  readonly waitingForBaa: boolean;
  /** The activation card is shown (a vendor is chosen and the member may write), saying what it waits for when it cannot be done yet. */
  readonly showActivation: boolean;
}

/** What the member may do now. `canWrite`: they hold `billing.clearinghouse.admin` and the step is open for work. */
export function tenantActionsOf(
  view: TenantClearinghouseView,
  canWrite: boolean,
): TenantClearinghouseActions {
  const none = {
    canRecordBaa: false,
    canVerifyConnection: false,
    canActivate: false,
    waitingForBaa: false,
    showActivation: false,
  };
  if (!canWrite || !isChosen(view) || !isTransmitting(view)) return none;
  const baaVerified = view.baa?.verified != null;
  return {
    canRecordBaa: view.baaRequired,
    canVerifyConnection: view.status === "draft" && view.hasSecret,
    canActivate: view.status === "verified" && (!view.baaRequired || baaVerified),
    waitingForBaa: view.baaRequired && view.baa !== null && !baaVerified,
    showActivation: true,
  };
}

/**
 * What the choice does, said before the member saves it: `undefined` where there is nothing worth saying (an unchanged vendor and mode
 * keep the credential on file). Billing outside ChartWarden says what the steps after it do.
 */
export function tenantConsequenceOf(
  view: TenantClearinghouseView,
  choice: { vendor: ClearinghouseVendor; mode: ClearinghouseMode },
): string | undefined {
  if (choice.vendor === "outside") {
    return "ChartWarden will not send claims; steps 8 and 9 are skipped. No credential, BAA or activation is needed.";
  }
  if (!isChosen(view)) {
    return "The credential is sealed under your organization's own key and is never shown again.";
  }
  if (needsSecret(view, choice)) {
    return "Changing the vendor or the mode starts the new configuration at draft: it must be verified and activated again, and claims work waits until then. A change of vendor also voids your vendor BAA.";
  }
  return undefined;
}
