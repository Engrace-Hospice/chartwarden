// @chartwarden/ai-platform — D18's AI-prohibited zone registry and its boot check (M32-T06).
//
// Six downstream modules have each declared entity prefixes M32's models may not target: M12 D12
// (prescribing), M13 D15 (administration), M18 D13 (EVV), M21 D15 (supply + controlled-substance
// dispatch), M27 D18 (cost report) and M28 D14 (FHIR synthesis). §8.5 makes the enforcement a TRIAD —
// boot-time registry query, build-time dependency-cruiser rule, runtime `ai_platform_invoker` route
// guard — and this file is M32's own half of leg 1.
//
// ── WHY M32 CHECKS ITS OWN REGISTRY, WHEN THE SIX MODULES ALREADY DO ────────────────────────────
//
// §4.5's boot validators run in each PROTECTED module and ask "does any active template target MY
// zone?". `validateAiProhibitedZoneRegistry` (§4.4 step 6) asks the complementary question from the
// producer side: "does any active template target ANYBODY's zone?" — and it is not redundant, because
// the six consumer validators only fire in a boot that actually mounts those six modules. A deployment
// that ships M32 with a subset of the platform (a worker sidecar, a slice test host, a tenant that has
// not licensed prescribing) would run zero of them. The contraband template would still exist, and it
// would still be active the day M12 mounts.
//
// ── THE PREFIX DIRECTION, AGAIN, BECAUSE THE INVERSE FAILS OPEN ─────────────────────────────────
//
// `aiPromptTargetsPrefix(templateTarget, zonePrefix)` — the TEMPLATE's target is the haystack and the
// ZONE prefix is the needle. `'medication_order'.startsWith('medication_')` is the match that catches
// contraband; `'medication_'.startsWith('medication_order')` is false and would sail past it. This file
// never inverts the arguments and the test asserts it on a real pair.
import { type ActivePromptSummary, aiPromptTargetsPrefix } from "../prompts/prompt-registry";

/** One module's declared AI-prohibited zone. */
export interface AiProhibitedZone {
  /** `mN` id of the module that declared it, for the boot error message. */
  readonly module: string;
  /** The decision that declared it (M12 D12, M18 D13, …) — the citation an operator will want. */
  readonly decision: string;
  /** The `output_entity_target_prefix` values no active template may start with. */
  readonly prefixes: readonly string[];
}

/**
 * D18's six zones, with the prefixes §1's consumed-by inventory and each module's own D-decision name.
 *
 * These live in CODE, not in the manifest, and the reason is the manifest's own contract: it declares
 * `codePaths` / `dependsOn` / `ownedTables`, and `architecture/module-manifest.ts` is consumed by five
 * fitness gates that would each have to learn a new field. §8.5's leg 2 (the dependency-cruiser rule
 * over `*.meta.yaml`) is where a manifest entry belongs and is a separate task; leg 1 needs a value the
 * runtime can read, and a runtime import of the manifest from `packages/ai-platform` is exactly the
 * `leaves-stay-leaves` edge the architecture forbids.
 */
export const AI_PROHIBITED_ZONES: readonly AiProhibitedZone[] = [
  { module: "m12", decision: "M12 D12", prefixes: ["medication_"] },
  { module: "m13", decision: "M13 D15", prefixes: ["administration_"] },
  { module: "m18", decision: "M18 D13", prefixes: ["evv_"] },
  { module: "m21", decision: "M21 D15", prefixes: ["supply_", "controlled_substance_dispatch_"] },
  {
    module: "m27",
    decision: "M27 D18",
    prefixes: ["cost_report_", "allocation_", "apportionment_"],
  },
  { module: "m28", decision: "M28 D14", prefixes: ["fhir_"] },
  {
    module: "m37",
    decision: "M37 D16",
    prefixes: ["gip_criteria_", "irc_cap_override_", "ipu_restraint_", "ipu_body_release_"],
  },
];

/** Every prohibited prefix, flattened — the set a template registration is checked against (R30). */
export const AI_PROHIBITED_PREFIXES: readonly string[] = AI_PROHIBITED_ZONES.flatMap(
  (z) => z.prefixes,
);

/** One contraband finding: an active template whose target falls inside a declared zone. */
export interface AiProhibitedZoneViolation {
  readonly capabilityKey: string;
  readonly templateKey: string;
  readonly version: number;
  readonly outputEntityTargetPrefix: string;
  readonly zoneModule: string;
  readonly zoneDecision: string;
  readonly zonePrefix: string;
}

/**
 * Which of `templates` target a declared AI-prohibited zone?
 *
 * PURE, and it takes the zone list as a parameter so a test can prove the prefix DIRECTION on a zone it
 * controls rather than on the shipped table. An empty result means no active template targets any zone —
 * and the caller must have established that the list came from the TABLE, not from a failed lookup
 * (`getActivePromptsTargeting`'s own contract: it never returns `[]` because a query failed).
 */
export function findAiProhibitedZoneViolations(
  templates: readonly ActivePromptSummary[],
  zones: readonly AiProhibitedZone[] = AI_PROHIBITED_ZONES,
): readonly AiProhibitedZoneViolation[] {
  const violations: AiProhibitedZoneViolation[] = [];
  for (const template of templates) {
    for (const zone of zones) {
      for (const prefix of zone.prefixes) {
        if (!aiPromptTargetsPrefix(template.outputEntityTargetPrefix, prefix)) continue;
        violations.push({
          capabilityKey: template.capabilityKey,
          templateKey: template.templateKey,
          version: template.version,
          outputEntityTargetPrefix: template.outputEntityTargetPrefix,
          zoneModule: zone.module,
          zoneDecision: zone.decision,
          zonePrefix: prefix,
        });
      }
    }
  }
  return violations;
}

/** Does this candidate target prefix fall inside a declared zone? The R30 registration guard (§1: "an
 *  attempt to register a prompt template with one of the prohibited output type prefixes fails
 *  registration with `AI_PROHIBITED_ZONE_VIOLATION`"). */
export function aiTargetPrefixIsProhibited(
  outputEntityTargetPrefix: string,
  zones: readonly AiProhibitedZone[] = AI_PROHIBITED_ZONES,
): AiProhibitedZone | null {
  for (const zone of zones) {
    for (const prefix of zone.prefixes) {
      if (aiPromptTargetsPrefix(outputEntityTargetPrefix, prefix)) return zone;
    }
  }
  return null;
}

/** Render violations into the one-line-per-finding message a fatal boot error carries. */
export function formatAiProhibitedZoneViolations(
  violations: readonly AiProhibitedZoneViolation[],
): string {
  return violations
    .map(
      (v) =>
        `'${v.templateKey}' v${v.version} (capability '${v.capabilityKey}') targets '${v.outputEntityTargetPrefix}', inside ${v.zoneModule}'s AI-prohibited zone '${v.zonePrefix}' (${v.zoneDecision})`,
    )
    .join("; ");
}
