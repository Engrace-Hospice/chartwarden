// S1 PR C2a — `computeDraft` (VN-D4, VN-D10, VN-D11, design §3.2): the visit time, the as-of per-viewer reads, the
// stored selection tree and the pure compiler, composed. Nothing is cached across calls.
import type { RecordedWound } from "@chartwarden/hearthnote";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import { computeDraft, snapshotStorePorts } from "../src/modules/08-encounters/drafting/compute";
import {
  AS_OF,
  NOW,
  NOW_ISO,
  ORG_ID,
  PATIENT_ID,
  carePlan,
  change,
  encounter,
  fakePorts,
  honestSeries,
  point,
  viewer,
} from "./_encounter-draft-fixtures";

const PREVIOUS_VISIT = new Date("2026-11-10T15:00:00.000Z");
const sectionOf = (draft: Awaited<ReturnType<typeof computeDraft>>["draft"], id: string) =>
  draft.sections.find((s) => s.sectionId === id);

describe("computeDraft: composition", () => {
  const richPorts = () =>
    fakePorts({
      carePlanAsOf: async () => carePlan(),
      scaleSeries: honestSeries({
        pps: [
          point("pps-prev", "2026-11-10T15:00:00.000Z", 60),
          point("pps-now", "2026-11-18T14:10:00.000Z", 50),
        ],
      }),
      latestVitals: async () => ({
        id: "vitals-1",
        recordedAt: "2026-11-18T14:20:00.000Z",
        heartRate: 72,
      }),
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => [
        change("started", "2026-11-12T16:00:00.000Z", { id: "order-a" }),
      ],
    });

  it("returns the draft, the visit time and the template key", async () => {
    const out = await computeDraft(richPorts(), encounter(), viewer(), NOW);
    expect(out.templateKey).toBe("routine_visit:rn");
    expect(out.draft.templateKey).toBe("routine_visit:rn");
    expect(out.asOf).toBe(NOW_ISO);
    expect(out.draft.asOf).toBe(NOW_ISO);
  });

  it("drafts each source into its section and leaves the rest empty", async () => {
    const { draft } = await computeDraft(richPorts(), encounter(), viewer(), NOW);
    expect(draft.sections.map((s) => [s.sectionId, s.state])).toEqual([
      ["chief_concern", "empty"],
      ["vitals_review", "drafted"],
      ["assessment", "drafted"],
      // WF09: the recorded ADL, nutrition and wound sections are free text only, so nothing drafts them.
      ["functional_status", "empty"],
      ["nutrition", "empty"],
      ["skin_wounds", "empty"],
      ["symptom_management", "empty"],
      ["interventions", "drafted"],
      ["plan", "drafted"],
    ]);
    const interventions = sectionOf(draft, "interventions");
    expect(interventions?.state === "drafted" && interventions.text).toContain(
      "Repositioning schedule review",
    );
    expect(interventions?.state === "drafted" && interventions.text).toContain(
      "Morphine sulfate was started on 2026-11-12",
    );
  });

  it("hashes with SHA-256 as 64 lowercase hex characters", async () => {
    const { draft } = await computeDraft(richPorts(), encounter(), viewer(), NOW);
    const plan = sectionOf(draft, "plan");
    expect(plan?.state === "drafted" && plan.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("renders the clinician's own selections into a drafted section", async () => {
    const ports = fakePorts({
      carePlanAsOf: async () => carePlan(),
      loadSelection: async () => ({
        selection: {
          templateKey: "routine_visit:rn",
          vocabVersion: VOCAB_VERSION,
          encounterType: "routine_visit",
          discipline: "rn",
          sections: [{ sectionId: "plan", entries: [], freeText: "Family meeting arranged." }],
        },
        context: { patient: "Patient", serviceDate: "2026-11-18" },
      }),
    });
    const { draft } = await computeDraft(ports, encounter(), viewer(), NOW);
    const plan = sectionOf(draft, "plan");
    expect(plan?.state === "drafted" && plan.text).toContain("Family meeting arranged.");
  });
});

describe("computeDraft: a scale reading the previous visit already had", () => {
  it("leaves the assessment empty instead of drafting the reading as unchanged from itself", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({ pps: [point("pps-old", "2026-11-03T15:00:00.000Z", 60)] }),
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
    });
    const { draft } = await computeDraft(ports, encounter(), viewer(), NOW);
    expect(sectionOf(draft, "assessment")?.state).toBe("empty");
    expect(JSON.stringify(draft)).not.toContain("unchanged");
    expect(JSON.stringify(draft)).not.toContain("pps-old");
  });

  it("still drafts the change when a newer reading follows the previous visit", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({
        pps: [
          point("pps-old", "2026-11-03T15:00:00.000Z", 60),
          point("pps-new", "2026-11-18T14:10:00.000Z", 50),
        ],
      }),
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
    });
    const { draft } = await computeDraft(ports, encounter(), viewer(), NOW);
    const assessment = sectionOf(draft, "assessment");
    expect(assessment?.state === "drafted" && assessment.text).toContain(
      "PPS 50%, down from 60% on 2026-11-03",
    );
  });
});

describe("computeDraft: the visit time", () => {
  const rowsOf = <T extends { recordedAt: string }>(rows: readonly T[], asOf: string) =>
    rows
      .filter((r) => Date.parse(r.recordedAt) <= Date.parse(asOf))
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))
      .at(-1) ?? null;

  it("is now while the service date is in progress, and goes to every as-of read", async () => {
    const ports = fakePorts({ carePlanAsOf: async () => null });
    const out = await computeDraft(ports, encounter(), viewer(), NOW);
    expect(out.asOf).toBe(NOW_ISO);
    expect(ports.carePlanAsOf.mock.calls[0]?.[5]).toBe(NOW_ISO);
    expect(ports.scaleSeries.mock.calls.map((c) => c[3])).toEqual([NOW_ISO, NOW_ISO]);
    expect(ports.latestVitals).toHaveBeenCalledWith(encounter().id, NOW_ISO);
  });

  it("is the end of the service date in the org zone once that date has ended", async () => {
    const out = await computeDraft(
      fakePorts(),
      encounter({ serviceDate: "2026-11-10" }),
      viewer(),
      NOW,
    );
    expect(out.asOf).toBe("2026-11-11T04:59:59.999Z");
  });

  it("describes the patient at the end of the service date for a late entry, never today", async () => {
    const lateEncounter = encounter({ serviceDate: "2026-11-10" });
    const ports = fakePorts({
      scaleSeries: honestSeries({
        pps: [
          point("pps-visit", "2026-11-10T15:10:00.000Z", 60),
          point("pps-today", "2026-11-18T14:10:00.000Z", 30),
        ],
      }),
      latestVitals: async (_id, asOf) =>
        rowsOf(
          [{ id: "vitals-today", recordedAt: "2026-11-18T14:20:00.000Z", heartRate: 99 }],
          asOf,
        ),
    });
    const { draft } = await computeDraft(ports, lateEncounter, viewer(), NOW);
    const assessment = sectionOf(draft, "assessment");
    expect(assessment?.state === "drafted" && assessment.text).toContain("PPS 60%");
    expect(JSON.stringify(draft)).not.toContain("PPS 30%");
    expect(JSON.stringify(draft)).not.toContain("vitals-today");
  });

  describe("readings captured later on the service date", () => {
    // Documented the next afternoon: the visit's day (Nov 18 EST) has ended, at 2026-11-19T04:59:59.999Z.
    const nextDay = new Date("2026-11-19T20:00:00.000Z");
    const build = (rows: { vitals: string; pps: string }[]) => {
      const vitalsRows = rows.map((r, i) => ({
        id: `vitals-${i}`,
        recordedAt: r.vitals,
        heartRate: 70 + i,
      }));
      return fakePorts({
        scaleSeries: honestSeries({
          pps: rows.map((r, i) => point(`pps-${i}`, r.pps, 50 - i * 10)),
        }),
        latestVitals: async (_id, asOf) => rowsOf(vitalsRows, asOf),
      });
    };

    it("drafts vitals and a PPS reading captured after check-in the same service day", async () => {
      const ports = build([
        { vitals: "2026-11-18T22:00:00.000Z", pps: "2026-11-18T22:05:00.000Z" },
      ]);
      const { draft } = await computeDraft(ports, encounter(), viewer(), nextDay);
      const vitals = sectionOf(draft, "vitals_review");
      const assessment = sectionOf(draft, "assessment");
      expect(vitals?.state === "drafted" && vitals.sourceRefs).toEqual([
        { kind: "vitals", id: "vitals-0" },
      ]);
      expect(assessment?.state === "drafted" && assessment.text).toContain("PPS 50%");
    });

    it("does not draft a vitals row or PPS reading captured the next local day", async () => {
      const ports = build([
        { vitals: "2026-11-18T22:00:00.000Z", pps: "2026-11-18T22:05:00.000Z" },
        { vitals: "2026-11-19T15:00:00.000Z", pps: "2026-11-19T15:05:00.000Z" },
      ]);
      const { draft } = await computeDraft(ports, encounter(), viewer(), nextDay);
      const json = JSON.stringify(draft);
      expect(json).toContain("vitals-0");
      expect(json).toContain("PPS 50%");
      expect(json).not.toContain("vitals-1");
      expect(json).not.toContain("PPS 40%");
    });

    it("keeps 23:30 local on the service day (already the next day in UTC) and drops local midnight", async () => {
      const inDay = build([
        { vitals: "2026-11-19T04:30:00.000Z", pps: "2026-11-19T04:30:00.000Z" },
      ]);
      const drafted = await computeDraft(inDay, encounter(), viewer(), nextDay);
      expect(JSON.stringify(drafted.draft)).toContain("vitals-0");
      const midnight = build([
        { vitals: "2026-11-19T05:00:00.000Z", pps: "2026-11-19T05:00:00.000Z" },
      ]);
      const dropped = await computeDraft(midnight, encounter(), viewer(), nextDay);
      expect(sectionOf(dropped.draft, "vitals_review")?.state).toBe("empty");
      expect(sectionOf(dropped.draft, "assessment")?.state).toBe("empty");
    });
  });

  it("reads the organization's time zone once per call", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({ pps: [point("pps-1", "2026-11-18T14:10:00.000Z", 50)] }),
    });
    await computeDraft(ports, encounter(), viewer(), NOW);
    expect(ports.organizationTimeZone).toHaveBeenCalledTimes(1);
    expect(ports.organizationTimeZone).toHaveBeenCalledWith(ORG_ID);
  });

  it("is DRAFT_UNAVAILABLE for a service date that is not a date", async () => {
    await expect(
      computeDraft(fakePorts(), encounter({ serviceDate: "2026-02-30" }), viewer(), NOW),
    ).rejects.toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
  });
});

describe("computeDraft: determinism and no caching across calls", () => {
  const ports = () =>
    fakePorts({
      carePlanAsOf: async () => carePlan(),
      scaleSeries: honestSeries({ pps: [point("pps-1", "2026-11-18T14:10:00.000Z", 50)] }),
    });

  it("gives equal drafts and equal hashes for equal inputs", async () => {
    const a = await computeDraft(ports(), encounter(), viewer(), NOW);
    const b = await computeDraft(ports(), encounter(), viewer(), NOW);
    expect(b).toEqual(a);
  });

  it("is not moved by `now` once the service date has ended", async () => {
    const ended = encounter({ serviceDate: "2026-11-18" });
    const a = await computeDraft(ports(), ended, viewer(), new Date("2026-11-19T10:00:00.000Z"));
    const b = await computeDraft(ports(), ended, viewer(), new Date("2026-12-24T09:00:00.000Z"));
    expect(b).toEqual(a);
  });

  it("recomputes from the seams on every call", async () => {
    let value = 50;
    const shared = fakePorts({
      scaleSeries: async (patientId, scaleType) => ({
        scaleType,
        patientId: patientId as never,
        from: "1970-01-01T00:00:00.000Z",
        to: AS_OF,
        points: scaleType === "pps" ? [point("pps-1", "2026-11-18T14:10:00.000Z", value)] : [],
      }),
    });
    const first = await computeDraft(shared, encounter(), viewer(), NOW);
    value = 40;
    const second = await computeDraft(shared, encounter(), viewer(), NOW);
    const hash = (d: typeof first) => {
      const s = sectionOf(d.draft, "assessment");
      return s?.state === "drafted" ? s.contentHash : null;
    };
    expect(hash(first)).not.toBeNull();
    expect(hash(second)).not.toBe(hash(first));
    expect(shared.scaleSeries).toHaveBeenCalledTimes(4);
    expect(shared.loadSelection).toHaveBeenCalledTimes(2);
  });
});

describe("computeDraft: 42 CFR Part 2, per viewer", () => {
  const sud = change("started", "2026-11-12T16:00:00.000Z", {
    id: "order-sud",
    drugName: "Buprenorphine",
    isSudTreatment: true,
  });
  const build = (disclosed: boolean) =>
    fakePorts({
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => [sud],
      part2DisclosureAllowed: async () => disclosed,
    });

  it("leaves SUD medication out of a viewer's draft without disclosure", async () => {
    const { draft } = await computeDraft(build(false), encounter(), viewer(), NOW);
    expect(JSON.stringify(draft)).not.toContain("Buprenorphine");
    expect(sectionOf(draft, "interventions")?.state).toBe("empty");
  });

  it("drafts it for a viewer with disclosure, and the section is Part 2", async () => {
    const { draft } = await computeDraft(build(true), encounter(), viewer(), NOW);
    const interventions = sectionOf(draft, "interventions");
    expect(interventions?.state === "drafted" && interventions.text).toContain("Buprenorphine");
    expect(interventions?.state === "drafted" && interventions.part2Derived).toBe(true);
  });

  it("marks a section built only from non-SUD sources as not Part 2", async () => {
    const ports = fakePorts({ carePlanAsOf: async () => carePlan() });
    const { draft } = await computeDraft(ports, encounter(), viewer(), NOW);
    const plan = sectionOf(draft, "plan");
    expect(plan?.state === "drafted" && plan.part2Derived).toBe(false);
  });

  it("recomputes for each viewer and never reuses another viewer's answer", async () => {
    const shared = fakePorts({
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => [sud],
      part2DisclosureAllowed: async ({ viewer: who }) => who.roles.includes("rn_case_manager"),
    });
    const withDisclosure = await computeDraft(
      shared,
      encounter(),
      viewer({ roles: ["rn_case_manager"] }),
      NOW,
    );
    const without = await computeDraft(shared, encounter(), viewer({ roles: ["rn"] }), NOW);
    expect(JSON.stringify(withDisclosure.draft)).toContain("Buprenorphine");
    expect(JSON.stringify(without.draft)).not.toContain("Buprenorphine");
    expect(shared.part2DisclosureAllowed).toHaveBeenCalledTimes(2);
  });

  it("asks the care-plan seam as the viewer, so its own redaction applies", async () => {
    const ports = fakePorts();
    const v = viewer({ roles: ["rn"], membershipId: null });
    await computeDraft(ports, encounter(), v, NOW);
    expect(ports.carePlanAsOf.mock.calls[0]?.[4]).toEqual({
      actor: { roles: ["rn"], membershipId: null },
    });
    expect(PATIENT_ID).toBe(ports.carePlanAsOf.mock.calls[0]?.[0]);
  });
});

describe("computeDraft: the wounds recorded on the visit", () => {
  const wound: RecordedWound = {
    site: "sacrum",
    etiology: "pressure_injury",
    stage: "stage_2",
    lengthCm: 2.5,
    widthCm: 1.5,
  };

  it("carry into the context the signed note is written from, asked of the seam for this visit", async () => {
    const ports = fakePorts({ recordedWounds: async () => [wound] });
    const out = await computeDraft(ports, encounter(), viewer(), NOW);
    expect(out.context.recordedWounds).toEqual([wound]);
    expect(ports.recordedWounds).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      encounterId: encounter().id,
      patientId: PATIENT_ID,
    });
  });

  it("leave the stored context as it was when there are none", async () => {
    const out = await computeDraft(fakePorts(), encounter(), viewer(), NOW);
    expect(out.context).not.toHaveProperty("recordedWounds");
  });

  it("make the draft unavailable when M9 cannot answer, rather than a note short of a wound", async () => {
    const ports = fakePorts({ recordedWounds: async () => Promise.reject(new Error("M9 down")) });
    await expect(computeDraft(ports, encounter(), viewer(), NOW)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
      statusCode: 503,
    });
  });
});

describe("computeDraft: failure", () => {
  it("is DRAFT_UNAVAILABLE when the stored selections cannot be loaded", async () => {
    const ports = fakePorts({ loadSelection: async () => Promise.reject(new Error("db down")) });
    await expect(computeDraft(ports, encounter(), viewer(), NOW)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("is DRAFT_UNAVAILABLE when a seam fails, with no partial draft", async () => {
    const ports = fakePorts({ scaleSeries: async () => Promise.reject(new Error("M9 down")) });
    await expect(computeDraft(ports, encounter(), viewer(), NOW)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });

  it("is DRAFT_UNAVAILABLE when a source is malformed (a blank goal)", async () => {
    const plan = carePlan({ goals: [{ ...carePlan().goals[0]!, text: "   " }] });
    const ports = fakePorts({ carePlanAsOf: async () => plan });
    await expect(computeDraft(ports, encounter(), viewer(), NOW)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });

  it("maps a selection authored against another corpus to VOCAB_VERSION_MISMATCH (409)", async () => {
    const ports = fakePorts({
      loadSelection: async () => ({
        selection: {
          templateKey: "routine_visit:rn",
          vocabVersion: "1999.01.0",
          encounterType: "routine_visit",
          discipline: "rn",
          sections: [],
        },
        context: { patient: "Patient", serviceDate: "2026-11-18" },
      }),
    });
    await expect(computeDraft(ports, encounter(), viewer(), NOW)).rejects.toMatchObject({
      code: "VOCAB_VERSION_MISMATCH",
      statusCode: 409,
    });
  });

  it("maps an encounter type and discipline with no template to INVALID_ENCOUNTER_DISCIPLINE_PAIR", async () => {
    await expect(
      computeDraft(fakePorts(), encounter({ discipline: "volunteer" }), viewer(), NOW),
    ).rejects.toMatchObject({ code: "INVALID_ENCOUNTER_DISCIPLINE_PAIR", statusCode: 422 });
  });
});

describe("snapshotStorePorts: the weights of a recertification or face-to-face draft (S2)", () => {
  const recert = encounter({ encounterType: "recert_visit", discipline: "rn" });
  const rows = [
    { id: "w-1", recordedAt: "2026-09-01T14:00:00.000Z", weight: "140", unit: "lb" },
    { id: "w-2", recordedAt: "2026-10-14T23:59:59.999Z", weight: "135", unit: "lb" },
    { id: "w-3", recordedAt: "2026-10-15T00:00:00.000Z", weight: "130", unit: "lb" },
  ];

  it("takes the weights once, from the epoch to the visit time, and serves them cut at the period start the later read names", async () => {
    const store = fakePorts({ weightReadings: async () => rows });
    const ports = await snapshotStorePorts(store, recert, NOW);
    expect(store.weightReadings).toHaveBeenCalledTimes(1);
    expect(store.weightReadings).toHaveBeenCalledWith(
      recert,
      "1970-01-01T00:00:00.000Z",
      expect.any(String),
    );
    const cut = await ports.weightReadings(recert, "2026-10-15T00:00:00.000Z", AS_OF);
    expect(cut.map((r) => r.id)).toEqual(["w-3"]);
    const all = await ports.weightReadings(recert, "2026-09-01T14:00:00.000Z", AS_OF);
    expect(all.map((r) => r.id)).toEqual(["w-1", "w-2", "w-3"]);
    expect(store.weightReadings).toHaveBeenCalledTimes(1);
  });

  it("takes none for a routine visit, and a read of them through its snapshot is a bug, not an empty answer", async () => {
    const store = fakePorts();
    const ports = await snapshotStorePorts(store, encounter(), NOW);
    expect(store.weightReadings).not.toHaveBeenCalled();
    await expect(
      ports.weightReadings(encounter(), "1970-01-01T00:00:00.000Z", AS_OF),
    ).rejects.toThrow("a weight read the snapshot did not take");
  });

  it("reads nothing for a template that drafts nothing: every store read through it is refused", async () => {
    const store = fakePorts();
    const ports = await snapshotStorePorts(store, encounter({ discipline: "msw" }), NOW);
    expect(store.organizationTimeZone).not.toHaveBeenCalled();
    expect(store.weightReadings).not.toHaveBeenCalled();
    await expect(ports.latestVitals(encounter().id, AS_OF)).rejects.toThrow(
      "a store read after its transaction closed",
    );
    await expect(ports.weightReadings(recert, "1970-01-01T00:00:00.000Z", AS_OF)).rejects.toThrow(
      "a store read after its transaction closed",
    );
  });
});

describe("snapshotStorePorts: the store reads of a source the template does not draft from (S3)", () => {
  it("takes the care-plan links alone for an aide, and a read of any other through its snapshot is a bug, not an empty answer", async () => {
    const aide = encounter({ encounterType: "chha_visit", discipline: "chha" });
    const store = fakePorts();
    const ports = await snapshotStorePorts(store, aide, NOW);
    expect(store.removedCarePlanElementIds).toHaveBeenCalledTimes(1);
    expect(store.previousSignedVisitAt).not.toHaveBeenCalled();
    expect(store.latestVitals).not.toHaveBeenCalled();
    await expect(ports.removedCarePlanElementIds(aide.id)).resolves.toEqual(new Set());
    await expect(ports.previousSignedVisitAt(aide)).rejects.toThrow(
      "a previous signed visit read the snapshot did not take",
    );
    await expect(ports.latestVitals(aide.id, AS_OF)).rejects.toThrow(
      "a vitals read the snapshot did not take",
    );
  });

  it("takes the previous visit and the recorded vitals and no care-plan links for a face-to-face visit, which reads scores and vitals", async () => {
    const f2f = encounter({ encounterType: "face_to_face", discipline: "md" });
    const recorded = { id: "vitals-1", recordedAt: "2026-11-18T14:20:00.000Z", heartRate: 72 };
    const store = fakePorts({ latestVitals: async () => recorded as never });
    const ports = await snapshotStorePorts(store, f2f, NOW);
    expect(store.previousSignedVisitAt).toHaveBeenCalledTimes(1);
    expect(store.latestVitals).toHaveBeenCalledTimes(1);
    expect(store.removedCarePlanElementIds).not.toHaveBeenCalled();
    await expect(ports.latestVitals(f2f.id, AS_OF)).resolves.toEqual(recorded);
    await expect(ports.previousSignedVisitAt(f2f)).resolves.toBeNull();
    await expect(ports.removedCarePlanElementIds(f2f.id)).rejects.toThrow(
      "a removed care-plan links read the snapshot did not take",
    );
  });

  it("takes the discipline-plan links alone for a social-work visit (S4b), and a read of them through any other template's snapshot is a bug, not an empty answer", async () => {
    const msw = encounter({ encounterType: "msw_followup", discipline: "msw" });
    const store = fakePorts();
    const ports = await snapshotStorePorts(store, msw, NOW);
    expect(store.removedDisciplinePlanElementIds).toHaveBeenCalledTimes(1);
    expect(store.removedCarePlanElementIds).not.toHaveBeenCalled();
    await expect(ports.removedDisciplinePlanElementIds(msw.id)).resolves.toEqual(new Set());

    const aide = encounter({ encounterType: "chha_visit", discipline: "chha" });
    const aideStore = fakePorts();
    const aidePorts = await snapshotStorePorts(aideStore, aide, NOW);
    expect(aideStore.removedDisciplinePlanElementIds).not.toHaveBeenCalled();
    await expect(aidePorts.removedDisciplinePlanElementIds(aide.id)).rejects.toThrow(
      "a removed discipline-plan links read the snapshot did not take",
    );
  });
});
