// Module 28 — §4.5 single-entity read-only mappers (M28-T04).
//
// Every Phase-1 mapper is PURE (same domain + same MapperContext.asOfDate ⇒ byte-identical output, the
// determinism the §164.528 disclosure record depends on) and pins the US Core StructureDefinition into
// meta.profile. These lock the field mapping + the D9 identifier-URI split (per-tenant MRN vs canonical
// RxNorm/ICD-10) for Patient/Encounter/Condition/Goal/CarePlan/MedicationRequest/MedicationStatement.

import { describe, expect, it } from "vitest";

import {
  type CarePlanDomain,
  type ConditionDomain,
  type EncounterDomain,
  type GoalDomain,
  ICD10CM_SYSTEM,
  type MedicationRequestDomain,
  type MedicationStatementDomain,
  type PatientRow,
  RXNORM_SYSTEM,
  carePlanMapper,
  conditionMapper,
  encounterMapper,
  goalMapper,
  medicationRequestMapper,
  medicationStatementMapper,
  mrnSystemUri,
  patientMapper,
} from "../src";
import type { MapperContext } from "../src";

const ctx: MapperContext = {
  organizationId: "org-1",
  tenantFhirHost: "engrace.fhir.wardenx.com",
  identifierUriBase: "https://engrace.fhir.wardenx.com",
  asOfDate: "2026-08-02T00:00:00Z",
  recipientClientId: "client-1",
  redactSudContent: false,
  includeProvenance: false,
};

describe("patientMapper", () => {
  const row: PatientRow = {
    id: "pat-1",
    mrn: "MRN-42",
    firstName: "Ada",
    lastName: "Lovelace",
    middleName: "Byron",
    gender: "female",
    birthDate: "1815-12-10",
    deceasedDateTime: null,
    phone: "555-0100",
    email: "ada@example.com",
    addressLines: ["1 Analytical Way"],
    city: "London",
    state: "NY",
    postalCode: "10001",
  };

  it("projects US Core Patient with the per-tenant MRN identifier system (D9)", () => {
    const p = patientMapper.map(row, ctx);
    expect(p.resourceType).toBe("Patient");
    expect(p.id).toBe("pat-1");
    expect(p.meta?.profile).toEqual([
      "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient",
    ]);
    expect(p.identifier?.[0]).toEqual({ use: "usual", system: mrnSystemUri(ctx), value: "MRN-42" });
    expect(mrnSystemUri(ctx)).toBe("https://engrace.fhir.wardenx.com/sid/mrn");
    expect(p.name?.[0]).toEqual({ use: "official", family: "Lovelace", given: ["Ada", "Byron"] });
    expect(p.gender).toBe("female");
    expect(p.telecom).toEqual([
      { system: "phone", value: "555-0100" },
      { system: "email", value: "ada@example.com" },
    ]);
  });

  it("is deterministic (byte-identical on re-projection)", () => {
    expect(JSON.stringify(patientMapper.map(row, ctx))).toBe(
      JSON.stringify(patientMapper.map(row, ctx)),
    );
  });

  it("omits identifier when there is no MRN, and defaults gender to unknown", () => {
    const p = patientMapper.map({ ...row, mrn: null, gender: null }, ctx);
    expect(p.identifier).toBeUndefined();
    expect(p.gender).toBe("unknown");
  });
});

describe("encounterMapper", () => {
  it("projects US Core Encounter with the v3-ActCode class", () => {
    const row: EncounterDomain = {
      id: "enc-1",
      patientId: "pat-1",
      status: "finished",
      classCode: "HH",
      classDisplay: "home health",
      typeCode: "12345",
      typeText: "Home visit",
      practitionerMdmId: "mdm-9",
      periodStart: "2026-07-01T14:00:00Z",
      periodEnd: "2026-07-01T15:00:00Z",
    };
    const e = encounterMapper.map(row, ctx);
    expect(e.status).toBe("finished");
    expect(e.class).toEqual({
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "HH",
      display: "home health",
    });
    expect(e.subject.reference).toBe("Patient/pat-1");
    expect(e.participant?.[0].individual?.reference).toBe("Practitioner/mdm-9");
    expect(e.period).toEqual({ start: "2026-07-01T14:00:00Z", end: "2026-07-01T15:00:00Z" });
  });
});

describe("conditionMapper", () => {
  it("projects ICD-10 + SNOMED codings on the canonical systems", () => {
    const row: ConditionDomain = {
      id: "cond-1",
      patientId: "pat-1",
      icd10Code: "C34.90",
      icd10Text: "Malignant neoplasm of lung",
      snomedCode: "363358000",
      clinicalStatus: "active",
      verificationStatus: "confirmed",
      categoryCode: "encounter-diagnosis",
      onsetDateTime: "2026-01-01",
      recordedDate: "2026-01-02",
    };
    const c = conditionMapper.map(row, ctx);
    expect(c.code?.coding).toEqual([
      { system: ICD10CM_SYSTEM, code: "C34.90", display: "Malignant neoplasm of lung" },
      { system: "http://snomed.info/sct", code: "363358000" },
    ]);
    expect(c.clinicalStatus?.coding?.[0].code).toBe("active");
    expect(c.verificationStatus?.coding?.[0].code).toBe("confirmed");
  });
});

describe("goalMapper", () => {
  it("projects US Core Goal with a due date target", () => {
    const row: GoalDomain = {
      id: "goal-1",
      patientId: "pat-1",
      lifecycleStatus: "active",
      description: "Pain controlled below 3/10",
      achievementStatus: "in-progress",
      targetDueDate: "2026-09-01",
    };
    const g = goalMapper.map(row, ctx);
    expect(g.lifecycleStatus).toBe("active");
    expect(g.description).toEqual({ text: "Pain controlled below 3/10" });
    expect(g.target?.[0]).toEqual({ dueDate: "2026-09-01" });
  });
});

describe("carePlanMapper", () => {
  it("projects goal + condition references", () => {
    const row: CarePlanDomain = {
      id: "cp-1",
      patientId: "pat-1",
      status: "active",
      intent: "plan",
      title: "Hospice plan of care",
      goalIds: ["goal-1", "goal-2"],
      addressesConditionIds: ["cond-1"],
    };
    const cp = carePlanMapper.map(row, ctx);
    expect(cp.goal).toEqual([{ reference: "Goal/goal-1" }, { reference: "Goal/goal-2" }]);
    expect(cp.addresses).toEqual([{ reference: "Condition/cond-1" }]);
    expect(cp.category?.[0].coding?.[0].code).toBe("assess-plan");
  });
});

describe("medication mappers", () => {
  it("MedicationRequest uses the RxNorm system with text fallback", () => {
    const row: MedicationRequestDomain = {
      id: "mr-1",
      patientId: "pat-1",
      status: "active",
      intent: "order",
      rxnormCode: "197361",
      rxnormText: "Morphine 10 mg tablet",
      authoredOn: "2026-07-01",
      requesterMdmId: "mdm-9",
      dosageText: "10 mg PO q4h PRN",
      routeCode: "PO",
      routeText: "Oral",
    };
    const mr = medicationRequestMapper.map(row, ctx);
    expect(mr.medicationCodeableConcept?.coding?.[0]).toEqual({
      system: RXNORM_SYSTEM,
      code: "197361",
      display: "Morphine 10 mg tablet",
    });
    expect(mr.dosageInstruction?.[0].text).toBe("10 mg PO q4h PRN");
    expect(mr.requester?.reference).toBe("Practitioner/mdm-9");
  });

  it("MedicationRequest falls back to free text when RxNorm is absent", () => {
    const mr = medicationRequestMapper.map(
      {
        id: "mr-2",
        patientId: "pat-1",
        status: "active",
        intent: "order",
        medicationText: "compounded cream",
      },
      ctx,
    );
    expect(mr.medicationCodeableConcept).toEqual({ text: "compounded cream" });
  });

  it("MedicationStatement projects effective period + dosage", () => {
    const row: MedicationStatementDomain = {
      id: "ms-1",
      patientId: "pat-1",
      status: "active",
      rxnormText: "Lorazepam",
      effectiveStart: "2026-06-01",
      effectiveEnd: "2026-07-01",
      dateAsserted: "2026-06-01",
      dosageText: "0.5 mg SL BID",
    };
    const ms = medicationStatementMapper.map(row, ctx);
    expect(ms.effectivePeriod).toEqual({ start: "2026-06-01", end: "2026-07-01" });
    expect(ms.dosage?.[0].text).toBe("0.5 mg SL BID");
    expect(ms.medicationCodeableConcept).toEqual({ text: "Lorazepam" });
  });
});
