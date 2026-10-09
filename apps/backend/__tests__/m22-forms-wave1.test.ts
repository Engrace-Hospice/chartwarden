// GAP-033 Wave 1 - the CMS-required forms (CTI, F2F, NOR, revocation, discharge, transfer, ABN) drawn from typed
// payloads. Proves: every forms-registry required field is actually drawn (closes D16's string-only gap),
// the regulatory elements appear verbatim, a missing required signature or patient identity fails closed,
// PHI stays out of file metadata and the visible footer, unknown payload keys are never drawn, Part 2 is
// handled, and long documents paginate with the signature kept together.
import { findFormTemplate } from "@wardenx/forms";
import { RenderPayloadError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { ABN_PRESCRIBED_TEXT } from "../src/modules/22-documents/render-pdf/forms";
import { COMPILED_FORMS, providedFieldIds } from "../src/modules/22-documents/render-pdf/forms";
import { CTI_TEXT } from "../src/modules/22-documents/render-pdf/forms/cti-form";
import { F2F_TEXT } from "../src/modules/22-documents/render-pdf/forms/f2f-form";
import { NOR_TEXT } from "../src/modules/22-documents/render-pdf/forms/nor-form";
import { REVOCATION_TEXT } from "../src/modules/22-documents/render-pdf/forms/revocation-form";
import { layoutDocument, pageTexts } from "../src/modules/22-documents/render-pdf/layout";
import { renderDocModelToPdf } from "../src/modules/22-documents/render-pdf/pdf-writer";
import { PART2_REDISCLOSURE_NOTICE } from "../src/modules/22-documents/render-pdf/shared";
import {
  CTI,
  DISCHARGE,
  F2F,
  FORM_FIXTURES,
  LONG_NARRATIVE,
  NOR,
  PATIENT,
  REVOCATION,
  SENTINEL_MRN,
  SENTINEL_NAME,
  TRANSFER,
  sig,
} from "./_m22-form-fixtures";

const textOf = (doc: Parameters<typeof layoutDocument>[0]): string =>
  pageTexts(layoutDocument(doc)).flat().join("\n");
const flat = (s: string): string => s.replace(/\s+/g, " ");

describe("every registry required field is drawn by its form (D16)", () => {
  const keys = Object.keys(FORM_FIXTURES) as Array<keyof typeof FORM_FIXTURES>;
  it.each(keys)("%s provides all forms-registry requiredFields", (key) => {
    const descriptor = findFormTemplate(key);
    if (descriptor === undefined) return; // renderer-only key (the transfer summary has no registry row)
    const provided = new Set(providedFieldIds(COMPILED_FORMS[key].spec as never));
    const missing = descriptor.requiredFields.filter((f) => !provided.has(f));
    expect(missing).toEqual([]);
  });

  it("abn provides its registry required fields", () => {
    const descriptor = findFormTemplate("abn");
    const provided = new Set(providedFieldIds(COMPILED_FORMS.abn.spec as never));
    expect(descriptor?.requiredFields.filter((f) => !provided.has(f))).toEqual([]);
  });
});

describe("regulatory elements appear verbatim", () => {
  it("CTI: prognosis statement, supporting-documentation pointer, narrative and signature, narrative LAST", () => {
    const text = flat(textOf(COMPILED_FORMS.cti(CTI)));
    expect(text).toContain(flat(CTI_TEXT.prognosis));
    expect(text).toContain(flat(CTI_TEXT.supporting));
    expect(text).toContain(CTI.narrative);
    expect(text).toContain("Electronically signed by Dr. Imani Okafor, MD (NPI 1234567893)");
    // 418.22(b)(3): the narrative sits immediately above the physician's signature.
    expect(text.indexOf(CTI.narrative)).toBeLessThan(
      text.indexOf("Hospice physician or medical director"),
    );
    expect(text.indexOf(CTI_TEXT.prognosis.slice(0, 30))).toBeLessThan(text.indexOf(CTI.narrative));
    expect(text).toContain("Period 3 (recertification)");
    expect(text).toContain("C34.90");
  });

  it("CTI: a late signature is stated with its reason", () => {
    const text = textOf(
      COMPILED_FORMS.cti({ ...CTI, signedLate: true, lateReason: "Physician unavailable" }),
    );
    expect(text).toContain("Signed after the certification period began");
    expect(text).toContain("Physician unavailable");
  });

  it("F2F: attestation, NP findings-provided statement (418.22(b)(4)), date and signature", () => {
    const text = flat(textOf(COMPILED_FORMS.f2f(F2F)));
    expect(text).toContain(flat(F2F_TEXT.attestation));
    expect(text).toContain(flat(F2F_TEXT.findingsProvided));
    expect(text).toContain("2026-09-12");
    expect(text).toContain("Hospice nurse practitioner");
    const physician = flat(textOf(COMPILED_FORMS.f2f({ ...F2F, performerRole: "hospice_md" })));
    expect(physician).not.toContain(flat(F2F_TEXT.findingsProvided));
  });

  it("F2F: a linked clinical note is the attestation source when no narrative was written", () => {
    const text = textOf(
      COMPILED_FORMS.f2f({
        ...F2F,
        attestationNarrative: null,
        linkedNoteEncounterId: "note-1234567890",
      }),
    );
    expect(text).toContain("clinical note note-123");
  });

  it("F2F: telehealth eligibility is stated when recorded", () => {
    const text = textOf(
      COMPILED_FORMS.f2f({
        ...F2F,
        encounterLocation: "telehealth",
        telehealthEligibility: {
          patientInMoratoriumArea: false,
          hospiceUnderEnhancedOversight: false,
          performerMedicareEnrolledOrOptedOut: true,
        },
      }),
    );
    expect(text).toContain("Telehealth eligibility");
    expect(text).toContain("Performer enrolled in Medicare or opted out: yes");
  });

  it("NOR: rights text, acknowledgment, representative capacity and witness", () => {
    const text = flat(textOf(COMPILED_FORMS.nor(NOR)));
    expect(text).toContain(flat(NOR_TEXT.rights));
    expect(text).toContain("Patient's representative");
    expect(text).toContain("Authorized representative of the patient");
    expect(text).toContain("Record of scan");
    expect(text).toContain("Pat Witness");
  });

  it("revocation: statement, effective date, reason and signature", () => {
    const text = flat(textOf(COMPILED_FORMS.revocation(REVOCATION)));
    expect(text).toContain(flat(REVOCATION_TEXT.statement));
    expect(text).toContain("2026-10-05");
    expect(text).toContain("Seek Curative Treatment");
  });

  it("discharge: date, reason, order, filer and cosign; pending cosign is watermarked and bannered", () => {
    const done = COMPILED_FORMS.discharge_summary(DISCHARGE);
    const text = textOf(done);
    expect(text).toContain("2026-10-06");
    expect(text).toContain("For Cause");
    expect(text).toContain("ORD-17");
    expect(text).toContain("Medical-director cosign");
    expect(done.watermark).toBeUndefined();
    const pending = COMPILED_FORMS.discharge_summary({
      ...DISCHARGE,
      status: "pending_cosign",
      cosign: { required: true, completed: false, signature: null },
    });
    expect(pending.watermark?.text).toBe("PENDING COSIGN");
    expect(textOf(pending)).toContain("awaiting medical-director cosign");
    const voided = COMPILED_FORMS.discharge_summary({ ...DISCHARGE, status: "voided" });
    expect(voided.watermark?.text).toBe("VOID");
  });

  it("transfer summary: direction, other hospice and period", () => {
    const text = textOf(COMPILED_FORMS.discharge_summary_transfer(TRANSFER));
    expect(text).toContain("Transfer out to another hospice");
    expect(text).toContain("Lakeside Hospice");
    expect(text).toContain("Period 2");
  });
});

describe("fail closed on the two integrity fields", () => {
  it("CTI without the hospice physician's signature record throws", () => {
    const bad = { ...CTI, hospiceMdSignature: undefined };
    expect(() => COMPILED_FORMS.cti(bad)).toThrow(RenderPayloadError);
  });

  it("CTI with a blank printed name or an invalid date throws", () => {
    expect(() =>
      COMPILED_FORMS.cti({ ...CTI, hospiceMdSignature: sig({ printedName: "" }) }),
    ).toThrow(RenderPayloadError);
    expect(() =>
      COMPILED_FORMS.cti({ ...CTI, hospiceMdSignature: sig({ signedAt: "not-a-date" }) }),
    ).toThrow(/valid date/);
  });

  it("CTI with no narrative is not a certification", () => {
    expect(() => COMPILED_FORMS.cti({ ...CTI, narrative: "" })).toThrow(RenderPayloadError);
  });

  it("every signing form refuses an id-only legacy payload (no typed content to draw)", () => {
    for (const key of ["cti", "f2f", "nor", "revocation"] as const) {
      expect(() => COMPILED_FORMS[key]({ aggregateId: "x", patientId: "p" })).toThrow(
        RenderPayloadError,
      );
    }
  });

  it("a payload with a blank patient name or MRN throws on every form", () => {
    for (const [key, payload] of Object.entries(FORM_FIXTURES)) {
      const form = COMPILED_FORMS[key as keyof typeof FORM_FIXTURES] as (p: unknown) => unknown;
      expect(() => form({ ...payload, patient: { ...PATIENT, name: "" } })).toThrow(
        RenderPayloadError,
      );
      expect(() => form({ ...payload, patient: { ...PATIENT, mrn: "" } })).toThrow(
        RenderPayloadError,
      );
    }
  });

  it("a cosigned discharge without the cosigner's signature throws; a pending one does not need it", () => {
    expect(() =>
      COMPILED_FORMS.discharge_summary({
        ...DISCHARGE,
        cosign: { required: true, completed: true, signature: null },
      }),
    ).toThrow(RenderPayloadError);
    expect(() =>
      COMPILED_FORMS.discharge_summary({
        ...DISCHARGE,
        status: "pending_cosign",
        cosign: { required: true, completed: false, signature: null },
      }),
    ).not.toThrow();
  });

  it("an optional signer's absence is simply not drawn", () => {
    const text = textOf(COMPILED_FORMS.cti({ ...CTI, attendingSignature: null }));
    expect(text).not.toContain("Attending physician");
    const both = textOf(
      COMPILED_FORMS.cti({
        ...CTI,
        attendingSignature: sig({ role: "Attending", printedName: "Dr. Attending" }),
      }),
    );
    expect(both).toContain("Dr. Attending");
  });
});

describe("PHI canary: sentinels live only in the page content", () => {
  const info = (raw: string): string => /5 0 obj\n([\s\S]*?)\nendobj/.exec(raw)?.[1] ?? "";
  const keys = Object.keys(FORM_FIXTURES) as Array<keyof typeof FORM_FIXTURES>;

  it.each(keys)("%s: absent from /Info and /Title, present on page content", (key) => {
    const doc = COMPILED_FORMS[key](FORM_FIXTURES[key]);
    const raw = Buffer.from(renderDocModelToPdf(doc)).toString("latin1");
    expect(info(raw)).not.toContain(SENTINEL_NAME);
    expect(info(raw)).not.toContain(SENTINEL_MRN);
    expect(doc.title).not.toContain(SENTINEL_NAME);
    const pages = pageTexts(layoutDocument(doc));
    expect(pages.flat().join("\n")).toContain(SENTINEL_NAME);
    // The visible footer is "<title> - Confidential ..." on every page: it must carry the constant title only.
    const footers =
      raw.match(/\([^)]*Confidential: contains protected health information\)/g) ?? [];
    expect(footers.length).toBeGreaterThan(0);
    for (const f of footers) expect(f).not.toContain(SENTINEL_NAME);
  });

  it("unknown payload keys are never drawn (allow-list, not dump)", () => {
    const text = textOf(
      COMPILED_FORMS.cti({
        ...CTI,
        internalNote: "SECRET-PLUMBING-KEY-VALUE",
        ssn: "123-45-6789",
      } as never),
    );
    expect(text).not.toContain("SECRET-PLUMBING-KEY-VALUE");
    expect(text).not.toContain("123-45-6789");
  });

  it("the running header identifies the patient on pages 2..N", () => {
    const doc = COMPILED_FORMS.cti({ ...CTI, narrative: LONG_NARRATIVE });
    expect(doc.runningHeader).toContain(SENTINEL_NAME);
    const raw = Buffer.from(renderDocModelToPdf(doc)).toString("latin1");
    const pages = raw.split("/Type /Page /Parent").slice(1);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages.slice(1)) expect(page).toContain(`${SENTINEL_NAME} - MRN`);
  });
});

describe("42 CFR Part 2", () => {
  it("adds the 2.32 redisclosure notice when Part 2 content is present (sudRedacted = consent present)", () => {
    const withNotice = textOf(COMPILED_FORMS.cti({ ...CTI, sudRedacted: true } as never));
    expect(flat(withNotice)).toContain(flat(PART2_REDISCLOSURE_NOTICE));
    expect(flat(textOf(COMPILED_FORMS.cti(CTI)))).not.toContain("42 CFR Part 2:");
  });

  it("prints the withheld marker for diagnoses the producer withheld, never the code", () => {
    const text = textOf(COMPILED_FORMS.cti({ ...CTI, part2WithheldCount: 1 }));
    expect(text).toContain("Withheld");
    expect(text).not.toContain("F10");
  });
});

describe("pagination", () => {
  it("a long narrative runs to 3+ pages and the signature group stays together after it", () => {
    const doc = COMPILED_FORMS.cti({ ...CTI, narrative: `${LONG_NARRATIVE} ${LONG_NARRATIVE}` });
    const pages = pageTexts(layoutDocument(doc));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const sigPage = pages.findIndex((p) => p.includes("Hospice physician or medical director"));
    expect(sigPage).toBeGreaterThanOrEqual(0);
    // the signature page opens with the narrative's closing lines (never a signature stranded alone)
    expect(pages[sigPage]?.[0]).not.toBe("Hospice physician or medical director");
    expect(sigPage).toBeGreaterThan(0);
    expect(pages[sigPage]?.some((l) => l.includes("Meaning of signature"))).toBe(true);
  });

  it("Page N of M is correct", () => {
    const doc = COMPILED_FORMS.cti({ ...CTI, narrative: LONG_NARRATIVE });
    const raw = Buffer.from(renderDocModelToPdf(doc)).toString("latin1");
    const total = pageTexts(layoutDocument(doc)).length;
    expect(raw).toContain(`(Page ${total} of ${total})`);
  });
});

describe("glyph degradation on a compliance form is disclosed", () => {
  it("a non-Latin patient name draws '?' and the page says so", () => {
    const doc = COMPILED_FORMS.cti({ ...CTI, patient: { ...PATIENT, name: "王小明 Wang" } });
    expect(Buffer.from(renderDocModelToPdf(doc)).toString("latin1")).toContain(
      "Some characters could not be displayed",
    );
  });
});

describe("ABN ships structure only until compliance supplies the CMS wording (R2)", () => {
  const abnPayload = {
    abnId: "abn-1",
    patientId: "p-1",
    serviceDescription: "Wound care supplies beyond the plan of care",
    estimatedCost: 12550,
    reasonNoncovered: "Not reasonable and necessary for the terminal illness",
    requiredBy: "2026-10-09T00:00:00.000Z",
  };

  it("while the prescribed text is not installed the document is a watermarked DRAFT with placeholders", () => {
    expect(ABN_PRESCRIBED_TEXT).toBeNull();
    const doc = COMPILED_FORMS.abn(abnPayload);
    expect(doc.watermark?.text).toBe("DRAFT");
    const text = textOf(doc);
    expect(flat(text)).toContain("Do not deliver this document to a beneficiary");
    expect(text).toContain(
      "[Option 1 - CMS-prescribed CMS-R-131 wording not yet supplied by compliance]",
    );
  });

  it("draws the service, reason, estimated cost, three unchecked options and a blank signature line", () => {
    const doc = COMPILED_FORMS.abn(abnPayload);
    const text = textOf(doc);
    expect(text).toContain("Wound care supplies beyond the plan of care");
    expect(text).toContain("$125.50");
    const options = doc.blocks.find((b) => b.kind === "options");
    expect(options?.kind === "options" && options.items.every((i) => !i.selected)).toBe(true);
    expect(options?.kind === "options" && options.items).toHaveLength(3);
    expect(text).toContain("Beneficiary signature");
  });

  it("an ABN renders even with no patient name (the beneficiary completes it by hand)", () => {
    expect(() => COMPILED_FORMS.abn({ abnId: "abn-2" })).not.toThrow();
  });
});

describe("determinism", () => {
  it("the same payload yields identical bytes", () => {
    const a = renderDocModelToPdf(COMPILED_FORMS.cti(CTI));
    const b = renderDocModelToPdf(COMPILED_FORMS.cti(structuredClone(CTI)));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
