// apps/backend/src/modules/32-ai-platform/jobs/token-ledger-rollup.ts - M32 §4.8 `ai:token-ledger-rollup`
// (GAP-161).
//
// Hourly, idempotent: for every active org and every capability that accrued tokens in the CURRENT cap window,
// compare the month-to-date spend with the org's configured budget (`ai_token_budgets` org setting) and raise the
// §4.9 `ai.token_soft_cap_warning` / `ai.token_hard_cap_breached` alert. The per-invocation hard-cap REFUSAL stays
// in the invocation pipeline (the cap is enforced where the spend happens); what had no producer anywhere was the
// alert, which is this job's output. The alert is STATE-based (it restates a standing breach each tick); the
// 24-hour dedup M36 applies to token-cap alerts (section 13.8) is what keeps the hourly restatement from paging
// hourly.
// Accruals are already written in the invocation's own transaction (`ai_token_ledger`), so there is nothing to
// re-aggregate - the rollup reads and alerts; an org with no configured budget raises nothing (a missing budget is
// not a breach; the pipeline already refuses those calls as `budget_unconfigured`).
import {
  type AiTokenBudget,
  aiTokenCapStateFor,
  aiTokenCapWindowFor,
} from "@chartwarden/ai-platform";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, gte, sql } from "drizzle-orm";
import { type AiAlertPort, type M32AlertPayload, emitAiAlert } from "../alerts";

export const M32_TOKEN_ROLLUP_QUEUE = "ai-token-ledger-rollup";
/** Hourly, on the hour (spec §4.8: "M32 cron scheduler (hourly)"). */
export const M32_TOKEN_ROLLUP_SCHEDULE = "0 * * * *";

export interface CapabilitySpend {
  readonly capabilityId: string;
  readonly capabilityKey: string;
  readonly spentTokens: number;
}

/** PURE - the alert (if any) one capability's month-to-date spend warrants. */
export function tokenCapAlertFor(input: {
  readonly organizationId: string;
  readonly spend: CapabilitySpend;
  readonly budget: AiTokenBudget | null;
  readonly window: { readonly start: string; readonly end: string };
}): M32AlertPayload | null {
  const { organizationId, spend, budget, window } = input;
  const state = aiTokenCapStateFor({ spentTokens: spend.spentTokens, budget });
  if (state === "hard_breached" && budget) {
    return {
      alertType: "ai.token_hard_cap_breached",
      organizationId,
      capabilityId: spend.capabilityId,
      capabilityKey: spend.capabilityKey,
      spentTokens: spend.spentTokens,
      hardCap: budget.hardCapTokens,
      fallbackEngaged: true,
      windowStart: window.start,
      windowEnd: window.end,
    };
  }
  if (state === "soft_breached" && budget) {
    return {
      alertType: "ai.token_soft_cap_warning",
      organizationId,
      capabilityId: spend.capabilityId,
      capabilityKey: spend.capabilityKey,
      spentTokens: spend.spentTokens,
      softCap: budget.softCapTokens,
      windowStart: window.start,
      windowEnd: window.end,
    };
  }
  return null;
}

export interface TokenRollupDeps {
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  /** Month-to-date spend per capability for the org, inside the given window (RLS-scoped, org-explicit). */
  readonly spendForOrg: (
    organizationId: string,
    window: { readonly start: string; readonly end: string },
  ) => Promise<readonly CapabilitySpend[]>;
  readonly budgetFor: (
    organizationId: string,
    capabilityKey: string,
  ) => Promise<AiTokenBudget | null>;
  readonly alerts?: AiAlertPort | null;
  readonly now?: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface TokenRollupSummary {
  readonly orgs: number;
  readonly alerts: number;
  readonly undelivered: number;
  readonly failedOrgs: number;
}

export async function runTokenLedgerRollup(deps: TokenRollupDeps): Promise<TokenRollupSummary> {
  const window = aiTokenCapWindowFor((deps.now ?? (() => new Date()))().toISOString());
  let alerts = 0;
  let undelivered = 0;
  let failedOrgs = 0;
  const orgs = await deps.listActiveOrgs();
  for (const { organizationId } of orgs) {
    try {
      for (const spend of await deps.spendForOrg(organizationId, window)) {
        const payload = tokenCapAlertFor({
          organizationId,
          spend,
          budget: await deps.budgetFor(organizationId, spend.capabilityKey),
          window,
        });
        if (payload === null) continue;
        alerts += 1;
        if (!(await emitAiAlert(payload, deps.alerts))) undelivered += 1;
      }
    } catch (error) {
      failedOrgs += 1;
      deps.warn?.("m32.token_ledger_rollup: org pass failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { orgs: orgs.length, alerts, undelivered, failedOrgs };
}

/** The Drizzle spend read: one grouped aggregate per org over the window's `ai_token_ledger` rows. */
export function buildSpendReader(db: DbClient): TokenRollupDeps["spendForOrg"] {
  return (organizationId, window) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const L = schema.aiTokenLedger;
      const rows = await (tx as DbClient)
        .select({
          capabilityId: L.capabilityId,
          capabilityKey: schema.aiCapability.capabilityKey,
          spent: sql<string>`coalesce(sum(${L.inputTokens} + ${L.outputTokens}), 0)`,
        })
        .from(L)
        .innerJoin(schema.aiCapability, eq(schema.aiCapability.id, L.capabilityId))
        .where(
          and(
            eq(L.organizationId, organizationId),
            gte(L.accruedAt, new Date(window.start)),
            sql`${L.accruedAt} < ${new Date(window.end)}`,
          ),
        )
        .groupBy(L.capabilityId, schema.aiCapability.capabilityKey);
      return rows.map((r) => ({
        capabilityId: r.capabilityId,
        capabilityKey: r.capabilityKey,
        spentTokens: Number(r.spent),
      }));
    });
}

export function registerM32TokenRollupWorker(
  deps: TokenRollupDeps & { readonly connection: ConnectionOptions },
): Worker {
  // §4.8: concurrency 1 (idempotent).
  return new Worker(M32_TOKEN_ROLLUP_QUEUE, async () => runTokenLedgerRollup(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleM32TokenRollupJob(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M32_TOKEN_ROLLUP_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M32_TOKEN_ROLLUP_SCHEDULE },
      // §4.8 retention: success 24h, failed 30d.
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  );
  return queue;
}
