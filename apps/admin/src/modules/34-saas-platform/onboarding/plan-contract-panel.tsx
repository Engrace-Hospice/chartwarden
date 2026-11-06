// apps/admin/src/modules/34-saas-platform/onboarding — step 2, Plan & contract. The operator picks a published census-banded plan,
// previews what the tenant would pay for the staff, census and collections they expect, and signs it. Signing settles the step (the
// server attests it through the wizard), so there is no separate "mark done". The platform fee is the greater of staff x the per-user
// price and the flat fee of the census band, plus a billing percentage (software or managed service; none for a tenant that bills
// outside ChartWarden).
// The contract read is audited per read, so it is made only while this step is open and can be acted on.
import {
  Button,
  InlineAlert,
  REASON_RULES,
  SelectField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { FailureNotice } from "./failure-notice";
import type { PanelContext } from "./panel-types";
import { RecordSaveDialog } from "./record-save-dialog";
import { StepFrame } from "./step-frame";
import { useLoad } from "./use-load";
import { useOpsWrite } from "./use-ops-write";

type Mode = "none" | "billing_software" | "managed_billing";
interface Plan {
  id: string;
  slug: string;
  name: string;
  version: number;
  currencyCode: string;
}
export interface PlatformContract {
  plan: Plan;
  billingServiceMode: Mode;
  pendingBillingServiceMode: { billingServiceMode: Mode; effectiveOn: string } | null;
  contractStartOn: string;
  contractTermMonths: number;
  contractEndsOn: string;
  perUserPriceCents: number;
  bands: { minAdc: number; maxAdc: number | null; monthlyFeeCents: number }[];
  implementationFeeCents: number;
  minimumMonthlyCents: number | null;
  signedReason: string;
  orderFormRef: string | null;
}
interface Preview {
  platformFee: {
    feeCents: number;
    basis: "per_user" | "census_band";
    perUserSubtotalCents: number;
    bandFeeCents: number;
  };
  billing: { mode: Mode; bps: number; feeCents: number };
  minimumAdjustmentCents: number;
  monthlyCents: number;
  implementationFeeCents: number;
  firstMonthCents: number;
  contractTermMonths: number;
}
interface SignResult {
  planContractStep: { status: "settled" | "already_settled" | "pending"; reason?: string };
}

const MODES: readonly { value: Mode; label: string }[] = [
  { value: "none", label: "None (the tenant bills outside ChartWarden)" },
  { value: "billing_software", label: "Billing software" },
  { value: "managed_billing", label: "Managed billing service" },
];
const MODE_LABEL: Record<Mode, string> = {
  none: "None",
  billing_software: "Billing software",
  managed_billing: "Managed billing service",
};

export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function ContractSummary({ contract }: { contract: PlatformContract }): JSX.Element {
  const money = (cents: number): string => formatCents(cents, contract.plan.currencyCode);
  return (
    <dl className="wx-kv">
      <dt>Plan</dt>
      <dd>
        {contract.plan.name} <span className="wx-row-sub">version {contract.plan.version}</span>
      </dd>
      <dt>Billing service</dt>
      <dd>
        {MODE_LABEL[contract.billingServiceMode]}
        {contract.pendingBillingServiceMode
          ? ` (changes to ${MODE_LABEL[contract.pendingBillingServiceMode.billingServiceMode]} on ${contract.pendingBillingServiceMode.effectiveOn})`
          : ""}
      </dd>
      <dt>Term</dt>
      <dd className="wx-nums">
        {contract.contractStartOn} to {contract.contractEndsOn} ({contract.contractTermMonths}{" "}
        months)
      </dd>
      <dt>Per user</dt>
      <dd className="wx-nums">{money(contract.perUserPriceCents)} a month</dd>
      <dt>Census bands</dt>
      <dd className="wx-nums">
        {contract.bands
          .map(
            (b) =>
              `${b.minAdc}${b.maxAdc === null ? "+" : `-${b.maxAdc}`}: ${money(b.monthlyFeeCents)}`,
          )
          .join(" · ")}
      </dd>
      <dt>Implementation</dt>
      <dd className="wx-nums">{money(contract.implementationFeeCents)}</dd>
      {contract.minimumMonthlyCents !== null ? (
        <>
          <dt>Monthly minimum</dt>
          <dd className="wx-nums">{money(contract.minimumMonthlyCents)}</dd>
        </>
      ) : null}
      {contract.orderFormRef ? (
        <>
          <dt>Order form</dt>
          <dd>{contract.orderFormRef}</dd>
        </>
      ) : null}
      <dt>Signed because</dt>
      <dd>{contract.signedReason}</dd>
    </dl>
  );
}

function PreviewCard({ preview, currency }: { preview: Preview; currency: string }): JSX.Element {
  const money = (cents: number): string => formatCents(cents, currency);
  return (
    <dl className="wx-kv" aria-label="Price preview">
      <dt>Platform fee</dt>
      <dd className="wx-nums">
        {money(preview.platformFee.feeCents)}{" "}
        <span className="wx-row-sub">
          ({preview.platformFee.basis === "per_user" ? "staff x per-user price" : "census band"})
        </span>
      </dd>
      <dt>Billing service</dt>
      <dd className="wx-nums">{money(preview.billing.feeCents)}</dd>
      {preview.minimumAdjustmentCents > 0 ? (
        <>
          <dt>Minimum adjustment</dt>
          <dd className="wx-nums">{money(preview.minimumAdjustmentCents)}</dd>
        </>
      ) : null}
      <dt>Monthly</dt>
      <dd className="wx-nums">{money(preview.monthlyCents)}</dd>
      <dt>Implementation</dt>
      <dd className="wx-nums">{money(preview.implementationFeeCents)}</dd>
      <dt>First month</dt>
      <dd className="wx-nums">{money(preview.firstMonthCents)}</dd>
    </dl>
  );
}

function PlanContractBody({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, actions } = ctx;
  const canWrite = actions.readOnlyReason === null;
  const plans = useLoad<Plan[]>(
    `plans:${orgSlug}`,
    () =>
      client.GET("/api/v1/platform/pricing/plans") as Promise<{
        data?: Plan[];
        error?: unknown;
        response?: { status: number };
      }>,
  );
  const subscription = useLoad<{ contract: PlatformContract | null }>(
    `subscription:${orgSlug}`,
    () =>
      client.GET("/api/v1/platform/tenants/{orgSlug}/subscription", {
        params: { path: { orgSlug } },
      }) as Promise<{
        data?: { contract: PlatformContract | null };
        error?: unknown;
        response?: { status: number };
      }>,
  );
  const [planSlug, setPlanSlug] = useState("");
  const [mode, setMode] = useState<Mode>("none");
  const [orderFormRef, setOrderFormRef] = useState("");
  const [staff, setStaff] = useState("");
  const [census, setCensus] = useState("");
  const [collections, setCollections] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saved, setSaved] = useState<SignResult["planContractStep"] | null>(null);
  const [dialog, setDialog] = useState<"sign" | "mode" | null>(null);
  const [changing, setChanging] = useState(false);
  const [newMode, setNewMode] = useState<Mode>("none");
  const previewWrite = useOpsWrite();
  const write = useOpsWrite();

  const offered = plans.data ?? [];
  const contract = subscription.data?.contract ?? null;
  const plan = offered.find((p) => p.slug === (planSlug || offered[0]?.slug));

  async function runPreview(): Promise<void> {
    const staffCount = Number(staff);
    const averageDailyCensus = Number(census);
    const dollars = Number(collections || "0");
    if (
      ![staffCount, averageDailyCensus, dollars].every((n) => Number.isFinite(n) && n >= 0) ||
      !Number.isInteger(staffCount) ||
      !plan
    ) {
      setInputError(
        "Enter the staff accounts (a whole number), the average daily census and the expected net collections.",
      );
      return;
    }
    setInputError(null);
    const body = {
      planId: plan.id,
      staffCount,
      averageDailyCensus,
      expectedNetCollectionsCents: Math.round(dollars * 100),
      billingServiceMode: mode,
    };
    const outcome = await previewWrite.run(JSON.stringify(body), () =>
      client.POST("/api/v1/platform/pricing/preview", { body }),
    );
    if (outcome.ok) setPreview(outcome.data as unknown as Preview);
  }

  async function sign(reason: string): Promise<void> {
    if (!plan) return;
    const body = {
      planSlug: plan.slug,
      billingServiceMode: mode,
      ...(orderFormRef.trim() ? { orderFormRef: orderFormRef.trim() } : {}),
      reason,
    };
    const outcome = await write.run(JSON.stringify(body), (key) =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/subscription", {
        params: { path: { orgSlug }, header: { "Idempotency-Key": key } },
        body,
      }),
    );
    if (outcome.ok) {
      setDialog(null);
      setSaved((outcome.data as unknown as SignResult).planContractStep);
      await Promise.all([subscription.reload(true), ctx.refresh()]);
    }
  }

  async function changeMode(reason: string): Promise<void> {
    const body = { billingServiceMode: newMode, reason };
    const outcome = await write.run(JSON.stringify(body), (key) =>
      client.PUT("/api/v1/platform/tenants/{orgSlug}/subscription/billing-service-mode", {
        params: { path: { orgSlug }, header: { "Idempotency-Key": key } },
        body,
      }),
    );
    if (outcome.ok) {
      setDialog(null);
      setChanging(false);
      await subscription.reload(true);
    }
  }

  if (plans.failure || subscription.failure) {
    return <p role="alert">Could not load the plan and contract.</p>;
  }
  if (!plans.data || !subscription.data) return <p>Loading the plan and contract…</p>;

  return (
    <>
      {contract ? (
        <section className="wx-drawer-card" aria-label="Signed contract">
          <div className="wx-drawer-card-head">
            <h3>Signed contract</h3>
            {canWrite && !changing ? (
              <Button
                size="sm"
                tone="secondary"
                onClick={() => {
                  setNewMode(contract.billingServiceMode);
                  setChanging(true);
                }}
              >
                Change billing service
              </Button>
            ) : null}
          </div>
          <ContractSummary contract={contract} />
          {changing ? (
            <div className="wx-form-stack">
              <SelectField
                label="New billing service"
                value={newMode}
                onChange={(e) => setNewMode(e.target.value as Mode)}
                options={MODES}
              />
              <InlineAlert tone="info">
                A change takes effect on the 1st of next month, or at once while the tenant is
                onboarding with nothing billed.
              </InlineAlert>
              <div className="wx-drawer-actions">
                <Button tone="secondary" onClick={() => setChanging(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    write.clear();
                    setDialog("mode");
                  }}
                >
                  Review change
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : canWrite ? (
        <section className="wx-drawer-card" aria-label="Sign a plan">
          <div className="wx-drawer-card-head">
            <h3>Sign a plan</h3>
          </div>
          {offered.length === 0 ? (
            <p>No published plan to sign. A billing admin publishes plans; none is offered yet.</p>
          ) : (
            <>
              <div className="wx-form-grid">
                <SelectField
                  label="Plan"
                  value={plan?.slug ?? ""}
                  onChange={(e) => {
                    setPlanSlug(e.target.value);
                    setPreview(null);
                  }}
                  options={offered.map((p) => ({
                    value: p.slug,
                    label: `${p.name} (version ${p.version})`,
                  }))}
                />
                <SelectField
                  label="Billing service"
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value as Mode);
                    setPreview(null);
                  }}
                  options={MODES}
                />
                <TextField
                  label="Order form reference (optional)"
                  value={orderFormRef}
                  onChange={(e) => setOrderFormRef(e.target.value)}
                />
              </div>
              <div className="wx-form-grid">
                <TextField
                  label="Staff accounts"
                  inputMode="numeric"
                  value={staff}
                  onChange={(e) => setStaff(e.target.value)}
                />
                <TextField
                  label="Average daily census"
                  inputMode="decimal"
                  value={census}
                  onChange={(e) => setCensus(e.target.value)}
                />
                <TextField
                  label="Expected net collections a month (dollars)"
                  inputMode="decimal"
                  value={collections}
                  onChange={(e) => setCollections(e.target.value)}
                />
              </div>
              {inputError ? <InlineAlert tone="error">{inputError}</InlineAlert> : null}
              {previewWrite.failure ? (
                <FailureNotice failure={previewWrite.failure} orgSlug={orgSlug} />
              ) : null}
              {preview && plan ? (
                <PreviewCard preview={preview} currency={plan.currencyCode} />
              ) : null}
              <div className="wx-drawer-actions">
                <Button
                  tone="secondary"
                  onClick={() => void runPreview()}
                  disabled={previewWrite.busy}
                >
                  Preview price
                </Button>
                <Button
                  onClick={() => {
                    write.clear();
                    setDialog("sign");
                  }}
                >
                  Sign contract
                </Button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {saved?.status === "pending" ? (
        <InlineAlert tone="info">
          Contract saved. The step settles once {saved.reason ?? "the earlier step is done"}.
        </InlineAlert>
      ) : null}

      <RecordSaveDialog
        open={dialog === "sign"}
        title="Sign the contract"
        description={
          plan ? `${plan.name}, version ${plan.version}: ${MODE_LABEL[mode]}.` : undefined
        }
        rule={REASON_RULES.pricing}
        confirmLabel="Sign"
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void sign(reason)}
        onCancel={() => setDialog(null)}
      />
      <RecordSaveDialog
        open={dialog === "mode"}
        title="Change the billing service"
        description={`To: ${MODE_LABEL[newMode]}.`}
        rule={REASON_RULES.pricing}
        confirmLabel="Change"
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void changeMode(reason)}
        onCancel={() => setDialog(null)}
      />
    </>
  );
}

export function PlanContractPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  // A locked step, or a tenant that is not onboarding, makes no contract read: every read of a tenant's pricing is audited.
  const canLoad = ctx.actions.readOnlyReason === null;
  return (
    <StepFrame ctx={ctx} settledByPanel>
      {canLoad ? <PlanContractBody ctx={ctx} /> : null}
    </StepFrame>
  );
}
