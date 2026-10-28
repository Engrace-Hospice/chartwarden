// FY2027 election statement addendum (42 CFR 418.24(b)(6), (c), (d); CMS-1851-F) — pure unit tests: the
// state machine, the (d)(1)/(d)(2) calendar-day clocks and the 2026-10-01 cutoff, item merging, the M7
// consumer's decision, the M36 alert plan, the activation-gate item and the M22 templates' 418.24 elements.
import type { NonCoveredItemSnapshot } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  ELECTION_ADDENDUM_MANDATORY_FROM,
  addendumRequiredForElection,
  applyPrefill,
  composeNonCoveredItemsReaders,
  daysUntilDue,
  draftContentChanged,
  initialAddendumDue,
  mergeSourceItems,
  sourceItemsDiffer,
  updateAddendumDue,
} from "../src/modules/06-admission/election-addendum/index";
import { electionAddendumRequirement } from "../src/modules/06-admission/intake/activation-gate";
import { decideCarePlanAddendum } from "../src/modules/06-admission/outbox-consumers/m7-care-plan-addendum";
import {
  type AddendumContentFacts,
  ELECTION_ADDENDUM_GRAPH,
  exemptionEventFor,
  missingAddendumContent,
  transitionElectionAddendum,
} from "../src/modules/06-admission/state-machines/election-addendum";
import {
  ADDENDUM_ADVOCACY,
  ADDENDUM_PURPOSE,
  ELECTION_ADDENDUM_DOC_TITLE,
  RECEIPT_ONLY,
  RELATEDNESS_STATEMENT,
  buildElectionAddendumDoc,
} from "../src/modules/22-documents/render-pdf/election-addendum-doc";
import {
  ELECTION_TEXT,
  buildElectionStatementDoc,
} from "../src/modules/22-documents/render-pdf/election-statement-doc";
import { planAdmissionComplianceAlerts } from "../src/modules/36-messaging/outbox-consumers/admission-compliance-alerts";

const COMPLETE: AddendumContentFacts = {
  hospiceName: "Example Hospice",
  patientName: "Test Patient",
  medicalRecordNumber: "MRN-0001",
  terminalDiagnosisCount: 1,
  items: [{ category: "condition", description: "Condition A", reasonNotCovered: "Unrelated" }],
  noNonCoveredItems: false,
  clinicalExplanation: "Explained in plain language.",
};

describe("418.24(d) addendum clocks", () => {
  it("applies only to elections effective on or after 2026-10-01", () => {
    expect(ELECTION_ADDENDUM_MANDATORY_FROM).toBe("2026-10-01");
    expect(addendumRequiredForElection("2026-09-30")).toBe(false);
    expect(addendumRequiredForElection("2026-10-01")).toBe(true);
    expect(addendumRequiredForElection("2027-03-15")).toBe(true);
  });

  it("initial: effective date + 5 calendar days, end of that org-local day", () => {
    const due = initialAddendumDue("2026-10-01", "America/New_York");
    expect(due.dueDate).toBe("2026-10-06");
    // 23:59:59.999 EDT (UTC-4) on 2026-10-06
    expect(due.dueAt).toBe("2026-10-07T03:59:59.999Z");
  });

  it("initial: crosses month and year ends by calendar days", () => {
    expect(initialAddendumDue("2026-12-29", "UTC").dueDate).toBe("2027-01-03");
    expect(initialAddendumDue("2026-10-29", "UTC").dueDate).toBe("2026-11-03");
  });

  it("update: the plan-of-care change's org-local date + 3 calendar days", () => {
    // 2026-11-02T03:00Z is still 2026-11-01 in Los Angeles (PDT ended that morning at 09:00Z)
    const due = updateAddendumDue("2026-11-02T03:00:00.000Z", "America/Los_Angeles");
    expect(due.dueDate).toBe("2026-11-04");
    expect(updateAddendumDue("2026-11-02T03:00:00.000Z", "UTC").dueDate).toBe("2026-11-05");
  });

  it("countdown in whole calendar days", () => {
    expect(daysUntilDue("2026-10-06", "2026-10-01")).toBe(5);
    expect(daysUntilDue("2026-10-06", "2026-10-08")).toBe(-2);
  });

  it("rejects a malformed date", () => {
    expect(() => addendumRequiredForElection("10/01/2026")).toThrow();
  });
});

describe("election addendum state machine", () => {
  it("draft → furnished closes the window and emits furnished", () => {
    const t = transitionElectionAddendum("draft", {
      type: "furnish",
      content: COMPLETE,
      method: "paper",
    });
    expect(t).toMatchObject({
      to: "furnished",
      emits: "m6.election_addendum.furnished",
      closesWindow: true,
    });
  });

  it("refuses to furnish an incomplete addendum, naming the missing (c) elements", () => {
    const blank: AddendumContentFacts = {
      hospiceName: null,
      patientName: " ",
      medicalRecordNumber: null,
      terminalDiagnosisCount: 0,
      items: [],
      noNonCoveredItems: false,
      clinicalExplanation: null,
    };
    expect(missingAddendumContent(blank)).toEqual([
      "hospice name (c)(2)",
      "patient name (c)(3)",
      "medical record identifier (c)(3)",
      "terminal diagnosis (c)(4)",
      "non-covered items, or the determination that there are none (c)(5)",
    ]);
    expect(() =>
      transitionElectionAddendum("draft", { type: "furnish", content: blank, method: "paper" }),
    ).toThrow(/missing/);
  });

  it("a 'no non-covered items' determination furnishes without items or explanation", () => {
    const none = { ...COMPLETE, items: [], noNonCoveredItems: true, clinicalExplanation: null };
    expect(missingAddendumContent(none)).toEqual([]);
  });

  it("items and the 'none' determination are mutually exclusive", () => {
    expect(() =>
      transitionElectionAddendum("draft", {
        type: "updateItems",
        content: { ...COMPLETE, noNonCoveredItems: true },
      }),
    ).toThrow(/cannot list/);
  });

  it("a refusal needs a reason; a representative signature needs a name", () => {
    expect(() =>
      transitionElectionAddendum("furnished", { type: "recordRefusal", reason: "no" }),
    ).toThrow(/418.24\(c\)\(9\)/);
    expect(
      transitionElectionAddendum("furnished", {
        type: "recordRefusal",
        reason: "Declined to sign today",
      }).to,
    ).toBe("refused");
    expect(() =>
      transitionElectionAddendum("furnished", {
        type: "recordSignature",
        signerKind: "representative",
        representativeName: "",
      }),
    ).toThrow(/representative/);
    expect(
      transitionElectionAddendum("furnished", {
        type: "recordSignature",
        signerKind: "beneficiary",
        representativeName: null,
      }).to,
    ).toBe("signed");
  });

  it("a furnished version is never edited and settled states are final", () => {
    expect(() =>
      transitionElectionAddendum("furnished", { type: "updateItems", content: COMPLETE }),
    ).toThrow(/cannot updateItems/);
    for (const s of ["signed", "refused", "signature_not_required", "not_required"] as const) {
      expect(ELECTION_ADDENDUM_GRAPH[s]).toEqual([]);
    }
  });

  it("leaving care: draft → not_required ((d)(3)), furnished → signature_not_required ((d)(4))", () => {
    expect(exemptionEventFor("draft", "death")).toEqual({
      type: "markNotRequired",
      reason: "death",
    });
    expect(exemptionEventFor("furnished", "revocation")).toEqual({
      type: "recordSignatureNotRequired",
      reason: "revocation",
    });
    expect(exemptionEventFor("signed", "discharge")).toBeNull();
    expect(
      transitionElectionAddendum("draft", { type: "markNotRequired", reason: "death" }),
    ).toMatchObject({ to: "not_required", closesWindow: true });
  });
});

const snap = (sourceId: string, description = `Condition ${sourceId}`): NonCoveredItemSnapshot => ({
  source: "problem",
  sourceId,
  category: "condition",
  description,
  reason: "Unrelated",
  determinedAt: "2026-10-01T00:00:00.000Z",
  determinedByUserId: null,
});

describe("source item merging", () => {
  it("keeps manual + still-reported (as edited) lines, drops withdrawn ones, appends new", () => {
    const merged = mergeSourceItems(
      [
        { category: "item", description: "Manual line", reasonNotCovered: "x" },
        {
          category: "condition",
          description: "Edited text",
          reasonNotCovered: "y",
          source: "problem",
          sourceId: "p1",
        },
        {
          category: "condition",
          description: "Gone",
          reasonNotCovered: "z",
          source: "problem",
          sourceId: "p2",
        },
      ],
      [snap("p1"), snap("p3")],
    );
    expect(merged.map((m) => m.description)).toEqual([
      "Manual line",
      "Edited text",
      "Condition p3",
    ]);
  });

  it("diffs determinations as a set of (source, id)", () => {
    const version = {
      items: [
        {
          category: "condition" as const,
          description: "a",
          reasonNotCovered: "b",
          source: "problem" as const,
          sourceId: "p1",
        },
      ],
    };
    expect(sourceItemsDiffer(version, [snap("p1", "renamed")])).toBe(false);
    expect(sourceItemsDiffer(version, [snap("p1"), snap("p2")])).toBe(true);
    expect(sourceItemsDiffer(version, [])).toBe(true);
  });

  it("composeNonCoveredItemsReaders merges sources and de-duplicates", async () => {
    const reader = composeNonCoveredItemsReaders([
      { listForAdmission: async () => [snap("p1")] },
      { listForAdmission: async () => [snap("p1"), { ...snap("m1"), source: "medication" }] },
    ]);
    expect((await reader.listForAdmission("o", "a")).map((i) => i.sourceId)).toEqual(["p1", "m1"]);
  });
});

describe("draft refresh is a no-op when the sources add nothing", () => {
  const row = {
    patientName: "Pat Demo",
    medicalRecordNumber: "MRN-1",
    terminalDiagnosis: [{ icd10Code: "C34.90", description: "Lung cancer" }],
    relatedDiagnoses: [],
    items: [
      {
        category: "condition" as const,
        description: "Condition p1",
        reasonNotCovered: "Unrelated",
        source: "problem" as const,
        sourceId: "p1",
        sourceReason: "Unrelated",
      },
    ],
    noNonCoveredItems: false,
  };
  const prefill = {
    patientName: null,
    medicalRecordNumber: null,
    terminalDiagnosis: null,
    relatedDiagnoses: null,
    items: [snap("p1")],
  };

  it("reports no change for a redelivered event (so the row's version is not bumped)", () => {
    expect(draftContentChanged(row, applyPrefill(row, prefill))).toBe(false);
  });

  it("is insensitive to JSON key order in the stored diagnosis lines", () => {
    const reordered = {
      ...row,
      terminalDiagnosis: [{ description: "Lung cancer", icd10Code: "C34.90" }],
    };
    const p = {
      ...prefill,
      terminalDiagnosis: [{ icd10Code: "C34.90", description: "Lung cancer" }],
    };
    expect(draftContentChanged(reordered, applyPrefill(reordered, p))).toBe(false);
  });

  it("reports a change when a new determination is appended", () => {
    const p = { ...prefill, items: [snap("p1"), snap("p2")] };
    expect(draftContentChanged(row, applyPrefill(row, p))).toBe(true);
  });

  it("reports a change when a determination is withdrawn", () => {
    expect(draftContentChanged(row, applyPrefill(row, { ...prefill, items: [] }))).toBe(true);
  });

  it("reports a change when an identity blank is filled", () => {
    const blank = { ...row, patientName: null };
    const p = { ...prefill, patientName: "Pat Demo" };
    expect(draftContentChanged(blank, applyPrefill(blank, p))).toBe(true);
  });
});

describe("M7 plan-of-care consumer decision (418.24(d)(2))", () => {
  it("acts on unrelated problems and relatedness changes only", () => {
    expect(
      decideCarePlanAddendum("m7.problem.added", { admissionId: "a", kind: "unrelated" }),
    ).toEqual({
      kind: "update",
      admissionId: "a",
      requireDiff: false,
    });
    expect(
      decideCarePlanAddendum("m7.problem.added", { admissionId: "a", kind: "related" }).kind,
    ).toBe("skip");
    expect(
      decideCarePlanAddendum("m7.problem.updated", {
        admissionId: "a",
        kind: "related",
        previousKind: "unrelated",
      }).kind,
    ).toBe("update");
    expect(decideCarePlanAddendum("m7.problem.resolved", { kind: "unrelated" }).kind).toBe("skip");
    expect(decideCarePlanAddendum("m7.care_plan.version_signed", { admissionId: "a" })).toEqual({
      kind: "update",
      admissionId: "a",
      requireDiff: true,
    });
  });
});

describe("M36 addendum overdue alerts", () => {
  it("pages the care team and compliance, one deterministic correlation key each", () => {
    const plans = planAdmissionComplianceAlerts({
      eventType: "m6.election_addendum.overdue",
      payload: {
        complianceWindowId: "w1",
        admissionId: "a1",
        patientId: "p1",
        electionAddendumId: "e1",
        windowKind: "election_addendum_initial",
        dueAt: "2026-10-07T03:59:59.999Z",
      },
    });
    expect(plans.map((p) => [p.alertEventType, p.correlationKey])).toEqual([
      ["m6.election_addendum.overdue", "w1:team"],
      ["m6.election_addendum.overdue_compliance", "w1:compliance"],
    ]);
    expect(plans[0]?.safe.deepLink).toBe("/patients/p1/election-certification");
  });

  it("throws on a malformed payload (retry → DLQ, never a dropped alert)", () => {
    expect(() =>
      planAdmissionComplianceAlerts({ eventType: "m6.election_addendum.overdue", payload: {} }),
    ).toThrow(/complianceWindowId/);
  });
});

describe("activation-gate addendum item is informational", () => {
  it("never blocks, whatever its state", () => {
    const states = [
      { activated: false, required: true, latestStatus: null, overdue: false },
      { activated: true, required: true, latestStatus: null, overdue: true },
      { activated: true, required: true, latestStatus: "furnished", overdue: false },
      { activated: true, required: true, latestStatus: "signed", overdue: false },
      { activated: true, required: false, latestStatus: null, overdue: false },
    ];
    const out = states.map((s) => electionAddendumRequirement(s));
    expect(out.map((r) => r?.status)).toEqual([
      "pending",
      "overdue",
      "awaiting_signature",
      "complete",
      "not_applicable",
    ]);
    expect(out.every((r) => r?.blocking === false)).toBe(true);
    expect(electionAddendumRequirement(undefined)).toBeNull();
  });
});

const text = (doc: ReturnType<typeof buildElectionAddendumDoc>) => JSON.stringify(doc.blocks);

describe("M22 election_addendum template carries every 418.24(c) element", () => {
  const payload = {
    title: ELECTION_ADDENDUM_DOC_TITLE,
    patientId: "p1",
    electionAddendumId: "e1",
    versionNumber: 1,
    trigger: "initial",
    hospiceName: "Example Hospice",
    patientName: "Test Patient",
    medicalRecordNumber: "MRN-0001",
    terminalDiagnoses: [{ icd10Code: "C34.90", description: "Lung cancer" }],
    relatedDiagnoses: [{ icd10Code: null, description: "Cachexia" }],
    items: [
      {
        category: "drug",
        description: "Drug X",
        reasonNotCovered: "Treats an unrelated condition",
      },
    ],
    noNonCoveredItems: false,
    clinicalExplanation: "Plain-language explanation.",
    guidelineReferences: "LCD reference",
    furnishedDate: "2026-10-03",
    furnishMethod: "paper",
    acknowledgement: {
      outcome: "pending",
      signedDate: null,
      signerKind: null,
      representativeName: null,
      representativeRelationship: null,
      refusalReason: null,
      exemptionReason: null,
      exemptionNote: null,
    },
  };

  it("title, hospice, patient, MRN, diagnoses, list, explanation, references, purpose, QIO, receipt-only, date furnished", () => {
    const doc = buildElectionAddendumDoc(payload);
    expect(doc.title).toBe(
      "Patient Notification of Hospice Non-Covered Items, Services, and Drugs",
    );
    const t = text(doc);
    for (const needle of [
      "Example Hospice",
      "Test Patient",
      "MRN-0001",
      "Lung cancer (C34.90)",
      "Cachexia",
      "Drug X",
      "Treats an unrelated condition",
      "Plain-language explanation.",
      "LCD reference",
      ADDENDUM_PURPOSE,
      RELATEDNESS_STATEMENT,
      ADDENDUM_ADVOCACY,
      RECEIPT_ONLY,
      "Date furnished",
      "Signature of beneficiary",
    ]) {
      expect(t).toContain(needle.replace(/"/g, '\\"'));
    }
  });

  it("documents a refusal reason and a (d)(4) exemption on the addendum itself", () => {
    const refused = text(
      buildElectionAddendumDoc({
        ...payload,
        acknowledgement: {
          ...payload.acknowledgement,
          outcome: "refused",
          refusalReason: "Wants to discuss with family",
        },
      }),
    );
    expect(refused).toContain("Wants to discuss with family");
    const exempt = text(
      buildElectionAddendumDoc({
        ...payload,
        acknowledgement: {
          ...payload.acknowledgement,
          outcome: "signature_not_required",
          exemptionReason: "death",
        },
      }),
    );
    expect(exempt).toContain("the patient died");
  });

  it("a 'none' determination is stated, not a blank form", () => {
    const t = text(buildElectionAddendumDoc({ ...payload, items: [], noNonCoveredItems: true }));
    expect(t).toContain("all of your conditions, items, services, and drugs are related");
  });
});

describe("M22 election_statement template carries 418.24(b)(1)–(8)", () => {
  it("includes the FY2027 addendum notice, cost sharing, unrelated-services and QIO language", () => {
    const t = JSON.stringify(
      buildElectionStatementDoc({
        patientName: "Test Patient",
        signerKind: "patient",
        signedAt: "2026-10-01",
      }).blocks,
    );
    for (const k of ["b1", "b2", "b3", "b4", "b5", "b6", "b7"] as const) {
      expect(t).toContain(ELECTION_TEXT[k].replace(/"/g, '\\"'));
    }
    expect(ELECTION_TEXT.b3).toContain("exceptional and unusual");
    expect(ELECTION_TEXT.b6).toContain("will receive");
    expect(t).toContain("Date signed");
  });
});
