// apps/backend/src/modules/32-ai-platform/invocation/chart-context-rules.ts — the §8.3 PHI-minimisation
// rules for the capabilities that have one (F-236).
//
// `createDenyingAiChartContextValidator` refuses every capability because no ruleset existed. This adds
// rulesets for the DocLens capabilities ONLY; every other capability still falls through to the denying
// validator. A ruleset is an ALLOWLIST of keys with primitive values: an unlisted key, a nested object or
// a long string refuses the call, because the chart context is the one channel where a caller could hand
// a vendor PHI the prompt itself does not need. (The document text DocLens sends IS the prompt — that is
// the capability; the chart context around it carries ids and counts only.)
import type { AiPhiMinimizationVerdict } from "@chartwarden/ai-platform";
import { type AiChartContextValidator, createDenyingAiChartContextValidator } from "./service";

const RULES: Readonly<Record<string, ReadonlySet<string>>> = {
  doclens_classify: new Set(["documentId", "pageCount", "pageNumber"]),
  doclens_extract: new Set(["documentId", "documentType", "schemaKey", "pageCount"]),
  // F-237 — stage 5 names the field it reads (a schema path, not a value) and the page it came from.
  doclens_vision_verify: new Set(["documentId", "verificationKey", "pageNumber", "fieldPath"]),
  doclens_sud_detect: new Set(["documentId", "pageCount"]),
};

const MAX_STRING = 128;

export function createRuleBasedAiChartContextValidator(
  fallback: AiChartContextValidator = createDenyingAiChartContextValidator(),
): AiChartContextValidator {
  return {
    validate(
      capabilityKey,
      chartContext,
    ): AiPhiMinimizationVerdict | Promise<AiPhiMinimizationVerdict> {
      const allowed = RULES[capabilityKey];
      if (!allowed) return fallback.validate(capabilityKey, chartContext);
      for (const [key, value] of Object.entries(chartContext)) {
        if (!allowed.has(key)) {
          return {
            permitted: false,
            detail: `chart-context key '${key}' is not allowed for '${capabilityKey}'`,
          };
        }
        const primitive =
          (typeof value === "string" && value.length <= MAX_STRING) ||
          (typeof value === "number" && Number.isFinite(value)) ||
          typeof value === "boolean";
        if (!primitive) {
          return {
            permitted: false,
            detail: `chart-context key '${key}' must be a short primitive`,
          };
        }
      }
      return { permitted: true, detail: `chart context satisfies the ${capabilityKey} allowlist` };
    },
  };
}
