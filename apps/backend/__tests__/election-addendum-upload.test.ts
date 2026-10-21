// FY2027 election statement addendum — a SCANNED signed paper copy as the 42 CFR 418.24(c)(9) acknowledgement.
// Pure unit tests: the uploaded-acknowledgement planner (draft → signed needs the (c)(10) furnish date; furnished →
// signed; dates never in the future, furnish on/before signature; settled versions refuse) and the shared M22
// document-version check (wrong patient / wrong admission / superseded version all refused).
import type { ActiveDocumentVersionLink } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createDocumentReaderEvidenceValidator } from "../src/modules/06-admission/admission-document-validator";
import {
  type AddendumContentFacts,
  addendumContentGaps,
  planUploadedAcknowledgement,
  transitionElectionAddendum,
} from "../src/modules/06-admission/state-machines/election-addendum";
import {
  buildElectionAddendumDoc,
  scannedCopyRef,
} from "../src/modules/22-documents/render-pdf/election-addendum-doc";

const NOW = new Date("2026-10-10T15:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe("planUploadedAcknowledgement (418.24(c)(9)/(c)(10) on paper)", () => {
  it("a furnished version is acknowledged directly (no furnish date needed)", () => {
    expect(
      planUploadedAcknowledgement({
        status: "furnished",
        acknowledgedAt: day("2026-10-09"),
        furnishedAt: null,
        contentGaps: [],
        now: NOW,
      }),
    ).toEqual({ furnishFirst: false, furnishedAt: null, contentOnPaper: false });
  });

  it("a draft furnished on paper outside WardenX requires the furnish date", () => {
    expect(() =>
      planUploadedAcknowledgement({
        status: "draft",
        acknowledgedAt: day("2026-10-09"),
        furnishedAt: null,
        contentGaps: [],
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_FURNISH_DATE_REQUIRED", statusCode: 422 }));
  });

  it("a draft with a furnish date on or before the signature is furnished first, then signed", () => {
    const plan = planUploadedAcknowledgement({
      status: "draft",
      acknowledgedAt: day("2026-10-09"),
      furnishedAt: day("2026-10-09"),
      contentGaps: [],
      now: NOW,
    });
    expect(plan).toEqual({
      furnishFirst: true,
      furnishedAt: day("2026-10-09"),
      contentOnPaper: false,
    });
  });

  it("refuses a furnish date after the signature date", () => {
    expect(() =>
      planUploadedAcknowledgement({
        status: "draft",
        acknowledgedAt: day("2026-10-08"),
        furnishedAt: day("2026-10-09"),
        contentGaps: [],
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_DATE_INVALID" }));
  });

  it("refuses a signature date in the future", () => {
    expect(() =>
      planUploadedAcknowledgement({
        status: "furnished",
        acknowledgedAt: day("2026-10-11"),
        furnishedAt: null,
        contentGaps: [],
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_DATE_INVALID", statusCode: 422 }));
  });

  it("refuses a future furnish date and an invalid date", () => {
    expect(() =>
      planUploadedAcknowledgement({
        status: "draft",
        acknowledgedAt: day("2026-10-10"),
        furnishedAt: day("2026-10-12"),
        contentGaps: [],
        now: new Date("2026-10-13T00:00:00.000Z"),
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_DATE_INVALID" }));
    expect(() =>
      planUploadedAcknowledgement({
        status: "furnished",
        acknowledgedAt: new Date("not a date"),
        furnishedAt: null,
        contentGaps: [],
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_DATE_INVALID" }));
  });

  it("a settled version cannot take a scanned copy", () => {
    for (const status of ["signed", "refused", "signature_not_required", "not_required"] as const) {
      expect(() =>
        planUploadedAcknowledgement({
          status,
          acknowledgedAt: day("2026-10-09"),
          furnishedAt: day("2026-10-09"),
          contentGaps: [],
          now: NOW,
        }),
      ).toThrow(expect.objectContaining({ code: "ILLEGAL_TRANSITION" }));
    }
  });
});

describe("createDocumentReaderEvidenceValidator (the scanned copy must be this patient's, this admission's)", () => {
  const ARGS = {
    organizationId: "org_a",
    admissionId: "adm_1",
    patientId: "pat_1",
    documentId: "doc_1",
    documentVersionId: "ver_1",
  };
  const validatorFor = (link: ActiveDocumentVersionLink | null) =>
    createDocumentReaderEvidenceValidator(() => ({ activeVersionLink: async () => link }));
  const link = (over: Partial<ActiveDocumentVersionLink> = {}): ActiveDocumentVersionLink =>
    ({
      documentId: "doc_1",
      documentVersionId: "ver_1",
      patientId: "pat_1",
      admissionId: "adm_1",
      ...over,
    }) as ActiveDocumentVersionLink;

  it("accepts the active version linked to the same patient and admission", async () => {
    await expect(
      validatorFor(link()).validateAdmissionEvidenceDocumentVersion(ARGS),
    ).resolves.toBeUndefined();
  });

  it("rejects a document of another patient", async () => {
    await expect(
      validatorFor(link({ patientId: "pat_2" as never })).validateAdmissionEvidenceDocumentVersion(
        ARGS,
      ),
    ).rejects.toMatchObject({ code: "ADMISSION_EVIDENCE_DOCUMENT_MISMATCH", statusCode: 400 });
  });

  it("rejects a document of another admission of the same patient", async () => {
    await expect(
      validatorFor(
        link({ admissionId: "adm_2" as never }),
      ).validateAdmissionEvidenceDocumentVersion(ARGS),
    ).rejects.toMatchObject({ code: "ADMISSION_EVIDENCE_DOCUMENT_MISMATCH" });
  });

  it("rejects an invisible (other org) or superseded version", async () => {
    await expect(
      validatorFor(null).validateAdmissionEvidenceDocumentVersion(ARGS),
    ).rejects.toMatchObject({ code: "DOCUMENT_VERSION_UNAVAILABLE", statusCode: 400 });
  });
});

const INCOMPLETE: AddendumContentFacts = {
  hospiceName: "Example Hospice",
  patientName: null,
  medicalRecordNumber: null,
  terminalDiagnosisCount: 0,
  items: [{ category: "drug", description: "", reasonNotCovered: "" }],
  noNonCoveredItems: false,
  clinicalExplanation: null,
};

describe("content on paper (an incomplete draft signed on paper)", () => {
  it("names every gap, including blank item lines", () => {
    expect(addendumContentGaps(INCOMPLETE)).toEqual([
      "patient name (c)(3)",
      "medical record identifier (c)(3)",
      "terminal diagnosis (c)(4)",
      "clinical explanation (c)(6)",
      "item 1 description and reason (c)(5)",
    ]);
  });

  it("the upload plan marks an incomplete draft's content as on paper (no ADDENDUM_INCOMPLETE)", () => {
    const plan = planUploadedAcknowledgement({
      status: "draft",
      acknowledgedAt: day("2026-10-09"),
      furnishedAt: day("2026-10-08"),
      contentGaps: addendumContentGaps(INCOMPLETE),
      now: NOW,
    });
    expect(plan).toMatchObject({ furnishFirst: true, contentOnPaper: true });
  });

  it("furnish with contentOnPaper skips the completeness check; the keyed furnish keeps it", () => {
    expect(
      transitionElectionAddendum("draft", {
        type: "furnish",
        content: INCOMPLETE,
        method: "paper",
        contentOnPaper: true,
      }),
    ).toMatchObject({
      to: "furnished",
      emits: "m6.election_addendum.furnished",
      closesWindow: true,
    });
    expect(() =>
      transitionElectionAddendum("draft", {
        type: "furnish",
        content: INCOMPLETE,
        method: "paper",
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_INCOMPLETE" }));
    expect(() =>
      transitionElectionAddendum("draft", {
        type: "furnish",
        content: { ...INCOMPLETE, noNonCoveredItems: true },
        method: "paper",
        contentOnPaper: true,
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_ITEMS_CONFLICT" }));
  });
});

describe("M22 election_addendum render — scanned paper copies", () => {
  const SCAN = { documentId: "3f2a91c4-0000-4000-8000-000000000001", filedDate: "2026-10-09" };
  const base = {
    title: "Patient Notification of Hospice Non-Covered Items, Services, and Drugs",
    versionNumber: 1,
    trigger: "initial",
    hospiceName: "Example Hospice",
    patientName: "Test Patient",
    medicalRecordNumber: "MRN-1",
    terminalDiagnoses: [{ icd10Code: "C34.90", description: "Lung cancer" }],
    relatedDiagnoses: [],
    items: [],
    noNonCoveredItems: true,
    clinicalExplanation: null,
    guidelineReferences: null,
    furnishedDate: "2026-10-08",
    furnishMethod: "paper",
    contentSource: "structured",
    scannedCopy: SCAN,
  };
  const text = (payload: unknown) => JSON.stringify(buildElectionAddendumDoc(payload).blocks);

  it("a signature acknowledged on a scanned copy says so, with the filing date and document reference", () => {
    const out = text({
      ...base,
      acknowledgement: {
        source: "uploaded",
        outcome: "signed",
        signedDate: "2026-10-09",
        signerKind: "beneficiary",
      },
    });
    expect(scannedCopyRef(SCAN.documentId)).toBe("3f2a91c4");
    expect(out).toContain(
      "Acknowledged on a signed paper copy, scanned and filed 2026-10-09 (document 3f2a91c4).",
    );
  });

  it("a refusal documented on paper says so; a keyed signature does not mention paper", () => {
    expect(
      text({
        ...base,
        acknowledgement: { source: "uploaded", outcome: "refused", refusalReason: "Declined." },
      }),
    ).toContain("The refusal is documented on the paper copy, scanned and filed 2026-10-09");
    expect(
      text({
        ...base,
        scannedCopy: null,
        acknowledgement: { source: "structured", outcome: "signed", signedDate: "2026-10-09" },
      }),
    ).not.toContain("paper copy, scanned");
  });

  it("content on paper renders a record notice, never the empty (c)(4)–(8) sections", () => {
    const out = text({
      ...base,
      contentSource: "scanned_paper",
      noNonCoveredItems: false,
      terminalDiagnoses: [],
      acknowledgement: { source: "uploaded", outcome: "signed", signedDate: "2026-10-09" },
    });
    expect(out).toContain("content on the signed paper copy");
    expect(out).toContain("The authoritative content of this addendum");
    expect(out).toContain("(document 3f2a91c4)");
    // No determination is invented from an empty list.
    expect(out).not.toContain("The hospice will cover them");
    expect(out).not.toContain("Your terminal illness and related conditions");
    expect(out).toContain("Acknowledgement of receipt");
  });
});
