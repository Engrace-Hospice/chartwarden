// apps/backend/src/modules/35-subscription/pricing/statement-inputs.ts — READS the facts a statement run is computed from (slice 2).
// One platform transaction's worth of reads, no writes: the org's contracts (through the ONE shared selector), each contract's plan
// prices and bands, its billing service mode history, the statements already stored, and the subscription's lifetime (go-live, pauses,
// cancel) turned into the windows `daysLiveInMonth` counts. The statement service calls this twice: once to know what money to ask M25
// for, and once more inside the write transaction (under the per-org lock) so what is written is judged on the freshest state.
import { schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { asc, eq, inArray } from "drizzle-orm";
import type { WriteTx } from "../routes/service-drizzle";
import { loadModeHistory, selectContracts } from "./contract-select";
import { loadBands } from "./plan-service";
import type { GoLiveReader } from "./ports";
import { liveWindowsOf } from "./statement-period";
import { type ContractFacts, type ExistingStatement, figuresOf } from "./statement-plan";

const SS = schema.subscriptionStatement;
const SH = schema.subscriptionStateHistory;

type Sub = typeof schema.subscriptionRow.$inferSelect;

export interface Transition {
  readonly from: Sub["status"] | null;
  readonly to: Sub["status"];
  readonly at: Date;
}

export interface Lifetime {
  readonly endedAt: Date | null;
  readonly pauses: { readonly from: Date; readonly to: Date | null }[];
}

/**
 * Paused intervals and the cancel instant of a subscription, from its transition ledger and its own row. PURE.
 *
 * A pause opens on a transition into `paused` and closes on the next transition out of it. A pause that is still open when a later
 * transition arrives that does not keep the subscription paused (a resume that wrote no history row of its own, then a cancel or a new
 * pause) is closed at that transition, the earliest instant the ledger proves it was over. Only the LAST pause has nothing after it: if
 * the subscription is NOT paused any more it falls back to the row's `updated_at`, the instant of the last write, rather than staying
 * open forever (an open pause bills nothing, so a stale one would stop the bill for good). `updated_at` drifts on unrelated writes, which
 * is why it is only the fallback.
 */
export function lifetimeFromTransitions(
  transitions: readonly Transition[],
  sub: Pick<Sub, "status" | "canceledAt" | "updatedAt">,
): Lifetime {
  const pauses: { from: Date; to: Date | null }[] = [];
  for (const t of transitions) {
    const open = pauses[pauses.length - 1];
    const keepsPaused = t.from === "paused" && t.to === "paused";
    if (open && open.to === null && !keepsPaused) open.to = t.at;
    if (t.to === "paused" && t.from !== "paused") pauses.push({ from: t.at, to: null });
  }
  const last = pauses[pauses.length - 1];
  if (last && last.to === null && sub.status !== "paused") last.to = sub.updatedAt;
  const canceledTransition = transitions.filter((t) => t.to === "canceled").pop();
  const endedAt =
    sub.status === "canceled" ? (sub.canceledAt ?? canceledTransition?.at ?? sub.updatedAt) : null;
  return { endedAt, pauses };
}

async function lifetimeOf(tx: WriteTx, sub: Sub): Promise<Lifetime> {
  const transitions = await tx
    .select({ from: SH.fromStatus, to: SH.toStatus, at: SH.transitionedAt })
    .from(SH)
    .where(eq(SH.subscriptionId, sub.id))
    .orderBy(asc(SH.transitionedAt), asc(SH.id));
  return lifetimeFromTransitions(transitions, sub);
}

function requirePricing(plan: typeof schema.plan.$inferSelect) {
  if (
    plan.perUserPriceCents === null ||
    plan.billingSoftwareBps === null ||
    plan.managedBillingBps === null ||
    plan.implementationFeeCents === null
  ) {
    throw new ChartWardenError(
      "PLAN_PRICING_INCOMPLETE",
      "the contracted plan has no prices; refusing to compute a statement from it",
      500,
    );
  }
  return {
    perUserPriceCents: plan.perUserPriceCents,
    billingSoftwareBps: plan.billingSoftwareBps,
    managedBillingBps: plan.managedBillingBps,
    implementationFeeCents: plan.implementationFeeCents,
    minimumMonthlyCents: plan.minimumMonthlyCents,
  };
}

export const toExisting = (row: typeof SS.$inferSelect): ExistingStatement => ({
  id: row.id,
  periodYearMonth: row.periodYearMonth,
  status: row.status,
  netCollectionsCents: row.netCollectionsCents,
  netCollectionsRemittanceCount: row.netCollectionsRemittanceCount,
  billingServiceMode: row.billingServiceMode,
  billingBps: row.billingBps,
  priorPeriodLines: row.priorPeriodLines,
  figures: figuresOf(row),
});

/** Every contract of the org that can still need a statement, with everything its months are computed from. [] when the org is not live. */
export async function loadContractFacts(
  tx: WriteTx,
  goLive: GoLiveReader,
  organizationId: string,
  at: Date,
): Promise<ContractFacts[]> {
  const records = await selectContracts(tx, "statements", at, organizationId);
  if (records.length === 0) return [];
  const goLiveAt = await goLive.goLiveAt(tx, organizationId);
  if (!goLiveAt) return [];
  const histories = await loadModeHistory(
    tx,
    records.map((r) => r.contract.id),
  );
  const stored = await tx
    .select()
    .from(SS)
    .where(
      inArray(
        SS.subscriptionId,
        records.map((r) => r.sub.id),
      ),
    );
  const facts: ContractFacts[] = [];
  for (const { contract, sub, plan } of records) {
    const pricing = requirePricing(plan);
    const lifetime = await lifetimeOf(tx, sub);
    const liveFrom = sub.startedAt > goLiveAt ? sub.startedAt : goLiveAt;
    facts.push({
      organizationId,
      subscriptionId: sub.id,
      contractId: contract.id,
      planId: plan.id,
      currencyCode: plan.currencyCode,
      implementationFeeCents: pricing.implementationFeeCents,
      pricing: {
        perUserPriceCents: pricing.perUserPriceCents,
        bands: await loadBands(tx, plan.id),
        billingSoftwareBps: pricing.billingSoftwareBps,
        managedBillingBps: pricing.managedBillingBps,
        minimumMonthlyCents: pricing.minimumMonthlyCents,
      },
      modeHistory: histories.get(contract.id) ?? [],
      liveFrom,
      windows: liveWindowsOf({ liveFrom, ...lifetime }),
      statements: stored.filter((s) => s.subscriptionId === sub.id).map(toExisting),
    });
  }
  return facts;
}
