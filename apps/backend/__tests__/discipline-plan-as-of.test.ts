// apps/backend/__tests__/discipline-plan-as-of.test.ts — ADR-0114 S4 (VN-D11, VN-D46, VN-D49): the M15 DisciplinePlanReader's
// `planElementsAsOf`. A social-work or chaplain visit note describes the patient AS OF the visit time, so the goals and interventions come
// from the SEALED `state_snapshot` of the signed plan version in effect then, never from today's rows. The per-viewer Part 2 verdict is
// M15's own (`resolveDisclosure`'s rule), and the read FAILS CLOSED: no version in effect, a declination, or a snapshot of an
// unexpected shape is null; a goal whose `sudRelated` is not the literal `false` is Part 2.
import type { DisciplinePlanKind } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  type DisciplinePlanSeamSeed,
  createDisciplinePlanReader,
  createInMemoryDisciplinePlanSeamStore,
} from "../src/modules/15-discipline-care-plans/index";
import type { DisclosurePort } from "../src/modules/15-discipline-care-plans/routes/disclosure";

const ORG = "11111111-1111-1111-1111-111111111111";
const PLAN = "33333333-3333-3333-3333-333333333333";
const PAT = "22222222-2222-2222-2222-222222222222";
const ADM = "44444444-4444-4444-4444-444444444444";

const SIGNED_V1 = "2026-03-01T09:00:00.000Z";
const SIGNED_V2 = "2026-03-10T09:00:00.000Z";
const DISCHARGED = "2026-04-01T09:00:00.000Z";

function goal(id: string, over: Record<string, unknown> = {}) {
  return {
    goalId: id,
    parentProblemId: null,
    parentGoalId: null,
    source: "clinical",
    status: "in_progress",
    originalText: `original ${id}`,
    revisedText: null,
    measurableOutcome: "a measurable outcome nobody may state",
    targetAt: null,
    frequencyText: null,
    frequencyValue: null,
    modalityText: null,
    sudRelated: false,
    addedByDiscipline: "msw",
    addedAt: SIGNED_V1,
    version: 1,
    ...over,
  };
}
function intervention(id: string, over: Record<string, unknown> = {}) {
  return {
    interventionId: id,
    parentInterventionId: null,
    goalRefs: [],
    scopeText: `scope ${id}`,
    frequencyText: "weekly",
    frequencyValue: 1,
    discipline: "msw",
    responsibleRoles: ["msw"],
    status: "active",
    discontinuationReason: null,
    addedByDiscipline: "msw",
    addedAt: SIGNED_V1,
    version: 1,
    ...over,
  };
}
function snapshot(parts: { goals?: readonly unknown[]; interventions?: readonly unknown[] }) {
  return {
    sealedAt: SIGNED_V1,
    planKind: "msw_plan",
    versionKind: "initial",
    volunteerOutOfScopeAcknowledged: false,
    goals: parts.goals ?? [],
    interventions: parts.interventions ?? [],
  };
}

/** v1: one open goal and its intervention, a SUD goal with an intervention anchored to it, and closed work that must not draft. */
const SNAPSHOT_V1 = snapshot({
  goals: [
    goal("goal-coping", { originalText: "Name two ways to cope with the diagnosis" }),
    goal("goal-revised", {
      source: "patient_stated",
      originalText: "I want to see my grandson",
      revisedText: "Arrange a visit with the grandson",
      status: "revised",
    }),
    goal("goal-family", { source: "family_stated", status: "not_started" }),
    goal("goal-met", { status: "met" }),
    goal("goal-not-met", { status: "not_met" }),
    goal("goal-discontinued", { status: "discontinued" }),
    goal("goal-sud", { originalText: "Abstinence support", sudRelated: true }),
  ],
  interventions: [
    intervention("iv-counsel", { scopeText: "Supportive counselling", frequencyText: "weekly" }),
    intervention("iv-sud", { scopeText: "Relapse prevention", goalRefs: ["GOAL-SUD"] }),
    intervention("iv-discontinued", { status: "discontinued" }),
    intervention("iv-completed", { status: "completed" }),
  ],
});

/** v2: a different plan state, so a test can tell which version it read. */
const SNAPSHOT_V2 = snapshot({
  goals: [goal("goal-v2", { originalText: "Complete the legacy letters" })],
  interventions: [intervention("iv-v2")],
});

type SeededVersion = NonNullable<DisciplinePlanSeamSeed["versions"]>[number];

function version(over: Partial<SeededVersion> = {}): SeededVersion {
  return {
    versionId: "ver-1",
    planId: PLAN,
    patientId: PAT,
    admissionId: ADM,
    kind: "msw_plan",
    // M15 stamps `superseded_at` only at discharge, so an earlier signed version stays `signed` with no instant until then.
    status: "signed",
    signedAt: SIGNED_V1,
    supersededAt: null,
    spiritualCareDeclinedAt: null,
    stateSnapshot: SNAPSHOT_V1,
    ...over,
  };
}

const V1 = version();
const V2 = version({ versionId: "ver-2", signedAt: SIGNED_V2, stateSnapshot: SNAPSHOT_V2 });

type Verdict = { allowed: boolean; restrictedToNamedWorkforce: boolean };
const NO_RELEASE: Verdict = { allowed: false, restrictedToNamedWorkforce: false };
const RELEASE: Verdict = { allowed: true, restrictedToNamedWorkforce: false };
const NAMED_ONLY: Verdict = { allowed: false, restrictedToNamedWorkforce: true };

function portOf(verdict: Verdict | Error) {
  return {
    part2ReleaseActive: vi.fn(async () => {
      if (verdict instanceof Error) throw verdict;
      return verdict;
    }),
    familyViolenceRedacted: vi.fn(async () => true),
  } satisfies DisclosurePort;
}

function readerOver(versions: readonly SeededVersion[], port: DisclosurePort = portOf(NO_RELEASE)) {
  const { store } = createInMemoryDisciplinePlanSeamStore({ versions });
  return createDisciplinePlanReader(store, port);
}

const MSW = { roles: ["msw"], membershipId: "mem-msw" } as const;
const RN_CASE_MANAGER = { roles: ["rn_case_manager"], membershipId: "mem-rncm" } as const;

function ask(
  reader: ReturnType<typeof createDisciplinePlanReader>,
  asOf: string,
  over: { kind?: DisciplinePlanKind; viewer?: typeof MSW | typeof RN_CASE_MANAGER } = {},
) {
  return reader.planElementsAsOf(ORG, PAT, ADM, over.kind ?? "msw_plan", over.viewer ?? MSW, asOf);
}

describe("DisciplinePlanReader.planElementsAsOf: which version is in effect (VN-D11)", () => {
  it("reads the earlier signed version before the next one is signed and the newer one after", async () => {
    const reader = readerOver([V1, V2]);

    const during = await ask(reader, "2026-03-05T00:00:00.000Z");
    const after = await ask(reader, "2026-03-12T00:00:00.000Z");

    expect(during?.goals.map((g) => g.goalId)).toContain("goal-coping");
    expect(during?.goals.map((g) => g.goalId)).not.toContain("goal-v2");
    expect(after?.goals.map((g) => g.goalId)).toEqual(["goal-v2"]);
  });

  it("is order-independent: the latest signed version wins however the rows arrive", async () => {
    const forward = await ask(readerOver([V1, V2]), "2026-03-12T00:00:00.000Z");
    const reversed = await ask(readerOver([V2, V1]), "2026-03-12T00:00:00.000Z");

    expect(reversed).toEqual(forward);
  });

  it("includes the signing instant itself and answers null one millisecond before it", async () => {
    const reader = readerOver([V1, V2]);

    expect(await ask(reader, SIGNED_V1)).not.toBeNull();
    expect(await ask(reader, "2026-03-01T08:59:59.999Z")).toBeNull();
    expect((await ask(reader, SIGNED_V2))?.goals.map((g) => g.goalId)).toEqual(["goal-v2"]);
  });

  it("keeps the latest signed version in effect indefinitely while nothing superseded it", async () => {
    expect((await ask(readerOver([V1, V2]), "2027-01-01T00:00:00.000Z"))?.goals).toHaveLength(1);
  });

  // The discharge consumer builds its `discharge` version from every CURRENT goal and intervention row of the plan (any status, unsigned edits
  // included) and stamps it signed by the system. It is not what the clinicians signed, so a note is never drafted from it: a visit after the
  // discharge reads the last version the clinicians signed.
  it("reads the versions a discharge superseded, and after the discharge still the last signed one, never the system-built discharge version", async () => {
    const dischargeSnapshot = snapshot({ goals: [goal("goal-final-unsigned")] });
    const reader = readerOver([
      version({ status: "superseded", supersededAt: DISCHARGED }),
      version({
        versionId: "ver-2",
        status: "superseded",
        signedAt: SIGNED_V2,
        supersededAt: DISCHARGED,
        stateSnapshot: SNAPSHOT_V2,
      }),
      version({
        versionId: "ver-discharge",
        versionKind: "discharge",
        signedAt: DISCHARGED,
        stateSnapshot: dischargeSnapshot,
      }),
    ]);

    const beforeDischarge = await ask(reader, "2026-03-20T00:00:00.000Z");
    const atDischarge = await ask(reader, DISCHARGED);
    const afterDischarge = await ask(reader, "2026-04-02T00:00:00.000Z");

    expect(beforeDischarge?.goals.map((g) => g.goalId)).toEqual(["goal-v2"]);
    expect(atDischarge?.goals.map((g) => g.goalId)).toEqual(["goal-v2"]);
    expect(afterDischarge?.goals.map((g) => g.goalId)).toEqual(["goal-v2"]);
    expect(JSON.stringify(afterDischarge)).not.toContain("goal-final-unsigned");
  });

  it("answers null for a plan whose only version is the discharge version", async () => {
    const reader = readerOver([version({ versionKind: "discharge" })]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it("settles two versions signed at the same instant by sequence, however the rows arrive", async () => {
    const low = version({ versionId: "low", sequence: 1, stateSnapshot: SNAPSHOT_V1 });
    const high = version({ versionId: "high", sequence: 2, stateSnapshot: SNAPSHOT_V2 });

    for (const rows of [
      [low, high],
      [high, low],
    ]) {
      const out = await ask(readerOver(rows), "2026-03-05T00:00:00.000Z");
      expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-v2"]);
    }
  });

  it("fails closed on a superseded version with no superseded_at (it cannot be placed in time)", async () => {
    const reader = readerOver([version({ status: "superseded", supersededAt: null })]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it("ignores a draft or in-review version, which is in effect at no instant", async () => {
    const reader = readerOver([
      version({ versionId: "a", status: "draft", signedAt: null }),
      version({ versionId: "b", status: "in_review", signedAt: null }),
    ]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it("ignores another admission, another patient and the other plan kind", async () => {
    const reader = readerOver([
      version({ admissionId: "adm-other" }),
      version({ versionId: "x", patientId: "pat-other" }),
      version({ versionId: "y", kind: "spiritual_plan" }),
    ]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
    expect(
      await ask(reader, "2026-03-05T00:00:00.000Z", { kind: "spiritual_plan" }),
    ).not.toBeNull();
  });

  it("answers null when the patient has no plan version at all", async () => {
    expect(await ask(readerOver([]), "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it("reports the plan and patient of the version it read", async () => {
    expect(await ask(readerOver([V1]), "2026-03-05T00:00:00.000Z")).toMatchObject({
      planId: PLAN,
      patientId: PAT,
    });
  });

  it("rejects an asOf that is not an instant rather than guessing", async () => {
    await expect(ask(readerOver([V1]), "not-a-date")).rejects.toThrow(/asOf/);
  });
});

describe("DisciplinePlanReader.planElementsAsOf: a spiritual-care declination", () => {
  const declined = (declinedAt: string | null) =>
    version({ kind: "spiritual_plan", spiritualCareDeclinedAt: declinedAt });

  it("answers null for a spiritual plan the patient had declined at the visit time", async () => {
    const reader = readerOver([declined("2026-03-02T00:00:00.000Z")]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z", { kind: "spiritual_plan" })).toBeNull();
  });

  it("reads the plan for a visit before the declination", async () => {
    const reader = readerOver([declined("2026-03-20T00:00:00.000Z")]);

    expect(
      await ask(reader, "2026-03-05T00:00:00.000Z", { kind: "spiritual_plan" }),
    ).not.toBeNull();
  });

  it("is a spiritual-care fact only: a social-work plan is not affected by it", async () => {
    const reader = readerOver([version({ spiritualCareDeclinedAt: "2026-03-02T00:00:00.000Z" })]);

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).not.toBeNull();
  });
});

describe("DisciplinePlanReader.planElementsAsOf: what is handed over", () => {
  it("returns open goals only and active interventions only", async () => {
    const out = await ask(readerOver([V1]), "2026-03-05T00:00:00.000Z");

    expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-coping", "goal-revised", "goal-family"]);
    expect(out?.interventions.map((i) => i.interventionId)).toEqual(["iv-counsel"]);
  });

  it("shows a revised goal's revision and says it is one; an unrevised goal keeps its original and its source", async () => {
    const out = await ask(readerOver([V1]), "2026-03-05T00:00:00.000Z");

    expect(out?.goals).toEqual([
      {
        goalId: "goal-coping",
        text: "Name two ways to cope with the diagnosis",
        source: "clinical",
        revised: false,
        sudRelated: false,
      },
      {
        goalId: "goal-revised",
        text: "Arrange a visit with the grandson",
        source: "patient_stated",
        revised: true,
        sudRelated: false,
      },
      {
        goalId: "goal-family",
        text: "original goal-family",
        source: "family_stated",
        revised: false,
        sudRelated: false,
      },
    ]);
  });

  it("carries an intervention's scope and frequency and nothing of its status, roles or reasons", async () => {
    const out = await ask(readerOver([V1]), "2026-03-05T00:00:00.000Z");

    expect(out?.interventions).toEqual([
      {
        interventionId: "iv-counsel",
        scopeText: "Supportive counselling",
        frequencyText: "weekly",
        sudRelated: false,
      },
    ]);
  });

  it("never carries a goal's status, progress or measurable outcome", async () => {
    const text = JSON.stringify(await ask(readerOver([V1]), "2026-03-05T00:00:00.000Z"));

    expect(text).not.toContain("measurable outcome nobody");
    expect(text).not.toContain("in_progress");
    expect(text).not.toContain("status");
  });

  it("reads the frozen version, not anything else the store holds", async () => {
    const out = await ask(readerOver([V1, V2]), "2026-03-05T00:00:00.000Z");

    expect(JSON.stringify(out)).not.toContain("legacy letters");
  });
});

describe("DisciplinePlanReader.planElementsAsOf: what cannot be stated is left out, not fatal", () => {
  // The draft states each element as a sentence and refuses a text that is nothing once its trailing periods are dropped. M15's input schema
  // only requires one character, so a goal of "." is a valid sealed goal; it must not make every draft of the patient unavailable.
  it.each([".", "...", " . ", ". ."])(
    "leaves out a goal whose words are only %j",
    async (words) => {
      const sealed = version({
        stateSnapshot: snapshot({
          goals: [goal("goal-bad", { originalText: words }), goal("goal-ok")],
        }),
      });

      const out = await ask(readerOver([sealed]), "2026-03-05T00:00:00.000Z");

      expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-ok"]);
    },
  );

  it("leaves out a goal whose revision is only periods, and an intervention whose scope is", async () => {
    const sealed = version({
      stateSnapshot: snapshot({
        goals: [goal("goal-bad", { revisedText: "..", status: "revised" }), goal("goal-ok")],
        interventions: [intervention("iv-bad", { scopeText: "..." }), intervention("iv-ok")],
      }),
    });

    const out = await ask(readerOver([sealed]), "2026-03-05T00:00:00.000Z");

    expect(out?.goals.map((g) => g.goalId)).toEqual(["goal-ok"]);
    expect(out?.interventions.map((i) => i.interventionId)).toEqual(["iv-ok"]);
  });

  it("answers null for a snapshot with an unreasonable number of elements (fail closed), and reads one at the cap", async () => {
    const many = (n: number, make: (id: string) => unknown) =>
      Array.from({ length: n }, (_, i) => make(`el-${i}`));
    const asOf = "2026-03-05T00:00:00.000Z";

    expect(
      await ask(
        readerOver([version({ stateSnapshot: snapshot({ goals: many(501, (id) => goal(id)) }) })]),
        asOf,
      ),
    ).toBeNull();
    expect(
      await ask(
        readerOver([
          version({
            stateSnapshot: snapshot({ interventions: many(501, (id) => intervention(id)) }),
          }),
        ]),
        asOf,
      ),
    ).toBeNull();
    const atTheCap = await ask(
      readerOver([version({ stateSnapshot: snapshot({ goals: many(500, (id) => goal(id)) }) })]),
      asOf,
    );
    expect(atTheCap?.goals).toHaveLength(500);
  });
});

describe("DisciplinePlanReader.planElementsAsOf: the tenant it is asked for", () => {
  it("reads only the asked tenant's versions when the store knows their tenant", async () => {
    const asOf = "2026-03-05T00:00:00.000Z";

    expect(await ask(readerOver([version({ organizationId: "org-other" })]), asOf)).toBeNull();
    expect(await ask(readerOver([version({ organizationId: ORG })]), asOf)).not.toBeNull();
  });
});

describe("DisciplinePlanReader.planElementsAsOf: 42 CFR Part 2 (per viewer, fail closed)", () => {
  it("withholds the SUD goal and the intervention anchored to it from a viewer without disclosure", async () => {
    const out = await ask(readerOver([V1], portOf(NO_RELEASE)), "2026-03-05T00:00:00.000Z");
    const text = JSON.stringify(out);

    expect(out?.redacted).toBe(true);
    expect(text).not.toContain("Abstinence");
    expect(text).not.toContain("Relapse prevention");
    expect(text).not.toContain("goal-sud");
    expect(text).not.toContain("iv-sud");
  });

  it("shows the SUD goal and its intervention, flagged, to a viewer with disclosure", async () => {
    const out = await ask(readerOver([V1], portOf(RELEASE)), "2026-03-05T00:00:00.000Z");

    expect(out?.redacted).toBe(false);
    expect(out?.goals.find((g) => g.goalId === "goal-sud")).toMatchObject({ sudRelated: true });
    expect(out?.interventions.find((i) => i.interventionId === "iv-sud")).toMatchObject({
      sudRelated: true,
    });
  });

  // `redacted` says something that would have been listed was withheld. A Part 2 goal that is closed is not listed for anyone, so it must not
  // make the draft ask a second verdict (and fail on an outage) for a plan whose visible content is whole.
  it("says redacted only when something that would have been listed was withheld", async () => {
    const closedOnly = version({
      stateSnapshot: snapshot({
        goals: [goal("goal-a"), goal("goal-sud-closed", { sudRelated: true, status: "met" })],
      }),
    });
    const openSud = version({
      stateSnapshot: snapshot({ goals: [goal("goal-a"), goal("goal-sud", { sudRelated: true })] }),
    });
    const anchoredToClosed = version({
      stateSnapshot: snapshot({
        goals: [goal("goal-sud-closed", { sudRelated: true, status: "met" })],
        interventions: [intervention("iv-anchored", { goalRefs: ["goal-sud-closed"] })],
      }),
    });
    const asOf = "2026-03-05T00:00:00.000Z";

    expect((await ask(readerOver([closedOnly], portOf(NO_RELEASE)), asOf))?.redacted).toBe(false);
    expect((await ask(readerOver([openSud], portOf(NO_RELEASE)), asOf))?.redacted).toBe(true);
    // an active intervention that serves a Part 2 goal is Part 2 content by its anchor, whatever the goal's status
    expect((await ask(readerOver([anchoredToClosed], portOf(NO_RELEASE)), asOf))?.redacted).toBe(
      true,
    );
    expect((await ask(readerOver([openSud], portOf(RELEASE)), asOf))?.redacted).toBe(false);
  });

  it("returns different results to two viewers of the same version", async () => {
    const withDisclosure = await ask(readerOver([V1], portOf(RELEASE)), "2026-03-05T00:00:00.000Z");
    const without = await ask(readerOver([V1], portOf(NO_RELEASE)), "2026-03-05T00:00:00.000Z");

    expect(withDisclosure?.goals).toHaveLength(4);
    expect(without?.goals).toHaveLength(3);
  });

  it("lets an RN case manager through where no release names others, and not where one does", async () => {
    const open = await ask(readerOver([V1], portOf(NO_RELEASE)), "2026-03-05T00:00:00.000Z", {
      viewer: RN_CASE_MANAGER,
    });
    const restricted = await ask(readerOver([V1], portOf(NAMED_ONLY)), "2026-03-05T00:00:00.000Z", {
      viewer: RN_CASE_MANAGER,
    });

    expect(open?.redacted).toBe(false);
    expect(restricted?.redacted).toBe(true);
  });

  it("does not let a social worker's role alone through (only the RN case manager carve-out exists)", async () => {
    const out = await ask(readerOver([V1], portOf(NO_RELEASE)), "2026-03-05T00:00:00.000Z");

    expect(out?.redacted).toBe(true);
  });

  it("redacts, never discloses, when the consent evaluator fails", async () => {
    const out = await ask(
      readerOver([V1], portOf(new Error("M39 down"))),
      "2026-03-05T00:00:00.000Z",
      { viewer: RN_CASE_MANAGER },
    );

    expect(out?.redacted).toBe(true);
    expect(JSON.stringify(out)).not.toContain("Abstinence");
  });

  it("asks M39 as the viewer, for the patient, from M15", async () => {
    const port = portOf(NO_RELEASE);
    await ask(readerOver([V1], port), "2026-03-05T00:00:00.000Z");

    expect(port.part2ReleaseActive).toHaveBeenCalledWith({
      organizationId: ORG,
      patientId: PAT,
      sessionClass: "staff",
      membershipId: "mem-msw",
    });
  });

  it("does not ask M39 when the snapshot holds no Part 2 content", async () => {
    const port = portOf(NO_RELEASE);
    const clean = version({ stateSnapshot: snapshot({ goals: [goal("goal-a")] }) });

    const out = await ask(readerOver([clean], port), "2026-03-05T00:00:00.000Z");

    expect(out?.redacted).toBe(false);
    expect(port.part2ReleaseActive).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["the string 'false'", "false"],
    ["0", 0],
  ])("treats a goal whose sudRelated is %s as Part 2", async (_label, flag) => {
    const { sudRelated: _drop, ...rest } = goal("goal-flagless", { originalText: "Hidden goal" });
    const mangled = flag === undefined ? rest : { ...rest, sudRelated: flag };
    const flagless = version({ stateSnapshot: snapshot({ goals: [mangled] }) });

    const hidden = await ask(
      readerOver([flagless], portOf(NO_RELEASE)),
      "2026-03-05T00:00:00.000Z",
    );
    const shown = await ask(readerOver([flagless], portOf(RELEASE)), "2026-03-05T00:00:00.000Z");

    expect(hidden).toMatchObject({ goals: [], redacted: true });
    expect(JSON.stringify(hidden)).not.toContain("Hidden goal");
    expect(shown?.goals).toEqual([expect.objectContaining({ sudRelated: true })]);
  });

  it("drops an intervention anchored to a SUD goal whatever the case of the reference", async () => {
    const anchored = version({
      stateSnapshot: snapshot({
        goals: [goal("11111111-AAAA-bbbb-cccc-111111111111", { sudRelated: true })],
        interventions: [
          intervention("iv-upper", { goalRefs: ["11111111-aaaa-BBBB-cccc-111111111111"] }),
        ],
      }),
    });

    const out = await ask(readerOver([anchored], portOf(NO_RELEASE)), "2026-03-05T00:00:00.000Z");

    expect(out?.interventions).toEqual([]);
  });

  it("never hands a Part 2 goal to a viewer a release restricted to named staff", async () => {
    const out = await ask(readerOver([V1], portOf(NAMED_ONLY)), "2026-03-05T00:00:00.000Z");

    expect(out?.goals.every((g) => !g.sudRelated)).toBe(true);
    expect(out?.interventions.every((i) => !i.sudRelated)).toBe(true);
  });
});

describe("DisciplinePlanReader.planElementsAsOf: unexpected snapshot shapes answer null", () => {
  const shapes: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["a string", "not-a-snapshot"],
    ["an array", []],
    ["an empty object", {}],
    ["goals not an array", { goals: {}, interventions: [] }],
    ["goals missing", { interventions: [] }],
    ["interventions missing", { goals: [] }],
    ["interventions not an array", { goals: [], interventions: "x" }],
    ["a goal that is not an object", snapshot({ goals: ["goal-coping"] })],
    ["a goal without an id", snapshot({ goals: [{ ...goal("g"), goalId: undefined }] })],
    ["a goal without a status", snapshot({ goals: [{ ...goal("g"), status: undefined }] })],
    [
      "a goal with an unknown source",
      snapshot({ goals: [goal("g", { source: "oracle_stated" })] }),
    ],
    [
      "a goal without original text",
      snapshot({ goals: [{ ...goal("g"), originalText: undefined }] }),
    ],
    [
      "an intervention without scope text",
      snapshot({ interventions: [{ ...intervention("i"), scopeText: undefined }] }),
    ],
    [
      "an intervention without frequency text",
      snapshot({ interventions: [{ ...intervention("i"), frequencyText: undefined }] }),
    ],
    [
      "an intervention whose goalRefs is not an array",
      snapshot({ interventions: [{ ...intervention("i"), goalRefs: "g" }] }),
    ],
    [
      "an intervention without a status",
      snapshot({ interventions: [{ ...intervention("i"), status: undefined }] }),
    ],
  ];

  it.each(shapes)("for a viewer without disclosure: %s", async (_label, stateSnapshot) => {
    const reader = readerOver([version({ stateSnapshot })], portOf(NO_RELEASE));

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });

  it.each(shapes)("for a viewer with disclosure: %s", async (_label, stateSnapshot) => {
    const reader = readerOver([version({ stateSnapshot })], portOf(RELEASE));

    expect(await ask(reader, "2026-03-05T00:00:00.000Z")).toBeNull();
  });
});
