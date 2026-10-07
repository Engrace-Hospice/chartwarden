// FY2027 election statement addendum — a SCANNED signed paper copy as the 42 CFR 418.24(c)(9) acknowledgement.
// Pure unit tests: the uploaded-acknowledgement planner (draft → signed needs the (c)(10) furnish date; furnished →
// signed; dates never in the future, furnish on/before signature; settled versions refuse) and the shared M22
// document-version check (wrong patient / wrong admission / superseded version all refused).
import type { ActiveDocumentVersionLink } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { createDocumentReaderEvidenceValidator } from "../src/modules/06-admission/admission-document-validator";
import { planUploadedAcknowledgement } from "../src/modules/06-admission/state-machines/election-addendum";

const NOW = new Date("2026-10-10T15:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe("planUploadedAcknowledgement (418.24(c)(9)/(c)(10) on paper)", () => {
  it("a furnished version is acknowledged directly (no furnish date needed)", () => {
    expect(
      planUploadedAcknowledgement({
        status: "furnished",
        acknowledgedAt: day("2026-10-09"),
        furnishedAt: null,
        now: NOW,
      }),
    ).toEqual({ furnishFirst: false, furnishedAt: null });
  });

  it("a draft furnished on paper outside WardenX requires the furnish date", () => {
    expect(() =>
      planUploadedAcknowledgement({
        status: "draft",
        acknowledgedAt: day("2026-10-09"),
        furnishedAt: null,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_FURNISH_DATE_REQUIRED", statusCode: 422 }));
  });

  it("a draft with a furnish date on or before the signature is furnished first, then signed", () => {
    const plan = planUploadedAcknowledgement({
      status: "draft",
      acknowledgedAt: day("2026-10-09"),
      furnishedAt: day("2026-10-09"),
      now: NOW,
    });
    expect(plan).toEqual({ furnishFirst: true, furnishedAt: day("2026-10-09") });
  });

  it("refuses a furnish date after the signature date", () => {
    expect(() =>
      planUploadedAcknowledgement({
        status: "draft",
        acknowledgedAt: day("2026-10-08"),
        furnishedAt: day("2026-10-09"),
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
        now: new Date("2026-10-13T00:00:00.000Z"),
      }),
    ).toThrow(expect.objectContaining({ code: "ADDENDUM_DATE_INVALID" }));
    expect(() =>
      planUploadedAcknowledgement({
        status: "furnished",
        acknowledgedAt: new Date("not a date"),
        furnishedAt: null,
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
