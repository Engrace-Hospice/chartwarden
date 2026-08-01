// @wardenx/ai-platform — the Anthropic vendor adapter and its D19 / §8.4 ZDR invariant (M32-T04).
//
// ── THIS FILE IS THE VENDOR-ADAPTER MANDATE'S ADDRESS ──────────────────────────────────────────────
//
// `VENDOR_ADAPTERS['@anthropic-ai/sdk'] = 'packages/ai-platform'` in `architecture/module-manifest.ts`
// (architecture §25.14) makes `packages/ai-platform` the only path in the monorepo where that import
// may appear, and dependency-cruiser fails the build anywhere else. Within the package, THIS is where
// it goes: one file, wrapping one client, behind the `ModelBackend` port.
//
// §8.4 writes the adapter as living in a `packages/anthropic-client`. That package does not exist and
// must not be created — the manifest names `packages/ai-platform` as the adapter owner, and a second
// package would be a second address for a rule whose whole value is having exactly one.
//
// ── WHAT PHASE 1 ACTUALLY SHIPS, STATED PLAINLY ───────────────────────────────────────────────────
//
// No `@anthropic-ai/sdk` dependency is installed and no HTTP call is made. `ai.full` is off for the
// whole of Wave H, so nothing in WardenX dispatches to a model; adding a vendor SDK to the dependency
// tree for code that cannot execute would buy supply-chain surface and nothing else.
//
// What ships instead is the adapter's SHAPE and its invariant: the transport is a port
// (`AnthropicDispatch`), Phase 2 binds it to `new Anthropic({...}).messages.create(...)` right here, and
// `createAnthropicModelBackend` cannot be constructed without BOTH a ZDR contract resolver and a
// transport. There is no half-built adapter and no bypass parameter — which is §8.4's actual
// requirement ("The adapter has no path to make an API call without a valid ZDR resolution; this is
// enforced by the adapter's constructor invariant + the lack of any bypass parameter").
//
// ── ONE THING §8.4 ASKS FOR THAT THE SCHEMA CANNOT HOLD ───────────────────────────────────────────
//
// §8.4.5 says the resolved contract ref is "captured in the `ai_invocation` row (via a non-PHI column
// `zdr_contract_ref`)". §3.2.8 declares no such column and M32-T02 migrated the table without one, so
// the ref is NOT persisted per invocation. `zdr_confirmed` (which §3.2.8 does declare, with a CHECK
// binding it to every `anthropic-%` route) carries the boolean claim; the contract itself is evidenced
// once in M2's contract registry, where the tenant opt-in already validates it (W4.1). Adding a column
// is a schema change, not an adapter change, and it belongs to whoever decides the per-invocation ref
// is worth a migration.
import { WardenXError } from "@wardenx/types";

import type {
  ModelBackend,
  ModelBackendCapabilities,
  ModelBackendCompletionRequest,
  ModelBackendCompletionResult,
} from "./model-backend";
import type { AiBackendHealthStatus } from "@wardenx/types";

/** The org's Zero-Data-Retention contract, as §8.4's resolver returns it. */
export interface AnthropicZdrContract {
  readonly contractRef: string;
  readonly verifiedAt: string;
  /** ISO instant. An expired contract is treated exactly as an absent one (§8.4.4). */
  readonly expiresAt: string;
}

/** §8.4 — `(organizationId) => contract | null`. `null` means "no ZDR on record": the call is refused. */
export type AnthropicZdrContractResolver = (
  organizationId: string,
) => Promise<AnthropicZdrContract | null>;

/**
 * The transport. Phase 2 binds this to the `@anthropic-ai/sdk` client constructed in this file; the
 * indirection exists so the ZDR gate is not something a future transport implementation can be written
 * around, and so this module's invariant is testable without a network.
 *
 * The `zdr` argument is the RESOLVED contract, passed in rather than resolved inside: a transport that
 * received only the org id could choose not to ask.
 */
export type AnthropicDispatch = (
  request: ModelBackendCompletionRequest,
  zdr: AnthropicZdrContract,
) => Promise<ModelBackendCompletionResult>;

/** §8.4.3 — no ZDR contract on record for the org, or the one on record has expired. */
export class ZdrContractMissingError extends WardenXError {
  constructor(detail: string) {
    super("AI_ZDR_CONTRACT_MISSING", detail, 503);
    this.name = "ZdrContractMissingError";
  }
}

/** What `createAnthropicModelBackend` needs. Every field is required — see the header. */
export interface AnthropicModelBackendOptions {
  /** The `ai_model_backend.backend_key` this adapter serves, e.g. `anthropic-claude-opus-4-7`. */
  readonly backendKey: string;
  readonly capabilities: Omit<ModelBackendCapabilities, "backendKey" | "kind">;
  readonly zdrContractResolver: AnthropicZdrContractResolver;
  readonly dispatch: AnthropicDispatch;
  /** Probes the vendor. Required for the same reason `dispatch` is: an adapter that reported itself
   *  healthy without asking would let the routing gate's health filter pass on a fiction. */
  readonly probeHealth: () => Promise<AiBackendHealthStatus>;
  /** Injected so the expiry comparison is testable; defaults to the real clock. */
  readonly now?: () => Date;
}

/**
 * Build the Anthropic adapter (D19 / §8.4).
 *
 * THROWS at construction when the ZDR resolver or the transport is missing, rather than refusing at
 * call time: a platform that boots with a half-built Anthropic adapter is a platform where the first
 * evidence of the problem is a clinician's failed enhancement. §8.4's "constructor invariant", verbatim.
 */
export function createAnthropicModelBackend(
  options: AnthropicModelBackendOptions,
): ModelBackend {
  if (typeof options.zdrContractResolver !== "function") {
    throw new ZdrContractMissingError(
      `anthropic backend '${options.backendKey}' cannot be constructed without a zdrContractResolver (D19 / §8.4)`,
    );
  }
  if (typeof options.dispatch !== "function") {
    throw new ZdrContractMissingError(
      `anthropic backend '${options.backendKey}' cannot be constructed without a dispatch transport (§8.4)`,
    );
  }

  const clock = options.now ?? (() => new Date());

  return {
    backendKey: options.backendKey,
    kind: "cloud",
    capabilities: () => ({
      ...options.capabilities,
      backendKey: options.backendKey,
      kind: "cloud",
    }),
    health: () => options.probeHealth(),
    async complete(request: ModelBackendCompletionRequest): Promise<ModelBackendCompletionResult> {
      const contract = await options.zdrContractResolver(request.organizationId);
      if (contract === null) {
        throw new ZdrContractMissingError(
          `no Zero-Data-Retention contract on record for organization ${request.organizationId}`,
        );
      }
      const expiresAt = new Date(contract.expiresAt).getTime();
      // An unparseable expiry is treated as expired. The alternative — trusting a date nobody can read
      // — makes the one field that bounds the contract's validity the one field that never refuses.
      if (Number.isNaN(expiresAt) || expiresAt <= clock().getTime()) {
        throw new ZdrContractMissingError(
          `the Zero-Data-Retention contract for organization ${request.organizationId} expired at ${contract.expiresAt}`,
        );
      }
      return options.dispatch(request, contract);
    },
  };
}
