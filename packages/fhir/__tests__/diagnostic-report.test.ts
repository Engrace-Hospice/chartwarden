// Module 28 — §4.11 DiagnosticReport projector + D20 SUD redaction (M28-T04, W-FHIR-13/15).
//
// The DiagnosticReport is composed at read time from M11 (order) + M29 (observation) + M40 (facility),
// never persisted (§1.2). These lock: the non-SUD projection shape (W-FHIR-13), the whole-report D20
// redaction when any value is SUD-class (W-FHIR-15 — including the grep-test that no SUD value/LOINC
// survives), the null-returns (no order / non-lab / no observation), and deterministic re-projection.

import { describe, expect, it } from "vitest";

import {
  applySudRedactionToDiagnosticReport,
  projectDiagnosticReport,
  type DiagnosticReportProjectorDeps,
  type ExternalPhysicianReader,
  type FacilityReader,
  type LabObservationReader,
  type LabObservationRow,
  type LabOrderRow,
  type OrderProvider,
  type PatientReader,
} from "../src";

function orderProvider(order: LabOrderRow | null): OrderProvider {
  return {
    async findOrder() {
      return order;
    },
    async searchOrdersByPatient() {
      return order ? [order] : [];
    },
  };
}

function labReader(obs: LabObservationRow | null): LabObservationReader {
  return { async loadById() { return obs; } };
}

const patientReader: PatientReader = {
  async findById() {
    return {
      id: "pat-1",
      mrn: "MRN-1",
      firstName: "Ada",
      lastName: "Lovelace",
      middleName: null,
      gender: "female",
      birthDate: "1970-01-01",
      deceasedDateTime: null,
      phone: null,
      email: null,
      addressLines: null,
      city: null,
      state: null,
      postalCode: null,
    };
  },
};

const physicianReader: ExternalPhysicianReader = { async findById() { return { id: "mdm-9" }; } };
const facilityReader: FacilityReader = { async findById() { return { id: "fac-2" }; } };

const cbcOrder: LabOrderRow = {
  id: "order-1",
  kind: "lab",
  patientId: "pat-1",
  lastLabObservationAttachedId: "obs-1",
  orderingPhysicianMdmId: "mdm-9",
  labDestinationFacilityId: "fac-2",
  signedAt: "2026-07-01T10:00:00Z",
  data: { observationIdentifier: { code: "58410-2", text: "CBC panel" } },
};

const cbcObs: LabObservationRow = {
  id: "obs-1",
  attachedAt: "2026-07-02T08:00:00Z",
  values: [
    { loincCode: "6690-2", loincText: "WBC", numericValue: 7.2, unit: "10*3/uL", stringValue: null, criticalFlag: null, abnormalFlag: null, referenceRange: "4.0-11.0", sudRedactionStatus: "not_applicable" },
    { loincCode: "718-7", loincText: "Hemoglobin", numericValue: 13.5, unit: "g/dL", stringValue: null, criticalFlag: null, abnormalFlag: null, referenceRange: "12.0-16.0", sudRedactionStatus: "not_applicable" },
    { loincCode: "4544-3", loincText: "Hematocrit", numericValue: 40, unit: "%", stringValue: null, criticalFlag: "HH", abnormalFlag: null, referenceRange: "36-46", sudRedactionStatus: "not_applicable" },
  ],
};

function deps(order: LabOrderRow | null, obs: LabObservationRow | null): DiagnosticReportProjectorDeps {
  return {
    orderProvider: orderProvider(order),
    labObservationReader: labReader(obs),
    patientReader,
    externalPhysicianReader: physicianReader,
    facilityReader,
    sudRedactionApplier: applySudRedactionToDiagnosticReport,
  };
}

const input = { organizationId: "org-1", orderId: "order-1", clientId: "client-1" };

describe("projectDiagnosticReport — non-SUD (W-FHIR-13)", () => {
  it("composes report + 3 contained Observations with synthetic ids", async () => {
    const report = (await projectDiagnosticReport(deps(cbcOrder, cbcObs), input))!;
    expect(report.id).toBe("order-1"); // the M11 order id, not the observation id
    expect(report.status).toBe("final");
    expect(report.meta?.profile).toContain(
      "http://hl7.org/fhir/us/core/StructureDefinition/us-core-diagnosticreport-lab",
    );
    expect(report.contained).toHaveLength(3);
    expect(report.contained?.map((o) => o.id)).toEqual(["obs-1--0", "obs-1--1", "obs-1--2"]);
    expect(report.result).toEqual([
      { reference: "Observation/obs-1--0" },
      { reference: "Observation/obs-1--1" },
      { reference: "Observation/obs-1--2" },
    ]);
    expect(report.performer).toEqual([
      { reference: "Practitioner/mdm-9" },
      { reference: "Organization/fac-2" },
    ]);
    expect(report.meta?.security ?? []).not.toContainEqual(
      expect.objectContaining({ code: "R" }),
    );
    // critical flag surfaces as an interpretation
    expect(report.contained?.[2].interpretation?.[0].coding?.[0].code).toBe("HH");
  });

  it("is deterministic across re-projection", async () => {
    const a = await projectDiagnosticReport(deps(cbcOrder, cbcObs), input);
    const b = await projectDiagnosticReport(deps(cbcOrder, cbcObs), input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns null when no order / non-lab order / no observation attached", async () => {
    expect(await projectDiagnosticReport(deps(null, cbcObs), input)).toBeNull();
    expect(await projectDiagnosticReport(deps({ ...cbcOrder, kind: "imaging" }, cbcObs), input)).toBeNull();
    expect(
      await projectDiagnosticReport(deps({ ...cbcOrder, lastLabObservationAttachedId: null }, cbcObs), input),
    ).toBeNull();
  });
});

describe("projectDiagnosticReport — SUD-class (W-FHIR-15, D20)", () => {
  const sudObs: LabObservationRow = {
    id: "obs-2",
    attachedAt: "2026-07-02T08:00:00Z",
    values: [
      { loincCode: "6690-2", loincText: "WBC", numericValue: 7.2, unit: "10*3/uL", stringValue: null, criticalFlag: null, abnormalFlag: null, referenceRange: "4.0-11.0", sudRedactionStatus: "not_applicable" },
      { loincCode: "19295-5", loincText: "Methadone screen", numericValue: null, unit: null, stringValue: "positive", criticalFlag: null, abnormalFlag: "A", referenceRange: null, sudRedactionStatus: "redacted_consent_absent" },
    ],
  };
  const sudOrder: LabOrderRow = { ...cbcOrder, id: "order-2", lastLabObservationAttachedId: "obs-2" };

  it("whole-report redacts, clears conclusion, adds R label", async () => {
    const report = (await projectDiagnosticReport(deps(sudOrder, sudObs), {
      ...input,
      orderId: "order-2",
    }))!;
    expect(report.result).toEqual([{ reference: "Observation/order-2--sud-placeholder" }]);
    expect(report.contained).toHaveLength(1);
    expect(report.contained?.[0].code.text).toBe("SUD-protected results");
    expect(report.contained?.[0].dataAbsentReason?.coding?.[0].code).toBe("temp-unknown");
    expect(report.contained?.[0].note?.[0].text).toContain("42 CFR Part 2");
    expect(report.conclusion).toBeUndefined();
    expect(report.meta?.security).toContainEqual(expect.objectContaining({ code: "R" }));
  });

  it("no SUD value/LOINC survives anywhere in the response (grep test)", async () => {
    const report = await projectDiagnosticReport(deps(sudOrder, sudObs), { ...input, orderId: "order-2" });
    const wire = JSON.stringify(report);
    expect(wire).not.toContain("19295-5"); // methadone LOINC
    expect(wire).not.toContain("Methadone");
    expect(wire).not.toContain("positive");
    expect(wire).not.toContain("R-SUD"); // internal marker never reaches the wire
    expect(wire).not.toContain("6690-2"); // the whole report collapses — even the non-SUD WBC is gone
  });
});

describe("applySudRedactionToDiagnosticReport", () => {
  it("returns the report unchanged when no SUD child is present", () => {
    const clean = { resourceType: "DiagnosticReport" as const, id: "x", status: "final" as const, code: {}, subject: {}, contained: [] };
    expect(applySudRedactionToDiagnosticReport(clean)).toBe(clean);
  });
});
