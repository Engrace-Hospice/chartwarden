// apps/backend/src/modules/22-documents/render-pdf/forms/abn-form.ts - the `abn` template: the CMS-R-131
// Advance Beneficiary Notice of Noncoverage. CMS PRESCRIBES the wording, the option text and the form's OMB
// expiry; copying them from memory would put an unverified legal notice in front of a beneficiary. So this
// builder ships the STRUCTURE (notifier, patient, service, reason, estimated cost, the three-option choice,
// the beneficiary signature line) and takes every prescribed string from {@link ABN_PRESCRIBED_TEXT}, which is
// `null` until compliance supplies it from the CMS-published form. While it is null the document is
// watermarked DRAFT, carries a danger banner, and prints bracketed placeholders - it cannot be mistaken for a
// deliverable notice. (Reported as an open item: GAP-033 R2.)
import { fmtInstant, rec, str } from "../shared";
import { defineForm } from "./compile";

export interface AbnPrescribedText {
  /** The notice's introductory "what you need to know" wording. */
  readonly intro: string;
  /** The three option statements, verbatim, in CMS order. */
  readonly options: readonly [string, string, string];
  /** The "additional information" and signature-line wording. */
  readonly signatureNote: string;
  /** The form's OMB control number and expiry line. */
  readonly ombLine: string;
}

/** Supplied by compliance from the CMS-published CMS-R-131 PDF. `null` = not yet supplied. */
export const ABN_PRESCRIBED_TEXT = null as AbnPrescribedText | null;

export const ABN_FORM_VERSION = "2.0.0-structure";

const BLANK = "______________________________";
const PLACEHOLDER = (what: string): string =>
  `[${what} - CMS-prescribed CMS-R-131 wording not yet supplied by compliance]`;

export interface AbnView {
  readonly patientName: string;
  readonly mrn: string;
  readonly service: string;
  readonly reason: string;
  readonly estimatedCost: string;
  readonly requiredBy: string;
}

const dollars = (cents: unknown): string =>
  typeof cents === "number" && Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : BLANK;

function parseAbn(payload: unknown): AbnView & { readonly id: string } {
  const p = rec(payload);
  return {
    id: str(p.abnId) ?? str(p.aggregateId) ?? "abn",
    patientName: str(p.patientName) ?? BLANK,
    mrn: str(p.medicalRecordNumber) ?? BLANK,
    service: str(p.serviceDescription) ?? BLANK,
    reason: str(p.reasonNoncovered) ?? BLANK,
    estimatedCost: dollars(p.estimatedCost),
    requiredBy: str(p.requiredBy) ?? new Date(0).toISOString(),
  };
}

export const abnForm = defineForm({
  key: "abn",
  version: ABN_FORM_VERSION,
  title: "Advance Beneficiary Notice of Noncoverage (ABN)",
  authority: "CMS-R-131; Medicare Claims Processing Manual ch. 30",
  parse: (payload) => parseAbn(payload),
  // The beneficiary identity is filled in by hand when the payload carries none: an ABN is a notice to be
  // completed and signed by the beneficiary, so blank identity cells are legitimate here (unlike every
  // signed clinical form, where a missing identity is a malformed payload).
  patient: (p) => ({ patientId: p.id, name: p.patientName, mrn: p.mrn, dateOfBirth: null }),
  hospiceName: () => null,
  documentDate: (p) => p.requiredBy,
  watermark: () => (ABN_PRESCRIBED_TEXT === null ? { text: "DRAFT", tone: "warn" } : undefined),
  sections: [
    {
      id: "abn_pending_text_notice",
      kind: "banner",
      tone: "danger",
      message: () =>
        ABN_PRESCRIBED_TEXT === null
          ? "DRAFT - the CMS-prescribed wording of this notice has not been installed. Do not deliver this document to a beneficiary."
          : undefined,
    },
    {
      id: "abn_required_text",
      kind: "legal",
      heading: "Notice",
      text: ABN_PRESCRIBED_TEXT?.intro ?? PLACEHOLDER("Notice text"),
    },
    {
      id: "service_and_reason",
      kind: "fields",
      heading: "What Medicare may not pay for",
      cells: (p) => [
        ["Service or item", p.service],
        ["Reason Medicare may not pay", p.reason],
      ],
    },
    {
      id: "cost_estimate_block",
      kind: "fields",
      heading: "Estimated cost",
      cells: (p) => [
        ["Estimated cost", p.estimatedCost],
        ["Notice required by", fmtInstant(p.requiredBy)],
      ],
    },
    {
      id: "beneficiary_option_block",
      kind: "custom",
      blocks: () => [
        {
          kind: "options",
          title: "Options - check only one box. Selected by the beneficiary.",
          items: [0, 1, 2].map((i) => ({
            label: ABN_PRESCRIBED_TEXT?.options[i] ?? PLACEHOLDER(`Option ${i + 1}`),
            selected: false,
          })),
        },
      ],
    },
    {
      id: "abn_beneficiary_signature_line",
      kind: "custom",
      blocks: () => [
        {
          kind: "keepTogether",
          blocks: [
            {
              kind: "paragraph",
              text: ABN_PRESCRIBED_TEXT?.signatureNote ?? PLACEHOLDER("Signature note"),
              muted: true,
            },
            { kind: "signature", role: "Beneficiary signature", ruledLine: true },
            {
              kind: "paragraph",
              muted: true,
              text: ABN_PRESCRIBED_TEXT?.ombLine ?? PLACEHOLDER("OMB control number and expiry"),
            },
          ],
        },
      ],
    },
  ],
  signatures: [],
});
