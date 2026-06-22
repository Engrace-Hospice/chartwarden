// apps/backend/__tests__/care-plan-seam.test.ts — M7-T04 (§7.8 CarePlanReader). The reader is pure
// orchestration over an injected CarePlanReaderStore; these cover the encounter-relevance projection
// (active-problem + discipline-tagged-intervention + parent-problem-goal filter, D7 SUD redaction), the
// §2.6 overdue gate (5-day initial / 15-day review, both grace boundaries), and the boot wiring
// (registerCarePlanSeams replaces the deny-stub; validateSeams passes; the deny-stub denies loudly).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  type CarePlanClockRecord,
  type CarePlanElementsRecord,
  createCarePlanReader,
  createInMemoryCarePlanReaderStore,
  evaluateCarePlanOverdue,
  registerCarePlanSeams,
} from "../src/modules/07-care-plan/index";

const PLAN = "cp-1";
const PAT = "pat-1";

const elements: CarePlanElementsRecord = {
  planId: PLAN,
  patientId: PAT,
  sudReadAllowed: false,
  problems: [
    {
      problemId: "prob-pain",
      icd10Code: "R52",
      snomedCode: null,
      description: "Chronic pain",
      kind: "terminal",
      status: "active",
      containsSud: false,
    },
    {
      problemId: "prob-resolved",
      icd10Code: null,
      snomedCode: null,
      description: "Resolved nausea",
      kind: "related",
      status: "resolved",
      containsSud: false,
    },
    {
      problemId: "prob-sud",
      icd10Code: "F11.20",
      snomedCode: null,
      description: "Opioid use disorder",
      kind: "unrelated",
      status: "active",
      containsSud: true,
    },
  ],
  goals: [
    {
      goalId: "goal-pain",
      problemId: "prob-pain",
      text: "Pain <=3/10",
      source: "patient_stated",
      status: "in_progress",
    },
    {
      goalId: "goal-sud",
      problemId: "prob-sud",
      text: "Abstinence",
      source: "clinical",
      status: "not_started",
    },
    {
      goalId: "goal-orphan",
      problemId: "prob-resolved",
      text: "n/a",
      source: "clinical",
      status: "met",
    },
  ],
  interventions: [
    {
      interventionId: "iv-rn",
      problemId: "prob-pain",
      scopeText: "Assess pain",
      frequencyText: "3x/week",
      discipline: "rn",
      status: "active",
    },
    {
      interventionId: "iv-msw",
      problemId: "prob-pain",
      scopeText: "Counsel",
      frequencyText: "1x/week",
      discipline: "msw",
      status: "active",
    },
    {
      interventionId: "iv-rn-dc",
      problemId: "prob-pain",
      scopeText: "old",
      frequencyText: "prn",
      discipline: "rn",
      status: "discontinued",
    },
    {
      interventionId: "iv-rn-sud",
      problemId: "prob-sud",
      scopeText: "Monitor",
      frequencyText: "daily",
      discipline: "rn",
      status: "active",
    },
  ],
};

function store(
  over: Partial<CarePlanElementsRecord> = {},
  clocks: readonly CarePlanClockRecord[] = [],
) {
  return createInMemoryCarePlanReaderStore({ elements: [{ ...elements, ...over }], clocks }).store;
}

describe("CarePlanReader.relevantElementsForEncounter (§7.8)", () => {
  it("returns active interventions of the requested discipline and their parent problems' goals", async () => {
    const reader = createCarePlanReader(store({ sudReadAllowed: true }));
    const out = await reader.relevantElementsForEncounter(PAT, "rn_routine_visit", "rn");
    // rn interventions: active iv-rn + iv-rn-sud (sud allowed); the discontinued iv-rn-dc is dropped.
    expect(out?.interventions.map((i) => i.interventionId).sort()).toEqual(["iv-rn", "iv-rn-sud"]);
    // goals: only those of the parent problems of the included interventions (pain + sud), not orphan.
    expect(out?.goals.map((g) => g.goalId).sort()).toEqual(["goal-pain", "goal-sud"]);
    // problems: active only (resolved dropped); sud included because entitled.
    expect(out?.problems.map((p) => p.problemId).sort()).toEqual(["prob-pain", "prob-sud"]);
    expect(out?.redacted).toBe(false);
    // the store-side containsSud flag never leaks into the seam DTO.
    expect(out?.problems.every((p) => !("containsSud" in p))).toBe(true);
  });

  it("redacts SUD problems (and their goals/interventions) when the caller is not entitled (D7)", async () => {
    const reader = createCarePlanReader(store({ sudReadAllowed: false }));
    const out = await reader.relevantElementsForEncounter(PAT, "rn_routine_visit", "rn");
    expect(out?.problems.map((p) => p.problemId)).toEqual(["prob-pain"]);
    expect(out?.interventions.map((i) => i.interventionId)).toEqual(["iv-rn"]);
    expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-pain"]);
    expect(out?.redacted).toBe(true);
  });

  it("filters by discipline (msw sees only the msw intervention)", async () => {
    const reader = createCarePlanReader(store({ sudReadAllowed: true }));
    const out = await reader.relevantElementsForEncounter(PAT, "msw_visit", "msw");
    expect(out?.interventions.map((i) => i.interventionId)).toEqual(["iv-msw"]);
    expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-pain"]);
  });

  it("returns null when the patient has no active care plan", async () => {
    const reader = createCarePlanReader(createInMemoryCarePlanReaderStore().store);
    expect(
      await reader.relevantElementsForEncounter("nobody", "rn_routine_visit", "rn"),
    ).toBeNull();
  });
});

describe("CarePlanReader.isReviewOverdue (§2.6 / §7.8)", () => {
  const clock: CarePlanClockRecord = {
    planId: PLAN,
    patientId: PAT,
    hasSignedInitialVersion: false,
    initialDueAt: "2026-01-06T05:00:00.000Z", // day 5 end-of-day
    nextReviewDueAt: null,
  };

  it("engages the initial (5-day) gate at day 6 — one day past the deadline", async () => {
    const reader = createCarePlanReader(store({}, [clock]), () => "2026-01-07T06:00:00.000Z");
    const out = await reader.isReviewOverdue(PAT);
    expect(out?.initialOverdue).toBe(true);
    expect(out?.reviewOverdue).toBe(false);
    expect(out?.overdue).toBe(true);
  });

  it("does not engage the initial gate before the grace day passes", async () => {
    const reader = createCarePlanReader(store({}, [clock]), () => "2026-01-06T12:00:00.000Z");
    expect((await reader.isReviewOverdue(PAT))?.overdue).toBe(false);
  });

  it("engages the review (15-day) gate at day 17 once the initial version is signed", async () => {
    const signed: CarePlanClockRecord = {
      ...clock,
      hasSignedInitialVersion: true,
      nextReviewDueAt: "2026-02-01T05:00:00.000Z",
    };
    const overdue = createCarePlanReader(store({}, [signed]), () => "2026-02-03T06:00:00.000Z");
    const within = createCarePlanReader(store({}, [signed]), () => "2026-02-02T06:00:00.000Z");
    expect((await overdue.isReviewOverdue(PAT))?.reviewOverdue).toBe(true);
    // a signed plan is never blocked by the initial gate.
    expect((await overdue.isReviewOverdue(PAT))?.initialOverdue).toBe(false);
    expect((await within.isReviewOverdue(PAT))?.reviewOverdue).toBe(false);
  });

  it("returns null when the patient has no active care plan clock", async () => {
    const reader = createCarePlanReader(store({}, []));
    expect(await reader.isReviewOverdue("nobody")).toBeNull();
  });

  it("evaluateCarePlanOverdue is pure over its injected now (no signed version ⇒ review gate inert)", () => {
    const out = evaluateCarePlanOverdue(
      {
        planId: PLAN,
        patientId: PAT,
        hasSignedInitialVersion: false,
        initialDueAt: "2026-01-06T05:00:00.000Z",
        nextReviewDueAt: null,
      },
      "2026-01-04T00:00:00.000Z",
    );
    expect(out.overdue).toBe(false);
  });
});

describe("boot wiring (registerCarePlanSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers the reader so validateSeams passes and it resolves as a real impl", async () => {
    registerCarePlanSeams({ store: store({ sudReadAllowed: true }) });
    expect(() => validateSeams()).not.toThrow();
    const reader = getSeam("CarePlanReader");
    const out = await reader.relevantElementsForEncounter(PAT, "rn_routine_visit", "rn");
    expect(out?.planId).toBe(PLAN);
  });

  it("falls back to a fail-closed deny-stub when M7 does not register", () => {
    validateSeams();
    const reader = getSeam("CarePlanReader");
    // The deny-stub throws SYNCHRONOUSLY on call (denies loudly), so assert a thrown error.
    expect(() => reader.isReviewOverdue(PAT)).toThrow(/not implemented/);
  });
});
