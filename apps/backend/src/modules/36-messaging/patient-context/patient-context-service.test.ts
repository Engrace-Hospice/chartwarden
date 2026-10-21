import type { MedicationOrderDto, PatientAllergyEntry, PatientIdentity } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  PATIENT_CONTEXT_TILES,
  type PatientContextPorts,
  type PatientContextTile,
  buildPatientContext,
} from "./patient-context-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
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
    openTaskCount: async () => 4,
    now: () => NOW,
    ...over,
  };
}

describe("buildPatientContext", () => {
  it("projects every permitted tile with as_of and an owning-module link", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, userId: USER, allowed: ALL },
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
    expect(ctx?.tiles.open_tasks).toMatchObject({
      state: "ok",
      data: { count: 4 },
      link: "/notifications?tab=tasks",
    });
  });

  it("counts open tasks for the calling user, not the team", async () => {
    const seen: unknown[][] = [];
    await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, userId: USER, allowed: new Set(["open_tasks"]) },
      ports({
        openTaskCount: async (...args) => {
          seen.push(args);
          return 0;
        },
      }),
    );

    expect(seen).toEqual([[ORG, PATIENT, USER]]);
  });

  it("degrades only the open-tasks tile when the task count throws", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, userId: USER, allowed: ALL },
      ports({
        openTaskCount: async () => {
          throw new Error("db down");
        },
      }),
    );

    expect(ctx?.tiles.open_tasks).toMatchObject({ state: "unavailable" });
    expect(ctx?.tiles.status).toMatchObject({ state: "ok" });
  });

  it("omits a tile the caller may not see and never calls its source", async () => {
    let medsCalled = false;
    const ctx = await buildPatientContext(
      {
        organizationId: ORG,
        patientId: PATIENT,
        userId: USER,
        allowed: new Set(["status", "care_team"]),
      },
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
    const unavailable: string[] = [];
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, userId: USER, allowed: ALL },
      ports({
        activeMedications: async () => {
          throw new Error("deny-stub");
        },
        onTileUnavailable: (t) => unavailable.push(t),
      }),
    );

    expect(ctx?.tiles.medications).toMatchObject({ state: "unavailable" });
    expect(ctx?.tiles.status).toMatchObject({ state: "ok" });
    expect(unavailable).toEqual(["medications"]);
  });

  it("treats an unreadable allergy list (null) as unavailable, never as no allergies", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, userId: USER, allowed: new Set(["allergies"]) },
      ports({ activeAllergies: async () => null }),
    );

    expect(ctx?.tiles.allergies).toMatchObject({ state: "unavailable" });
  });

  it("returns null when the patient does not exist in the org", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, userId: USER, allowed: ALL },
      ports({ findPatient: async () => null }),
    );

    expect(ctx).toBeNull();
  });

  it("returns no tiles without reading the patient when nothing is permitted", async () => {
    let read = false;
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, userId: USER, allowed: new Set() },
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

  it("keeps the other tiles when the patient lookup itself throws", async () => {
    const ctx = await buildPatientContext(
      { organizationId: ORG, patientId: PATIENT, userId: USER, allowed: ALL },
      ports({
        findPatient: async () => {
          throw new Error("deny-stub");
        },
      }),
    );

    expect(ctx?.tiles.status).toMatchObject({ state: "unavailable" });
    expect(ctx?.tiles.medications).toMatchObject({ state: "ok", data: { active_count: 3 } });
  });
});
