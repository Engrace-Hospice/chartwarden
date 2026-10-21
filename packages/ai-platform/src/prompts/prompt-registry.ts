import type { AiPromptTemplateStatus } from "@chartwarden/types";
// @chartwarden/ai-platform — §4.5 / §4.10 `AIPromptRegistry` (M32-T05).
//
// The typed query API D13/D18 make load-bearing: M12, M13, M18, M21, M27 and M28 each call
// `getActivePromptsTargeting(<prefix>)` at their OWN boot and refuse to start if any active prompt
// template targets their prohibited entity. That is the whole AI-prohibited-zone enforcement triad's
// third leg (§8.5), and it means this interface is a SAFETY surface, not a convenience one.
//
// This file holds the contract plus the pure rules a registry implementation is built from. The
// implementation — the store, the cache and the git artifact reader — lives in
// `apps/backend/src/modules/32-ai-platform/prompts`.
//
// ── THREE PLACES THIS DEPARTS FROM §4.5's LITERAL TEXT, AND WHY ───────────────────────────────────
//
//  1. `promptTargets: string[]` BECOMES `outputEntityTargetPrefix: string`. §4.5 sketches an array;
//     §3.2.5 — the schema M32-T02 migrated — declares `output_entity_target_prefix TEXT NOT NULL`,
//     singular. The schema wins (it exists), and reporting a one-element array would invite a consumer
//     to write "does ANY of my prefixes match ANY of its targets" logic over a column that can only
//     ever answer one. `outputTypePrefix` is exposed alongside it because §3.2.5's second D18 index
//     (`ai_prompt_template_output_type_idx`) is queried by `getActivePromptsWithOutputType`, which §4.5's
//     interface omits and the schema header names.
//
//  2. `getActivePromptForCapability` RETURNS THE DETAIL OR THROWS — it does not degrade to a summary.
//     `ActivePromptDetail.promptBody` is "resolved from git filesystem at this call", so without a
//     bound artifact reader there is no body. Returning `null` would be a LIE with a specific victim:
//     `null` from this method means "this capability has no active prompt", which is exactly what the
//     invocation pipeline reads before deciding it may dispatch a capability with no template.
//
//  3. `getActivePromptsTargeting` DOES NOT NEED THE READER, and must not. It answers from the TABLE
//     alone. A D18 boot validator that could not answer because a filesystem mount was missing would
//     fail open — "no contraband found" — which is the one answer this query must never invent.
import { type AiGovernanceRefusal, aiGovernanceRefusal } from "../governance/errors";

/** SHA-256, lowercase hex — §3.2.5's `length(template_content_hash) = 64` CHECK, as a predicate. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True when the value is a well-formed lowercase-hex SHA-256 digest. */
export function isAiPromptContentHash(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Does the file at `templateFilesystemRef` still match the row's `template_content_hash`?
 *
 * Case-insensitive on the digest (a hex digest is the same digest in either case) but NOT lenient about
 * shape: a malformed digest is `false`, never "close enough". §4.4 step 5 makes a mismatch a FATAL boot
 * error, because a row whose hash does not pin its file pins nothing — and the pin is the only thing
 * standing between the reviewed prompt and a prompt someone edited on the box.
 */
export function aiPromptContentHashMatches(expected: string, actual: string): boolean {
  const e = expected.trim().toLowerCase();
  const a = actual.trim().toLowerCase();
  if (!isAiPromptContentHash(e) || !isAiPromptContentHash(a)) return false;
  return e === a;
}

/**
 * §4.5's prefix rule: "exact-prefix; e.g., 'medication_' matches a template targeting 'medication_order'
 * or 'medication_administration' but not 'patient_demographics'".
 *
 * The template's target is the HAYSTACK and the query is the NEEDLE — the direction matters and the
 * inverse is a silent fail-open. `getActivePromptsTargeting('medication_')` asked against a template
 * targeting `'medication_order'` must MATCH; a naive `query.startsWith(target)` would not, and M12's
 * boot validator would sail past the exact contraband it exists to catch.
 */
export function aiPromptTargetsPrefix(
  templateTargetPrefix: string,
  queriedPrefix: string,
): boolean {
  return templateTargetPrefix.startsWith(queriedPrefix);
}

/** §4.10's LRU key: `(capabilityKey, contentHash)`. Keyed on the HASH, not the version, so a row whose
 *  file changed under it cannot be served from a cache entry minted before the change. */
export function aiPromptCacheKey(capabilityKey: string, contentHash: string): string {
  return `${capabilityKey}@${contentHash.trim().toLowerCase()}`;
}

/** §4.10's TTL fallback, in milliseconds — "TTL fallback 5 minutes". The primary invalidation is the
 *  `ai:kill-switch-broadcast`-style fan-out; this only bounds how stale an instance that missed one gets. */
export const AI_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

/** §4.5's summary — the shape every D18 boot validator reads. */
export interface ActivePromptSummary {
  readonly capabilityKey: string;
  readonly promptTemplateId: string;
  readonly templateKey: string;
  readonly version: number;
  /** §3.2.5's singular column (see departure 1). */
  readonly outputEntityTargetPrefix: string;
  readonly outputTypePrefix: string;
  /** Repo path of the reviewed prompt file. */
  readonly gitArtifactPath: string;
  readonly contentHash: string;
  /** ISO instant; `null` for a row that reached `active` without an approver recorded. */
  readonly approvedAt: string | null;
}

/** §4.5's detail — the summary plus the resolved body and its governance metadata. */
export interface ActivePromptDetail extends ActivePromptSummary {
  /** Resolved from the artifact mount at this call, hash-verified before it is returned. */
  readonly promptBody: string;
  readonly meta: {
    readonly capabilityKey: string;
    readonly inputSchemaRef: string;
    readonly outputSchemaRef: string;
    readonly compatibleBackendKeys: readonly string[];
  };
  /** §4.10's PR-gated block. `null` only on a row that predates the gate. */
  readonly clinicalReviewerAttestation: string | null;
}

/**
 * §4.5 — the typed query API consumed at boot.
 *
 * EVERY METHOD ANSWERS FROM `status = 'active'` ONLY. Deprecated and archived rows stay readable
 * forever (§3.5: a 2031 audit of a 2026 invocation must reconstruct the template that ran), and it is
 * this filter that keeps them out of the live path and out of D18's contraband answer.
 */
export interface AIPromptRegistry {
  /**
   * Every active template whose `output_entity_target_prefix` starts with `entityPrefix`.
   *
   * The D18 query. Answers from the table alone (see departure 3); an empty array means "no active
   * template targets this zone", and the implementation must never return one because a lookup failed.
   */
  getActivePromptsTargeting(entityPrefix: string): Promise<readonly ActivePromptSummary[]>;

  /** The `output_type_prefix` half of §3.2.5's D18 index pair. */
  getActivePromptsWithOutputType(outputTypePrefix: string): Promise<readonly ActivePromptSummary[]>;

  /** The active template for a capability key, body resolved and hash-verified. `null` ONLY when the
   *  capability genuinely has no active template (see departure 2). */
  getActivePromptForCapability(capabilityKey: string): Promise<ActivePromptDetail | null>;

  /** Boot-time only: every active template. §4.5 — "Logged at INFO; expensive." */
  enumerateAllActive(): Promise<readonly ActivePromptSummary[]>;
}

// ── R30 activation (§3.2.5 / D3 / W6.8) ────────────────────────────────────────────────────────────

/** The `ai_prompt_template` columns the activation rule reads. */
export interface AiPromptTemplateSnapshot {
  readonly id: string;
  readonly templateKey: string;
  readonly capabilityKey: string;
  readonly version: number;
  readonly templateFilesystemRef: string;
  readonly templateContentHash: string;
  readonly status: AiPromptTemplateStatus;
  readonly approvedByMembershipId: string | null;
  readonly approvedAt: string | null;
  readonly clinicalReviewerAttestation: string | null;
}

/**
 * R30's request.
 *
 * IT CARRIES THE WHOLE NEW ROW, NOT A VERSION POINTER, and that is the frozen schema speaking rather
 * than a design preference. `ai_prompt_template_status` has NO pre-active value — the column defaults to
 * `'active'` and 0116's `M32_PROMPT_TEMPLATE_STATUS_WALK` trigger permits only active→deprecated and
 * deprecated→archived. So a version becomes active AT INSERT and at no other moment; "activate version
 * N" is therefore INSERT the new row (active) + UPDATE the prior active row to `deprecated`, in one
 * transaction. A route that read R30's wording as "flip an existing row to active" would emit an UPDATE
 * the trigger rejects with `restrict_violation`, i.e. a 500 on the happy path.
 */
export interface AiPromptActivationRequest {
  readonly capabilityKey: string;
  readonly templateKey: string;
  readonly version: number;
  readonly templateFilesystemRef: string;
  readonly templateContentHash: string;
  readonly compatibleBackendKeys: readonly string[];
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
  readonly outputEntityTargetPrefix: string;
  readonly outputTypePrefix: string;
  readonly createdByMembershipId: string;
  readonly approvedByMembershipId: string;
  readonly clinicalReviewerAttestation: string;
  /** The digest of the bytes actually at `templateFilesystemRef`, computed by the caller. `null` when
   *  no artifact reader is bound — which REFUSES, rather than trusting the submitted hash. */
  readonly resolvedContentHash: string | null;
}

/** The two writes an accepted activation makes, in one transaction. */
export interface AiPromptActivationPlan {
  /** The row to INSERT, already `active` (see the request's header). */
  readonly insert: AiPromptActivationRequest & {
    readonly status: "active";
    readonly approvedAt: string;
  };
  /** The currently-active row to walk to `deprecated`; `null` when the capability has none yet. */
  readonly deprecate: {
    readonly id: string;
    readonly supersededAt: string;
    readonly deprecatedAt: string;
  } | null;
}

export type AiPromptActivationDecision =
  | { readonly ok: true; readonly plan: AiPromptActivationPlan }
  | AiGovernanceRefusal;

/**
 * R30 / W6.8 — may this template version become the capability's active prompt?
 *
 * `current` is the capability's active row (`null` for a first activation); `existing` is any row that
 * already holds the requested (capabilityKey, version) — `ai_prompt_template_cap_version_idx` makes it
 * unique, so a collision has to be refused here rather than surfaced as a constraint violation.
 */
export function evaluateAiPromptActivation(
  request: AiPromptActivationRequest,
  current: AiPromptTemplateSnapshot | null,
  existing: AiPromptTemplateSnapshot | null,
  at: string,
): AiPromptActivationDecision {
  if (existing !== null) {
    if (existing.status === "active") {
      return aiGovernanceRefusal(
        "AI_PROMPT_TEMPLATE_ALREADY_ACTIVE",
        `${request.capabilityKey} v${request.version} is already the active template; re-activating it would deprecate and then re-activate the same row, which D3's one-way walk forbids — the capability would be left with no active template`,
      );
    }
    return aiGovernanceRefusal(
      "AI_PROMPT_TEMPLATE_NOT_ACTIVATABLE",
      `${request.capabilityKey} v${request.version} is '${existing.status}'; D3's walk is one-way, so a withdrawn template returns only as a NEW version`,
    );
  }

  if (!isAiPromptContentHash(request.templateContentHash.trim().toLowerCase())) {
    return aiGovernanceRefusal(
      "AI_PROMPT_TEMPLATE_CONTENT_HASH_INVALID",
      `template_content_hash must be a 64-character lowercase-hex SHA-256; got ${request.templateContentHash.length} characters`,
    );
  }

  if (request.resolvedContentHash === null) {
    return aiGovernanceRefusal(
      "AI_PROMPT_TEMPLATE_CONTENT_HASH_INVALID",
      `the artifact at '${request.templateFilesystemRef}' could not be read, so the submitted hash pins nothing; activation refuses rather than trusting it`,
    );
  }

  if (!aiPromptContentHashMatches(request.templateContentHash, request.resolvedContentHash)) {
    return aiGovernanceRefusal(
      "AI_PROMPT_TEMPLATE_CONTENT_HASH_INVALID",
      `the artifact at '${request.templateFilesystemRef}' does not hash to the submitted template_content_hash`,
    );
  }

  if (
    request.approvedByMembershipId.trim().length === 0 ||
    request.clinicalReviewerAttestation.trim().length === 0
  ) {
    return aiGovernanceRefusal(
      "AI_PROMPT_TEMPLATE_ATTESTATION_REQUIRED",
      "§4.10's PR gate requires a filled clinical_reviewer_attestation and a named approver before a prompt reaches the active set",
    );
  }

  return {
    ok: true,
    plan: {
      insert: { ...request, status: "active", approvedAt: at },
      deprecate: current === null ? null : { id: current.id, supersededAt: at, deprecatedAt: at },
    },
  };
}
