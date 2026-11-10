// apps/web/src/modules/34-saas/wizard — step 7, Billing: clearinghouse, in the tenant's voice, as pure functions of the server's masked view.
// The hoisted `clearinghouseFacts` / `clearinghouseActions` in @chartwarden/ui speak to an operator ("the tenant recorded its BAA, an
// operator verified it"); these say the same facts to the organization itself. The server owns every rule (verify before activate, the
// BAA gate, the vendor lock); this only keeps the member from being handed a button the server is certain to refuse.
import {
  type ClearinghouseMode,
  type ClearinghouseVendor,
  type ClearinghouseView,
  type Fact,
  MODE_LABEL,
  VENDOR_LABEL,
  isTransmitting,
  needsSecret,
  type operations,
} from "@chartwarden/ui";

export type TenantClearinghouseView =
  operations["getApiV1TenantClearinghouse"]["responses"][200]["content"]["application/json"];

/**
 * The tenant's view is the platform view minus `hasContract` (a tenant cannot change its billing service mode: that switch is refused with
 * CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR). The shared form and model take the platform shape, so say "no contract" for the tenant.
 */
export const asSharedView = (view: TenantClearinghouseView): ClearinghouseView => ({
  ...view,
  hasContract: false,
});

const isChosen = (view: TenantClearinghouseView): boolean =>
  view.vendor !== null && view.source === "tenant";

const TEST_OUTCOME: Readonly<Record<string, string>> = {
  ok: "the connection answered",
  credential_rejected: "the vendor rejected the credential",
  unreachable: "the vendor could not be reached",
};

const when = (iso: string): string => new Date(iso).toLocaleString();

export function tenantFactsOf(view: TenantClearinghouseView): Fact[] {
  if (!isChosen(view)) {
    return [
      {
        key: "chosen",
        label: "A clearinghouse is chosen",
        state: "pending",
        ...(view.source === "platform_env"
          ? {
              detail:
                "Only the deployment's shared setting names one; none is recorded for your organization.",
            }
          : {}),
      },
    ];
  }
  const shared = asSharedView(view);
  if (!isTransmitting(shared)) {
    return [
      {
        key: "chosen",
        label: "Billing outside ChartWarden",
        state: "ok",
        detail:
          "ChartWarden will not send claims for your organization. No credential, BAA or activation is needed.",
      },
    ];
  }
  const vendor = VENDOR_LABEL[view.vendor ?? ""] ?? "The vendor";
  const connected = view.status === "verified" || view.status === "active";
  const lastTest = view.lastTest;
  return [
    {
      key: "chosen",
      label: "A clearinghouse is chosen",
      state: "ok",
      detail: `${vendor}${view.mode ? `, ${MODE_LABEL[view.mode].toLowerCase()} mode` : ""}`,
    },
    {
      key: "secret",
      label: "The vendor credential is on file",
      state: view.hasSecret ? "ok" : "pending",
    },
    {
      key: "baa-recorded",
      label: "You recorded your vendor BAA",
      state: view.baa ? "ok" : "pending",
      detail: view.baa
        ? `${view.baa.documentRef}, effective ${view.baa.effectiveDate}`
        : "Record the BAA your organization holds with this vendor.",
    },
    {
      key: "baa-verified",
      label: "ChartWarden verified your vendor BAA",
      state: view.baa?.verified ? "ok" : "pending",
      ...(view.baa?.verified ? { detail: `Verified ${when(view.baa.verified.at)}` } : {}),
    },
    {
      key: "connection",
      label: "The connection is verified",
      state: connected ? "ok" : "pending",
      ...(!connected && lastTest
        ? {
            detail: `Last test ${when(lastTest.at)}: ${TEST_OUTCOME[lastTest.outcome] ?? lastTest.outcome}.`,
          }
        : {}),
    },
    {
      key: "active",
      label: "The clearinghouse is active",
      state: view.status === "active" ? "ok" : "pending",
    },
  ];
}

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
  if (!canWrite || !isChosen(view) || !isTransmitting(asSharedView(view))) return none;
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
  if (needsSecret(asSharedView(view), choice)) {
    return "Changing the vendor or the mode starts the new configuration at draft: it must be verified and activated again, and claims work waits until then. A change of vendor also voids your vendor BAA.";
  }
  return undefined;
}
