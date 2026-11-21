// S1 PR C2a — `defaultDraftPorts` resolves each seam from the M1 registry at call time and fails closed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { defaultDraftPorts } from "../src/modules/08-encounters/drafting/default-ports";
import { readDraftInputs } from "../src/modules/08-encounters/drafting/inputs";
import {
  AS_OF,
  ORG_ID,
  PATIENT_ID,
  change,
  encounter,
  fakePorts,
  viewer,
} from "./_encounter-draft-fixtures";

afterEach(() => __resetSeamsForTest());

const register = (name: string, impl: unknown) => registerSeam(name as never, impl as never);

describe("defaultDraftPorts", () => {
  it("delegates the care-plan read to the registered CarePlanReader's as-of method", async () => {
    const relevantElementsAsOf = vi.fn(async () => null);
    register("CarePlanReader", { relevantElementsAsOf });
    const audience = { actor: { roles: ["rn"], membershipId: null } };
    await defaultDraftPorts().carePlanAsOf(
      PATIENT_ID,
      "routine_visit",
      "rn",
      "adm",
      audience,
      AS_OF,
    );
    expect(relevantElementsAsOf).toHaveBeenCalledWith(
      PATIENT_ID,
      "routine_visit",
      "rn",
      "adm",
      audience,
      AS_OF,
    );
  });

  it("delegates the scale series to the registered ScaleSeriesProvider", async () => {
    const series = vi.fn(async () => ({ points: [] }));
    register("ScaleSeriesProvider", { series });
    await defaultDraftPorts().scaleSeries(PATIENT_ID, "pps", "from", "to");
    expect(series).toHaveBeenCalledWith(PATIENT_ID, "pps", "from", "to");
  });

  it("delegates the medication window to the registered MedicationOrderProvider", async () => {
    const getMedicationChangesBetween = vi.fn(async () => []);
    register("MedicationOrderProvider", { getMedicationChangesBetween });
    await defaultDraftPorts().medicationChangesBetween(ORG_ID, PATIENT_ID, "from", "to");
    expect(getMedicationChangesBetween).toHaveBeenCalledWith(ORG_ID, PATIENT_ID, "from", "to");
  });

  it("S2b: reads the orders in effect as of the visit instant from the registered MedicationOrderProvider", async () => {
    const getMedicationsAsOf = vi.fn(async () => []);
    register("MedicationOrderProvider", { getMedicationsAsOf });
    await defaultDraftPorts().activeMedicationsAsOf(ORG_ID, PATIENT_ID, AS_OF);
    expect(getMedicationsAsOf).toHaveBeenCalledWith(ORG_ID, PATIENT_ID, AS_OF);
  });

  it("S2b: reads the caregivers on the service date from the registered PatientCaregiverRosterReader", async () => {
    const caregiversOn = vi.fn(async () => []);
    register("PatientCaregiverRosterReader", { caregiversOn });
    await defaultDraftPorts().caregiversOn(ORG_ID, PATIENT_ID, "2026-11-18");
    expect(caregiversOn).toHaveBeenCalledWith(ORG_ID, PATIENT_ID, "2026-11-18");
  });

  describe("S2b: the advance directive acknowledgment (M39 consent evaluation)", () => {
    const ask = () =>
      defaultDraftPorts().advanceDirectiveAcknowledgment({
        organizationId: ORG_ID,
        patientId: PATIENT_ID,
        asOf: AS_OF,
      });

    it("asks M39 for the acknowledgment type as of the visit instant, historically (was it in force then, not is it now), as module m8, and answers the record that was active", async () => {
      const evaluate = vi.fn(async () => ({ allowed: true, consentRecordId: "consent-ad-1" }));
      register("ConsentEvaluator", { evaluate });
      await expect(ask()).resolves.toEqual({ consentRecordId: "consent-ad-1" });
      expect(evaluate).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        patientId: PATIENT_ID,
        consentType: "advance_directive_acknowledgment",
        asOf: AS_OF,
        historical: true,
        sessionContext: { sessionClass: "staff" },
        callerModule: "m8",
      });
    });

    it("answers none when no acknowledgment was active, whatever the reason", async () => {
      register("ConsentEvaluator", {
        evaluate: vi.fn(async () => ({ allowed: false, denyReason: "consent_revoked" })),
      });
      await expect(ask()).resolves.toBeNull();
    });

    it("answers none for an allowed verdict that names no record, and throws when M39 cannot answer (never a false none)", async () => {
      register("ConsentEvaluator", { evaluate: vi.fn(async () => ({ allowed: true })) });
      await expect(ask()).resolves.toBeNull();
      register("ConsentEvaluator", {
        evaluate: vi.fn(async () => {
          throw new Error("synthetic outage");
        }),
      });
      await expect(ask()).rejects.toThrow("synthetic outage");
    });
  });

  it("reads the visit's wounds through the registered WoundProvider, and fails closed when none is registered", async () => {
    const listObservationsForEncounter = vi.fn(async () => [
      { observationId: "o", woundId: "w", observedAt: "2026-11-18T14:00:00.000Z", site: "sacrum" },
    ]);
    register("WoundProvider", { listObservationsForEncounter });
    const query = { organizationId: ORG_ID, encounterId: "enc", patientId: PATIENT_ID };
    await expect(defaultDraftPorts().recordedWounds(query)).resolves.toEqual([{ site: "sacrum" }]);
    expect(listObservationsForEncounter).toHaveBeenCalledWith(
      ORG_ID,
      "enc",
      { userId: "" },
      { patientId: PATIENT_ID },
    );
    __resetSeamsForTest();
    await expect(defaultDraftPorts().recordedWounds(query)).rejects.toThrow();
  });

  describe("Part 2 verdict (M7's per-actor decision over M39)", () => {
    const verdict = (over: { redact: boolean; basis: string }) =>
      register("ConsentEvaluator", {
        evaluateForInternalAccess: vi.fn(async () => ({
          redactSubstanceUseDisorderFields: over.redact,
          basis: over.basis,
        })),
      });
    const ask = (roles: string[]) =>
      defaultDraftPorts().part2DisclosureAllowed({
        organizationId: ORG_ID,
        patientId: PATIENT_ID,
        viewer: { roles, membershipId: "membership-1" },
      });

    it("allows a viewer M39 does not redact", async () => {
      verdict({ redact: false, basis: "release_names_actor" });
      await expect(ask(["rn"])).resolves.toBe(true);
    });

    it("denies a viewer M39 redacts", async () => {
      verdict({ redact: true, basis: "no_release" });
      await expect(ask(["rn"])).resolves.toBe(false);
    });

    it("lets an RN case manager through only where no release names others", async () => {
      verdict({ redact: true, basis: "no_release" });
      await expect(ask(["rn_case_manager"])).resolves.toBe(true);
      verdict({ redact: true, basis: "release_names_others" });
      await expect(ask(["rn_case_manager"])).resolves.toBe(false);
    });

    it("names M8 as the calling module on M39's evaluation audit", async () => {
      const evaluateForInternalAccess = vi.fn(async () => ({
        redactSubstanceUseDisorderFields: false,
        basis: "release_names_actor",
      }));
      register("ConsentEvaluator", { evaluateForInternalAccess });
      await ask(["rn"]);
      expect(evaluateForInternalAccess).toHaveBeenCalledWith(
        expect.objectContaining({ callerModule: "m8", actor: { membershipId: "membership-1" } }),
      );
    });

    it("rethrows when M39 cannot be reached (the deny-stub throws): an outage is not a 'no'", async () => {
      register("ConsentEvaluator", {
        evaluateForInternalAccess: async () => Promise.reject(new Error("down")),
      });
      await expect(ask(["rn_case_manager"])).rejects.toThrow("down");
    });

    it("makes the draft DRAFT_UNAVAILABLE when M39 is down, instead of silently dropping SUD medication", async () => {
      register("ConsentEvaluator", {
        evaluateForInternalAccess: async () => Promise.reject(new Error("down")),
      });
      const ports = {
        ...fakePorts({
          previousSignedVisitAt: async () => new Date("2026-11-10T15:00:00.000Z"),
          medicationChangesBetween: async () => [
            change("started", "2026-11-12T16:00:00.000Z", { isSudTreatment: true }),
          ],
        }),
        part2DisclosureAllowed: defaultDraftPorts().part2DisclosureAllowed,
      };
      await expect(readDraftInputs(ports, encounter(), viewer(), AS_OF)).rejects.toMatchObject({
        code: "DRAFT_UNAVAILABLE",
        statusCode: 503,
      });
    });

    it("drops SUD medication end to end for a viewer M39 redacts", async () => {
      verdict({ redact: true, basis: "no_release" });
      const ports = {
        ...fakePorts({
          previousSignedVisitAt: async () => new Date("2026-11-10T15:00:00.000Z"),
          medicationChangesBetween: async () => [
            change("started", "2026-11-12T16:00:00.000Z", { isSudTreatment: true }),
          ],
        }),
        part2DisclosureAllowed: defaultDraftPorts().part2DisclosureAllowed,
      };
      const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
      expect(out.medicationChanges).toEqual([]);
    });
  });

  it("fails inside the read, not at wiring, when a seam is not registered", async () => {
    const ports = defaultDraftPorts();
    expect(() => ports.scaleSeries(PATIENT_ID, "pps", "from", "to")).toThrow();
    const wired = { ...fakePorts(), scaleSeries: ports.scaleSeries };
    await expect(readDraftInputs(wired, encounter(), viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });
});
