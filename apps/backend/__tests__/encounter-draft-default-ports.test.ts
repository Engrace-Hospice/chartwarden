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
