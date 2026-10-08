// apps/backend/src/modules/22-documents/render-pdf/appeal-packet-doc.ts — the `appeal_packet` template: M25's
// typed AppealPacketRenderPayload -> a {@link DocModel} (GAP-036). Pure. Unlike the tolerant builders, a packet
// that fails its schema THROWS (the render consumer retries then dead-letters): this letter goes to a MAC / QIC /
// ALJ, and a silently half-empty filing is worse than a visible failed render.
import { type AppealPacketRenderPayload, assertAppealPacketRenderPayload } from "@wardenx/types";
import { type Block, type DocModel, latestInstant } from "./doc-model";
import { fmtDate, fmtInstant, humanize, shortId } from "./shared";

export function buildAppealPacketDoc(payload: unknown): DocModel {
  const p: AppealPacketRenderPayload = assertAppealPacketRenderPayload(payload);
  const blocks: Block[] = [
    { kind: "title", text: p.tierLetterTitle, subtitle: `To: ${p.addressee}` },
    {
      kind: "facts",
      rows: [
        ["Appeal case", shortId(p.appealCaseId)],
        ["Appeal level", humanize(p.tier)],
        ["Claim", shortId(p.claimId)],
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
    { kind: "heading", level: 1, text: "Statement of appeal" },
    { kind: "paragraph", text: p.appealNarrative },
    { kind: "heading", level: 1, text: "Supporting documents" },
    {
      kind: "table",
      columns: [
        { header: "#", weight: 1 },
        { header: "Document reference", weight: 6 },
      ],
      rows: p.supportingDocuments.map((d) => [String(d.ordinal), shortId(d.documentId)]),
      emptyText: "No supporting documents were attached.",
    },
    { kind: "heading", level: 1, text: "Enclosures" },
    {
      kind: "facts",
      rows: [
        ["Signed claim copy", `Claim ${shortId(p.signedClaimCopyRef.claimId)}`],
        [
          "Remittance advice copy",
          p.remitCopyRef.remittanceLineId
            ? `Remittance line ${shortId(p.remitCopyRef.remittanceLineId)}`
            : "Not applicable (denial raised before a remittance advice)",
        ],
        [
          "Medical records bundle",
          p.medicalRecordsBundleRef
            ? `Document ${shortId(p.medicalRecordsBundleRef.documentId)}`
            : "Not attached",
        ],
      ],
    },
  );
  return {
    title: p.tierLetterTitle,
    createdAtIso: latestInstant([p.submittedAt, `${fmtDate(p.submittedAt)}T00:00:00.000Z`]),
    blocks,
  };
}
