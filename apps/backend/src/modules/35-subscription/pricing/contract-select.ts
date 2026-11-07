// apps/backend/src/modules/35-subscription/pricing/contract-select.ts — THE ONE WAY slice 2 finds an organisation's contract.
//
// An organisation can hold more than one contract over time (a canceled subscription and the one signed after it), so "the contract of
// org X" is a question with an ORDER and a FILTER, and every consumer must ask it the same way or two of them will pick different rows
// and one silently never bills (the statement sweep once picked a canceled contract through an unordered LIMIT 1 and stopped billing).
// This file is the only place the question is asked; the statement sweep, the daily census (its sweep list AND its per-org backstop),
// the billing-service-mode seam, the platform and tenant views and the onboarding resume all call it.
//
//   scope "live"        a contract whose subscription is billable NOW: not canceled, not paused (the census records for these, and the
//                       mode seam answers for these)
//   scope "statements"  a contract that can still need a statement: every subscription not canceled (a paused one still owes the months
//                       before its pause), and a canceled one for POST_END_SETTLEMENT_MONTHS after it ended, so late-posting money is
//                       still billed on a settlement statement in the month it posts
//   scope "latest"      any contract, for a view
// Newest contract first (created_at, then id: total, so the order never depends on how the planner reads the table).
import { schema } from "@chartwarden/db";
import { type SQL, and, desc, eq, gte, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import type { PlatformRunner, WriteTx } from "../routes/service-drizzle";
import type { ModeHistoryRow } from "./contract-mode";

const SC = schema.subscriptionContract;
const SCM = schema.subscriptionContractMode;
const SUB = schema.subscriptionRow;
const PL = schema.plan;

/** How long after a subscription ended it is still scanned for money that posts late (billed on a settlement statement). */
export const POST_END_SETTLEMENT_MONTHS = 12;

export type ContractScope = "live" | "statements" | "latest";

/**
 * The contract columns EVERY reader may see: the tenant role holds a COLUMN-level SELECT on exactly these (migration 1362), never on who
 * signed, why, or the order form. The signature facts are read separately, on a platform transaction (`contract-service.ts`).
 */
const CONTRACT_COLUMNS = {
  id: SC.id,
  organizationId: SC.organizationId,
  subscriptionId: SC.subscriptionId,
  planId: SC.planId,
  contractStartOn: SC.contractStartOn,
  createdAt: SC.createdAt,
} as const;

export interface ContractCore {
  readonly id: string;
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly planId: string;
  readonly contractStartOn: string;
  readonly createdAt: Date;
}

export interface ContractRecord {
  readonly contract: ContractCore;
  readonly sub: typeof SUB.$inferSelect;
  readonly plan: typeof PL.$inferSelect;
}

function scopeFilter(scope: ContractScope, at: Date): SQL | undefined {
  if (scope === "live") return notInArray(SUB.status, ["canceled", "paused"]);
  if (scope === "statements") {
    const cutoff = new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - POST_END_SETTLEMENT_MONTHS, 1),
    );
    return or(ne(SUB.status, "canceled"), isNull(SUB.canceledAt), gte(SUB.canceledAt, cutoff));
  }
  return undefined;
}

/** The contracts of one org (or of every org when `organizationId` is omitted, on a platform transaction), newest first. */
export async function selectContracts(
  tx: WriteTx,
  scope: ContractScope,
  at: Date,
  organizationId?: string,
): Promise<ContractRecord[]> {
  const filters = [
    scopeFilter(scope, at),
    organizationId ? eq(SC.organizationId, organizationId) : undefined,
  ].filter((f): f is SQL => f !== undefined);
  const rows = await tx
    .select({ contract: CONTRACT_COLUMNS, sub: SUB, plan: PL })
    .from(SC)
    .innerJoin(SUB, eq(SUB.id, SC.subscriptionId))
    .innerJoin(PL, eq(PL.id, SC.planId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(SC.createdAt), desc(SC.id));
  return rows;
}

/** The newest contract of the org in the scope, or null. */
export async function selectNewestContract(
  tx: WriteTx,
  scope: ContractScope,
  at: Date,
  organizationId: string,
): Promise<ContractRecord | null> {
  return (await selectContracts(tx, scope, at, organizationId))[0] ?? null;
}

/** The orgs that have a contract in the scope: ONE platform transaction for a whole sweep (every runner call is an audited bypass). */
export async function listContractedOrgIds(
  runner: PlatformRunner,
  scope: ContractScope,
  at: Date,
): Promise<ReadonlySet<string>> {
  const rows = await runner((tx) => selectContracts(tx, scope, at));
  return new Set(rows.map((r) => r.contract.organizationId));
}

/** The billing service mode history of the given contracts, grouped by contract id. */
export async function loadModeHistory(
  tx: WriteTx,
  contractIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ModeHistoryRow[]>> {
  const byContract = new Map<string, ModeHistoryRow[]>();
  if (contractIds.length === 0) return byContract;
  const rows = await tx
    .select({
      contractId: SCM.contractId,
      billingServiceMode: SCM.billingServiceMode,
      effectiveFrom: SCM.effectiveFrom,
      createdAt: SCM.createdAt,
    })
    .from(SCM)
    .where(inArray(SCM.contractId, [...contractIds]));
  for (const { contractId, ...row } of rows) {
    byContract.set(contractId, [...(byContract.get(contractId) ?? []), row]);
  }
  return byContract;
}
