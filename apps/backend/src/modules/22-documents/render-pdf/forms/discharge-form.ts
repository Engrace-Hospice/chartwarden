// apps/backend/src/modules/22-documents/render-pdf/forms/discharge-form.ts - the `discharge_summary` and
// `discharge_summary_transfer` templates (42 CFR 418.26). The discharge summary names the date and reason, the
// physician discharge order when one was required (418.26(b)), the filer (authorship, 418.104(b)) and - for a
// for-cause discharge - the medical-director cosign. A cosigned version MUST carry the cosigner's signature
// (fail closed); a pending-cosign version is watermarked so it is never mistaken for the final record.
import { assertDischargeRenderPayload, assertTransferRenderPayload } from "@chartwarden/types";
import { fmtDate, humanize } from "../shared";
import { defineForm } from "./compile";

export const DISCHARGE_FORM_VERSION = "2.0.0";
export const TRANSFER_FORM_VERSION = "2.0.0";

export const dischargeForm = defineForm({
  key: "discharge_summary",
  version: DISCHARGE_FORM_VERSION,
  title: "Discharge Summary",
  authority: "42 CFR 418.26",
  parse: assertDischargeRenderPayload,
  patient: (p) => p.patient,
  hospiceName: (p) => p.hospiceName,
  documentDate: (p) =>
    p.cosign.signature?.signedAt ?? p.filedBy?.signedAt ?? `${p.effectiveDate}T00:00:00.000Z`,
  watermark: (p) =>
    p.status === "voided"
      ? { text: "VOID", tone: "danger" }
      : p.status === "pending_cosign"
        ? { text: "PENDING COSIGN", tone: "warn" }
        : undefined,
  sections: [
    {
      id: "discharge_date",
      kind: "fields",
      heading: "Discharge",
      cells: (p) => [
        ["Discharge date", fmtDate(p.effectiveDate)],
        ["Status", humanize(p.status)],
      ],
    },
    {
      id: "pending_cosign_notice",
      kind: "banner",
      tone: "warn",
      message: (p) =>
        p.status === "pending_cosign"
          ? "This for-cause discharge is awaiting medical-director cosign. It is not final until cosigned."
          : undefined,
    },
    {
      id: "discharge_reason",
      kind: "fields",
      heading: "Reason for discharge",
      cells: (p) => [
        ["Reason", humanize(p.dischargeType)],
        ...(p.forCauseReason ? ([["For-cause reason", p.forCauseReason]] as const) : []),
      ],
    },
    {
      id: "discharge_order",
      kind: "custom",
      blocks: (p) =>
        p.dischargeOrder === null
          ? []
          : [
              { kind: "heading", level: 1, text: "Physician discharge order" },
              {
                kind: "fieldGrid",
                cells: [
                  ["Order reference", p.dischargeOrder.reference ?? "-"],
                  ["Order", p.dischargeOrder.text ?? "-"],
                ],
              },
            ],
    },
    {
      id: "discharge_narrative",
      kind: "narrative",
      heading: "Narrative",
      text: (p) => p.narrative ?? undefined,
      emptyText: "No narrative was recorded.",
    },
  ],
  signatures: [
    {
      id: "filed_by_signature_block",
      role: "Discharge filed by",
      required: false,
      from: (p) => p.filedBy,
    },
    {
      id: "discharge_order_signature_block",
      role: "Physician discharge order signed by",
      required: false,
      from: (p) => p.dischargeOrder?.signature ?? null,
    },
    {
      id: "cosign_signature_block",
      role: "Medical-director cosign",
      required: (p) => p.cosign.completed,
      from: (p) => p.cosign.signature,
    },
  ],
});

export const transferForm = defineForm({
  key: "discharge_summary_transfer",
  version: TRANSFER_FORM_VERSION,
  title: "Transfer Summary",
  authority: "42 CFR 418.26; 418.24(e)",
  parse: assertTransferRenderPayload,
  patient: (p) => p.patient,
  hospiceName: (p) => p.hospiceName,
  documentDate: (p) => `${p.effectiveDate}T00:00:00.000Z`,
  sections: [
    {
      id: "transfer_details",
      kind: "fields",
      heading: "Transfer",
      cells: (p) => [
        [
          "Direction",
          p.direction === "out"
            ? "Transfer out to another hospice"
            : "Transfer in from another hospice",
        ],
        ["Effective date", fmtDate(p.effectiveDate)],
        [
          p.direction === "out" ? "Receiving hospice" : "Sending hospice",
          p.otherHospiceName ?? "-",
        ],
        ["Hospice CCN", p.otherHospiceCcn ?? "-"],
        ["Receiving care setting", p.receivingCareSetting ? humanize(p.receivingCareSetting) : "-"],
        ["Benefit period at transfer", `Period ${p.benefitPeriodSequence}`],
      ],
    },
    {
      id: "transfer_narrative",
      kind: "narrative",
      heading: "Narrative",
      text: (p) => p.narrative ?? undefined,
      emptyText: "No narrative was recorded.",
    },
  ],
  signatures: [],
});
