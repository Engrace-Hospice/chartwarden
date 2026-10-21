// apps/backend/src/modules/32-ai-platform/routes/index.ts — M32 route-service surface barrel.
//
// The composed `M32RouteServices` every route plugin takes, plus the Drizzle-backed read builder the
// composition root binds (the M15/M16/M19/M20/M21/M24/M25/M26 routes/index.ts precedent).
//
// M32's shape differs from those modules in one respect worth stating: there is no `writeService` here.
// The §4.1 WRITES already have services — M32-T03's governance commands, M32-T05's safety commands,
// M32-T05's prompt activation — each of which owns its own transaction and its own pure rule. A fourth
// write service wrapping them would be a layer whose only content is argument forwarding, and it would put
// a second place where a §2.2 gate could be forgotten. What T07 adds is the READ port for the six §4.1
// surfaces no command service owns (read-service.ts).
export type {
  AiBackendHealthView,
  AiDriftFindingView,
  AiHealthView,
  AiInvocationLedgerPage,
  AiInvocationLedgerView,
  AiInvocationSearchFilters,
  AiPlatformReadActor,
  AiTokenForecastView,
  AiTokenLedgerEntryView,
  AiTokenLedgerFilters,
  AiTokenLedgerPage,
  M32ReadService,
} from "./read-service";
export {
  AI_TERMINAL_EVALUATION_STATUSES,
  M32_PAGE_SIZES,
  clampLimit,
  maskInvocationForActor,
} from "./read-service";
export {
  type M32ReadDeps,
  M32_DEFAULT_DRIFT_LIMIT,
  M32_DEFAULT_SEARCH_WINDOW_DAYS,
  buildDrizzleM32ReadService,
  calendarMonthWindow,
} from "./read-service-drizzle";
export {
  type M32WriteActor,
  type PreHandler,
  PHI_FULL_READ_GRANT,
  actorOf,
  killSwitchScopeOf,
  locationOf,
  providerEntityOf,
  writeActorOf,
} from "./actor";
export {
  ABAC_ANY,
  ABAC_INVOCATION_ROW,
  ABAC_INVOCATION_SEARCH,
  ABAC_IN_ORG,
  ABAC_KILL_SWITCH_INACTIVE,
  ABAC_KILL_SWITCH_SCOPE,
  ABAC_SAFETY_OWNER,
  ABAC_SAFETY_OWNER_OR_IN_ORG,
  ABAC_TENANT_CONSENT,
  ABAC_TENANT_OPTED_IN,
  P,
  STEP_UP,
} from "./guards";
export { parse, parseQuery } from "./m32-typebox";

import type { AIPromptRegistry } from "@chartwarden/ai-platform";

import type { AiGovernanceServiceDeps } from "../governance/service";
import type { AiRoutingOverrideStore } from "../invocation/store";
import type { AiPromptServiceDeps } from "../prompts/service";
import type { AiSafetyServiceDeps } from "../safety/service";
import type { AiReportCipherPort } from "./hallucinations.routes";
import type { M32ReadService } from "./read-service";

/** The service surface every M32 route plugin composes over (bound at the composition root). */
export interface M32RouteServices {
  /** M32-T03's §2.2 / §5.3 / §5.4 commands (R1-R6, R10-R15). */
  readonly governance: AiGovernanceServiceDeps;
  /** M32-T05's kill-switch, hallucination and evaluation commands (R7-R9, R18-R20, R26-R28). */
  readonly safety: AiSafetyServiceDeps;
  /** M32-T05's prompt activation (R30). */
  readonly prompts: AiPromptServiceDeps;
  /** T07's read port for the six surfaces no command service owns (R16, R17, R21, R22, R31, R32). */
  readonly read: M32ReadService;
  /** M32-T04's `ai_routing_override` store (R23-R25). */
  readonly routing: AiRoutingOverrideStore;
  /** `null` ⇒ R18 refuses with 503 rather than writing cleartext into a `_cipher` column. */
  readonly cipher: AiReportCipherPort | null;
  /** GAP-161 - the §4.8 `ai:hallucination-triage-followup` producer (absent => plans are returned, not executed). */
  readonly followUpQueue?: import("../jobs/triage-followup-worker").TriageFollowUpEnqueuePort;
  /** The live §4.5 registry R29 reads through; `null` ⇒ R29 404s. */
  readonly promptRegistry: AIPromptRegistry | null;
  /** Injectable clock — the §10 tests pin the forecast window and the drift cut-off. */
  readonly now?: () => string;
}
