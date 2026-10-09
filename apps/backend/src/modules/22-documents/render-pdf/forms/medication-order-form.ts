// apps/backend/src/modules/22-documents/render-pdf/forms/medication-order-form.ts - the `medication_order` template:
// the signed M12 medication order. It states the drug, strength, form and route, the structured directions and the
// directions as written, the dispense quantity, days supply, refills and DAW, the DEA schedule of a controlled
// substance (never the prescriber's DEA number), a compounded formulation, the hospice coverage determination
// with its clinical reason (42 CFR 418.24(c)(6)), a documented allergy override, and the prescriber's signature.
// A SUD-treatment drug prints the 42 CFR 2.32 redisclosure notice whether or not the render flagged it.
import {
  type MedicationOrderRenderPayload,
  assertMedicationOrderRenderPayload,
} from "@wardenx/types";
import type { Block } from "../doc-model";
import { PART2_REDISCLOSURE_NOTICE, fmtInstant, humanize } from "../shared";
import { defineForm } from "./compile";
import { practitionerLine } from "./practitioner";

export const MEDICATION_ORDER_FORM_VERSION = "1.0.0";

export const MEDICATION_ORDER_TEXT = {
  verbal: "This order was received as a verbal order and signed afterwards by the prescriber.",
  cosign: "This order requires a cosignature.",
  allergyOverride:
    "A potential allergy match was reviewed and the prescriber documented a reason for proceeding.",
} as const;

const COVERAGE_LABELS: Readonly<Record<string, string>> = {
  covered_related: "Covered - related to the terminal illness",
};

function directionsCells(
  p: MedicationOrderRenderPayload,
): ReadonlyArray<readonly [string, string]> {
  const { sig } = p;
  return [
    ["Dose", `${sig.doseQuantity} ${sig.doseUnit}`],
    ["Route", sig.route],
    ["Frequency", sig.frequencyCode],
    ["Duration", sig.duration ?? "Not limited"],
    [
      "As needed (PRN)",
      sig.asNeeded ? `Yes${sig.asNeededReason ? ` - ${sig.asNeededReason}` : ""}` : "No",
    ],
  ];
}

function compoundedBlocks(p: MedicationOrderRenderPayload): Block[] {
  if (p.compounded === null) return [];
  return [
    { kind: "heading", level: 1, text: "Compounded formulation" },
    { kind: "paragraph", text: p.compounded.formulationDescription },
    {
      kind: "table",
      columns: [
        { header: "Component", weight: 3 },
        { header: "Strength", weight: 2 },
        { header: "Quantity ratio", weight: 2 },
      ],
      rows: p.compounded.components.map((c) => [c.name, c.strength, c.quantityRatio]),
      emptyText: "No components recorded.",
    },
    ...(p.compounded.containsControlled
      ? ([
          {
            kind: "paragraph",
            muted: true,
            text: "This formulation contains a controlled substance.",
          },
        ] as Block[])
      : []),
  ];
}

export const medicationOrderForm = defineForm({
  key: "medication_order",
  version: MEDICATION_ORDER_FORM_VERSION,
  title: "Medication Order",
  authority: "42 CFR 418.106(b), 418.24(c)(6); M12 medication orders",
  parse: assertMedicationOrderRenderPayload,
  patient: (p) => p.patient,
  hospiceName: (p) => p.hospiceName,
  documentDate: (p) => p.signature.signedAt,
  sections: [
    {
      id: "part2_notice",
      kind: "custom",
      blocks: (p, ctx): Block[] =>
        p.isSudTreatment && !ctx.part2ContentPresent
          ? [{ kind: "banner", tone: "danger", text: PART2_REDISCLOSURE_NOTICE }]
          : [],
    },
    {
      id: "medication",
      kind: "fields",
      heading: "Medication",
      cells: (p) => [
        ["Drug", p.drugName],
        ["Strength", p.strength],
        ["Dose form", p.doseForm],
        ["Route", p.route],
        ["Class", humanize(p.medClass)],
        ...(p.deaSchedule ? ([["DEA schedule", p.deaSchedule]] as const) : []),
        ["Received as", p.viaVerbal ? "Verbal order" : "Written order"],
      ],
    },
    {
      id: "verbal_order_notice",
      kind: "banner",
      tone: "info",
      message: (p) => (p.viaVerbal ? MEDICATION_ORDER_TEXT.verbal : undefined),
    },
    {
      id: "directions",
      kind: "fields",
      heading: "Directions",
      cells: directionsCells,
    },
    {
      id: "directions_as_written",
      kind: "narrative",
      heading: "Directions as written",
      text: (p) => p.sigFreeText,
      emptyText: "No directions were recorded.",
    },
    {
      id: "dispense",
      kind: "fields",
      heading: "Dispense",
      cells: (p) => [
        ["Quantity", `${p.dispenseQuantity.value} ${p.dispenseQuantity.unit}`],
        ["Days supply", String(p.daysSupply)],
        ["Refills authorized", String(p.refillsAuthorized)],
        ["Dispense as written", p.daw ? "Yes" : "No"],
      ],
    },
    { id: "compounded_formulation", kind: "custom", blocks: compoundedBlocks },
    {
      id: "indication",
      kind: "narrative",
      heading: "Indication",
      text: (p) => p.indication ?? undefined,
      emptyText: "No indication was recorded.",
    },
    {
      id: "clinical_justification",
      kind: "custom",
      blocks: (p): Block[] =>
        p.clinicalJustification === null
          ? []
          : [
              { kind: "heading", level: 1, text: "Clinical justification" },
              { kind: "paragraph", text: p.clinicalJustification },
            ],
    },
    {
      id: "hospice_coverage",
      kind: "fields",
      heading: "Hospice coverage",
      cite: "42 CFR 418.24(c)(6)",
      cells: (p) => [
        ["Determination", COVERAGE_LABELS[p.coverage.status] ?? humanize(p.coverage.status)],
        ...(p.coverage.reason ? ([["Clinical reason", p.coverage.reason]] as const) : []),
      ],
    },
    {
      id: "allergy_override",
      kind: "custom",
      blocks: (p): Block[] =>
        p.allergyOverride === null
          ? []
          : [
              { kind: "banner", tone: "warn", text: MEDICATION_ORDER_TEXT.allergyOverride },
              {
                kind: "fieldGrid",
                cells: [
                  ["Reason documented", p.allergyOverride.reason],
                  ["Acknowledged", fmtInstant(p.allergyOverride.acknowledgedAt)],
                  [
                    "Matched allergy classes",
                    p.allergyOverride.matchedClasses.length > 0
                      ? p.allergyOverride.matchedClasses.join(", ")
                      : "-",
                  ],
                ],
              },
            ],
    },
    {
      id: "prescriber",
      kind: "fields",
      heading: "Prescriber",
      cells: (p) => [["Prescribing physician", practitionerLine(p.prescribingPhysician)]],
    },
    {
      id: "pharmacy_transmission",
      kind: "custom",
      blocks: (p): Block[] =>
        !p.transmission
          ? []
          : [
              { kind: "heading", level: 1, text: "Transmission to pharmacy" },
              {
                kind: "fieldGrid",
                cells: [
                  ["Transmitted", fmtInstant(p.transmission.transmittedAt)],
                  [
                    "Prescription reference",
                    p.transmission.prescriptionRef
                      ? p.transmission.prescriptionRef.slice(0, 8)
                      : "-",
                  ],
                ],
              },
            ],
    },
    {
      id: "cosign_notice",
      kind: "banner",
      tone: "warn",
      message: (p) =>
        p.cosign === null
          ? undefined
          : `${MEDICATION_ORDER_TEXT.cosign}${p.cosign.status ? ` Status: ${humanize(p.cosign.status)}.` : ""}`,
    },
  ],
  signatures: [
    {
      id: "prescriber_signature_block",
      role: "Prescriber",
      required: true,
      from: (p) => p.signature,
    },
  ],
});
