// apps/backend/src/modules/22-documents/render-pdf/forms/order-record-form.ts - the `order_record` template: the
// signed M11 clinical order (lab, DME, level-of-care change, recertification, comfort kit, supply, ancillary
// service, IDG request). It states what was ordered, the priority and indication, the ordering physician, the
// kind-specific lines the producer validated, and the signer's 21 CFR 11.50 manifestation. A kind whose field
// contract M11 has not published prints the envelope and says so, never an invented detail list.
import { assertOrderRecordRenderPayload } from "@wardenx/types";
import type { Block } from "../doc-model";
import { humanize } from "../shared";
import { defineForm } from "./compile";
import { practitionerLine } from "./practitioner";

export const ORDER_RECORD_FORM_VERSION = "1.0.0";

export const ORDER_RECORD_TEXT = {
  verbal:
    "This order was received as a verbal order and signed afterwards by the ordering clinician.",
  cosign: "This order requires a cosignature.",
} as const;

export const orderRecordForm = defineForm({
  key: "order_record",
  version: ORDER_RECORD_FORM_VERSION,
  title: "Order Record",
  authority: "42 CFR 418.54(c)(3), 418.104; M11 orders",
  parse: assertOrderRecordRenderPayload,
  patient: (p) => p.patient,
  hospiceName: (p) => p.hospiceName,
  documentDate: (p) => p.signature.signedAt,
  sections: [
    {
      id: "order_summary",
      kind: "fields",
      heading: "Order",
      cells: (p) => [
        ["Order type", humanize(p.kind)],
        ["Priority", humanize(p.priority)],
        ["Ordering physician", practitionerLine(p.orderingPhysician)],
        ["Received as", p.viaVerbal ? "Verbal order" : "Written order"],
        ...(p.replacesOrderId
          ? ([["Corrects order", p.replacesOrderId.slice(0, 8)]] as const)
          : []),
        ...(p.fromStandingOrder ? ([["Source", "Standing order"]] as const) : []),
      ],
    },
    {
      id: "verbal_order_notice",
      kind: "banner",
      tone: "info",
      message: (p) => (p.viaVerbal ? ORDER_RECORD_TEXT.verbal : undefined),
    },
    {
      id: "order_indication",
      kind: "narrative",
      heading: "Indication",
      text: (p) => p.indication ?? undefined,
      emptyText: "No indication was recorded.",
    },
    {
      id: "order_details",
      kind: "custom",
      blocks: (p): Block[] => [
        { kind: "heading", level: 1, text: "Order details" },
        p.details.length > 0
          ? { kind: "fieldGrid", cells: p.details.map((d) => [d.label, d.value] as const) }
          : {
              kind: "paragraph",
              muted: true,
              text: p.detailsNote ?? "No further order details were recorded.",
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
          : `${ORDER_RECORD_TEXT.cosign}${p.cosign.status ? ` Status: ${humanize(p.cosign.status)}.` : ""}`,
    },
  ],
  signatures: [
    {
      id: "ordering_clinician_signature_block",
      role: "Ordering clinician",
      required: true,
      from: (p) => p.signature,
    },
  ],
});
