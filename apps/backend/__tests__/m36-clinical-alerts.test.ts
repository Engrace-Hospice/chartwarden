import { describe, expect, it } from "vitest";
import { presentationForClinicalEvent } from "../src/modules/36-messaging/outbox-consumers/clinical-alerts";

describe("M36 clinical alert presentation", () => {
  it("links a visit-specific scheduling alert to its registered visit detail route", () => {
    expect(
      presentationForClinicalEvent("m17.reassignment_needed", { visitId: "visit-1" }),
    ).toMatchObject({
      deepLink: "/scheduling/visits/visit-1",
      message: "A scheduled visit needs reassignment.",
    });
  });

  it("links time-off events to the registered time-off queue", () => {
    expect(presentationForClinicalEvent("m17.time_off.requested", {})).toMatchObject({
      deepLink: "/scheduling/time-off",
      message: "A time-off request requires review.",
    });
  });

  it("links cosignature alerts to the registered cosignature worklist", () => {
    expect(presentationForClinicalEvent("m8.encounter.cosignature_overdue", {})).toMatchObject({
      deepLink: "/work/cosignatures",
      message: "An encounter cosignature is overdue.",
    });
  });

  it("says so when a cosignature alert is for an AMENDMENT of a signed note (ADR-0114 VN-D30) and names its addendum; the work list is the same", () => {
    for (const eventType of [
      "m8.encounter.cosignature_routed",
      "m8.encounter.cosignature_overdue",
      "m8.encounter.cosignature_escalated",
      "m8.encounter.cosignature_hard_cap_reached",
    ]) {
      const note = presentationForClinicalEvent(eventType, { encounterId: "e-1" });
      const amendment = presentationForClinicalEvent(eventType, {
        encounterId: "e-1",
        addendumId: "a-1",
      });
      expect(amendment, eventType).toMatchObject({
        addendumId: "a-1",
        encounterId: "e-1",
        deepLink: "/work/cosignatures",
      });
      expect(String(amendment.message), eventType).toContain("amendment");
      expect(String(note.message), eventType).not.toContain("amendment");
      expect(note.addendumId, eventType).toBeNull();
    }
  });

  it("does not give an admission discharge a scheduling message and uses its admission route", () => {
    expect(
      presentationForClinicalEvent("m6.admission.discharged", { admissionId: "admission-1" }),
    ).toMatchObject({
      deepLink: "/admissions/admission-1",
      message: "An admission has been discharged.",
    });
  });

  it("omits a fabricated destination when a visit identifier is absent", () => {
    expect(presentationForClinicalEvent("m17.reassignment_needed", {}).deepLink).toBeUndefined();
  });
});
