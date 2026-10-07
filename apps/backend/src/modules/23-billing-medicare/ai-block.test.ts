import type { FastifyReply, FastifyRequest } from "fastify";
// apps/backend/src/modules/23-billing-medicare/ai-block.test.ts — M23 §D13 AI-BLOCK unit tests (tasks 59–62).
//
// The D13 AI block on M23 is ABSOLUTE and proven at four layers; this suite exercises the three that are
// CODE (the fourth, the import boundary, is the `m23-billing-no-ai-platform` dependency-cruiser rule, proven
// by `bun run arch:fitness`):
//   • the boot validator over M32's prompt-template registry — empty-safe pass + fail-on-M23-target;
//   • the per-route `actor_kind='ai_*'` reject guard (rejectAiActor, from ./routes/actor.ts);
//   • the only-admitted read-only advisory reader deny-stub (never throws, never gates);
//   • the AI-governance audit channel separation (advisory display → AI-gov channel, not operational).
// PURE: no DB, no real Fastify, no network. The guard is unit-tested against a structurally-minimal request.
import { describe, expect, it } from "vitest";
import {
  ADVISORY_DISPLAY_EVENT_TYPE,
  AiBlockViolationError,
  M23_OWNED_TABLE_EXACT,
  M23_OWNED_TABLE_FAMILIES,
  type PromptTemplateDescriptor,
  type PromptTemplateRegistry,
  auditChannelForBillingEvent,
  buildAdvisoryDisplayAuditEvent,
  denyAiAdvisoryReader,
  outputTypeTargetsBilling,
  validateAiBlockForBilling,
  validateBillingAiBlockAtBoot,
} from "./ai-block";
import { rejectAiActor } from "./routes/actor";

// A tiny in-memory registry double (M32 is a placeholder; the real registry is M32-owned).
const registryOf = (templates: readonly PromptTemplateDescriptor[]): PromptTemplateRegistry => ({
  list: () => templates,
});

// ── §D13 boot validator: EMPTY-SAFE (M32 placeholder today) ────────────────────────────────────────────────
describe("validateAiBlockForBilling — empty-safe with no M32 registry", () => {
  it("passes (returns []) when the registry is undefined (M32 not yet registered)", () => {
    expect(validateAiBlockForBilling()).toEqual([]);
    expect(validateAiBlockForBilling(undefined)).toEqual([]);
  });

  it("passes when the registry is null", () => {
    expect(validateAiBlockForBilling(null)).toEqual([]);
  });

  it("passes when the registry lists zero templates", () => {
    expect(validateAiBlockForBilling(registryOf([]))).toEqual([]);
  });

  it("passes (and echoes the inspected set) when templates target only NON-M23 tables", () => {
    const templates: readonly PromptTemplateDescriptor[] = [
      { key: "m9.summarize-assessment", outputType: "assessment_summary" },
      { key: "m22.intake-extract", outputType: "intake_upload_batch" },
      { key: "m30.measure-narrative", outputType: "quality_measure_note" },
    ];
    expect(validateAiBlockForBilling(registryOf(templates))).toEqual(templates);
  });
});

// ── §D13 boot validator: FAILS BOOT on any M23-targeting template ──────────────────────────────────────────
describe("validateAiBlockForBilling — fails boot on an M23-targeting template", () => {
  it("throws AiBlockViolationError when a template writes a claim_* table", () => {
    const templates = [{ key: "m32.auto-fix-claim", outputType: "claim_line" }];
    expect(() => validateAiBlockForBilling(registryOf(templates))).toThrow(AiBlockViolationError);
  });

  it("names the offending template key(s) on the thrown error", () => {
    const templates: readonly PromptTemplateDescriptor[] = [
      { key: "m9.benign", outputType: "assessment_summary" },
      { key: "m32.auto-override", outputType: "validation_override" },
      { key: "m32.auto-noe", outputType: "noe_record" },
    ];
    try {
      validateAiBlockForBilling(registryOf(templates));
      expect.unreachable("expected the validator to fail boot");
    } catch (err) {
      expect(err).toBeInstanceOf(AiBlockViolationError);
      const e = err as AiBlockViolationError;
      expect(e.offendingTemplateKeys).toEqual(["m32.auto-override", "m32.auto-noe"]);
      // The benign (non-M23) template is never named.
      expect(e.offendingTemplateKeys).not.toContain("m9.benign");
      expect(e.message).toContain("validation_override");
    }
  });

  it("fails boot for EVERY M23-owned table family (one synthetic template per family)", () => {
    for (const family of M23_OWNED_TABLE_FAMILIES) {
      const outputType = `${family}thing`; // e.g. claim_thing, hipps_thing, wage_thing
      const templates = [{ key: `m32.target-${family}`, outputType }];
      expect(() => validateAiBlockForBilling(registryOf(templates))).toThrow(AiBlockViolationError);
    }
  });

  it("fails boot for the bare-root owned tables (claim / noe / notr)", () => {
    for (const exact of M23_OWNED_TABLE_EXACT) {
      const templates = [{ key: `m32.target-${exact}`, outputType: exact }];
      expect(() => validateAiBlockForBilling(registryOf(templates))).toThrow(AiBlockViolationError);
    }
  });
});

// ── §D13 owned-table matcher ───────────────────────────────────────────────────────────────────────────────
describe("outputTypeTargetsBilling — owned-table family matcher", () => {
  it("matches every owned family prefix (case- and whitespace-insensitive)", () => {
    expect(outputTypeTargetsBilling("claim_submission")).toBe(true);
    expect(outputTypeTargetsBilling("VALIDATION_RESULT")).toBe(true);
    expect(outputTypeTargetsBilling("  hipps_calculation  ")).toBe(true);
    expect(outputTypeTargetsBilling("sia_calculation")).toBe(true);
    expect(outputTypeTargetsBilling("eligibility_check")).toBe(true);
    expect(outputTypeTargetsBilling("sequestration_policy")).toBe(true);
    expect(outputTypeTargetsBilling("mac_submitter_credential")).toBe(true);
    expect(outputTypeTargetsBilling("wage_index_factor")).toBe(true);
    expect(outputTypeTargetsBilling("notr_record")).toBe(true);
  });

  it("matches the bare owned roots", () => {
    expect(outputTypeTargetsBilling("claim")).toBe(true);
    expect(outputTypeTargetsBilling("noe")).toBe(true);
    expect(outputTypeTargetsBilling("notr")).toBe(true);
  });

  it("does NOT match unrelated tables or an empty string", () => {
    expect(outputTypeTargetsBilling("assessment_summary")).toBe(false);
    expect(outputTypeTargetsBilling("patient")).toBe(false);
    expect(outputTypeTargetsBilling("claimant_note")).toBe(false); // not a claim_ / claim root
    expect(outputTypeTargetsBilling("")).toBe(false);
    expect(outputTypeTargetsBilling("   ")).toBe(false);
  });
});

// ── §D13 per-route actor_kind='ai_*' reject guard (rejectAiActor) ──────────────────────────────────────────
describe("rejectAiActor — the per-route AI-principal reject guard", () => {
  const reply = {} as FastifyReply;
  const requestWithActorKind = (actorKind: string | undefined): FastifyRequest =>
    ({
      context: actorKind === undefined ? { attributes: {} } : { attributes: { actorKind } },
    }) as unknown as FastifyRequest;

  it("REJECTS an ai_* principal with a structured 403 (D13)", async () => {
    const guard = rejectAiActor();
    await expect(guard(requestWithActorKind("ai_assistant"), reply)).rejects.toThrow(
      /AI principals cannot create or modify billing records/i,
    );
    await expect(guard(requestWithActorKind("ai_agent"), reply)).rejects.toThrow();
  });

  it("ADMITS a human / system / integration / missing actor kind (fail-closed only on the ai_ prefix)", async () => {
    const guard = rejectAiActor();
    await expect(guard(requestWithActorKind("user"), reply)).resolves.toBeUndefined();
    await expect(guard(requestWithActorKind("system"), reply)).resolves.toBeUndefined();
    await expect(guard(requestWithActorKind("integration"), reply)).resolves.toBeUndefined();
    await expect(guard(requestWithActorKind(undefined), reply)).resolves.toBeUndefined();
  });

  it("does not over-match a non-ai actor kind that merely contains 'ai' mid-string", async () => {
    const guard = rejectAiActor();
    // Only a leading `ai_` prefix is an AI principal; 'maintainer' / 'paid_user' must pass.
    await expect(guard(requestWithActorKind("maintainer"), reply)).resolves.toBeUndefined();
    await expect(guard(requestWithActorKind("paid_user"), reply)).resolves.toBeUndefined();
  });
});

// ── §D13 / task 61: the only admitted AI surface — read-only advisory reader DENY-STUB ─────────────────────
describe("denyAiAdvisoryReader — non-gating deny-stub (M32 not yet locked)", () => {
  it("returns NO advisories (empty) rather than throwing — never gates the worklist read", async () => {
    const reader = denyAiAdvisoryReader();
    await expect(reader.advisoriesForResult("org-1", "vr-1")).resolves.toEqual([]);
  });

  it("never throws across arbitrary ids (the advisory surface can never break the read path)", async () => {
    const reader = denyAiAdvisoryReader();
    for (const id of ["", "vr-2", "vr-with-😀", "00000000-0000-0000-0000-000000000000"]) {
      await expect(reader.advisoriesForResult("org-x", id)).resolves.toEqual([]);
    }
  });
});

// ── GAP-137: the async boot validator over the REAL M32 registry (D18 table-only query) ────────────────────
describe("validateBillingAiBlockAtBoot — real-registry boot gate", () => {
  const targeting = (...outputs: string[]) => ({
    getActivePromptsTargeting: async (prefix: string) =>
      outputs
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ templateKey: `k.${o}`, outputEntityTargetPrefix: o })),
  });

  it("passes with no registry and with an empty registry", async () => {
    await expect(validateBillingAiBlockAtBoot(undefined)).resolves.toBeUndefined();
    await expect(validateBillingAiBlockAtBoot(targeting())).resolves.toBeUndefined();
  });

  it("refuses boot when an active template targets an M23 table family or bare root", async () => {
    await expect(validateBillingAiBlockAtBoot(targeting("claim_line"))).rejects.toBeInstanceOf(
      AiBlockViolationError,
    );
    await expect(validateBillingAiBlockAtBoot(targeting("noe"))).rejects.toBeInstanceOf(
      AiBlockViolationError,
    );
  });

  it("admits the read-only validation_ai_advisory projection", async () => {
    await expect(
      validateBillingAiBlockAtBoot(targeting("validation_ai_advisory")),
    ).resolves.toBeUndefined();
  });
});

// ── §D13 / task 62: AI-governance audit channel separation ─────────────────────────────────────────────────
describe("auditChannelForBillingEvent — AI-gov vs operational channel separation", () => {
  it("routes the advisory-display event to the AI-governance channel", () => {
    expect(auditChannelForBillingEvent(ADVISORY_DISPLAY_EVENT_TYPE)).toBe("ai_governance");
    expect(ADVISORY_DISPLAY_EVENT_TYPE).toContain("ai_advisory");
  });

  it("routes operational claim/override/submission events to the operational channel", () => {
    const operational = [
      "m23.claim.draft_created",
      "m23.claim.submitted",
      "m23.claim.override_applied",
      "m23.claim.adjudicated",
      "m23.noe.submitted",
      "m23.notr.submitted",
    ];
    for (const eventType of operational) {
      expect(auditChannelForBillingEvent(eventType)).toBe("operational");
    }
  });

  it("the two streams are DISJOINT — no operational event ever lands on the AI-gov channel and vice-versa", () => {
    // The advisory family is the ONLY thing on the AI-gov channel; everything operational is excluded.
    expect(auditChannelForBillingEvent("m23.claim.override_applied")).not.toBe(
      auditChannelForBillingEvent(ADVISORY_DISPLAY_EVENT_TYPE),
    );
  });

  it("buildAdvisoryDisplayAuditEvent pins the AI-governance channel on the audit context (PHI-free)", () => {
    const evt = buildAdvisoryDisplayAuditEvent({
      validationResultId: "vr-9",
      modelVersion: "claude-x",
    });
    expect(evt.eventType).toBe(ADVISORY_DISPLAY_EVENT_TYPE);
    expect(evt.auditChannel).toBe("ai_governance");
    expect(evt.context.auditChannel).toBe("ai_governance");
    expect(evt.resourceKind).toBe("validation_result");
    expect(evt.resourceId).toBe("vr-9");
    // The built event carries NO claim/override/MBI/PHI fields — only ids + model version.
    expect(Object.keys(evt.context)).toEqual(["auditChannel", "modelVersion"]);
  });
});
