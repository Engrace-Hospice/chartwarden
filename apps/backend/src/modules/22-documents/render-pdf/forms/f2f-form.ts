// apps/backend/src/modules/22-documents/render-pdf/forms/f2f-form.ts - the `f2f` template: the face-to-face
// encounter attestation (42 CFR 418.22(a)(4), (b)(4)). The performer attests in writing that the encounter
// occurred, with its date, and signs and dates the attestation. When the performer is a nurse practitioner the
// attestation states that the clinical findings were provided to the certifying physician (b)(4). The
// attestation source is either the written narrative or a linked, signed clinical note (R-F2F-06).
import { assertF2fRenderPayload } from "@wardenx/types";
import { fmtDate, humanize, shortId } from "../shared";
import { defineForm } from "./compile";

export const F2F_TEXT = {
  attestation:
    "I attest that I had a face-to-face encounter with the patient named above on the date of encounter shown above.",
  findingsProvided:
    "The clinical findings of that visit were provided to the certifying physician for use in determining continued eligibility for hospice care.",
} as const;

export const F2F_FORM_VERSION = "2.0.0";

const PERFORMER_LABEL = {
  hospice_md: "Hospice physician",
  hospice_np: "Hospice nurse practitioner",
} as const;

export const f2fForm = defineForm({
  key: "f2f",
  version: F2F_FORM_VERSION,
  title: "Face-to-Face Encounter Attestation",
  authority: "42 CFR 418.22(a)(4), (b)(4)",
  parse: assertF2fRenderPayload,
  patient: (p) => p.patient,
  hospiceName: (p) => p.hospiceName,
  documentDate: (p) => p.attestation.signedAt,
  sections: [
    {
      id: "encounter_date",
      kind: "fields",
      heading: "Encounter",
      cite: "42 CFR 418.22(a)(4)",
      cells: (p) => [
        ["Date of encounter", p.encounterDate ? fmtDate(p.encounterDate) : "-"],
        ["Location / modality", p.encounterLocation ? humanize(p.encounterLocation) : "-"],
        ["Performed by", PERFORMER_LABEL[p.performerRole]],
        [
          "Timing",
          p.windowOverride
            ? `Outside the 30-day window; override recorded${p.windowOverrideReason ? `: ${p.windowOverrideReason}` : ""}`
            : p.withinWindow === true
              ? "Within the 30 calendar days before the benefit period"
              : p.withinWindow === false
                ? "Outside the 30-day window"
                : "Not verified",
        ],
      ],
    },
    {
      id: "telehealth_eligibility",
      kind: "custom",
      blocks: (p) =>
        p.telehealthEligibility === null
          ? []
          : [
              {
                kind: "heading",
                level: 2,
                text: "Telehealth eligibility (42 CFR 418.22(a)(4)(ii))",
              },
              {
                kind: "bullets",
                items: [
                  `Patient located in a hospice enrollment moratorium area: ${p.telehealthEligibility.patientInMoratoriumArea ? "yes" : "no"}`,
                  `Hospice under enhanced oversight: ${p.telehealthEligibility.hospiceUnderEnhancedOversight ? "yes" : "no"}`,
                  `Performer enrolled in Medicare or opted out: ${p.telehealthEligibility.performerMedicareEnrolledOrOptedOut ? "yes" : "no"}`,
                ],
              },
            ],
    },
    {
      id: "face_to_face_attestation",
      kind: "attestation",
      heading: "Attestation",
      cite: "42 CFR 418.22(b)(4)",
      text: (p) =>
        p.performerRole === "hospice_np"
          ? `${F2F_TEXT.attestation} ${F2F_TEXT.findingsProvided}`
          : F2F_TEXT.attestation,
    },
    {
      id: "attestation_basis",
      kind: "narrative",
      heading: "Clinical findings and basis of the attestation",
      text: (p) =>
        p.attestationNarrative ??
        (p.linkedNoteEncounterId
          ? `The attestation is the clinical note ${shortId(p.linkedNoteEncounterId)} signed by the performer on the date of the encounter, which records the clinical findings, the date of the visit, and the performer's signature and signature date.`
          : undefined),
      emptyText: "No attestation source was recorded.",
    },
  ],
  signatures: [
    {
      id: "physician_signature_block",
      role: "Clinician who performed the face-to-face encounter",
      required: true,
      from: (p) => p.attestation,
    },
  ],
});
