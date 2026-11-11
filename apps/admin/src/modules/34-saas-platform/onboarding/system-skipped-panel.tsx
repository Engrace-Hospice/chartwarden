// apps/admin/src/modules/34-saas-platform/onboarding — a billing step the SYSTEM skipped because the tenant bills outside ChartWarden
// (MAC credentials, payer enrollment). It says why the step does not apply and offers none of its own forms; the step frame keeps
// "re-open" so nothing is hidden behind the skip. When the tenant has since chosen a vendor the step applies again: the server re-opens
// it by itself, unless a go-live attestation is pending (that would be voided), so the panel says so and how to get it back.
import { InlineAlert, useApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { type ClearinghouseView, VENDOR_LABEL, isTransmitting } from "./clearinghouse-model";
import type { PanelContext } from "./panel-types";
import { StepFrame } from "./step-frame";
import { useLoad } from "./use-load";

const WHY: Readonly<Record<string, string>> = {
  mac_configured:
    "ChartWarden sends no Medicare claims for this tenant, so there is no MAC submitter credential to enter.",
  payer_enrollment:
    "ChartWarden submits no claims for this tenant, so payer enrollment is not tracked here.",
};
const WHY_DEFAULT = "This step does not apply to a tenant that bills outside ChartWarden.";

export function SystemSkippedPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, step } = ctx;
  // Advisory: a choice that cannot be read shows no warning rather than a wrong one.
  const choice = useLoad<ClearinghouseView>(`system-skipped:${orgSlug}`, () =>
    client.GET("/api/v1/platform/tenants/{orgSlug}/clearinghouse", {
      params: { path: { orgSlug } },
    }),
  );
  const vendor = choice.data;
  const vendorNow = vendor !== null && isTransmitting(vendor) && vendor.source === "tenant";
  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="Why this step does not apply">
        <div className="wx-drawer-card-head">
          <h3>Not needed for this tenant</h3>
        </div>
        <p>{WHY[step.key] ?? WHY_DEFAULT}</p>
        {vendorNow ? (
          <InlineAlert tone="warning">
            This tenant now bills through {VENDOR_LABEL[vendor.vendor ?? ""] ?? "a vendor"}, so this
            step applies again. It re-opens by itself; if it has not, re-open it here (a pending
            go-live attestation has to be revoked first).
          </InlineAlert>
        ) : null}
      </section>
    </StepFrame>
  );
}
