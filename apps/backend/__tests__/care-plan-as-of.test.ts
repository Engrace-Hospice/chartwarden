// apps/backend/__tests__/care-plan-as-of.test.ts — VN-D11 (visit-note drafting, S1): the §7.8 CarePlanReader's
// `relevantElementsAsOf`. The draft describes the patient AS OF the visit time, so the care plan comes from the
// frozen `state_snapshot` of the version in effect at that instant (signed at or before it, superseded after it),
// never from today's rows. Same encounter-relevance rules as `relevantElementsForEncounter`, same per-viewer
// Part 2 redaction, and FAIL CLOSED: no version in effect or a snapshot of an unexpected shape is null.
import { describe, expect, it } from "vitest";
import {
  type CarePlanAsOfSeed,
  type CarePlanReaderStore,
  createCarePlanReader,
  createInMemoryCarePlanReaderStore,
} from "../src/modules/07-care-plan/index";

const PLAN = "cp-1";
const PAT = "pat-1";
const ADM = "adm-1";

const SIGNED_V1 = "2026-03-01T09:00:00.000Z";
const SIGNED_V2 = "2026-03-10T09:00:00.000Z";

function problem(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    icd10Code: null,
    snomedCode: null,
    description: `problem ${id}`,
    kind: "terminal",
    source: "clinical",
    sudRelated: false,
    status: "active",
    onsetAt: null,
    resolvedAt: null,
    resolutionNote: null,
    version: 1,
    ...over,
  };
}
function goal(id: string, problemId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    problemId,
    originalText: `original ${id}`,
    revisedText: null,
    source: "clinical",
    status: "in_progress",
    version: 1,
    ...over,
  };
}
function intervention(id: string, problemId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    problemId,
    scopeText: `scope ${id}`,
    frequencyText: "3x/week",
    discipline: "rn",
    status: "active",
    version: 1,
    ...over,
  };
}
function snapshot(parts: {
  problems?: readonly unknown[];
  goals?: readonly unknown[];
  interventions?: readonly unknown[];
}) {
  return {
    schemaVersion: "test",
    problems: parts.problems ?? [],
    goals: parts.goals ?? [],
    interventions: parts.interventions ?? [],
  };
}

/** v1 plan state: pain problem with an RN and an MSW intervention, plus a SUD problem with its own children. */
const SNAPSHOT_V1 = snapshot({
  problems: [
    problem("prob-pain", { description: "Chronic pain" }),
    problem("prob-resolved", { status: "resolved" }),
    problem("prob-sud", {
      description: "Opioid use disorder",
      sudRelated: true,
      kind: "unrelated",
    }),
  ],
  goals: [
    goal("goal-pain", "prob-pain", { originalText: "Pain <=3/10" }),
    goal("goal-pain-rev", "prob-pain", { originalText: "old", revisedText: "Pain <=2/10" }),
    goal("goal-resolved", "prob-resolved"),
    goal("goal-sud", "prob-sud", { originalText: "Abstinence" }),
  ],
  interventions: [
    intervention("iv-rn", "prob-pain", { scopeText: "Assess pain" }),
    intervention("iv-msw", "prob-pain", { discipline: "msw" }),
    intervention("iv-rn-discontinued", "prob-pain", { status: "discontinued" }),
    intervention("iv-rn-on-resolved", "prob-resolved"),
    intervention("iv-rn-sud", "prob-sud", { scopeText: "Monitor" }),
  ],
});

/** v2 plan state: a different problem set, so a test can tell which version it read. */
const SNAPSHOT_V2 = snapshot({
  problems: [problem("prob-dyspnea", { description: "Dyspnea" })],
  goals: [goal("goal-dyspnea", "prob-dyspnea")],
  interventions: [intervention("iv-rn-dyspnea", "prob-dyspnea")],
});

type SeededVersion = NonNullable<CarePlanAsOfSeed["versions"]>[number];

function version(over: Partial<SeededVersion> = {}): SeededVersion {
  return {
    versionId: "ver-1",
    planId: PLAN,
    patientId: PAT,
    admissionId: ADM,
    status: "superseded",
    signedAt: SIGNED_V1,
    supersededAt: SIGNED_V2,
    stateSnapshot: SNAPSHOT_V1,
    sudReadAllowed: false,
    ...over,
  };
}

const V1 = version();
const V2 = version({
  versionId: "ver-2",
  status: "signed",
  signedAt: SIGNED_V2,
  supersededAt: null,
  stateSnapshot: SNAPSHOT_V2,
});

function readerOver(versions: readonly SeededVersion[]) {
  const { store } = createInMemoryCarePlanReaderStore({ versions });
  return createCarePlanReader(store);
}

const NO_DISCLOSURE = { sudDisclosureAllowed: false } as const;
const DISCLOSURE = { sudDisclosureAllowed: true } as const;

function ask(
  reader: ReturnType<typeof createCarePlanReader>,
  asOf: string,
  over: { discipline?: "rn" | "msw"; viewer?: typeof NO_DISCLOSURE | typeof DISCLOSURE } = {},
) {
  return reader.relevantElementsAsOf(
    PAT,
    "routine_visit",
    over.discipline ?? "rn",
    ADM,
    over.viewer ?? NO_DISCLOSURE,
    asOf,
  );
}

describe("CarePlanReader.relevantElementsAsOf: which version is in effect (VN-D11)", () => {
  it("reads the superseded version while it was in effect and the newer one after", async () => {
    const reader = readerOver([V1, V2]);

    const during = await ask(reader, "2026-03-05T00:00:00.000Z");
    const after = await ask(reader, "2026-03-12T00:00:00.000Z");

    expect(during?.problems.map((p) => p.problemId)).toEqual(["prob-pain"]);
    expect(after?.problems.map((p) => p.problemId)).toEqual(["prob-dyspnea"]);
  });

  it("includes the signing instant itself (signed_at is at or before the visit time)", async () => {
    const reader = readerOver([V1, V2]);

    const out = await ask(reader, SIGNED_V1);

    expect(out?.problems.map((p) => p.problemId)).toEqual(["prob-pain"]);
  });

  it("answers null one millisecond before the first signing (no signed version yet)", async () => {
    const reader = readerOver([V1, V2]);

    expect(await ask(reader, "2026-03-01T08:59:59.999Z")).toBeNull();
  });

  it("hands over to the newer version at the instant the older one was superseded", async () => {
    const reader = readerOver([V1, V2]);

    const justBefore = await ask(reader, "2026-03-10T08:59:59.999Z");
    const atHandover = await ask(reader, SIGNED_V2);

    expect(justBefore?.problems.map((p) => p.problemId)).toEqual(["prob-pain"]);
    expect(atHandover?.problems.map((p) => p.problemId)).toEqual(["prob-dyspnea"]);
  });

  it("keeps the latest signed version in effect indefinitely (superseded_at null)", async () => {
    const reader = readerOver([V1, V2]);

    const out = await ask(reader, "2027-01-01T00:00:00.000Z");

    expect(out?.problems.map((p) => p.problemId)).toEqual(["prob-dyspnea"]);
  });

  it("reports the plan and patient of the version it read", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z");

    expect(out).toMatchObject({ planId: PLAN, patientId: PAT });
  });

  it("answers null when the patient has no signed version at all", async () => {
    expect(await ask(readerOver([]), "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it("ignores a draft or in-review version, which is not in effect at any instant", async () => {
    const reader = readerOver([
      version({ versionId: "ver-draft", status: "draft", signedAt: null, supersededAt: null }),
      version({ versionId: "ver-review", status: "in_review", signedAt: null, supersededAt: null }),
    ]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it("fails closed on a superseded version with no superseded_at (cannot be placed in time)", async () => {
    const reader = readerOver([version({ supersededAt: null })]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it("ignores versions of another admission or another patient", async () => {
    const reader = readerOver([
      version({ admissionId: "adm-other" }),
      version({ versionId: "ver-x", patientId: "pat-other" }),
    ]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it("reads the frozen version, not the plan's current state", async () => {
    const live = {
      planId: PLAN,
      patientId: PAT,
      sudReadAllowed: true,
      problems: [],
      goals: [],
      interventions: [],
    };
    const { store } = createInMemoryCarePlanReaderStore({ elements: [live], versions: [V1, V2] });
    const reader = createCarePlanReader(store);

    const asOf = await ask(reader, "2026-03-05T00:00:00.000Z");
    const now = await reader.relevantElementsForEncounter(
      PAT,
      "routine_visit",
      "rn",
      ADM,
      DISCLOSURE,
    );

    expect(asOf?.problems.map((p) => p.problemId)).toEqual(["prob-pain"]);
    expect(now?.problems).toEqual([]);
  });

  it("rejects an asOf that is not an instant rather than guessing", async () => {
    await expect(ask(readerOver([V1, V2]), "not-a-date")).rejects.toThrow(/asOf/);
  });
});

describe("CarePlanReader.relevantElementsAsOf: the same encounter-relevance rules", () => {
  it("returns active problems, the discipline's active interventions and their parent problems' goals", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z", {
      viewer: DISCLOSURE,
    });

    expect(out?.problems.map((p) => p.problemId)).toEqual(["prob-pain", "prob-sud"]);
    expect(out?.interventions.map((i) => i.interventionId)).toEqual(["iv-rn", "iv-rn-sud"]);
    expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-pain", "goal-pain-rev", "goal-sud"]);
  });

  it("filters by discipline: an MSW draft gets the MSW intervention only", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z", { discipline: "msw" });

    expect(out?.interventions.map((i) => i.interventionId)).toEqual(["iv-msw"]);
    expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-pain", "goal-pain-rev"]);
  });

  it("answers an empty set (not null) when the discipline has no active intervention", async () => {
    const out = await ask(readerOver([V2]), "2026-03-12T00:00:00.000Z", { discipline: "msw" });

    expect(out).toMatchObject({ interventions: [], goals: [], redacted: false });
    expect(out?.problems.map((p) => p.problemId)).toEqual(["prob-dyspnea"]);
  });

  it("drops resolved problems, discontinued interventions and interventions on resolved problems", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z");

    expect(out?.problems.map((p) => p.problemId)).not.toContain("prob-resolved");
    expect(out?.interventions.map((i) => i.interventionId)).not.toContain("iv-rn-discontinued");
    expect(out?.interventions.map((i) => i.interventionId)).not.toContain("iv-rn-on-resolved");
  });

  it("shows a revised goal's revised text, else the original", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z");

    expect(out?.goals.map((g) => g.text)).toEqual(["Pain <=3/10", "Pain <=2/10"]);
  });

  it("projects the picker fields the live reader projects", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z");

    expect(out?.problems[0]).toEqual({
      problemId: "prob-pain",
      icd10Code: null,
      snomedCode: null,
      description: "Chronic pain",
      kind: "terminal",
      status: "active",
      sudRelated: false,
    });
    expect(out?.interventions[0]).toEqual({
      interventionId: "iv-rn",
      problemId: "prob-pain",
      scopeText: "Assess pain",
      frequencyText: "3x/week",
      discipline: "rn",
      status: "active",
    });
  });
});

describe("CarePlanReader.relevantElementsAsOf: 42 CFR Part 2 (per-viewer, fail closed)", () => {
  it("withholds the SUD problem and everything anchored to it from a viewer without disclosure", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z");
    const text = JSON.stringify(out);

    expect(out?.redacted).toBe(true);
    expect(out?.problems.map((p) => p.problemId)).toEqual(["prob-pain"]);
    expect(out?.interventions.map((i) => i.interventionId)).toEqual(["iv-rn"]);
    expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-pain", "goal-pain-rev"]);
    expect(text).not.toContain("Opioid");
    expect(text).not.toContain("Abstinence");
    expect(text).not.toContain("prob-sud");
  });

  it("shows the SUD content, flagged, to a viewer with disclosure", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z", { viewer: DISCLOSURE });

    expect(out?.redacted).toBe(false);
    expect(out?.problems.find((p) => p.problemId === "prob-sud")).toMatchObject({
      sudRelated: true,
    });
  });

  it("returns different results for two viewers of the same version (no shared unredacted result)", async () => {
    const reader = readerOver([V1, V2]);

    const withDisclosure = await ask(reader, "2026-03-05T00:00:00.000Z", { viewer: DISCLOSURE });
    const without = await ask(reader, "2026-03-05T00:00:00.000Z", { viewer: NO_DISCLOSURE });

    expect(without?.problems).toHaveLength(1);
    expect(withDisclosure?.problems).toHaveLength(2);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["the string 'false'", "false"],
    ["0", 0],
  ])("treats a problem whose sudRelated is %s as Part 2", async (_label, flag) => {
    const { sudRelated: _drop, ...rest } = problem("prob-flagless");
    const mangled = flag === undefined ? rest : { ...rest, sudRelated: flag };
    const reader = readerOver([
      version({
        stateSnapshot: snapshot({
          problems: [mangled],
          goals: [goal("goal-flagless", "prob-flagless")],
          interventions: [intervention("iv-flagless", "prob-flagless")],
        }),
      }),
    ]);

    const hidden = await ask(reader, "2026-03-05T00:00:00.000Z");
    const shown = await ask(reader, "2026-03-05T00:00:00.000Z", { viewer: DISCLOSURE });

    expect(hidden).toMatchObject({ problems: [], goals: [], interventions: [], redacted: true });
    expect(shown?.problems).toEqual([expect.objectContaining({ sudRelated: true })]);
  });

  it("resolves the verdict through the store for a session-identity audience (seeded deny stays deny)", async () => {
    const reader = readerOver([V1, V2]);

    const actor = await reader.relevantElementsAsOf(
      PAT,
      "routine_visit",
      "rn",
      ADM,
      { actor: { roles: ["rn"], membershipId: "mem-1" } },
      "2026-03-05T00:00:00.000Z",
    );
    const patientLevel = await reader.relevantElementsAsOf(
      PAT,
      "routine_visit",
      "rn",
      ADM,
      "patient_level",
      "2026-03-05T00:00:00.000Z",
    );

    expect(actor?.redacted).toBe(true);
    expect(patientLevel?.redacted).toBe(true);
    expect(JSON.stringify([actor, patientLevel])).not.toContain("prob-sud");
  });

  it("never returns the SUD problem when the store itself says the viewer is not entitled", async () => {
    const baseStore = createInMemoryCarePlanReaderStore({ versions: [V1] }).store;
    const store: CarePlanReaderStore = {
      ...baseStore,
      // a store that returns the raw snapshot with the verdict false: the reader must still redact
      carePlanVersionAsOf: async (...args) => {
        const found = await baseStore.carePlanVersionAsOf(...args);
        return found && { ...found, sudReadAllowed: false };
      },
    };
    const out = await ask(createCarePlanReader(store), "2026-03-05T00:00:00.000Z", {
      viewer: DISCLOSURE,
    });

    expect(JSON.stringify(out)).not.toContain("prob-sud");
    expect(out?.redacted).toBe(true);
  });
});

describe("CarePlanReader.relevantElementsAsOf: unexpected snapshot shapes answer null", () => {
  const shapes: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["a string", "not-a-snapshot"],
    ["an array", []],
    ["an empty object", {}],
    ["problems not an array", { problems: {}, goals: [], interventions: [] }],
    ["goals missing", { problems: [], interventions: [] }],
    ["interventions not an array", { problems: [], goals: [], interventions: "x" }],
    ["a problem without an id", snapshot({ problems: [{ ...problem("p"), id: undefined }] })],
    ["a problem that is not an object", snapshot({ problems: ["prob-pain"] })],
    [
      "a goal without a problem id",
      snapshot({ problems: [problem("p")], goals: [{ ...goal("g", "p"), problemId: undefined }] }),
    ],
    [
      "an intervention without a discipline",
      snapshot({
        problems: [problem("p")],
        interventions: [{ ...intervention("i", "p"), discipline: undefined }],
      }),
    ],
  ];

  it.each(shapes)("for a viewer without disclosure: %s", async (_label, stateSnapshot) => {
    const reader = readerOver([version({ stateSnapshot })]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it.each(shapes)("for a viewer with disclosure: %s", async (_label, stateSnapshot) => {
    const reader = readerOver([version({ stateSnapshot })]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z", { viewer: DISCLOSURE })).toBeNull();
  });
});
