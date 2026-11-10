// apps/web/src/modules/34-saas/wizard — step 2, Plan and contract: what ChartWarden set up for your organization, read only (GET
// /api/v1/subscription/pricing: the plan, the terms and the latest statement, never who set them or why). The tenant cannot create or
// change a contract; to change it, ask ChartWarden. The read is audited per call, so it is made once when the panel opens.
import { Button, InlineAlert, LoadingSpinner, useApiClient, useLoad } from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
import type { JSX } from "react";
import { formatCents } from "../../35-subscription/billing-status";
import { statusLabel } from "../saas-status";
import type { StepPanelProps } from "./panel-props";
import { ONBOARDING_KEYS } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { WIZARD_ERROR_COPY } from "./wizard-errors";

type Pricing =
  operations["getApiV1SubscriptionPricing"]["responses"][200]["content"]["application/json"];
type Contract = NonNullable<Pricing["contract"]>;

const MODE_LABEL: Record<Contract["billingServiceMode"], string> = {
  none: "No billing service",
  billing_software: "Billing software",
  managed_billing: "Managed billing service",
};
/** What the panel shows when the person may not read the plan: nothing is requested. */
const noPricing: Pricing = { contract: null, latestStatement: null };
const BPS_PER_PERCENT = 100;

const censusBand = (band: Contract["bands"][number]): string =>
  band.maxAdc === null
    ? `${band.minAdc} or more patients`
    : `${band.minAdc} to ${band.maxAdc} patients`;

function ContractFacts({ contract }: { contract: Contract }): JSX.Element {
  const money = (cents: number): string => formatCents(cents, contract.plan.currencyCode);
  const billingPercent = contract.billingBps / BPS_PER_PERCENT;
  return (
    <>
      <dl className="wx-kv">
        <dt>Plan</dt>
        <dd>{contract.plan.name}</dd>
        <dt>Billing service</dt>
        <dd>
          {MODE_LABEL[contract.billingServiceMode]}
          {contract.billingServiceMode === "none" ? "" : ` (${billingPercent}% of collections)`}
        </dd>
        <dt>Contract</dt>
        <dd className="wx-nums">
          {contract.contractStartOn} to {contract.contractEndsOn} ({contract.contractTermMonths}{" "}
          months)
        </dd>
        <dt>Per user, per month</dt>
        <dd className="wx-nums">{money(contract.perUserPriceCents)}</dd>
        <dt>One-time setup fee</dt>
        <dd className="wx-nums">{money(contract.implementationFeeCents)}</dd>
        {contract.minimumMonthlyCents === null ? null : (
          <>
            <dt>Monthly minimum</dt>
            <dd className="wx-nums">{money(contract.minimumMonthlyCents)}</dd>
          </>
        )}
      </dl>
      {contract.pendingBillingServiceMode ? (
        <InlineAlert tone="info">
          Your billing service changes to{" "}
          {MODE_LABEL[contract.pendingBillingServiceMode.billingServiceMode]} on{" "}
          {contract.pendingBillingServiceMode.effectiveOn}.
        </InlineAlert>
      ) : null}
      {contract.bands.length > 0 ? (
        <table className="wx-list-table wx-list-table-static">
          <caption className="wx-sr-only">Monthly platform fee by average daily census</caption>
          <thead>
            <tr>
              <th scope="col">Average daily census</th>
              <th scope="col">Monthly fee</th>
            </tr>
          </thead>
          <tbody>
            {contract.bands.map((band) => (
              <tr key={band.minAdc}>
                <td>{censusBand(band)}</td>
                <td className="wx-nums">{money(band.monthlyFeeCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

export function PlanContractPanel({ held }: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const mayRead = held.has(ONBOARDING_KEYS.pricingRead);
  const pricing = useLoad<Pricing>(
    `pricing:${mayRead}`,
    async () => (mayRead ? client.GET("/api/v1/subscription/pricing") : { data: noPricing }),
    WIZARD_ERROR_COPY,
  );
  const contract = pricing.data?.contract ?? null;
  const statement = pricing.data?.latestStatement ?? null;

  return (
    <section className="wx-drawer-card" aria-label="Plan and contract">
      <div className="wx-drawer-card-head">
        <h3>Your plan</h3>
      </div>
      {!mayRead ? <RoleCannot what="see the plan and contract" /> : null}
      {pricing.failure ? (
        <div className="wx-form-stack">
          <InlineAlert tone="error">Could not load your plan.</InlineAlert>
          <div>
            <Button tone="secondary" size="sm" onClick={() => void pricing.reload()}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}
      {pricing.loading && !pricing.data && !pricing.failure ? (
        <LoadingSpinner label="Loading your plan…" />
      ) : null}
      {mayRead && pricing.data && contract === null ? (
        <p>ChartWarden has not set up your plan yet. This step is completed by ChartWarden.</p>
      ) : null}
      {contract ? <ContractFacts contract={contract} /> : null}
      {statement ? (
        <p className="wx-row-sub">
          Latest statement ({statement.periodYearMonth},{" "}
          {statusLabel(statement.status).toLowerCase()}):{" "}
          {formatCents(statement.totalCents, statement.currencyCode)}
        </p>
      ) : null}
      {contract ? (
        <p className="wx-row-sub">To change your plan or contract, ask ChartWarden.</p>
      ) : null}
    </section>
  );
}
