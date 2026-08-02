// apps/backend/__tests__/portal-read-surfaces.test.ts — M31-T04 (§4.4, §5.1, §8.4, D7, D17).
//
// The PURE portal read layer — no DB, no live seam, no ambient clock: every upstream digest, the M38
// lay-label function, and `asOfMs` are injected. The cases that matter most pin the D17 minimization + D7
// redaction the §8 threat model turns on: a SUD-redacted medication shows a placeholder never the drug, a
// non-patient-facing document kind is DROPPED (fail-closed) even if the upstream leaks it, a redacted care
// plan discloses no problems, and the M38 lay-label fails OPEN to the source description on a terminology
// miss (a cosmetic gap, never a disclosure).
import type {
  BereavedPortalScope,
  PatientId,
  PatientIdentity,
  PortalAdministrationSummary,
  PortalDocumentDigest,
  PortalMedicationSummary,
  PortalTriageSummary,
  PortalVisitSummary,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type PortalTerminologyPort,
  PORTAL_PATIENT_FACING_DOCUMENT_KINDS,
  SUD_REDACTED_PLACEHOLDER,
  ageYearsFromDob,
  humanizeToken,
  isPatientFacingDocumentKind,
  layEnumLabel,
  layLabelForCode,
  projectAdministrationList,
  projectBereavementScope,
  projectCarePlan,
  projectDashboard,
  projectDocumentList,
  projectMedicationList,
  projectTriageList,
  projectVisitList,
  redactedDisplayName,
} from "../src/modules/31-portal/read-surfaces/index";

// ── §8.4 M38 lay labelling ─────────────────────────────────────────────────────────────────────────────
describe("layEnumLabel / humanizeToken", () => {
  it("prefers a curated override over the humanizer", () => {
    expect(layEnumLabel("telephonic")).toBe("Phone visit");
    expect(layEnumLabel("single_dose")).toBe("Single dose");
    expect(layEnumLabel("election_statement")).toBe("Hospice election form");
  });
  it("humanizes an unknown snake_case token instead of leaking it raw", () => {
    expect(layEnumLabel("some_new_status")).toBe("Some New Status");
    expect(humanizeToken("discharge_summary")).toBe("Discharge Summary");
  });
  it("never throws on an empty value", () => {
    expect(layEnumLabel("")).toBe("");
  });
});

describe("layLabelForCode (M38 opaque consult)", () => {
  const port: PortalTerminologyPort = {
    async lookup(system, code) {
      return system === "icd10" && code === "C34.90" ? { display: "Lung cancer" } : null;
    },
  };
  it("resolves the M38 display when present", async () => {
    expect(await layLabelForCode("icd10", "C34.90", "fallback", port)).toBe("Lung cancer");
  });
  it("fails OPEN to the fallback on a miss", async () => {
    expect(await layLabelForCode("icd10", "Z99.9", "raw description", port)).toBe("raw description");
  });
  it("fails OPEN to the fallback with no port / no code", async () => {
    expect(await layLabelForCode("icd10", "C34.90", "fb", null)).toBe("fb");
    expect(await layLabelForCode("icd10", null, "fb", port)).toBe("fb");
  });
  it("fails OPEN when the port throws", async () => {
    const throwing: PortalTerminologyPort = {
      lookup() {
        throw new Error("terminology down");
      },
    };
    expect(await layLabelForCode("icd10", "C34.90", "fb", throwing)).toBe("fb");
  });
});

// ── §8.4 / D7 minimization ─────────────────────────────────────────────────────────────────────────────
describe("document patient-facing allowlist", () => {
  it("admits patient-facing kinds and drops internal ones", () => {
    expect(isPatientFacingDocumentKind("election_statement")).toBe(true);
    expect(isPatientFacingDocumentKind("idg_patient_packet")).toBe(true);
    expect(isPatientFacingDocumentKind("encounter")).toBe(false);
    expect(isPatientFacingDocumentKind("idg_minutes")).toBe(false);
    expect(isPatientFacingDocumentKind("order_record")).toBe(false);
  });
  it("never lists an obviously-internal clinical kind", () => {
    for (const internal of ["encounter", "order_record", "medication_administration_record"] as const) {
      expect(PORTAL_PATIENT_FACING_DOCUMENT_KINDS.has(internal)).toBe(false);
    }
  });
});

describe("redactedDisplayName (D7)", () => {
  it("returns the placeholder when redacted", () => {
    expect(redactedDisplayName(true, "Morphine")).toBe(SUD_REDACTED_PLACEHOLDER);
  });
  it("returns the placeholder when the name is missing even if the flag is false (fail-closed)", () => {
    expect(redactedDisplayName(false, null)).toBe(SUD_REDACTED_PLACEHOLDER);
    expect(redactedDisplayName(false, "")).toBe(SUD_REDACTED_PLACEHOLDER);
  });
  it("returns the lay name when present and not redacted", () => {
    expect(redactedDisplayName(false, "Acetaminophen")).toBe("Acetaminophen");
  });
});

// ── §5.1 projectors ────────────────────────────────────────────────────────────────────────────────────
describe("projectMedicationList (M12, D7)", () => {
  const meds: PortalMedicationSummary[] = [
    { medicationOrderId: "m1", displayName: "Acetaminophen", instructions: "Take 1 tablet", status: "active", isRedacted: false },
    { medicationOrderId: "m2", displayName: "Buprenorphine", instructions: "SUD sig", status: "active", isRedacted: true },
  ];
  it("keeps every row (honest count) but redacts the SUD one", () => {
    const view = projectMedicationList(meds);
    expect(view.items).toHaveLength(2);
    expect(view.items[0]).toMatchObject({ displayName: "Acetaminophen", instructions: "Take 1 tablet", redacted: false });
    expect(view.items[1]).toMatchObject({ displayName: SUD_REDACTED_PLACEHOLDER, instructions: "", redacted: true });
    expect(view.items[0]?.statusLabel).toBe("Active");
  });
});

describe("projectAdministrationList (M13, D7)", () => {
  const admins: PortalAdministrationSummary[] = [
    { administrationRecordId: "a1", displayName: "Acetaminophen", administeredAt: "2026-08-01T10:00:00Z", mode: "single_dose", isRedacted: false },
    { administrationRecordId: "a2", displayName: "Methadone", administeredAt: "2026-08-01T12:00:00Z", mode: "iv_continuous_start", isRedacted: true },
  ];
  it("lay-labels the mode and redacts the SUD row", () => {
    const view = projectAdministrationList(admins);
    expect(view.items[0]).toMatchObject({ displayName: "Acetaminophen", modeLabel: "Single dose", redacted: false });
    expect(view.items[1]).toMatchObject({ displayName: SUD_REDACTED_PLACEHOLDER, modeLabel: "IV infusion started", redacted: true });
  });
});

describe("projectVisitList (M17)", () => {
  const visits: PortalVisitSummary[] = [
    { visitId: "v1", scheduledStartedAt: "2026-08-03T14:00:00Z", scheduledEndedAt: "2026-08-03T15:00:00Z", visitPurposeLabel: "Routine nursing visit", clinicianDisplayName: "RN Jordan", visitSetting: "telephonic" },
  ];
  it("carries the lay purpose + clinician and lay-labels the setting", () => {
    const view = projectVisitList(visits);
    expect(view.items[0]).toMatchObject({
      purposeLabel: "Routine nursing visit",
      clinicianDisplayName: "RN Jordan",
      settingLabel: "Phone visit",
    });
  });
});

describe("projectDocumentList (M22, §8.4 fail-closed)", () => {
  const digests: PortalDocumentDigest[] = [
    { documentId: "d1", aggregateType: "election_statement", title: "Election", activeVersionId: "ver1", createdAt: "2026-07-01T00:00:00Z" },
    { documentId: "d2", aggregateType: "encounter", title: "Internal encounter", activeVersionId: "ver2", createdAt: "2026-07-02T00:00:00Z" },
    { documentId: "d3", aggregateType: "idg_minutes", title: "IDG minutes", activeVersionId: null, createdAt: "2026-07-03T00:00:00Z" },
  ];
  it("drops non-patient-facing kinds and lay-labels the survivors", () => {
    const view = projectDocumentList(digests);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ documentId: "d1", kindLabel: "Hospice election form", hasActiveVersion: true });
  });
});

describe("projectTriageList (M19)", () => {
  const calls: PortalTriageSummary[] = [
    { triageCallId: "t1", occurredAt: "2026-08-01T02:00:00Z", callerRelationshipLabel: "Daughter", callerKind: "caregiver", dispositionSummaryLay: "Advice given; nurse visit next morning", visitDispatched: false, visitScheduledFirstLight: true },
    { triageCallId: "t2", occurredAt: "2026-08-01T03:00:00Z", callerRelationshipLabel: null, callerKind: "external_clinician", dispositionSummaryLay: "Nurse dispatched", visitDispatched: true, visitScheduledFirstLight: false },
  ];
  it("prefers the resolved relationship, else the lay caller kind", () => {
    const view = projectTriageList(calls);
    expect(view.items[0]?.callerLabel).toBe("Daughter");
    expect(view.items[1]?.callerLabel).toBe("Outside clinician");
    expect(view.items[1]?.disposition).toBe("Nurse dispatched");
  });
});

describe("projectBereavementScope (M16)", () => {
  const scopes: BereavedPortalScope[] = [
    { contactId: "c1", planId: "p1", status: "active", inBereavementWindow: true, mayOptOut: true, mayRescindOptOut: false },
  ];
  it("maps the scope rows and lay-labels the status", () => {
    const view = projectBereavementScope(scopes);
    expect(view.items[0]).toMatchObject({ contactId: "c1", planId: "p1", inWindow: true, mayOptOut: true, statusLabel: "Active" });
  });
});

describe("projectCarePlan (M7 + M38)", () => {
  const labeller = async (system: string, code: string | null | undefined, fallback: string) =>
    system === "icd10" && code === "C34.90" ? "Lung cancer" : fallback;
  const elements = {
    patientId: "pat1" as PatientId,
    redacted: false,
    problems: [
      { problemId: "pr1", icd10Code: "C34.90", snomedCode: null, description: "malignant neoplasm" },
      { problemId: "pr2", icd10Code: null, snomedCode: "Z1", description: "uncoded problem" },
    ],
    goals: [{ problemId: "pr1", text: "Comfort" }],
    interventions: [{ problemId: "pr1", scopeText: "Pain management" }],
  };
  it("lay-labels via M38 (fail-open to description) and nests goals/focus under the parent problem", async () => {
    const view = await projectCarePlan(elements, labeller);
    expect(view.redacted).toBe(false);
    expect(view.problems[0]).toMatchObject({ label: "Lung cancer", goals: ["Comfort"], focus: ["Pain management"] });
    expect(view.problems[1]?.label).toBe("uncoded problem"); // fail-open to description
  });
  it("discloses no problems for a redacted plan (D17)", async () => {
    const view = await projectCarePlan({ ...elements, redacted: true }, labeller);
    expect(view.redacted).toBe(true);
    expect(view.problems).toHaveLength(0);
  });
});

describe("projectDashboard (M5) + ageYearsFromDob", () => {
  const asOf = Date.parse("2026-08-02T00:00:00Z");
  const identity: PatientIdentity = {
    id: "pat1",
    organizationId: "org1",
    mrn: "MRN-SECRET",
    externalMrns: [],
    lastName: "Rivera",
    firstName: "Sam",
    dateOfBirth: "1950-01-01",
    administrativeSex: "M",
    ssnLast4: "1234",
  };
  it("computes age and omits MRN/SSN from the view", () => {
    const view = projectDashboard(identity, { upcomingVisits: 2, activeMedications: 3, unreadDocuments: 1 }, asOf);
    expect(view.displayName).toBe("Sam Rivera");
    expect(view.ageYears).toBe(76);
    expect(view.counts).toEqual({ upcomingVisits: 2, activeMedications: 3, unreadDocuments: 1 });
    expect(JSON.stringify(view)).not.toContain("MRN-SECRET");
    expect(JSON.stringify(view)).not.toContain("1234");
  });
  it("returns null age for a future or unparseable dob", () => {
    expect(ageYearsFromDob("2999-01-01", asOf)).toBeNull();
    expect(ageYearsFromDob("not-a-date", asOf)).toBeNull();
  });
});
