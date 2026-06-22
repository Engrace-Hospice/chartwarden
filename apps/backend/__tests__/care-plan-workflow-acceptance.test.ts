// apps/backend/__tests__/care-plan-workflow-acceptance.test.ts — M7-T09 the §7 workflow-acceptance
// suite. One scenario per §7 user story, exercised end-to-end over the in-memory CarePlanRouteService
// (the same backend the routes compose over) plus the pure §7.3–7.6 authoring helpers. Deterministic:
// no infra, injected clock. The route-auth handshake (§4.5/§4.6) + the §7.7 412 wire behaviour are
// proven in care-plan-routes.test.ts; this suite asserts the WORKFLOW outcomes (state transitions,
// quorum, discipline scope, SUD redaction, DPOA gating, verbatim preservation, IDG application).
import { describe, expect, it } from "vitest";
import {
  type AuthoringDisciplineScope,
  CarePlanStateError,
  assertDisciplineScope,
  createInMemoryCarePlanBackend,
  decideIdgDecision,
  redactedSudProblemIds,
  resolveRequiredSignerSet,
} from "../src/modules/07-care-plan/index";

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";

/** Bootstrap a plan and add one terminal problem; return the backend + the plan/version/problem ids. */
async function planWithProblem() {
  const backend = createInMemoryCarePlanBackend();
  const boot = (await backend.service.bootstrapCarePlan(ORG, PATIENT, ADMISSION)) as {
    id: string;
    initialVersionId: string;
  };
  const problem = await backend.service.addProblem(ORG, boot.id, {
    description: "Terminal CA",
    kind: "terminal",
    source: "clinical",
  });
  return { backend, planId: boot.id, versionId: boot.initialVersionId, problemId: problem.id };
}

describe("M7-T09 §7 workflow acceptance", () => {
  it("§7.1 — initial care plan: finalize + RN/physician quorum activates the plan", async () => {
    const { backend, planId, versionId } = await planWithProblem();
    const svc = backend.service;

    await svc.finalizeVersion(ORG, planId, versionId, 1, null);
    const sig1 = (await svc.signVersion(ORG, planId, versionId, 2, "hospice_physician", "2026-06-21T12:00:00Z")) as {
      status: string;
    };
    expect(sig1.status).toBe("in_review"); // quorum not yet met
    const sig2 = (await svc.signVersion(ORG, planId, versionId, 3, "rn_case_manager", "2026-06-21T12:00:00Z")) as {
      status: string;
    };
    expect(sig2.status).toBe("signed");

    const plan = (await svc.getCarePlanForPatient(ORG, PATIENT)) as { status: string; activeVersionId: string };
    expect(plan.status).toBe("active");
    expect(plan.activeVersionId).toBe(versionId);
  });

  it("§7.2 — 15-day IDG review: an idg_review version needs the full RN+MSW+chaplain+MD quorum", async () => {
    const { backend, planId } = await planWithProblem();
    const svc = backend.service;
    const v2 = (await svc.createVersion(ORG, planId, "idg_review", "idg_meeting_1")) as { id: string; version: number };
    await svc.finalizeVersion(ORG, planId, v2.id, 1, null);

    // The idg_review floor: four distinct slots. Only the last signature completes the quorum.
    const roles = ["rn_case_manager", "msw", "chaplain", "hospice_physician"] as const;
    let ifVersion = 2;
    let last: { status: string } = { status: "in_review" };
    for (const role of roles) {
      last = (await svc.signVersion(ORG, planId, v2.id, ifVersion, role, "2026-07-06T12:00:00Z")) as { status: string };
      ifVersion += 1;
    }
    expect(resolveRequiredSignerSet("idg_review")).toHaveLength(4);
    expect(last.status).toBe("signed");
  });

  it("§7.3 — patient-stated goal: original_text is verbatim and immutable; only revised_text changes", async () => {
    const { backend, planId, problemId } = await planWithProblem();
    const svc = backend.service;
    const goal = await svc.addGoal(
      ORG,
      planId,
      { problemId, originalText: "Want to walk to mailbox without help", source: "patient_stated" },
      false,
    );
    // PATCH sets revised_text; the schema never carries original_text, so it stays verbatim.
    const patched = await svc.patchGoal(ORG, planId, goal.id, 1, { revisedText: "Will walk 20ft assisted in 4 weeks" });
    expect(patched.version).toBe(2);

    const plan = (await svc.getCarePlanForPatient(ORG, PATIENT)) as {
      goals: { id: string; originalText: string; revisedText: string | null }[];
    };
    const stored = plan.goals.find((g) => g.id === goal.id);
    expect(stored?.originalText).toBe("Want to walk to mailbox without help");
    expect(stored?.revisedText).toBe("Will walk 20ft assisted in 4 weeks");
  });

  it("§7.4 — discipline scope: an aide cannot author an rn intervention; the IDG coordinator can", async () => {
    const { backend, planId, problemId } = await planWithProblem();
    const svc = backend.service;
    const aide: AuthoringDisciplineScope = { disciplines: ["chha"], isIdgCoordinator: false };
    const idgCoord: AuthoringDisciplineScope = { disciplines: [], isIdgCoordinator: true };

    await expect(
      svc.addIntervention(
        ORG,
        planId,
        { problemId, scopeText: "x", frequencyText: "daily", frequencyValue: "1/day", discipline: "rn" },
        aide,
      ),
    ).rejects.toMatchObject({ code: "DISCIPLINE_SCOPE_VIOLATION" });
    // The pure guard agrees (single home for the rule).
    expect(() => assertDisciplineScope(aide, "rn")).toThrow(CarePlanStateError);

    // The IDG Coordinator is the cross-discipline exception.
    const ok = await svc.addIntervention(
      ORG,
      planId,
      { problemId, scopeText: "RN pain reassessment", frequencyText: "3x/week", frequencyValue: "3/week", discipline: "rn" },
      idgCoord,
    );
    expect(ok.status).toBe("active");
  });

  it("§7.5 — DPOA: an agent_stated goal is refused without an active dpoa_healthcare consent; accepted with one", async () => {
    const { backend, planId, problemId } = await planWithProblem();
    const svc = backend.service;
    await expect(
      svc.addGoal(ORG, planId, { problemId, originalText: "Agent wishes comfort care", source: "agent_stated" }, false),
    ).rejects.toMatchObject({ code: "DPOA_CONSENT_REQUIRED" });

    const ok = await svc.addGoal(
      ORG,
      planId,
      { problemId, originalText: "Agent wishes comfort care", source: "agent_stated", actingConsentId: "consent_1" },
      true,
    );
    expect(ok.status).toBe("not_started");
  });

  it("§7.6 — SUD confidentiality: a caller without consent gets the SUD problem omitted (redacted:true)", async () => {
    const backend = createInMemoryCarePlanBackend();
    const svc = backend.service;
    const boot = (await svc.bootstrapCarePlan(ORG, PATIENT, ADMISSION)) as { id: string };
    await svc.addProblem(ORG, boot.id, { description: "Terminal CA", kind: "terminal", source: "clinical" });
    const sud = await svc.addProblem(ORG, boot.id, {
      description: "Opioid use disorder",
      kind: "related",
      source: "clinical",
      sudRelated: true,
    });

    const denied = (await svc.getCarePlanForPatient(ORG, PATIENT, { sudDisclosureAllowed: false })) as {
      problems: { id: string }[];
      redacted: boolean;
    };
    expect(denied.problems.some((p) => p.id === sud.id)).toBe(false);
    expect(denied.redacted).toBe(true);

    const allowed = (await svc.getCarePlanForPatient(ORG, PATIENT, { sudDisclosureAllowed: true })) as {
      problems: { id: string }[];
      redacted: boolean;
    };
    expect(allowed.problems.some((p) => p.id === sud.id)).toBe(true);
    expect(allowed.redacted).toBe(false);

    // The pure helper backing the route agrees on what gets dropped.
    expect(redactedSudProblemIds([{ id: sud.id, sudRelated: true }], false)).toEqual([sud.id]);
  });

  it("§7.7 — optimistic concurrency: a stale If-Match version is refused with STALE_VERSION", async () => {
    const { backend, planId, problemId } = await planWithProblem();
    const svc = backend.service;
    const first = await svc.patchProblem(ORG, planId, problemId, 1, { description: "Terminal CA (staged)" });
    expect(first.version).toBe(2);
    await expect(
      svc.patchProblem(ORG, planId, problemId, 1, { description: "stale write" }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
  });

  it("§7.9 — IDG decision: the pure decision core applies a meeting decision and is idempotent on idgDecisionId", () => {
    const decision = {
      idgDecisionId: "dec-1",
      idgMeetingId: "idg_meeting_1",
      planId: "cp-1",
      patientId: PATIENT,
      changes: [{ target: "intervention" as const, op: "add" as const, discipline: "rn" as const }],
    };
    const baseFacts = { alreadyApplied: false, planActive: true, openDraftVersionId: null, terminalProblemIds: [] as string[] };

    const applied = decideIdgDecision(decision, baseFacts);
    expect(applied.kind).toBe("apply");

    // Replay: the same decision id (alreadyApplied) is a no-op.
    const replay = decideIdgDecision(decision, { ...baseFacts, alreadyApplied: true });
    expect(replay.kind).toBe("idempotent_skip");
  });

  it("§6.6 — cross-tenant: Org B cannot read Org A's plan (non-leaking 404)", async () => {
    const { backend, planId } = await planWithProblem();
    await expect(backend.service.listVersions(ORG_B, planId)).rejects.toMatchObject({ name: "NotFoundError" });
  });
});
