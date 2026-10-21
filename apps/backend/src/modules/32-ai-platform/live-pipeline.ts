// apps/backend/src/modules/32-ai-platform/live-pipeline.ts — compose the REAL `aiSdk.invoke` pipeline from
// the Drizzle stores M32-T02..T05 built and the bindings F-236 adds (ADR-0048).
//
// Until now the composition root never constructed the pipeline, so every §4.2 seam answered from its
// boot deny-stub. The blocker named at that call site was the per-tenant DEK cipher for
// `prompt_payload_cipher`; it exists now (invocation/payload-cipher.ts over M34's key provider). What this
// does NOT change: every gate still runs, in §6 order, on every call — `ai.full` (OFF for every tenant),
// lifecycle (the DocLens capabilities stay at DESIGN_REVIEW), kill switch, tenant opt-in, clinician
// opt-out, token cap (a tenant without `ai_token_budgets` refuses), PHI minimisation (only the DocLens
// capabilities have a ruleset), routing (only `healthy`/`degraded` registered backends with a bound
// adapter). Building the pipeline makes a governed call POSSIBLE; it makes none happen.
import { type ModelBackend, createModelBackendRegistry } from "@chartwarden/ai-platform";
import type { DbClient } from "@chartwarden/db";
import type { PlatformBypassAuditor } from "@chartwarden/tenancy";
import type { M32EventEmitter } from "./events";
import { createDrizzleAiTenantConsentStore } from "./governance/store-drizzle";
import { createRuleBasedAiChartContextValidator } from "./invocation/chart-context-rules";
import { type AiPayloadKeyProvider, createAiPayloadCipher } from "./invocation/payload-cipher";
import { type AiInvocationPipeline, createAiInvocationPipeline } from "./invocation/service";
import {
  createDrizzleAiBackendRegistryStore,
  createDrizzleAiInvocationCapabilityStore,
  createDrizzleAiInvocationLedgerStore,
  createDrizzleAiRoutingOverrideStore,
} from "./invocation/store-drizzle";
import { createOrganizationSettingsAiTokenBudgetResolver } from "./invocation/token-budget-settings";
import { createAiKillSwitchGate } from "./safety/service";
import { createDrizzleAiKillSwitchStore } from "./safety/store-drizzle";
import { M32_PLATFORM_JOB_ID } from "./wiring";

/** The pipeline's writes carry no acting user of their own (the seam's actor is ON the ledger row). */
const PIPELINE_SYSTEM_USER_ID = "";

export function buildLiveAiInvocationPipeline(deps: {
  readonly db: DbClient;
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly keys: AiPayloadKeyProvider;
  readonly flags: { forOrg(orgId: string): Promise<Readonly<Record<string, boolean>>> };
  readonly backends: readonly ModelBackend[];
  /** GAP-161 - the m32 outbox emitter; the pipeline's ledger, consent and override writes publish through it. */
  readonly events?: M32EventEmitter;
}): AiInvocationPipeline {
  return createAiInvocationPipeline({
    capabilities: createDrizzleAiInvocationCapabilityStore(deps.db),
    consent: createDrizzleAiTenantConsentStore({
      db: deps.db,
      userId: PIPELINE_SYSTEM_USER_ID,
      events: deps.events,
    }),
    backends: createDrizzleAiBackendRegistryStore(deps.db),
    overrides: createDrizzleAiRoutingOverrideStore({
      db: deps.db,
      userId: PIPELINE_SYSTEM_USER_ID,
      events: deps.events,
    }),
    ledger: createDrizzleAiInvocationLedgerStore({
      db: deps.db,
      userId: PIPELINE_SYSTEM_USER_ID,
      events: deps.events,
    }),
    flags: { readFlags: (orgId) => deps.flags.forOrg(orgId) },
    cipher: createAiPayloadCipher(deps.keys),
    killSwitch: createAiKillSwitchGate(
      createDrizzleAiKillSwitchStore({
        db: deps.db,
        platformDb: deps.platformDb,
        auditBypass: deps.auditBypass,
        jobId: M32_PLATFORM_JOB_ID,
        userId: PIPELINE_SYSTEM_USER_ID,
        events: deps.events,
      }),
    ),
    modelBackends: createModelBackendRegistry(deps.backends),
    tokenBudget: createOrganizationSettingsAiTokenBudgetResolver(deps.db),
    chartContext: createRuleBasedAiChartContextValidator(),
  });
}
