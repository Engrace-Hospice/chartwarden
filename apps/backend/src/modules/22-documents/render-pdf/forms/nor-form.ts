// apps/backend/src/modules/22-documents/render-pdf/forms/nor-form.ts - the `nor` template: the acknowledgment of
// the Notice of Patient Rights (42 CFR 418.52(a)). The acknowledgment is the signed fact; the rights text is the
// template's own fixed language and is the document the patient or representative received.
import { assertNorRenderPayload } from "@wardenx/types";
import { fmtDate, humanize } from "../shared";
import { defineForm } from "./compile";

export const NOR_TEXT = {
  rights:
    "I have received, and the hospice has explained to me, a written notice of my rights as a hospice patient. The notice explains my rights, including the right to be informed of my rights before care is furnished; to be treated with dignity and respect; to have my person and property respected; to take part in planning my care; to choose my attending physician; to refuse care or treatment; to voice grievances without discrimination or reprisal; and to have my records kept confidential. The hospice has also given me information about its policies on advance directives.",
} as const;

export const NOR_FORM_VERSION = "2.0.0";

export const norForm = defineForm({
  key: "nor",
  version: NOR_FORM_VERSION,
  title: "Notice of Patient Rights - Acknowledgment",
  authority: "42 CFR 418.52(a)",
  parse: assertNorRenderPayload,
  patient: (p) => p.patient,
  hospiceName: (p) => p.hospiceName,
  documentDate: (p) => p.acknowledgment.signedAt,
  sections: [
    {
      id: "acknowledgment_details",
      kind: "fields",
      heading: "Acknowledgment",
      cells: (p) => [
        ["Acknowledged on", fmtDate(p.acknowledgedDate)],
        [
          "Acknowledged by",
          p.signerKind === "representative" ? "Patient's representative" : "Patient",
        ],
        ["Method", humanize(p.acknowledgmentMethod)],
      ],
    },
    {
      id: "beneficiary_rights_text",
      kind: "legal",
      heading: "Notice of patient rights",
      cite: "42 CFR 418.52(a)",
      text: NOR_TEXT.rights,
    },
  ],
  signatures: [
    {
      id: "acknowledgment_signature_block",
      role: "Patient or representative",
      required: true,
      from: (p) => p.acknowledgment,
    },
    {
      id: "witness_signature_block",
      role: "Witness",
      required: false,
      from: (p) => p.witness,
    },
  ],
});
