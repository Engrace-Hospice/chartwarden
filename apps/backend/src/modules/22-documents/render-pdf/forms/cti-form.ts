// apps/backend/src/modules/22-documents/render-pdf/forms/cti-form.ts - the `cti` template: the physician's
// certification of terminal illness (42 CFR 418.22(b)-(c)). Content-element form (CMS prescribes elements, not
// a layout): prognosis statement, supporting-documentation pointer, the physician's own narrative IMMEDIATELY
// ABOVE the signature (418.22(b)(3)), the signature with printed name, date/time and meaning (21 CFR 11.50;
// 418.104(b) authorship), and the certification period. The cited paragraph numbers other than (b)(3) and
// (b)(4) await compliance's line-by-line confirmation against the repo rules file (design section 5).
import { assertCtiRenderPayload } from "@wardenx/types";
import { defineForm } from "./compile";

export const CTI_TEXT = {
  prognosis:
    "I certify that the patient named above is terminally ill, with a medical prognosis of a life expectancy of 6 months or less if the terminal illness runs its normal course, based on my clinical judgment regarding the normal course of the patient's illness.",
  supporting:
    "Specific clinical findings and other documentation supporting a life expectancy of 6 months or less are filed in the patient's medical record with this certification.",
} as const;

export const CTI_FORM_VERSION = "2.0.0";

export const ctiForm = defineForm({
  key: "cti",
  version: CTI_FORM_VERSION,
  title: "Certification of Terminal Illness",
  authority: "42 CFR 418.22(b)-(c)",
  parse: assertCtiRenderPayload,
  patient: (p) => p.patient,
  hospiceName: (p) => p.hospiceName,
  documentDate: (p) => p.hospiceMdSignature.signedAt,
  sections: [
    {
      id: "certification_period",
      kind: "fields",
      heading: "Certification period",
      cite: "42 CFR 418.21; 418.22(a)",
      cells: (p) => [
        [
          "Benefit period",
          p.benefitPeriodSequence === null
            ? "-"
            : `Period ${p.benefitPeriodSequence} (${p.isRecertification ? "recertification" : "initial certification"})`,
        ],
        ["Period start", p.periodStart ?? "-"],
        ["Period end", p.periodEnd ?? "-"],
      ],
    },
    {
      id: "terminal_diagnosis",
      kind: "list",
      heading: "Terminal illness diagnosis (ICD-10)",
      items: (p) => p.terminalDiagnoses.map((d) => d.code),
      withheld: (p) => p.part2WithheldCount,
      emptyText: "No terminal diagnosis code is recorded.",
    },
    {
      id: "related_conditions",
      kind: "list",
      heading: "Related conditions (ICD-10)",
      items: (p) => p.relatedConditions.map((d) => d.code),
      withheld: (p) => p.relatedPart2WithheldCount,
      emptyText: "No related conditions are recorded.",
    },
    {
      id: "late_signature_notice",
      kind: "banner",
      tone: "warn",
      message: (p) =>
        p.signedLate
          ? `Signed after the certification period began. Reason: ${p.lateReason ?? "not recorded"}.`
          : undefined,
    },
    {
      id: "terminal_prognosis_statement",
      kind: "legal",
      heading: "Certification statement",
      cite: "42 CFR 418.22(b)(1)",
      text: CTI_TEXT.prognosis,
    },
    {
      id: "supporting_documentation_statement",
      kind: "legal",
      cite: "42 CFR 418.22(b)(2)",
      text: CTI_TEXT.supporting,
    },
    {
      id: "clinical_narrative",
      kind: "narrative",
      heading: "Physician's narrative explanation of the clinical findings",
      cite: "42 CFR 418.22(b)(3)",
      text: (p) => p.narrative,
      emptyText: "No narrative was recorded.",
    },
  ],
  signatures: [
    {
      id: "physician_signature_block",
      role: "Hospice physician or medical director",
      required: true,
      from: (p) => p.hospiceMdSignature,
    },
    {
      id: "attending_signature_block",
      role: "Attending physician",
      required: false,
      from: (p) => p.attendingSignature,
    },
  ],
});
