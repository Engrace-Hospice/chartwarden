// GAP-033 Waves 2 and 3 - the signed order documents (order_record, medication_order) and the billing
// correspondence (NOE / NOTR receipts, Medicare and Medicaid claim acknowledgments, denial-appeal cover and
// denial-resolution letters) drawn from typed payloads. Proves: the fixed statements and every field the payload
// carries are drawn, a signature / patient identity / control number that is missing fails closed, PHI stays out
// of file metadata and the visible footer, unknown keys are never drawn, Part 2 is handled, and the billing
// letters carry no patient identity.
import { findFormTemplate } from "@chartwarden/forms";
import { RenderPayloadError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { COMPILED_FORMS, providedFieldIds } from "../src/modules/22-documents/render-pdf/forms";
import { BILLING_TEXT } from "../src/modules/22-documents/render-pdf/forms/billing-forms";
import { MEDICATION_ORDER_TEXT } from "../src/modules/22-documents/render-pdf/forms/medication-order-form";
import { ORDER_RECORD_TEXT } from "../src/modules/22-documents/render-pdf/forms/order-record-form";
import { layoutDocument, pageTexts } from "../src/modules/22-documents/render-pdf/layout";
import { renderDocModelToPdf } from "../src/modules/22-documents/render-pdf/pdf-writer";
import { PART2_REDISCLOSURE_NOTICE } from "../src/modules/22-documents/render-pdf/shared";
import {
  BILLING_FIXTURES,
  CLAIM_ACK,
  DENIAL_COVER,
  DENIAL_RESOLUTION,
  MEDICAID_CLAIM_ACK,
  MEDICATION_ORDER,
  NOE_RECEIPT,
  NOTR_RECEIPT,
  ORDER_RECORD,
  PATIENT,
  SENTINEL_MRN,
  SENTINEL_NAME,
  sig,
} from "./_m22-form-fixtures";

const textOf = (doc: Parameters<typeof layoutDocument>[0]): string =>
  pageTexts(layoutDocument(doc)).flat().join("\n");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const orderKeys = ["order_record", "medication_order"] as const;
const billingKeys = Object.keys(BILLING_FIXTURES) as Array<keyof typeof BILLING_FIXTURES>;

describe("registry required fields are drawn (D16)", () => {
  it.each(orderKeys)("%s provides all forms-registry requiredFields", (key) => {
    const descriptor = findFormTemplate(key);
    expect(descriptor).toBeDefined();
    const provided = new Set(providedFieldIds(COMPILED_FORMS[key].spec as never));
    expect(descriptor?.requiredFields.filter((f) => !provided.has(f))).toEqual([]);
  });
});

describe("order_record", () => {
  it("draws the order type, priority, indication, ordering physician, details and the signature", () => {
    const text = flat(textOf(COMPILED_FORMS.order_record(ORDER_RECORD)));
    expect(text).toContain("Lab");
    expect(text).toContain("Urgent");
    expect(text).toContain("Rising creatinine");
    expect(text).toContain("Dr. Imani Okafor, MD (NPI 1234567893)");
    expect(text).toContain("Creatinine (LOINC 2160-0); Potassium (LOINC 2823-3)");
    expect(text).toContain("Written order");
    expect(text).toContain("Electronically signed by Dr. Imani Okafor");
    expect(text).toContain("Meaning of signature: Order Authorization");
  });

  it("states a verbal order, a correction, a standing-order source and a pending cosign", () => {
    const text = flat(
      textOf(
        COMPILED_FORMS.order_record({
          ...ORDER_RECORD,
          viaVerbal: true,
          replacesOrderId: "abcdef12-0000-4000-8000-000000000000",
          fromStandingOrder: true,
          cosign: { required: true, status: "pending" },
        }),
      ),
    );
    expect(text).toContain(flat(ORDER_RECORD_TEXT.verbal));
    expect(text).toContain("Verbal order");
    expect(text).toContain("Corrects order");
    expect(text).toContain("abcdef12");
    expect(text).toContain("Standing order");
    expect(text).toContain(flat(ORDER_RECORD_TEXT.cosign));
    expect(text).toContain("Status: Pending");
  });

  it("a kind with no published field contract says so instead of inventing details", () => {
    const note = "No reviewed field contract is published for this order kind.";
    const text = flat(
      textOf(
        COMPILED_FORMS.order_record({
          ...ORDER_RECORD,
          kind: "ancillary_service",
          kindVersion: "ancillary_service.v1",
          details: [],
          detailsNote: note,
        }),
      ),
    );
    expect(text).toContain(note);
  });

  it("an inherited standing-order signature prints its capacity", () => {
    const text = flat(
      textOf(
        COMPILED_FORMS.order_record({
          ...ORDER_RECORD,
          signature: sig({
            capacity: "Standing order authorization",
            meaning: "order_authorization",
          }),
        }),
      ),
    );
    expect(text).toContain("(Standing order authorization)");
  });
});

describe("medication_order", () => {
  it("draws the drug, directions, dispense, DEA schedule, coverage and prescriber signature", () => {
    const text = flat(textOf(COMPILED_FORMS.medication_order(MEDICATION_ORDER)));
    expect(text).toContain("Morphine sulfate oral solution");
    expect(text).toContain("20 mg/mL");
    expect(text).toContain("5 mg");
    expect(text).toContain("q4h");
    expect(text).toContain("30 days");
    expect(text).toContain("Yes - dyspnea");
    expect(text).toContain("Give 5 mg by mouth every 4 hours");
    expect(text).toContain("30 mL");
    expect(text).toContain("DEA schedule");
    expect(text).toContain("II");
    expect(text).toContain("Covered - related to the terminal illness");
    expect(text).toContain("Dr. Imani Okafor, MD (NPI 1234567893)");
    expect(text).toContain("Electronically signed by Dr. Imani Okafor");
  });

  it("never draws a prescriber DEA number, even when one is smuggled into the payload", () => {
    const text = textOf(
      COMPILED_FORMS.medication_order({ ...MEDICATION_ORDER, prescriberDea: "AB1234563" } as never),
    );
    expect(text).not.toContain("AB1234563");
  });

  it("draws a compounded formulation and a documented allergy override", () => {
    const text = flat(
      textOf(
        COMPILED_FORMS.medication_order({
          ...MEDICATION_ORDER,
          medClass: "compounded",
          deaSchedule: null,
          compounded: {
            formulationDescription:
              "Haloperidol, lorazepam and diphenhydramine gel for topical use.",
            containsControlled: true,
            components: [
              { name: "Haloperidol", strength: "2 mg/mL", quantityRatio: "1:1" },
              { name: "Lorazepam", strength: "2 mg/mL", quantityRatio: "1:1" },
            ],
          },
          allergyOverride: {
            reason: "Tolerated this drug class previously without reaction.",
            acknowledgedAt: "2026-09-30T13:50:00.000Z",
            matchedClasses: ["benzodiazepine"],
          },
        }),
      ),
    );
    expect(text).toContain("Compounded formulation");
    expect(text).toContain("Lorazepam");
    expect(text).toContain("contains a controlled substance");
    expect(text).toContain(flat(MEDICATION_ORDER_TEXT.allergyOverride));
    expect(text).toContain("Tolerated this drug class previously");
    expect(text).toContain("benzodiazepine");
  });

  it("states a verbal order, a cosign and a non-covered determination with its clinical reason", () => {
    const text = flat(
      textOf(
        COMPILED_FORMS.medication_order({
          ...MEDICATION_ORDER,
          viaVerbal: true,
          cosign: { required: true, status: "attached" },
          coverage: {
            status: "not_covered_unrelated",
            reason: "Treats a condition unrelated to the terminal illness.",
          },
        }),
      ),
    );
    expect(text).toContain(flat(MEDICATION_ORDER_TEXT.verbal));
    expect(text).toContain(flat(MEDICATION_ORDER_TEXT.cosign));
    expect(text).toContain("Not Covered Unrelated");
    expect(text).toContain("Treats a condition unrelated to the terminal illness.");
  });

  it("the appended transmission version states when the prescription reached the pharmacy", () => {
    const text = flat(
      textOf(
        COMPILED_FORMS.medication_order({
          ...MEDICATION_ORDER,
          transmission: {
            transmittedAt: "2026-09-30T16:20:00.000Z",
            prescriptionRef: "9f8e7d6c-0000-4000-8000-000000000000",
          },
        }),
      ),
    );
    expect(text).toContain("Transmission to pharmacy");
    expect(text).toContain("2026-09-30 16:20 UTC");
    expect(text).toContain("9f8e7d6c");
    expect(flat(textOf(COMPILED_FORMS.medication_order(MEDICATION_ORDER)))).not.toContain(
      "Transmission to pharmacy",
    );
  });

  it("a SUD-treatment drug prints the 42 CFR 2.32 notice exactly once, flagged or not", () => {
    const unflagged = flat(
      textOf(COMPILED_FORMS.medication_order({ ...MEDICATION_ORDER, isSudTreatment: true })),
    );
    const flagged = flat(
      textOf(
        COMPILED_FORMS.medication_order({
          ...MEDICATION_ORDER,
          isSudTreatment: true,
          sudRedacted: true,
        } as never),
      ),
    );
    const notice = flat(PART2_REDISCLOSURE_NOTICE);
    expect(unflagged.split(notice)).toHaveLength(2);
    expect(flagged.split(notice)).toHaveLength(2);
    expect(flat(textOf(COMPILED_FORMS.medication_order(MEDICATION_ORDER)))).not.toContain(notice);
  });
});

describe("fail closed", () => {
  it.each(orderKeys)("%s without a signature record throws", (key) => {
    const payload = key === "order_record" ? ORDER_RECORD : MEDICATION_ORDER;
    expect(() => COMPILED_FORMS[key]({ ...payload, signature: undefined })).toThrow(
      RenderPayloadError,
    );
    expect(() => COMPILED_FORMS[key]({ ...payload, signature: sig({ printedName: "" }) })).toThrow(
      RenderPayloadError,
    );
    expect(() =>
      COMPILED_FORMS[key]({ ...payload, signature: sig({ signedAt: "never" }) }),
    ).toThrow(/valid date/);
  });

  it.each(orderKeys)("%s with a blank patient name or MRN throws", (key) => {
    const payload = key === "order_record" ? ORDER_RECORD : MEDICATION_ORDER;
    expect(() => COMPILED_FORMS[key]({ ...payload, patient: { ...PATIENT, name: "" } })).toThrow(
      RenderPayloadError,
    );
    expect(() => COMPILED_FORMS[key]({ ...payload, patient: { ...PATIENT, mrn: "" } })).toThrow(
      RenderPayloadError,
    );
  });

  it.each(orderKeys)("%s refuses the legacy id-only payload", (key) => {
    expect(() =>
      COMPILED_FORMS[key]({ patientId: "p", kind: "lab", signedAt: "2026-09-30T00:00:00.000Z" }),
    ).toThrow(RenderPayloadError);
  });

  it("a medication order with no directions or an unknown class throws", () => {
    expect(() => COMPILED_FORMS.medication_order({ ...MEDICATION_ORDER, sigFreeText: "" })).toThrow(
      RenderPayloadError,
    );
    expect(() =>
      COMPILED_FORMS.medication_order({ ...MEDICATION_ORDER, medClass: "street" }),
    ).toThrow(RenderPayloadError);
  });

  it.each([
    ["noe_confirmation_receipt", { ...NOE_RECEIPT, noeControlNumber: "" }],
    ["notr_confirmation_receipt", { ...NOTR_RECEIPT, submittedAt: undefined }],
    ["claim_acknowledgment_letter", { ...CLAIM_ACK, claimControlNumber: undefined }],
    ["medicaid_claim_acknowledgment_letter", { ...MEDICAID_CLAIM_ACK, acknowledgedAt: "" }],
    ["denial_appeal_cover_letter", { ...DENIAL_COVER, rejectionCodes: undefined }],
    ["denial_resolution_letter", { ...DENIAL_RESOLUTION, closureOutcome: "" }],
  ] as const)("%s without the field it exists to state throws", (key, payload) => {
    expect(() => COMPILED_FORMS[key](payload as never)).toThrow(RenderPayloadError);
  });
});

describe("billing correspondence", () => {
  it("NOE receipt: control number, submission instant and the fixed statements", () => {
    const text = flat(textOf(COMPILED_FORMS.noe_confirmation_receipt(NOE_RECEIPT)));
    expect(text).toContain(flat(BILLING_TEXT.noe));
    expect(text).toContain("NOE-2026-000417");
    expect(text).toContain("2026-10-02 15:30 UTC");
    expect(text).toContain(flat(BILLING_TEXT.notDetermination));
  });

  it("NOTR receipt: control number and submission instant", () => {
    const text = flat(textOf(COMPILED_FORMS.notr_confirmation_receipt(NOTR_RECEIPT)));
    expect(text).toContain(flat(BILLING_TEXT.notr));
    expect(text).toContain("NOTR-2026-000052");
    expect(text).toContain("2026-10-09 09:12 UTC");
  });

  it("claim acknowledgment: both control numbers; an unassigned payer number is stated, not blank", () => {
    const text = flat(textOf(COMPILED_FORMS.claim_acknowledgment_letter(CLAIM_ACK)));
    expect(text).toContain("CLM-2026-0091");
    expect(text).toContain("PAYER-7781234");
    const unassigned = flat(
      textOf(
        COMPILED_FORMS.claim_acknowledgment_letter({ ...CLAIM_ACK, payerClaimControlNumber: null }),
      ),
    );
    expect(unassigned).toContain("Not yet assigned by the payer");
  });

  it("Medicaid claim acknowledgment: Medicaid control number and the unassigned payer number", () => {
    const text = flat(
      textOf(COMPILED_FORMS.medicaid_claim_acknowledgment_letter(MEDICAID_CLAIM_ACK)),
    );
    expect(text).toContain(flat(BILLING_TEXT.medicaidClaimAck));
    expect(text).toContain("MCLM-2026-0044");
    expect(text).toContain("Not yet assigned by the payer");
  });

  it("denial-appeal cover letter: stage label, every rejection code, and no invented date", () => {
    const doc = COMPILED_FORMS.denial_appeal_cover_letter(DENIAL_COVER);
    const text = flat(textOf(doc));
    expect(text).toContain("277CA claim acknowledgment");
    expect(text).toContain("A7:51:85");
    expect(text).toContain("A3:21:IL");
    expect(text).not.toContain("Document date");
    const none = flat(
      textOf(COMPILED_FORMS.denial_appeal_cover_letter({ ...DENIAL_COVER, rejectionCodes: [] })),
    );
    expect(none).toContain("No rejection codes were returned");
  });

  it("denial-resolution letter: outcome label, resolution instant and the claim reference", () => {
    const text = flat(textOf(COMPILED_FORMS.denial_resolution_letter(DENIAL_RESOLUTION)));
    expect(text).toContain("Resolved without appeal");
    expect(text).toContain("2026-10-20 13:00 UTC");
    expect(text).toContain("cccccccc");
    const noClaim = flat(
      textOf(COMPILED_FORMS.denial_resolution_letter({ ...DENIAL_RESOLUTION, claimId: null })),
    );
    expect(noClaim).toContain("No claim attached to this denial");
    const writeOff = flat(
      textOf(
        COMPILED_FORMS.denial_resolution_letter({
          ...DENIAL_RESOLUTION,
          closureOutcome: "written_off",
        }),
      ),
    );
    expect(writeOff).toContain("Written off");
  });

  it.each(billingKeys)(
    "%s: patient-independent, constant title, no coverage or payment claim",
    (key) => {
      const doc = COMPILED_FORMS[key](BILLING_FIXTURES[key] as never);
      const text = flat(textOf(doc));
      expect(doc.runningHeader).toBe(doc.title);
      expect(text).not.toContain("Medical record number");
      expect(text).not.toMatch(/is covered|will be paid|payment of \$/i);
      expect(flat(text)).toContain(flat(BILLING_TEXT.notDetermination));
    },
  );

  it.each(billingKeys)("%s: unknown keys (an MBI, a patient name) are never drawn", (key) => {
    const text = textOf(
      COMPILED_FORMS[key]({
        ...BILLING_FIXTURES[key],
        mbi: "1EG4-TE5-MK73",
        patientName: SENTINEL_NAME,
      } as never),
    );
    expect(text).not.toContain("1EG4-TE5-MK73");
    expect(text).not.toContain(SENTINEL_NAME);
  });
});

describe("PHI canary", () => {
  const info = (raw: string): string => /5 0 obj\n([\s\S]*?)\nendobj/.exec(raw)?.[1] ?? "";

  it.each(orderKeys)(
    "%s: sentinels absent from /Info and the footer, present on the page",
    (key) => {
      const payload = key === "order_record" ? ORDER_RECORD : MEDICATION_ORDER;
      const doc = COMPILED_FORMS[key](payload);
      const raw = Buffer.from(renderDocModelToPdf(doc)).toString("latin1");
      expect(info(raw)).not.toContain(SENTINEL_NAME);
      expect(info(raw)).not.toContain(SENTINEL_MRN);
      expect(doc.title).not.toContain(SENTINEL_NAME);
      expect(pageTexts(layoutDocument(doc)).flat().join("\n")).toContain(SENTINEL_NAME);
      const footers =
        raw.match(/\([^)]*Confidential: contains protected health information\)/g) ?? [];
      expect(footers.length).toBeGreaterThan(0);
      for (const f of footers) expect(f).not.toContain(SENTINEL_NAME);
    },
  );

  it.each(orderKeys)("%s: unknown payload keys are never drawn (allow-list, not dump)", (key) => {
    const payload = key === "order_record" ? ORDER_RECORD : MEDICATION_ORDER;
    const text = textOf(
      COMPILED_FORMS[key]({
        ...payload,
        internalNote: "SECRET-PLUMBING",
        ssn: "123-45-6789",
      } as never),
    );
    expect(text).not.toContain("SECRET-PLUMBING");
    expect(text).not.toContain("123-45-6789");
  });

  it("the running header identifies the patient on pages 2..N of a long order", () => {
    const doc = COMPILED_FORMS.order_record({
      ...ORDER_RECORD,
      indication: Array.from(
        { length: 120 },
        (_, i) => `Clinical statement ${i + 1} about the patient.`,
      ).join(" "),
    });
    expect(doc.runningHeader).toContain(SENTINEL_NAME);
    const raw = Buffer.from(renderDocModelToPdf(doc)).toString("latin1");
    const pages = raw.split("/Type /Page /Parent").slice(1);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages.slice(1)) expect(page).toContain(`${SENTINEL_NAME} - MRN`);
  });
});
