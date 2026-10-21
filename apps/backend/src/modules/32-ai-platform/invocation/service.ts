// apps/backend/src/modules/32-ai-platform/invocation/service.ts — `aiSdk.invoke` (§4.1), M32-T04.
//
// The entry point every consumer-module AI call goes through: gates → route → dispatch → token capture
// → `ai_invocation` row. The ORDER lives in `evaluateAiInvocationGates` (pure, `@chartwarden/ai-platform`),
// the ROUTE in `resolveAiRoute`, the CAP in `aiTokenCapStateFor`; this file resolves the facts those
// three need and performs the writes their decisions imply. No rule is decided here.
//
// ── IT NEVER THROWS TO SAY "NO AI" ────────────────────────────────────────────────────────────────
//
// §4.2's seams and D7 both insist: absence is a first-class result, and a refused capability must reach
// the consumer as a value it can branch on, never as an exception it has to remember to catch (the
// M20-T01 finding on synchronous deny-stub throws). So every refusal — flag off, kill switch, opt-out,
// hard cap, unhealthy backend, vendor error, timeout — returns `{ available: false, ... }`. The only
// throws that escape are programmer errors (a store that cannot reach the database).
//
// ── RECORD-ONCE, BECAUSE §3.5 SAYS SO ─────────────────────────────────────────────────────────────
//
// §3.5's immutability trigger freezes `input_token_count`, `output_token_count`,
// `response_payload_cipher`, `model_version_pin` and `zdr_confirmed` against every UPDATE. So the
// intuitive shape — insert the row before dispatching, close it after — is not available: the row
// cannot be opened empty and filled in. It is written ONCE, at the end, with the outcome known.
//
// The consequence is stated in `store.ts` and repeated here because it is the sharpest edge in this
// file: a process killed between the vendor answering and the insert leaves a real disclosure with no
// ledger row. Every terminal outcome is therefore funnelled through ONE `record()` call at the bottom
// of a single try/catch, so the unrecorded window is one `await` wide.
//
// ── FOUR PORTS ARE DELIBERATELY UNBOUND OR REFUSING IN PHASE 1 ───────────────────────────────────
//
//   · `killSwitch`        — REQUIRED with no default. M32-T05 owns `ai_kill_switch_state`; until it
//                           lands, the pipeline cannot be CONSTRUCTED without one. A default that
//                           answered "not killed" would be a gate that looks wired and is not, and the
//                           direction that fails is the one where a SEV-1 kill does nothing.
//   · `chartContext`      — the §8.3 PHI-minimisation validator. Defaults to
//                           `createDenyingAiChartContextValidator()`: an unbound ruleset REFUSES, since
//                           this gate's entire job is to stop caller-supplied PHI reaching a vendor.
//   · `tokenBudget`       — defaults to `createUnconfiguredAiTokenBudgetResolver()`, which refuses (no
//                           authority states a default budget figure — see `token-cap.ts`).
//   · `modelBackends`     — the Phase-1 registry is EMPTY, so a routed backend resolves to no adapter
//                           and the call refuses. `ai.full` is off anyway; this is the second line.
//
// `cipher` is required outright: a pipeline that could be built without an envelope-encryption binding
// is a pipeline that could write plaintext PHI into `prompt_payload_cipher`.
import { createHash } from "node:crypto";
import {
  type AiInvocationGate,
  type AiInvocationGateDecision,
  type AiPhiMinimizationVerdict,
  type AiResolvedRoute,
  type AiTokenCapState,
  type ModelBackendImage,
  type ModelBackendRegistry,
  aiInvocationGateRecordsLedgerRow,
  aiTokenCapStateFor,
  aiTokenCapWindowFor,
  aiTokenSoftCapCrossedBy,
  evaluateAiInvocationGates,
  resolveAiRoute,
} from "@chartwarden/ai-platform";
import type {
  AiCapabilityLifecycleState,
  AiCapabilityUnavailable,
  AiConsumerContextRef,
  AiInvocationHitlOutcome,
  AiInvocationStatus,
  AiModelModality,
  AiRoutingPreference,
} from "@chartwarden/types";
import { AI_FULL_FLAG } from "@chartwarden/types";

import type { AiTenantConsentStore } from "../governance/store";
import type {
  AiBackendRegistryStore,
  AiInvocationInsert,
  AiInvocationLedgerStore,
  AiRoutingOverrideStore,
  AiTokenBudgetResolver,
} from "./store";
import { createUnconfiguredAiTokenBudgetResolver } from "./store";

// ── the ports T04 declares ─────────────────────────────────────────────────────────────────────────

/** The `ai_capability` columns the pipeline reads. Narrower than T03's governance projection and
 *  wider in exactly two places (`fallbackChainKeys`, `tenantOverrideAllowed`) — the routing columns a
 *  governance gate has no business seeing. */
export interface AiInvocationCapabilityRow {
  readonly id: string;
  readonly capabilityKey: string;
  readonly lifecycleState: AiCapabilityLifecycleState;
  readonly defaultBackendKey: string;
  readonly allowedBackendKeys: readonly string[];
  readonly fallbackChainKeys: readonly string[];
  readonly tenantOverrideAllowed: boolean;
  readonly tenantOptInRequired: boolean;
  readonly currentPromptTemplateKey: string | null;
  /** `null` when the capability declares no modality requirement. */
  readonly requiredModality: AiModelModality | null;
}

/** Resolves a capability key to the row above. */
export interface AiInvocationCapabilityStore {
  findByKey(capabilityKey: string): Promise<AiInvocationCapabilityRow | null>;
}

/** §3.2.12 — M32-T05's gate, at its §6.2 position. Required; see the header. */
export interface AiKillSwitchGate {
  isActive(organizationId: string, capabilityId: string): Promise<boolean>;
}

/** §8.3 — the per-capability chart-context ruleset. */
export interface AiChartContextValidator {
  validate(
    capabilityKey: string,
    chartContext: Record<string, unknown>,
  ): Promise<AiPhiMinimizationVerdict> | AiPhiMinimizationVerdict;
}

/**
 * The Phase-1 validator: refuses everything.
 *
 * The §8.3 TypeBox schemas are a later task. Until they exist there is no ruleset to check a caller's
 * chart context against, and the fail-open alternative would hand arbitrary caller-supplied fields to a
 * model vendor under a gate whose name says it prevented exactly that.
 */
export function createDenyingAiChartContextValidator(): AiChartContextValidator {
  return {
    validate: (capabilityKey) => ({
      permitted: false,
      detail: `no §8.3 chart-context schema is registered for capability '${capabilityKey}'; the PHI-minimisation gate refuses rather than forwarding unvalidated context`,
    }),
  };
}

/** §3.6 — M1's per-tenant-DEK envelope encryption, as this pipeline needs it. */
export interface AiPayloadCipher {
  encrypt(organizationId: string, plaintext: string): Promise<Buffer>;
}

/** The `ai.full` read. A flag store that cannot answer must read as OFF. */
export interface AiFeatureFlagReader {
  readFlags(organizationId: string): Promise<Readonly<Record<string, boolean>>>;
}

// ── request / outcome ──────────────────────────────────────────────────────────────────────────────

/** One `aiSdk.invoke` call. */
export interface AiInvokeRequest {
  readonly capabilityKey: string;
  readonly organizationId: string;
  /**
   * ARCH-011: `ai_invocation.provider_entity_id` is NOT NULL because a disclosure accounting has to name
   * WHICH certified provider entity disclosed the PHI — "the tenant" is not an answer a surveyor takes.
   * The consumer module resolves it from the parent entity; M32 will not guess it.
   */
  readonly providerEntityId: string;
  readonly locationId?: string | null;
  readonly actorMembershipId: string;
  readonly actorRole: string;
  /** Absent for a non-patient-scoped surface. Its presence IS §3.2.8's PHI indicator. */
  readonly patientId?: string | null;
  readonly consumerCorrelationId?: string | null;
  readonly consumerContextRef: AiConsumerContextRef;
  readonly prompt: {
    readonly text: string;
    readonly systemPrompt?: string | null;
    readonly templateId?: string | null;
    readonly templateVersion?: string | null;
  };
  readonly chartContext: Record<string, unknown>;
  readonly maxOutputTokens?: number;
  /** F-236 — a JSON Schema the backend must constrain its answer to (structured outputs). The caller's
   *  projector still validates the answer; this only narrows what the model may emit. */
  readonly responseSchema?: Record<string, unknown>;
  /** F-236 — overrides the pipeline's dispatch timeout for THIS call. A background capability (DocLens
   *  extraction on a local model) needs minutes; the clinician-facing default stays what it was. */
  readonly dispatchTimeoutMs?: number;
  /**
   * F-237 — images for a vision capability. Their presence makes `vision` the required modality at the
   * routing gate (a text-only backend in the chain is filtered out). The ledger records each image's
   * SHA-256 inside the encrypted prompt payload, never the bytes.
   */
  readonly images?: readonly ModelBackendImage[];
  /** From the caller's session clock; the partition key and the cap window both derive from it. */
  readonly invokedAt: string;
}

/** What a completed invocation hands back. */
export interface AiInvocationOutput {
  readonly text: string;
  readonly modelVersionPin: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The pipeline's answer. Absence is a value here, never an exception (see the header). */
export type AiInvocationOutcome =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly invokedAt: string;
      readonly route: AiResolvedRoute;
      readonly output: AiInvocationOutput;
      readonly tokenCapState: AiTokenCapState;
      /** W1.7 — this accrual is the one that crossed the soft cap. M32-T07 turns it into the alert. */
      readonly softCapCrossed: boolean;
    }
  | {
      readonly available: false;
      readonly unavailable: AiCapabilityUnavailable;
      /** Operator-facing; never PHI. */
      readonly detail: string;
      /** Which gate decided — the ledger's `error_class` and the first question an operator asks. */
      readonly gate: AiInvocationGate;
      /** `null` when no `ai_invocation` row could be written (see `ledgerRecorded`). */
      readonly invocationId: string | null;
      /**
       * FALSE means the §164.528 ledger has NO row for this refusal, and that is always one of two
       * stated cases: the `ai.full` gate (which records nothing by design) or a call for which no
       * truthful backend could be named. Never a silent drop.
       */
      readonly ledgerRecorded: boolean;
    };

/** Everything the pipeline is composed from. */
export interface AiInvocationPipelineDeps {
  readonly capabilities: AiInvocationCapabilityStore;
  readonly consent: AiTenantConsentStore;
  readonly backends: AiBackendRegistryStore;
  readonly overrides: AiRoutingOverrideStore;
  readonly ledger: AiInvocationLedgerStore;
  readonly flags: AiFeatureFlagReader;
  readonly cipher: AiPayloadCipher;
  /** Required — see the header. */
  readonly killSwitch: AiKillSwitchGate;
  readonly modelBackends: ModelBackendRegistry;
  readonly tokenBudget?: AiTokenBudgetResolver;
  readonly chartContext?: AiChartContextValidator;
  /** §9.2's p95 latency budget for the hot capability is 4000ms; the default leaves headroom for a
   *  cloud round trip while still bounding the clinician's wait. */
  readonly dispatchTimeoutMs?: number;
  readonly now?: () => Date;
}

/** M32's invocation SDK. */
export interface AiInvocationPipeline {
  invoke(request: AiInvokeRequest): Promise<AiInvocationOutcome>;
  /** The one legal post-hoc write (§3.5): the consumer records the human's accept/edit/reject. */
  recordHitlOutcome(
    organizationId: string,
    invocationId: string,
    invokedAt: string,
    outcome: AiInvocationHitlOutcome,
  ): Promise<void>;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

/** Build the pipeline. */
export function createAiInvocationPipeline(deps: AiInvocationPipelineDeps): AiInvocationPipeline {
  const tokenBudget = deps.tokenBudget ?? createUnconfiguredAiTokenBudgetResolver();
  const chartContextValidator = deps.chartContext ?? createDenyingAiChartContextValidator();
  const timeoutMs = deps.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  const clock = deps.now ?? (() => new Date());

  async function aiFullEnabled(organizationId: string): Promise<boolean> {
    try {
      const flags = await deps.flags.readFlags(organizationId);
      return flags[AI_FULL_FLAG] === true;
    } catch {
      // An unreachable flag store reads as all-off. The M16 precedent, and the only safe direction:
      // "we could not ask whether AI is enabled" must never resolve to "yes".
      return false;
    }
  }

  return {
    recordHitlOutcome: (organizationId, invocationId, invokedAt, outcome) =>
      deps.ledger.recordHitlOutcome(organizationId, invocationId, invokedAt, outcome),

    async invoke(request: AiInvokeRequest): Promise<AiInvocationOutcome> {
      // ── gate 0, short-circuited ─────────────────────────────────────────────────────────────────
      // The pure evaluator also holds this gate at position 0 and there is a test that proves the two
      // agree; the short circuit exists so a wave that refuses every call does not do six lookups to
      // say so, and so no capability row is read for a platform that runs no AI.
      const flagOn = await aiFullEnabled(request.organizationId);
      if (!flagOn) {
        return {
          available: false,
          unavailable: { status: "capability_unavailable", reason: "phase_1_capability_shell" },
          detail: "the 'ai.full' feature flag is off; ChartWarden dispatches no AI in Phase 1",
          gate: "ai_full_flag",
          invocationId: null,
          ledgerRecorded: false,
        };
      }

      const capability = await deps.capabilities.findByKey(request.capabilityKey);
      if (capability === null) {
        // The M32-T03 posture, verbatim: an unknown key answers as a RETIRED capability rather than a
        // 404, so a consumer cannot enumerate the registry by probing keys. No `capability_id` exists,
        // so no ledger row can exist either — `ai_invocation.capability_id` is NOT NULL with a real FK.
        return {
          available: false,
          unavailable: { status: "capability_unavailable", reason: "lifecycle_state_retired" },
          detail: "no such capability",
          gate: "lifecycle",
          invocationId: null,
          ledgerRecorded: false,
        };
      }

      // ── the facts ────────────────────────────────────────────────────────────────────────────────
      const [killSwitchActive, optIn, optOut, override] = await Promise.all([
        deps.killSwitch.isActive(request.organizationId, capability.id),
        deps.consent.findOptIn(request.organizationId, capability.id),
        deps.consent.findLiveOptOut(
          request.organizationId,
          request.actorMembershipId,
          capability.id,
        ),
        deps.overrides.findActiveOverride(request.organizationId, capability.id, request.invokedAt),
      ]);

      const routingPreference: AiRoutingPreference | null =
        optIn?.routingPreferenceSnapshot ?? null;

      const chainKeys = [
        capability.defaultBackendKey,
        ...capability.fallbackChainKeys,
        ...(override === null ? [] : [override.backendKeyPreference]),
      ];
      const backends = await deps.backends.findBackendsByKey(chainKeys);

      const route = resolveAiRoute({
        capability: {
          defaultBackendKey: capability.defaultBackendKey,
          allowedBackendKeys: capability.allowedBackendKeys,
          fallbackChainKeys: capability.fallbackChainKeys,
          tenantOverrideAllowed: capability.tenantOverrideAllowed,
          requiredModality: request.images?.length ? "vision" : capability.requiredModality,
        },
        routingPreference,
        override,
        backends,
      });

      const window = aiTokenCapWindowFor(request.invokedAt);
      const [spentTokens, budget] = await Promise.all([
        deps.ledger.sumTokensInWindow(request.organizationId, capability.id, window),
        tokenBudget.budgetFor(request.organizationId, capability.capabilityKey),
      ]);
      const tokenCapState = aiTokenCapStateFor({ spentTokens, budget });

      const phiMinimization = await chartContextValidator.validate(
        capability.capabilityKey,
        request.chartContext,
      );

      const decision = evaluateAiInvocationGates({
        aiFullEnabled: flagOn,
        lifecycleState: capability.lifecycleState,
        killSwitchActive,
        tenantOptInRequired: capability.tenantOptInRequired,
        tenantOptInStatus: optIn?.status ?? null,
        tenantPilotEnrollment: optIn?.pilotEnrollment ?? false,
        clinicianOptedOut: optOut !== null,
        tokenCapState,
        phiMinimization,
        route,
      });

      if (!decision.dispatch) {
        return refused(request, capability, decision);
      }

      // ── dispatch ─────────────────────────────────────────────────────────────────────────────────
      const backend = deps.modelBackends.get(decision.route.backendKey);
      if (backend === null || backend.complete === undefined) {
        // A registry row with no bound adapter, or an adapter that does not do text. The routing gate
        // already filtered on `supported_modalities`, so reaching here means the REGISTRY and the bound
        // adapters disagree — an operator-visible configuration fault, recorded as such.
        return refused(request, capability, {
          dispatch: false,
          gate: "routing",
          unavailable: { status: "capability_unavailable", reason: "backend_unhealthy" },
          detail: `backend '${decision.route.backendKey}' is registered but no model adapter is bound to it`,
          ledgerRoute: decision.route,
        });
      }

      const startedAt = clock().getTime();
      let status: AiInvocationStatus = "failed";
      let errorClass: string | null = null;
      let output: AiInvocationOutput | null = null;

      try {
        const result = await withTimeout(
          backend.complete({
            organizationId: request.organizationId,
            systemPrompt: request.prompt.systemPrompt ?? null,
            prompt: request.prompt.text,
            chartContext: request.chartContext,
            maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
            ...(request.images?.length ? { images: request.images } : {}),
          }),
          request.dispatchTimeoutMs ?? timeoutMs,
        );
        if (result === TIMED_OUT) {
          status = "timed_out";
          errorClass = "dispatch_timeout";
        } else {
          status = "completed";
          output = {
            text: result.text,
            // The pin the BACKEND echoed, not the one the registry expected — a drifted pin is a
            // finding, and the ledger has to be able to show it.
            modelVersionPin: result.modelVersionPin,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          };
        }
      } catch (error) {
        status = "failed";
        // The CLASS, never the message: a vendor error string can echo the prompt back, and §3.4
        // denylists `error_message` precisely because "we strip PHI from it" is an assertion about a
        // code path rather than a property of the column. Storing nothing needs no assertion.
        errorClass = error instanceof Error ? error.name : "unknown_error";
      }

      const completedAt = clock();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt);

      const promptCipher = await deps.cipher.encrypt(
        request.organizationId,
        JSON.stringify({
          systemPrompt: request.prompt.systemPrompt ?? null,
          prompt: request.prompt.text,
          ...(request.images?.length
            ? {
                images: request.images.map((i) => ({
                  mediaType: i.mediaType,
                  sha256: createHash("sha256").update(i.dataBase64, "base64").digest("hex"),
                })),
              }
            : {}),
        }),
      );
      const chartCipher = await deps.cipher.encrypt(
        request.organizationId,
        JSON.stringify(request.chartContext),
      );
      const responseCipher =
        output === null
          ? null
          : await deps.cipher.encrypt(
              request.organizationId,
              JSON.stringify({ text: output.text }),
            );

      const recorded = await deps.ledger.recordInvocation(
        {
          ...baseRow(request, capability, decision.route),
          promptPayloadCipher: promptCipher,
          responsePayloadCipher: responseCipher,
          chartContextCipher: chartCipher,
          inputTokenCount: output?.inputTokens ?? 0,
          outputTokenCount: output?.outputTokens ?? 0,
          durationMs,
          status,
          errorClass,
          errorMessage: null,
          completedAt: completedAt.toISOString(),
        },
        output === null
          ? // No accrual for a failed or timed-out call: the token counts are UNKNOWN, not zero, and a
            // zero row in a spend ledger asserts a measurement nobody made. If the vendor did bill for
            // a partial generation, the reconciliation against the invoice is where that surfaces —
            // which is only possible if this table never contains a fabricated zero.
            null
          : {
              capabilityId: capability.id,
              backendId: decision.route.backendId,
              vendorRateAtInvocation: null,
              inputTokens: output.inputTokens,
              outputTokens: output.outputTokens,
              cloudCostUsd: null,
              localComputeAttribution: null,
              accruedAt: request.invokedAt,
            },
      );

      if (output === null) {
        return {
          available: false,
          unavailable: { status: "capability_unavailable", reason: "backend_unhealthy" },
          detail: `dispatch to '${decision.route.backendKey}' ended '${status}' (${errorClass ?? "unknown"})`,
          gate: "routing",
          invocationId: recorded.invocationId,
          ledgerRecorded: true,
        };
      }

      return {
        available: true,
        invocationId: recorded.invocationId,
        invokedAt: recorded.invokedAt,
        route: decision.route,
        output,
        tokenCapState,
        softCapCrossed: aiTokenSoftCapCrossedBy({
          spentTokensBefore: spentTokens,
          accruedTokens: output.inputTokens + output.outputTokens,
          budget,
        }),
      };
    },
  };

  /** Record a gate refusal and shape the outcome. The ONE place a refusal becomes a row. */
  async function refused(
    request: AiInvokeRequest,
    capability: AiInvocationCapabilityRow,
    decision: Extract<AiInvocationGateDecision, { dispatch: false }>,
  ): Promise<AiInvocationOutcome> {
    const base = {
      available: false as const,
      unavailable: decision.unavailable,
      detail: decision.detail,
      gate: decision.gate,
    };

    if (!aiInvocationGateRecordsLedgerRow(decision.gate) || decision.ledgerRoute === null) {
      return { ...base, invocationId: null, ledgerRecorded: false };
    }

    const recorded = await deps.ledger.recordInvocation(
      {
        ...baseRow(request, capability, decision.ledgerRoute),
        // W2.4 — "no payload". The prompt cipher is NOT NULL, so the refusal writes the empty bytea:
        // the same sentinel §3.7's shred uses, and the only value that says "there is nothing here"
        // without encrypting a payload that was never allowed to be built.
        promptPayloadCipher: Buffer.alloc(0),
        responsePayloadCipher: null,
        chartContextCipher: null,
        inputTokenCount: 0,
        outputTokenCount: 0,
        durationMs: 0,
        // §3.1's `ai_invocation_status` has no `gate_blocked` member (W2.4's wording predates the enum);
        // `capability_unavailable` IS the recorded gate refusal, and the gate that produced it lands in
        // `error_class` — a code, not a message, so nothing PHI-adjacent enters the ledger.
        status: "capability_unavailable",
        errorClass: decision.unavailable.reason,
        errorMessage: null,
        completedAt: request.invokedAt,
      },
      // No accrual: a refused call spent nothing, and the ledger is the SPEND record. The evidence that
      // the availability check happened is the `ai_invocation` row itself.
      null,
    );

    return { ...base, invocationId: recorded.invocationId, ledgerRecorded: true };
  }

  function baseRow(
    request: AiInvokeRequest,
    capability: AiInvocationCapabilityRow,
    route: AiResolvedRoute,
  ): Omit<
    AiInvocationInsert,
    | "promptPayloadCipher"
    | "responsePayloadCipher"
    | "chartContextCipher"
    | "inputTokenCount"
    | "outputTokenCount"
    | "durationMs"
    | "status"
    | "errorClass"
    | "errorMessage"
    | "completedAt"
  > {
    return {
      organizationId: request.organizationId,
      providerEntityId: request.providerEntityId,
      locationId: request.locationId ?? null,
      capabilityId: capability.id,
      capabilityKey: capability.capabilityKey,
      promptTemplateId: request.prompt.templateId ?? null,
      promptTemplateVersion: request.prompt.templateVersion ?? null,
      backendId: route.backendId,
      backendKey: route.backendKey,
      modelVersionPin: route.modelVersionPin,
      actorMembershipId: request.actorMembershipId,
      actorRole: request.actorRole,
      patientId: request.patientId ?? null,
      consumerCorrelationId: request.consumerCorrelationId ?? null,
      consumerContextRef: { ...request.consumerContextRef },
      routingDecision: route.decision,
      routingReason: route.reason,
      // §3.2.8's `ai_invocation_zdr_check` refuses an `anthropic-%` row without it. The value is the
      // REGISTRY's claim about the backend that served (or would have), which is knowable without
      // dispatching — which is what lets a refused call carry a truthful one.
      zdrConfirmed: route.zdrConfirmed,
      invokedAt: request.invokedAt,
    };
  }
}

const TIMED_OUT = Symbol("ai-dispatch-timeout");

/**
 * Race a dispatch against the clinician's patience.
 *
 * Resolves to `TIMED_OUT` rather than throwing so the timeout is a STATUS (`timed_out`, the §3.1 enum
 * member that otherwise nothing could produce) instead of an indistinguishable member of the `failed`
 * bucket. The in-flight request is not cancelled — the vendor may still answer, and if it does the
 * disclosure happened; the row already records the attempt, which is what §164.528 needs.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
