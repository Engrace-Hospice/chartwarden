// apps/backend/src/modules/23-billing-medicare/ai-block.ts — M23 (Billing — Medicare) §D13 AI-BLOCK.
//
// D13 makes the AI block on M23 ABSOLUTE: Module 32 (AI Platform) cannot create, modify, witness, or
// resolve any M23-owned row. The block is enforced at FOUR layers; this file owns the two that are not
// already in place elsewhere:
//   1. BOOT VALIDATOR  — {@link validateAiBlockForBilling} iterates M32's registered prompt-template
//      registry and FAILS BOOT if any template declares an `outputType` that targets an M23-owned table
//      family (claim_* / validation_* / noe_* / notr_* / hipps_* / sia_* / eligibility_* /
//      sequestration_* / mac_* / wage_*). M32 is a Phase-0 placeholder today (no registry), so the
//      validator is EMPTY-SAFE: with no registry / an empty registry it passes.
//   2. THE ONLY ADMITTED AI SURFACE — {@link AiAdvisoryReader}: a read-only `validation_ai_advisory`
//      projection M32 *may* write (advisory remediation hints for failed rules, surfaced in the
//      validation worklist UI when tenant policy opts in). M23 NEVER writes it; the advisory NEVER gates
//      a rule outcome and NEVER transitions a claim. It is a DENY-STUB today ({@link denyAiAdvisoryReader})
//      — M32-published when M32 locks.
//   3. AI-GOVERNANCE AUDIT CHANNEL SEPARATION — {@link auditChannelForBillingEvent}: every advisory
//      *display* event is captured to M4's AI-governance audit channel, separate from the operational
//      channel that carries claim transitions / overrides / submissions (AI Governance §17). The two
//      streams are not mergeable.
// The remaining two layers live elsewhere and are NOT duplicated here: the per-route `actor_kind='ai_*'`
// reject is `rejectAiActor()` in `./routes/actor.ts` (composed on every mutating route), and the import
// boundary (no `packages/ai-platform/*` / `@anthropic-ai/sdk` from M23 paths) is the dependency-cruiser
// rule `m23-billing-no-ai-platform` in `architecture/.dependency-cruiser.cjs`.
//
// PRECEDENT NOTE: M13/M18/M19 carry the AI block as an `actor_kind` data field + the per-route reject; none
// of them ships a standalone boot-validator FILE or a per-module dependency-cruiser AI rule (verified by
// grep). With no concrete precedent FILE to mirror, the D13 boot validator lives here (per the task rule:
// "…or apps/backend/src/modules/23-billing-medicare/ai-block.ts if no precedent") and is exported + tested
// directly rather than wired into boot (no precedent module wires one).
//
// PURE: no DB, no Fastify, no BullMQ, no network, NO PHI (D13 / §3.6 / §8.7). Deps are structural types only.

// ── §D13 owned-table families ────────────────────────────────────────────────────────────────────────────

/**
 * The M23-owned table-name family PREFIXES (§D13). A prompt-template `outputType` whose lowercased value
 * starts with any of these is a forbidden AI write target. These cover every one of M23's seventeen owned
 * tables by prefix.
 */
export const M23_OWNED_TABLE_FAMILIES = [
  "claim_",
  "validation_",
  "noe_",
  "notr_",
  "hipps_",
  "sia_",
  "eligibility_",
  "sequestration_",
  "mac_",
  "wage_",
] as const;

export type M23OwnedTableFamily = (typeof M23_OWNED_TABLE_FAMILIES)[number];

/**
 * The exact M23-owned table names that have NO family-prefix underscore of their own (the bare `claim`
 * root) — matched in addition to the prefix families so a template targeting the `claim` table itself is
 * still caught (the prefix `claim_` would miss the bare `claim`).
 */
export const M23_OWNED_TABLE_EXACT = ["claim", "noe", "notr"] as const;

/**
 * True iff `outputType` names (by family prefix or exact bare-root match) an M23-owned table. Case- and
 * surrounding-whitespace-insensitive; an empty/whitespace string is never a match.
 */
export function outputTypeTargetsBilling(outputType: string): boolean {
  const normalized = outputType.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if ((M23_OWNED_TABLE_EXACT as readonly string[]).includes(normalized)) return true;
  return M23_OWNED_TABLE_FAMILIES.some((family) => normalized.startsWith(family));
}

// ── §D13 boot validator ──────────────────────────────────────────────────────────────────────────────────

/**
 * The minimal structural shape of one M32 prompt-template the boot validator inspects. M32 owns the
 * canonical descriptor; M23 reads only what D13 needs — the template's stable `key` (for the error message)
 * and the `outputType` it writes. Additive: M32 may carry more fields; the validator ignores them.
 */
export interface PromptTemplateDescriptor {
  readonly key: string;
  readonly outputType: string;
}

/**
 * The minimal structural view of M32's prompt-template registry the validator iterates. M32 is a Phase-0
 * placeholder, so the registry is ABSENT today; the validator treats `undefined` / `null` / an empty list
 * as "no templates" (empty-safe → passes).
 */
export interface PromptTemplateRegistry {
  list(): readonly PromptTemplateDescriptor[];
}

/** Thrown by {@link validateAiBlockForBilling} when an M32 template targets an M23-owned table (fails boot). */
export class AiBlockViolationError extends Error {
  /** The offending template keys (stable identifiers for the operator). */
  readonly offendingTemplateKeys: readonly string[];
  constructor(offending: readonly PromptTemplateDescriptor[]) {
    const detail = offending.map((t) => `${t.key} → ${t.outputType}`).join(", ");
    super(
      `M23 AI-block (D13) violated: M32 prompt template(s) target an M23-owned table and may NOT write billing rows: ${detail}`,
    );
    this.name = "AiBlockViolationError";
    this.offendingTemplateKeys = offending.map((t) => t.key);
  }
}

/**
 * §D13 BOOT VALIDATOR — iterate M32's prompt-template registry and FAIL BOOT (throw
 * {@link AiBlockViolationError}) if any template's `outputType` targets an M23-owned table family. Module 32
 * cannot author billing rows; this is the structural proof at boot. EMPTY-SAFE: a `null`/`undefined`/empty
 * registry (M32 placeholder today) passes silently. Returns the (possibly empty) set of inspected templates
 * so the caller can log how many were checked.
 */
export function validateAiBlockForBilling(
  registry?: PromptTemplateRegistry | null,
): readonly PromptTemplateDescriptor[] {
  const templates = registry?.list() ?? [];
  const offending = templates.filter((t) => outputTypeTargetsBilling(t.outputType));
  if (offending.length > 0) throw new AiBlockViolationError(offending);
  return templates;
}

/** The slice of M32's real `AIPromptRegistry` (D18 table-only query) the async boot validator consults. */
export interface BillingAiPromptRegistryPort {
  getActivePromptsTargeting(
    entityPrefix: string,
  ): Promise<
    readonly { readonly templateKey: string; readonly outputEntityTargetPrefix: string }[]
  >;
}

/** The one M32-writable projection (validation_ai_advisory) — it is NOT a forbidden target. */
const ADMITTED_AI_OUTPUT = "validation_ai_advisory";

/**
 * §D13 BOOT VALIDATOR over the REAL M32 registry (GAP-137): the composition root calls this in a db-present
 * onReady hook. Asks the D18 table-only query for each M23 family prefix (and the bare roots) and throws
 * {@link AiBlockViolationError} on any active template targeting an M23 table, except the admitted
 * read-only `validation_ai_advisory` projection. `null`/`undefined` registry (no-db boot) passes.
 */
export async function validateBillingAiBlockAtBoot(
  registry: BillingAiPromptRegistryPort | null | undefined,
): Promise<void> {
  if (!registry) return;
  const prefixes = [...M23_OWNED_TABLE_FAMILIES, ...M23_OWNED_TABLE_EXACT];
  const offending: PromptTemplateDescriptor[] = [];
  for (const prefix of prefixes) {
    const hits = await registry.getActivePromptsTargeting(prefix);
    for (const hit of hits) {
      if (hit.outputEntityTargetPrefix.trim().toLowerCase() === ADMITTED_AI_OUTPUT) continue;
      offending.push({ key: hit.templateKey, outputType: hit.outputEntityTargetPrefix });
    }
  }
  if (offending.length > 0) throw new AiBlockViolationError(offending);
}

// ── The ONLY admitted AI surface: the read-only `validation_ai_advisory` projection (task 61) ──────────────

/**
 * One advisory remediation hint M32 *may* attach to a failed validation result (§D13 / task 61). PHI-free:
 * it carries the failed-result id, the model-authored hint text, the producing model version, and the
 * produced-at instant — never a claim/override row, never the MBI. Read-only on M23's side.
 */
export interface ValidationAiAdvisoryDto {
  readonly validationResultId: string;
  readonly advisoryText: string;
  readonly modelVersion: string;
  readonly generatedAt: string;
}

/**
 * §D13 / task 61 — the read-only seam M23's Claim Validation Worklist (routes 14/15) consumes to surface AI
 * remediation hints below each failed rule WHEN tenant policy opts in. M23 NEVER writes through this seam;
 * the advisory NEVER gates a rule outcome and NEVER transitions a claim. M32-published when M32 locks.
 */
export interface AiAdvisoryReader {
  advisoriesForResult(
    orgId: string,
    validationResultId: string,
  ): Promise<readonly ValidationAiAdvisoryDto[]>;
}

/**
 * DENY-STUB for {@link AiAdvisoryReader} (M32 placeholder today). Because the advisory is a purely optional,
 * non-gating UI hint, the fail-closed posture is to surface NO advisories (return empty) rather than throw —
 * a throw would break the worklist read, and D13 forbids the AI surface from ever affecting the worklist's
 * operational outcome. The worklist simply shows no AI hints until M32 registers the real reader.
 */
export function denyAiAdvisoryReader(): AiAdvisoryReader {
  return {
    advisoriesForResult: async () => [],
  };
}

// ── AI-governance audit channel separation (task 62) ───────────────────────────────────────────────────────

/** The two non-mergeable M4 audit streams (AI Governance §17). */
export type BillingAuditChannel = "operational" | "ai_governance";

/**
 * The single event type emitted when an AI advisory is RENDERED to a user on the worklist. It is the only
 * M23 event that routes to the AI-governance audit channel; every other `m23.*` event (claim transitions,
 * overrides, submissions) is operational.
 */
export const ADVISORY_DISPLAY_EVENT_TYPE = "m23.validation.ai_advisory_displayed" as const;

/**
 * §D13 / task 62 — classify an M23 audit event into its channel. Advisory-display events go to the
 * AI-governance channel; everything else (operational claim/override/submission activity) goes to the
 * operational channel. The mapping is total and the two channels are disjoint, so an auditor reviewing the
 * AI surface's footprint never has to filter operational noise (AI Governance §17).
 */
export function auditChannelForBillingEvent(eventType: string): BillingAuditChannel {
  const normalized = eventType.trim().toLowerCase();
  return normalized === ADVISORY_DISPLAY_EVENT_TYPE || normalized.includes("ai_advisory")
    ? "ai_governance"
    : "operational";
}

/**
 * Build the channel-tagged audit-event context for an advisory-DISPLAY event (task 62). The returned
 * `eventType` is the advisory-display type and `context.auditChannel` is pinned to `ai_governance`, so the
 * M4 writer routes it to the AI-governance stream. PHI-free: only ids + model version cross.
 */
export function buildAdvisoryDisplayAuditEvent(input: {
  readonly validationResultId: string;
  readonly modelVersion: string;
}): {
  readonly eventType: typeof ADVISORY_DISPLAY_EVENT_TYPE;
  readonly resourceKind: "validation_result";
  readonly resourceId: string;
  readonly auditChannel: BillingAuditChannel;
  readonly context: { readonly auditChannel: BillingAuditChannel; readonly modelVersion: string };
} {
  return {
    eventType: ADVISORY_DISPLAY_EVENT_TYPE,
    resourceKind: "validation_result",
    resourceId: input.validationResultId,
    auditChannel: "ai_governance",
    context: { auditChannel: "ai_governance", modelVersion: input.modelVersion },
  };
}
