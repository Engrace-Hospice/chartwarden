// @chartwarden/saas-tenant-platform — §2.3 onboarding: precondition-DSL evaluator + the (XState-shaped)
// machine config + the strictly-observable advance interpreter + the canonical wizard steps (M34 / D3).
//
// Pure, IO-free assertions over the real implementation:
//   • src/onboarding/precondition-dsl.ts — every canonical precondition expression evaluates met vs blocked
//     over a hand-built OnboardingContext (the migration 1327 seed expressions, verbatim);
//   • src/onboarding/machine.ts — the interpreter settles an `auto`/`either` step ONLY when its precondition holds,
//     waits at an `attestation` step, blocks an `auto` step that cannot settle, and never activates a tenant;
//   • src/onboarding/steps.ts — the canonical steps are present, in the wizard's order.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OnboardingContext, OnboardingProviderEntityView } from "../src/onboarding/context";
import {
  type OnboardingCompletionMode,
  type OnboardingEmit,
  type OnboardingStepState,
  type OnboardingTaskStatus,
  advanceOnboarding,
  buildOnboardingMachineConfig,
} from "../src/onboarding/machine";
import { PreconditionDslError, evaluatePrecondition } from "../src/onboarding/precondition-dsl";
import {
  CANONICAL_ONBOARDING_STEPS,
  GO_LIVE_ROLLBACK_GUARD_DSL,
  ONBOARDING_DONE,
  canonicalStepIndex,
  isCanonicalOnboardingStep,
} from "../src/onboarding/steps";

// ── the wizard catalog (migration 1327), mirrored verbatim — key, canonical_order, precondition_dsl,
//    completion_mode, is_optional. The machine's state floor is data-driven from exactly these rows (D3). ──────
interface Template {
  readonly key: string;
  readonly preconditionDsl: string | null;
  readonly isCanonical: boolean;
  readonly canonicalOrder: number;
  readonly completionMode: OnboardingCompletionMode;
  readonly isOptional: boolean;
}
const t = (
  key: string,
  canonicalOrder: number,
  completionMode: OnboardingCompletionMode,
  preconditionDsl: string | null,
  isOptional = false,
): Template => ({
  key,
  preconditionDsl,
  isCanonical: true,
  canonicalOrder,
  completionMode,
  isOptional,
});

// Every attestation-mode row carries the rollback tripwire, as migration 1327 seeds it (a NULL there would let the PREVIOUS
// release's sweep settle the step on its own); the new machine must ignore it. A test below pins the migration to this.
const attestation = (key: string, canonicalOrder: number, isOptional = false): Template =>
  t(key, canonicalOrder, "attestation", GO_LIVE_ROLLBACK_GUARD_DSL, isOptional);
const CANONICAL_TEMPLATES: readonly Template[] = [
  attestation("account_created", 1),
  attestation("plan_contract", 2),
  t("baa_executed", 3, "auto", "context.baaExecuted == true"),
  t("provisioning_complete", 4, "auto", null),
  attestation("ccn_registered", 5),
  t("locations_seeded", 6, "either", "context.primaryLocationExists == true"),
  attestation("clearinghouse_selected", 7),
  t("mac_configured", 8, "either", "context.macFeedConfigured == true"),
  attestation("payer_enrollment", 9),
  t("dosespot_kickoff_initiated", 10, "either", "context.dosespotKickoffRecorded == true"),
  t("first_admin_invited", 11, "auto", "context.orgAdminAcceptedMembershipCount > 0"),
  t("compliance_officer_assigned", 12, "either", "context.complianceOfficerAssigned == true"),
  attestation("sample_data_loaded", 13, true),
  attestation("go_live_checklist_complete", 14),
];

const pe = (id: string, ccn: string | null): OnboardingProviderEntityView => ({
  providerEntityId: id,
  ccn,
});

/** A context in which EVERY canonical precondition is satisfied. Each "blocked" case below is one
 *  `metContext()` with a single fact flipped — so the assertion isolates the field. */
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
    complianceOfficerAssigned: true,
    allCanonicalTasksDoneOrSkipped: true,
    baaExecuted: true,
    ...overrides,
  };
}

/** The canonical step states in order, defaulting to `pending`, with a per-key status override map. */
function makeSteps(
  statusByKey: Readonly<Record<string, OnboardingTaskStatus>> = {},
): OnboardingStepState[] {
  return CANONICAL_TEMPLATES.map((tpl) => ({
    templateKey: tpl.key,
    preconditionDsl: tpl.preconditionDsl,
    isCanonical: tpl.isCanonical,
    completionMode: tpl.completionMode,
    isOptional: tpl.isOptional,
    status: statusByKey[tpl.key] ?? ("pending" as OnboardingTaskStatus),
    dueAt: null,
    blockedSince: null,
  }));
}

/** Every step through `through` (inclusive, in wizard order) done; the rest pending. */
function doneThrough(through: string): Record<string, OnboardingTaskStatus> {
  const out: Record<string, OnboardingTaskStatus> = {};
  for (const tpl of CANONICAL_TEMPLATES) {
    out[tpl.key] = "done";
    if (tpl.key === through) break;
  }
  return out;
}

const kinds = (emits: readonly OnboardingEmit[]): string[] => emits.map((e) => e.kind);
const hasKind = (emits: readonly OnboardingEmit[], kind: OnboardingEmit["kind"]): boolean =>
  emits.some((e) => e.kind === kind);
const completedKeys = (emits: readonly OnboardingEmit[]): string[] =>
  emits
    .filter((e) => e.kind === "step_completed")
    .map((e) => (e as { templateKey: string }).templateKey);

const CONFIG = buildOnboardingMachineConfig(CANONICAL_TEMPLATES);
const NOW = new Date("2026-06-25T12:00:00.000Z");

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. The canonical steps are present, in the wizard's order (§2.3 / migration 1327).
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("§2.3 canonical onboarding steps (wizard v2)", () => {
  it("declares the fourteen canonical step keys in wizard order, without the retired ones", () => {
    expect(CANONICAL_ONBOARDING_STEPS).toEqual(CANONICAL_TEMPLATES.map((tpl) => tpl.key));
    expect(CANONICAL_ONBOARDING_STEPS).toHaveLength(14);
    for (const retired of ["org_seeded", "xero_connected", "payroll_connected"]) {
      expect(CANONICAL_ONBOARDING_STEPS as readonly string[]).not.toContain(retired);
    }
  });

  it("the constant order matches the seed canonical_order", () => {
    const seedOrder = [...CANONICAL_TEMPLATES]
      .sort((a, b) => a.canonicalOrder - b.canonicalOrder)
      .map((tpl) => tpl.key);
    expect([...CANONICAL_ONBOARDING_STEPS]).toEqual(seedOrder);
  });

  it("isCanonicalOnboardingStep accepts the canonical keys and rejects an unknown / agency / retired key", () => {
    for (const key of CANONICAL_ONBOARDING_STEPS) {
      expect(isCanonicalOnboardingStep(key)).toBe(true);
    }
    expect(isCanonicalOnboardingStep("agency_custom_step")).toBe(false);
    expect(isCanonicalOnboardingStep("xero_connected")).toBe(false);
    expect(isCanonicalOnboardingStep(ONBOARDING_DONE)).toBe(false);
  });

  it("canonicalStepIndex returns the 0-based order, and -1 for non-canonical keys", () => {
    expect(canonicalStepIndex("account_created")).toBe(0);
    expect(canonicalStepIndex("go_live_checklist_complete")).toBe(13);
    expect(canonicalStepIndex("ccn_registered")).toBe(4);
    expect(canonicalStepIndex("not_a_step")).toBe(-1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Each canonical precondition expression evaluates correctly over a context (met vs blocked).
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("§2.3 precondition-DSL: canonical expressions met vs blocked", () => {
  it("a NULL / empty precondition is always satisfied (an `auto` step with no fact, e.g. provisioning_complete)", () => {
    expect(evaluatePrecondition(null, metContext())).toBe(true);
    expect(evaluatePrecondition(undefined, metContext())).toBe(true);
    expect(evaluatePrecondition("   ", metContext())).toBe(true);
  });

  it("every precondition the machine evaluates is MET under the fully-satisfied context", () => {
    // An attestation step is never evaluated (go-live's DSL is the old release's rollback tripwire, see section 5).
    for (const t of CANONICAL_TEMPLATES.filter((x) => x.completionMode !== "attestation")) {
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
      ["context.primaryLocationExists == true", "primaryLocationExists"],
      ["context.complianceOfficerAssigned == true", "complianceOfficerAssigned"],
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
// 3. The machine config — the steps wired into a linear graph, in order, ending at __done__.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("§2.3 buildOnboardingMachineConfig", () => {
  it("assembles the canonical nodes in wizard order with account_created initial", () => {
    expect(CONFIG.id).toBe("m34.onboarding");
    expect(CONFIG.initial).toBe("account_created");
    expect(CONFIG.nodes.map((n) => n.key)).toEqual([...CANONICAL_ONBOARDING_STEPS]);
    expect(CONFIG.nodes).toHaveLength(14);
  });

  it("each node advances to its successor; the last targets __done__", () => {
    for (let i = 0; i < CONFIG.nodes.length - 1; i += 1) {
      const node = CONFIG.nodes[i]!;
      const next = CONFIG.nodes[i + 1]!;
      expect(node.onAdvance.target).toBe(next.key);
    }
    expect(CONFIG.nodes[CONFIG.nodes.length - 1]!.onAdvance.target).toBe(ONBOARDING_DONE);
  });

  it("each node's guard, mode and optionality are the seed's (data-driven, not a code branch — D3)", () => {
    for (const tpl of CANONICAL_TEMPLATES) {
      const node = CONFIG.nodes.find((n) => n.key === tpl.key)!;
      // A step only a human settles is never evaluated, so the config drops its DSL (the go-live row's rollback guard).
      const evaluated = tpl.completionMode === "attestation" ? null : tpl.preconditionDsl;
      expect(node.preconditionDsl).toBe(evaluated);
      expect(node.onAdvance.whenPreconditionHolds).toBe(evaluated);
      expect(node.completionMode).toBe(tpl.completionMode);
      expect(node.isOptional).toBe(tpl.isOptional);
      expect(node.isCanonical).toBe(true);
    }
  });

  it("a template without a mode reads as `auto` and non-optional", () => {
    const cfg = buildOnboardingMachineConfig([
      { key: "x", preconditionDsl: null, isCanonical: true, canonicalOrder: 1 },
    ]);
    expect(cfg.nodes[0]).toMatchObject({ completionMode: "auto", isOptional: false });
  });

  it("sorts templates by canonical_order regardless of input order", () => {
    const cfg = buildOnboardingMachineConfig([...CANONICAL_TEMPLATES].reverse());
    expect(cfg.nodes.map((n) => n.key)).toEqual([...CANONICAL_ONBOARDING_STEPS]);
    expect(cfg.initial).toBe("account_created");
  });

  it("refuses an empty template floor", () => {
    expect(() => buildOnboardingMachineConfig([])).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. The interpreter: `auto`/`either` settle on a fact, `attestation` waits for a human, `auto` blocks.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("§2.3 advanceOnboarding — completion modes", () => {
  it("waits at an attestation step: emits nothing and does not look past it", () => {
    const res = advanceOnboarding(CONFIG, makeSteps(), metContext(), NOW);
    expect(res.currentStep).toBe("account_created");
    expect(res.nextStep).toBe("account_created");
    expect(res.emits).toEqual([]);
  });

  it("settles consecutive auto steps in ONE pass and stops at the next attestation step", () => {
    // account_created + plan_contract attested; baa_executed and provisioning_complete are auto.
    const steps = makeSteps({ account_created: "done", plan_contract: "done" });
    const res = advanceOnboarding(CONFIG, steps, metContext(), NOW);
    expect(completedKeys(res.emits)).toEqual(["baa_executed", "provisioning_complete"]);
    expect(res.currentStep).toBe("baa_executed");
    expect(res.nextStep).toBe("ccn_registered");
  });

  it("blocks an auto step whose fact does not hold, with the standard outbox, and stops there", () => {
    const steps = makeSteps({ account_created: "done", plan_contract: "done" });
    const res = advanceOnboarding(CONFIG, steps, metContext({ baaExecuted: false }), NOW);
    expect(completedKeys(res.emits)).toEqual([]);
    const blk = res.emits.find((e) => e.kind === "step_blocked")!;
    expect((blk as { templateKey: string }).templateKey).toBe("baa_executed");
    expect((blk as { outbox: string }).outbox).toBe("m34.tenant.onboarding_step_blocked");
    expect((blk as { blockerReason: string }).blockerReason).toContain("baa_executed");
    expect(res.nextStep).toBe("baa_executed");
  });

  it("an already-blocked auto step that is still unmet emits nothing new", () => {
    const steps = makeSteps({
      account_created: "done",
      plan_contract: "done",
      baa_executed: "blocked",
    });
    const res = advanceOnboarding(CONFIG, steps, metContext({ baaExecuted: false }), NOW);
    expect(res.emits).toEqual([]);
  });

  it("recovers a blocked step: step_unblocked precedes step_completed once the fact holds again", () => {
    const steps = makeSteps({
      account_created: "done",
      plan_contract: "done",
      baa_executed: "blocked",
    });
    const res = advanceOnboarding(CONFIG, steps, metContext(), NOW);
    const order = kinds(res.emits);
    expect(order.indexOf("step_unblocked")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("step_unblocked")).toBeLessThan(order.indexOf("step_completed"));
  });

  it("an `either` step settles when its fact holds, and waits SILENTLY (no block, no alert) when it does not", () => {
    const upToLocations = doneThrough("ccn_registered");
    const met = advanceOnboarding(CONFIG, makeSteps(upToLocations), metContext(), NOW);
    expect(completedKeys(met.emits)).toEqual(["locations_seeded"]);

    const unmet = advanceOnboarding(
      CONFIG,
      makeSteps(upToLocations),
      metContext({ primaryLocationExists: false }),
      NOW,
    );
    expect(unmet.emits).toEqual([]);
    expect(unmet.nextStep).toBe("locations_seeded");
  });

  it("an `either` step with no fact to read behaves as attestation-only", () => {
    const cfg = buildOnboardingMachineConfig([
      {
        key: "a",
        preconditionDsl: null,
        isCanonical: true,
        canonicalOrder: 1,
        completionMode: "either",
      },
    ]);
    const steps: OnboardingStepState[] = [
      {
        templateKey: "a",
        preconditionDsl: null,
        isCanonical: true,
        completionMode: "either",
        status: "pending",
        dueAt: null,
        blockedSince: null,
      },
    ];
    expect(advanceOnboarding(cfg, steps, metContext(), NOW).emits).toEqual([]);
  });

  it("a skipped step is terminal: the walk steps over it", () => {
    const statuses = { ...doneThrough("payer_enrollment"), mac_configured: "skipped" as const };
    const res = advanceOnboarding(CONFIG, makeSteps(statuses), metContext(), NOW);
    expect(completedKeys(res.emits)).toEqual([
      "dosespot_kickoff_initiated",
      "first_admin_invited",
      "compliance_officer_assigned",
    ]);
  });

  it("an optional step never gates the walk and is never driven by it", () => {
    const res = advanceOnboarding(
      CONFIG,
      makeSteps(doneThrough("compliance_officer_assigned")),
      metContext(),
      NOW,
    );
    // sample_data_loaded (optional, pending) is stepped over; go_live (attestation) is where the walk waits.
    expect(res.emits).toEqual([]);
    expect(res.currentStep).toBe("go_live_checklist_complete");
    expect(res.nextStep).toBe("go_live_checklist_complete");
  });

  it("reaches __done__ when everything is settled, and NEVER emits an activation", () => {
    const all: Record<string, OnboardingTaskStatus> = {};
    for (const k of CANONICAL_ONBOARDING_STEPS) all[k] = "done";
    const res = advanceOnboarding(CONFIG, makeSteps(all), metContext(), NOW);
    expect(res.nextStep).toBe(ONBOARDING_DONE);
    expect(res.emits).toEqual([]);
    expect(kinds(res.emits)).not.toContain("onboarding_completed");
  });

  it("raises step_overdue (alert-only) for a non-terminal step past due, without changing the walk", () => {
    const steps = makeSteps({
      account_created: "done",
      plan_contract: "done",
      baa_executed: "in_progress",
    });
    const overdue = steps.map((s) =>
      s.templateKey === "baa_executed"
        ? { ...s, dueAt: new Date(NOW.getTime() - 2 * 3_600_000) }
        : s,
    );
    const res = advanceOnboarding(CONFIG, overdue, metContext(), NOW);
    const od = res.emits.find((e) => e.kind === "step_overdue");
    expect(od).toBeDefined();
    expect((od as { templateKey: string }).templateKey).toBe("baa_executed");
    expect((od as { hoursOverdue: number }).hoursOverdue).toBeCloseTo(2, 5);
    expect((od as { outbox: string }).outbox).toBe("m34.tenant.onboarding_overdue");
    // overdue is independent of the advance: baa_executed still completes (fact holds).
    expect(completedKeys(res.emits)).toContain("baa_executed");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. Rollback safety of the go-live row. If the previous release is ever run against this schema (an operator restore),
//    the OLD sweep reads a NULL precondition as met and would settle go-live and auto-activate the tenant. The row
//    therefore carries a DSL the old evaluator cannot satisfy; the new code never evaluates it.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("go-live rollback guard", () => {
  it("is a DSL the evaluator cannot satisfy: an unknown context field fails loud, never reads as met", () => {
    expect(() => evaluatePrecondition(GO_LIVE_ROLLBACK_GUARD_DSL, metContext())).toThrow(
      PreconditionDslError,
    );
  });

  it("is on the go-live row of migration 1327, verbatim", () => {
    const sql = readFileSync(
      join(__dirname, "../../db/migrations/1327_m34_onboarding_wizard_v2.sql"),
      "utf8",
    );
    const row = sql.split("\n").find((line) => line.includes("'go_live_checklist_complete'"));
    expect(row).toContain(`'${GO_LIVE_ROLLBACK_GUARD_DSL}'`);
  });

  it("is on EVERY attestation-mode row of migration 1327, not only go-live (review fix L1: a NULL lets the old sweep settle the step)", () => {
    const sql = readFileSync(
      join(__dirname, "../../db/migrations/1327_m34_onboarding_wizard_v2.sql"),
      "utf8",
    );
    // The seed rows are the VALUES tuples that name a template key and a completion mode.
    const rows = sql
      .split("\n")
      .filter(
        (line) =>
          /^\s*\('[a-z_]+',/.test(line) &&
          /'(attestation|either|auto)',\s*(true|false)\)/.test(line),
      );
    const attestationRows = rows.filter((line) => /'attestation',\s*(true|false)\)/.test(line));
    const keys = attestationRows.map((line) => /^\s*\('([a-z_]+)'/.exec(line)?.[1]);
    expect(keys.sort()).toEqual(
      [
        "account_created",
        "ccn_registered",
        "clearinghouse_selected",
        "go_live_checklist_complete",
        "payer_enrollment",
        "plan_contract",
        "sample_data_loaded",
      ].sort(),
    );
    for (const line of attestationRows) {
      expect(line, line).toContain(`'${GO_LIVE_ROLLBACK_GUARD_DSL}'`);
    }
    // ...and the fixture above mirrors it: every attestation-mode template carries it.
    expect(
      CANONICAL_TEMPLATES.filter((tpl) => tpl.completionMode === "attestation").every(
        (tpl) => tpl.preconditionDsl === GO_LIVE_ROLLBACK_GUARD_DSL,
      ),
    ).toBe(true);
  });

  it("is ignored by the new machine for every attestation step: the walk waits at the first one and nothing is emitted or thrown", () => {
    const res = advanceOnboarding(CONFIG, makeSteps(), metContext(), NOW);
    expect(res.currentStep).toBe("account_created");
    expect(res.emits.filter((e) => e.kind !== "step_overdue")).toEqual([]);
  });

  it("is ignored by the new machine: an attested tenant waits at go-live and nothing is emitted or thrown", () => {
    const steps = makeSteps(
      Object.fromEntries(
        CANONICAL_TEMPLATES.filter((tpl) => tpl.key !== "go_live_checklist_complete").map((tpl) => [
          tpl.key,
          "done" as OnboardingTaskStatus,
        ]),
      ),
    );

    const res = advanceOnboarding(CONFIG, steps, metContext(), NOW);

    expect(res.currentStep).toBe("go_live_checklist_complete");
    expect(res.emits).toEqual([]);
  });
});
