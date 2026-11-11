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
  freshIdempotencyKeyHeaders,
  parsePriceCents,
  parseWholeNumber,
  stashStepUpMemoryDraft,
  useApiClient,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../../shell/session";
import { FailureNotice } from "./failure-notice";
import type { PanelContext } from "./panel-types";
import { ONBOARDING_KEYS, useCan } from "./permissions";
import { RecordSaveDialog } from "./record-save-dialog";
import { StepFrame } from "./step-frame";
import { useLoad } from "./use-load";
import { useOpsWrite } from "./use-ops-write";
import { readOnlyReasonOf } from "./wizard-model";

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
/** What a Re-verify keeps of this step: the typed inputs, which prompt was open and its reason (free text: this tab's memory only). */
interface Draft {
  readonly planSlug: string;
  readonly mode: Mode | "";
  readonly orderFormRef: string;
  readonly staff: string;
  readonly census: string;
  readonly collections: string;
  readonly changing: boolean;
  readonly newMode: Mode;
  readonly dialog: "sign" | "mode";
  readonly reason: string;
}
const draftKey = (orgSlug: string): string => `wizard:${orgSlug}:plan_contract:draft`;
/** The sign form's billing service pick: empty until chosen, never defaulted (it is a commercial term). */
const MODE_CHOICES: readonly { value: Mode | ""; label: string }[] = [
  { value: "", label: "Choose the billing service…" },
  ...MODES,
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
  // The price plans screen is plan.admin.read; an operator without it is told who publishes plans instead of sent to a refusal.
  const canReadPlans = useSession()?.permissions?.includes("plan.admin.read") ?? false;
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
  // Back from Re-verify the form and the prompt come back as they were left, with the reason that was typed (signing needs a step-up).
  const restored = useStepUpMemoryDraft<Draft>(draftKey(orgSlug));
  const [planSlug, setPlanSlug] = useState(restored?.planSlug ?? "");
  // No default: the billing service is a commercial term the operator chooses (the switch form has none either).
  const [mode, setMode] = useState<Mode | "">(restored?.mode ?? "");
  const [orderFormRef, setOrderFormRef] = useState(restored?.orderFormRef ?? "");
  const [staff, setStaff] = useState(restored?.staff ?? "");
  const [census, setCensus] = useState(restored?.census ?? "");
  const [collections, setCollections] = useState(restored?.collections ?? "");
  const [inputError, setInputError] = useState<string | null>(null);
  // A price is shown only for the inputs it was asked for: one that arrives after the operator edited them is never this form's price.
  const [preview, setPreview] = useState<{ inputsKey: string; value: Preview } | null>(null);
  const [saved, setSaved] = useState<SignResult["planContractStep"] | null>(null);
  const [dialog, setDialog] = useState<"sign" | "mode" | null>(restored?.dialog ?? null);
  const [changing, setChanging] = useState(restored?.changing ?? false);
  const [newMode, setNewMode] = useState<Mode>(restored?.newMode ?? "none");
  const [seedReason, setSeedReason] = useState(restored?.reason ?? "");
  // What is in the prompt's reason box right now (a Re-verify keeps an edit made after a refusal, not only the last submitted text).
  const typedReason = useRef(restored?.reason ?? "");
  const previewWrite = useOpsWrite();
  const write = useOpsWrite();

  const offered = plans.data ?? [];
  const contract = subscription.data?.contract ?? null;
  const plan = offered.find((p) => p.slug === (planSlug || offered[0]?.slug));
  const inputsKey = JSON.stringify([
    plan?.id ?? null,
    mode,
    staff.trim(),
    census.trim(),
    collections.trim(),
  ]);

  /** The props a sign / change prompt shares: the typed reason and the form survive a Re-verify, and the reason is dropped with the prompt. */
  const keepReason = (kind: "sign" | "mode") => ({
    ...(restored?.dialog === kind && seedReason !== "" ? { initialReason: seedReason } : {}),
    onReasonChange: (reason: string) => {
      typedReason.current = reason;
    },
    onReverify: () =>
      stashStepUpMemoryDraft<Draft>(draftKey(orgSlug), {
        planSlug,
        mode,
        orderFormRef,
        staff,
        census,
        collections,
        changing,
        newMode,
        dialog: kind,
        reason: typedReason.current,
      }),
  });
  const closePrompt = (): void => {
    typedReason.current = "";
    setSeedReason("");
    setDialog(null);
  };
  function askToSign(): void {
    if (mode === "") {
      setInputError("Choose the billing service.");
      return;
    }
    setInputError(null);
    write.clear();
    setDialog("sign");
  }

  async function runPreview(): Promise<void> {
    // A blank box is not zero (Number("") is 0), and "1e3" or "0x1f" is not a census: plain digits and a decimal point only.
    const asNumber = (text: string): number =>
      /^\d+(\.\d+)?$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
    const staffCount = parseWholeNumber(staff);
    const averageDailyCensus = asNumber(census);
    // String math, never a float multiply ("1.005" or "1e3" is not an amount an operator meant).
    const collectionsCents = collections.trim() === "" ? 0 : parsePriceCents(collections);
    const problem =
      staffCount === null
        ? "Enter the staff accounts (a whole number)."
        : !Number.isFinite(averageDailyCensus) || averageDailyCensus < 0
          ? "Enter the average daily census."
          : mode === ""
            ? "Choose the billing service."
            : mode !== "none" && collections.trim() === ""
              ? "Enter the expected net collections: the billing percentage is charged on them."
              : collectionsCents === null
                ? "Enter the expected net collections as dollars, with up to two decimals."
                : !plan
                  ? "Pick a plan."
                  : null;
    if (
      problem !== null ||
      !plan ||
      staffCount === null ||
      collectionsCents === null ||
      mode === ""
    ) {
      setInputError(problem);
      return;
    }
    setInputError(null);
    const body = {
      planId: plan.id,
      staffCount,
      averageDailyCensus,
      expectedNetCollectionsCents: collectionsCents,
      billingServiceMode: mode,
    };
    const askedFor = inputsKey;
    // A preview prices the plan as it is now, so it does not use the keeper's key: every click gets a fresh one (never a replay).
    const outcome = await previewWrite.run(JSON.stringify(body), () =>
      client.POST("/api/v1/platform/pricing/preview", {
        body,
        headers: freshIdempotencyKeyHeaders(),
      }),
    );
    if (outcome.ok) setPreview({ inputsKey: askedFor, value: outcome.data as unknown as Preview });
  }

  async function sign(reason: string): Promise<void> {
    if (!plan || mode === "") return;
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
      closePrompt();
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
      closePrompt();
      setChanging(false);
      await subscription.reload(true);
    }
  }

  if (plans.failure || subscription.failure) {
    // Reads only what failed: the contract read is audited per read, so a good one is not repeated.
    return (
      <div className="wx-form-stack">
        <InlineAlert tone="error">Could not load the plan and contract.</InlineAlert>
        <div>
          <Button
            tone="secondary"
            size="sm"
            onClick={() => {
              if (plans.failure) void plans.reload();
              if (subscription.failure) void subscription.reload();
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
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
                  write.clear();
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
            canReadPlans ? (
              <p>
                No published plan to sign yet.{" "}
                {/* A URL, not an import: M34 and M35 share no code edge (ADR-0025). */}
                <Link to="/admin/pricing-plans">Create or publish a price plan</Link>.
              </p>
            ) : (
              <p>
                No published plan to sign. A billing admin publishes plans; none is offered yet.
              </p>
            )
          ) : (
            <>
              <div className="wx-form-grid">
                <SelectField
                  label="Plan"
                  value={plan?.slug ?? ""}
                  onChange={(e) => setPlanSlug(e.target.value)}
                  options={offered.map((p) => ({
                    value: p.slug,
                    label: `${p.name} (version ${p.version})`,
                  }))}
                />
                <SelectField
                  label="Billing service"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as Mode | "")}
                  options={MODE_CHOICES}
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
              {preview && preview.inputsKey === inputsKey && plan ? (
                <PreviewCard preview={preview.value} currency={plan.currencyCode} />
              ) : null}
              <div className="wx-drawer-actions">
                <Button
                  tone="secondary"
                  onClick={() => void runPreview()}
                  disabled={previewWrite.busy}
                >
                  Preview price
                </Button>
                <Button onClick={askToSign}>Sign contract</Button>
              </div>
            </>
          )}
        </section>
      ) : (
        <p>No contract is signed yet.</p>
      )}

      {saved?.status === "pending" ? (
        <InlineAlert tone="info">
          Contract saved. The step settles once {saved.reason ?? "the earlier step is done"}.
        </InlineAlert>
      ) : null}

      <RecordSaveDialog
        open={dialog === "sign"}
        title="Sign the contract"
        description={
          plan && mode !== ""
            ? `${plan.name}, version ${plan.version}: ${MODE_LABEL[mode]}.`
            : undefined
        }
        rule={REASON_RULES.pricing}
        confirmLabel="Sign"
        write={write}
        orgSlug={orgSlug}
        {...keepReason("sign")}
        onConfirm={(reason) => void sign(reason)}
        onCancel={closePrompt}
      />
      <RecordSaveDialog
        open={dialog === "mode"}
        title="Change the billing service"
        description={`To: ${MODE_LABEL[newMode]}.`}
        rule={REASON_RULES.pricing}
        confirmLabel="Change"
        write={write}
        orgSlug={orgSlug}
        {...keepReason("mode")}
        onConfirm={(reason) => void changeMode(reason)}
        onCancel={closePrompt}
      />
    </>
  );
}

export function PlanContractPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  // A locked step, or a tenant that is not onboarding, makes no contract read: every read of a tenant's pricing is audited. Reading is
  // not writing: an operator whose role may read the contract but not sign it still sees it (the frame says they cannot edit).
  const stepOpen = readOnlyReasonOf(ctx.step, ctx.view) === null;
  const mayRead = useCan(ONBOARDING_KEYS.pricingRead);
  return (
    <StepFrame ctx={ctx} settledByPanel>
      {stepOpen && mayRead ? <PlanContractBody ctx={ctx} /> : null}
      {stepOpen && !mayRead ? (
        <InlineAlert tone="info">
          Your role cannot read this tenant's contract (that needs the {ONBOARDING_KEYS.pricingRead}{" "}
          permission).
        </InlineAlert>
      ) : null}
    </StepFrame>
  );
}
