// apps/backend/src/modules/32-ai-platform/seams/boot-validators.ts — §4.4 step 6 (M32-T06).
//
// The five boot-time invariants §4.4 runs after publishing M32's seams. Every one of them is a
// REFUSE-TO-START check, not a warning, and every one fails in the direction where the platform does not
// serve rather than the direction where it serves something unverified.
//
// ── WHY THESE RUN EVEN THOUGH `ai.full` IS OFF FOR THE WHOLE WAVE ────────────────────────────────
//
// Because they check the REGISTRY, not the traffic. A contraband prompt template, a capability APPROVED
// with no calibration row, or an Anthropic backend with no ZDR binding are all facts about the database
// that are equally true with the flag off — and the flag is one UPDATE away from being on. A validator
// that only ran in Phase 2 would first run on the day it could do the most damage by failing.
//
// ── THE ONE THAT IS A NO-OP, AND WHY IT IS STILL HERE ────────────────────────────────────────────
//
// `validateAnthropicAdapterZdrContract` has nothing to check in Phase 1: no `@anthropic-ai/sdk` is
// installed, no adapter is constructed, and D19 already makes the adapter's CONSTRUCTOR refuse without a
// `zdrContractResolver` (`createAnthropicModelBackend` throws `ZdrContractMissingError`) — which is a
// stronger guarantee than any boot check, because it cannot be skipped. So this validator asserts the
// weaker, complementary thing the constructor cannot: that no `ai_model_backend` row claims a cloud
// Anthropic backend while no adapter is bound to it. A registry row with no adapter is how a routing
// decision reaches a backend that then cannot dispatch — T04 already handles that at call time; this
// makes it visible at boot.
import {
  type AIPromptRegistry,
  findAiProhibitedZoneViolations,
  formatAiProhibitedZoneViolations,
} from "@wardenx/ai-platform";

import type { AiCapabilityRegistryStore } from "../governance/store";
import type { AiBackendRegistryStore } from "../invocation/store";
import type { AiPromptArtifactReader, AiPromptTemplateStore } from "../prompts/store";

/** Raised by any §4.4 step-6 validator. A fatal boot error — M1's health check surfaces it. */
export class AiBootValidationError extends Error {
  constructor(
    readonly validator: string,
    detail: string,
  ) {
    super(`AI_BOOT_VALIDATION_FAILED (${validator}): ${detail}`);
    this.name = "AiBootValidationError";
  }
}

/** The five §4.4 step-6 checks, as one surface. */
export interface AiBootValidators {
  validateAllCapabilitiesHaveBackend(): Promise<void>;
  validateAllActivePromptsResolveToGitArtifacts(): Promise<void>;
  validateAnthropicAdapterZdrContract(): Promise<void>;
  validateNoApprovedCapabilityWithoutCalibration(): Promise<void>;
  validateAiProhibitedZoneRegistry(): Promise<void>;
  /** Run all five, in §4.4's order. */
  validateAll(): Promise<void>;
}

/** What the validators read. All four ports are required: a validator that could not read is a validator. */
export interface AiBootValidatorDeps {
  readonly capabilities: AiCapabilityRegistryStore;
  readonly backends: AiBackendRegistryStore;
  readonly prompts: AiPromptTemplateStore;
  readonly promptRegistry: AIPromptRegistry;
  /**
   * Reads the bytes at a template's `template_filesystem_ref`.
   *
   * ABSENT ⇒ `validateAllActivePromptsResolveToGitArtifacts` REFUSES when any active template exists,
   * rather than passing. §4.4 step 5 makes a hash mismatch a fatal boot error precisely because the pin
   * is the only thing between the reviewed prompt and a prompt someone edited on the box; "we could not
   * open the file" must land on the same side of that line as "the file did not match".
   */
  readonly artifacts?: AiPromptArtifactReader;
}

/**
 * The §2.4 capabilities whose default backend is a SERVICE, not an `ai_model_backend` row.
 *
 * §2.4 routes the prediction family to "tabular ML (XGBoost on `local-ml-worker`)" and the inventory
 * records them with `defaultBackendKey: null`. Their rows are legitimately backend-less, so
 * `validateAllCapabilitiesHaveBackend` must not fail them — but it must also not blanket-exempt a NULL,
 * because a NULL on a capability that IS supposed to route to a model is exactly the misconfiguration
 * this validator exists to catch. The store's `defaultBackendKey` is typed non-null, so a backend-less
 * capability shows up as an EMPTY key, and an empty key on anything not in this set is a failure.
 */
const AI_SERVICE_ROUTED_CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  "hospitalization_risk_30d",
  "denial_outcome_prediction",
  "mortality_decline_prediction",
  "falls_risk_prediction",
  "level_of_care_prediction",
]);

/** The lifecycle states at or past APPROVED — the ones D12 requires a current calibration for. */
const AI_CALIBRATED_STATES: ReadonlySet<string> = new Set(["APPROVED", "MONITORING"]);

/** Build the §4.4 step-6 validator set. */
export function createAiBootValidators(deps: AiBootValidatorDeps): AiBootValidators {
  async function validateAllCapabilitiesHaveBackend(): Promise<void> {
    const capabilities = await deps.capabilities.listCapabilities();
    const wanted = new Set<string>();
    for (const c of capabilities) {
      if (c.defaultBackendKey !== "") wanted.add(c.defaultBackendKey);
      for (const key of c.allowedBackendKeys) wanted.add(key);
    }
    // `findBackendsByKey` answers a MAP and a key with no row is ABSENT from it — never defaulted
    // (its own contract). That absence is exactly the failure this validator reports.
    const present = await deps.backends.findBackendsByKey([...wanted]);

    const failures: string[] = [];
    for (const c of capabilities) {
      if (c.defaultBackendKey === "") {
        if (!AI_SERVICE_ROUTED_CAPABILITY_KEYS.has(c.capabilityKey)) {
          failures.push(`'${c.capabilityKey}' has no default backend and is not service-routed`);
        }
        continue;
      }
      if (!present.has(c.defaultBackendKey)) {
        failures.push(
          `'${c.capabilityKey}' defaults to backend '${c.defaultBackendKey}', which has no ai_model_backend row`,
        );
      }
      for (const key of c.allowedBackendKeys) {
        if (present.has(key)) continue;
        failures.push(
          `'${c.capabilityKey}' allows backend '${key}', which has no ai_model_backend row`,
        );
      }
    }
    if (failures.length > 0) {
      throw new AiBootValidationError(
        "validateAllCapabilitiesHaveBackend",
        `${failures.length} capability/backend gap(s): ${failures.join("; ")}`,
      );
    }
  }

  async function validateAllActivePromptsResolveToGitArtifacts(): Promise<void> {
    const active = await deps.prompts.listActive();
    if (active.length === 0) return; // Phase 1: no template is seeded, and zero rows is a pass.

    if (deps.artifacts === undefined) {
      throw new AiBootValidationError(
        "validateAllActivePromptsResolveToGitArtifacts",
        `${active.length} active prompt template(s) exist but no artifact reader is bound; the §4.4 step-5 content-hash pin cannot be verified`,
      );
    }

    // `getActivePromptForCapability` resolves the body AND verifies the hash (it throws
    // `AiPromptArtifactError` on a miss or a mismatch), so this asks the registry rather than
    // re-implementing the comparison — one hash rule, one place, one behaviour under drift.
    const failures: string[] = [];
    for (const row of active) {
      try {
        const detail = await deps.promptRegistry.getActivePromptForCapability(row.capabilityKey);
        if (detail === null) {
          failures.push(
            `'${row.templateKey}' v${row.version} is active for '${row.capabilityKey}' but the registry resolves no active prompt for that capability`,
          );
        }
      } catch (error) {
        failures.push(
          `'${row.templateKey}' v${row.version} (${row.capabilityKey}): ${error instanceof Error ? error.message : "unresolvable"}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new AiBootValidationError(
        "validateAllActivePromptsResolveToGitArtifacts",
        failures.join("; "),
      );
    }
  }

  async function validateAnthropicAdapterZdrContract(): Promise<void> {
    // See the header: D19 puts the real enforcement in the adapter constructor. This asserts the
    // complementary registry fact — a cloud backend row whose kind says Anthropic must be one the
    // routing layer can actually reach, i.e. it must exist as a row rather than only as a capability's
    // aspiration. `resolveBackendKinds` is the governance store's own read of that table.
    const capabilities = await deps.capabilities.listCapabilities();
    const cloudKeys = new Set<string>();
    for (const c of capabilities) {
      if (c.defaultBackendKey !== "") cloudKeys.add(c.defaultBackendKey);
      for (const key of c.allowedBackendKeys) cloudKeys.add(key);
    }
    if (cloudKeys.size === 0) return;

    const kinds = await deps.capabilities.resolveBackendKinds([...cloudKeys]);
    const unresolved = [...cloudKeys].filter((k) => !kinds.has(k));
    if (unresolved.length > 0) {
      throw new AiBootValidationError(
        "validateAnthropicAdapterZdrContract",
        `${unresolved.length} referenced backend key(s) resolve to no ai_model_backend row, so their cloud/ZDR posture is unknown: ${unresolved.join(", ")}`,
      );
    }
  }

  async function validateNoApprovedCapabilityWithoutCalibration(): Promise<void> {
    const capabilities = await deps.capabilities.listCapabilities();
    const failures: string[] = [];
    for (const c of capabilities) {
      if (!AI_CALIBRATED_STATES.has(c.lifecycleState)) continue;
      // Calibration is per (capability, backend) — D12 — so an APPROVED capability with a default
      // backend needs the row for THAT backend. A service-routed capability has no backend to calibrate
      // against and is skipped; none of the five is APPROVED in Phase 1 anyway.
      if (c.defaultBackendKey === "") continue;
      const calibration = await deps.capabilities.findCurrentCalibration(c.id, c.defaultBackendKey);
      if (calibration === null) {
        failures.push(
          `'${c.capabilityKey}' is ${c.lifecycleState} on backend '${c.defaultBackendKey}' with no current ai_capability_calibration row`,
        );
      }
    }
    if (failures.length > 0) {
      throw new AiBootValidationError(
        "validateNoApprovedCapabilityWithoutCalibration",
        failures.join("; "),
      );
    }
  }

  async function validateAiProhibitedZoneRegistry(): Promise<void> {
    // Reads through the REGISTRY's own D18 query surface (`enumerateAllActive`, which §4.5 marks
    // boot-time-only and expensive) rather than the store, so the "active rows only" filter that makes
    // this answer meaningful is the same one the six consumer validators get.
    const active = await deps.promptRegistry.enumerateAllActive();
    const violations = findAiProhibitedZoneViolations(active);
    if (violations.length > 0) {
      throw new AiBootValidationError(
        "validateAiProhibitedZoneRegistry",
        `AI_PROHIBITED_ZONE_VIOLATION — ${formatAiProhibitedZoneViolations(violations)}`,
      );
    }
  }

  return {
    validateAllCapabilitiesHaveBackend,
    validateAllActivePromptsResolveToGitArtifacts,
    validateAnthropicAdapterZdrContract,
    validateNoApprovedCapabilityWithoutCalibration,
    validateAiProhibitedZoneRegistry,
    async validateAll() {
      await validateAllCapabilitiesHaveBackend();
      await validateAllActivePromptsResolveToGitArtifacts();
      await validateAnthropicAdapterZdrContract();
      await validateNoApprovedCapabilityWithoutCalibration();
      await validateAiProhibitedZoneRegistry();
    },
  };
}
