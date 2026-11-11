// apps/backend/src/modules/35-subscription/pricing/contract-view.ts — what a contract READS as: the tenant's and the platform's contract
// views, how one is built from the contract, its plan bands and its billing-mode history, and the loaders that fetch those on a tenant
// or a platform transaction (including the subscription row lock that serialises the billing-mode writers). No inserts.
import { schema } from "@chartwarden/db";
import type { BillingServiceMode } from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type { WriteTx } from "../routes/service-drizzle";
import { type ModeHistoryRow, modeInForceOn, pendingModeAfter } from "./contract-mode";
import { type ContractRecord, loadModeHistory, selectNewestContract } from "./contract-select";
import { type PricingBandView, bandViews, loadBands } from "./plan-service";
import type { StatementView } from "./statement-view";

const PL = schema.plan;
const SC = schema.subscriptionContract;
const SUB = schema.subscriptionRow;

export interface ContractView {
  readonly subscriptionId: string;
  readonly plan: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly version: number;
    readonly currencyCode: string;
  };
  /** The mode in force today. */
  readonly billingServiceMode: BillingServiceMode;
  /** The rate in force for this subscription today: 0 when it bills outside ChartWarden. */
  readonly billingBps: number;
  /** A recorded change that has not taken effect yet (it takes effect from the 1st of the next month), else null. */
  readonly pendingBillingServiceMode: {
    readonly billingServiceMode: BillingServiceMode;
    readonly effectiveOn: string;
  } | null;
  readonly contractStartOn: string;
  readonly contractTermMonths: number;
  readonly contractEndsOn: string;
  readonly perUserPriceCents: number;
  readonly bands: readonly PricingBandView[];
  readonly billingSoftwareBps: number;
  readonly managedBillingBps: number;
  readonly implementationFeeCents: number;
  readonly minimumMonthlyCents: number | null;
}

/** The platform's richer view: who signed, why, and the order form reference. Never on the tenant surface. */
export interface PlatformContractView extends ContractView {
  readonly signedByMembershipId: string;
  readonly signedReason: string;
  readonly orderFormRef: string | null;
}

export interface TenantPricingView {
  readonly contract: ContractView | null;
  /** The latest statement: the month in progress (`draft`) or the last closed one. Null before the first. */
  readonly latestStatement: StatementView | null;
}

export interface PlatformPricingView {
  readonly contract: PlatformContractView | null;
  readonly statements: readonly StatementView[];
}

export type PlanRow = typeof PL.$inferSelect;
export type Band = { readonly minAdc: number; readonly monthlyFeeCents: number };

/** `start` plus `months` calendar months, on the same day (clamped to the month's last day), as `YYYY-MM-DD` (UTC). */
export function addMonthsIso(startIso: string, months: number): string {
  const [y, m, d] = startIso.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export const rateOf = (plan: PlanRow, mode: BillingServiceMode): number =>
  mode === "billing_software"
    ? (plan.billingSoftwareBps ?? 0)
    : mode === "managed_billing"
      ? (plan.managedBillingBps ?? 0)
      : 0;

export function contractViewOf(
  { contract, plan }: Pick<ContractRecord, "contract" | "plan">,
  bands: readonly Band[],
  history: readonly ModeHistoryRow[],
  today: string,
): ContractView {
  if (
    plan.perUserPriceCents === null ||
    plan.billingSoftwareBps === null ||
    plan.managedBillingBps === null ||
    plan.contractTermMonths === null ||
    plan.implementationFeeCents === null
  ) {
    throw new ChartWardenError("PLAN_PRICING_INCOMPLETE", "the contracted plan has no prices", 500);
  }
  const mode = modeInForceOn(history, today);
  if (mode === null) {
    throw new ChartWardenError(
      "CONTRACT_MODE_MISSING",
      "the contract has no billing service mode",
      500,
    );
  }
  return {
    subscriptionId: contract.subscriptionId,
    plan: {
      id: plan.id,
      slug: plan.slug,
      name: plan.name,
      version: plan.version,
      currencyCode: plan.currencyCode,
    },
    billingServiceMode: mode,
    billingBps: rateOf(plan, mode),
    pendingBillingServiceMode: pendingModeAfter(history, today),
    contractStartOn: contract.contractStartOn,
    contractTermMonths: plan.contractTermMonths,
    contractEndsOn: addMonthsIso(contract.contractStartOn, plan.contractTermMonths),
    perUserPriceCents: plan.perUserPriceCents,
    bands: bandViews(bands),
    billingSoftwareBps: plan.billingSoftwareBps,
    managedBillingBps: plan.managedBillingBps,
    implementationFeeCents: plan.implementationFeeCents,
    minimumMonthlyCents: plan.minimumMonthlyCents,
  };
}

/** Who signed, why, and the order form: the columns the tenant role cannot read. Platform transactions only. */
export interface Signature {
  readonly signedByMembershipId: string;
  readonly signedReason: string;
  readonly orderFormRef: string | null;
}

export async function loadSignature(tx: WriteTx, contractId: string): Promise<Signature> {
  const [row] = await tx
    .select({
      signedByMembershipId: SC.signedByMembershipId,
      signedReason: SC.signedReason,
      orderFormRef: SC.orderFormRef,
    })
    .from(SC)
    .where(eq(SC.id, contractId))
    .limit(1);
  if (!row) throw new ChartWardenError("PERSIST_FAILED", "the contract has no signature row", 500);
  return row;
}

export const platformViewOf = (
  record: ContractRecord,
  bands: readonly Band[],
  history: readonly ModeHistoryRow[],
  today: string,
  signature: Signature,
): PlatformContractView => ({
  ...contractViewOf(record, bands, history, today),
  signedByMembershipId: signature.signedByMembershipId,
  signedReason: signature.signedReason,
  orderFormRef: signature.orderFormRef,
});

export interface LoadedContract {
  readonly record: ContractRecord;
  readonly bands: Band[];
  readonly history: readonly ModeHistoryRow[];
}

/** The org's newest contract in the scope with its plan bands and mode history, on a tenant or a platform transaction. */
export async function loadContract(
  tx: WriteTx,
  scope: "live" | "current" | "latest",
  at: Date,
  organizationId: string,
): Promise<LoadedContract | null> {
  const record = await selectNewestContract(tx, scope, at, organizationId);
  if (!record) return null;
  const history = (await loadModeHistory(tx, [record.contract.id])).get(record.contract.id) ?? [];
  return { record, bands: await loadBands(tx, record.plan.id), history };
}

/**
 * Serialise the writers of one subscription's billing mode (an operator's change, the system's outside-means-none sync, the sweep) on its
 * row, and read the mode history AFTER the lock: what is judged is what is current, not what was read before another writer committed.
 */
export async function lockSubscriptionAndReloadHistory(
  tx: WriteTx,
  found: LoadedContract,
): Promise<LoadedContract> {
  await tx
    .select({ id: SUB.id })
    .from(SUB)
    .where(eq(SUB.id, found.record.sub.id))
    .for("update")
    .limit(1);
  const history =
    (await loadModeHistory(tx, [found.record.contract.id])).get(found.record.contract.id) ?? [];
  return { ...found, history };
}
