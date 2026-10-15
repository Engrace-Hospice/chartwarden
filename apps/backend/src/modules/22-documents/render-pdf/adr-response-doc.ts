// apps/backend/src/modules/22-documents/render-pdf/adr-response-doc.ts — the `adr_response_packet` template: M25's
// typed AdrPacketRenderPayload -> a {@link DocModel} (hospice ADR/TPE/QIC PRD, milestone 2b). Pure. Like the
// appeal packet, a payload that fails its schema THROWS (the render consumer retries then dead-letters): this is
// the retained record of what went to a MAC, and a silently half-empty one is worse than a visible failed render.
//
// What it carries: the cover sheet (MAC, ADR reference, the due date, when and how it was filed, the proof
// reference, whether it was late) and the enclosure index. The enclosures are NAMED (title, date, kind); the
// documents themselves are delivered separately and are never merged in here.
import { type AdrPacketRenderPayload, assertAdrPacketRenderPayload } from "@wardenx/types";
import type { Block, DocModel } from "./doc-model";
import { fmtDate, fmtInstant, humanize, shortId } from "./shared";

export function buildAdrResponseDoc(payload: unknown): DocModel {
  const p: AdrPacketRenderPayload = assertAdrPacketRenderPayload(payload);
  const title = p.reviewType === "re_adr" ? "Re-ADR Response Packet" : "ADR Response Packet";
  const blocks: Block[] = [
    { kind: "title", text: title, subtitle: `To: ${p.macName}` },
    {
      kind: "facts",
      rows: [
        ["ADR case", shortId(p.adrCaseId)],
        ["MAC reference", p.adrReference ?? "-"],
        ["Date on the ADR letter", fmtDate(p.requestedOn)],
        ["Response due", fmtInstant(p.responseDueAt)],
        ["Filed", fmtInstant(p.filedAt)],
        ["Filed by", humanize(p.filingChannel)],
        ["Confirmation reference", p.filingConfirmationRef],
        ["Reviewed", fmtInstant(p.reviewedAt)],
      ],
    },
  ];
  if (p.filedLate) {
    blocks.push({
      kind: "banner",
      tone: "warn",
      text: "Filed after the response due date",
    });
  }
  blocks.push(
    { kind: "heading", level: 1, text: "Documentation checklist" },
    {
      kind: "table",
      columns: [
        { header: "Item", weight: 6 },
        { header: "Status", weight: 3 },
      ],
      rows: p.checklist.map((c) => [humanize(c.key), humanize(c.state)]),
      emptyText: "No checklist was recorded.",
    },
    { kind: "heading", level: 1, text: "Enclosures" },
    {
      kind: "table",
      columns: [
        { header: "#", weight: 1 },
        { header: "Document", weight: 6 },
        { header: "Type", weight: 3 },
        { header: "Dated", weight: 3 },
        { header: "Answers", weight: 4 },
      ],
      rows: p.enclosures.map((d) => [
        String(d.ordinal),
        d.title,
        humanize(d.documentKind),
        fmtDate(d.documentDate),
        d.checklistKey ? humanize(d.checklistKey) : "-",
      ]),
      emptyText: "No documents were attached.",
    },
  );
  return { title, createdAtIso: p.filedAt, blocks };
}
