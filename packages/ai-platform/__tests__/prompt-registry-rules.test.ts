// Module 32 — §4.5/§4.10 `AIPromptRegistry`'s pure rules and R30's activation plan (M32-T05).
//
// The D18 prefix direction is the test that matters most in this file: `getActivePromptsTargeting`
// answered with the arguments the other way round would silently report "no contraband" to every
// prohibited-zone boot validator, and the build would be green.

import { describe, expect, it } from "vitest";

import {
  AI_PROMPT_CACHE_TTL_MS,
  aiPromptCacheKey,
  aiPromptContentHashMatches,
  aiPromptTargetsPrefix,
  evaluateAiPromptActivation,
  isAiPromptContentHash,
} from "../src/index";
import type { AiPromptActivationRequest, AiPromptTemplateSnapshot } from "../src/index";

const T0 = "2026-08-15T12:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("D18 prefix matching (§4.5)", () => {
  it("matches 'medication_' against a template targeting medication_order", () => {
    expect(aiPromptTargetsPrefix("medication_order", "medication_")).toBe(true);
    expect(aiPromptTargetsPrefix("medication_administration", "medication_")).toBe(true);
  });

  it("does not match an unrelated target", () => {
    expect(aiPromptTargetsPrefix("patient_demographics", "medication_")).toBe(false);
  });

  it("is NOT symmetric — the template target is the haystack", () => {
    // The inverse reading (`query.startsWith(target)`) would answer false here and let M12 boot with
    // a contraband prompt active. Pinning the asymmetry is what keeps that from being refactored in.
    expect(aiPromptTargetsPrefix("medication_order", "medication_")).toBe(true);
    expect(aiPromptTargetsPrefix("medication_", "medication_order")).toBe(false);
  });

  it("matches an exact target", () => {
    expect(aiPromptTargetsPrefix("encounter_narrative", "encounter_narrative")).toBe(true);
  });
});

describe("content-hash pin (§3.2.5 / §4.4 step 5)", () => {
  it("accepts a 64-character lowercase-hex digest and nothing else", () => {
    expect(isAiPromptContentHash(HASH_A)).toBe(true);
    expect(isAiPromptContentHash(HASH_A.slice(1))).toBe(false);
    expect(isAiPromptContentHash(`${HASH_A}0`)).toBe(false);
    expect(isAiPromptContentHash("z".repeat(64))).toBe(false);
    expect(isAiPromptContentHash(HASH_A.toUpperCase())).toBe(false);
  });

  it("compares case-insensitively but refuses a malformed digest outright", () => {
    expect(aiPromptContentHashMatches(HASH_A, HASH_A.toUpperCase())).toBe(true);
    expect(aiPromptContentHashMatches(HASH_A, HASH_B)).toBe(false);
    // "close enough" is not a match: an 8-character prefix pins nothing.
    expect(aiPromptContentHashMatches(HASH_A, HASH_A.slice(0, 8))).toBe(false);
    expect(aiPromptContentHashMatches("", "")).toBe(false);
  });

  it("keys the cache on the hash, so a file changing under a row misses", () => {
    expect(aiPromptCacheKey("hearthnote_layer2", HASH_A)).not.toBe(
      aiPromptCacheKey("hearthnote_layer2", HASH_B),
    );
    expect(aiPromptCacheKey("hearthnote_layer2", HASH_A.toUpperCase())).toBe(
      aiPromptCacheKey("hearthnote_layer2", HASH_A),
    );
    expect(AI_PROMPT_CACHE_TTL_MS).toBe(300_000);
  });
});

// ── R30 activation ─────────────────────────────────────────────────────────────────────────────────

function request(overrides: Partial<AiPromptActivationRequest> = {}): AiPromptActivationRequest {
  return {
    capabilityKey: "hearthnote_layer2",
    templateKey: "hearthnote_enhancement_v2",
    version: 2,
    templateFilesystemRef: "packages/prompts/templates/hearthnote_layer2/v2.md",
    templateContentHash: HASH_A,
    compatibleBackendKeys: ["anthropic-claude"],
    inputSchemaRef: "hearthnote_layer2.input.v1",
    outputSchemaRef: "hearthnote_layer2.output.v1",
    outputEntityTargetPrefix: "encounter_narrative",
    outputTypePrefix: "narrative_text",
    createdByMembershipId: "mem-author",
    approvedByMembershipId: "mem-reviewer",
    clinicalReviewerAttestation: "Reviewed against the hospice narrative safety checklist.",
    resolvedContentHash: HASH_A,
    ...overrides,
  };
}

function template(overrides: Partial<AiPromptTemplateSnapshot> = {}): AiPromptTemplateSnapshot {
  return {
    id: "apt-1",
    templateKey: "hearthnote_enhancement_v1",
    capabilityKey: "hearthnote_layer2",
    version: 1,
    templateFilesystemRef: "packages/prompts/templates/hearthnote_layer2/v1.md",
    templateContentHash: HASH_B,
    status: "active",
    approvedByMembershipId: "mem-reviewer",
    approvedAt: "2026-06-01T00:00:00.000Z",
    clinicalReviewerAttestation: "Reviewed.",
    ...overrides,
  };
}

describe("R30 activation (§3.2.5 / D3 / W6.8)", () => {
  it("inserts the new version active and deprecates the prior one, in one plan", () => {
    const decision = evaluateAiPromptActivation(request(), template(), null, T0);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.insert.status).toBe("active");
    expect(decision.plan.insert.approvedAt).toBe(T0);
    expect(decision.plan.deprecate).toEqual({
      id: "apt-1",
      supersededAt: T0,
      deprecatedAt: T0,
    });
  });

  it("deprecates nothing on a capability's first activation", () => {
    const decision = evaluateAiPromptActivation(request(), null, null, T0);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.deprecate).toBeNull();
  });

  it("refuses re-activating the already-active version — it would leave the capability prompt-less", () => {
    const decision = evaluateAiPromptActivation(
      request({ version: 1 }),
      template(),
      template(),
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_PROMPT_TEMPLATE_ALREADY_ACTIVE");
  });

  it("refuses returning a deprecated or archived version to active (D3's one-way walk)", () => {
    for (const status of ["deprecated", "archived"] as const) {
      const decision = evaluateAiPromptActivation(
        request({ version: 1 }),
        template({ id: "apt-current", version: 3 }),
        template({ status }),
        T0,
      );
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.code).toBe("AI_PROMPT_TEMPLATE_NOT_ACTIVATABLE");
    }
  });

  it("refuses a malformed submitted hash", () => {
    const decision = evaluateAiPromptActivation(
      request({ templateContentHash: "deadbeef" }),
      null,
      null,
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_PROMPT_TEMPLATE_CONTENT_HASH_INVALID");
  });

  it("refuses when the artifact could not be read, rather than trusting the submitted hash", () => {
    const decision = evaluateAiPromptActivation(
      request({ resolvedContentHash: null }),
      null,
      null,
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_PROMPT_TEMPLATE_CONTENT_HASH_INVALID");
    expect(decision.detail).toContain("could not be read");
  });

  it("refuses when the file does not hash to the pinned value", () => {
    const decision = evaluateAiPromptActivation(
      request({ resolvedContentHash: HASH_B }),
      null,
      null,
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_PROMPT_TEMPLATE_CONTENT_HASH_INVALID");
  });

  it("refuses an unattested or unapproved template (§4.10's PR gate)", () => {
    for (const overrides of [
      { clinicalReviewerAttestation: "   " },
      { approvedByMembershipId: "" },
    ]) {
      const decision = evaluateAiPromptActivation(request(overrides), null, null, T0);
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.code).toBe("AI_PROMPT_TEMPLATE_ATTESTATION_REQUIRED");
    }
  });
});
