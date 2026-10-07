import { describe, expect, it } from "vitest";
import { fhirInboundIsPatientScoped, fhirInboundSubjectPatientId } from "../src/lifecycle/inbound";

const ID = "3f2b8c1e-5a47-4d0e-9b1a-7c6d5e4f3a21";

describe("fhirInboundSubjectPatientId (GAP-198)", () => {
  it("reads the Patient/<uuid> subject of a MedicationStatement", () => {
    expect(
      fhirInboundSubjectPatientId("MedicationStatement", {
        subject: { reference: `Patient/${ID}` },
      }),
    ).toBe(ID);
  });
  it("reads a Patient's own uuid id", () => {
    expect(fhirInboundSubjectPatientId("Patient", { id: ID.toUpperCase() })).toBe(ID);
  });
  it("is null for a new Patient, an external id, or a malformed reference", () => {
    expect(fhirInboundSubjectPatientId("Patient", {})).toBeNull();
    expect(fhirInboundSubjectPatientId("Patient", { id: "ext-1" })).toBeNull();
    expect(
      fhirInboundSubjectPatientId("MedicationStatement", { subject: { reference: "Group/1" } }),
    ).toBeNull();
    expect(fhirInboundSubjectPatientId("MedicationStatement", { subject: "x" })).toBeNull();
  });
  it("only MedicationStatement is patient-scoped", () => {
    expect(fhirInboundIsPatientScoped("MedicationStatement")).toBe(true);
    expect(fhirInboundIsPatientScoped("Patient")).toBe(false);
  });
});
