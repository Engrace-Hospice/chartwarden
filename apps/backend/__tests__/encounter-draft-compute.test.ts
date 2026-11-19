// S1 PR C2a — `computeDraft` (VN-D4, VN-D10, VN-D11, design §3.2): the visit time, the as-of per-viewer reads, the
// stored selection tree and the pure compiler, composed. Nothing is cached across calls.
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import { computeDraft } from "../src/modules/08-encounters/drafting/compute";
import {
  AS_OF,
  NOW,
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
    expect(out.asOf).toBe(AS_OF);
    expect(out.draft.asOf).toBe(AS_OF);
  });

  it("drafts each source into its section and leaves the rest empty", async () => {
    const { draft } = await computeDraft(richPorts(), encounter(), viewer(), NOW);
    expect(draft.sections.map((s) => [s.sectionId, s.state])).toEqual([
      ["chief_concern", "empty"],
      ["vitals_review", "drafted"],
      ["assessment", "drafted"],
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

describe("computeDraft: the visit time", () => {
  it("uses started_at and passes it to every as-of read", async () => {
    const ports = fakePorts({ carePlanAsOf: async () => null });
    await computeDraft(ports, encounter(), viewer(), NOW);
    expect(ports.carePlanAsOf.mock.calls[0]?.[5]).toBe(AS_OF);
    expect(ports.scaleSeries.mock.calls.map((c) => c[3])).toEqual([AS_OF, AS_OF]);
    expect(ports.latestVitals).toHaveBeenCalledWith(encounter().id, AS_OF);
  });

  it("falls back to clock_started_at, then to the end of the service date in the org zone", async () => {
    const clock = await computeDraft(
      fakePorts(),
      encounter({ startedAt: null, clockStartedAt: new Date("2026-11-18T13:00:00.000Z") }),
      viewer(),
      NOW,
    );
    expect(clock.asOf).toBe("2026-11-18T13:00:00.000Z");
    const endOfDay = await computeDraft(
      fakePorts(),
      encounter({ startedAt: null, serviceDate: "2026-11-10" }),
      viewer(),
      NOW,
    );
    expect(endOfDay.asOf).toBe("2026-11-11T04:59:59.999Z");
  });

  it("describes the patient at the visit time for a late entry, never today", async () => {
    const lateEncounter = encounter({
      serviceDate: "2026-11-10",
      startedAt: new Date("2026-11-10T15:30:00.000Z"),
    });
    const ports = fakePorts({
      scaleSeries: honestSeries({
        pps: [
          point("pps-visit", "2026-11-10T15:10:00.000Z", 60),
          point("pps-today", "2026-11-18T14:10:00.000Z", 30),
        ],
      }),
      latestVitals: async (_id, asOf) =>
        Date.parse("2026-11-18T14:20:00.000Z") <= Date.parse(asOf)
          ? { id: "vitals-today", recordedAt: "2026-11-18T14:20:00.000Z", heartRate: 99 }
          : null,
    });
    const { draft } = await computeDraft(ports, lateEncounter, viewer(), NOW);
    const assessment = sectionOf(draft, "assessment");
    expect(assessment?.state === "drafted" && assessment.text).toContain("PPS 60%");
    expect(JSON.stringify(draft)).not.toContain("PPS 30%");
    expect(JSON.stringify(draft)).not.toContain("vitals-today");
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
      computeDraft(
        fakePorts(),
        encounter({ startedAt: null, serviceDate: "2026-02-30" }),
        viewer(),
        NOW,
      ),
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

  it("is not moved by `now` once the visit has a start time", async () => {
    const a = await computeDraft(ports(), encounter(), viewer(), NOW);
    const b = await computeDraft(
      ports(),
      encounter(),
      viewer(),
      new Date("2026-12-24T09:00:00.000Z"),
    );
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
