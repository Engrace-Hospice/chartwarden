// apps/backend/src/modules/32-ai-platform/prompts/registry.ts — the `AIPromptRegistry` implementation
// (§4.5 / §4.10), M32-T05.
//
// The seam M12, M13, M18, M21, M27 and M28 each `reg.require` at their own boot to enforce their
// AI-prohibited zone (D13/D18/§8.5). Everything about this file's failure behaviour is chosen so that
// the D18 question can never be answered "no contraband" by accident.
//
// ── THE CACHE, AND WHAT IT IS AND IS NOT ALLOWED TO HOLD ──────────────────────────────────────────
//
// §4.10 specifies an in-process LRU keyed on `(capabilityKey, contentHash)` with a 5-minute TTL
// fallback, invalidated by the kill-switch-style fan-out. It caches RESOLVED DETAILS — the body read
// off the artifact mount plus its verified hash — and NOTHING ELSE:
//
//   · the D18 prefix queries are NOT cached. A prohibited-zone answer that could be up to five minutes
//     stale is a boot validator that can pass on a template activated four minutes ago. These queries
//     run at boot, once per process; the cost of asking the table is a query nobody is waiting on.
//   · a NEGATIVE result ("this capability has no active template") is NOT cached, for the same reason
//     in the opposite direction — a capability that just gained its first prompt would keep refusing.
//
// Keying on the content HASH rather than the version is what makes eviction correct without a
// broadcast: a row whose file changed under it produces a different hash and therefore misses.
import type {
  AIPromptRegistry,
  ActivePromptDetail,
  ActivePromptSummary,
} from "@chartwarden/ai-platform";
import {
  AI_PROMPT_CACHE_TTL_MS,
  aiPromptCacheKey,
  aiPromptContentHashMatches,
} from "@chartwarden/ai-platform";

import type {
  AiPromptArtifactReader,
  AiPromptTemplateRowProjection,
  AiPromptTemplateStore,
} from "./store";

/** Raised when an active template's artifact cannot be resolved or does not match its pinned hash. */
export class AiPromptArtifactError extends Error {
  constructor(
    readonly capabilityKey: string,
    readonly templateFilesystemRef: string,
    detail: string,
  ) {
    super(
      `AI_PROMPT_ARTIFACT_UNRESOLVED: active prompt for '${capabilityKey}' at '${templateFilesystemRef}' ${detail}`,
    );
    this.name = "AiPromptArtifactError";
  }
}

function toSummary(row: AiPromptTemplateRowProjection): ActivePromptSummary {
  return {
    capabilityKey: row.capabilityKey,
    promptTemplateId: row.id,
    templateKey: row.templateKey,
    version: row.version,
    outputEntityTargetPrefix: row.outputEntityTargetPrefix,
    outputTypePrefix: row.outputTypePrefix,
    gitArtifactPath: row.templateFilesystemRef,
    contentHash: row.templateContentHash,
    approvedAt: row.approvedAt,
  };
}

export interface AiPromptRegistryDeps {
  readonly store: AiPromptTemplateStore;
  readonly artifacts: AiPromptArtifactReader;
  /** Injectable for the tests; the TTL is the only clock this file reads. */
  readonly now?: () => number;
  /** §4.10's LRU bound. Small on purpose: Phase 1 declares 14 capabilities (§2.4). */
  readonly maxCacheEntries?: number;
}

interface CacheEntry {
  readonly detail: ActivePromptDetail;
  readonly expiresAt: number;
}

/** §4.5's registry over `ai_prompt_template` + the artifact mount. */
export function createAiPromptRegistry(deps: AiPromptRegistryDeps): AIPromptRegistry & {
  /** §4.10 — invalidation hook for the fan-out and for R30's success path. */
  invalidate(capabilityKey?: string): void;
} {
  const now = deps.now ?? (() => Date.now());
  const max = deps.maxCacheEntries ?? 32;
  const cache = new Map<string, CacheEntry>();

  function invalidate(capabilityKey?: string): void {
    if (capabilityKey === undefined) {
      cache.clear();
      return;
    }
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${capabilityKey}@`)) cache.delete(key);
    }
  }

  function remember(key: string, detail: ActivePromptDetail): void {
    // Map preserves insertion order, so the first key is the least-recently-inserted — an LRU by
    // insertion, which is the right approximation for a set that turns over on activation, not on read.
    if (cache.size >= max) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { detail, expiresAt: now() + AI_PROMPT_CACHE_TTL_MS });
  }

  return {
    invalidate,

    // NO CACHE, and no artifact read — see the header. The D18 answer comes from the table every time.
    getActivePromptsTargeting: async (entityPrefix) => {
      const rows = await deps.store.findActiveTargeting(entityPrefix);
      return rows.map(toSummary);
    },

    getActivePromptsWithOutputType: async (outputTypePrefix) => {
      const rows = await deps.store.findActiveWithOutputType(outputTypePrefix);
      return rows.map(toSummary);
    },

    getActivePromptForCapability: async (capabilityKey) => {
      const row = await deps.store.findActiveForCapability(capabilityKey);
      // The ONLY `null` this method returns: the capability genuinely has no active template.
      if (row === null) return null;

      const key = aiPromptCacheKey(capabilityKey, row.templateContentHash);
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAt > now()) return hit.detail;
      cache.delete(key);

      const artifact = await deps.artifacts.read(row.templateFilesystemRef);
      if (artifact === null) {
        // NOT `null`, and not an empty body. A caller that read either as "no prompt" would let the
        // invocation pipeline dispatch a capability whose reviewed prompt it could not load.
        throw new AiPromptArtifactError(
          capabilityKey,
          row.templateFilesystemRef,
          "did not resolve; the registry refuses rather than reporting the capability as prompt-less",
        );
      }
      if (!aiPromptContentHashMatches(row.templateContentHash, artifact.contentHash)) {
        throw new AiPromptArtifactError(
          capabilityKey,
          row.templateFilesystemRef,
          `hashes to ${artifact.contentHash} but the row pins ${row.templateContentHash}; the reviewed prompt and the file on disk have diverged`,
        );
      }

      const detail: ActivePromptDetail = {
        ...toSummary(row),
        promptBody: artifact.body,
        meta: {
          capabilityKey: row.capabilityKey,
          inputSchemaRef: row.inputSchemaRef,
          outputSchemaRef: row.outputSchemaRef,
          compatibleBackendKeys: row.compatibleBackendKeys,
        },
        clinicalReviewerAttestation: row.clinicalReviewerAttestation,
      };
      remember(key, detail);
      return detail;
    },

    enumerateAllActive: async () => {
      const rows = await deps.store.listActive();
      return rows.map(toSummary);
    },
  };
}

/** One active template's artifact verdict, as §4.4 step 5's validator reports it. */
export interface AiPromptArtifactFinding {
  readonly capabilityKey: string;
  readonly templateKey: string;
  readonly gitArtifactPath: string;
  readonly problem: "unresolved" | "hash_mismatch";
  readonly detail: string;
}

/**
 * §4.4 step 5 / §4.10 — verify every active template's artifact resolves and matches its pinned hash.
 *
 * Returns findings rather than throwing, so the caller decides what a finding costs. §4.4 makes a
 * mismatch a FATAL boot error; a maintenance command that wanted to LIST divergences would otherwise
 * have to catch the first one and lose the rest.
 *
 * WITH THE PHASE-1 UNRESOLVABLE READER THIS REPORTS EVERY ACTIVE TEMPLATE AS `unresolved`, which is
 * correct and is why Phase 1 seeds no active templates: there is no artifact mount, so any active row
 * would be a row whose reviewed prompt nothing can produce.
 */
export async function verifyActiveAiPromptArtifacts(deps: {
  readonly store: AiPromptTemplateStore;
  readonly artifacts: AiPromptArtifactReader;
}): Promise<readonly AiPromptArtifactFinding[]> {
  const rows = await deps.store.listActive();
  const findings: AiPromptArtifactFinding[] = [];
  for (const row of rows) {
    const artifact = await deps.artifacts.read(row.templateFilesystemRef);
    if (artifact === null) {
      findings.push({
        capabilityKey: row.capabilityKey,
        templateKey: row.templateKey,
        gitArtifactPath: row.templateFilesystemRef,
        problem: "unresolved",
        detail: "the artifact path did not resolve against the prompt mount",
      });
      continue;
    }
    if (!aiPromptContentHashMatches(row.templateContentHash, artifact.contentHash)) {
      findings.push({
        capabilityKey: row.capabilityKey,
        templateKey: row.templateKey,
        gitArtifactPath: row.templateFilesystemRef,
        problem: "hash_mismatch",
        detail: `file hashes to ${artifact.contentHash}; the row pins ${row.templateContentHash}`,
      });
    }
  }
  return findings;
}
