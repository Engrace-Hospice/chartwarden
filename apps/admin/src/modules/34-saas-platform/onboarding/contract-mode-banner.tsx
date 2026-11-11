// apps/admin/src/modules/34-saas-platform/onboarding — a tenant that has a clearinghouse vendor but whose contract's billing service mode
// is still "none". Billing outside ChartWarden sets the mode to none; a later vendor choice never moves it back (the owner's decision: the
// mode is a commercial term, changed on purpose), so this says so, once, where the operator is looking at the vendor. Advisory: a contract
// that cannot be read shows nothing. Reading the contract is an audited read, so this is mounted only where a vendor is chosen.
import { InlineAlert, useApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import type { PlatformContract } from "./plan-contract-panel";
import { useLoad } from "./use-load";

export function ContractModeBanner({ orgSlug }: { orgSlug: string }): JSX.Element | null {
  const client = useApiClient();
  const sub = useLoad<{ contract: PlatformContract | null }>(
    `contract-mode-banner:${orgSlug}`,
    () =>
      client.GET("/api/v1/platform/tenants/{orgSlug}/subscription", {
        params: { path: { orgSlug } },
      }) as Promise<{
        data?: { contract: PlatformContract | null };
        error?: unknown;
        response?: { status: number };
      }>,
  );
  const contract = sub.data?.contract;
  if (!contract || contract.billingServiceMode !== "none") return null;
  // A change away from none is already scheduled: that is the answer, nothing to flag.
  const pending = contract.pendingBillingServiceMode?.billingServiceMode;
  if (pending !== undefined && pending !== "none") return null;
  return (
    <InlineAlert tone="warning">
      This tenant's billing service mode is still None. A clearinghouse is chosen, but choosing one
      never changes the contract's mode, so ChartWarden is not set up to bill for this tenant. If it
      now bills through ChartWarden, change the mode on{" "}
      <Link to={`/tenants/${encodeURIComponent(orgSlug)}/onboarding/plan_contract`}>
        the Plan and contract step
      </Link>
      .
    </InlineAlert>
  );
}
