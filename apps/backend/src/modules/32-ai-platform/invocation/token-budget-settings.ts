// apps/backend/src/modules/32-ai-platform/invocation/token-budget-settings.ts — the `AiTokenBudgetResolver`
// over the tenant's registered `ai_token_budgets` organization setting (F-236).
//
// `createUnconfiguredAiTokenBudgetResolver` answered `null` for everything because no authority stated
// where a budget lives. It now lives on the tenant's own configuration (`organization.settings`, key
// registered by `settings-by-m32.ts`). The posture is unchanged: an org with no setting, or a capability
// missing from it, is `budget_unconfigured`, which the cap gate REFUSES. A setting that fails its schema
// also resolves to `null` (refuse), never to a guessed figure.
import { type AiTokenBudget, aiTokenBudgetFor } from "@wardenx/ai-platform";
import { type DbClient, organizationSettingsReader, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";
import type { AiTokenBudgetResolver } from "./store";

type Budgets = Record<string, { hardCapTokens: number; softCapTokens?: number }> | null;

export function createOrganizationSettingsAiTokenBudgetResolver(
  db: DbClient,
): AiTokenBudgetResolver {
  return {
    async budgetFor(organizationId, capabilityKey): Promise<AiTokenBudget | null> {
      const settings = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [row] = await (tx as DbClient)
          .select({ settings: schema.organizations.settings })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, organizationId))
          .limit(1);
        return (row?.settings ?? null) as Record<string, unknown> | null;
      });
      let budgets: Budgets;
      try {
        budgets = organizationSettingsReader.get<Budgets>(settings, "ai_token_budgets");
      } catch {
        return null; // a malformed setting refuses; it never becomes a figure
      }
      const entry = budgets?.[capabilityKey];
      return entry ? aiTokenBudgetFor(entry.hardCapTokens, entry.softCapTokens ?? null) : null;
    },
  };
}
