import type { MedicationOrderDto, PatientAllergyEntry, PatientIdentity } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  PATIENT_CONTEXT_TILES,
  type PatientContextPorts,
  type PatientContextTile,
  buildPatientContext,
} from "./patient-context-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const ALL: ReadonlySet<PatientContextTile> = new Set(PATIENT_CONTEXT_TILES);

const identity = { id: PATIENT, organizationId: ORG, status: "active" } as PatientIdentity;
const allergy = { allergenText: "penicillin", severity: "severe" } as PatientAllergyEntry;

function ports(over: Partial<PatientContextPorts> = {}): PatientContextPorts {
  return {
    findPatient: async () => identity,
    careTeamMembers: async () => ["u1", "u2"],
    activeAllergies: async () => [allergy],
    activeMedications: async () => [{}, {}, {}] as MedicationOrderDto[],
    now: () => NOW,
    ...over,
  };
}

describe("buildPatientContext", () => {
  it("projects every permitted tile with as_of and an owning-module link", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, allowed: ALL },
      ports(),
    );

    expect(ctx?.tiles.status).toMatchObject({
      state: "ok",
      as_of: NOW.toISOString(),
      data: { status: "active" },
    });
    expect(ctx?.tiles.care_team).toMatchObject({ state: "ok", data: { member_count: 2 } });
    expect(ctx?.tiles.allergies).toMatchObject({
      state: "ok",
      data: { entries: [{ allergen: "penicillin" }] },
    });
    expect(ctx?.tiles.medications).toMatchObject({
      state: "ok",
      data: { active_count: 3 },
      link: `/patients/${PATIENT}/medications`,
    });
  });

  it("omits a tile the caller may not see and never calls its source", async () => {
    let medsCalled = false;
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, allowed: new Set(["status", "care_team"]) },
      ports({
        activeMedications: async () => {
          medsCalled = true;
          return [];
        },
      }),
    );

    expect("medications" in (ctx?.tiles ?? {})).toBe(false);
    expect("allergies" in (ctx?.tiles ?? {})).toBe(false);
    expect(medsCalled).toBe(false);
  });

  it("marks one tile unavailable when its seam throws and keeps the others", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, allowed: ALL },
      ports({
        activeMedications: async () => {
          throw new Error("deny-stub");
        },
      }),
    );

    expect(ctx?.tiles.medications).toMatchObject({ state: "unavailable" });
    expect(ctx?.tiles.status).toMatchObject({ state: "ok" });
  });

  it("treats an unreadable allergy list (null) as unavailable, never as no allergies", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, allowed: new Set(["allergies"]) },
      ports({ activeAllergies: async () => null }),
    );

    expect(ctx?.tiles.allergies).toMatchObject({ state: "unavailable" });
  });

  it("returns null when the patient does not exist in the org", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, allowed: ALL },
      ports({ findPatient: async () => null }),
    );

    expect(ctx).toBeNull();
  });

  it("returns no tiles without reading the patient when nothing is permitted", async () => {
    let read = false;
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, allowed: new Set() },
      ports({
        findPatient: async () => {
          read = true;
          return identity;
        },
      }),
    );

    expect(ctx).toEqual({ patient_id: PATIENT, tiles: {} });
    expect(read).toBe(false);
  });
});
