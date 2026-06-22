// apps/backend/__tests__/care-plan-authoring.test.ts — M7-T06 authoring acceptance (§7.3–7.6).
//
// Covers the four authoring workflows the task delivers:
//   §7.3 patient-stated goal preservation — verbatim `original_text`, dual-text revision view.
//   §7.4 discipline contribution + cross-discipline view — `discipline_scope` guard + grouping/counts.
//   §7.5 DPOA-attributed decisions — agent-stated goal gated on active consent + revoked-note view.
//   §7.6 SUD problem confidentiality — per-caller redaction (read) vs full set (sign), + ABAC predicate.
//
// Pure helpers and the §6 predicate factory are exercised directly; the discipline/SUD enforcement is
// also proved through the in-memory CarePlanRouteService (the slice the routes compose over).
import type { AbacContext, AbacTarget } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import {
  type CarePlanAbacDeps,
  assertDisciplineScope,
  buildCarePlanAbacPredicates,
  canAuthorInterventionDiscipline,
  createInMemoryCarePlanBackend,
  disciplineCounts,
  filterVisibleProblems,
  groupInterventionsByDiscipline,
  projectGoalAttribution,
  redactCarePlanForCaller,
  redactedSudProblemIds,
} from "../src/modules/07-care-plan/index";
import { CarePlanStateError } from "../src/modules/07-care-plan/lifecycle/errors";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const PLAN = "cp_seed";
const PROBLEM_ID = "22222222-2222-4222-8222-222222222222";

function makeContext(over: Partial<AbacContext> = {}): AbacContext {
  return {
    organizationId: ORG,
    userId: "u_1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {},
    ...over,
  };
}

function makePredicates(over: Partial<CarePlanAbacDeps> = {}) {
  const { service, resolver } = createInMemoryCarePlanBackend({
    plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT, status: "draft" }],
  });
  const deps: CarePlanAbacDeps = {
    resolver,
    isInCaseload: async () => false,
    isConsentActive: async () => false,
    ...over,
  };
  return { service, resolver, predicates: buildCarePlanAbacPredicates(deps) };
}

// ── §7.3 Patient-stated goal preservation ───────────────────────────────────────────────────────
describe("M7-T06 §7.3 — patient-stated goal preservation", () => {
  it("stores original_text verbatim and a revision lands in revised_text (original unchanged)", async () => {
    const { service } = createInMemoryCarePlanBackend({
      plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT }],
    });
    const goal = await service.addGoal(
      ORG,
      PLAN,
      {
        problemId: PROBLEM_ID,
        originalText: "Want to walk to mailbox without help",
        source: "patient_stated",
      },
      false,
    );
    const revised = await service.patchGoal(ORG, PLAN, goal.id, goal.version, {
      revisedText: "Will walk 20ft assisted in 4 weeks",
      status: "revised",
    });
    expect(revised.status).toBe("revised");

    const plan = (await service.getCarePlanForPatient(ORG, PATIENT)) as {
      goals: { id: string; originalText: string; revisedText: string | null }[];
    };
    const stored = plan.goals.find((g) => g.id === goal.id)!;
    expect(stored.originalText).toBe("Want to walk to mailbox without help"); // verbatim, untouched
    expect(stored.revisedText).toBe("Will walk 20ft assisted in 4 weeks");
  });

  it("projects the dual-text attribution view (original + revised, attributed to patient)", () => {
    const view = projectGoalAttribution({
      id: "g1",
      source: "patient_stated",
      originalText: "Want to walk to mailbox without help",
      revisedText: "Will walk 20ft assisted in 4 weeks",
      actingConsentId: null,
    });
    expect(view.attributedTo).toBe("patient");
    expect(view.revised).toBe(true);
    expect(view.originalText).toMatch(/mailbox/);
    expect(view.revisedText).toMatch(/20ft/);
  });

  it("refuses to mutate original_text on a verbatim-source goal (§7.3 / §2.3)", async () => {
    const { service } = createInMemoryCarePlanBackend({
      plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT }],
    });
    // A blank verbatim original is itself rejected (the write guard requires non-empty verbatim text).
    await expect(
      service.addGoal(
        ORG,
        PLAN,
        { problemId: PROBLEM_ID, originalText: "", source: "patient_stated" },
        false,
      ),
    ).rejects.toBeInstanceOf(CarePlanStateError);
  });
});

// ── §7.4 Discipline contribution & cross-discipline view ─────────────────────────────────────────
describe("M7-T06 §7.4 — discipline contribution & cross-discipline view", () => {
  it("an aide may not author an rn intervention; an RN may; the IDG Coordinator may author any", () => {
    expect(
      canAuthorInterventionDiscipline({ disciplines: ["chha"], isIdgCoordinator: false }, "rn"),
    ).toBe(false);
    expect(
      canAuthorInterventionDiscipline({ disciplines: ["rn"], isIdgCoordinator: false }, "rn"),
    ).toBe(true);
    expect(canAuthorInterventionDiscipline({ disciplines: [], isIdgCoordinator: true }, "rn")).toBe(
      true,
    );
  });

  it("the service write path raises DISCIPLINE_SCOPE_VIOLATION (403) for an out-of-discipline author", async () => {
    const { service } = createInMemoryCarePlanBackend({
      plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT }],
    });
    const body = {
      problemId: PROBLEM_ID,
      scopeText: "Wound care",
      frequencyText: "daily",
      frequencyValue: "1/day",
      discipline: "rn" as const,
    };
    await expect(
      service.addIntervention(ORG, PLAN, body, { disciplines: ["chha"], isIdgCoordinator: false }),
    ).rejects.toMatchObject({ code: "DISCIPLINE_SCOPE_VIOLATION", statusCode: 403 });
    // The MSW authoring an msw intervention succeeds; the IDG coordinator is the cross-discipline exception.
    const ok = await service.addIntervention(
      ORG,
      PLAN,
      { ...body, discipline: "msw", scopeText: "Weekly psychosocial support" },
      { disciplines: ["msw"], isIdgCoordinator: false },
    );
    expect(ok.status).toBe("active");
  });

  it("groups entries by discipline and counts active interventions per discipline (§7.4 survey rollup)", () => {
    const entries = [
      { id: "i1", discipline: "rn" as const, status: "active" },
      { id: "i2", discipline: "msw" as const, status: "active" },
      { id: "i3", discipline: "rn" as const, status: "discontinued" },
    ];
    const groups = groupInterventionsByDiscipline(entries);
    expect(groups.map((g) => g.discipline)).toEqual(["rn", "msw"]);
    expect(disciplineCounts(entries)).toEqual({ rn: 1, msw: 1 }); // discontinued rn excluded
  });

  it("assertDisciplineScope throws for a mismatch and is silent for the IDG Coordinator", () => {
    expect(() =>
      assertDisciplineScope({ disciplines: ["chaplain"], isIdgCoordinator: false }, "rn"),
    ).toThrow(CarePlanStateError);
    expect(() =>
      assertDisciplineScope({ disciplines: [], isIdgCoordinator: true }, "rn"),
    ).not.toThrow();
  });

  it("the discipline_scope predicate reads the body's discipline against the actor's session scope", async () => {
    const { predicates } = makePredicates();
    const target: AbacTarget = { discipline: "rn" };
    expect(await predicates.discipline_scope(makeContext({ roles: ["chha"] }), target)).toBe(false);
    expect(await predicates.discipline_scope(makeContext({ roles: ["rn"] }), target)).toBe(true);
    expect(
      await predicates.discipline_scope(makeContext({ roles: ["idg_coordinator"] }), target),
    ).toBe(true);
  });
});

// ── §7.5 DPOA-attributed decisions ───────────────────────────────────────────────────────────────
describe("M7-T06 §7.5 — DPOA-attributed decisions", () => {
  it("an agent-stated goal requires an active dpoa_healthcare consent at write time", async () => {
    const { service } = createInMemoryCarePlanBackend({
      plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT }],
    });
    await expect(
      service.addGoal(
        ORG,
        PLAN,
        {
          problemId: PROBLEM_ID,
          originalText: "Honor the agent's stated wishes",
          source: "agent_stated",
        },
        false, // no active DPOA
      ),
    ).rejects.toMatchObject({ code: "DPOA_CONSENT_REQUIRED" });

    const ok = await service.addGoal(
      ORG,
      PLAN,
      {
        problemId: PROBLEM_ID,
        originalText: "Honor the agent's stated wishes",
        source: "agent_stated",
        actingConsentId: "consent_1",
      },
      true, // active DPOA
    );
    expect(ok.status).toBe("not_started");
  });

  it("a later DPOA revocation preserves the entry and annotates 'consent revoked on <date>'", () => {
    const view = projectGoalAttribution(
      {
        id: "g2",
        source: "agent_stated",
        originalText: "Agent wishes",
        revisedText: null,
        actingConsentId: "consent_1",
      },
      { consentRevokedAt: "2026-07-01" },
    );
    expect(view.attributedTo).toBe("agent");
    expect(view.actingConsentId).toBe("consent_1");
    expect(view.consentRevokedNote).toBe("consent revoked on 2026-07-01");
  });

  it("the dpoa_active predicate resolves through the consent seam for the plan's patient", async () => {
    const withConsent = makePredicates({
      isConsentActive: async (q) => q.consentType === "dpoa_healthcare",
    });
    const noConsent = makePredicates({ isConsentActive: async () => false });
    const target: AbacTarget = { planId: PLAN };
    expect(await withConsent.predicates.dpoa_active(makeContext(), target)).toBe(true);
    expect(await noConsent.predicates.dpoa_active(makeContext(), target)).toBe(false);
    expect(await withConsent.predicates.dpoa_active(makeContext(), { planId: "cp_absent" })).toBe(
      false,
    ); // fail-closed
  });
});

// ── §7.6 SUD problem confidentiality ─────────────────────────────────────────────────────────────
describe("M7-T06 §7.6 — SUD problem confidentiality", () => {
  it("filters SUD-flagged problems for a caller without disclosure; keeps them with disclosure", () => {
    const problems = [
      { id: "p1", sudRelated: false },
      { id: "p2", sudRelated: true },
    ];
    expect(filterVisibleProblems(problems, false).map((p) => p.id)).toEqual(["p1"]);
    expect(filterVisibleProblems(problems, true).map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(redactedSudProblemIds(problems, false)).toEqual(["p2"]);
  });

  it("redacts a SUD problem AND its dependent goals/interventions from a per-caller read", () => {
    const view = redactCarePlanForCaller(
      {
        problems: [
          { id: "p1", sudRelated: false },
          { id: "p_sud", sudRelated: true },
        ],
        goals: [{ problemId: "p1" }, { problemId: "p_sud" }],
        interventions: [{ problemId: "p_sud" }],
      },
      false,
    );
    expect(view.redacted).toBe(true);
    expect(view.problems.map((p) => p.id)).toEqual(["p1"]);
    expect(view.goals).toHaveLength(1); // the p_sud-anchored goal dropped with its problem
    expect(view.interventions).toHaveLength(0);
  });

  it("the read service omits SUD problems for a non-disclosed viewer; the full set is intact without a viewer", async () => {
    const { service } = createInMemoryCarePlanBackend({
      plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT }],
    });
    await service.addProblem(ORG, PLAN, {
      description: "Terminal CA",
      kind: "terminal",
      source: "clinical",
    });
    await service.addProblem(ORG, PLAN, {
      description: "Opioid use disorder",
      kind: "related",
      source: "clinical",
      sudRelated: true,
    });

    const redacted = (await service.getCarePlanForPatient(ORG, PATIENT, {
      sudDisclosureAllowed: false,
    })) as {
      problems: unknown[];
      redacted: boolean;
    };
    expect(redacted.problems).toHaveLength(1);
    expect(redacted.redacted).toBe(true);

    // The SIGNING path uses the FULL problem set (system actor, no viewer) — redaction must not hide it.
    const full = (await service.getCarePlanForPatient(ORG, PATIENT)) as {
      problems: unknown[];
      redacted: boolean;
    };
    expect(full.problems).toHaveLength(2);
    expect(full.redacted).toBe(false);
  });

  it("the sud_disclosure_allowed predicate: non-SUD allowed; SUD needs Part-2 consent or the RN Case Manager", async () => {
    const { service, predicates } = makePredicates({
      isConsentActive: async (q) => q.consentType === "42_cfr_part_2_release",
    });
    const nonSud = await service.addProblem(ORG, PLAN, {
      description: "Pain",
      kind: "terminal",
      source: "clinical",
    });
    const sud = await service.addProblem(ORG, PLAN, {
      description: "SUD",
      kind: "related",
      source: "clinical",
      sudRelated: true,
    });

    // A non-SUD problem is always disclosable, even with no consent.
    const denyConsent = makePredicates({ isConsentActive: async () => false });
    const nonSud2 = await denyConsent.service.addProblem(ORG, PLAN, {
      description: "Pain",
      kind: "terminal",
      source: "clinical",
    });
    expect(
      await denyConsent.predicates.sud_disclosure_allowed(makeContext(), { elementId: nonSud2.id }),
    ).toBe(true);

    // A SUD problem: allowed with an active Part-2 release consent context...
    expect(await predicates.sud_disclosure_allowed(makeContext(), { elementId: sud.id })).toBe(
      true,
    );
    expect(await predicates.sud_disclosure_allowed(makeContext(), { elementId: nonSud.id })).toBe(
      true,
    );
    // ...or for the assigned RN Case Manager...
    expect(
      await denyConsent.predicates.sud_disclosure_allowed(
        makeContext({ roles: ["rn_case_manager"] }),
        {
          elementId: (
            await denyConsent.service.addProblem(ORG, PLAN, {
              description: "SUD",
              kind: "related",
              source: "clinical",
              sudRelated: true,
            })
          ).id,
        },
      ),
    ).toBe(true);
    // ...and denied to a consulting clinician with neither.
    const sudDeny = await denyConsent.service.addProblem(ORG, PLAN, {
      description: "SUD",
      kind: "related",
      source: "clinical",
      sudRelated: true,
    });
    expect(
      await denyConsent.predicates.sud_disclosure_allowed(makeContext(), { elementId: sudDeny.id }),
    ).toBe(false);
  });
});

// ── §6 caseload_or_scope + signer_role_match predicate coverage ──────────────────────────────────
describe("M7-T06 §6 — caseload_or_scope & signer_role_match predicates", () => {
  it("caseload_or_scope allows an org-wide scope role, a session-scoped patient, or caseload membership", async () => {
    const target: AbacTarget = { planId: PLAN };
    const orgWide = makePredicates();
    expect(
      await orgWide.predicates.caseload_or_scope(
        makeContext({ roles: ["medical_director"] }),
        target,
      ),
    ).toBe(true);

    const scoped = makePredicates();
    expect(
      await scoped.predicates.caseload_or_scope(
        makeContext({ attributes: { scopePatientIds: [PATIENT] } }),
        target,
      ),
    ).toBe(true);

    const caseload = makePredicates({ isInCaseload: async () => true });
    expect(await caseload.predicates.caseload_or_scope(makeContext(), target)).toBe(true);

    const denied = makePredicates({ isInCaseload: async () => false });
    expect(await denied.predicates.caseload_or_scope(makeContext(), target)).toBe(false);
  });

  it("signer_role_match is true iff the caller's signer roles satisfy a slot of the version's RequiredSignerSet", async () => {
    const { service, resolver } = createInMemoryCarePlanBackend({
      plans: [{ id: PLAN, organizationId: ORG, patientId: PATIENT }],
    });
    const version = (await service.createVersion(ORG, PLAN, "initial", null)) as { id: string };
    const predicates = buildCarePlanAbacPredicates({
      resolver,
      isInCaseload: async () => false,
      isConsentActive: async () => false,
    });
    const target: AbacTarget = { versionId: version.id };
    // INITIAL set = (hospice_physician|nurse_practitioner) + rn_case_manager.
    expect(
      await predicates.signer_role_match(makeContext({ roles: ["rn_case_manager"] }), target),
    ).toBe(true);
    expect(
      await predicates.signer_role_match(makeContext({ roles: ["nurse_practitioner"] }), target),
    ).toBe(true);
    expect(await predicates.signer_role_match(makeContext({ roles: ["chaplain"] }), target)).toBe(
      false,
    ); // not in INITIAL set
    expect(await predicates.signer_role_match(makeContext({ roles: [] }), target)).toBe(false);
  });
});
