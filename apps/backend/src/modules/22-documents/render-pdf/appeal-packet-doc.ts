// apps/backend/src/modules/22-documents/render-pdf/appeal-packet-doc.ts — the `appeal_packet` template: M25's
// typed AppealPacketRenderPayload -> a {@link DocModel} (GAP-036). Pure. Unlike the tolerant builders, a packet
// that fails its schema THROWS (the render consumer retries then dead-letters): this letter goes to a MAC / QIC /
// ALJ, and a silently half-empty filing is worse than a visible failed render.
//
// What the filing carries (Layer 1): the letter, the as-submitted claim (header + lines), the 835 payment detail
// (adjustments with CARC/group, remarks with RARC), and the enclosures NAMED (title, date, kind) - the supporting
// documents themselves are delivered separately by the biller (merging document bytes is a separate, PHI-bearing
// step). An 837I has no wet signature, so the claim enclosure is the as-submitted electronic claim.
import {
  type AppealPacketRenderPayload,
  assertAppealPacketRenderPayload,
} from "@chartwarden/types";
import { type Block, type DocModel, latestInstant } from "./doc-model";
import { fmtDate, fmtInstant, humanize, shortId } from "./shared";

/** Integer cents -> "$12,345.00" (sign-aware; deterministic, never the viewer's locale). */
export function fmtCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

function claimCopyBlocks(p: AppealPacketRenderPayload): Block[] {
  const c = p.claimCopy;
  return [
    { kind: "heading", level: 2, text: "Enclosure A - As-submitted claim" },
    {
      kind: "paragraph",
      text: "The electronic institutional claim (837I) as submitted to the payer. It carries a submission attestation, not a handwritten signature.",
      muted: true,
    },
    {
      kind: "facts",
      rows: [
        ["Claim control number", c.controlNumber],
        ["Type of bill", c.tob],
        ["Service period", `${fmtDate(c.serviceFrom)} to ${fmtDate(c.serviceTo)}`],
        ["Total charges", fmtCents(c.totalChargeCents)],
        ["Claim status", humanize(c.state)],
      ],
    },
    {
      kind: "table",
      columns: [
        { header: "Line", weight: 1 },
        { header: "Rev code", weight: 2 },
        { header: "HCPCS", weight: 2 },
        { header: "Service dates", weight: 4 },
        { header: "Units", weight: 1 },
        { header: "Charge", weight: 3 },
      ],
      rows: c.lines.map((l) => [
        String(l.lineNumber),
        l.revenueCode,
        l.hcpcsCode ?? "-",
        `${fmtDate(l.serviceFrom)} - ${fmtDate(l.serviceTo)}`,
        String(l.units),
        fmtCents(l.chargeCents),
      ]),
      emptyText: "The claim carries no service lines.",
    },
  ];
}

function remitCopyBlocks(p: AppealPacketRenderPayload): Block[] {
  const r = p.remitCopy;
  if (!r) {
    return [
      { kind: "heading", level: 2, text: "Enclosure B - Remittance advice" },
      {
        kind: "paragraph",
        text: "Not applicable: the denial was raised before a remittance advice (835) was issued.",
        muted: true,
      },
    ];
  }
  return [
    { kind: "heading", level: 2, text: "Enclosure B - Remittance advice (835)" },
    {
      kind: "facts",
      rows: [
        ["Received", fmtInstant(r.receivedAt)],
        ["Payment method", humanize(r.paymentMethod)],
        ["Check / EFT trace", r.checkOrEftTrace ?? "-"],
        ["Payer claim number (ICN)", r.payerIcn ?? "-"],
        ["Claim status code", String(r.claimStatusCode)],
        ["Charged", fmtCents(r.chargeCents)],
        ["Paid", fmtCents(r.paidCents)],
        ["Patient responsibility", fmtCents(r.patientResponsibilityCents)],
      ],
    },
    {
      kind: "table",
      columns: [
        { header: "Group", weight: 2 },
        { header: "Reason code (CARC)", weight: 3 },
        { header: "Adjustment", weight: 3 },
      ],
      rows: r.adjustments.map((a) => [a.group, a.carc, fmtCents(a.amountCents)]),
      emptyText: "No claim-level adjustments.",
    },
    {
      kind: "table",
      columns: [
        { header: "Remark type", weight: 3 },
        { header: "Remark code (RARC)", weight: 3 },
      ],
      rows: r.remarks.map((m) => [m.kind, m.rarc]),
      emptyText: "No remark codes.",
    },
    {
      kind: "table",
      columns: [
        { header: "Rev code", weight: 2 },
        { header: "HCPCS", weight: 2 },
        { header: "Charged", weight: 3 },
        { header: "Paid", weight: 3 },
      ],
      rows: r.serviceLines.map((l) => [
        l.revenueCode ?? "-",
        l.hcpcsCode ?? "-",
        fmtCents(l.chargeCents),
        fmtCents(l.paidCents),
      ]),
      emptyText: "No service-line payment detail.",
    },
  ];
}

/**
 * The QIC request elements (hospice ADR/TPE/QIC PRD, milestone 4): the redetermination MAC and notice, the claim
 * items and dates of service, fill-in cells for the identity this system does not hold (beneficiary name, Medicare
 * number, appellant, signature - the ABN precedent: the person completes and signs), the documentation the notice
 * cited, and the preclusion statement. CMS-20033 is not reproduced here: this is the letter request.
 */
function reconsiderationBlocks(p: AppealPacketRenderPayload): Block[] {
  const r = p.reconsideration;
  if (!r) return [];
  const noticeCopy = p.supportingDocuments.find(
    (d) => d.documentId === r.redeterminationNoticeDocumentId,
  );
  const anyUnenclosed = r.citedEvidence.some((i) => i.documentId === null);
  const enclosureOf = (documentId: string | null): string => {
    const doc = p.supportingDocuments.find((d) => d.documentId === documentId);
    return doc ? `Enclosed: #${doc.ordinal} ${doc.title}` : "";
  };
  return [
    { kind: "heading", level: 1, text: "Request for reconsideration - required elements" },
    {
      kind: "paragraph",
      text: "Complete the blank cells and sign before sending. This letter is the written request; it does not reproduce form CMS-20033.",
      muted: true,
    },
    {
      kind: "fieldGrid",
      cells: [
        ["Beneficiary name", ""],
        ["Medicare number (MBI)", ""],
        ["Appellant (provider) name and NPI/PTAN", ""],
        ["Representative, if any", ""],
        ["Redetermination MAC", r.redeterminationMacName],
        ["Redetermination notice dated", fmtDate(r.redeterminationNoticeDate)],
        ["Claim control number", p.claimCopy.controlNumber],
        [
          "Dates of service",
          `${fmtDate(p.claimCopy.serviceFrom)} to ${fmtDate(p.claimCopy.serviceTo)}`,
        ],
      ],
    },
    {
      kind: "table",
      columns: [
        { header: "Line", weight: 1 },
        { header: "Item (rev code / HCPCS)", weight: 4 },
        { header: "Dates of service", weight: 4 },
      ],
      rows: p.claimCopy.lines.map((l) => [
        String(l.lineNumber),
        `${l.revenueCode}${l.hcpcsCode ? ` / ${l.hcpcsCode}` : ""}`,
        `${fmtDate(l.serviceFrom)} - ${fmtDate(l.serviceTo)}`,
      ]),
      emptyText: "The claim carries no service lines.",
    },
    {
      kind: "facts",
      rows: [
        [
          "Copy of the redetermination notice",
          noticeCopy ? `Enclosed: #${noticeCopy.ordinal} ${noticeCopy.title}` : "",
        ],
      ],
    },
    { kind: "heading", level: 2, text: "Documentation cited in the redetermination notice" },
    r.citedEvidenceNone
      ? {
          kind: "paragraph",
          text: "The redetermination notice named no missing documentation.",
        }
      : {
          kind: "table",
          columns: [
            { header: "#", weight: 1 },
            { header: "Documentation named in the notice", weight: 5 },
            { header: "Included / not available", weight: 6 },
          ],
          rows: r.citedEvidence.map((i, n) => [
            String(n + 1),
            i.label,
            i.documentId !== null
              ? enclosureOf(i.documentId)
              : `Not enclosed: ${i.notAvailableReason ?? ""}`,
          ]),
          emptyText: "No documentation was cited.",
        },
    anyUnenclosed
      ? {
          kind: "banner",
          tone: "warn",
          text: "Evidence that is not submitted before the reconsideration notice may be excluded at later levels of appeal unless good cause is shown.",
        }
      : {
          kind: "paragraph",
          text: "Evidence not submitted before the reconsideration notice may be excluded at later levels of appeal unless good cause is shown.",
          muted: true,
        },
    {
      kind: "fieldGrid",
      cells: [
        ["Signature", ""],
        ["Date signed", ""],
      ],
    },
  ];
}

export function buildAppealPacketDoc(payload: unknown): DocModel {
  const p: AppealPacketRenderPayload = assertAppealPacketRenderPayload(payload);
  const blocks: Block[] = [
    { kind: "title", text: p.tierLetterTitle, subtitle: `To: ${p.addressee}` },
    {
      kind: "facts",
      rows: [
        ["Appeal case", shortId(p.appealCaseId)],
        ["Appeal level", humanize(p.tier)],
        ["Claim control number", p.claimCopy.controlNumber],
        ["Denial reason (CARC)", p.denial.carcCode],
        ["Remark (RARC)", p.denial.rarcCode ?? "-"],
        ["Amount in dispute", `$${p.denial.dollarValue}`],
        ["Filing deadline", fmtInstant(p.tierDeadlineAt)],
        ["Submitted", fmtInstant(p.submittedAt)],
        ...Object.entries(p.macReferenceNumbers ?? {}).map(([label, value]): [string, string] => [
          humanize(label),
          value,
        ]),
      ],
    },
  ];
  if (p.lateGoodCauseFiling === true) {
    blocks.push(
      {
        kind: "banner",
        tone: "warn",
        text: "Late filing - good cause requested (42 CFR 405.942(b))",
      },
      { kind: "paragraph", text: p.goodCauseJustification ?? "" },
    );
  }
  blocks.push(
    ...reconsiderationBlocks(p),
    { kind: "heading", level: 1, text: "Statement of appeal" },
    { kind: "paragraph", text: p.appealNarrative },
    { kind: "heading", level: 1, text: "Enclosures" },
    ...claimCopyBlocks(p),
    ...remitCopyBlocks(p),
    { kind: "heading", level: 2, text: "Enclosure C - Supporting documents" },
    {
      kind: "table",
      columns: [
        { header: "#", weight: 1 },
        { header: "Document", weight: 6 },
        { header: "Type", weight: 3 },
        { header: "Dated", weight: 3 },
      ],
      rows: p.supportingDocuments.map((d) => [
        String(d.ordinal),
        d.title,
        humanize(d.documentKind),
        fmtDate(d.documentDate),
      ]),
      emptyText: "No supporting documents were attached.",
    },
    { kind: "heading", level: 2, text: "Enclosure D - Medical records bundle" },
    p.medicalRecordsBundleRef
      ? {
          kind: "facts",
          rows: [
            ["Document", p.medicalRecordsBundleRef.title],
            ["Type", humanize(p.medicalRecordsBundleRef.documentKind)],
            ["Dated", fmtDate(p.medicalRecordsBundleRef.documentDate)],
          ],
        }
      : { kind: "paragraph", text: "Not attached.", muted: true },
  );
  return {
    title: p.tierLetterTitle,
    createdAtIso: latestInstant([p.submittedAt, `${fmtDate(p.submittedAt)}T00:00:00.000Z`]),
    blocks,
  };
}
