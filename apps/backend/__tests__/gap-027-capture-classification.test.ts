// GAP-027 — EVV events carry a server-derived service-type code; an empty one never reaches the aggregator.
import { SandataAdapter } from "@wardenx/evv-aggregators";
import { describe, expect, it } from "vitest";

import {
  classifyCapture,
  submissionServiceTypeCode,
} from "../src/modules/18-evv/capture-classification";

describe("GAP-027 capture classification", () => {
  it("derives the stamp from the registration", () => {
    expect(classifyCapture({ serviceTypeCode: "routine_visit", assignedDiscipline: "rn" })).toEqual(
      { serviceTypeCode: "routine_visit", postingDisciplineAtRecording: "rn" },
    );
  });

  it("refuses a capture whose registration has no service type", () => {
    expect(() => classifyCapture({ serviceTypeCode: "", assignedDiscipline: "rn" })).toThrow(
      /serviceTypeCode/,
    );
  });

  it("refuses a capture whose registration has no discipline", () => {
    expect(() => classifyCapture({ serviceTypeCode: "x", assignedDiscipline: " " })).toThrow(
      /assignedDiscipline/,
    );
  });

  it("submits the event's own code when present", () => {
    expect(submissionServiceTypeCode("T1019", "routine_visit")).toBe("T1019");
  });

  it("falls back to the registration for a legacy empty event code", () => {
    expect(submissionServiceTypeCode("", "routine_visit")).toBe("routine_visit");
  });

  it("rejects when neither the event nor the registration has a code", () => {
    expect(() => submissionServiceTypeCode("", null)).toThrow(/serviceTypeCode/);
  });
});

describe("GAP-027 Sandata payload builder", () => {
  const args = {
    orgId: "o",
    visitId: "v",
    checkInEventId: "a",
    checkOutEventId: "b",
    clinicianNpi: "1234567893",
    patientStateIdentifier: "M1",
    encounterDurationMinutes: 30,
  };

  it("rejects an empty service type code", async () => {
    const adapter = new SandataAdapter();
    await expect(
      adapter.buildSubmissionPayload({ ...args, serviceTypeCode: "" } as never),
    ).rejects.toThrow(/empty serviceTypeCode/);
  });

  it("builds a body carrying the service code when present", async () => {
    const adapter = new SandataAdapter();
    const { body } = await adapter.buildSubmissionPayload({
      ...args,
      serviceTypeCode: "routine_visit",
    } as never);
    expect(body).toMatchObject({ serviceCode: "routine_visit" });
  });
});
