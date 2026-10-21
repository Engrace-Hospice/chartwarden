// @chartwarden/cost-report — M27 auto-rule-suggestion stub (D20, §2.4 `m27.validation.rule_suggestion_created`,
// §7.8). When a MAC rejection comes back post-submission whose `mcref_rejection_code` matches NO rule in
// the library, M27 generates a DRAFT platform-suggestion rule for the WardenX platform-team review queue:
// `status: 'draft_suggestion'`, `organization_id = NULL` (platform-owned), ANONYMIZED — it carries only
// the rejection code, the derived rule pattern, and (upstream) aggregate frequency. No tenant identifier,
// no ProviderEntity-specific value, no PHI (D18). The platform-team review gate (never auto-publish)
// prevents one tenant's anomaly from becoming a platform-wide rule.
//
// This is a STUB (the matching catalog is stage-2): a suggestion's `evaluate` is INERT — a
// `draft_suggestion` is a candidate, not yet an executable predicate, and the engine never runs non-
// `active` rules — so it returns a skip until the platform team curates it into an `active` rule with a
// real predicate.
//
// TODO(CMS-fixture): the rejection-code → rule-pattern mapping (which CMS/MAC reject codes map to which
// validation category + predicate) requires the CMS/MAC rejection-code catalog we do not yet hold. Until
// then the suggestion records the raw rejection code and a generic `mac_specific` pattern; it does NOT
// fabricate a category/severity mapping as if derived from a verified catalog.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`. Types, pure
// functions, constants only.
import type { RuleDef } from "./types";
import { skipResult } from "./types";

/** The rule-set version draft suggestions are stamped under until the platform team promotes them. */
export const RULE_SUGGESTION_SET_VERSION = 1;

/**
 * Normalize a raw MAC rejection code into a deterministic, anonymized rule-code suffix: lowercased, with
 * any non-alphanumeric run collapsed to a single underscore and edges trimmed. Same input always yields
 * the same suffix (idempotent suggestion identity); carries nothing tenant- or patient-identifying.
 */
function sanitizeRejectionCode(code: string): string {
  return code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * D20 auto-suggestion: build a DRAFT platform-suggestion `RuleDef` from an unmatched MAC rejection code,
 * or `null` for a blank/whitespace code (nothing to suggest). The returned rule is `status:
 * 'draft_suggestion'`, scoped `'all'`, non-regulatory, `mac_specific`, with an INERT `evaluate` (skips) —
 * it is a review-queue candidate the platform team curates, never an executable or auto-published rule.
 * Pure + deterministic: same rejection code → identical suggestion.
 */
export function suggestRuleFromRejection(mcrefRejectionCode: string): RuleDef | null {
  const suffix = sanitizeRejectionCode(mcrefRejectionCode);
  if (suffix === "") return null;

  return {
    ruleCode: `mac.rejection.${suffix}`,
    category: "mac_specific",
    description: `Draft platform-suggestion from unmatched MAC rejection code '${mcrefRejectionCode.trim()}' (anonymized; pending platform-team review and a curated predicate).`,
    severity: "info",
    regulatoryRequired: false,
    macJurisdictionScope: "all",
    status: "draft_suggestion",
    // Inert until curated: a draft suggestion is a candidate, not an executable predicate. The engine
    // never runs a non-`active` rule, so this is defensive — it skips rather than asserts anything.
    evaluate: () =>
      skipResult(
        "Draft rule suggestion — not yet executable (awaiting platform-team review).",
        "not_applicable",
      ),
  };
}
