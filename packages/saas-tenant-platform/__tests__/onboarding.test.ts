// @wardenx/saas-tenant-platform — §2.3 onboarding: precondition-DSL evaluator + the (XState-shaped)
// machine config + the strictly-observable advance interpreter + the eleven canonical steps (M34 / D3).
//
// Pure, IO-free assertions over the real implementation:
//   • src/onboarding/precondition-dsl.ts — every canonical precondition expression evaluates met vs blocked
//     over a hand-built OnboardingContext (the §3.12 seed expressions, verbatim);
//   • src/onboarding/machine.ts — the interpreter advances a step ONLY when its precondition holds (else
//     it blocks and the walk stops), unblocks a recovered step, and reaches the §2.3 `[*]` completion;
//   • src/onboarding/steps.ts — the eleven canonical steps are present, in `canonical_order`.
import { describe, expect, it } from "vitest";
import type { OnboardingContext, OnboardingProviderEntityView } from "../src/onboarding/context";
import {
  type OnboardingEmit,
  type OnboardingStepState,
  type OnboardingTaskStatus,
  advanceOnboarding,
  buildOnboardingMachineConfig,
} from "../src/onboarding/machine";
import { PreconditionDslError, evaluatePrecondition } from "../src/onboarding/precondition-dsl";
import {
  CANONICAL_ONBOARDING_STEPS,
  ONBOARDING_DONE,
  canonicalStepIndex,
  isCanonicalOnboardingStep,
} from "../src/onboarding/steps";

// ── the §3.12 seed catalog (migration 0054), mirrored verbatim — key, canonical_order, precondition_dsl,
//    is_canonical. The machine's state floor is data-driven from exactly these rows (D3). ────────────────
const CANONICAL_TEMPLATES: ReadonlyArray<{
  readonly key: string;
  readonly preconditionDsl: string | null;
  readonly isCanonical: boolean;
  readonly canonicalOrder: number;
}> = [
  { key: "account_created", preconditionDsl: null, isCanonical: true, canonicalOrder: 1 },
  {
    key: "org_seeded",
    preconditionDsl: "context.providerEntityCount > 0 AND context.locationCount > 0",
    isCanonical: true,
    canonicalOrder: 2,
  },
  {
    key: "ccn_registered",
    preconditionDsl: "context.providerEntities[*].ccn != null",
    isCanonical: true,
    canonicalOrder: 3,
  },
  {
    key: "mac_configured",
    preconditionDsl: "context.macFeedConfigured == true",
    isCanonical: true,
    canonicalOrder: 4,
  },
  {
    key: "dosespot_kickoff_initiated",
    preconditionDsl: "context.dosespotKickoffRecorded == true",
    isCanonical: true,
    canonicalOrder: 5,
  },
  {
    key: "xero_connected",
    preconditionDsl: "context.xeroConnected == true",
    isCanonical: true,
    canonicalOrder: 6,
  },
  {
    key: "payroll_connected",
    preconditionDsl: "context.gustoConnected == true",
    isCanonical: true,
    canonicalOrder: 7,
  },
  {
    key: "locations_seeded",
    preconditionDsl: "context.primaryLocationExists == true",
    isCanonical: true,
    canonicalOrder: 8,
  },
  {
    key: "first_admin_invited",
    preconditionDsl: "context.orgAdminAcceptedMembershipCount > 0",
    isCanonical: true,
    canonicalOrder: 9,
  },
  { key: "sample_data_loaded", preconditionDsl: null, isCanonical: true, canonicalOrder: 10 },
  {
    key: "go_live_checklist_complete",
    preconditionDsl:
      "context.allCanonicalTasksDoneOrSkipped == true AND context.baaExecuted == true",
    isCanonical: true,
    canonicalOrder: 11,
  },
];

const pe = (id: string, ccn: string | null): OnboardingProviderEntityView => ({
  providerEntityId: id,
  ccn,
});

/** A context in which EVERY one of the eleven canonical preconditions is satisfied. Each "blocked"
 *  case below is one `metContext()` with a single fact flipped — so the assertion isolates the field. */
function metContext(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    providerEntityCount: 2,
    locationCount: 3,
    providerEntities: [pe("pe-1", "012345"), pe("pe-2", "678901")],
    macFeedConfigured: true,
    dosespotKickoffRecorded: true,
    xeroConnected: true,
    gustoConnected: true,
    primaryLocationExists: true,
    orgAdminAcceptedMembershipCount: 1,
    allCanonicalTasksDoneOrSkipped: true,
    baaExecuted: true,
    ...overrides,
  };
}

/** Build the eleven canonical step states in canonical order, defaulting to `pending`, with a per-key
 *  status override map. dueAt/blockedSince default null (the overdue/blocked-age sweeps are off). */
function makeSteps(
  statusByKey: Readonly<Record<string, OnboardingTaskStatus>> = {},
): OnboardingStepState[] {
  return CANONICAL_TEMPLATES.map((t) => ({
    templateKey: t.key,
    preconditionDsl: t.preconditionDsl,
    isCanonical: t.isCanonical,
    status: statusByKey[t.key] ?? ("pending" as OnboardingTaskStatus),
    dueAt: null,
    blockedSince: null,
  }));
}

const kinds = (emits: readonly OnboardingEmit[]): string[] => emits.map((e) => e.kind);
const hasKind = (emits: readonly OnboardingEmit[], kind: OnboardingEmit["kind"]): boolean =>
  emits.some((e) => e.kind === kind);

const CONFIG = buildOnboardingMachineConfig(CANONICAL_TEMPLATES);
const NOW = new Date("2026-06-25T12:00:00.000Z");

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. The eleven canonical steps are present, in `canonical_order` (§2.3 / §3.12).
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("§2.3 / §3.12 canonical onboarding steps", () => {
  it("declares exactly eleven canonical step keys in canonical order", () => {
    expect(CANONICAL_ONBOARDING_STEPS).toEqual([
      "account_created",
      "org_seeded",
      "ccn_registered",
      "mac_configured",
      "dosespot_kickoff_initiated",
      "xero_connected",
      "payroll_connected",
      "locations_seeded",
      "first_admin_invited",
      "sample_data_loaded",
      "go_live_checklist_complete",
    ]);
    expect(CANONICAL_ONBOARDING_STEPS).toHaveLength(11);
  });

  it("the constant order matches the §3.12 seed canonical_order", () => {
    const seedOrder = [...CANONICAL_TEMPLATES]
      .sort((a, b) => a.canonicalOrder - b.canonicalOrder)
      .map((t) => t.key);
    expect([...CANONICAL_ONBOARDING_STEPS]).toEqual(seedOrder);
  });

  it("isCanonicalOnboardingStep accepts the eleven and rejects an unknown / agency key", () => {
    for (const key of CANONICAL_ONBOARDING_STEPS) {
      expect(isCanonicalOnboardingStep(key)).toBe(true);
    }
    expect(isCanonicalOnboardingStep("agency_custom_step")).toBe(false);
    expect(isCanonicalOnboardingStep(ONBOARDING_DONE)).toBe(false);
  });

  it("canonicalStepIndex returns the 0-based order, and -1 for non-canonical keys", () => {
    expect(canonicalStepIndex("account_created")).toBe(0);
    expect(canonicalStepIndex("go_live_checklist_complete")).toBe(10);
    expect(canonicalStepIndex("ccn_registered")).toBe(2);
    expect(canonicalStepIndex("not_a_step")).toBe(-1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Each canonical precondition expression evaluates correctly over a context (met vs blocked).
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("§2.3 precondition-DSL: canonical expressions met vs blocked", () => {
  it("a NULL / empty precondition is always satisfied (account_created, sample_data_loaded)", () => {
    expect(evaluatePrecondition(null, metContext())).toBe(true);
    expect(evaluatePrecondition(undefined, metContext())).toBe(true);
    expect(evaluatePrecondition("   ", metContext())).toBe(true);
  });

  it("every canonical precondition is MET under the fully-satisfied context", () => {
    for (const t of CANONICAL_TEMPLATES) {
      expect(evaluatePrecondition(t.preconditionDsl, metContext())).toBe(true);
    }
  });

  it("org_seeded: met when both counts > 0, blocked when either is 0", () => {
    const expr = "context.providerEntityCount > 0 AND context.locationCount > 0";
    expect(evaluatePrecondition(expr, metContext())).toBe(true);
    expect(evaluatePrecondition(expr, metContext({ providerEntityCount: 0 }))).toBe(false);
    expect(evaluatePrecondition(expr, metContext({ locationCount: 0 }))).toBe(false);
    expect(
      evaluatePrecondition(expr, metContext({ providerEntityCount: 0, locationCount: 0 })),
    ).toBe(false);
  });

  it("ccn_registered: met when EVERY provider entity has a CCN, blocked if ANY is null", () => {
    const expr = "context.providerEntities[*].ccn != null";
    expect(evaluatePrecondition(expr, metContext())).toBe(true);
    expect(
      evaluatePrecondition(expr, metContext({ providerEntities: [pe("a", "111"), pe("b", null)] })),
    ).toBe(false);
    expect(evaluatePrecondition(expr, metContext({ providerEntities: [pe("a", null)] }))).toBe(
      false,
    );
  });

  it("ccn_registered: an empty provider-entity array is VACUOUSLY true (the [*] universal)", () => {
    // The DSL `[*]` is universal: `.every()` over an empty array is true — which is why the seed pairs
    // CCN with org_seeded's `providerEntityCount > 0` so emptiness blocks upstream (DSL header note).
    expect(
      evaluatePrecondition(
        "context.providerEntities[*].ccn != null",
        metContext({ providerEntities: [] }),
      ),
    ).toBe(true);
  });

  it("the boolean-attestation steps: met on == true, blocked on == false", () => {
    const cases: ReadonlyArray<[string, keyof OnboardingContext]> = [
      ["context.macFeedConfigured == true", "macFeedConfigured"],
      ["context.dosespotKickoffRecorded == true", "dosespotKickoffRecorded"],
      ["context.xeroConnected == true", "xeroConnected"],
      ["context.gustoConnected == true", "gustoConnected"],
      ["context.primaryLocationExists == true", "primaryLocationExists"],
    ];
    for (const [expr, field] of cases) {
      expect(evaluatePrecondition(expr, metContext())).toBe(true);
      expect(
        evaluatePrecondition(expr, metContext({ [field]: false } as Partial<OnboardingContext>)),
      ).toBe(false);
    }
  });

  it("first_admin_invited: met when accepted org_admin count > 0, blocked at 0", () => {
    const expr = "context.orgAdminAcceptedMembershipCount > 0";
    expect(evaluatePrecondition(expr, metContext({ orgAdminAcceptedMembershipCount: 1 }))).toBe(
      true,
    );
    expect(evaluatePrecondition(expr, metContext({ orgAdminAcceptedMembershipCount: 3 }))).toBe(
      true,
    );
    expect(evaluatePrecondition(expr, metContext({ orgAdminAcceptedMembershipCount: 0 }))).toBe(
      false,
    );
  });

  it("go_live_checklist_complete: AND of both clauses — blocked if EITHER is false (D11 BAA gate)", () => {
    const expr = "context.allCanonicalTasksDoneOrSkipped == true AND context.baaExecuted == true";
    expect(evaluatePrecondition(expr, metContext())).toBe(true);
    expect(evaluatePrecondition(expr, metContext({ baaExecuted: false }))).toBe(false);
    expect(evaluatePrecondition(expr, metContext({ allCanonicalTasksDoneOrSkipped: false }))).toBe(
      false,
    );
    expect(
      evaluatePrecondition(
        expr,
        metContext({ baaExecuted: false, allCanonicalTasksDoneOrSkipped: false }),
      ),
    ).toBe(false);
  });

  it("OR / precedence / parentheses evaluate correctly", () => {
    // OR is satisfied when either side holds; AND binds tighter than OR.
    expect(
      evaluatePrecondition(
        "context.baaExecuted == true OR context.macFeedConfigured == true",
        metContext({ baaExecuted: false }),
      ),
    ).toBe(true);
    expect(
      evaluatePrecondition(
        "context.baaExecuted == false OR context.macFeedConfigured == false",
        metContext(),
      ),
    ).toBe(false);
    // (A OR B) AND C — parenthesised group.
    expect(
      evaluatePrecondition(
        "(context.baaExecuted == false OR context.xeroConnected == true) AND context.gustoConnected == true",
        metContext({ baaExecuted: false }),
      ),
    ).toBe(true);
  });

  it("a malformed precondition throws PreconditionDslError (a bad seed fails loud, never silently passes)", () => {
    expect(() => evaluatePrecondition("context.unknownField == true", metContext())).toThrow(
      PreconditionDslError,
    );
    expect(() => evaluatePrecondition("context.providerEntityCount >", metContext())).toThrow(
      PreconditionDslError,
    );
    expect(() => evaluatePrecondition("providerEntityCount > 0", metContext())).toThrow(
      PreconditionDslError,
    );
    // relational on non-numeric operands is rejected.
    expect(() => evaluatePrecondition("context.macFeedConfigured > 0", metContext())).toThrow(
      PreconditionDslError,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. The machine config — the eleven steps wired into a linear graph, in order, ending at __done__.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("§2.3 buildOnboardingMachineConfig", () => {
  it("assembles the eleven canonical nodes in canonical order with account_created initial", () => {
    expect(CONFIG.id).toBe("m34.onboarding");
    expect(CONFIG.initial).toBe("account_created");
    expect(CONFIG.nodes.map((n) => n.key)).toEqual([...CANONICAL_ONBOARDING_STEPS]);
    expect(CONFIG.nodes).toHaveLength(11);
  });

  it("each node advances to its successor; the last targets __done__", () => {
    for (let i = 0; i < CONFIG.nodes.length - 1; i += 1) {
      const node = CONFIG.nodes[i]!;
      const next = CONFIG.nodes[i + 1]!;
      expect(node.onAdvance.target).toBe(next.key);
    }
    expect(CONFIG.nodes[CONFIG.nodes.length - 1]!.onAdvance.target).toBe(ONBOARDING_DONE);
  });

  it("each node's guard is its seed precondition_dsl (data-driven, not a code branch — D3)", () => {
    for (const t of CANONICAL_TEMPLATES) {
      const node = CONFIG.nodes.find((n) => n.key === t.key)!;
      expect(node.preconditionDsl).toBe(t.preconditionDsl);
      expect(node.onAdvance.whenPreconditionHolds).toBe(t.preconditionDsl);
      expect(node.isCanonical).toBe(true);
    }
  });

  it("sorts templates by canonical_order regardless of input order", () => {
    const shuffled = [...CANONICAL_TEMPLATES].reverse();
    const cfg = buildOnboardingMachineConfig(shuffled);
    expect(cfg.nodes.map((n) => n.key)).toEqual([...CANONICAL_ONBOARDING_STEPS]);
    expect(cfg.initial).toBe("account_created");
  });

  it("refuses an empty template floor", () => {
    expect(() => buildOnboardingMachineConfig([])).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. The interpreter advances a step ONLY when its precondition is met (else blocks; the walk stops).
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("§2.3 advanceOnboarding — advances only when the precondition is met", () => {
  it("completes the first non-terminal step when its precondition holds (account_created → org_seeded)", () => {
    const res = advanceOnboarding(CONFIG, makeSteps(), metContext(), NOW);
    expect(res.currentStep).toBe("account_created");
    expect(res.nextStep).toBe("org_seeded");
    const completed = res.emits.filter((e) => e.kind === "step_completed");
    expect(completed).toHaveLength(1);
    expect((completed[0] as { templateKey: string }).templateKey).toBe("account_created");
    expect(hasKind(res.emits, "step_blocked")).toBe(false);
  });

  it("settles the first guarded step (org_seeded) ONLY when its DSL precondition holds", () => {
    // account_created already done → org_seeded is the first non-terminal step under evaluation.
    const steps = makeSteps({ account_created: "done", org_seeded: "in_progress" });

    // precondition MET → step_completed, advance to ccn_registered.
    const met = advanceOnboarding(CONFIG, steps, metContext(), NOW);
    expect(met.currentStep).toBe("org_seeded");
    expect(met.nextStep).toBe("ccn_registered");
    expect(hasKind(met.emits, "step_completed")).toBe(true);
    expect(hasKind(met.emits, "step_blocked")).toBe(false);

    // precondition NOT met → step_blocked, the machine does NOT advance.
    const blocked = advanceOnboarding(CONFIG, steps, metContext({ providerEntityCount: 0 }), NOW);
    expect(blocked.currentStep).toBe("org_seeded");
    expect(blocked.nextStep).toBe("org_seeded");
    expect(hasKind(blocked.emits, "step_completed")).toBe(false);
    const blk = blocked.emits.find((e) => e.kind === "step_blocked")!;
    expect((blk as { templateKey: string }).templateKey).toBe("org_seeded");
    expect((blk as { outbox: string }).outbox).toBe("m34.tenant.onboarding_step_blocked");
    expect((blk as { blockerReason: string }).blockerReason).toContain("org_seeded");
  });

  it("a blocker GATES the rest: later steps never advance past an unmet precondition", () => {
    // org_seeded blocked (providerEntityCount 0); ccn_registered would otherwise be met — it must NOT settle.
    const steps = makeSteps({ account_created: "done", org_seeded: "blocked" });
    const res = advanceOnboarding(CONFIG, steps, metContext({ providerEntityCount: 0 }), NOW);
    expect(res.currentStep).toBe("org_seeded");
    expect(kinds(res.emits)).not.toContain("step_completed");
    // already-blocked-and-still-blocked emits nothing new for that step.
    expect(hasKind(res.emits, "step_blocked")).toBe(false);
  });

  it("recovers a blocked step: step_unblocked precedes step_completed once the precondition holds again", () => {
    const steps = makeSteps({ account_created: "done", org_seeded: "blocked" });
    const res = advanceOnboarding(CONFIG, steps, metContext(), NOW);
    const order = kinds(res.emits);
    expect(order).toContain("step_unblocked");
    expect(order).toContain("step_completed");
    expect(order.indexOf("step_unblocked")).toBeLessThan(order.indexOf("step_completed"));
    expect(res.nextStep).toBe("ccn_registered");
  });

  it("a skipped step is terminal — the walk steps over it to the next non-terminal step", () => {
    const steps = makeSteps({
      account_created: "done",
      org_seeded: "done",
      ccn_registered: "skipped",
      mac_configured: "in_progress",
    });
    const res = advanceOnboarding(CONFIG, steps, metContext(), NOW);
    expect(res.currentStep).toBe("mac_configured");
    const completed = res.emits.filter((e) => e.kind === "step_completed");
    expect((completed[0] as { templateKey: string }).templateKey).toBe("mac_configured");
  });

  it("emits onboarding_completed and __done__ when every canonical step is settled", () => {
    const allDone: Record<string, OnboardingTaskStatus> = {};
    for (const k of CANONICAL_ONBOARDING_STEPS) allDone[k] = "done";
    allDone.sample_data_loaded = "skipped"; // the optional step may be skipped
    const res = advanceOnboarding(CONFIG, makeSteps(allDone), metContext(), NOW);
    expect(res.nextStep).toBe(ONBOARDING_DONE);
    const done = res.emits.find((e) => e.kind === "onboarding_completed");
    expect(done).toBeDefined();
    expect((done as { outbox: string }).outbox).toBe("m34.tenant.onboarding_completed");
    expect((done as { canonicalCompleted: number }).canonicalCompleted).toBe(10);
    expect((done as { canonicalSkipped: number }).canonicalSkipped).toBe(1);
  });

  it("rolls a final-step completion straight into onboarding_completed in the same pass", () => {
    const statuses: Record<string, OnboardingTaskStatus> = {};
    for (const k of CANONICAL_ONBOARDING_STEPS) statuses[k] = "done";
    statuses.go_live_checklist_complete = "in_progress"; // last step still open, precondition now holds
    const res = advanceOnboarding(CONFIG, makeSteps(statuses), metContext(), NOW);
    expect(hasKind(res.emits, "step_completed")).toBe(true);
    expect(hasKind(res.emits, "onboarding_completed")).toBe(true);
    expect(res.nextStep).toBe(ONBOARDING_DONE);
  });

  it("raises step_overdue (alert-only) for a non-terminal step past due, without changing the walk", () => {
    const steps = makeSteps({ account_created: "done", org_seeded: "in_progress" });
    const overdue = steps.map((s) =>
      s.templateKey === "org_seeded" ? { ...s, dueAt: new Date(NOW.getTime() - 2 * 3_600_000) } : s,
    );
    const res = advanceOnboarding(CONFIG, overdue, metContext(), NOW);
    const od = res.emits.find((e) => e.kind === "step_overdue");
    expect(od).toBeDefined();
    expect((od as { templateKey: string }).templateKey).toBe("org_seeded");
    expect((od as { hoursOverdue: number }).hoursOverdue).toBeCloseTo(2, 5);
    expect((od as { outbox: string }).outbox).toBe("m34.tenant.onboarding_overdue");
    // overdue is independent of the advance: org_seeded still completes (precondition met).
    expect(hasKind(res.emits, "step_completed")).toBe(true);
  });
});
