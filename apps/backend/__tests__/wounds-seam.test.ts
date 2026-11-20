// apps/backend/__tests__/wounds-seam.test.ts — M9's WoundProvider seam over the in-memory records the route service keeps.
// The Drizzle store is proven live (wounds.live.test.ts); this pins the provider's contract without a database: only the
// CURRENT observations recorded at the encounter, ordered, tenant- and patient-scoped, failing closed on a blank scope,
// and registered under the seam name the M8 visit note resolves.
import type { WoundProvider } from "@chartwarden/assessments";
import { describe, expect, it } from "vitest";
import { createInMemoryWoundService, registerWoundSeam } from "../src/modules/09-assessments/index";
import { createInMemoryWoundProviderStore } from "../src/modules/09-assessments/wounds/seam";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "11111111-1111-4111-8111-222222222222";
const ENCOUNTER = "55555555-5555-4555-8555-555555555555";
const OTHER_ENCOUNTER = "55555555-5555-4555-8555-666666666666";
const NOW = new Date("2026-11-19T15:00:00.000Z");
const actor = (organizationId = ORG) => ({ organizationId, userId: "u1", membershipId: "m1" });
const reader = { userId: "u1" };

/** M8's answer for the two visits the actor ("m1") is writing for PATIENT. */
const openVisits = new Set([ENCOUNTER, OTHER_ENCOUNTER]);
const visits = {
  draftOf: async ({ encounterId }: { encounterId: string }) =>
    openVisits.has(encounterId)
      ? ({
          patientId: PATIENT,
          status: "draft",
          authoredByMembershipId: "m1",
          templateStatesWounds: true,
        } as const)
      : null,
};

async function seeded() {
  const backend = createInMemoryWoundService({ now: () => NOW, visits });
  const { service } = backend;
  const heel = await service.createWound(actor(), PATIENT, {
    siteCode: "heel",
    laterality: "left",
    etiology: "pressure_injury",
  });
  const sacrum = await service.createWound(actor(), PATIENT, {
    siteCode: "sacrum",
    laterality: "midline",
    etiology: "pressure_injury",
  });
  const late = await service.recordObservation(actor(), PATIENT, heel.id, {
    observedAt: "2026-11-19T14:00:00.000Z",
    sourceEncounterId: ENCOUNTER,
    lengthCm: 3,
    widthCm: 2,
    stage: "stage_2",
  });
  const early = await service.recordObservation(actor(), PATIENT, sacrum.id, {
    observedAt: "2026-11-19T13:00:00.000Z",
    sourceEncounterId: ENCOUNTER,
    stage: "stage_3",
    painScore: 5,
  });
  const wrong = await service.recordObservation(actor(), PATIENT, heel.id, {
    observedAt: "2026-11-19T12:00:00.000Z",
    sourceEncounterId: ENCOUNTER,
    lengthCm: 9,
    widthCm: 9,
  });
  const fixed = await service.correctObservation(actor(), PATIENT, heel.id, wrong.id, 1, {
    observedAt: "2026-11-19T12:00:00.000Z",
    lengthCm: 2,
    widthCm: 2,
    correctionReason: "measurement_error",
  });
  await service.recordObservation(actor(), PATIENT, heel.id, {
    observedAt: "2026-11-18T09:00:00.000Z",
    sourceEncounterId: OTHER_ENCOUNTER,
  });
  await service.recordObservation(actor(), PATIENT, heel.id, {
    observedAt: "2026-11-18T10:00:00.000Z",
  });
  return { backend, ids: { late: late.id, early: early.id, fixed: fixed.id } };
}

describe("WoundProvider seam", () => {
  it("returns the current observations of the encounter, oldest first, the corrected one replaced by its correction", async () => {
    // Arrange
    const { backend, ids } = await seeded();
    // Act
    const rows = await backend.provider.listObservationsForEncounter(ORG, ENCOUNTER, reader);
    // Assert
    expect(rows.map((r) => r.observationId)).toEqual([ids.fixed, ids.early, ids.late]);
    expect(rows.map((r) => r.site)).toEqual(["left heel", "sacrum", "left heel"]);
  });

  it("mirrors the note's RecordedWound field for field, nulls where nothing was recorded", async () => {
    const { backend, ids } = await seeded();
    const rows = await backend.provider.listObservationsForEncounter(ORG, ENCOUNTER, reader);
    expect(rows.find((r) => r.observationId === ids.late)).toEqual({
      observationId: ids.late,
      woundId: expect.any(String),
      observedAt: "2026-11-19T14:00:00.000Z",
      site: "left heel",
      etiology: "pressure_injury",
      stage: "stage_2",
      lengthCm: 3,
      widthCm: 2,
      depthCm: null,
      undermining: null,
      woundBed: [],
      exudateAmount: null,
      exudateType: null,
      odor: null,
      periwound: [],
      painScore: null,
      dressing: null,
      dressingChanged: null,
      infectionSigns: null,
      trend: null,
    });
  });

  it("returns only the asked encounter's observations, and nothing for an unknown one or another organisation", async () => {
    const { backend } = await seeded();
    expect(
      await backend.provider.listObservationsForEncounter(ORG, OTHER_ENCOUNTER, reader),
    ).toHaveLength(1);
    expect(
      await backend.provider.listObservationsForEncounter(
        ORG,
        "55555555-5555-4555-8555-999999999999",
        reader,
      ),
    ).toEqual([]);
    expect(await backend.provider.listObservationsForEncounter(ORG_B, ENCOUNTER, reader)).toEqual(
      [],
    );
  });

  it("narrows to the encounter's patient on request", async () => {
    const { backend } = await seeded();
    expect(
      await backend.provider.listObservationsForEncounter(ORG, ENCOUNTER, reader, {
        patientId: OTHER_PATIENT,
      }),
    ).toEqual([]);
    expect(
      await backend.provider.listObservationsForEncounter(ORG, ENCOUNTER, reader, {
        patientId: PATIENT,
      }),
    ).toHaveLength(3);
  });

  it("fails closed on a blank organisation or encounter", async () => {
    const { backend } = await seeded();
    await expect(
      backend.provider.listObservationsForEncounter("", ENCOUNTER, reader),
    ).rejects.toThrow("organizationId required");
    await expect(backend.provider.listObservationsForEncounter(ORG, "  ", reader)).rejects.toThrow(
      "encounterId required",
    );
  });

  it("registers under the name the visit note resolves", async () => {
    // Arrange
    const { backend } = await seeded();
    const registered: [string, WoundProvider][] = [];
    // Act
    registerWoundSeam(
      (name, impl) => registered.push([name, impl]),
      createInMemoryWoundProviderStore({
        wounds: backend.wounds,
        observations: backend.observations,
      }),
    );
    // Assert
    expect(registered.map(([name]) => name)).toEqual(["WoundProvider"]);
    expect(
      await registered[0]?.[1].listObservationsForEncounter(ORG, ENCOUNTER, reader),
    ).toHaveLength(3);
  });
});
